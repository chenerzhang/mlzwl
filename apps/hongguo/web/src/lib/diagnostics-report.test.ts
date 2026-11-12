import { describe, expect, it } from 'vitest';
import type { ClientEvent } from './client-events';
import {
  buildDiagnosticBundle,
  parseServerDiagnostics,
  parseServerHealth,
  serializeDiagnosticBundle,
} from './diagnostics-report';

/**
 * 诊断装配的纯逻辑测试。
 *
 * 不引入 jsdom：被测模块的全部环境输入都是参数，测试里直接传常量。
 * 断言一律用**手写期望值**，不用被测模块自己算出来的结果反推，否则形状
 * 校验写错时用例会一起错。
 */

/** 一份合法的 `/api/diagnostics` 响应。 */
const VALID_DIAGNOSTICS = {
  server: ['[log] boot', '[log] ready'],
  version: '0.1.0',
  uptimeSeconds: 12,
};

/** 一份合法的 `/api/health` 响应。 */
const VALID_HEALTH = {
  ok: true,
  upstream: 'ok',
  apiVersion: '0.1.0',
  deviceRegistered: true,
  uptimeSeconds: 12,
};

/** 造 `count` 条事件，`detail` 为序号，方便断言顺序。 */
function makeEvents(count: number): ClientEvent[] {
  const events: ClientEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push({ kind: 'api-error', detail: `e${index}` });
  }
  return events;
}

describe('parseServerDiagnostics', () => {
  it('accepts a well-formed body', () => {
    expect(parseServerDiagnostics(VALID_DIAGNOSTICS)).toEqual({
      server: ['[log] boot', '[log] ready'],
      version: '0.1.0',
      uptimeSeconds: 12,
    });
  });

  it('rejects a body missing a field', () => {
    expect(parseServerDiagnostics({ server: [], version: '0.1.0' })).toBeNull();
  });

  it('rejects a non-array server field', () => {
    expect(parseServerDiagnostics({ server: '[log] boot', version: '0.1.0', uptimeSeconds: 1 })).toBeNull();
  });

  it('rejects a server array containing a non-string', () => {
    expect(parseServerDiagnostics({ server: ['[log] boot', 42], version: '0.1.0', uptimeSeconds: 1 })).toBeNull();
  });

  it('keeps only the last 200 log lines', () => {
    const lines: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      lines.push(`line-${index}`);
    }
    const parsed = parseServerDiagnostics({ server: lines, version: '0.1.0', uptimeSeconds: 1 });
    expect(parsed?.server).toHaveLength(200);
    // 保留的是尾部：首条是第 50 行，末条是第 249 行。
    expect(parsed?.server[0]).toBe('line-50');
    expect(parsed?.server[199]).toBe('line-249');
  });

  it('rejects the whole response when a bad line would have been truncated away', () => {
    // 500 行、第 400 行非字符串：它本来会被 `slice(-200)` 丢掉，但校验发生在截断
    // 之前，所以整份响应仍然判为无效。这个顺序是刻意的——只校验「最后 200 行」会
    // 让服务端换了响应形状时静默通过一半。
    const lines: unknown[] = [];
    for (let index = 0; index < 500; index += 1) {
      lines.push(index === 400 ? 42 : `line-${index}`);
    }
    expect(parseServerDiagnostics({ server: lines, version: '0.1.0', uptimeSeconds: 1 })).toBeNull();
  });

  it('rejects a string uptimeSeconds', () => {
    expect(parseServerDiagnostics({ server: [], version: '0.1.0', uptimeSeconds: '12' })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseServerDiagnostics(null)).toBeNull();
    expect(parseServerDiagnostics('boom')).toBeNull();
  });
});

