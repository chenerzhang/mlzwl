import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadQueue } from './download-queue';
import { downloadEpisode, saveBlob } from './download-media';
import { initialEntry, nextEntryAfterFailure, type DownloadEntry } from './download-state';

/**
 * 同时进行的下载任务上限。
 *
 * 每集约 19 MB 且整段驻留内存，并发过高会直接吃掉几百 MB。2 个既能掩盖单集
 * 首字节延迟，又能把峰值内存压在 40 MB 量级。
 */
const MAX_CONCURRENT_DOWNLOADS = 2;

export interface EpisodeDownloadController {
  entries: Record<string, DownloadEntry>;
  /** 已排队但还没开始的任务。 */
  queued: ReadonlySet<string>;
  download: (episodeId: string) => void;
  /** 依次提交多集。已在下载、已排队、已下载的集会由调用方过滤。 */
  downloadMany: (episodeIds: readonly string[]) => void;
  cancel: (episodeId: string) => void;
  retry: (episodeId: string) => void;
}

/** 管理页面内每一集的下载进度、排队、取消与重试。 */
export function useEpisodeDownload(): EpisodeDownloadController {
  const [entries, setEntries] = useState<Record<string, DownloadEntry>>({});
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  /** 队列实例必须稳定，用 ref 而不是 state：它不参与渲染，重建会丢掉排队任务。 */
  const queueRef = useRef<DownloadQueue | null>(null);

  /** 把队列里排队的集号同步到 React 状态，供 UI 显示「排队中」。 */
  const syncQueued = useCallback((): void => {
    const queue = queueRef.current;
    if (queue === null || !mounted.current) {
      return;
    }
    setQueued(new Set(queue.waitingIds()));
  }, []);

  /**
   * 真正执行一集下载。由队列在有空位时调用，因此这里的并发数天然被限制住。
   * 返回的 Promise 结束时队列才会释放槽位。
   */
  const runDownload = useCallback(
    (episodeId: string): Promise<void> => {
      const controller = new AbortController();
      controllers.current.set(episodeId, controller);
      if (mounted.current) {
        setEntries((current) => ({
          ...current,
          [episodeId]: { status: 'downloading', received: 0, total: null },
        }));
      }

      return downloadEpisode({
        episodeId,
        signal: controller.signal,
        onProgress: ({ received, total }) => {
          if (mounted.current) {
            setEntries((current) => ({
              ...current,
              [episodeId]: { status: 'downloading', received, total },
            }));
          }
        },
      })
        .then(({ blob, filename }) => {
          controller.signal.throwIfAborted();
          if (!mounted.current) {
            return;
          }
          saveBlob(blob, filename);
          setEntries((current) => {
            const previous = current[episodeId] ?? initialEntry();
            return {
              ...current,
              [episodeId]: {
                status: 'done',
                received: previous.received,
                total: previous.total,
              },
            };
          });
        })
        .catch((cause: unknown) => {
          if (mounted.current) {
            setEntries((current) => {
              const previous = current[episodeId] ?? initialEntry();
              return {
                ...current,
                [episodeId]: nextEntryAfterFailure(previous, cause),
              };
            });
          }
        })
        .finally(() => {
          if (controllers.current.get(episodeId) === controller) {
            controllers.current.delete(episodeId);
          }
          syncQueued();
        });
    },
    [syncQueued],
  );

  const queue = useMemo(() => new DownloadQueue(MAX_CONCURRENT_DOWNLOADS, { run: runDownload }), [runDownload]);
  queueRef.current = queue;

  const download = useCallback(
    (episodeId: string): void => {
      if (!queue.enqueue(episodeId)) {
        return;
      }
      // 立即把「排队中」反映到 UI，避免点了没反应。
      syncQueued();
    },
    [queue, syncQueued],
  );

  const cancel = useCallback(
    (episodeId: string): void => {
      // 排队中的任务直接出队并标记取消，不必等它开始。
      if (queue.dequeue(episodeId)) {
        setEntries((current) => ({
          ...current,
          [episodeId]: nextEntryAfterFailure(
            current[episodeId] ?? initialEntry(),
            new DOMException('已取消', 'AbortError'),
          ),
        }));
        syncQueued();
        return;
      }
      controllers.current.get(episodeId)?.abort();
    },
    [queue, syncQueued],
  );

  const retry = useCallback(
    (episodeId: string): void => {
      download(episodeId);
    },
    [download],
  );

  const downloadMany = useCallback(
    (episodeIds: readonly string[]): void => {
      // 逐集入队而不是单独加一个批量接口：队列本身就是先来先服务，
      // 批量提交只是把多次 enqueue 合并成一次状态同步。
      for (const episodeId of episodeIds) {
        queue.enqueue(episodeId);
      }
      syncQueued();
    },
    [queue, syncQueued],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queue.clearWaiting();
      for (const controller of controllers.current.values()) {
        controller.abort();
      }
      controllers.current.clear();
    };
  }, [queue]);

  return { entries, queued, download, downloadMany, cancel, retry };
}
