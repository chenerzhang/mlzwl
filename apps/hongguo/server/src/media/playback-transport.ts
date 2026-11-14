import { gunzipSync } from 'node:zlib';
import type { Transport, TransportRequest, TransportResponse } from 'openhongguo';

/**
 * 把 SDK 的 `video_model/v1` 调用改写成上游仍在服务的 `multi_video_model/v1`。
 *
 * ## 为什么需要这一层
 *
 * 2026-11-13 之后 `POST /novel/player/video_model/v1/` 对任何请求体都返回
 * HTTP 200 + **0 字节**（无错误码），`openhongguo` 因此报
 * `anonymous response was empty`，`/api/episodes/:id/playback` 全线 500。
 * 上游改成 `multi_video_model/v1` 之后才继续服务。
 *
 * 第二个坑：`multi_video_model/v1` 在 `device_platform=android` 与 `aid=8662`
 * **同时出现**时会返回 0 字节。这是官方 App 的身份指纹判定，不是匿名配额，
 * 也不是签名问题。
 *
 * **只删 `aid`，保留 `device_platform`**。这一点很关键，两个参数都删虽然也能拿到
 * 数据，但上游会降级成另一套响应形态：`video_list` 变成 `{video_1:…}` 对象、
 * 只剩 4 档（缺 1080p）、`spade_a` 从 `encrypt_info` 挪到顶层、`main_url` 变成
 * base64 编码。保留 `device_platform=android` 时上游返回的是**旧接口原样结构**：
 * `video_list` 数组、5 档（含 1080p）、`encrypt_info.spade_a`、明文 `main_url`。
 * 这样 SDK 和 `VideoModelCapture` 都不用改。
 *
 * 实测证据见 `docs/adr-app-feasibility.md` §7.1.2。
 *
 * ## 为什么在 Transport 层做
 *
 * SDK 是 WASM，改不动。`HongguoService` 已经用装饰器把 SDK 的 transport 包了
 * 一层（`VideoModelCapture` 就是这么挂的），所以这里只加一个装饰器：
 * 不改 SDK、不改 `web/`、不改 `shared/`。
 */
export function rewriteVideoModelRequest(inner: Transport): Transport {
  return async (request: TransportRequest): Promise<TransportResponse> => {
    const rewritten = toMultiVideoModel(request);
    if (rewritten === null) {
      return inner(request);
    }
    const response = await inner(rewritten.request);
    return liftVideoModel(response, rewritten.videoId);
  };
}

/** 旧接口路径。命中这个才改写。 */
const VIDEO_MODEL_PATH = '/novel/player/video_model/';
/** 新接口路径。 */
const MULTI_VIDEO_MODEL_PATH = '/novel/player/multi_video_model/v1/';

/**
 * 新接口要求 `video_platform`。实测只有 `1024` 能取到数据，
 * 其它值（3 / 0 / 1）返回 `code 100001 参数错误`。
 */
const VIDEO_PLATFORM = 1024;

/**
 * `mixed_video_id_map` 的键。`hongguo-drama` 用的是 `1004`，实测可用。
 * 这个值的含义上游未公开，按「短剧视频」使用。
 */
const MIXED_VIDEO_ID_KEY = '1004';

/** 改写后的请求，以及后续用于从响应里取回 `video_model` 的 video id。 */
interface Rewrite {
  request: TransportRequest;
  videoId: string;
}

/**
 * 把 `video_model` 请求转成 `multi_video_model` 请求。
 *
 * 不是 `video_model` 请求时返回 `null`，调用方原样转发。
 */
function toMultiVideoModel(request: TransportRequest): Rewrite | null {
  if (!request.url.includes(VIDEO_MODEL_PATH)) {
    return null;
  }
  const videoId = readVideoId(request);
  if (videoId === null) {
    // 读不出 id 就无法构造 `mixed_video_id_map`。原样转发，让 SDK 自己报错——
    // 在这里编一个假 id 只会让上游返回更难懂的空响应。
    return null;
  }

  const url = new URL(request.url);
  url.pathname = MULTI_VIDEO_MODEL_PATH;
  // 只删 `aid`。它和 `device_platform=android` 同时出现时上游返回 0 字节。
  // 不要顺手把 `device_platform` 也删掉：那会让上游降级成另一套响应形态，
  // 档位变少、结构变形，见文件头注释。
  url.searchParams.delete('aid');

  const body = JSON.stringify({
    biz_param: {
      need_all_video_definition: true,
      video_platform: VIDEO_PLATFORM,
    },
    mixed_video_id_map: { [MIXED_VIDEO_ID_KEY]: [videoId] },
  });

  return {
    request: {
      ...request,
      url: url.toString(),
      body: new Uint8Array(Buffer.from(body, 'utf8')),
    },
    videoId,
  };
}

