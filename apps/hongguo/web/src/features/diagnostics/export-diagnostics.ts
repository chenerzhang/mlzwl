import type { ClientEvent } from '../../lib/client-events';
import {
  buildDiagnosticBundle,
  parseServerDiagnostics,
  parseServerHealth,
  serializeDiagnosticBundle,
  type ServerDiagnostics,
  type ServerHealth,
} from '../../lib/diagnostics-report';

/**
 * 「导出诊断」的副作用层：收集环境信息、并发取服务端信息、写剪贴板。
 *
 * **不直接引用 `window` / `document` / `navigator`**：剪贴板写入、时间、环境
 * 信息全部由调用方通过参数注入，这样整条流程能在 node 环境的测试里跑完整分支，
 * 不需要 jsdom 或伪造全局对象。
 *
 * 两条刻意的取舍：
 *
 * 1. **服务端信息取不到不算导出失败**。这个按钮是排障工具，最需要它的时刻恰好
 *    是服务端已经挂了的时候——此时前端事件、环境信息仍然有诊断价值。把失败原因
 *    写进 `bundle.failure` 一起导出，比直接报错让用户什么也拿不到有用。
 * 2. **剪贴板写入失败不抛错**。浏览器拒绝写剪贴板（无用户手势、权限被拒、
 *    `file://` 之外的受限环境）是常见情况，抛出去只会变成一个未捕获的 Promise
 *    rejection，调用方拿不到任何可展示的文案。返回 `{ ok: false, error }` 让 UI
 *    能就地显示「复制失败：…」。
 */

export interface ExportDiagnosticsDeps {
  /** 返回 ISO 8601 时间字符串。 */
  now: () => string;
  userAgent: string;
  language: string;
  viewport: string;
  route: string;
  events: readonly ClientEvent[];
  fetchDiagnostics: () => Promise<unknown>;
  fetchHealth: () => Promise<unknown>;
  writeClipboard: (text: string) => Promise<void>;
}

export interface ExportDiagnosticsResult {
  ok: boolean;
  /** 成功时是写入剪贴板的文本长度；失败时是 0。 */
  bytes: number;
  /** 失败原因；成功时为 `null`。 */
  error: string | null;
}

/** 服务端信息整体取不到时的文案。 */
const FAILURE_ALL = '服务端信息获取失败';
/** 只有日志接口失败。 */
const FAILURE_DIAGNOSTICS = '服务端日志获取失败';
/** 只有健康检查失败。 */
const FAILURE_HEALTH = '服务端健康状态获取失败';

export async function exportDiagnostics(deps: ExportDiagnosticsDeps): Promise<ExportDiagnosticsResult> {
  // 并发取：两个接口互不依赖，串行会让弱网下的等待时间翻倍。
  // `.catch(() => undefined)` 把失败降级成 `undefined`，交给形状校验判成 `null`。
  const [diagnostics, rawHealth] = await Promise.all([
    deps.fetchDiagnostics().catch(() => undefined),
    deps.fetchHealth().catch(() => undefined),
  ]);

  // 先校验再判失败：不能只看「有没有拿到值」。服务端回 200 但响应体是 `null`、
  // 或形状对不上时，`undefined` 判断会认为「成功」，结果 `failure: null` 而
  // `server: null`——用户看到「已复制」但服务端信息是空的。
  const failure = describeFailure(parseServerDiagnostics(diagnostics), parseServerHealth(rawHealth));

  const text = serializeDiagnosticBundle(
    buildDiagnosticBundle({
      generatedAt: deps.now(),
      userAgent: deps.userAgent,
      language: deps.language,
      viewport: deps.viewport,
      route: deps.route,
      events: deps.events,
      server: diagnostics,
      health: rawHealth,
      failure,
    }),
  );

  try {
    await deps.writeClipboard(text);
  } catch (error: unknown) {
    return { ok: false, bytes: 0, error: errorMessage(error) };
  }
  return { ok: true, bytes: text.length, error: null };
}

/**
 * 按「哪一项没拿到」给出失败文案。
 *
 * 入参是**已校验**的结果（`null` 表示失败），不是原始响应体：`200` + `null` 响应体、
 * 或字段类型不对，都应该算失败。只看 `undefined` 会把这两种情况当成成功。
 */
function describeFailure(server: ServerDiagnostics | null, health: ServerHealth | null): string | null {
  if (server === null && health === null) {
    return FAILURE_ALL;
  }
  if (server === null) {
    return FAILURE_DIAGNOSTICS;
  }
  if (health === null) {
    return FAILURE_HEALTH;
  }
  return null;
}

/** 从任意抛出值里取可展示的消息，兜底为「未知错误」。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return '未知错误';
}
