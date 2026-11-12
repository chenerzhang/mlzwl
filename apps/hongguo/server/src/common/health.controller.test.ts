import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { openDatabase, type DatabaseHandle } from '../db/database.js';
import { devices } from '../db/schema.js';
import { HongguoService, type UpstreamStatus } from '../hongguo/hongguo.service.js';
import { HealthController, type HealthStatus } from './health.controller.js';

/**
 * 健康检查的响应形状。
 *
 * 两件事要锁死：
 * 1. 三态原样透传，且 `ok` 与上游状态**解耦**——上游挂了不代表本服务不可用。
 * 2. `deviceRegistered` 读的是真实档案行，不是某个内存标志；而且查询本身不会
 *    创建档案（那会触发真实设备注册）。
 *
 * 用临时目录里的真实 SQLite，不碰真实上游，也不发任何网络请求。
 */

const PACKAGE_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

const tempDirs: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function testConfig(dataDir: string): Config {
  return {
    NODE_ENV: 'test',
    PORT: 9133,
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    MEDIA_KEEP: 4,
    COVER_KEEP_DAYS: 30,
    UPSTREAM_TIMEOUT_MS: 1_000,
    MEDIA_MAX_BYTES: 1_048_576,
    CORS_ORIGINS: [],
    LOG_TO_FILE: false,
  };
}

/** 打开临时数据库并构造真实的 `HongguoService`（不调用 `getClient`，所以不联网）。 */
async function service(): Promise<{ hongguo: HongguoService; handle: DatabaseHandle }> {
  const dir = await mkdtemp(join(tmpdir(), 'hongguo-health-'));
  tempDirs.push(dir);
  const handle = await openDatabase(dir, MIGRATIONS_DIR);
  handles.push(handle);
  return { hongguo: new HongguoService(testConfig(dir), handle), handle };
}

/** 只替换状态来源，用于三态用例。 */
function fakeHongguo(upstream: UpstreamStatus, deviceRegistered: boolean): HongguoService {
  return {
    lastUpstreamStatus: () => upstream,
    isDeviceRegistered: () => deviceRegistered,
  } as unknown as HongguoService;
}

describe('HealthController', () => {
  it('reports catalog_only before any upstream call', async () => {
    const { hongguo } = await service();
    const body = new HealthController(hongguo).health();
    expect(body.upstream).toBe('catalog_only');
  });

  it('reflects every upstream state without changing ok', () => {
    for (const upstream of ['ok', 'catalog_only', 'failed'] as const) {
      const body = new HealthController(fakeHongguo(upstream, true)).health();
      expect(body.upstream).toBe(upstream);
      // 上游失败是上游的事；本进程仍能应答，ok 必须恒为 true。
      expect(body.ok).toBe(true);
    }
  });

  it('reports deviceRegistered from the stored profile row', async () => {
    const { hongguo, handle } = await service();
    const controller = new HealthController(hongguo);

    // 空库：还没注册过设备。查询本身不得写入任何行。
    expect(controller.health().deviceRegistered).toBe(false);
    expect(handle.db.select().from(devices).all()).toHaveLength(0);

    const now = Date.now();
    handle.db.insert(devices).values({ profile: '{"device_id_str":"x"}', createdAt: now, lastUsedAt: now }).run();
    expect(controller.health().deviceRegistered).toBe(true);

    // 空白档案算「没注册」：`profile` 非空是唯一判据。
    handle.db.delete(devices).run();
    handle.db.insert(devices).values({ profile: '   ', createdAt: now, lastUsedAt: now }).run();
    expect(controller.health().deviceRegistered).toBe(false);
  });

  it('returns exactly the documented fields', () => {
    const body: HealthStatus = new HealthController(fakeHongguo('ok', false)).health();
    expect(Object.keys(body).sort()).toEqual(['apiVersion', 'deviceRegistered', 'ok', 'upstream', 'uptimeSeconds']);
    expect(body.apiVersion).toBe(PACKAGE_VERSION);
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
