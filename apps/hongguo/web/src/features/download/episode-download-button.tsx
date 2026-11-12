import { formatBytes, initialEntry, progressPercent, type DownloadEntry } from './download-state';

export interface EpisodeDownloadButtonProps {
  episodeId: string;
  entry: DownloadEntry | undefined;
  /** 已排队但还没开始。并发闸门满时新任务会先排队。 */
  queued?: boolean;
  onDownload: (episodeId: string) => void;
  onCancel: (episodeId: string) => void;
  onRetry: (episodeId: string) => void;
  idleLabel?: string;
  className?: string;
}

/** 单集下载按钮：按钮本身同时承担状态播报与取消 / 重试入口。 */
export function EpisodeDownloadButton({
  episodeId,
  entry = initialEntry(),
  queued = false,
  onDownload,
  onCancel,
  onRetry,
  idleLabel = '下载',
  className = '',
}: EpisodeDownloadButtonProps): React.JSX.Element {
  const percent = progressPercent(entry);
  let label = idleLabel;
  let action = onDownload;

  if (entry.status === 'downloading') {
    const progress =
      percent === null
        ? `${formatBytes(entry.received)} 已下载`
        : `${percent}% · ${formatBytes(entry.received)} / ${formatBytes(entry.total ?? 0)}`;
    label = `${progress}，取消`;
    action = onCancel;
  } else if (entry.status === 'done') {
    label = '已下载';
  } else if (entry.status === 'failed') {
    label = entry.error === '已取消' ? '已取消，重新下载' : `失败：${entry.error ?? '下载失败'}，重试`;
    action = onRetry;
  } else if (queued) {
    // 排队中的任务可以取消，否则用户点了没反应又撤不掉。
    label = '排队中，取消';
    action = onCancel;
  }

  return (
    <button
      type="button"
      disabled={entry.status === 'done'}
      onClick={() => action(episodeId)}
      /*
        `title` 给出完整文案：窄屏下按钮宽度封顶，进度数字会被截断，
        鼠标悬停仍能看到完整信息。
      */
      title={label}
      className={`min-h-11 overflow-hidden rounded-lg px-3 text-xs text-ellipsis whitespace-nowrap text-text-secondary ring-1 ring-border-subtle transition-colors hover:text-text-primary disabled:opacity-60 ${className}`}
    >
      {label}
    </button>
  );
}
