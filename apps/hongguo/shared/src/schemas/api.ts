import { z } from 'zod';

/**
 * 对外接口的契约。前后端共享同一份 schema，前端由此推导类型，避免手写类型漂移。
 */

/** 一部剧的摘要，用于列表页。 */
export const SeriesSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** 封面地址；已转成本服务的 `/api/cover?u=...`，不会是上游 CDN 直链。 */
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

/** 分页游标参数。 */
export const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
});
export type CursorQuery = z.output<typeof CursorQuerySchema>;

/** 搜索参数。 */
export const SearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).max(64),
  cursor: z.string().optional(),
});
export type SearchQuery = z.output<typeof SearchQuerySchema>;

/** 播放参数。`definition` 可选，缺省时自动挑一档。 */
export const PlaybackQuerySchema = z.object({
  definition: z
    .string()
    .regex(/^\d{3,4}p$/)
    .optional(),
});
export type PlaybackQuery = z.output<typeof PlaybackQuerySchema>;

/** 雪碧图切片参数。`sheet` 可省略，controller 从路径读。 */
export const SpriteQuerySchema = z.object({
  sheet: z.coerce.number().int().min(0).optional(),
});
export type SpriteQuery = z.output<typeof SpriteQuerySchema>;

/** 封面代理参数。 */
export const CoverQuerySchema = z.object({
  u: z.string().min(1),
  w: z.coerce.number().int().min(16).max(2048).optional(),
});
export type CoverQuery = z.output<typeof CoverQuerySchema>;
