import { useEffect, useMemo, useRef, useState } from 'react';
import type { Episode } from '@mlzwl/hongguo-shared';
import { useFocusTrap } from '../player/use-focus-trap';
import { EpisodeDownloadButton } from './episode-download-button';
import { selectBatchTargets, selectionState, toggleAllEpisodes, toggleEpisode } from './download-selection';
import { entryFor, type DownloadEntries, type DownloadEntry } from './download-state';
import {
  downloadDefinitionPlan,
  isDownloadableDefinition,
  resolveDownloadDefinition,
  type DefinitionReadiness,
} from './download-media-url';

export interface DownloadPanelProps {
  open: boolean;
  episodes: readonly Episode[];
  /** 集号 → 档位 → 记录。按档位分桶，同一集的两档互不覆盖。 */
  entries: DownloadEntries;
  /** 某一集是否有任一档正在下载。 */
  activeOf: (episodeId: string) => DownloadEntry | undefined;
  /** 已排队但还没开始的任务。 */
  queued: ReadonlySet<string>;
  onDownload: (episodeId: string) => void;
  onDownloadMany: (episodeIds: readonly string[]) => void;
  onCancel: (episodeId: string) => void;
  onRetry: (episodeId: string) => void;
  /**
   * 这一部剧可用的清晰度档位，从低到高。
   *
   * 为空时不显示选择器：没有任何档位信息时给用户一个下拉框，只会让他选到
   * 一个服务端并不存在的档。
   */
  definitions?: readonly string[];
  /**
   * 档位信息的就绪状态。
   *
   * 未就绪（`pending`/`error`）时禁止提交：此时 `definitions` 为空，请求会不带
   * `definition`，服务端按默认档返回，而不是界面承诺的最高档。
   */
  definitionsReadiness: DefinitionReadiness;
  /** 档位查询失败时的重试入口。 */
  onRetryDefinitions: () => void;
  /** 用户选定的下载档位；`undefined` 表示「跟随最高档」。 */
  definition?: string;
  onSelectDefinition: (definition: string | undefined) => void;
  onClose: () => void;
}

/**
 * 详情页下载面板：只在打开时渲染行，避免大型剧集常驻上千个操作按钮。
 *
 * 支持勾选多集后一次提交。批量提交会跳过已下载、正在下载与排队中的集，
 * 失败的集会被重新提交，相当于批量重试。
 */
