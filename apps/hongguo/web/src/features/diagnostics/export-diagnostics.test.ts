import { describe, expect, it } from 'vitest';
import type { ClientEvent } from '../../lib/client-events';
import { exportDiagnostics, type ExportDiagnosticsDeps } from './export-diagnostics';

/**
 * 导出流程的纯逻辑测试。
 *
 * 全部依赖都是注入的假实现：不碰真实 `fetch`，也不碰 `navigator.clipboard`，
 * 所以不需要 jsdom。断言「写进剪贴板的内容」时一律 `JSON.parse` 后比对结构，
 * 不用字符串包含判断——后者在字段顺序或转义变化时会假绿。
 */

const VALID_DIAGNOSTICS = { server: ['[log] boot'], version: '0.1.0', uptimeSeconds: 12 };
const VALID_HEALTH = {
  ok: true,
  upstream: 'ok',
  apiVersion: '0.1.0',
  deviceRegistered: true,
  uptimeSeconds: 12,
};

/** 造 `count` 条事件，`detail` 为序号。 */
function makeEvents(count: number): ClientEvent[] {
  const events: ClientEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push({ kind: 'api-error', detail: `e${index}` });
  }
  return events;
}

/** 一次导出调用里被写进剪贴板的文本。 */
interface Captured {
  text: string | null;
}

/**
 * 造一份默认全部成功的依赖。
 *
 * `writeClipboard` 捕获入参写进 `captured`，同时保证返回 Promise：被测代码会
 * `await` 它，返回 `void` 会在严格模式下报错。
 */
function makeDeps(overrides: Partial<ExportDiagnosticsDeps> = {}): {
  deps: ExportDiagnosticsDeps;
  captured: Captured;
} {
  const captured: Captured = { text: null };
  const deps: ExportDiagnosticsDeps = {
    now: () => '2025-01-02T03:04:05.000Z',
    userAgent: 'test-agent',
    language: 'zh-CN',
    viewport: '390x844',
    route: '/history',
    events: makeEvents(3),
    fetchDiagnostics: () => Promise.resolve(VALID_DIAGNOSTICS),
    fetchHealth: () => Promise.resolve(VALID_HEALTH),
    writeClipboard: (text: string): Promise<void> => {
      captured.text = text;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, captured };
}

/** 解析被写进剪贴板的文本。 */
function parseCaptured(captured: Captured): Record<string, unknown> {
  expect(captured.text).not.toBeNull();
  return JSON.parse(captured.text ?? '') as Record<string, unknown>;
}

describe('exportDiagnostics', () => {
  it('succeeds when both endpoints answer', async () => {
    const { deps } = makeDeps();
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('still exports when the diagnostics endpoint rejects', async () => {
    const { deps, captured } = makeDeps({
      fetchDiagnostics: () => Promise.reject(new Error('502')),
    });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    const bundle = parseCaptured(captured);
    expect(bundle['failure']).toBe('服务端日志获取失败');
    expect(bundle['server']).toBeNull();
  });

  it('still exports when the health endpoint rejects', async () => {
    const { deps, captured } = makeDeps({
      fetchHealth: () => Promise.reject(new Error('502')),
    });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    const bundle = parseCaptured(captured);
    expect(bundle['failure']).toBe('服务端健康状态获取失败');
    expect(bundle['health']).toBeNull();
  });

  it('still exports when both endpoints reject', async () => {
    const { deps, captured } = makeDeps({
      fetchDiagnostics: () => Promise.reject(new Error('502')),
      fetchHealth: () => Promise.reject(new Error('502')),
    });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    const bundle = parseCaptured(captured);
    expect(bundle['failure']).toBe('服务端信息获取失败');
  });

  it('reports a clipboard failure instead of throwing', async () => {
    const { deps } = makeDeps({
      writeClipboard: () => Promise.reject(new Error('剪贴板不可用')),
    });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBe(0);
    expect(result.error).toContain('剪贴板不可用');
  });

  it('reports a clipboard failure when the API throws synchronously', async () => {
    // `navigator.clipboard` 在非安全上下文里是 `undefined`，属性访问会同步抛
    // `TypeError`（不是返回 rejected Promise）。这条路径必须同样被 `try/catch`
    // 捕获，否则点击按钮会变成未捕获异常、状态卡在 pending。
    const { deps } = makeDeps({
      writeClipboard: (): Promise<void> => {
        throw new TypeError('navigator.clipboard is undefined');
      },
    });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBe(0);
    expect(result.error).toContain('navigator.clipboard is undefined');
  });

  it('writes parseable JSON with events in order', async () => {
    const { deps, captured } = makeDeps();
    await exportDiagnostics(deps);
    const bundle = parseCaptured(captured);
    expect(bundle['events']).toEqual([
      { kind: 'api-error', detail: 'e0' },
      { kind: 'api-error', detail: 'e1' },
      { kind: 'api-error', detail: 'e2' },
    ]);
    // 服务端信息成功时 `failure` 必须是 `null`，不是 `undefined`（后者会在
    // JSON 里整个消失，排障时看不出「到底试过没有」）。
    expect(bundle['failure']).toBeNull();
  });

  it('caps 250 events at the last 200', async () => {
    const { deps, captured } = makeDeps({ events: makeEvents(250) });
    await exportDiagnostics(deps);
    const bundle = parseCaptured(captured);
    const events = bundle['events'] as { detail: string }[];
    expect(events).toHaveLength(200);
    expect(events[0]?.detail).toBe('e50');
    expect(events[199]?.detail).toBe('e249');
  });

  it('reports a failure when the diagnostics body is 200 but shaped wrong', async () => {
    // 服务端回 200 + `null` 响应体：只看「有没有拿到值」会认为成功，
    // 结果是 `failure: null` 而 `server: null`，用户看到「已复制」但内容是空的。
    const { deps, captured } = makeDeps({ fetchDiagnostics: () => Promise.resolve(null) });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    const bundle = parseCaptured(captured);
    expect(bundle['failure']).toBe('服务端日志获取失败');
    expect(bundle['server']).toBeNull();
  });

  it('reports a failure when the health body is missing a field', async () => {
    const { deps, captured } = makeDeps({
      fetchHealth: () => Promise.resolve({ ok: true, upstream: 'ok', apiVersion: '0.1.0' }),
    });
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    const bundle = parseCaptured(captured);
    expect(bundle['failure']).toBe('服务端健康状态获取失败');
    expect(bundle['health']).toBeNull();
  });

  it('stamps generatedAt with the injected clock', async () => {
    const { deps, captured } = makeDeps({ now: () => '2024-12-31T23:59:59.000Z' });
    await exportDiagnostics(deps);
    const bundle = parseCaptured(captured);
    expect(bundle['generatedAt']).toBe('2024-12-31T23:59:59.000Z');
  });
});
