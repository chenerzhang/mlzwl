import type { SpriteMeta } from '@mlzwl/hongguo-shared';

export interface SpritePreviewProps {
  /** 当前播放位置（秒）。 */
  position: number;
  meta: SpriteMeta;
  /** 每张图的地址；按 `frameCount` 与网格容量决定用哪张。 */
  sheetUrls: string[];
}

/**
 * 拖动进度条时的缩略图预览。
 *
 * 关键点：**每张图固定 `gridX * gridY` 格，最后一张也补满。** 所以第 n 帧在
 * 图 `floor(n / 容量)` 的第 `n % 容量` 格，不要用 `gridY` 推算有效行数。
 *
 * 时间 → 帧号要 clamp 到 `frameCount - 1`：实测有 `img_num=110` 而
 * `duration/interval = 111` 的集，不 clamp 会在最后一秒越界。
 */
export function SpritePreview({ position, meta, sheetUrls }: SpritePreviewProps): React.JSX.Element | null {
  if (sheetUrls.length === 0 || meta.frameCount <= 0) {
    return null;
  }

  const cellsPerSheet = meta.gridX * meta.gridY;
  const rawFrame = Math.floor(position / meta.interval);
  const frame = Math.min(Math.max(rawFrame, 0), meta.frameCount - 1);

  const sheetIndex = Math.floor(frame / cellsPerSheet);
  const cell = frame % cellsPerSheet;
  const col = cell % meta.gridX;
  const row = Math.floor(cell / meta.gridX);
  const url = sheetUrls[sheetIndex] ?? sheetUrls[0];
  if (url === undefined) {
    return null;
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none overflow-hidden rounded-md border border-on-scrim/25 bg-scrim shadow-lg"
      style={{ width: meta.cellWidth, height: meta.cellHeight }}
    >
      <div
        style={{
          width: meta.cellWidth,
          height: meta.cellHeight,
          backgroundImage: `url(${url})`,
          // 背景按原图尺寸铺开，再按格子偏移。
          backgroundSize: `${meta.gridX * meta.cellWidth}px ${meta.gridY * meta.cellHeight}px`,
          backgroundPosition: `-${col * meta.cellWidth}px -${row * meta.cellHeight}px`,
          backgroundRepeat: 'no-repeat',
        }}
      />
    </div>
  );
}
