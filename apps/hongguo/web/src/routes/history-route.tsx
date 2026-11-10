import { useNavigate } from 'react-router';
import { useHistoryStore } from '../features/history/history-store';
import { HeaderTextButton, PageHeader, SHELL_WIDTH } from '../components/page-header';

/** 观看历史。按最近更新时间排序。 */
export function HistoryRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const entries = useHistoryStore((state) => state.entries);
  const remove = useHistoryStore((state) => state.remove);
  const clear = useHistoryStore((state) => state.clear);

  const list = Object.values(entries).sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={
          <HeaderTextButton
            label="返回"
            onClick={() => {
              void navigate(-1);
            }}
          >
            返回
          </HeaderTextButton>
        }
        title="观看历史"
        right={list.length > 0 ? <HeaderTextButton label="清空" onClick={clear} /> : undefined}
      />

      {list.length === 0 && (
        <p className="px-3 pt-20 text-center text-[13px] text-text-secondary sm:px-5">还没有观看记录</p>
      )}

      <ul className="grid grid-cols-1 gap-2 px-3 pt-4 sm:px-5 md:grid-cols-2 xl:grid-cols-3">
        {list.map((entry) => {
          const progress = entry.duration > 0 ? Math.min(entry.position / entry.duration, 1) : 0;
          return (
            <li
              key={entry.seriesId}
              className="group flex gap-3 overflow-hidden rounded-lg bg-surface-raised transition-colors hover:bg-surface-overlay"
            >
              <button
                type="button"
                onClick={() => {
                  void navigate(`/watch/${entry.episodeId}?series=${entry.seriesId}`);
                }}
                className="flex min-w-0 flex-1 gap-3 p-2 text-left"
              >
                {entry.coverUrl !== undefined ? (
                  <img
                    src={entry.coverUrl}
                    alt={entry.seriesTitle}
                    className="h-20 w-15 flex-none rounded-md object-cover"
                  />
                ) : (
                  <div className="h-20 w-15 flex-none rounded-md bg-surface-overlay" />
                )}
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <p className="truncate text-[13px] font-medium tracking-tight text-text-primary">
                    {entry.seriesTitle}
                  </p>
                  <p className="mt-1 text-[11px] tabular-nums text-text-tertiary">第 {entry.episodeNumber} 集</p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-border-subtle">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                    <span className="flex-none text-[10px] tabular-nums text-text-tertiary">
                      {Math.round(progress * 100)}%
                    </span>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => remove(entry.seriesId)}
                aria-label="删除记录"
                className="flex w-11 flex-none items-center justify-center self-stretch text-text-tertiary transition-colors hover:text-text-primary"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
