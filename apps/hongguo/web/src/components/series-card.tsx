import type { SeriesSummary } from '@mlzwl/hongguo-shared';

export interface SeriesCardProps {
  series: SeriesSummary;
  onSelect?: (series: SeriesSummary) => void;
}

/**
 * 列表卡片。
 *
 * 设计取向：**封面是唯一主角，其余全部退到背景里**。
 *
 * 三条具体规则：
 * 1. **不画卡片底色**。之前卡片有 `bg-surface-raised` + `ring-1`，等于给每张
 *    封面套一个可见的框；一整屏 18 个框会形成「表格感」，是廉价感的主要来源。
 *    现在卡片背景透明，只有封面本体 + 下方两行文字，靠网格间距分隔。
 * 2. **不用 hover 放大**。`scale-[1.04]` 在 6 列网格里会互相挤到邻居，而且
 *    短剧列表的点击频率很高，每次划过都缩放会显得躁。改成 hover 时封面轻微
 *    提亮 + 标题变色，安静但明确。
 * 3. **角标只留集数，且贴边不留胶囊**。之前的 `bg-scrim/65` 胶囊在深色主题下
 *    是一块明显的灰斑；现在改成无底色的白字 + 底部极窄渐变，只在需要时提供
 *    最低限度的对比。
 *
 * 封面遮罩用 `scrim` 系 token 而不是主题色：遮罩必须始终是暗的，否则浅色
 * 主题下白字角标会消失。这是唯一允许不随主题变化的地方。
 */
export function SeriesCard({ series, onSelect }: SeriesCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(series)}
      className="group flex flex-col rounded-lg text-left outline-none"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-surface-overlay ring-1 ring-border-subtle transition-[filter,box-shadow] duration-200 group-hover:ring-border group-focus-visible:ring-2 group-focus-visible:ring-accent-soft">
        {series.coverUrl === undefined ? (
          <div className="flex h-full items-center justify-center text-xs text-text-tertiary">无封面</div>
        ) : (
          <img
            src={series.coverUrl}
            alt={series.title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-[filter] duration-200 group-hover:brightness-110 motion-reduce:transition-none"
          />
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug tracking-tight text-text-primary transition-colors group-hover:text-accent-soft">
        {series.title}
      </p>
      {/*
        集数从封面里挪到标题下方。
        之前是压在封面底部的白色角标 + 一层 64px 渐变遮罩。问题有两个：
        1. 封面亮度不可控。浅色主题下遇到浅色封面，白字对比度实测只有
           1.19:1，完全看不清（`scripts/ui-audit.mjs` 抓到的真实失败）。
        2. 那层渐变本身就是用户说的「廉价渐变」——为了一个数字，把封面
           下缘整片压暗。
        现在封面完全裸露，信息统一放在封面下方一行，既稳定又干净。
      */}
      <p className="mt-0.5 truncate text-[11px] tabular-nums text-text-tertiary">
        {series.episodeCount !== undefined && <>{series.episodeCount} 集</>}
        {series.episodeCount !== undefined && series.category !== undefined && <span aria-hidden> · </span>}
        {series.category}
      </p>
    </button>
  );
}

/** 骨架屏，避免加载时布局跳动。尺寸与真实卡片一致，填充时不会跳。 */
export function SeriesCardSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="flex flex-col">
      <div className="aspect-[3/4] w-full animate-pulse rounded-lg bg-surface-overlay motion-reduce:animate-none" />
      <div className="mt-2 space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-surface-overlay motion-reduce:animate-none" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-surface-overlay motion-reduce:animate-none" />
      </div>
    </div>
  );
}
