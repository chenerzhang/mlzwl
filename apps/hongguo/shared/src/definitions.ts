/**
 * 清晰度档位标签的判定规则。
 *
 * **本文件不得 import zod。** `web` 需要值导入这里的函数，而 `schemas/api.ts`
 * 依赖 zod；把规则留在 schema 文件里会让浏览器包连带打进 zod（实测 +89 kB）。
 *
 * 规则同时被三处使用，必须只有一份实现：
 * 1. `PlaybackQuerySchema` 校验 `/api/episodes/:id/playback?definition=`；
 * 2. `web` 的清晰度菜单，决定哪些档位可以渲染成可点选项；
 * 3. `web` 的下载档位选择，决定拼不拼 `?definition=`。
 *
 * 之前这三处各写一份：菜单允许任意非空字符串，于是出现 `unknown` 这种服务端
 * 明确拒绝的选项，点下去稳定 400；下载则另写一份 `\d{3,4}p`。规则一旦分叉，
 * 「能选的档」就不再等于「能请求的档」。
 */

/** 可请求的档位标签形态：`360p` … `1440p`。 */
const REQUESTABLE_DEFINITION = /^\d{3,4}p$/;

/**
 * 该标签能否作为播放或下载请求的 `definition` 参数。
 *
 * 不写死分辨率白名单（`360p`/`720p`/`1080p`…）：上游随时可能加档，写死会让新档位
 * 静默消失。但形态必须收紧到服务端能接受的范围，否则前端会把注定 400 的值发给服务端。
 *
 * `unknown` 是服务端在「上游没给档位标签」时填的占位值。它只能作为**当前状态**
 * 展示，不能作为请求参数。
 */
export function isRequestableDefinition(label: string): boolean {
  return REQUESTABLE_DEFINITION.test(label);
}

/**
 * 单条封面令牌的长度上限（字符数）。
 *
 * 令牌 = base64url(版本 1 字节 + IV 12 字节 + 认证标签 16 字节 + 上游 URL 密文)。
 * 密文长度等于上游 URL 的 UTF-8 字节数，base64url 再膨胀约 4/3，所以 3072 字节的
 * 上游 URL 会产生约 4108 字符的令牌。这里留足余量取 6144。
 *
 * **这是唯一的长度来源**，三个消费方必须共用它：
 * 1. `server` 的 Fastify `maxParamLength`（路径参数上限）；
 * 2. `server` 生成令牌时的自检；
 * 3. `web` 离线快照的 `MAX_COVER_URL_LENGTH`。
 *
 * 三处各写一个字面量已经出过事：`maxParamLength` 先是默认 100（合法令牌全部 414），
 * 后改成 2048，而前端允许 4096，于是超过 2048 的令牌仍然 414。
 */
export const MAX_COVER_TOKEN_LENGTH = 6144;

/** 封面代理路径前缀。令牌拼在它后面。 */
export const COVER_PATH_PREFIX = '/api/cover/';

/**
 * 判断一个 `coverUrl` 是不是本服务的封面代理地址。
 *
 * 只接受 `${COVER_PATH_PREFIX}<base64url 令牌>`，且令牌长度不超过上限。
 * 用途是**清理持久化数据**：早期版本把完整上游签名 URL 编码进
 * `/api/cover?u=...`，这些值可能还在 `localStorage`（离线目录、观看记录、收藏）里。
 * 服务端删掉旧路由只能让它们 404，签名串仍会被渲染进 DOM、出现在网络面板。
 *
 * 因此读取持久化数据时必须用本函数过滤：不符合新格式的 `coverUrl` 直接丢弃，
 * 让卡片退化成纯文字，而不是把一个带签名的地址继续用下去。
 */
export function isCoverProxyUrl(value: string): boolean {
  if (!value.startsWith(COVER_PATH_PREFIX)) {
    return false;
  }
  const token = value.slice(COVER_PATH_PREFIX.length);
  if (token.length === 0 || token.length > MAX_COVER_TOKEN_LENGTH) {
    return false;
  }
  // base64url 字符集。查询串（`?u=`）、斜杠、空格都会在这里被拒掉。
  return /^[A-Za-z0-9_-]+$/.test(token);
}
