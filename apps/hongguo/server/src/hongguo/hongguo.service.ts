import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  createClient,
  memoryProfileStore,
  nodeTransport,
  OpenhongguoError,
  type Client,
  type ProfileStore,
  type Transport,
} from 'openhongguo';
import { redact as redactCommon } from '../common/redact.js';
import { CONFIG, type Config } from '../config/config.js';
import { DB } from '../db/db.module.js';
import { devices } from '../db/schema.js';
import type { DatabaseHandle } from '../db/database.js';
import { eq } from 'drizzle-orm';

export const HONGUO_CLIENT = Symbol('HONGUO_CLIENT');

/**
 * 上游可用性的三态。
 *
 * `catalog_only` 是初始值：还没发起过任何上游调用，所以既不能声称可用，也不该
 * 直接报失败。健康检查据此区分「目录能读但播放不行」与「上游完全不可达」。
 */
export type UpstreamStatus = 'ok' | 'catalog_only' | 'failed';

/**
 * 设备档案的 SQLite 适配器。
 *
 * SDK 的 `ProfileStore` 只要 load/save/reset 三个方法，所以把「档案放数据库」
 * 这件事完全封装在这里，SDK 无感知。
 *
 * 只保留一行：一台服务进程对应一个匿名身份。多设备轮换是后续的事，届时改成
 * 「取 state=active 且当天用量最低的那一行」即可。
 */
class SqliteProfileStore implements ProfileStore {
  private cached: string | null = null;

  constructor(private readonly handle: DatabaseHandle) {}

  // 三个方法都写成箭头函数字段，不能用原型方法。
  // SDK 会把 store 的方法解构出来再调用（`const { load } = store`），
  // 原型方法在这种情况下 `this` 是 undefined，会报
  // `Cannot read properties of undefined (reading 'cached')`。

  // 三个方法内部是同步的（better-sqlite3 是同步 API），但接口要求返回 Promise。
  // 用 `Promise.resolve` 显式包装，而不是加 `async` 却不 await —— 后者会被
  // `@typescript-eslint/require-await` 判定为可疑代码。

  load = (): Promise<string | null> => {
    if (this.cached !== null) {
      return Promise.resolve(this.cached);
    }
    const row = this.handle.db.select().from(devices).orderBy(devices.id).limit(1).get();
    if (row === undefined) {
      return Promise.resolve(null);
    }
    this.cached = row.profile;
    return Promise.resolve(row.profile);
  };

  save = (json: string): Promise<void> => {
    this.cached = json;
    const now = Date.now();
    const deviceId = readDeviceId(json);
    const existing = this.handle.db.select().from(devices).orderBy(devices.id).limit(1).get();
    if (existing === undefined) {
      this.handle.db.insert(devices).values({ profile: json, deviceId, createdAt: now, lastUsedAt: now }).run();
      return Promise.resolve();
    }
    this.handle.db
      .update(devices)
      .set({ profile: json, deviceId, lastUsedAt: now })
      .where(eq(devices.id, existing.id))
      .run();
    return Promise.resolve();
  };

  reset = (): Promise<void> => {
    this.cached = null;
    this.handle.db.delete(devices).run();
    return Promise.resolve();
  };
}

