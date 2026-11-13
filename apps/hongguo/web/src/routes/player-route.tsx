import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { EpisodeDrawer } from '../features/player/episode-drawer';
import { Player } from '../features/player/player';
import { pickPrefetchTarget, prefetchMedia } from '../features/player/prefetch-next';
import { shouldPrefetch } from '../features/player/prefetch-policy';
import { resolveInitialTime, type FrozenInitialTime } from '../features/player/resume-initial-time';
import {
  chooseDefinition,
  isSwitchStateForEpisode,
  readDefinitions,
  resumeTimeAfterSwitch,
  shouldRequestBeforePlayback,
} from '../features/player/definition-selection';
import { usePlayerStore } from '../features/player/player-store';
import { playerBackTarget } from '../features/navigation/back-target';
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
  /** 用户上次选的档位；`undefined` 表示让它自动挑。 */
  const preferredDefinition = usePlayerStore((state) => state.definition);
  const setDefinition = usePlayerStore((state) => state.setDefinition);
  /**
   * 本次播放实际请求的档位，**带它所属的集号**。
   *
   * 用 state 而不是直接读 store：切档是一次显式动作，需要触发新请求；
   * 而 store 里存的是「偏好」，两者在回退场景下会不一致（记住 4k、实际请求 540p）。
   *
   * 为什么必须带 `episodeId`：换集时 React 会先用**旧 state** 渲染一次，之后
   * effect 才把它清掉。若只存裸档位，这一帧会用上一集的档位发请求，甚至把
   * 上一集的进度当成新集的起始位置。带上集号后，「属于别的集」的状态在读的时候
   * 就被判定为无效，不依赖 effect 的时序。
   */
  const [definitionRequest, setDefinitionRequest] = useState<{ episodeId: string; definition: string } | null>(null);
  /**
   * 切档前冻结的播放位置，同样带集号。
   *
   * 切档会换 `src`，`<video>` 重新加载会从 0 开始。这里在切换动作发生时记下
   * 当前进度，新 `src` 就绪后用 `initialTime` 恢复。
   */
  const [switchResume, setSwitchResume] = useState<{ episodeId: string; time: number } | null>(null);
  /**
   * 换集时清掉切档状态。
   *
   * 光靠「按集号匹配」不够：A 集切档后去 B 集、再回到 A 集时，`switchResume`
   * 里仍是上次 A 集的旧位置，会把播放器从中间拽回去，盖掉真正的观看历史。
   * 所以换集时必须真的清空。两个机制一起用：
   * 1. 按集号匹配 → 换集那一帧（effect 还没跑）读到的旧值直接判无效；
   * 2. 本 effect → 换集后彻底丢弃，回来时不会复活。
   */
  useEffect(() => {
    setDefinitionRequest(null);
    setSwitchResume(null);
  }, [episodeId]);
  /**
   * 最近一次进度回调的位置，按集号记账。
   *
   * 换集后新一集第一次 `onProgress` 到来前，这里仍是上一集的数值；带集号比较
   * 才能避免把上一集的位置用到新集上。
   */
  const progressRef = useRef<{ episodeId: string; position: number } | null>(null);
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

  /**
   * 当前集生效的请求档位。
   *
   * 只认「集号匹配」的那一条：换集那一帧旧 state 还在，直接读会拿上一集的档位。
   */
  const requestedDefinition = isSwitchStateForEpisode(definitionRequest, episodeId)
    ? definitionRequest.definition
    : undefined;
  /** 当前集生效的切档续播位置；同样只认集号匹配的那一条。 */
  const resumeTime = isSwitchStateForEpisode(switchResume, episodeId) ? switchResume.time : undefined;

  const playbackQuery = useQuery({
    queryKey: queryKeys.playback(episodeId ?? '', requestedDefinition),
    queryFn: () => api.playback(episodeId ?? '', requestedDefinition),
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
  /**
   * 下一集的**默认档**播放信息。
   *
   * 只用来读 `availableDefinitions`：不拿它的 `streamUrl` 去预热。原因见下面
   * `nextDefinition` 的说明——预热的必须是用户真正会看的那一档。
   */
  const nextPlaybackQuery = useQuery({
    queryKey: queryKeys.playback(nextEpisode?.id ?? ''),
    queryFn: () => api.playback(nextEpisode?.id ?? ''),
    enabled: nextEpisode !== undefined,
    staleTime: 5 * 60 * 1000,
  });
  /**
   * 下一集预热应该用的档位。
   *
   * 与当前集同一套规则（`chooseDefinition`）：记住的档位优先，否则沿用默认档。
   * 不这样做会重新引入「同一集下载两档整集视频」：片尾按默认档预热 720p，
   * 切集后又要按记住的 1080p 重新拉一遍，白烧一倍流量。
   */
  const nextDefinition = useMemo(() => {
    const data = nextPlaybackQuery.data;
    if (data === undefined) {
      return undefined;
    }
    const nextAvailable = readDefinitions(data).available;
    return chooseDefinition(preferredDefinition, nextAvailable, data.definition).requested;
  }, [nextPlaybackQuery.data, preferredDefinition]);
  /**
   * 下一集**目标档**的播放信息。
   *
   * 只有目标档与默认档不同时才发这个请求；相同时直接复用默认响应，省一次往返。
   */
  const nextTargetPlaybackQuery = useQuery({
    queryKey: queryKeys.playback(nextEpisode?.id ?? '', nextDefinition),
    queryFn: () => api.playback(nextEpisode?.id ?? '', nextDefinition),
    enabled:
      nextEpisode !== undefined &&
      nextDefinition !== undefined &&
      nextDefinition !== nextPlaybackQuery.data?.definition,
    staleTime: 5 * 60 * 1000,
  });
  /** 预热用的播放信息：目标档就绪则用目标档，否则等它（不退回默认档）。 */
  const nextPrefetchPlayback = useMemo(
    () => pickPrefetchTarget(nextPlaybackQuery.data, nextDefinition, nextTargetPlaybackQuery.data),
    [nextPlaybackQuery.data, nextDefinition, nextTargetPlaybackQuery.data],
  );

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
      // 切档要用：记录最近一次进度（带集号），切档时作为新 src 的起始位置。
      progressRef.current = { episodeId, position };
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
      // 必须等**目标档**的播放信息就绪：拿默认档的 `streamUrl` 预热会让切集后再下一遍。
      const target = nextPrefetchPlayback;
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
    [record, confirmCurrentEpisode, seriesId, seriesQuery.data, episodeId, currentEpisode, nextPrefetchPlayback],
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
  const definitions = useMemo(
    () => (playback === undefined ? { current: undefined, available: [] } : readDefinitions(playback)),
    [playback],
  );

  /**
   * 首次进入某一集时，按「记住的档位 > 服务端当前档 > 自动」决定请求哪一档。
   *
   * **必须在 effect 里跑而不是在渲染期算**：`setDefinitionRequest` 会改变
   * `queryKey`，渲染期调用 setState 是 React 禁止的。
   *
   * 与 `shouldRequestBeforePlayback` 的分工：那个纯函数决定「这一帧能不能挂载
   * 播放器」，本 effect 负责真正把档位写进 state。两者用的是同一个
   * `chooseDefinition`，不会分叉。
   */
  useEffect(() => {
    if (playback === undefined || episodeId === undefined || requestedDefinition !== undefined) {
      return;
    }
    const choice = chooseDefinition(preferredDefinition, definitions.available, definitions.current);
    // 只在真的需要换档时才设 state：`undefined` 表示「就用当前这次请求的结果」。
    if (choice.requested !== undefined && choice.requested !== definitions.current) {
      setDefinitionRequest({ episodeId, definition: choice.requested });
    }
  }, [playback, episodeId, requestedDefinition, preferredDefinition, definitions]);

  /**
   * 需要二次选档时先不挂载播放器。
   *
   * 否则浏览器会立刻去拉默认档整集媒体（服务端在响应前 `await` 完整下载 + 解密），
   * 紧接着切档又拉一次目标档——同一集双倍上游流量、磁盘缓存与等待。
   *
   * 这是**渲染期**的同步判断，不依赖 effect 的提交时机：effect 要等这一帧提交后
   * 才跑，而 `<video src>` 的请求在这一帧就已经发出去了。
   */
  const awaitingDefinition =
    playback !== undefined &&
    shouldRequestBeforePlayback(
      preferredDefinition,
      definitions.available,
      definitions.current,
      requestedDefinition !== undefined,
    );

  /**
   * 切换清晰度。
   *
   * 三件事必须同时成立：
   * 1. 记住用户选择（写 store，下次换集优先用它）；
   * 2. 冻结当前进度，让新 src 从同一位置继续；
   * 3. 触发新请求（改 `requestedDefinition`，`queryKey` 会跟着变）。
   *
   * 不碰签名、不碰解密：只是换一个 `/api/episodes/:id/playback?definition=` 请求。
   */
  const handleSelectDefinition = useCallback(
    (next: string) => {
      if (episodeId === undefined) {
        return;
      }
      setDefinition(next);
      // 只在这一集真的有过进度回调时才取位置：否则 `progressRef` 里可能还是别的集的数。
      const position = progressRef.current?.episodeId === episodeId ? progressRef.current.position : 0;
      const resume = resumeTimeAfterSwitch(position, lastProgressRef.current.duration);
      setSwitchResume(resume === undefined ? null : { episodeId, time: resume });
      setDefinitionRequest({ episodeId, definition: next });
    },
    [episodeId, setDefinition],
  );

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

      {playback !== undefined && awaitingDefinition && (
        <div className="flex h-full items-center justify-center text-sm text-text-secondary">
          正在切换到记住的清晰度…
        </div>
      )}

      {playback !== undefined && !awaitingDefinition && (
        <Player
          key={playback.episodeId}
          src={playback.streamUrl}
          onBack={() => {
            void navigate(playerBackTarget(seriesId), { replace: true });
          }}
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
          {...(resumeTime !== undefined
            ? // 切档后优先用切换时冻结的进度：用户看的是同一集，必须接着播。
              { initialTime: resumeTime }
            : frozenInitialTime?.episodeId === playback.episodeId && frozenInitialTime.initialTime !== undefined
              ? { initialTime: frozenInitialTime.initialTime }
              : {})}
          {...(definitions.available.length === 0 ? {} : { definitions: definitions.available })}
          {...(definitions.current === undefined ? {} : { definition: definitions.current })}
          onSelectDefinition={handleSelectDefinition}
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
        definitions={definitions.available}
        onClose={() => setDrawerOpen(false)}
        onSelect={(episode) => {
          setDrawerOpen(false);
          // 播放器内部换集也走 replace：否则 `/series/S → /watch/E1 → /watch/E2`
          // 之后点返回只会把 E2 换成 `/series/S`，栈里还留着 E1，浏览器后退
          // 又回到已看过的上一集。
          void navigate(`/watch/${episode.id}?series=${seriesId}`, { replace: true });
        }}
      />
    </div>
  );
}
