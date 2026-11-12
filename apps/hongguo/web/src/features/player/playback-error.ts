import type { MediaErrorCode } from '@mlzwl/hongguo-shared';

/**
 * 播放错误文案与可用动作。
 *
 * 纯逻辑模块：**import 期不访问 `window` / `document` / `localStorage`**，这样
 * `vitest` 能在默认 node 环境里直接测（见 `apps/hongguo/AGENTS.md` 的 web 测试边界）。
 */

/** 用户能采取的动作。`none` 表示没有可点的按钮，只显示文案。 */
export type PlaybackErrorAction = 'retry' | 'switch-definition' | 'none';

export interface PlaybackErrorHint {
  message: string;
  action: PlaybackErrorAction;
}

/** 没有任何 code 时的兜底文案：这才是真的「浏览器解不了这个编码」。 */
const CODEC_MESSAGE = '当前浏览器无法播放该视频（HEVC 编码需要 Safari / Edge / Chrome）';

/**
 * 探测本身失败（离线、被中断、服务端返回非 JSON 的 5xx）时的哨兵值。
 *
 * **不是服务端契约**：不能加进 `MEDIA_ERROR_CODES`（那是 server 与 web 共用的
 * code 表）。它只活在浏览器这一层，用来把「传输层故障」与「编码不支持」分开——
 * 否则 `describePlaybackError(undefined)` 会退回 HEVC 文案，把网络问题报成编码问题。
 */
export const PROBE_FAILED = 'probe_failed';

/** 停滞判定的默认窗口，与上游播放器的 `stallTimeout` 一致。 */
export const STALL_TIMEOUT_MS = 20_000;

const HINTS: Record<MediaErrorCode, PlaybackErrorHint> = {
  media_timeout: { message: '上游响应超时', action: 'retry' },
  media_not_video: { message: '上游返回的不是视频，可能被风控拦截', action: 'retry' },
  media_too_large: { message: '视频体积超出上限', action: 'none' },
  media_upstream_4xx: { message: '上游拒绝了请求', action: 'retry' },
  media_upstream_5xx: { message: '上游服务异常', action: 'retry' },
  decrypt_failed: { message: '解密失败，建议换一档清晰度', action: 'switch-definition' },
  no_stream: { message: '该集没有可播放的地址', action: 'none' },
  key_unavailable: { message: '暂时拿不到播放密钥', action: 'retry' },
  not_encrypted: { message: '该集的加密格式不受支持', action: 'none' },
};

/** 类型守卫：用文案表的键做判定。
 *
 * 不用 `MEDIA_ERROR_CODES`：那是值导入，会把 shared 的 barrel（连带 `zod`）
 * 拉进浏览器包。实测这样会让 web 包从 341 kB 涨到 430 kB。这里只导入类型
 * （编译期擦除），并用 `Record<MediaErrorCode, ...>` 的穷尽性保证两端 code 一致：
 * 后端新增 code 而前端没补文案时，`tsc` 会直接报缺键。
 */
export function isMediaErrorCode(value: string | undefined): value is MediaErrorCode {
  if (value === undefined) {
    return false;
  }
  // `Object.hasOwn` 而不是 `in`：后者会命中 `toString` 之类的原型键。
  return Object.hasOwn(HINTS, value);
}

/**
 * 把服务端错误码翻译成文案与动作。
 *
 * `status` 只在没有 code 时参与判断：`404` 说明这集不存在（重试没用），其余情况
 * 才是编码问题——这是 P0-5 要修的缺陷，之前四种原因都给同一句 HEVC 提示。
 *
 * `PROBE_FAILED` 先于一切判断：它是浏览器侧的哨兵（不是服务端 code），代表探测
 * 本身失败，必须报成可重试的服务异常，绝不能退到 `CODEC_MESSAGE`。
 */
export function describePlaybackError(code: string | undefined, status?: number): PlaybackErrorHint {
  if (code === PROBE_FAILED) {
    return { message: '网络或服务异常，请稍后重试', action: 'retry' };
  }
  if (isMediaErrorCode(code)) {
    return HINTS[code];
  }
  if (status === 404) {
    return { message: '该集不存在', action: 'none' };
  }
  return { message: CODEC_MESSAGE, action: 'none' };
}

export interface StallState {
  playing: boolean;
  /** 页面是否在后台。后台时浏览器会暂停解码，不算停滞。 */
  hidden: boolean;
  currentTime: number;
  /** 上一次观测到 `currentTime` 变化的时间戳（毫秒）。 */
  lastProgressAt: number;
  /** 当前时间戳（毫秒）。 */
  now: number;
  /** 判定窗口；省略时用 `STALL_TIMEOUT_MS`。 */
  timeoutMs?: number;
}

/**
 * 是否算播放停滞。
 *
 * 三个条件必须同时成立：正在播放、页面在前台、`currentTime` 超过窗口没有变化。
 * 用「上次变化时间」而不是「连续采样相等」：缓冲 1 秒就恢复的情况不该报停滞，
 * 时间戳差天然带上了这段抖动容忍。
 *
 * `currentTime` 只作为观测值随状态传入（调用方本来就持有它，日志与调试要用），
 * 判定本身只比较 `lastProgressAt` 与 `now`。
 */
export function isStalled(state: StallState): boolean {
  if (!state.playing || state.hidden) {
    return false;
  }
  const timeout = state.timeoutMs ?? STALL_TIMEOUT_MS;
  return state.now - state.lastProgressAt >= timeout;
}

/**
 * 探测媒体地址的真实失败原因。
 *
 * `<video>` 的 `error` 事件不给 HTTP 状态码，只给 `MediaError` 枚举，无法区分
 * 「上游 500」和「编码不支持」。这里用一次 2 字节的 Range 请求拿响应头：
 * 服务端在写头之前就完成了下载与解密，所以失败时响应体是 JSON `{ code, message }`。
 *
 * `fetchImpl` 显式传入，测试里可以注入假的 fetch，不必伪造全局对象。
 *
 * 失败分两类，不能合并：
 * - 服务端给出了稳定的 `code`：返回该 code，交给 `describePlaybackError` 选文案。
 * - 探测本身失败（网络断了、5xx 且不是 JSON）：返回 `PROBE_FAILED`。不能返回
 *   `undefined`，否则会退回「HEVC 不兼容」的错文案——传输层故障被报成编码问题。
 */
export async function probePlaybackError(src: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(src, { headers: { range: 'bytes=0-1' }, signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      return undefined;
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/json')) {
      // 5xx 的非 JSON 响应（反代 / 网关的 HTML 错误页）说明是传输层故障，不能退成
      // 「编码不支持」。4xx 的非 JSON 保持原行为：它不像服务异常，且没有 code 可用。
      return response.status >= 500 ? PROBE_FAILED : undefined;
    }
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = (body as { code: unknown }).code;
      if (typeof code === 'string') {
        return code;
      }
    }
    // 5xx 里没拿到可用 `code`（例如 Fastify 默认错误体 `{ statusCode, error, message }`）
    // 同样是服务异常，不能报成编码问题。4xx 保持原行为：它不像传输层故障。
    return response.status >= 500 ? PROBE_FAILED : undefined;
  } catch {
    // 探测本身失败（离线、被中断、响应不是合法 JSON）时不能退成编码文案。
    return PROBE_FAILED;
  }
}
