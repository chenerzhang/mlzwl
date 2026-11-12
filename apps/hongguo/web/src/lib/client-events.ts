/**
 * 前端事件环形缓冲。
 *
 * 目的是排障时能拿到「出问题前用户点了什么」，而不是做分析。所以只保留最近
 * 200 条，满了丢最旧的，不落盘、不上报、不读 `window` / `document`（测试跑在
 * node 环境，import 期不能碰浏览器全局）。
 *
 * 记录内容必须能安全外传：`detail` 由调用方保证不含 query 与凭据，本模块不再
 * 脱敏——这里没有 URL 解析的上下文，补一层「看起来像密钥就抹掉」的猜测只会
 * 给出虚假的安全感。真正的脱敏边界在服务端（`redact`）。
 */

/** 缓冲容量。与服务端 `/api/diagnostics` 返回的日志行数对齐。 */
export const CLIENT_EVENT_LIMIT = 200;

export interface ClientEvent {
  /** 事件类别，如 `api-error`。用英文短标识，便于 grep。 */
  kind: string;
  /** 事件细节，如 `/api/search 502 search_failed`。**不得**含 query 与凭据。 */
  detail: string;
}

/** 定长环形缓冲：满了覆盖最旧的一条，内存占用恒定。 */
const buffer: ClientEvent[] = [];

/**
 * 记一条事件。
 *
 * `kind` / `detail` 都截断：单条事件不该因为异常长（比如把整个响应体塞进
 * `detail`）把 200 条预算撑爆。
 */
export function record(event: ClientEvent): void {
  buffer.push({ kind: truncate(event.kind, 64), detail: truncate(event.detail, 512) });
  if (buffer.length > CLIENT_EVENT_LIMIT) {
    buffer.splice(0, buffer.length - CLIENT_EVENT_LIMIT);
  }
}

/**
 * 取当前快照。
 *
 * 返回副本：调用方（将来的「导出诊断」）要能安全地遍历、序列化，而内部缓冲
 * 仍会在遍历过程中被继续写入。
 *
 * **当前无 UI 调用方**：供 P2 的「导出诊断」按钮使用。数据已经在写了——
 * `api-client.ts` 的 `request()` 失败时调 `record()`——所以这个导出只是读口，
 * 不是待实现的数据采集。留在这里而不是删掉，是为了让 P2 接按钮时不用重新推导
 * 缓冲的生命周期。
 */
export function snapshot(): readonly ClientEvent[] {
  return buffer.map((event) => ({ ...event }));
}

/**
 * 把请求路径削成「可以写进诊断」的形式：只留 `path`，丢掉 `?` 之后的全部内容。
 *
 * 必须显式做，不能指望调用方传干净的 path：`api.search()` 的路径本身就带
 * `?keyword=...`，而搜索词是用户输入，属于不该进诊断数据的内容。
 */
export function stripQuery(path: string): string {
  const index = path.indexOf('?');
  return index === -1 ? path : path.slice(0, index);
}

/**
 * 一次失败请求的诊断文案：`<path> <status> <code>`，`code` 缺失时省掉尾段。
 *
 * 单独抽成纯函数是为了能测：`request()` 里夹着 `fetch`，整条路径不好单测。
 */
export function apiErrorDetail(path: string, status: number, code: string | undefined): string {
  const base = `${stripQuery(path)} ${status}`;
  return code === undefined ? base : `${base} ${code}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
