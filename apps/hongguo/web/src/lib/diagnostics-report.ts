import { CLIENT_EVENT_LIMIT, type ClientEvent } from './client-events';

/**
 * 「导出诊断」的数据装配。
 *
 * 整个模块是纯函数，**不 import `window` / `document` / `navigator`**：环境信息
 * 全部由调用方通过参数注入。测试跑在 vitest 的 node 环境，没有浏览器全局可用，
 * 一旦在 import 期或函数体里直接摸 `navigator`，测试就会红。
 *
 * 服务端响应用手写形状校验而不是 `zod`：web 包已经因为避开 `zod` 才控制在
 * 282 kB（引入后实测到 430 kB 量级），这里只有两个扁平对象，逐字段 `typeof`
 * 比拉一个运行时校验库便宜得多。校验失败一律返回 `null`，不抛错——诊断工具
 * 不该因为响应体多一个字段或服务端换了形状就整个不可用。
 */

/** 服务端 `/api/diagnostics` 的响应形状（前端只做形状校验，不 import 服务端类型）。 */
export interface ServerDiagnostics {
  server: string[];
  version: string;
  uptimeSeconds: number;
}

/** 服务端 `/api/health` 的响应形状。 */
export interface ServerHealth {
  ok: boolean;
  upstream: string;
  apiVersion: string;
  deviceRegistered: boolean;
  uptimeSeconds: number;
}

export interface DiagnosticBundle {
  /** 生成时间，ISO 8601 字符串。 */
  generatedAt: string;
  /** 前端环境信息。 */
  client: { userAgent: string; language: string; viewport: string; route: string };
  /** 前端事件，最多 200 条。 */
  events: ClientEvent[];
  /** 服务端报告；取不到时为 `null`。 */
  server: ServerDiagnostics | null;
  /** 服务端健康状态；取不到时为 `null`。 */
  health: ServerHealth | null;
  /** 取服务端信息时的失败原因；全部成功时为 `null`。 */
  failure: string | null;
}

/**
 * 校验 `/api/diagnostics` 的响应体。
 *
 * `server` 还要截断到 `CLIENT_EVENT_LIMIT`：服务端已经只回 200 行，但这里不能
 * 依赖对端——诊断文本会被粘进 issue，长度必须由导出方自己兜住。
 */
export function parseServerDiagnostics(value: unknown): ServerDiagnostics | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { server, version, uptimeSeconds } = value as {
    server?: unknown;
    version?: unknown;
    uptimeSeconds?: unknown;
  };
  if (!Array.isArray(server)) {
    return null;
  }
  const lines: string[] = [];
  for (const line of server) {
    if (typeof line !== 'string') {
      return null;
    }
    lines.push(line);
  }
  if (typeof version !== 'string' || typeof uptimeSeconds !== 'number') {
    return null;
  }
  return { server: lines.slice(-CLIENT_EVENT_LIMIT), version, uptimeSeconds };
}

/**
 * 校验 `/api/health` 的响应体。
 *
 * `ok` 只要求是 boolean，**不要求为 true**：`ok: false` 恰恰是最需要导出的那种
 * 状态，把它当成「响应不合法」会让排障在最关键的场景下丢掉信息。`upstream`
 * 同理只校验是字符串，三态的取值由服务端定义，前端不该在这里重复枚举。
 */
export function parseServerHealth(value: unknown): ServerHealth | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { ok, upstream, apiVersion, deviceRegistered, uptimeSeconds } = value as {
    ok?: unknown;
    upstream?: unknown;
    apiVersion?: unknown;
    deviceRegistered?: unknown;
    uptimeSeconds?: unknown;
  };
  if (typeof ok !== 'boolean') {
    return null;
  }
  if (typeof upstream !== 'string') {
    return null;
  }
  if (typeof apiVersion !== 'string') {
    return null;
  }
  if (typeof deviceRegistered !== 'boolean') {
    return null;
  }
  if (typeof uptimeSeconds !== 'number') {
    return null;
  }
  return { ok, upstream, apiVersion, deviceRegistered, uptimeSeconds };
}

/**
 * 装配诊断包。
 *
 * `events` 取最后 `CLIENT_EVENT_LIMIT` 条并**逐个复制**：调用方传进来的通常是
 * `snapshot()` 的返回值，但本函数不假定这一点——持有外部引用会让导出结果在
 * 序列化之前被后续写入改动，出现「导出的内容跟点按钮时看到的不一样」。
 */
export function buildDiagnosticBundle(input: {
  generatedAt: string;
  userAgent: string;
  language: string;
  viewport: string;
  route: string;
  events: readonly ClientEvent[];
  server: unknown;
  health: unknown;
  failure: string | null;
}): DiagnosticBundle {
  return {
    generatedAt: input.generatedAt,
    client: {
      userAgent: input.userAgent,
      language: input.language,
      viewport: input.viewport,
      route: input.route,
    },
    events: input.events.slice(-CLIENT_EVENT_LIMIT).map((event) => ({ kind: event.kind, detail: event.detail })),
    server: parseServerDiagnostics(input.server),
    health: parseServerHealth(input.health),
    failure: input.failure,
  };
}

/**
 * 序列化成可以直接粘进 issue 的文本。
 *
 * 缩进 2 空格：这份文本是人读的，压缩成一行会让日志行挤在一起。
 */
export function serializeDiagnosticBundle(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}
