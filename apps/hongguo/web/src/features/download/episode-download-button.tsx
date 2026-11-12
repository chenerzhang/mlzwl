import { formatBytes, initialEntry, progressPercent, type DownloadEntry } from './download-state';

export interface EpisodeDownloadButtonProps {
  episodeId: string;
  /** 当前档位那一桶的记录。 */
  entry: DownloadEntry | undefined;
  /**
   * 本集正在下载的任务（可能是别的档）。
   *
   * 并发限制按集算，所以同一集不可能同时跑两个档。用户在当前档点开按钮时，
   * 若该集正以另一档下载，必须显示进度而不是「下载」——否则点了会被队列忽略，
   * 看起来像点了没反应。
   */
  active?: DownloadEntry | undefined;
  /** 已排队但还没开始。并发闸门满时新任务会先排队。 */
  queued?: boolean;
  /**
   * 档位信息还没拿到，此时不允许提交。
   *
   * 只压过「空闲 / 已下载 / 失败」三种静止态：正在下载与排队中的集必须仍能
   * 取消，否则一次卡住的下载就没有出口。
   */
  blocked?: boolean;
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
  active,
  queued = false,
  blocked = false,
  onDownload,
  onCancel,
  onRetry,
  idleLabel = '下载',
  className = '',
}: EpisodeDownloadButtonProps): React.JSX.Element {
  /*
    状态优先级：`active`（本集任一档在跑）> `queued`（本集任一档在排队）> 当前档位记录。

    顺序不能反。反了会出现这些错：
    - 1080p 已完成、360p 正在排队，切回 1080p 时按钮显示「已下载」且被禁用，
      用户既看不到排队状态，也没有取消入口；
    - 当前档 failed、另一档正在跑时，按钮显示「重试」，点了会被队列按集号拒绝。

    `active` 与 `queued` 都是「按集」的，因为它们反映队列的并发语义（每集一个任务）。
  */
  const shown = active ?? entry;
  const percent = progressPercent(shown);
  let label = idleLabel;
  let action = onDownload;
  let disabled = false;

  if (shown.status === 'downloading') {
    const progress =
      percent === null
        ? `${formatBytes(shown.received)} 已下载`
        : `${percent}% · ${formatBytes(shown.received)} / ${formatBytes(shown.total ?? 0)}`;
    label = `${progress}，取消`;
    action = onCancel;
  } else if (queued) {
    // 排队中的任务可以取消，否则用户点了没反应又撤不掉。
    label = '排队中，取消';
    action = onCancel;
  } else if (blocked) {
    // 档位未知时提交会下成服务端默认档，与界面承诺的最高档不符，直接挡住。
    label = '等待清晰度';
    disabled = true;
  } else if (entry.status === 'done') {
    label = '已下载';
    disabled = true;
  } else if (entry.status === 'failed') {
    label = entry.error === '已取消' ? '已取消，重新下载' : `失败：${entry.error ?? '下载失败'}，重试`;
    action = onRetry;
  }

  return (
    <button
      type="button"
      /*
        `disabled` 必须跟 `shown` 走，不能跟 `entry` 走：当前档已下载、
        另一档正在跑时，按钮显示的是那条任务的进度与「取消」，若此时按
        `entry` 判 `disabled`，用户看到进度条却点不动，也撤不掉那次下载。
      */
      disabled={disabled}
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