/** 从档案 JSON 里取出 device_id，仅用于排障时区分设备。 */
function readDeviceId(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = (parsed as Record<string, unknown>)['device_id_str'];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

@Injectable()
export class HongguoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HongguoService.name);
  private client: Client | null = null;
  /** 最近一次上游调用的结果。只由 `observe` 与 `recordUpstreamCall` 改写。 */
  private upstreamStatus: UpstreamStatus = 'catalog_only';
  /** 串行化首次注册，避免并发请求各注册一台设备。 */
  private initPromise: Promise<Client> | null = null;

  /** transport 装饰器，由 MediaModule 注入（用于捕获 spade_a）。 */
  private readonly transportDecorators: Array<(inner: Transport) => Transport> = [];

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly handle: DatabaseHandle,
  ) {}

  /**
   * 注册 transport 装饰器。必须在首次 `getClient()` 之前调用。
   *
   * 用「注册」而不是构造注入，是为了避免 HongguoModule 与 MediaModule 互相依赖。
   */
  addTransportDecorator(decorator: (inner: Transport) => Transport): void {
    if (this.client !== null) {
      throw new Error('cannot add transport decorator after client is created');
    }
    this.transportDecorators.push(decorator);
  }

  /**
   * 预热。
   *
   * 用 `onApplicationBootstrap` 而不是 `onModuleInit`：后者在模块的
   * `onModuleInit` 之前执行，而 MediaModule 需要在那时注册 transport 装饰器。
   * bootstrap 阶段所有模块都已完成初始化，顺序安全。
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.getClient().catch((error: unknown) => {
      this.logger.warn(`upstream client warm-up failed: ${describeError(error)}`);
    });
  }

  async getClient(): Promise<Client> {
    if (this.client !== null) {
      return this.client;
    }
    this.initPromise ??= this.create();
    this.client = await this.initPromise;
    return this.client;
  }

  private async create(): Promise<Client> {
    const store = new SqliteProfileStore(this.handle);
    let transport: Transport = nodeTransport({ timeoutMs: this.config.UPSTREAM_TIMEOUT_MS });
    for (const decorate of this.transportDecorators) {
      transport = decorate(transport);
    }
    transport = this.observe(transport);
    const client = await createClient({
      profile: store,
      transport,
      log: (line) => this.logger.debug(redact(line)),
    });
    this.logger.log('upstream client ready');
    return client;
  }

  /**
   * 在 transport 外面包一层，记录每次上游调用的成败。
   *
   * 包在**最外层**（装饰器之后）：`x-argus` 签名失败之类的问题发生在内层，也算
   * 一次失败。3xx/4xx 同样记为失败——对使用者来说拿不到数据就是不可用。
   */
  private observe(inner: Transport): Transport {
    return async (request) => {
      try {
        const response = await inner(request);
        this.recordUpstreamCall(response.status < 400);
        return response;
      } catch (error) {
        this.recordUpstreamCall(false);
        throw error;
      }
    };
  }

  /**
   * 丢弃当前设备并重新注册。
   *
   * 上游在匿名配额耗尽时会返回 `ANONYMOUS_LIMITED`，此时换一台设备通常能继续。
   */
  async resetDevice(): Promise<void> {
    const client = await this.getClient();
    await client.resetDevice();
    this.logger.log('device reset');
  }

  /**
   * 记录一次上游调用的结果。
   *
   * 公开是为了让将来的调用方（例如直连 CDN 的下载层）也能报告状态；SDK 请求由
   * `observe` 自动记录，不依赖调用方自觉。
   */
  recordUpstreamCall(ok: boolean): void {
    this.upstreamStatus = ok ? 'ok' : 'failed';
  }

  /** 最近一次上游调用的状态；还没调用过时是 `catalog_only`。 */
  lastUpstreamStatus(): UpstreamStatus {
    return this.upstreamStatus;
  }

  /**
   * 设备档案是否已存在且非空。
   *
   * 直接读 SQLite 而不是走 `SqliteProfileStore`：那个类的 `load` 会缓存到内存，
   * 健康检查不该影响客户端的缓存状态。**只读，不触发注册**。
   */
  isDeviceRegistered(): boolean {
    const row = this.handle.db.select().from(devices).orderBy(devices.id).limit(1).get();
    return row !== undefined && row.profile.trim() !== '';
  }

  /** 是否属于「换设备可能有效」的错误。 */
  static isDeviceLimited(error: unknown): boolean {
    return (
      error instanceof OpenhongguoError && (error.code === 'ANONYMOUS_LIMITED' || error.code === 'DEVICE_REJECTED')
    );
  }
}

/**
 * SDK 日志脱敏。
 *
 * 在通用 `redact`（URL 去 query、抹签名参数）之上再挡一层 SDK 特有的字段：
 * device_id、iid 与 `x-argus` 系列的签名头。这些值一旦进日志就等于泄漏身份，
 * 排障时不需要完整值。
 */
export function redact(line: string): string {
  return redactCommon(line)
    .replace(/(device_id=)[^&\s]+/g, '$1***')
    .replace(/(iid=)[^&\s]+/g, '$1***')
    .replace(/(x-argus|x-gorgon|x-ladon|x-helios|x-medusa|x-khronos|x-ss-stub)[=:]\s*\S+/gi, '$1=***');
}

/** 把错误压成一行日志。message 可能带上游地址，所以出口统一过 `redact`。 */
export function describeError(error: unknown): string {
  if (error instanceof OpenhongguoError) {
    return redactCommon(`${error.code}: ${error.message}`);
  }
  if (error instanceof Error) {
    return redactCommon(`${error.name}: ${error.message}`);
  }
  return redactCommon(String(error));
}

export { memoryProfileStore };
