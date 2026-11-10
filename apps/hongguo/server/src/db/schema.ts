import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 数据库表。
 *
 * 注意：**内容密钥不落库**。`playback` 表只存可以重新解析出来的元数据（上游
 * 分集 id、清晰度、过期时间）。密钥每次重新解析播放地址时在内存里重算。
 */
export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 匿名设备档案的完整 JSON（约 605 字节）。 */
  profile: text('profile').notNull(),
  /** 上游分配的 device_id，仅用于排障时识别是哪台设备，不对外暴露。 */
  deviceId: text('device_id'),
  /** active：可用；limited：上游已限制，需轮换。 */
  state: text('state', { enum: ['active', 'limited'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
});

export const deviceUsage = sqliteTable(
  'device_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceRef: integer('device_ref')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** UTC 日期，格式 YYYY-MM-DD。 */
    day: text('day').notNull(),
    playbackCount: integer('playback_count').notNull().default(0),
  },
  (table) => [index('device_usage_device_day').on(table.deviceRef, table.day)],
);

export const playback = sqliteTable(
  'playback',
  {
    /** 上游分集 id。 */
    episodeId: text('episode_id').primaryKey(),
    /** 上游 series id，便于按剧清理。 */
    seriesId: text('series_id').notNull(),
    /** 选定的清晰度，例如 "1080p"。 */
    definition: text('definition').notNull(),
    /** 播放地址的过期时间（epoch ms）。 */
    expiresAt: integer('expires_at').notNull(),
    /** 上游返回的时长（秒）。用于进度条与雪碧图帧数校验。 */
    duration: integer('duration').notNull(),
    /** 加密文件的字节数，用于 Range 校验。 */
    encryptedBytes: integer('encrypted_bytes').notNull(),
    /** CENC 方案标识，例如 "cenc-aes-ctr"。 */
    encryptionMethod: text('encryption_method').notNull(),
    /** 解密后写入磁盘的文件名（相对媒体目录）。 */
    mediaFile: text('media_file'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('playback_series').on(table.seriesId)],
);

export const spriteSheets = sqliteTable(
  'sprite_sheets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    episodeId: text('episode_id').notNull(),
    /** 上游的 video id，缓存键用它而不是 URL（URL 会带签名并过期）。 */
    videoId: text('video_id').notNull(),
    sheetIndex: integer('sheet_index').notNull(),
    /** 相对雪碧图目录的文件名。 */
    file: text('file').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    gridX: integer('grid_x').notNull(),
    gridY: integer('grid_y').notNull(),
    cellWidth: integer('cell_width').notNull(),
    cellHeight: integer('cell_height').notNull(),
    frameCount: integer('frame_count').notNull(),
    interval: integer('interval').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('sprite_episode').on(table.episodeId, table.sheetIndex)],
);

export const coverCache = sqliteTable('cover_cache', {
  /** 原始 URL 的 sha256，避免主键过长。 */
  urlHash: text('url_hash').primaryKey(),
  /** 相对封面目录的文件名。 */
  file: text('file').notNull(),
  contentType: text('content_type').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: integer('created_at').notNull(),
});
