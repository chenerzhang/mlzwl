import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Episode } from '@mlzwl/hongguo-shared';
import { EpisodeDownloadButton } from '../download/episode-download-button';
import { useEpisodeDownload } from '../download/use-download';
import { groupEpisodes, groupIndexOf, validateEpisodeJump } from './episode-groups';
import { useFocusTrap } from './use-focus-trap';

export interface EpisodeDrawerProps {
  open: boolean;
  episodes: Episode[];
  currentId: string | undefined;
  onSelect: (episode: Episode) => void;
  onClose: () => void;
}

/**
 * 选集抽屉。
 *
 * 从底部滑出，打开时自动滚到当前集，避免在几百集里手动找。关闭用
 * 遮罩点击或 Esc。
 *
 * 列表用 `overflow-y-auto` + `overscroll-contain`：抽屉内滚动不会连带
 * 滚动背后的页面，移动端必需。
 *
 * **分组**：超过 40 集（实测有 104 集的剧）时按 20 集一组折叠，默认只展开当前集
 * 所在组。一次性渲染 104 个按钮在低端机上会有明显卡顿，也让用户滚很久才看到
 * 自己正在看的那一集。
 *
 * **跳转**：输入集数直接定位。非法输入显示提示而不是 clamp 到最近的合法值——
 * 把 105 悄悄改成 104 会让用户以为跳到了自己输入的那一集。
 */