describe('parseServerHealth', () => {
  it('accepts a well-formed body', () => {
    expect(parseServerHealth(VALID_HEALTH)).toEqual({
      ok: true,
      upstream: 'ok',
      apiVersion: '0.1.0',
      deviceRegistered: true,
      uptimeSeconds: 12,
    });
  });

  it('keeps a body whose ok is false', () => {
    // `ok: false` 正是最需要导出的状态，不能被当成「响应不合法」丢掉。
    expect(parseServerHealth({ ...VALID_HEALTH, ok: false })).toEqual({
      ok: false,
      upstream: 'ok',
      apiVersion: '0.1.0',
      deviceRegistered: true,
      uptimeSeconds: 12,
    });
  });

  it('rejects a body missing upstream', () => {
    expect(parseServerHealth({ ok: true, apiVersion: '0.1.0', deviceRegistered: true, uptimeSeconds: 12 })).toBeNull();
  });
});

describe('buildDiagnosticBundle', () => {
  it('keeps only the last 200 events in order', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2025-01-02T03:04:05.000Z',
      userAgent: 'ua',
      language: 'zh-CN',
      viewport: '390x844',
      route: '/history',
      events: makeEvents(250),
      server: VALID_DIAGNOSTICS,
      health: VALID_HEALTH,
      failure: null,
    });
    expect(bundle.events).toHaveLength(200);
    expect(bundle.events[0]).toEqual({ kind: 'api-error', detail: 'e50' });
    expect(bundle.events[199]).toEqual({ kind: 'api-error', detail: 'e249' });
  });

  it('accepts an empty event list', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2025-01-02T03:04:05.000Z',
      userAgent: 'ua',
      language: 'zh-CN',
      viewport: '390x844',
      route: '/history',
      events: [],
      server: VALID_DIAGNOSTICS,
      health: VALID_HEALTH,
      failure: null,
    });
    expect(bundle.events).toEqual([]);
  });

  it('copies events instead of holding external references', () => {
    const events = makeEvents(1);
    const bundle = buildDiagnosticBundle({
      generatedAt: '2025-01-02T03:04:05.000Z',
      userAgent: 'ua',
      language: 'zh-CN',
      viewport: '390x844',
      route: '/history',
      events,
      server: VALID_DIAGNOSTICS,
      health: VALID_HEALTH,
      failure: null,
    });
    // 改动入参不应影响已生成的诊断包。
    const first = events[0];
    if (first !== undefined) {
      first.detail = 'mutated';
    }
    expect(bundle.events[0]).toEqual({ kind: 'api-error', detail: 'e0' });
  });

  it('maps a missing server body to null', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2025-01-02T03:04:05.000Z',
      userAgent: 'ua',
      language: 'zh-CN',
      viewport: '390x844',
      route: '/history',
      events: [],
      server: null,
      health: VALID_HEALTH,
      failure: '服务端日志获取失败',
    });
    expect(bundle.server).toBeNull();
    expect(bundle.health).toEqual(VALID_HEALTH);
    expect(bundle.failure).toBe('服务端日志获取失败');
    expect(bundle.client).toEqual({ userAgent: 'ua', language: 'zh-CN', viewport: '390x844', route: '/history' });
    expect(bundle.generatedAt).toBe('2025-01-02T03:04:05.000Z');
  });
});

describe('serializeDiagnosticBundle', () => {
  it('round-trips through JSON.parse', () => {
    const bundle = buildDiagnosticBundle({
      generatedAt: '2025-01-02T03:04:05.000Z',
      userAgent: 'ua',
      language: 'zh-CN',
      viewport: '390x844',
      route: '/history',
      events: makeEvents(3),
      server: VALID_DIAGNOSTICS,
      health: VALID_HEALTH,
      failure: null,
    });
    const text = serializeDiagnosticBundle(bundle);
    expect(JSON.parse(text)).toEqual(bundle);
  });

  it('indents with two spaces so the text stays readable', () => {
    const text = serializeDiagnosticBundle(
      buildDiagnosticBundle({
        generatedAt: '2025-01-02T03:04:05.000Z',
        userAgent: 'ua',
        language: 'zh-CN',
        viewport: '390x844',
        route: '/history',
        events: [],
        server: null,
        health: null,
        failure: '服务端信息获取失败',
      }),
    );
    expect(text).toContain('\n');
    expect(text).toContain('\n  "generatedAt": "2025-01-02T03:04:05.000Z"');
  });
});
