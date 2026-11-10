import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { EpisodeDrawer } from '../features/player/episode-drawer';
import { Player } from '../features/player/player';
import { useHistoryStore } from '../features/history/history-store';

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
  useQuery({
    queryKey: queryKeys.playback(nextEpisode?.id ?? ''),
    queryFn: () => api.playback(nextEpisode?.id ?? ''),
    enabled: nextEpisode !== undefined,
    staleTime: 5 * 60 * 1000,
  });

  const playback = playbackQuery.data;
  const currentEpisode = episodes[currentIndex];

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
          {...(entry?.episodeId === playback.episodeId && entry.position > 3 ? { initialTime: entry.position } : {})}
          onProgress={(position, duration) => {
            if (duration <= 0 || seriesId === '') {
              return;
            }
            record({
              seriesId,
              seriesTitle: seriesQuery.data?.title ?? '',
              ...(seriesQuery.data?.coverUrl === undefined ? {} : { coverUrl: seriesQuery.data.coverUrl }),
              episodeId,
              episodeNumber: currentEpisode?.number ?? 0,
              position,
              duration,
            });
          }}
          onEnded={() => goTo(1)}
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