/** 从 SDK 的请求体里取 `video_id`。 */
function readVideoId(request: TransportRequest): string | null {
  if (request.body.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(request.body).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = (parsed as Record<string, unknown>)['video_id'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把新接口的 `data[<vid>].video_model` 提升成旧接口的 `data.video_model`。
 *
 * 新接口按视频 id 分组，旧接口只有一层。SDK 读的是 `data.video_model`，
 * 所以这里把那一层拆掉。`video_model` 保持**字符串**形态不动——旧接口也是字符串，
 * `VideoModelCapture` 依赖这个形态（见 `readVideoModel`）。
 *
 * 任何一步不符合预期都原样返回，不改动响应：宁可让 SDK 报它自己的错，
 * 也不要在这里造一个结构不完整的响应。
 */
function liftVideoModel(response: TransportResponse, videoId: string): TransportResponse {
  if (response.body.length === 0) {
    return response;
  }
  const text = decodeBody(response);
  if (text === null) {
    return response;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return response;
  }
  if (typeof payload !== 'object' || payload === null) {
    return response;
  }
  const data = (payload as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) {
    return response;
  }
  const grouped = data as Record<string, unknown>;
  const entry = grouped[videoId];
  if (typeof entry !== 'object' || entry === null) {
    return response;
  }
  if (!('video_model' in (entry as Record<string, unknown>))) {
    return response;
  }

  // 保留 entry 的其余字段（`episode_id` 之类），把 `video_model` 提到 `data` 下，
  // 再删掉按 id 分组的那一层。
  const lifted = { ...(entry as Record<string, unknown>) };
  const model = lifted['video_model'];
  if (typeof model === 'string') {
    const normalized = normalizeVideoModel(model);
    if (normalized !== null) {
      lifted['video_model'] = normalized;
    }
  }

  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  next['data'] = lifted;

  const body = new Uint8Array(Buffer.from(JSON.stringify(next), 'utf8'));
  const headers = { ...response.headers };
  // 长度变了，留着旧值会误导下游。
  delete headers['content-length'];
  delete headers['Content-Length'];
  return { ...response, headers, body };
}

/**
 * 把新接口的 `video_model` 归一成旧接口的形状。
 *
 * **正常情况下不会走到这里**：只要保留 `device_platform=android`，上游返回的就是
 * 旧接口原样结构。这个函数是兜底，用于上游以后改回降级形态的情况。
 *
 * 两处差异：
 * 1. `video_list` 是 `{video_1: {...}, video_2: {...}}` 对象，旧接口是数组。
 * 2. `main_url` / `backup_url` 是 base64 编码的明文 URL，旧接口是明文。
 *
 * 解析失败或结构不符时返回 `null`，由调用方保留原始字符串——宁可让 SDK 报它自己的
 * 错，也不要造一个半成品。
 */
function normalizeVideoModel(raw: string): string | null {
  let model: unknown;
  try {
    model = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof model !== 'object' || model === null) {
    return null;
  }
  const record = model as Record<string, unknown>;

  const list = record['video_list'];
  if (typeof list === 'object' && list !== null && !Array.isArray(list)) {
    // 按 `video_1`..`video_5` 的序号排，让输出顺序稳定（对象键顺序本身不保证）。
    const entries = Object.entries(list as Record<string, unknown>)
      .sort(([a], [b]) => numericSuffix(a) - numericSuffix(b))
      .map(([, value]) => value);
    record['video_list'] = entries;
  }

  if (Array.isArray(record['video_list'])) {
    for (const entry of record['video_list']) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const item = entry as Record<string, unknown>;
      for (const key of ['main_url', 'backup_url']) {
        const decoded = decodeUrlField(item[key]);
        if (decoded !== null) {
          item[key] = decoded;
        }
      }
      // 有的档位把地址放在 `backup_url_list` 里，同样要解。
      const backupList = item['backup_url_list'];
      if (Array.isArray(backupList)) {
        item['backup_url_list'] = backupList.map((value) => decodeUrlField(value) ?? value);
      }
    }
  }

  return JSON.stringify(record);
}

/** 取 `video_3` 里的 `3`。取不到时返回一个很大的值，让它排在最后。 */
function numericSuffix(key: string): number {
  const match = /(\d+)$/.exec(key);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

/**
 * 把 base64 的地址字段解成明文。
 *
 * 已经是明文（`http://` / `https://` 开头）时原样返回，所以新旧两种形态都能处理。
 * 解出来不是 URL 时返回 `null`，调用方保留原值。
 */
function decodeUrlField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  return decoded.startsWith('http://') || decoded.startsWith('https://') ? decoded : null;
}

/**
 * 取出响应体的文本。
 *
 * 解 gzip 是因为 SDK 要的是原始字节，但这里要读 JSON。解压失败返回 `null`，
 * 由调用方原样转发未解压的响应。
 */
function decodeBody(response: TransportResponse): string | null {
  const bytes = Buffer.from(response.body);
  const encoding = response.headers['content-encoding'] ?? response.headers['Content-Encoding'] ?? '';
  if (encoding.includes('gzip') || (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    try {
      return gunzipSync(bytes).toString('utf8');
    } catch {
      return null;
    }
  }
  return bytes.toString('utf8');
}
