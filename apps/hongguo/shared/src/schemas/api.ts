import { z } from 'zod';
import { isRequestableDefinition } from '../definitions.js';

/**
 * 对外接口的契约。前后端共享同一份 schema，前端由此推导类型，避免手写类型漂移。
 */

/** 一部剧的摘要，用于列表页。 */
export const SeriesSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** 封面地址；已转成本服务的 `/api/cover/<不透明令牌>`，不会是上游 CDN 直链。 */
  coverUrl: z.string().optional(),
  episodeCount: z.number().int().nonnegative().optional(),
  author: z.string().optional(),
  category: z.string().optional(),
});
export type SeriesSummary = z.output<typeof SeriesSummarySchema>;

export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    /** 下一页游标；`null` 表示没有更多。 */
    cursor: z.string().nullable(),
  });

export const SeriesPageSchema = PageSchema(SeriesSummarySchema);
export type SeriesPage = z.output<typeof SeriesPageSchema>;

/** 一集。 */
export const EpisodeSchema = z.object({
  id: z.string(),
  seriesId: z.string(),
  number: z.number().int().positive(),
  title: z.string().optional(),
  playable: z.boolean(),
  /** 分集剧照，已转成本服务的封面代理地址。 */
  coverUrl: z.string().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  diggCount: z.number().int().nonnegative().optional(),
});
export type Episode = z.output<typeof EpisodeSchema>;

export const EpisodePageSchema = PageSchema(EpisodeSchema);
export type EpisodePage = z.output<typeof EpisodePageSchema>;

/** 一部剧的详情。 */
export const SeriesDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  coverUrl: z.string().optional(),
  episodeCount: z.number().int().nonnegative().optional(),
  episodes: z.array(EpisodeSchema),
});
export type SeriesDetail = z.output<typeof SeriesDetailSchema>;

/** 雪碧图网格信息。 */
export const SpriteMetaSchema = z.object({
  /** 每张图的列数与行数。 */
  gridX: z.number().int().positive(),
  gridY: z.number().int().positive(),
  /** 单帧像素尺寸。 */
  cellWidth: z.number().int().positive(),
  cellHeight: z.number().int().positive(),
  /** 有效帧数（不是网格容量）。 */
  frameCount: z.number().int().positive(),
  /** 相邻帧的时间间隔，单位秒。 */
  interval: z.number().positive(),
});
export type SpriteMeta = z.output<typeof SpriteMetaSchema>;

/** 播放信息。**不包含**上游签名 URL 与内容密钥。 */
export const PlaybackSchema = z.object({
  episodeId: z.string(),
  /** 自有媒体地址，支持 Range。 */
  streamUrl: z.string(),
  /** 视频时长，单位秒。 */
  duration: z.number().positive(),
  /** 选定的清晰度标签，例如 "1080p"。 */
  definition: z.string(),
  /** 可用清晰度，从低到高。 */
  availableDefinitions: z.array(z.string()),
  /** 视频编码，例如 "hevc"。前端据此判断能否直接播放。 */
  codec: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** 雪碧图信息；没有时前端不显示缩略预览。 */
  sprite: SpriteMetaSchema.optional(),
  /** 雪碧图张数；每张 `gridX * gridY` 格。 */
  spriteSheetCount: z.number().int().nonnegative().optional(),
});
export type Playback = z.output<typeof PlaybackSchema>;

/**
 * 媒体错误的稳定错误码。
 *
 * 前端不能靠 HTTP 状态码区分原因：`502` 既可能是上游 5xx，也可能是上游返回了
 * HTML 错误页。这里给出稳定的 code，让前端能选对文案与动作（重试 / 换清晰度 / 换浏览器）。
 * 新增 code 必须同步 `web/src/features/player/playback-error.ts` 的文案表。
 */
export const MEDIA_ERROR_CODES = [
  'media_timeout',
  'media_not_video',
  'media_too_large',
  'media_upstream_4xx',
  'media_upstream_5xx',
  'decrypt_failed',
  'no_stream',
  'key_unavailable',
  'not_encrypted',
  /**
   * 请求了该集并不存在的档位。
   *
   * 与 `no_stream` 分开：`no_stream` 是「这集根本没有流」，而这里只是「这集
   * 没有你要的那一档」。前端据此提示「该档位不可用」而不是「这集播不了」。
   * 之所以必须报错：静默回退到别的档会让用户以为 1080p 下载成功，
   * 实际拿到 720p 的文件却带着 `-1080p.mp4` 的名字。
   */
  'definition_unavailable',
] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

/**
 * 服务端错误响应体。与 `MediaError` 抛出的形状一致。
 *
 * **仅作文档契约。web 侧禁止值导入此 schema，会把 zod 打进浏览器包（实测 +89 kB）；
 * 需要校验时手写。**
 */
