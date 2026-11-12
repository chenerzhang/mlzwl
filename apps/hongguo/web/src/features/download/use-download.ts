import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadQueue, type DownloadTask } from './download-queue';
import { downloadEpisode, saveBlob } from './download-media';
import {
  activeEntry,
  entryFor,
  initialEntry,
  nextEntryAfterFailure,
  withEntry,
  type DownloadEntries,
  type DownloadEntry,
} from './download-state';
import { usePlayerStore } from '../player/player-store';
import { resolveDownloadDefinition } from './download-media-url';

/**
 * 同时进行的下载任务上限。
 *
 * 每集约 19 MB 且整段驻留内存，并发过高会直接吃掉几百 MB。2 个既能掩盖单集
 * 首字节延迟，又能把峰值内存压在 40 MB 量级。
 */
const MAX_CONCURRENT_DOWNLOADS = 2;

export interface EpisodeDownloadController {
  /** 集号 → 档位 → 记录。`selectBatchTargets` 等纯函数需要它。 */
  entries: DownloadEntries;
  /**
   * 某一集在**指定档位**下的记录。
   *
   * 必须传档位：同一集的 1080p 与 360p 是两份文件、两条记录。
   */
  entryOf: (episodeId: string, definition: string | undefined) => DownloadEntry;
  /** 某一集是否有任一档正在下载（用于显示进度、禁用重复提交）。 */
  activeOf: (episodeId: string) => DownloadEntry | undefined;
  /** 已排队但还没开始的任务。 */
  queued: ReadonlySet<string>;
  download: (episodeId: string) => void;
  /** 依次提交多集。已在下载、已排队、已下载的集会由调用方过滤。 */
  downloadMany: (episodeIds: readonly string[]) => void;
  cancel: (episodeId: string) => void;
  retry: (episodeId: string) => void;
}

/**
 * 管理页面内每一集的下载进度、排队、取消与重试。
 *
 * `definitions` 是该剧可用的清晰度档位（低→高）。传空数组时无法判断「最高档」，
 * 只有用户显式选过档才会带 `definition`，否则交给服务端默认选档。
 *
 * **档位在两个时刻确定，且只确定一次**：
 * 1. 入队时冻结（`DownloadTask.definition`）——批量提交后用户改档不会污染已排队任务；
 * 2. 记录按档位分桶——同一集下载完两档后，两条记录同时存在。
 */
export function useEpisodeDownload(definitions: readonly string[] = []): EpisodeDownloadController {
  const [entries, setEntries] = useState<DownloadEntries>({});
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  /** 队列实例必须稳定，用 ref 而不是 state：它不参与渲染，重建会丢掉排队任务。 */
  const queueRef = useRef<DownloadQueue | null>(null);
  /**
   * 下载专用的清晰度偏好。
   *
   * 读 store 而不是收参数：下载面板与详情页各自渲染，收参数就要在每个调用点
   * 重复透传。与播放档位分开，见 `PlayerPreferences.downloadDefinition`。
   *
   * 必须放 ref：`runDownload` 是 `DownloadQueue` 的构造依赖，把它做成
   * `runDownload` 的依赖会让用户切档时重建队列、丢掉排队中的任务。
   */
  const preferredDefinitionRef = useRef<string | undefined>(undefined);
  const preferredDefinition = usePlayerStore((state) => state.downloadDefinition);
  preferredDefinitionRef.current = preferredDefinition;
  /**
   * 可用档位同样放 ref，理由同上：它参与 `runDownload` 的取值，但不应触发
   * 队列重建。
   */
  const availableRef = useRef<readonly string[]>(definitions);
  availableRef.current = definitions;

  /** 把队列里排队的集号同步到 React 状态，供 UI 显示「排队中」。 */
  const syncQueued = useCallback((): void => {
    const queue = queueRef.current;
    if (queue === null || !mounted.current) {
      return;
    }
    setQueued(new Set(queue.waitingIds()));
  }, []);

  /**
   * 真正执行一个任务。由队列在有空位时调用，因此这里的并发数天然被限制住。
   * 返回的 Promise 结束时队列才会释放槽位。
   *
   * 档位用任务里冻结的值，**不读当前偏好**：见 `DownloadTask` 的说明。
   */
  const runDownload = useCallback(
    (task: DownloadTask): Promise<void> => {
      const { episodeId, definition } = task;
      const controller = new AbortController();
      controllers.current.set(episodeId, controller);
      if (mounted.current) {
        setEntries((current) =>
          withEntry(current, episodeId, definition, { status: 'downloading', received: 0, total: null }),
        );
      }

      return downloadEpisode({
        episodeId,
        ...(definition === undefined ? {} : { definition }),
        signal: controller.signal,
        onProgress: ({ received, total }) => {
          if (mounted.current) {
            setEntries((current) =>
              withEntry(current, episodeId, definition, { status: 'downloading', received, total }),
            );
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
            const previous = entryFor(current, episodeId, definition);
            return withEntry(current, episodeId, definition, {
              status: 'done',
              received: previous.received,
              total: previous.total,
            });
          });
        })
        .catch((cause: unknown) => {
          if (mounted.current) {
            setEntries((current) =>
              withEntry(
                current,
                episodeId,
                definition,
                nextEntryAfterFailure(entryFor(current, episodeId, definition), cause),
              ),
            );
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

  /** 当前偏好折算出的档位；入队时用它冻结任务。 */
  const currentDefinition = useCallback(
    (): string | undefined => resolveDownloadDefinition(preferredDefinitionRef.current, availableRef.current),
    [],
  );

  const download = useCallback(
    (episodeId: string): void => {
      // 入队即冻结：之后切档不会改变这个任务。
      const definition = currentDefinition();
      if (!queue.enqueue({ episodeId, ...(definition === undefined ? {} : { definition }) })) {
        return;
      }
      // 立即把「排队中」反映到 UI，避免点了没反应。
      syncQueued();
    },
    [currentDefinition, queue, syncQueued],
  );

  const cancel = useCallback(
    (episodeId: string): void => {
      // 排队中的任务直接出队并标记取消，不必等它开始。
      const waitingDefinition = queue.waitingDefinition(episodeId);
      if (queue.dequeue(episodeId)) {
        setEntries((current) =>
          withEntry(
            current,
            episodeId,
            waitingDefinition,
            nextEntryAfterFailure(initialEntry(), new DOMException('已取消', 'AbortError')),
          ),
        );
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
      // 档位在这里解析一次，所有任务共用同一个快照。
      const definition = currentDefinition();
      for (const episodeId of episodeIds) {
        queue.enqueue({ episodeId, ...(definition === undefined ? {} : { definition }) });
      }
      syncQueued();
    },
    [currentDefinition, queue, syncQueued],
  );

  const entryOf = useCallback(
    (episodeId: string, definition: string | undefined): DownloadEntry => entryFor(entries, episodeId, definition),
    [entries],
  );
  const activeOf = useCallback(
    (episodeId: string): DownloadEntry | undefined => activeEntry(entries, episodeId),
    [entries],
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

  return { entries, entryOf, activeOf, queued, download, downloadMany, cancel, retry };
}
