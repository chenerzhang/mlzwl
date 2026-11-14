/**
 * /api/* 适配层：把 web/dist 页面发出的请求转成 WASM SDK 调用。
 *
 * ## 为什么需要它
 *
 * `web/dist` 是给自建 server 写的，所有数据都走 `/api/*`（`web/src/lib/api-client.ts`）。
 * 在 WebView 里没有 server，这些请求会 404，页面显示「加载失败」。
 *
 * 这一层把 `/api/*` 接到本地的 WASM SDK 上，并把上游模型映射成页面期望的契约
 * （逻辑移植自 `server/src/catalog/catalog.mapper.ts` 与 `catalog.service.ts`）。
 *
 * ## 为什么注入到 `<head>` 最前、且不是 module
 *
 * 页面 bundle 是 ES module。`api-client.ts` 在模块顶层取 `fetch`，所以拦截必须
 * 早于任何 module 执行。普通脚本同步执行，能满足这个顺序。
 *
 * ## 契约
 *
 * 响应体形状必须与 server 一致（`shared/src/schemas/api.ts`），否则页面的 zod
 * 校验会失败。错误体是 `{ code, message }`。
 */
(function () {
  'use strict';

  const LOG = (msg, cls) => {
    // eslint-disable-next-line no-console
    console.log('[hgAdapter] ' + msg);
    if (window.__hgAdapterLog) {
      window.__hgAdapterLog(msg, cls);
    }
  };

  // ---------------------------------------------------------------- 上游模型 → 页面契约

  /** 与 server 一致的封面路径前缀（`shared/src/definitions.ts` 的 `COVER_PATH_PREFIX`）。 */
  const COVER_PATH_PREFIX = '/api/cover/';

  /**
   * 字符串 → base64url（无填充）。
   *
   * 先按 UTF-8 转字节再编码：上游地址里可能有非 ASCII 字符，
   * 直接 `btoa(str)` 会抛 `InvalidCharacterError`。
   */
  function base64UrlEncode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * 上游封面地址 → 页面用的地址。
   *
   * 上游封面是 **HEIC**（实测 `...heic`），WebView 不解码，所以改写成原生侧
   * 代理地址，由 Kotlin 用 `BitmapFactory` 转成 JPEG。这一步对应 server 的
   * `CoverProxyService`。
   *
   * ## 为什么用 `/api/cover/<base64url>` 而不是 `/api/cover?url=`
   *
   * `@mlzwl/hongguo-shared` 的 `isCoverProxyUrl()` 只接受
   * `${COVER_PATH_PREFIX}<base64url 令牌>` 这一种形式。它用在离线目录、
   * 观看历史、收藏三处的**持久化过滤**上：早期版本把完整签名 URL 编进
   * `/api/cover?u=...`，那些值可能还在 `localStorage` 里，所以读取时要把
   * 不符合新格式的丢掉。
   *
   * 壳内早期用 `?url=` 形式，结果被同一个函数过滤掉：离线目录快照里
   * `coverUrl` 被整个丢弃，首屏用快照做 `placeholderData`，9 张卡片全部
   * 退化成「无封面」。换档后首次渲染正常、断网或重进才出问题，很容易漏。
   *
   * ## 为什么不用 server 那种加密令牌
   *
   * server 的令牌是 AES-GCM 加密的，密钥在服务端；壳内没有这个密钥，也不该
   * 有。壳里只要求「格式合法 + 原生能还原」，所以用 base64url 明文编码。
   * 安全边界不同：server 的令牌防止用户构造任意上游地址；壳内则由原生侧
   * `HostAllowlist` 把关，非法地址一律 403。
   */
  function coverOf(source) {
    if (typeof source !== 'string' || source === '') {
      return {};
    }
    return { coverUrl: COVER_PATH_PREFIX + base64UrlEncode(source) };
  }

  function toSeriesSummary(source) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    return {
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...coverOf(source.cover_url),
      ...(source.episode_count === undefined ? {} : { episodeCount: source.episode_count }),
      ...(source.author === undefined ? {} : { author: source.author }),
      ...(source.category === undefined ? {} : { category: source.category }),
    };
  }

  function toEpisode(source) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    return {
      id: source.id,
      seriesId: source.series_id,
      number: source.number,
      ...(source.title === undefined ? {} : { title: source.title }),
      playable: source.playable,
      ...coverOf(source.cover_url),
      ...(source.comment_count === undefined ? {} : { commentCount: source.comment_count }),
      ...(source.digg_count === undefined ? {} : { diggCount: source.digg_count }),
    };
  }

  function toSeriesDetail(source, episodes) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    return {
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...coverOf(source.cover_url),
      ...(source.episode_count === undefined ? {} : { episodeCount: source.episode_count }),
      episodes: (episodes || []).map(toEpisode).filter((e) => e !== null),
    };
  }

  /** 与 server 的 `toSeriesPage` 一致：`has_more` 为假或 cursor 为空时给 null。 */
  function toSeriesPage(page) {
    const cursor = page && page.cursor;
    const items = ((page && page.items) || []).map(toSeriesSummary).filter((i) => i !== null);
    return {
      items,
      cursor: page && page.has_more && cursor !== undefined && cursor !== '' ? cursor : null,
    };
  }

  /**
   * 把松散的上游榜单行转成稳定结构。移植自 `server/src/catalog/ranking-rows.ts`。
   *
   * 规则刻意严格，因为单条脏数据不该让整个榜单变成 500：
   * 只用 `position`（不用 `rank`，推广行会照拄下一行名次）、缺 `series_id`
   * 或标题的行丢弃、非法集数丢弃整行、按 `series_id` 去重保留首次出现。
   */
  function toRankingEntries(rows) {
    const seen = new Set();
    const entries = [];
    for (const row of rows || []) {
      const position = row && row.position;
      if (typeof position !== 'number' || !Number.isInteger(position) || position <= 0) {
        continue;
      }
      const seriesId = row.series_id;
      if (typeof seriesId !== 'string' || seriesId.trim() === '') {
        continue;
      }
      const title = row.title;
      if (typeof title !== 'string' || title.trim() === '') {
        continue;
      }
      const episodeCount = row.episode_count;
      if (episodeCount !== undefined && (!Number.isInteger(episodeCount) || episodeCount < 0)) {
        continue;
      }
      if (seen.has(seriesId)) {
        continue;
      }
      seen.add(seriesId);
      entries.push({
        position,
        seriesId,
        title,
        ...(typeof row.cover_url === 'string' ? { coverUrl: row.cover_url } : {}),
        ...(episodeCount === undefined ? {} : { episodeCount }),
        ...(typeof row.score === 'string' ? { score: row.score } : {}),
        ...(typeof row.promoted === 'boolean' ? { promoted: row.promoted } : {}),
      });
    }
    return entries;
  }

  function toRankingEntry(source) {
    return {
      position: source.position,
      seriesId: source.seriesId,
      title: source.title,
      ...(source.coverUrl === undefined ? {} : coverOf(source.coverUrl)),
      ...(source.episodeCount === undefined ? {} : { episodeCount: source.episodeCount }),
      ...(source.score === undefined ? {} : { score: source.score }),
      ...(source.promoted === undefined ? {} : { promoted: source.promoted }),
    };
  }

  /**
   * 把榜单行过滤成随机候选。移植自 `server/src/catalog/random-pick.ts`。
   *
   * 榜单里的演员行只有 `user_id` 没有 `series_id`，不过滤会让随机入口跳到
   * `/series/undefined`。先校验后去重，这样「第一条不合法、第二条合法」时仍能留下。
   */
  function toRandomCandidates(rows) {
    const seen = new Set();
    const candidates = [];
    for (const row of rows || []) {
      const seriesId = row && row.series_id;
      if (typeof seriesId !== 'string' || seriesId.trim() === '') {
        continue;
      }
      const title = row.title;
      if (typeof title !== 'string' || title.trim() === '') {
        continue;
      }
      const episodeCount = row.episode_count;
      if (episodeCount !== undefined && (!Number.isInteger(episodeCount) || episodeCount < 0)) {
        continue;
      }
      if (seen.has(seriesId)) {
        continue;
      }
      seen.add(seriesId);
      candidates.push({
        seriesId,
        title,
        ...(typeof row.cover_url === 'string' ? { coverUrl: row.cover_url } : {}),
        ...(episodeCount === undefined ? {} : { episodeCount }),
      });
    }
    return candidates;
  }

  /**
   * 搜索词归一化。移植自 `server/src/catalog/search-text.ts` 的意图：
   * 上游对全角标点敏感，归一化后为空就不打上游。
   */
  function normalizeSearchText(text) {
    return String(text == null ? '' : text)
      .replace(/[\u3000\s]+/g, ' ')
      .replace(/[，。、；：？！“”‘’（）《》【】…—～]/g, '')
      .trim();
  }

  // ---------------------------------------------------------------- 错误

  class ApiError extends Error {
    constructor(status, message, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  /** 把 SDK 抛出的错误转成 server 风格的错误体。 */
  function toHttpError(error) {
    const message = error && error.message ? String(error.message) : String(error);
    const code = error && error.code ? String(error.code) : undefined;
    // 上游明确说「内容不可用」时是参数问题，映射成 400，与 server 一致。
    if (code === 'CONTENT_UNAVAILABLE' || code === 'PARAM_INVALID') {
      return new ApiError(400, message, code);
    }
    return new ApiError(500, message, code === undefined ? 'upstream_error' : code);
  }

  // ---------------------------------------------------------------- SDK 启动

  let sdkPromise = null;

  /**
   * 启动 WASM SDK 并返回 client。
   *
   * 设备档案放 localStorage：WebView 的 `domStorageEnabled` 已打开，
   * 且这样重装 APK 才会丢档案（与 server 的 SQLite 语义接近）。
   */
  function startSdk() {
    sdkPromise ??= (async () => {
      if (typeof globalThis.Go !== 'function') {
        throw new Error('wasm_exec.js 未加载，无法启动 SDK');
      }
      const resp = await fetch('/openhongguo.wasm');
      if (!resp.ok) {
        throw new Error('wasm 下载失败: HTTP ' + resp.status);
      }
      const bytes = await resp.arrayBuffer();
      const go = new globalThis.Go();
      const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
      go.run(instance);

      for (let i = 0; i < 200 && !globalThis.__openhongguo; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!globalThis.__openhongguo) {
        throw new Error('SDK 启动超时（__openhongguo 未出现）');
      }

      const profile = {
        load: async () => localStorage.getItem('ohg'),
        save: async (p) => localStorage.setItem('ohg', p),
        reset: async () => localStorage.removeItem('ohg'),
      };

      const created = globalThis.__openhongguo.newClient({
        transport: bridgeTransport,
        profile,
        options: JSON.stringify({ retryAttempts: 1 }),
      });
      if (created.error) {
        throw new Error('newClient 失败: ' + JSON.stringify(created.error));
      }
      LOG('SDK 就绪');
      return created.call;
    })();
    return sdkPromise;
  }

  /** 调一个 SDK 方法。`call(name, argsJson)`，参数是数组的 JSON。 */
  async function sdkCall(name, ...args) {
    const call = await startSdk();
    const out = await call(name, JSON.stringify(args));
    return out === undefined || out === 'null' ? undefined : JSON.parse(out);
  }

  // ---------------------------------------------------------------- Kotlin 桥接

  const pending = new Map();
  let nextId = 1;

  function installBridgeListener() {
    if (!window.hgBridge) {
      LOG('hgBridge 不存在：无法访问上游');
      return false;
    }
    window.hgBridge.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) {
        return;
      }
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg);
      }
    };
    return true;
  }

  /**
   * SDK 的 Transport 契约：返回 `{ status, headers, cookies, body }`。
   *
   * ## 为什么要在这里改写请求
   *
   * 上游 `POST /novel/player/video_model/v1/` 已下线（2026-11-13 之后恒返 200 + 0 字节），
   * SDK 因此报 `ANONYMOUS_LIMITED`，播放全线失败。新接口是 `multi_video_model/v1`。
   *
   * SDK 是 WASM，改不动；端上也没有 server 侧那个装饰器。能挂的钩子只有这里。
   * 逻辑移植自 `server/src/media/playback-transport.ts`，包括那个关键细节：
   * **只删 `aid`，保留 `device_platform`**，否则上游降级成 4 档 + 另一套响应结构。
   */
  function bridgeTransport(req) {
    const rewritten = toMultiVideoModel(req);
    const sent = rewritten === null ? req : rewritten.request;

    return postToHost(sent).then((msg) => {
      const response = {
        status: msg.status,
        headers: msg.headers || {},
        cookies: msg.cookies || {},
        body: msg.bodyBase64
          ? Uint8Array.from(atob(msg.bodyBase64), (c) => c.charCodeAt(0))
          : new Uint8Array(0),
      };
      return rewritten === null ? response : liftVideoModel(response, rewritten.videoId);
    });
  }

  function postToHost(req) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      let bodyBase64 = '';
      if (req.body && req.body.length) {
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < req.body.length; i += chunk) {
          bin += String.fromCharCode.apply(null, req.body.subarray(i, i + chunk));
        }
        bodyBase64 = btoa(bin);
      }
      window.hgBridge.postMessage(
        JSON.stringify({
          id,
          method: req.method || 'GET',
          url: req.url,
          headers: req.headers || {},
          bodyBase64,
        }),
      );
    });
  }

  // ---- 视频接口改写（移植自 server/src/media/playback-transport.ts）

  const VIDEO_MODEL_PATH = '/novel/player/video_model/';
  const MULTI_VIDEO_MODEL_PATH = '/novel/player/multi_video_model/v1/';
  /** 实测只有 1024 能取到数据，其它值上游报 `code 100001 参数错误`。 */
  const VIDEO_PLATFORM = 1024;
  /** `mixed_video_id_map` 的键；`hongguo-drama` 用这个值，实测可用。 */
  const MIXED_VIDEO_ID_KEY = '1004';

  function toMultiVideoModel(req) {
    if (typeof req.url !== 'string' || req.url.indexOf(VIDEO_MODEL_PATH) < 0) {
      return null;
    }
    const videoId = readVideoId(req);
    if (videoId === null) {
      return null;
    }
    const url = new URL(req.url);
    url.pathname = MULTI_VIDEO_MODEL_PATH;
    // 只删 `aid`。它与 `device_platform=android` 同时出现时上游返回 0 字节。
    // 不要顺手删 `device_platform`：那会让上游降级成 4 档 + 另一套结构。
    url.searchParams.delete('aid');

    const body = JSON.stringify({
      biz_param: { need_all_video_definition: true, video_platform: VIDEO_PLATFORM },
      mixed_video_id_map: { [MIXED_VIDEO_ID_KEY]: [videoId] },
    });
    return {
      request: {
        ...req,
        url: url.toString(),
        body: new TextEncoder().encode(body),
      },
      videoId,
    };
  }

  function readVideoId(req) {
    if (!req.body || req.body.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(req.body));
      const value = parsed && parsed.video_id;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * 把新接口的 `data[<vid>].video_model` 提升成旧接口的 `data.video_model`。
   *
   * SDK 读 `data.video_model`，所以要把按 id 分组的那一层拆掉。任何一步不符合
   * 预期就原样返回，不造半成品响应。
   */
  function liftVideoModel(response, videoId) {
    if (response.body.length === 0) {
      return response;
    }
    const text = decodeBodyText(response);
    if (text === null) {
      return response;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return response;
    }
    if (!payload || typeof payload !== 'object') {
      return response;
    }
    const data = payload.data;
    if (!data || typeof data !== 'object') {
      return response;
    }
    const entry = data[videoId];
    if (!entry || typeof entry !== 'object' || !('video_model' in entry)) {
      return response;
    }

    const lifted = Object.assign({}, entry);
    if (typeof lifted.video_model === 'string') {
      const normalized = normalizeVideoModel(lifted.video_model);
      if (normalized !== null) {
        // 顺手把雪碧图元数据存下来：SDK 只拿到整理后的结果，`big_thumbs`
        // 不会传给它。不在这里存，进度条缩略图就永远拿不到。
        // `normalizeVideoModel` 返回的是 JSON **字符串**，要再解一次。
        const sprite = parseSprite(normalized);
        if (sprite !== null) {
          // 实测请求体的 `video_id` 就是 episode id，但上游不保证永远相同，
          // 所以 `episode_id` 也存一份。
          let episodeId = null;
          try {
            episodeId = JSON.parse(normalized).episode_id;
          } catch {
            episodeId = null;
          }
          rememberSprite(sprite, videoId, typeof episodeId === 'string' ? episodeId : null);
        }
        lifted.video_model = normalized;
      }
    }
    const next = Object.assign({}, payload, { data: lifted });

    const headers = Object.assign({}, response.headers);
    // 长度变了，留着旧值会误导下游。
    delete headers['content-length'];
    delete headers['Content-Length'];
    return Object.assign({}, response, {
      headers,
      body: new TextEncoder().encode(JSON.stringify(next)),
    });
  }

  /**
   * 兜底：把降级形态的 `video_model` 归一成旧接口形状。
   *
   * 保留 `device_platform=android` 时上游返回的就是旧结构，所以正常不会走到。
   */
  function normalizeVideoModel(raw) {
    let model;
    try {
      model = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!model || typeof model !== 'object') {
      return null;
    }
    const list = model.video_list;
    if (list && typeof list === 'object' && !Array.isArray(list)) {
      model.video_list = Object.keys(list)
        .sort((a, b) => numericSuffix(a) - numericSuffix(b))
        .map((k) => list[k]);
    }
    if (Array.isArray(model.video_list)) {
      for (const item of model.video_list) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        for (const key of ['main_url', 'backup_url']) {
          const decoded = decodeUrlField(item[key]);
          if (decoded !== null) {
            item[key] = decoded;
          }
        }
        if (Array.isArray(item.backup_url_list)) {
          item.backup_url_list = item.backup_url_list.map((v) => decodeUrlField(v) || v);
        }
      }
    }
    return JSON.stringify(model);
  }

  function numericSuffix(key) {
    const m = /(\d+)$/.exec(key);
    return m === null ? Number.MAX_SAFE_INTEGER : parseInt(m[1], 10);
  }

  function decodeUrlField(value) {
    if (typeof value !== 'string' || value === '') {
      return null;
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    try {
      const decoded = atob(value);
      return decoded.startsWith('http://') || decoded.startsWith('https://') ? decoded : null;
    } catch {
      return null;
    }
  }

  /**
   * 取响应体文本。gzip 由 OkHttp 自动解压（没显式设 `Accept-Encoding`），
   * 但上游可能强制 gzip，所以这里再兜一层。
   */
  function decodeBodyText(response) {
    const bytes = response.body;
    const encoding = response.headers['content-encoding'] || response.headers['Content-Encoding'] || '';
    if (encoding.indexOf('gzip') >= 0 || (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      // WebView 里没有同步的 gunzip；声明 gzip 但内容已解压时会在这里失败，
      // 那就按原文当 JSON 解析，失败则原样返回。
      return null;
    }
    try {
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 路由表

  /**
   * 每个处理器返回 `{ status, body }` 或抛 `ApiError`。
   *
   * 参数从 URL 的 query 里取，与 server 的 `@Query` 一一对应。
   */
  /**
   * 上游 `big_thumbs[0]` 缓存。
   *
   * SDK 的 `resolvePlayback` 只返回整理过的结果，**不包含** `big_thumbs`。
   * 进度条缩略图必须从原始 `video_model` 响应里取，所以在
   * `liftVideoModel` 解析响应时顺手存一份。
   *
   * 键是 video id（与 `episode_id` 实测相同，但不保证永远相同），
   * 两个都存一份（见 `rememberSprite`）。
   */
  const spriteCache = new Map();

  /**
   * 从 `video_model` 对象里读雪碧图元数据。
   *
   * 字段名是蛇形：`img_num`、`img_x_len`、`img_y_len`、`img_x_size`、
   * `img_y_size`、`interval`、`img_urls`。移植自
   * `server/src/media/video-model-capture.service.ts` 的 `readSprite`。
   */
  function readSprite(model) {
    if (!model || typeof model !== 'object') {
      return null;
    }
    const thumbs = model.big_thumbs;
    if (!Array.isArray(thumbs) || thumbs.length === 0) {
      return null;
    }
    const first = thumbs[0];
    if (!first || typeof first !== 'object') {
      return null;
    }
    const imgNum = first.img_num;
    const gridX = first.img_x_len;
    const gridY = first.img_y_len;
    const cellWidth = first.img_x_size;
    const cellHeight = first.img_y_size;
    const interval = first.interval;
    const urlsRaw = first.img_urls;
    if (typeof imgNum !== 'number' || typeof gridX !== 'number' || typeof gridY !== 'number') {
      return null;
    }
    if (typeof cellWidth !== 'number' || typeof cellHeight !== 'number' || typeof interval !== 'number') {
      return null;
    }
    if (!Array.isArray(urlsRaw)) {
      return null;
    }
    const urls = urlsRaw.filter((u) => typeof u === 'string' && u.length > 0);
    if (urls.length === 0) {
      return null;
    }
    return { imgNum, gridX, gridY, cellWidth, cellHeight, interval, urls };
  }

  /** 从 `video_model` 的 JSON 字符串里取雪碧图元数据。 */
  function parseSprite(raw) {
    let model;
    try {
      model = JSON.parse(raw);
    } catch {
      return null;
    }
    return readSprite(model);
  }

  /**
   * 取某集的雪碧图元数据。
   *
   * 正常路径是缓存命中：页面播放前一定先调过 `playback`，`liftVideoModel`
   * 已经把 `big_thumbs` 存下了。缓存未命中时补一次 `resolvePlayback`——
   * 进度条拖动的 sprite 请求可能先于播放信息到达（前端两个查询独立发起）。
   */
  async function resolveSprite(episodeId) {
    const cached = spriteCache.get(episodeId);
    if (cached !== undefined) {
      return cached;
    }
    try {
      await sdkCall('resolvePlayback', episodeId);
    } catch (e) {
      LOG('sprite 补解析失败: ' + (e && e.message ? e.message : String(e)));
    }
    const again = spriteCache.get(episodeId);
    if (again !== undefined) {
      return again;
    }
    throw new ApiError(404, 'episode ' + episodeId + ' has no sprite sheet', 'not_found');
  }

  /** 把雪碧图记到 video id 与 episode id 两个键下。 */
  function rememberSprite(sprite, videoId, episodeId) {
    if (sprite === null) {
      return;
    }
    if (typeof videoId === 'string' && videoId.length > 0) {
      spriteCache.set(videoId, sprite);
    }
    if (typeof episodeId === 'string' && episodeId.length > 0) {
      spriteCache.set(episodeId, sprite);
    }
    // 防止长期积累：最多留 32 条，超出时删最早的。
    while (spriteCache.size > 32) {
      const oldest = spriteCache.keys().next();
      if (oldest.done) {
        break;
      }
      spriteCache.delete(oldest.value);
    }
  }

  const routes = [
    {
      match: /^\/api\/feed$/,
      handle: async (url) => {
        const cursor = url.searchParams.get('cursor');
        const page = await sdkCall('discover', cursor === null ? {} : { cursor });
        return { status: 200, body: toSeriesPage(page) };
      },
    },
    {
      match: /^\/api\/search$/,
      handle: async (url) => {
        const keyword = normalizeSearchText(url.searchParams.get('keyword'));
        const cursor = url.searchParams.get('cursor');
        if (keyword === '') {
          return { status: 200, body: { items: [], cursor: null } };
        }
        const page = await sdkCall('search', keyword, cursor === null ? {} : { cursor });
        const result = toSeriesPage(page);
        // 上游搜索不返回封面，用一次批量取详情补齐。失败就降级为无封面。
        const missing = result.items.filter((i) => i.coverUrl === undefined).map((i) => i.id);
        if (missing.length > 0) {
          try {
            const details = await sdkCall('getSeriesBatch', missing);
            // SDK 返回的是 `[{ series: {...}, ... }]` 而不是扁平的剧集对象。
            // 直接读 `d.id` / `d.cover_url` 会全部拿到 undefined，搜索页就
            // 永远显示「无封面」——这正是之前的缺陷。
            const byId = new Map(
              (details || [])
                .map((d) => (d && d.series ? d.series : d))
                .filter((s) => s && s.id !== undefined)
                .map((s) => [s.id, s]),
            );
            result.items = result.items.map((item) => {
              const detail = byId.get(item.id);
              if (detail === undefined || item.coverUrl !== undefined) {
                return item;
              }
              return { ...item, ...coverOf(detail.cover_url) };
            });
          } catch (e) {
            LOG('搜索补封面失败，降级为无封面: ' + (e && e.message ? e.message : String(e)));
          }
        }
        return { status: 200, body: result };
      },
    },
    {
      match: /^\/api\/suggest$/,
      handle: async (url) => {
        const prefix = normalizeSearchText(url.searchParams.get('prefix'));
        if (prefix === '') {
          return { status: 200, body: { items: [] } };
        }
        try {
          const list = await sdkCall('suggest', prefix);
          return {
            status: 200,
            body: {
              items: (list || [])
                .map((s) => normalizeSearchText(s && s.text))
                .filter((t) => t !== '')
                .map((text) => ({ text })),
            },
          };
        } catch (e) {
          // 联想失败不阻塞搜索，返回空列表（与 server 一致）。
          LOG('suggest 降级为空: ' + (e && e.message ? e.message : String(e)));
          return { status: 200, body: { items: [] } };
        }
      },
    },
    {
      match: /^\/api\/series\/([^/]+)\/episodes$/,
      handle: async (url, m) => {
        const seriesId = decodeURIComponent(m[1]);
        const cursor = url.searchParams.get('cursor');
        const page = await sdkCall('listEpisodes', seriesId, cursor === null ? {} : { cursor });
        return {
          status: 200,
          body: {
            items: ((page && page.items) || []).map(toEpisode).filter((e) => e !== null),
            cursor:
              page && page.has_more && page.cursor !== undefined && page.cursor !== ''
                ? page.cursor
                : null,
          },
        };
      },
    },
    {
      match: /^\/api\/series\/([^/]+)$/,
      handle: async (url, m) => {
        const seriesId = decodeURIComponent(m[1]);
        // 与 server 一致：详情 + 全部集数并行取。
        const [detail, episodes] = await Promise.all([
          sdkCall('getSeries', seriesId),
          collectAllEpisodes(seriesId),
        ]);
        if (detail === undefined || detail === null) {
          throw new ApiError(404, '剧集不存在', 'not_found');
        }
        return { status: 200, body: toSeriesDetail(detail, episodes) };
      },
    },
    {
      match: /^\/api\/media\/([^/]+)$/,
      handle: async (url, m) => {
        // 下载端点（前端 `download-media.ts` 用它）。与 server 一致：
        // 先把解密后的完整字节准备好，再一次性返回；不实现 Range——
        // 端上没有落盘缓存，Range 只会让同一集被重复下载与解密。
        const episodeId = decodeURIComponent(m[1]);
        const definition = url.searchParams.get('definition');
        const resolved = await resolveDecrypted(episodeId, definition);
        return {
          status: 200,
          bytes: resolved.bytes,
          contentType: 'video/mp4',
          headers: { 'content-length': String(resolved.bytes.length) },
        };
      },
    },
    {
      match: /^\/api\/episodes\/([^/]+)\/playback$/,
      handle: async (url, m) => {
        const episodeId = decodeURIComponent(m[1]);
        const definition = url.searchParams.get('definition');
        return { status: 200, body: await resolvePlayback(episodeId, definition) };
      },
    },
    {
      match: /^\/api\/ranking\/catalog$/,
      handle: async () => {
        // 上游没有「只取目录」接口：`shortRank` 必然顺带返回一页榜单，
        // 这里只取 `contents`，丢弃 `items`（同 server）。
        const ranking = await sdkCall('shortRank');
        return {
          status: 200,
          body: {
            sections: ((ranking && ranking.contents) || []).map((section) => ({
              id: section.id,
              name: section.name,
              boards: ((section.boards) || []).map((board) => ({ id: board.id, name: board.name })),
            })),
          },
        };
      },
    },
    {
      match: /^\/api\/ranking$/,
      handle: async (url) => {
        const options = {};
        for (const key of ['content', 'board', 'cursor']) {
          const value = url.searchParams.get(key);
          if (value !== null) {
            options[key] = value;
          }
        }
        const ranking = await sdkCall('shortRank', options);
        const boardName = ((ranking && ranking.contents) || [])
          .find((section) => section.id === ranking.content)
          ?.boards.find((board) => board.id === ranking.board)?.name;
        return {
          status: 200,
          body: {
            entries: toRankingEntries((ranking && ranking.items) || []).map(toRankingEntry),
            cursor:
              ranking && ranking.has_more && typeof ranking.cursor === 'string' && ranking.cursor !== ''
                ? ranking.cursor
                : null,
            board: ranking && ranking.board,
            ...(boardName === undefined ? {} : { boardName }),
          },
        };
      },
    },
    {
      match: /^\/api\/random$/,
      handle: async () => {
        // 从热榜取候选再随机一项。榜单里混着演员行和推广重复行，必须过滤，
        // 否则会跳到 `/series/undefined`（同 server 的 `toRandomCandidates`）。
        const ranking = await sdkCall('shortRank');
        const candidates = toRandomCandidates((ranking && ranking.items) || []);
        const picked = candidates.length === 0
          ? undefined
          : candidates[Math.min(Math.floor(Math.random() * candidates.length), candidates.length - 1)];
        if (picked === undefined) {
          throw new ApiError(404, '排行榜暂时没有可用的剧集', 'no_random');
        }
        return {
          status: 200,
          body: toSeriesSummary({
            id: picked.seriesId,
            title: picked.title,
            ...(picked.coverUrl === undefined ? {} : { cover_url: picked.coverUrl }),
            ...(picked.episodeCount === undefined ? {} : { episode_count: picked.episodeCount }),
          }),
        };
      },
    },
    {
      match: /^\/api\/sprite\/([^/]+)$/,
      handle: async (url, m) => {
        const episodeId = decodeURIComponent(m[1]);
        const sprite = await resolveSprite(episodeId);
        return {
          status: 200,
          body: {
            gridX: sprite.gridX,
            gridY: sprite.gridY,
            cellWidth: sprite.cellWidth,
            cellHeight: sprite.cellHeight,
            frameCount: sprite.imgNum,
            interval: sprite.interval,
            sheetCount: sprite.urls.length,
            // **必须指向原生转码端点，不能指向 `/api/sprite/:id/:index`。**
            //
            // `sprite-preview.tsx` 把 URL 用在 `background-image` 上，
            // 而 `background-image` 不经过 `window.fetch`——它走
            // `WebViewAssetLoader`，命中不到适配层的路由表，只能拿到
            // `FileNotFoundException: api/sprite/<id>/<n>`。
            //
            // `/api/sprite-sheet` 在 `shouldInterceptRequest` 里被原生
            // `SpriteHandler` 接管（与 `/api/cover` 同一条路），
            // 所以 `<div background-image>` 能拿到 JPEG。
            sheetUrls: sprite.urls.map(
              (u) => '/api/sprite-sheet?url=' + encodeURIComponent(u),
            ),
          },
        };
      },
    },
    {
      match: /^\/api\/sprite\/([^/]+)\/(\d+)$/,
      handle: async (url, m) => {
        const episodeId = decodeURIComponent(m[1]);
        const index = Number(m[2]);
        const sprite = await resolveSprite(episodeId);
        if (index >= sprite.urls.length) {
          return { status: 404, body: { code: 'not_found', message: 'sheet ' + index + ' out of range' } };
        }
        // 雪碧图是 HEIC 大图（实测 240x136 格 × 10x10）。前端用
        // `background-image` + `background-position` 裁剪单帧，而背景图
        // **不解码 HEIC**，所以必须转 JPEG。
        //
        // 转码交给原生 `/api/sprite-sheet`（同源，走 `shouldInterceptRequest`）。
        // 用 `realFetch`：这条路径不经过适配层的路由表，否则会死循环。
        const response = await realFetch(
          '/api/sprite-sheet?url=' + encodeURIComponent(sprite.urls[index]),
        );
        if (!response.ok) {
          throw new ApiError(502, '雪碧图下载失败 HTTP ' + response.status, 'sprite_failed');
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: 200, bytes, contentType: 'image/jpeg' };
      },
    },
    {
      match: /^\/api\/health$/,
      handle: async () => ({ status: 200, body: { status: 'ok', mode: 'self-contained' } }),
    },
    {
      match: /^\/api\/diagnostics$/,
      handle: async () => ({
        status: 200,
        body: { adapter: 'webview', deviceProfile: localStorage.getItem('ohg') ? 'present' : 'absent' },
      }),
    },
  ];

  /** 取一部剧的全部集数（server 的 `allEpisodes`）。 */
  async function collectAllEpisodes(seriesId) {
    const all = [];
    let cursor;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await sdkCall('listEpisodes', seriesId, cursor === undefined ? {} : { cursor });
      const items = (page && page.items) || [];
      all.push(...items);
      if (!page || !page.has_more || page.cursor === undefined || page.cursor === '') {
        break;
      }
      cursor = page.cursor;
    }
    return all;
  }

  // ---------------------------------------------------------------- 播放

  /**
   * 解析播放信息，返回页面期望的 `Playback` 契约。
   *
   * ## 与 server 的关键差异
   *
   * server 的 `streamUrl` 指向自己的 `/api/media/:id` 代理，那个代理做下载 + 解密 +
   * 落盘 + Range。端上没有这个代理，也不能直接把 CDN 地址交给 `<video>`：
   * 上游视频是 **CENC 加密**的（`protected:true` + `cenc-aes-ctr`），浏览器要播
   * 必须走 EME + license server，而上游不提供。
   *
   * 所以这里当场完成「下载 → WebCrypto 解密 → blob URL」，把 `streamUrl` 直接
   * 换成一个 `<video>` 能播的 blob 地址。代价是请求会阻塞到解密完成，
   * 但这是端上唯一可行路径（`<video src>` 不经过 `window.fetch`，拦不住）。
   */
  /**
   * 解析播放信息（**只解析元数据**，不下载视频）。
   *
   * 与 server 的 `GET /api/episodes/:id/playback` 对齐：那个端点只返回
   * `streamUrl` / 档位 / 时长，字节在 `GET /api/media/:id` 里懒加载。
   *
   * 壳内早期版本在这个端点里直接下载 + 解密整份视频，目的是把字节做成
   * blob URL。这个做法在正常长度上能用，但两个后果很严重：
   *
   * 1. 下载面板只需要知道「有哪几档」。为拿档位而下载 248 MB 的视频，
   *    超过体积上限就整个端点 502，面板报「清晰度获取失败」——而移动端 web
   *    同一集能正常列出 5 档。
   * 2. 任何只要元数据的调用方（预取、下载面板、诊断）都会白白付一次全量下载。
   *
   * 所以拆成两步：`resolvePlayback` 只查元数据，`resolveDecrypted` 才取字节。
   * 播放时页面拿到 `streamUrl` 后由 `/api/media/:id` 懒加载，行为与 web 一致。
   */
  async function resolvePlayback(episodeId, preferredDefinition) {
    const meta = await resolveMeta(episodeId, preferredDefinition);
    return {
      episodeId,
      // 与 server 同形：自有地址，不暴露上游签名 URL。
      streamUrl: '/api/media/' + encodeURIComponent(episodeId) + '?definition=' + encodeURIComponent(meta.definition),
      duration: meta.duration,
      definition: meta.definition,
      availableDefinitions: meta.availableDefinitions,
      ...(meta.codec === undefined ? {} : { codec: meta.codec }),
      ...(meta.width === undefined ? {} : { width: meta.width }),
      ...(meta.height === undefined ? {} : { height: meta.height }),
    };
  }

  /**
   * 解析播放元数据：选档 + 时长 + 档位列表。**不下载视频**。
   */
  async function resolveMeta(episodeId, preferredDefinition) {
    const result = await sdkCall('resolvePlayback', episodeId);
    const playback = (result && result.playback) || {};
    const streams = (playback.streams || []).filter((s) => s.url !== undefined && s.url !== '');
    if (streams.length === 0) {
      throw new ApiError(500, '该集没有可播放的地址', 'no_stream');
    }

    // 与 server 一致：显式指定档位时必须精确命中，否则「选了 1080p 实际播 720p」。
    let chosen;
    if (preferredDefinition !== null && preferredDefinition !== undefined) {
      chosen = streams.find((s) => s.definition === preferredDefinition);
      if (chosen === undefined) {
        throw new ApiError(404, 'definition ' + preferredDefinition + ' 不可用', 'definition_unavailable');
      }
    } else {
      chosen = pickStream(streams);
    }

    const duration = playback.duration_seconds;
    const availableDefinitions = [...streams]
      .sort((a, b) => resolutionOf(a) - resolutionOf(b))
      .map((s) => (s.definition === undefined ? 'unknown' : s.definition))
      .filter((d, i, all) => all.indexOf(d) === i);

    return {
      chosen,
      contentKey: result && result.contentKey,
      duration: duration !== undefined && duration > 0 ? duration : 1,
      definition: chosen.definition === undefined ? 'unknown' : chosen.definition,
      availableDefinitions,
      ...(chosen.codec === undefined ? {} : { codec: chosen.codec }),
      ...(chosen.width === undefined ? {} : { width: chosen.width }),
      ...(chosen.height === undefined ? {} : { height: chosen.height }),
    };
  }

  /**
   * 解析播放信息并完成下载 + 解密，返回解密后的字节。
   *
   * 只有 `/api/media/:id`（下载 / 播放取字节）走这条路。
   */
  async function resolveDecrypted(episodeId, preferredDefinition) {
    const meta = await resolveMeta(episodeId, preferredDefinition);
    const url = decodeStreamUrl(meta.chosen.url);
    const bytes = await decryptStream(url, meta.contentKey, episodeId, meta.definition);
    return {
      bytes,
      episodeId,
      duration: meta.duration,
      definition: meta.definition,
      availableDefinitions: meta.availableDefinitions,
      ...(meta.codec === undefined ? {} : { codec: meta.codec }),
      ...(meta.width === undefined ? {} : { width: meta.width }),
      ...(meta.height === undefined ? {} : { height: meta.height }),
    };
  }

  /**
   * 下载 + 解密字节。按 `episodeId+definition` 缓存最近几份，
   * 避免播放和下载对同一集重复解密。
   *
   * ## 为什么条目数上限不够
   *
   * 实测最长的一集 1080p 有 80 MB（另一集 360p 甚至 248 MB）。
   * 只限 3 条时，最坏情况是 3 × 80 = 240 MB 全都压在一个 WebView 进程的
   * JS 堆里，比整份 base64 桥接 OOM 那次（39 MB）还严重。
   * 所以同时限**总字节**：超过 [MAX_BYTE_CACHE_BYTES] 就从最旧的开始删。
   */
  const byteCache = new Map();
  const MAX_BYTE_CACHE = 3;
  const MAX_BYTE_CACHE_BYTES = 96 * 1024 * 1024;
  let byteCacheBytes = 0;

  /** 删掉一条字节缓存，同时维护总字节数。 */
  function dropByteCache(key) {
    const value = byteCache.get(key);
    if (value !== undefined) {
      byteCacheBytes -= value.length;
      byteCache.delete(key);
    }
  }

  /** 把一条字节缓存加进去，必要时按条目数与总字节数淘汰。 */
  function putByteCache(key, bytes) {
    dropByteCache(key);
    byteCache.set(key, bytes);
    byteCacheBytes += bytes.length;
    // 单份就超过总预算时（例如 248 MB 的那一集），保留它但不做淘汰——
    // 否则会出现「刚放进去就被自己删掉」。调用方本来就要用这份字节。
    if (bytes.length > MAX_BYTE_CACHE_BYTES) {
      return;
    }
    while (
      (byteCache.size > MAX_BYTE_CACHE || byteCacheBytes > MAX_BYTE_CACHE_BYTES) &&
      byteCache.size > 1
    ) {
      dropByteCache(byteCache.keys().next().value);
    }
  }

  async function decryptStream(url, contentKey, episodeId, definition) {
    const cacheKey = episodeId + '|' + (definition || 'default');
    const cached = byteCache.get(cacheKey);
    if (cached !== undefined) {
      LOG('字节缓存命中 ' + cacheKey);
      return cached;
    }
    const started = Date.now();
    const raw = await downloadBytes(url);
    LOG('下载完成 ' + episodeId + ' ' + (definition || 'default') + ' ' + raw.length + 'B ' + (Date.now() - started) + 'ms');

    const keyHex = contentKey && typeof contentKey.key === 'string' ? contentKey.key : null;
    let bytes = raw;
    if (keyHex !== null) {
      const t = Date.now();
      bytes = await globalThis.HgCenc.decryptCenc(raw, keyHex);
      LOG('解密完成 ' + episodeId + ' ' + (Date.now() - t) + 'ms');
    } else {
      LOG('没有 contentKey，按明文处理: ' + episodeId);
    }

    putByteCache(cacheKey, bytes);
    return bytes;
  }

  /**
   * 解密后的字节 → blob URL（给 `<video src>` 用）。
   *
   * blob 会一直占着 JS 堆，直到 `revokeObjectURL`。按条目数限 3 条同样
   * 不够（3 × 80 MB = 240 MB），所以再限总字节。
   */
  const blobCache = new Map();
  const MAX_BLOB_CACHE_BYTES = 96 * 1024 * 1024;
  let blobCacheBytes = 0;

  /** 删掉一条 blob 缓存并释放内存。 */
  function dropBlobCache(key) {
    const entry = blobCache.get(key);
    if (entry !== undefined) {
      blobCacheBytes -= entry.bytes;
      blobCache.delete(key);
      URL.revokeObjectURL(entry.url);
    }
  }

  async function toBlobUrl(resolved) {
    const cacheKey = resolved.episodeId + '|' + resolved.definition;
    const cached = blobCache.get(cacheKey);
    if (cached !== undefined) {
      return cached.url;
    }
    const blob = new Blob([resolved.bytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    blobCache.set(cacheKey, { url: blobUrl, bytes: resolved.bytes.length });
    blobCacheBytes += resolved.bytes.length;
    // 单份就超预算时保留它（调用方马上要用），不自己删自己。
    if (resolved.bytes.length <= MAX_BLOB_CACHE_BYTES) {
      while (blobCacheBytes > MAX_BLOB_CACHE_BYTES && blobCache.size > 1) {
        dropBlobCache(blobCache.keys().next().value);
      }
    }
    return blobUrl;
  }

  /**
   * 下载整份视频。
   *
   * **必须走 `/api/video` 原生代理**：上游 CDN 对 WebView 内的 `fetch` 回 403
   * （UA 是 Android WebView，响应体为空）；同一地址在 Kotlin 的 OkHttp 里能拿到 200。
   * 差异在 TLS 指纹与请求头组合上，JS 侧无法伪造。
   *
   * 也不能走 `hgBridge`：视频是 4–14 MB，base64 编码后会让 WebView 堆内存 OOM
   * （实测：`Failed to allocate a 40137608 byte allocation`）。同源 URL 直接
   * `fetch` 就只是普通字节流，不进 JS 字符串。
   */
  async function downloadBytes(url) {
    const response = await realFetch('/api/video?url=' + encodeURIComponent(url));
    if (!response.ok) {
      throw new ApiError(502, '视频下载失败 HTTP ' + response.status, 'download_failed');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new ApiError(502, '视频下载为空', 'download_failed');
    }
    return new Uint8Array(buffer);
  }

  /** 短边像素数，与 server 的 `resolutionOf` 一致（竖屏 540x960 要算 540）。 */
  function resolutionOf(stream) {
    const w = stream.width !== undefined && stream.width > 0 ? stream.width : undefined;
    const h = stream.height !== undefined && stream.height > 0 ? stream.height : undefined;
    if (w !== undefined && h !== undefined) {
      return Math.min(w, h);
    }
    if (w !== undefined) {
      return w;
    }
    if (h !== undefined) {
      return h;
    }
    const m = /^(\d{3,4})p$/.exec(stream.definition || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  /** 默认取最高档（端上不受服务端带宽限制，且用户是在本地看）。 */
  function pickStream(streams) {
    let best;
    let bestScore = -1;
    for (const s of streams) {
      const score = resolutionOf(s);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /** base64 明文 → 明文；已经是 URL 就原样返回。 */
  function decodeStreamUrl(value) {
    if (typeof value !== 'string' || value === '') {
      return value;
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    try {
      const decoded = atob(value);
      return decoded.startsWith('http://') || decoded.startsWith('https://') ? decoded : value;
    } catch {
      return value;
    }
  }

  // ---------------------------------------------------------------- fetch 拦截

  const realFetch = window.fetch.bind(window);

  /**
   * 拦截 `/api/*`。
   *
   * 只拦同源的 `/api/` 路径；其它请求（assets、wasm、CDN）原样走真实 fetch。
   * 注意 `/api/media/:id` 不在路由表里：端上没有 server 侧的下载/解密/落盘，
   * 页面拿到的 `streamUrl` 已经是 CDN 地址，不会请求它。
   */
  window.fetch = async function patchedFetch(input, init) {
    let urlString;
    try {
      const raw = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      urlString = new URL(raw, location.href).href;
    } catch {
      return realFetch(input, init);
    }

    const parsed = new URL(urlString);
    if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/api/')) {
      return realFetch(input, init);
    }

    for (const route of routes) {
      const m = route.match.exec(parsed.pathname);
      if (!m) {
        continue;
      }
      // 预取让出带宽：当前集还在等首帧时，预取先等。见 `waitForFirstFrame`。
      if (isPrefetchRequest(init)) {
        await waitForFirstFrame();
      }
      try {
        const out = await route.handle(parsed, m);
        // 下载端点返回原始字节；其余端点返回 JSON。
        if (out.bytes !== undefined) {
          return binaryResponse(out.bytes, out.status, out.contentType, out.headers);
        }
        return jsonResponse(out.body, out.status);
      } catch (e) {
        const httpError = e instanceof ApiError ? e : toHttpError(e);
        LOG(parsed.pathname + ' → ' + httpError.status + ' ' + httpError.message);
        return jsonResponse({ code: httpError.code, message: httpError.message }, httpError.status);
      }
    }

    LOG('未适配的端点: ' + parsed.pathname);
    return jsonResponse({ code: 'not_adapter', message: '端上未适配 ' + parsed.pathname }, 404);
  };

  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  function binaryResponse(bytes, status, contentType, extraHeaders) {
    return new Response(bytes, {
      status: status,
      headers: Object.assign({ 'content-type': contentType }, extraHeaders || {}),
    });
  }

  // ---------------------------------------------------------------- 下载落盘

  /**
   * 接管 `<a download>` 的点击，把字节分块交给原生写进系统下载目录。
   *
   * ## 为什么需要接管
   *
   * 页面的 `saveBlob()` 会造一个 `<a download href="blob:...">` 并 `click()`。
   * 移动端 Chrome 会接管它并把文件存进下载目录；**Android WebView 不会**：
   * `DownloadListener` 只对真实网络下载触发，`blob:` 不会。实测：click 确实
   * 执行了（页面里能拦到），但 `/sdcard/Download/` 仍然是空的。
   *
   * ## 为什么分块
   *
   * 一次把 8–39 MB 的 base64 字符串过 `hgBridge` 会撞爆 Java 堆
   * （实测 `Failed to allocate a 39101711 byte allocation`）。按 512 KB 原始字节
   * 分块，峰值内存只跟块大小有关。
   *
   * ## 为什么不直接传 `/api/video` 的缓存文件路径
   *
   * 那份文件是**加密**的（CENC）。用户要的是能直接播的 MP4，所以必须传
   * 解密后的字节，而解密只在 JS 侧做过（`hg-cenc.js`）。
   */
  const DOWNLOAD_CHUNK = 512 * 1024;

  function installDownloadInterceptor() {
    if (!window.hgBridge) {
      return;
    }
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick() {
      const href = this.href || '';
      const name = this.download || '';
      // 只接管「带 download 属性的 blob 链接」；其他链接保持原生行为。
      if (name === '' || !href.startsWith('blob:')) {
        return originalClick.apply(this, arguments);
      }
      // 不阻塞调用方：`saveBlob()` 之后会 `revokeObjectURL`，
      // 所以要在同一个任务里先把 Blob 抓在手上。
      const blobUrl = href;
      saveBlobToDownloads(blobUrl, name).catch((e) => {
        LOG('下载落盘失败: ' + (e && e.message ? e.message : String(e)));
      });
      return undefined;
    };
    LOG('已接管 <a download> 点击');
  }

  async function saveBlobToDownloads(blobUrl, filename) {
    const response = await realFetch(blobUrl);
    if (!response.ok) {
      throw new Error('读取 blob 失败 HTTP ' + response.status);
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    LOG('开始落盘 ' + filename + ' ' + bytes.length + 'B');

    const token = await hostCommand({ op: 'downloadBegin' }).then((m) => m.token);
    try {
      let written = 0;
      for (let offset = 0; offset < bytes.length; offset += DOWNLOAD_CHUNK) {
        const slice = bytes.subarray(offset, Math.min(offset + DOWNLOAD_CHUNK, bytes.length));
        let bin = '';
        // `apply` 的参数个数有上限，分小段拼。
        for (let i = 0; i < slice.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
        }
        const reply = await hostCommand({ op: 'downloadChunk', token: token, chunk: btoa(bin) });
        written = reply.written;
        if (written < 0) {
          throw new Error('写入失败');
        }
      }
      const done = await hostCommand({ op: 'downloadFinish', token: token, displayName: filename });
      LOG('落盘完成 ' + filename + ' ' + done.bytes + 'B -> ' + done.uri);
      return done;
    } catch (e) {
      await hostCommand({ op: 'downloadCancel', token: token }).catch(() => undefined);
      throw e;
    }
  }

  /** 发一条非 HTTP 的命令给原生，等它的回包。 */
  function hostCommand(payload) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.hgBridge.postMessage(JSON.stringify(Object.assign({ id: id }, payload)));
    });
  }

  /**
   * 接管 `<video src="/api/media/...">`。
   *
   * ## 为什么必须拦在 JS 侧
   *
   * 页面把 `playback.streamUrl`（`/api/media/:id?definition=...`）直接赋给
   * `<video>`。这个请求**不经过 `window.fetch`**，也不经过任何适配层路由：
   * WebView 自己发出去，`shouldInterceptRequest` 里没有 `/api/media` 分支，
   * 最终落到 asset loader，得到 `FileNotFoundException`，`readyState` 永远 0。
   *
   * 两条可选路径：
   * 1. 原生 `shouldInterceptRequest` 拦 `/api/media`，把加密字节返回——不行，
   *    浏览器拿到的是 CENC 加密流，解不了。解密只在 JS 侧（`hg-cenc.js`）。
   * 2. JS 侧拦 `src` 写入，先解密再换成 blob URL——可行，且能复用已有的
   *    `resolveDecrypted` / `toBlobUrl`。
   *
   * 属性与 attribute 都要拦：React 写 `src` 走 property，直接写 HTML 走
   * attribute，实测两条路都存在。
   */
  function installMediaSrcInterceptor() {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (descriptor === undefined || descriptor.set === undefined) {
      LOG('无法接管 <video src>：原型上没有 setter');
      return;
    }
    const originalSet = descriptor.set;
    const originalSetAttribute = Element.prototype.setAttribute;

    /**
     * 每个元素最后一次请求的序号。
     *
     * 切清晰度时 React 不重建元素（`key` 是 episodeId，档位不在 key 里），
     * 所以同一个元素会连续收到两次 `src` 写入。两次解密是并发跑的，
     * 完成顺序不保证——先发起的慢请求后完成，就会把新档位的地址覆盖回去，
     * 用户看到「选了 360p 却仍在放 1080p」。用序号丢弃过期结果。
     */
    const requestSeq = new WeakMap();

    /**
     * 把 `/api/media/...` 换成解密后的 blob URL，其他值原样写入。
     *
     * 解密是异步的，而 setter 必须是同步的，所以这里**不写占位值**：
     * 写 `/api/media/...` 会让 WebView 真的去请求它（落到 asset loader，报 404），
     * 写 `about:blank` 之类又会触发一次无意义的加载。直接不写，等 blob 就绪再写一次。
     */
    const rewrite = function rewrite(element, value) {
      if (typeof value !== 'string' || !value.startsWith('/api/media/')) {
        return null;
      }
      const parsed = new URL(value, location.href);
      const episodeId = decodeURIComponent(parsed.pathname.replace('/api/media/', ''));
      const definition = parsed.searchParams.get('definition');
      const seq = (requestSeq.get(element) ?? 0) + 1;
      requestSeq.set(element, seq);
      resolveDecrypted(episodeId, definition)
        .then((resolved) => toBlobUrl(resolved))
        .then((blobUrl) => {
          // 两个条件都要满足才写：
          // - `isConnected`：切集时 React 会重建元素，旧元素不该再加载。
          // - 序号仍是最新：同一元素的连续切档只认最后一次。
          if (element.isConnected && requestSeq.get(element) === seq) {
            originalSet.call(element, blobUrl);
            LOG('媒体 src 已换成 blob: ' + episodeId + ' ' + (definition || 'default'));
          }
        })
        .catch((e) => {
          LOG('媒体加载失败 ' + episodeId + ': ' + (e && e.message ? e.message : String(e)));
          if (element.isConnected && requestSeq.get(element) === seq) {
            element.dispatchEvent(new Event('error'));
          }
        });
      return 'pending';
    };

    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function patchedSrc(value) {
        const outcome = rewrite(this, value);
        if (outcome === 'pending') {
          return;
        }
        return originalSet.call(this, value);
      },
    });

    Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
      if (name === 'src' && this instanceof HTMLMediaElement) {
        const outcome = rewrite(this, value);
        if (outcome === 'pending') {
          return;
        }
      }
      return originalSetAttribute.call(this, name, value);
    };
    LOG('已接管 <video src> 的 /api/media 地址');
  }

  /**
   * 修 `paused` 的语义：首帧未到时报告「还没开始播」。
   *
   * ## 要解决的问题
   *
   * 页面的停滞检测（`web/src/features/player/playback-error.ts` 的 `isStalled()`）
   * 只看 `!video.paused` 与 `currentTime` 是否 20 秒未变。
   *
   * 但 `HTMLMediaElement.play()` 一被调用，`paused` **立刻**变 false，
   * 哪怕一个字节都还没到（`readyState === 0`、`buffered.length === 0`）。
   * 实测壳内冷启动进 `/watch/<id>`：
   *
   * ```
   * t=1022ms  rs=0 paused=false ct=0 buf=0     ← play() 已调，字节未到
   * t=20124ms rs=0 paused=false ct=0 buf=0     ← 浮层弹出「播放停滞，正在自动重新加载」
   * ```
   *
   * 于是「等待首帧」被算成「播着播着卡住」。壳内这条路径比浏览器慢得多：
   * 要先经 OkHttp 把整集下载到本地、再用 WebCrypto 解密，首帧前本来就要等很久。
   *
   * ## 为什么改 `paused` 而不是改 web 源码
   *
   * 页面读 `video.paused` 只有两处：
   * - `player.tsx:543` 的停滞判定（就是这里要修的）
   * - `player.tsx:571` 的播放/暂停切换
   *
   * 后者语义上也是对的：首帧未到时的按钮应该显示「播放」而不是「暂停」，
   * 点下去会再 `play()` 一次（幂等）。所以两边都受益，不需要分支。
   *
   * `playing` 这个 React 状态走的是 `play`/`pause` 事件，不受影响。
   *
   * ## 边界
   *
   * - 只有**已经请求过播放**（调过 `play()`）且 `readyState < HAVE_CURRENT_DATA`
   *   时才改。用户主动 `pause()` 后必须如实返回 true，否则按钮会错。
   * - `readyState >= 2`（有当前帧数据）后一律返回原生值，不干预正常播放。
   */
  function installPausedSemantics() {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
    if (descriptor === undefined || descriptor.get === undefined) {
      LOG('无法修正 paused 语义：原型上没有 getter');
      return;
    }
    const originalGet = descriptor.get;
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPause = HTMLMediaElement.prototype.pause;

    /** 已经调过 `play()`、还没拿到首帧的元素。 */
    const awaitingFirstFrame = new WeakSet();

    HTMLMediaElement.prototype.play = function patchedPlay() {
      const result = originalPlay.apply(this, arguments);
      // `readyState < 2` 说明连当前帧都没有。标记上，让 `paused` 报告「还没开始播」。
      // `readyState >= 2` 时不需要标记：此时 `paused` 本来就是 false，语义正确。
      if (this.readyState < 2) {
        awaitingFirstFrame.add(this);
      }
      if (result !== undefined && typeof result.then === 'function') {
        result.then(
          () => undefined,
          () => {
            // `play()` 被拒绝（自动播放策略、地址不可用）：不再等首帧，
            // 否则 `paused` 会永远报 true，切换按钮永远显示「播放」。
            awaitingFirstFrame.delete(this);
          },
        );
      }
      return result;
    };

    HTMLMediaElement.prototype.pause = function patchedPause() {
      // 用户主动暂停：立刻退出「等首帧」状态，`paused` 必须如实返回 true。
      awaitingFirstFrame.delete(this);
      return originalPause.apply(this, arguments);
    };

    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function patchedPaused() {
        const native = originalGet.call(this);
        // 已拿到当前帧：原生值就是对的。
        if (this.readyState >= 2) {
          awaitingFirstFrame.delete(this);
          return native;
        }
        // 正在等首帧：报告「还没开始播」，停滞检测就不会把这段等待算成停滞。
        if (awaitingFirstFrame.has(this)) {
          return true;
        }
        return native;
      },
      set: descriptor.set,
    });
    LOG('已修正 paused 语义（首帧未到时报告未播放）');
  }

  /**
   * 预取请求的排队：当前集还在等首帧时，预取先让出带宽。
   *
   * ## 要解决的问题
   *
   * 播放页会预取下一集（`web/src/features/player/prefetch-next.ts`），发一个
   * `range: bytes=0-1` 的请求。适配层收到后仍然要完整下载 + 解密整集，所以
   * 它和当前正在播的那一集**争同一份带宽**。
   *
   * 实测：`lock released, locks=2 cache=1`——进播放页时同时有两个下载。
   * 网络差时这会把首帧等待推到几十秒，也就是「播放停滞」浮层的直接原因。
   *
   * ## 判据
   *
   * 页面的预取请求带 `range: bytes=0-1`，正常播放不会带（`<video src>` 那条
   * 路径根本不进 `fetch`）。所以用这个头区分两者，不用看 URL。
   *
   * ## 做法
   *
   * 预取先等「当前有 `<video>` 且它已经拿到首帧（`readyState >= 2`）」再开始。
   * 等待有上限（[PREFETCH_MAX_WAIT_MS]）：如果用户一直没在播（比如停在列表页），
   * 不能让预取永久挂起。超时后照常发请求。
   *
   * 这不是取消预取：预取仍然会跑，只是排在首帧之后。首帧是用户可见的，
   * 预取是纯优化，让优化给体验让路。
   */
  const PREFETCH_MAX_WAIT_MS = 30_000;

  /** 是否还有 `<video>` 在等首帧。 */
  function awaitingFirstFrame() {
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (video.readyState < 2) {
        return true;
      }
    }
    return false;
  }

  /** 等首帧就绪或超时，然后放行预取。 */
  async function waitForFirstFrame() {
    const deadline = Date.now() + PREFETCH_MAX_WAIT_MS;
    while (awaitingFirstFrame() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** 这个请求是不是页面的预取（带 `range: bytes=0-1`）。 */
  function isPrefetchRequest(init) {
    if (!init || !init.headers) {
      return false;
    }
    const headers = init.headers;
    let range;
    if (typeof headers.get === 'function') {
      range = headers.get('range');
    } else if (Array.isArray(headers)) {
      const hit = headers.find((pair) => String(pair[0]).toLowerCase() === 'range');
      range = hit ? hit[1] : undefined;
    } else {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === 'range');
      range = key === undefined ? undefined : headers[key];
    }
    return typeof range === 'string' && range.indexOf('bytes=0-1') === 0;
  }

  // ---------------------------------------------------------------- 启动

  installBridgeListener();
  installDownloadInterceptor();
  installMediaSrcInterceptor();
  installPausedSemantics();
  LOG('适配层已安装（' + routes.length + ' 个端点）');
  // 预热：提前启动 WASM，首屏请求就不用等它。
  startSdk().catch((e) => LOG('SDK 预热失败: ' + (e && e.message ? e.message : String(e))));

  // 调试入口：模拟器上取证用（CDP 控制台可以直接调）。
  globalThis.__hgAdapter = {
    sdkCall: sdkCall,
    routes: routes.map((r) => String(r.match)),
  };
})();