export const ApiErrorBodySchema = z.object({ code: z.string(), message: z.string() });
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/**
 * 一条「我的收藏」记录。
 *
 * 收藏与追更是**两个独立的布尔标记**，不是一个按钮轮转出来的多态：
 * 收藏回答「我记住了这部剧」，追更回答「它更新时提醒我」。
 * 两者可以同时为真、可以只开一个；都为假时整条记录删除，不留在存档里。
 *
 * 历史背景：早期版本用 `state: 'planned' | 'watching' | 'watched'` 三态，
 * 单个按钮轮转「未收藏 → 想看 → 在看 → 看完 → 取消」。这有两个问题：
 * 1. 取消收藏要点 4 次，中间还会经过用户没表达过的状态；
 * 2. 三态只驱动按钮文案与分组 tab，不参与任何功能。
 * 因此改为两个独立布尔量。旧存档（含 `state` 字段）直接丢弃，不做迁移。
 *
 * **仅作文档契约。web 侧禁止值导入此 schema，会把 zod 打进浏览器包（实测 +89 kB）；
 * 需要校验时手写。**
 */
export const FollowRecordSchema = z
  .object({
    seriesId: z.string().min(1),
    seriesTitle: z.string().min(1),
    coverUrl: z.string().optional(),
    /** 是否已收藏。 */
    favorite: z.boolean(),
    /** 是否追更。只有追更中的剧才显示「更新 N 集」角标。 */
    following: z.boolean(),
    /** 上游最近一次报告的已知集数。 */
    knownEpisodes: z.number().int().nonnegative(),
    /** 用户已确认看到的集数。**只增不减**，除非用户显式重置。 */
    confirmedEpisodes: z.number().int().nonnegative(),
    /** 最后一次更新这些数字的时间。用于防时钟回拨误判。 */
    checkedAt: z.number().int().nonnegative(),
  })
  // 两条不变量：web 侧的手写校验（`follow-store.ts` 的 `sanitizeFollowRecord`）
  // 已经这么做，schema 必须与它一致，否则这份「文档契约」会验证通过一份
  // web 实际会丢弃的记录。
  .refine((record) => record.favorite || record.following, {
    message: '两个标记都为假的记录不应落盘',
  })
  .refine((record) => record.confirmedEpisodes <= record.knownEpisodes, {
    message: 'confirmedEpisodes 不得超过 knownEpisodes',
  });
export type FollowRecord = z.infer<typeof FollowRecordSchema>;

/** 分页游标参数。 */
export const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
});
export type CursorQuery = z.output<typeof CursorQuerySchema>;

/**
 * 搜索关键词的最大长度。
 *
 * 前后端共用这一个常量。之前 `web` 的搜索历史允许 80 字符、这里只允许 64，
 * 导致 65–80 字符的输入被前端写入历史、提交后稳定收到 400，
 * 而且从历史再次点击仍然失败。两套上限不能共存。
 */
export const MAX_SEARCH_KEYWORD_LENGTH = 80;

/** 搜索参数。 */
export const SearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).max(MAX_SEARCH_KEYWORD_LENGTH),
  cursor: z.string().optional(),
});
export type SearchQuery = z.output<typeof SearchQuerySchema>;

/** 播放参数。`definition` 可选，缺省时自动挑一档。 */
export const PlaybackQuerySchema = z.object({
  definition: z.string().refine(isRequestableDefinition, { message: 'unsupported definition' }).optional(),
});
export type PlaybackQuery = z.output<typeof PlaybackQuerySchema>;

/** 雪碧图切片参数。`sheet` 可省略，controller 从路径读。 */
export const SpriteQuerySchema = z.object({
  sheet: z.coerce.number().int().min(0).optional(),
});
export type SpriteQuery = z.output<typeof SpriteQuerySchema>;

/** 封面代理参数。 */
/** 榜单中的一部短剧；封面只允许返回本服务的代理地址。 */
export const RankingEntrySchema = z.object({
  position: z.number().int().positive(),
  seriesId: z.string(),
  title: z.string(),
  coverUrl: z.string().optional(),
  episodeCount: z.number().int().nonnegative().optional(),
  /** 上游已经生成可展示文案，解析数字会丢失「平台推荐」等语义。 */
  score: z.string().optional(),
  promoted: z.boolean().optional(),
});
export type RankingEntry = z.output<typeof RankingEntrySchema>;

export const RankingBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type RankingBoard = z.output<typeof RankingBoardSchema>;

export const RankingSectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  boards: z.array(RankingBoardSchema),
});
export type RankingSection = z.output<typeof RankingSectionSchema>;

export const RankingPageSchema = z.object({
  entries: z.array(RankingEntrySchema),
  cursor: z.string().nullable(),
  board: z.string(),
  boardName: z.string().optional(),
});
export type RankingPage = z.output<typeof RankingPageSchema>;

export const RankingCatalogSchema = z.object({
  sections: z.array(RankingSectionSchema),
});
export type RankingCatalog = z.output<typeof RankingCatalogSchema>;

/** 榜单 ID 限长，避免任意长字符串占满缓存键并被转发给上游。 */
export const RankingQuerySchema = z.object({
  content: z.string().max(64).optional(),
  board: z.string().max(64).optional(),
  cursor: z.string().optional(),
});
export type RankingQuery = z.output<typeof RankingQuerySchema>;
