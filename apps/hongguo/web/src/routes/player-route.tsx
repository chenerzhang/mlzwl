import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { EpisodeDrawer } from '../features/player/episode-drawer';
import { Player } from '../features/player/player';
import { prefetchMedia } from '../features/player/prefetch-next';
import { shouldPrefetch } from '../features/player/prefetch-policy';
import { resolveInitialTime, type FrozenInitialTime } from '../features/player/resume-initial-time';
import { useHistoryStore } from '../features/history/history-store';
import { useFollowStore } from '../features/follow/follow-store';

/**
 * 播放页。
 *
 * 手势由 `Player` 内部处理（单击控件、双击播放、长按倍速、左右快进），
 * 上下滑切集在这里通过 `onSwipe` 之外的方式接入：Player 不感知路由，
 * 所以切集回调由外层通过 `key` 换源 + 路由跳转实现。
 */
export function PlayerRoute(): React.JSX.Element {
  const { episodeId } = useParams<{ episodeId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const seriesId = params.get('series') ?? '';
  const [drawerOpen, setDrawerOpen] = useState(false);

  const record = useHistoryStore((state) => state.record);
  const entry = useHistoryStore((state) => (seriesId === '' ? undefined : state.entries[seriesId]));
  const confirmFollow = useFollowStore((state) => state.confirm);
  const syncFollowEpisodes = useFollowStore((state) => state.syncEpisodes);

  /**
   * 最近一次进度回调的值。
   *
   * `ended` 事件本身不带 position / duration，而「已看完」的最终写盘需要它们，
   * 否则会把一条 `position: 0` 的记录盖掉真正的片尾进度。
   */
  const lastProgressRef = useRef({ position: 0, duration: 0 });
  const initialTimeRef = useRef<FrozenInitialTime | undefined>(undefined);
  const frozenInitialTime =
    episodeId === undefined ? undefined : resolveInitialTime(initialTimeRef.current, entry, episodeId);
  if (frozenInitialTime !== undefined) {
    initialTimeRef.current = frozenInitialTime;
  }

  const seriesQuery = useQuery({
    queryKey: queryKeys.series(seriesId),
    queryFn: () => api.series(seriesId),
    enabled: seriesId !== '',
  });

  const playbackQuery = useQuery({
    queryKey: queryKeys.playback(episodeId ?? ''),
    queryFn: () => api.playback(episodeId ?? ''),
    enabled: episodeId !== undefined && episodeId !== '',
  });

  // 雪碧图是可选装饰：失败不重试，也不阻塞播放。
  const spriteQuery = useQuery({
    queryKey: queryKeys.sprite(episodeId ?? ''),
    queryFn: () => api.sprite(episodeId ?? ''),
    enabled: episodeId !== undefined && episodeId !== '',
    retry: false,
    staleTime: 10 * 60 * 1000,
  });

  const episodes = seriesQuery.data?.episodes ?? [];
  const currentIndex = useMemo(() => episodes.findIndex((episode) => episode.id === episodeId), [episodes, episodeId]);
  const currentEpisode = episodes[currentIndex];

  const goTo = useCallback(
    (offset: number) => {
      const target = episodes[currentIndex + offset];
      if (target === undefined) {
        return;
      }
      void navigate(`/watch/${target.id}?series=${seriesId}`, { replace: true });
    },
    [episodes, currentIndex, navigate, seriesId],
  );

  // 预取下一集，让切集不用等 8MB 下载解密。
  const nextEpisode = episodes[currentIndex + 1];
  const nextPlaybackQuery = useQuery({
    queryKey: queryKeys.playback(nextEpisode?.id ?? ''),
    queryFn: () => api.playback(nextEpisode?.id ?? ''),
    enabled: nextEpisode !== undefined,
    staleTime: 5 * 60 * 1000,
  });

  /**
   * 下一集预热的运行态。
   *
   * - `generation`：当前集 id。异步结果回来时与它比对，不一致说明已经切集，
   *   旧结果直接丢弃。
   * - `controller`：进行中的预热请求，切集时 abort。
   * - `done`：已经预热过的集 id，同一集只预热一次。
   *
   * 三者放在同一个 ref 里，保证「判定未预热 → 占用 controller → 记入 done」是一段
   * 同步代码，不会因为两次进度回调交错而发出两个请求。
   */
  const prefetchRef = useRef({
    generation: episodeId ?? '',
    controller: null as AbortController | null,
    done: new Set<string>(),
  });

  // 切集：先换 generation，再中止上一集还没回来的预热。
  useEffect(() => {
    const state = prefetchRef.current;
    state.generation = episodeId ?? '';
    state.controller?.abort();
    state.controller = null;
    return () => {
      state.controller?.abort();
      state.controller = null;
    };
  }, [episodeId]);

  // 播放页也可能直接被打开（分享链接），这里补一次高水位推进，
  // 否则 `confirm` 会因为没有 `knownEpisodes` 而一直被夹到 0。
  const upstreamEpisodes =
    seriesQuery.data === undefined
      ? undefined
      : Math.max(seriesQuery.data.episodeCount ?? 0, seriesQuery.data.episodes.length);
  useEffect(() => {
    if (seriesId === '' || upstreamEpisodes === undefined) {
      return;
    }
    syncFollowEpisodes(seriesId, upstreamEpisodes);
  }, [seriesId, upstreamEpisodes, syncFollowEpisodes]);

  /**
   * 把「当前集」计入追更的已看集数（P1-8）。
   *
   * 未收藏的剧 `confirm` 是空操作（store 里返回原 state，不会触发落盘），
   * 所以这里不需要先查一次记录。
   */
  const confirmCurrentEpisode = useCallback(() => {
    if (currentEpisode === undefined) {
      return;
    }
    confirmFollow(seriesId, currentEpisode.number);
  }, [confirmFollow, seriesId, currentEpisode]);

  const handleProgress = useCallback(
    (position: number, duration: number, speed: number) => {
      // 路由参数缺失时整页是错误态，不该写记录也不该预热。
      if (episodeId === undefined) {
        return;
      }
      if (duration > 0 && seriesId !== '') {
        lastProgressRef.current = { position, duration };
        record({
          seriesId,
          seriesTitle: seriesQuery.data?.title ?? '',
          ...(seriesQuery.data?.coverUrl === undefined ? {} : { coverUrl: seriesQuery.data.coverUrl }),
          episodeId,
          episodeNumber: currentEpisode?.number ?? 0,
          position,
          duration,
        });
        // 真的看到第 N 集就算用户确认了这一集，角标因此会随观看减少。
        confirmCurrentEpisode();
      }

      // 剩余时间（按倍速折算成墙钟）进入预热窗口时，让服务端提前下载 + 解密下一集。
      if (!shouldPrefetch({ position, duration, speed })) {
        return;
      }
      const target = nextPlaybackQuery.data;
      if (target === undefined) {
        return;
      }
      const state = prefetchRef.current;
      if (state.done.has(target.episodeId) || state.controller !== null) {
        return;
      }
      const generation = state.generation;
      const controller = new AbortController();
      state.controller = controller;
      // 先占位再发请求：同一集只预热一次，失败的预热也不重试（临片尾每秒都有
      // 进度回调，反复重试只会把已经吃紧的带宽和服务端再打一遍）。
      state.done.add(target.episodeId);
      void prefetchMedia({ url: target.streamUrl, signal: controller.signal }).then(() => {
        const latest = prefetchRef.current;
        // 切集后旧结果直接丢弃：effect 已经 abort 并清空了 controller 槽位，
        // 这里不能再动新集的请求。
        if (latest.generation !== generation) {
          return;
        }
        if (latest.controller === controller) {
          latest.controller = null;
        }
      });
    },
    [record, confirmCurrentEpisode, seriesId, seriesQuery.data, episodeId, currentEpisode, nextPlaybackQuery.data],
  );

  /**
   * 片尾：先把这一集标记为看完再切集。
   *
   * 进度阈值（95%）由 `record()` 内部判，这里传显式 `completed: true` 是因为
   * `ended` 是确定性信号：用户可能拖到 100% 时 `timeupdate` 被暂停吞掉，只靠
   * 进度比会漏记。
   */
  const handleEnded = useCallback(() => {
    const { duration } = lastProgressRef.current;
    if (episodeId !== undefined && seriesId !== '' && duration > 0) {
      record({
        seriesId,
        seriesTitle: seriesQuery.data?.title ?? '',
        ...(seriesQuery.data?.coverUrl === undefined ? {} : { coverUrl: seriesQuery.data.coverUrl }),
        episodeId,
        episodeNumber: currentEpisode?.number ?? 0,
        position: duration,
        duration,
        completed: true,
      });
      confirmCurrentEpisode();
    }
    goTo(1);
  }, [record, confirmCurrentEpisode, seriesId, seriesQuery.data, episodeId, currentEpisode, goTo]);

  const playback = playbackQuery.data;

  if (episodeId === undefined) {
    return <div className="p-6 text-sm text-text-secondary">缺少分集参数</div>;
  }

  return (
    <div className="relative h-safe-screen w-full">
      {playbackQuery.isPending && (
        <div className="flex h-full items-center justify-center text-sm text-text-secondary">正在准备播放…</div>
      )}

      {playbackQuery.isError && (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-secondary">
          <p>播放失败：{playbackQuery.error instanceof Error ? playbackQuery.error.message : '未知错误'}</p>
          <button
            type="button"
            onClick={() => {
              void playbackQuery.refetch();
            }}
            className="rounded-full bg-surface-raised px-5 py-2"
          >
            重试
          </button>
        </div>
      )}

      {playback !== undefined && (
        <Player
          key={playback.episodeId}
          src={playback.streamUrl}
          {...(seriesQuery.data?.title === undefined ? {} : { title: seriesQuery.data.title })}
          {...(currentEpisode === undefined ? {} : { episodeLabel: `第 ${currentEpisode.number} 集` })}
          {...(spriteQuery.data === undefined
            ? {}
            : {
                sprite: {
                  meta: {
                    gridX: spriteQuery.data.gridX,
                    gridY: spriteQuery.data.gridY,
                    cellWidth: spriteQuery.data.cellWidth,
                    cellHeight: spriteQuery.data.cellHeight,
                    frameCount: spriteQuery.data.frameCount,
                    interval: spriteQuery.data.interval,
                  },
                  sheetUrls: spriteQuery.data.sheetUrls,
                },
              })}
          {...(frozenInitialTime?.episodeId === playback.episodeId && frozenInitialTime.initialTime !== undefined
            ? { initialTime: frozenInitialTime.initialTime }
            : {})}
          onProgress={handleProgress}
          onEnded={handleEnded}
          onNextEpisode={() => goTo(1)}
          onPrevEpisode={() => goTo(-1)}
          canPrev={currentIndex > 0}
          canNext={currentIndex >= 0 && currentIndex < episodes.length - 1}
          onOpenEpisodes={() => setDrawerOpen(true)}
        />
      )}

      <EpisodeDrawer
        open={drawerOpen}
        episodes={episodes}
        currentId={episodeId}
        onClose={() => setDrawerOpen(false)}
        onSelect={(episode) => {
          setDrawerOpen(false);
          void navigate(`/watch/${episode.id}?series=${seriesId}`);
        }}
      />
    </div>
  );
}
