import type { FollowRecord } from '@mlzwl/hongguo-shared';
import { useNavigate } from 'react-router';
import { ArrowLeftIcon, BellIcon } from '../components/icons';
import { HOME_PATH } from '../features/navigation/back-target';
import { HeaderButton, PageHeader, SHELL_WIDTH } from '../components/page-header';
import { favoriteEntries, favoritesSummary } from '../features/follow/favorites-view';
import { newEpisodes } from '../features/follow/follow-model';
import { useFollowStore } from '../features/follow/follow-store';

/**
 * 我的收藏。
 *
 * 只有一列，没有「在看 / 想看 / 看完」三个 tab。收藏就是收藏：一个二元标记，
 * 一个列表。之前的三个 tab 来自旧的三态追更模型，那个模型既要点 4 次才能取消，
 * 分组本身也不参与任何功能。
 *
 * 追更但不收藏的剧**不出现在这里**——那是「更新提醒」，不是「我的收藏」。
 */
export function FavoritesRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const recordsById = useFollowStore((state) => state.records);
  const removeFavorite = useFollowStore((state) => state.removeFavorite);
  const records = Object.values(recordsById);
  const entries = favoriteEntries(records);
  const summary = favoritesSummary(records);

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={
          <HeaderButton
            label="返回"
            onClick={() => {
              void navigate(HOME_PATH, { replace: true });
            }}
          >
            <ArrowLeftIcon />
          </HeaderButton>
        }
        title="我的收藏"
      />

      <div className="px-3 pt-4 sm:px-5">
        {entries.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-text-tertiary">还没有收藏的短剧</p>
        ) : (
          <>
            <p className="text-[13px] tabular-nums text-text-secondary">
              共 {summary.total} 部{summary.withUpdates > 0 && <>，{summary.withUpdates} 部有更新</>}
            </p>
            <ul className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {entries.map((entry) => (
                <FavoriteCard
                  key={entry.record.seriesId}
                  record={entry.record}
                  onSelect={() => {
                    void navigate(`/series/${entry.record.seriesId}`);
                  }}
                  onRemove={() => removeFavorite(entry.record.seriesId)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

interface FavoriteCardProps {
  record: FollowRecord;
  onSelect: () => void;
  onRemove: () => void;
}

/** 横向专用卡片给取消按钮保留独立命中区，避免在可点击卡片里嵌套按钮。 */
function FavoriteCard({ record, onSelect, onRemove }: FavoriteCardProps): React.JSX.Element {
  // 只有追更中的剧才显示更新数。只收藏不追更时不打扰用户。
  const updates = record.following ? newEpisodes(record) : 0;

  return (
    <li className="group flex gap-3 overflow-hidden rounded-lg bg-surface-raised transition-colors hover:bg-surface-overlay">
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 gap-3 p-2 text-left">
        {record.coverUrl !== undefined ? (
          <img
            src={record.coverUrl}
            alt={record.seriesTitle}
            loading="lazy"
            decoding="async"
            className="h-20 w-15 flex-none rounded-md object-cover"
          />
        ) : (
          <div className="flex h-20 w-15 flex-none items-center justify-center rounded-md bg-surface-overlay text-[10px] text-text-tertiary">
            无封面
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <p className="truncate text-[13px] font-medium tracking-tight text-text-primary">{record.seriesTitle}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-text-tertiary">
            <span>{record.knownEpisodes} 集</span>
            {record.following && (
              <span className="flex items-center gap-0.5">
                <BellIcon size="sm" className="h-3 w-3" />
                追更中
              </span>
            )}
            {updates > 0 && <span className="font-medium text-accent-soft">更新 {updates} 集</span>}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`取消收藏：${record.seriesTitle}`}
        className="flex min-h-11 flex-none items-center self-stretch px-3 text-xs text-text-tertiary transition-colors hover:text-text-primary"
      >
        取消收藏
      </button>
    </li>
  );
}