export function DownloadPanel({
  open,
  episodes,
  entries,
  activeOf,
  queued,
  onDownload,
  onDownloadMany,
  onCancel,
  onRetry,
  definitions,
  definitionsReadiness,
  onRetryDefinitions,
  definition,
  onSelectDefinition,
  onClose,
}: DownloadPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const titleId = 'download-panel-title';
  /**
   * 实际会下载的档位。
   *
   * 与 `useEpisodeDownload` 用同一个纯函数，保证「面板显示的档位」与「真正请求的
   * 档位」不可能不一致——两边各算一次是最容易出错的地方。
   */
  const usableDefinitions = (definitions ?? []).filter((item) => isDownloadableDefinition(item));
  /**
   * 提交计划：未就绪时 `blocked`，界面必须禁用提交按钮。
   *
   * 与 `useEpisodeDownload` 用同一个纯函数算档位，避免「面板显示 1080p、实际请求
   * 不带 definition」这种分叉。
   */
  const plan = downloadDefinitionPlan(definitionsReadiness, definition, usableDefinitions);
  const effectiveDefinition = plan.definition ?? resolveDownloadDefinition(definition, usableDefinitions);
  useFocusTrap(panelRef, { onClose, enabled: open });

  useEffect(() => {
    if (open) {
      closeRef.current?.focus();
    }
  }, [open]);

  /** 只有可下载的集参与勾选与全选，不可下载的集不该出现在批量任务里。 */
  const selectableIds = useMemo(
    () => episodes.filter((episode) => episode.playable).map((episode) => episode.id),
    [episodes],
  );
  // 详情重新拉取后，可下载集可能发生变化。批量目标只使用当前仍可下载的选中项，
  // 避免把已下架或已变为不可播放的旧选中项继续提交。
  const selectableSelected = useMemo(
    () => new Set(selectableIds.filter((episodeId) => selected.has(episodeId))),
    [selectableIds, selected],
  );
  const state = selectionState(selectableSelected, selectableIds);
  const targets = selectBatchTargets(selectableSelected, selectableIds, entries, queued, effectiveDefinition);

  useEffect(() => {
    // 全选框的第三态只能通过 DOM 属性设置，React 没有对应 prop。
    if (selectAllRef.current !== null) {
      selectAllRef.current.indeterminate = state === 'partial';
    }
  }, [open, state]);

  if (!open) {
    return <></>;
  }

  const submitBatch = (): void => {
    if (plan.blocked || targets.length === 0) {
      return;
    }
    onDownloadMany(targets);
    setSelected(new Set());
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" aria-label="关闭下载面板" onClick={onClose} className="absolute inset-0 bg-scrim/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[75vh] w-full max-w-lg flex-col rounded-t-2xl bg-surface-overlay pb-safe outline-none sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-medium">
              下载单集
            </h2>
            <p className="mt-0.5 text-xs text-text-tertiary">
              共 {episodes.length} 集{' · '}
              {/*
                必须写清下载的是哪一档：用户可能刚在播放器里切过档，
                下载用的却是另一档，不写清会让人以为选择没生效。
              */}
              {definitionsReadiness === 'pending'
                ? '正在获取清晰度…'
                : definitionsReadiness === 'error'
                  ? '清晰度获取失败'
                  : effectiveDefinition === undefined
                    ? '默认清晰度'
                    : `清晰度 ${effectiveDefinition}`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="h-11 rounded-lg px-3 text-xs text-text-secondary hover:text-text-primary"
          >
            关闭
          </button>
        </div>

        {/*
          清晰度选择：只在真有多档时显示。
          默认「最高档」，用户可以改成任意档；选择立刻影响后续提交的下载任务。
        */}
        {usableDefinitions.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
            <span className="flex-none text-xs text-text-tertiary">清晰度</span>
            <div role="radiogroup" aria-label="下载清晰度" className="flex flex-wrap gap-1.5">
              {usableDefinitions.map((item) => {
                const active = item === effectiveDefinition;
                return (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onSelectDefinition(item)}
                    className={`h-9 rounded-full px-3 text-xs tabular-nums transition-colors ${
                      active
                        ? 'bg-accent font-medium text-on-accent'
                        : 'bg-surface-raised text-text-secondary ring-1 ring-border-subtle hover:text-text-primary'
                    }`}
                  >
                    {item}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {definitionsReadiness === 'error' && (
          <div role="alert" className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2">
            <p className="text-xs text-text-secondary">拿不到这一部剧的清晰度，暂时不能下载。</p>
            <button
              type="button"
              onClick={onRetryDefinitions}
              className="h-9 flex-none rounded-lg px-3 text-xs text-accent ring-1 ring-border-subtle"
            >
              重试
            </button>
          </div>
        )}

        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-2">
          <label className="flex min-h-11 flex-none cursor-pointer items-center gap-2 text-xs text-text-secondary">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={state === 'all'}
              onChange={() => setSelected(toggleAllEpisodes(selected, selectableIds))}
              className="h-4 w-4 flex-none accent-[var(--color-accent)]"
            />
            全选
          </label>
          <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
            {selectableSelected.size === 0 ? '勾选多集可一次提交' : `已选 ${selectableSelected.size} 集`}
          </span>
          <button
            type="button"
            onClick={submitBatch}
            disabled={plan.blocked || targets.length === 0}
            className="h-11 flex-none rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-[filter] hover:brightness-110 active:brightness-95 disabled:opacity-40"
          >
            {plan.blocked ? '等待清晰度' : targets.length === 0 ? '批量下载' : `下载 ${targets.length} 集`}
          </button>
        </div>

        <div className="overflow-y-auto overscroll-contain px-3 py-2">
          {episodes.map((episode) => {
            const checked = selected.has(episode.id);
            return (
              <div
                key={episode.id}
                className="flex min-h-14 items-center gap-2 border-b border-border-subtle px-1 py-2 last:border-0"
              >
                {episode.playable ? (
                  <label className="flex min-h-11 w-11 flex-none cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setSelected(toggleEpisode(selected, episode.id))}
                      aria-label={`选择第 ${episode.number} 集`}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                  </label>
                ) : (
                  <span className="w-11 flex-none" />
                )}
                {/* 集号列固定宽度且不换行：`第 53 集` 折成两行会把整行撑高。 */}
                <span className="w-16 flex-none whitespace-nowrap text-xs tabular-nums text-text-secondary">
                  第{episode.number}集
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {episode.title ?? `第 ${episode.number} 集`}
                </span>
                {episode.playable ? (
                  <EpisodeDownloadButton
                    episodeId={episode.id}
                    // 只取**当前档位**那一桶：别的档已完成不影响本档按钮。
                    entry={entryFor(entries, episode.id, effectiveDefinition)}
                    active={activeOf(episode.id)}
                    queued={queued.has(episode.id)}
                    blocked={plan.blocked}
                    onDownload={onDownload}
                    onCancel={onCancel}
                    onRetry={onRetry}
                    /*
                      宽度封顶：下载中时按钮文案会变成「45% · 8.2 MB / 19.1 MB，取消」，
                      不封顶会把标题挤到 48px（只剩「第1集」）。封顶后长文案在按钮内
                      截断，完整原因仍靠 `title` 与 aria 提供。
                    */
                    className="w-36 max-w-36 flex-none truncate"
                  />
                ) : (
                  <span className="flex-none text-xs text-text-tertiary">暂不可下载</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
