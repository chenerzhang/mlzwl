import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { FollowRecord, FollowState } from '@mlzwl/hongguo-shared';
import { useNavigate } from 'react-router';
import { HeaderTextButton, PageHeader, SHELL_WIDTH } from '../components/page-header';
import { favoritesSummary, favoritesTabs, resolveInitialTab } from '../features/follow/favorites-view';
import { newEpisodes } from '../features/follow/follow-model';
import { useFollowStore } from '../features/follow/follow-store';

const TAB_CLASS =
  'relative flex h-11 flex-1 items-center justify-center whitespace-nowrap px-2 text-[13px] transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full';

/** 我的收藏。三个状态用固定 tab 呈现，空组也保留自己的空状态。 */
export function FavoritesRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const recordsById = useFollowStore((state) => state.records);
  const unfollow = useFollowStore((state) => state.unfollow);
  const records = Object.values(recordsById);
  const tabs = favoritesTabs(records);
  const summary = favoritesSummary(records);
  const [activeState, setActiveState] = useState<FollowState>(() => resolveInitialTab(tabs));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeTab = tabs.find((tab) => tab.state === activeState) ?? tabs[0]!;

  const selectAndFocusTab = (index: number): void => {
    const tab = tabs[index];
    if (tab === undefined) {
      return;
    }
    setActiveState(tab.state);
    tabRefs.current[index]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    selectAndFocusTab(nextIndex);
  };

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
        title="我的收藏"
      />

      <div className="px-3 pt-4 sm:px-5">
        <p className="text-[13px] tabular-nums text-text-secondary">
          共 {summary.total} 部{summary.withUpdates > 0 && <>，{summary.withUpdates} 部有更新</>}
        </p>

        <div role="tablist" aria-label="收藏状态" className="mt-3 flex border-b border-border-subtle">
          {tabs.map((tab, index) => {
            const selected = tab.state === activeTab.state;
            const tabId = `favorites-tab-${tab.state}`;
            const panelId = `favorites-panel-${tab.state}`;
            return (
              <button
                key={tab.state}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={tabId}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveState(tab.state)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={`${TAB_CLASS} ${
                  selected
                    ? 'font-medium text-text-primary after:bg-accent'
                    : 'text-text-secondary after:bg-transparent hover:text-text-primary'
                }`}
              >
                {tab.title} <span className="ml-1 tabular-nums text-text-tertiary">{tab.records.length}</span>
              </button>
            );
          })}
        </div>

        <section
          id={`favorites-panel-${activeTab.state}`}
          role="tabpanel"
          aria-labelledby={`favorites-tab-${activeTab.state}`}
          tabIndex={0}
        >
          {activeTab.records.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-text-tertiary">{activeTab.emptyHint}</p>
          ) : (
            <ul className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {activeTab.records.map((record) => (
                <FavoriteCard
                  key={record.seriesId}
                  record={record}
                  onSelect={() => {
                    void navigate(`/series/${record.seriesId}`);
                  }}
                  onRemove={() => unfollow(record.seriesId)}
                />
              ))}
            </ul>
          )}
        </section>
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
  const updates = newEpisodes(record);

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
