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
import { CONFIG, type Config } from '../config/config.js';
import { DB } from '../db/db.module.js';
import { devices } from '../db/schema.js';
import type { DatabaseHandle } from '../db/database.js';
import { eq } from 'drizzle-orm';

export const HONGUO_CLIENT = Symbol('HONGUO_CLIENT');

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
    const client = await createClient({
      profile: store,
      transport,
      log: (line) => this.logger.debug(redact(line)),
    });
    this.logger.log('upstream client ready');
    return client;
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

  /** 是否属于「换设备可能有效」的错误。 */
  static isDeviceLimited(error: unknown): boolean {
    return (
      error instanceof OpenhongguoError && (error.code === 'ANONYMOUS_LIMITED' || error.code === 'DEVICE_REJECTED')
    );
  }
}

/**
 * 脱敏日志。
 *
 * SDK 说它已对 URL 脱敏，但这里再挡一层：device_id、iid、签名参数一旦进日志
 * 就等于泄漏身份，排障时不需要完整值。
 */
export function redact(line: string): string {
  return line
    .replace(/(device_id=)[^&\s]+/g, '$1***')
    .replace(/(iid=)[^&\s]+/g, '$1***')
    .replace(/(x-argus|x-gorgon|x-ladon|x-helios|x-medusa|x-khronos|x-ss-stub)[=:]\s*\S+/gi, '$1=***')
    .replace(/(spade_a=)[^&\s]+/g, '$1***');
}

export function describeError(error: unknown): string {
  if (error instanceof OpenhongguoError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export { memoryProfileStore };
