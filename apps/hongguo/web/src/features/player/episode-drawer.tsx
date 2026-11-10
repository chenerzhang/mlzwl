import { useEffect, useRef } from 'react';
import type { Episode } from '@mlzwl/hongguo-shared';

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
 */
export function EpisodeDrawer({ open, episodes, currentId, onSelect, onClose }: EpisodeDrawerProps): React.JSX.Element {
  const currentRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    currentRef.current?.scrollIntoView({ block: 'center' });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) {
    return <></>;
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <button type="button" aria-label="关闭" onClick={onClose} className="absolute inset-0 bg-scrim/60" />
      <div className="relative max-h-[65%] overflow-hidden rounded-t-2xl bg-surface-overlay pb-safe">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-medium">选集</h2>
          <span className="text-xs text-text-secondary">共 {episodes.length} 集</span>
        </div>
        <div className="max-h-[calc(65vh-3rem)] overflow-y-auto overscroll-contain px-3 pb-3">
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 md:grid-cols-10">
            {episodes.map((episode) => {
              const isCurrent = episode.id === currentId;
              return (
                <button
                  key={episode.id}
                  ref={isCurrent ? currentRef : null}
                  type="button"
                  disabled={!episode.playable}
                  onClick={() => onSelect(episode)}
                  className={`rounded-lg py-2.5 text-sm tabular-nums transition-colors ${
                    isCurrent ? 'bg-accent font-medium text-on-accent' : 'bg-surface-raised ring-1 ring-border-subtle'
                  } ${episode.playable ? '' : 'opacity-40'}`}
                >
                  {episode.number}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
