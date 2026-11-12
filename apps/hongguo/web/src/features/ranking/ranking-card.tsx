import type { RankingEntry } from '@mlzwl/hongguo-shared';
import { formatPosition, isPromoted, scoreLabel } from './ranking-view';

export interface RankingCardProps {
  entry: RankingEntry;
  onSelect: (entry: RankingEntry) => void;
}

/**
 * 榜单专用横卡。
 *
 * 普通 `SeriesCard` 以海报为视觉主角，而榜单必须先读到名次，并区分推广与真实
 * 热度；独立组件可避免把两套冲突的信息层级塞进一个通用卡片。
 */
export function RankingCard({ entry, onSelect }: RankingCardProps): React.JSX.Element {
  const promoted = isPromoted(entry);
  const score = scoreLabel(entry);
  const topThree = entry.position >= 1 && entry.position <= 3;

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className="group flex min-h-28 w-full items-stretch gap-3 rounded-xl bg-surface-raised p-2 text-left outline-none ring-1 ring-border-subtle transition-[background-color,box-shadow] duration-200 hover:bg-surface-overlay focus-visible:ring-2 focus-visible:ring-accent-soft"
    >
      {/* 前三名只提高字重与品牌色，不引入金银铜新色，避免两套主题下产生低对比。 */}
      <span
        className={`flex w-9 flex-none items-center justify-center text-xl font-semibold tabular-nums ${
          topThree ? 'text-accent-soft' : 'text-text-tertiary'
        }`}
        aria-label={`第 ${formatPosition(entry.position)} 名`}
      >
        {formatPosition(entry.position)}
      </span>

      {entry.coverUrl === undefined ? (
        <span className="flex h-24 w-18 flex-none items-center justify-center rounded-lg bg-surface-overlay text-[10px] text-text-tertiary">
          无封面
        </span>
      ) : (
        <img
          src={entry.coverUrl}
          alt={entry.title}
          loading="lazy"
          decoding="async"
          className="h-24 w-18 flex-none rounded-lg object-cover"
        />
      )}

      <span className="flex min-w-0 flex-1 flex-col justify-center pr-1">
        <span className="line-clamp-2 text-[13px] font-medium leading-snug tracking-tight text-text-primary transition-colors group-hover:text-accent-soft">
          {entry.title}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
          {promoted && <span className="rounded-full bg-accent px-2 py-0.5 font-medium text-on-accent">推荐位</span>}
          {score !== undefined && (
            <span className={promoted ? 'text-text-tertiary' : 'font-medium text-accent-soft'}>{score}</span>
          )}
          {entry.episodeCount !== undefined && <span className="text-text-tertiary">{entry.episodeCount} 集</span>}
        </span>
        {promoted && <span className="mt-1 text-[10px] text-text-tertiary">推荐位，不代表热度排序</span>}
      </span>
    </button>
  );
}

/** 尺寸与真实横卡一致，分页补位时不会推动已有内容。 */
export function RankingCardSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="flex min-h-28 gap-3 rounded-xl bg-surface-raised p-2 ring-1 ring-border-subtle">
      <div className="my-auto h-6 w-9 flex-none animate-pulse rounded bg-surface-overlay motion-reduce:animate-none" />
      <div className="h-24 w-18 flex-none animate-pulse rounded-lg bg-surface-overlay motion-reduce:animate-none" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 pr-2">
        <div className="h-3 w-5/6 animate-pulse rounded bg-surface-overlay motion-reduce:animate-none" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-surface-overlay motion-reduce:animate-none" />
      </div>
    </div>
  );
}