export function EpisodeDrawer({ open, episodes, currentId, onSelect, onClose }: EpisodeDrawerProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 待滚动的集序号（1 起）。跳转时写入，滚动完成后清空。 */
  const pendingScroll = useRef<number | null>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState<string | null>(null);
  const downloads = useEpisodeDownload();

  const groups = useMemo(() => groupEpisodes(episodes), [episodes]);
  /** 是否分组渲染。≤ 40 集时一次性全部铺开，不需要展开/收起。 */
  const grouped = groups.length > 1;
  /** 当前集序号（1 起）；找不到时 -1。 */
  const currentIndex = episodes.findIndex((episode) => episode.id === currentId) + 1;

  /** 展开的分组下标。默认只展开当前集所在组。 */
  const [expandedGroups, setExpandedGroups] = useState<readonly number[]>([]);
  /** 上一次的 `open`，用来区分「刚打开」与「开着时数据刷新」。 */
  const wasOpen = useRef(false);
  /** 本次打开是否已经落过默认展开。用于「打开时剧集还没加载完」的补位。 */
  const defaultExpanded = useRef(false);

  useFocusTrap(panelRef, { onClose, enabled: open });

  /** 展开当前集所在组（没有当前集时展开第一组），并把焦点/滚动目标指向当前集。 */
  const applyDefaultGroup = useCallback((): void => {
    if (groups.length === 0) {
      // 剧集还没加载到：只把焦点放进抽屉，等数据到了再走一次默认展开。
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    const currentGroup = groupIndexOf(groups, currentIndex);
    setExpandedGroups([currentGroup >= 0 ? currentGroup : 0]);
    defaultExpanded.current = true;
    // 焦点目标：当前集。没有当前集（从分享链接直开、集号对不上）时落到第一集，
    // 保证键盘用户打开抽屉后焦点就在列表里。
    pendingScroll.current = currentIndex >= 1 ? currentIndex : 1;
    setScrollRequest((count) => count + 1);
  }, [groups, currentIndex]);

  // 每次**从关闭变成打开**时重置分组与跳转输入：上次的展开状态和报错留到下一次
  // 打开只会让人困惑。不写成依赖 `open` 的普通 effect：开着时 `episodes` 重新拉取
  // 会换掉 `groups` 引用，那样会把用户正在输入的集数清掉、折叠已展开的分组。
  useEffect(() => {
    if (open === wasOpen.current) {
      return;
    }
    wasOpen.current = open;
    defaultExpanded.current = false;
    setJump('');
    setJumpError(null);
    if (open) {
      applyDefaultGroup();
    }
  }, [open, applyDefaultGroup]);

  // 剧集数据晚到时补一次默认展开：用户可能在选集列表还没加载完就打开了抽屉，
  // 那次重置时 `groups` 还是空的，不补的话 104 集全是折叠的，一个按钮也看不到。
  // 用 ref 而不是 `expandedGroups.length === 0` 判断：后者在用户主动折叠全部组时
  // 也成立，会把用户刚收起的组又展开。
  useEffect(() => {
    if (!open || defaultExpanded.current || groups.length === 0) {
      return;
    }
    applyDefaultGroup();
  }, [open, groups, applyDefaultGroup]);

  // 滚动到当前集或跳转目标。分组展开后才渲染按钮，所以必须等 DOM 更新完再滚。
  // 找不到目标时**保留**待滚值，下一轮重渲染（分组刚展开）再试一次。
  //
  // 同时把焦点移进抽屉：`useFocusTrap` 只在焦点已经在容器内时才拦 Tab。
  // 目标按钮可能不可播放（`disabled` 元素无法聚焦），那时把焦点放在面板上——
  // 面板有 `tabIndex={-1}`，同样算「在容器内」，下一次 Tab 会进入第一个按钮。
  useEffect(() => {
    if (!open) {
      return;
    }
    const target = pendingScroll.current;
    if (target === null) {
      return;
    }
    const node = listRef.current?.querySelector<HTMLElement>(`[data-episode-index="${target}"]`);
    if (node === null || node === undefined) {
      return;
    }
    if (node.hasAttribute('disabled')) {
      panelRef.current?.focus({ preventScroll: true });
    } else {
      node.focus({ preventScroll: true });
    }
    node.scrollIntoView({ block: 'center' });
    pendingScroll.current = null;
  }, [open, expandedGroups, scrollRequest]);

  const toggleGroup = (index: number): void => {
    setExpandedGroups((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index],
    );
  };

  const submitJump = (): void => {
    // 校验范围用**最大集号**而不是集数：上游缺集时集号会跳号，
    // 用集数会把合法的高集号误判为越界。
    const maxNumber = episodes.reduce((max, episode) => (episode.number > max ? episode.number : max), 0);
    if (maxNumber === 0) {
      setJumpError('剧集还没加载完');
      return;
    }
    const error = validateEpisodeJump(jump, maxNumber);
    setJumpError(error);
    if (error !== null) {
      return;
    }
    const wanted = Number(jump.trim());
    // 输入框填的是**按钮上显示的集号**（`episode.number`），不是列表序号。
    // 上游缺集时集号会跳号，两者不一致；直接用输入值当序号会跳到另一集。
    const index = episodes.findIndex((episode) => episode.number === wanted) + 1;
    if (index < 1) {
      setJumpError(`第 ${wanted} 集不存在`);
      return;
    }
    pendingScroll.current = index;
    const groupIndex = groupIndexOf(groups, index);
    if (groupIndex >= 0 && !expandedGroups.includes(groupIndex)) {
      setExpandedGroups((current) => [...current, groupIndex]);
    }
    setScrollRequest((count) => count + 1);
  };

  if (!open) {
    return <></>;
  }

  const renderGrid = (items: readonly Episode[], offset: number): React.JSX.Element => (
    <div className="space-y-2">
      {items.map((episode, itemIndex) => {
        const index = offset + itemIndex + 1;
        const isCurrent = episode.id === currentId;
        return (
          <div key={episode.id} className="flex items-stretch gap-2">
            <button
              type="button"
              data-episode-index={index}
              disabled={!episode.playable}
              onClick={() => onSelect(episode)}
              className={`min-h-11 min-w-0 flex-1 truncate rounded-lg px-3 text-left text-sm tabular-nums transition-colors ${
                isCurrent ? 'bg-accent font-medium text-on-accent' : 'bg-surface-raised ring-1 ring-border-subtle'
              } ${episode.playable ? '' : 'opacity-40'}`}
            >
              第 {episode.number} 集{episode.title === undefined ? '' : ` · ${episode.title}`}
            </button>
            {episode.playable && (
              <div className="w-36 flex-none" title={downloads.entries[episode.id]?.error}>
                <EpisodeDownloadButton
                  episodeId={episode.id}
                  entry={downloads.entries[episode.id]}
                  queued={downloads.queued.has(episode.id)}
                  onDownload={downloads.download}
                  onCancel={downloads.cancel}
                  onRetry={downloads.retry}
                  className="w-full truncate"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <button type="button" aria-label="关闭" onClick={onClose} className="absolute inset-0 bg-scrim/60" />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative max-h-[65%] overflow-hidden rounded-t-2xl bg-surface-overlay pb-safe outline-none"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-medium">选集</h2>
          <span className="text-xs text-text-secondary">共 {episodes.length} 集</span>
        </div>
        <form
          className="flex items-start gap-2 px-4 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitJump();
          }}
        >
          <input
            type="text"
            inputMode="numeric"
            value={jump}
            onChange={(event) => {
              setJump(event.currentTarget.value);
              setJumpError(null);
            }}
            aria-label="跳转到第几集"
            aria-invalid={jumpError !== null}
            placeholder="跳转到第 N 集"
            className="h-9 w-32 rounded-lg bg-surface-raised px-3 text-sm tabular-nums ring-1 ring-border-subtle outline-none placeholder:text-text-tertiary"
          />
          <button
            type="submit"
            className="h-9 rounded-lg bg-surface-raised px-3 text-xs ring-1 ring-border-subtle transition-colors hover:bg-surface"
          >
            跳转
          </button>
          {jumpError !== null && (
            <p role="alert" className="self-center text-xs text-accent-soft">
              {jumpError}
            </p>
          )}
        </form>
        <div ref={listRef} className="max-h-[calc(65vh-6rem)] overflow-y-auto overscroll-contain px-3 pb-3">
          {grouped
            ? groups.map((group, index) => {
                const expanded = expandedGroups.includes(index);
                return (
                  <div key={group.start} className="mb-2">
                    <button
                      type="button"
                      onClick={() => toggleGroup(index)}
                      aria-expanded={expanded}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
                    >
                      {/*
                        标题用**真实集号**（首尾按钮上的数字），与下方按钮一致。
                        分组本身按序号切（`group.start`/`group.end`），上游缺集时两者会不同，
                        显示序号会让用户以为「第 1—20 集」里真有 20 个按钮。
                      */}
                      <span className="tabular-nums">
                        第 {group.items[0]?.number}—{group.items[group.items.length - 1]?.number} 集
                      </span>
                      <span aria-hidden>{expanded ? '收起' : '展开'}</span>
                    </button>
                    {expanded && <div className="pt-2">{renderGrid(group.items, group.start - 1)}</div>}
                  </div>
                );
              })
            : groups.map((group) => <div key={group.start}>{renderGrid(group.items, group.start - 1)}</div>)}
        </div>
      </div>
    </div>
  );
}
