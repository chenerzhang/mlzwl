import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { formatCount, shouldShowCount } from '../lib/format';
import { useHistoryStore } from '../features/history/history-store';
import { useFollowStore } from '../features/follow/follow-store';
import { FOLLOW_STATE_LABELS, hasUpdates, newEpisodes, nextFollowState } from '../features/follow/follow-model';
import { resumeTarget } from '../features/player/resume-target';
import { DownloadPanel } from '../features/download/download-panel';
import { useEpisodeDownload } from '../features/download/use-download';
import { HeaderButton, PageHeader, SHELL_WIDTH } from '../components/page-header';

/**
 * 剧集详情：封面、简介、分集列表。
 *
 * 布局用「模糊封面做背景 + 前景信息卡」的影院式结构，而不是纯黑底：
 * 详情页只有一张封面，用它的放大模糊版填充首屏能立刻建立氛围，也让纯黑
 * 背景不显得空。模糊层固定 `opacity` 且 `pointer-events-none`，不随滚动
 * 变化，避免 `ui-ux-pro-max` 里 Excessive Motion 指出的「整屏都在动」。
 */
export function SeriesRoute(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const seriesId = id ?? '';
  const history = useHistoryStore((state) => state.entries[seriesId]);
  const followRecord = useFollowStore((state) => state.records[seriesId]);
  const follow = useFollowStore((state) => state.follow);
  const unfollow = useFollowStore((state) => state.unfollow);
  const setFollowState = useFollowStore((state) => state.setState);
  const syncEpisodes = useFollowStore((state) => state.syncEpisodes);
  /** 分集倒序。104 集时正序要点很多次才能看到最新集，倒序是真实需求。 */
  const [descending, setDescending] = useState(false);
  const [downloadPanelOpen, setDownloadPanelOpen] = useState(false);
  const downloads = useEpisodeDownload();

  const query = useQuery({
    queryKey: queryKeys.series(seriesId),
    queryFn: () => api.series(seriesId),
    enabled: seriesId !== '',
  });

  const detail = query.data;

  // 拉回详情后把上游集数推进追更记录的高水位（P1-9）。
  // 上游偶尔不返回 `episode_count`，那时用分集列表长度兑底——两者都拿不到就不推。
  // 只有已收藏的剧才有记录，`syncEpisodes` 对未收藏的剧是空操作。
  const upstreamEpisodes =
    detail === undefined ? undefined : Math.max(detail.episodeCount ?? 0, detail.episodes.length);
  useEffect(() => {
    if (seriesId === '' || upstreamEpisodes === undefined) {
      return;
    }
    syncEpisodes(seriesId, upstreamEpisodes);
  }, [seriesId, upstreamEpisodes, syncEpisodes]);

  const episodes = useMemo(() => {
    const list = detail?.episodes ?? [];
    return descending ? [...list].reverse() : list;
  }, [detail, descending]);

  /**
   * 续播目标（P1-10）。
   *
   * 历史里记的集号 + 是否看完 交给 `resumeTarget` 算：看完了下一集，没看完就
   * 回原集。它返回的是**集序号**，这里再换回分集对象。
   */
  const resume = useMemo(
    () =>
      resumeTarget({
        episodes: detail?.episodes ?? [],
        currentEpisodeNumber: history?.episodeNumber,
        position: history?.position ?? 0,
        completed: history?.completed === true,
      }),
    [detail, history],
  );
  const resumeEpisode =
    resume.episodeNumber === 0 ? undefined : detail?.episodes.find((e) => e.number === resume.episodeNumber);
  const target = resumeEpisode ?? detail?.episodes[0];
  // 高亮与按钮文案都用续播目标而不是历史原集号：看完一集后回来，两者都应该
  // 已经指向下一集。历史里记的集号已经不存在（剧集被重新抓取）时不算「继续看」。
  const hasKnownEpisode =
    history !== undefined && (detail?.episodes.some((e) => e.number === history.episodeNumber) ?? false);
  const isResuming = resumeEpisode !== undefined && hasKnownEpisode;
  /** 没看过这部剧时不预选任何集，避免第 1 集无端显示成「当前集」。 */
  const currentEpisodeId = hasKnownEpisode ? target?.id : undefined;
  const followUpdates = followRecord !== undefined && hasUpdates(followRecord) ? newEpisodes(followRecord) : 0;

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={
          <HeaderButton
            label="返回"
            onClick={() => {
              void navigate(-1);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </HeaderButton>
        }
        title={detail?.title}
        right={<span />}
      />

      <div className="px-3 pt-4 sm:px-5">
        {query.isPending && <p className="text-sm text-text-secondary">加载中…</p>}
        {query.isError && (
          <p className="rounded-xl bg-surface-raised p-4 text-sm text-text-secondary">
            加载失败：{query.error instanceof Error ? query.error.message : '未知错误'}
          </p>
        )}

        {detail !== undefined && (
          <>
            {/*
              之前这里垫了一层「封面放大 + 模糊 + 灰渐变」当背景。
              浅色主题下它表现为一块没来由的灰色雾，用户直接问「为什么背景是个
              渐变灰」。封面本身就是彩色主视觉，再垫一层同图模糊只会降低清晰度、
              增加视觉噪音，不产生任何信息。
              现在改成干净的 `surface` 底 + 封面本体 + 一条极细分隔线。
            */}
            <div>
              <div className="flex gap-4">
                {detail.coverUrl !== undefined && (
                  <img
                    src={detail.coverUrl}
                    alt={detail.title}
                    className="h-52 w-39 flex-none rounded-lg object-cover sm:h-72 sm:w-54"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{detail.title}</h1>

                  {/*
                    元信息之前是两块灰底胶囊。胶囊是"标签系统"的视觉语言，
                    放在剧名下面会让头部变成三个并列的色块。改成纯文本 + 中点分隔，
                    层级退到剧名之后，视线先落在剧名和封面上。
                  */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] tabular-nums text-text-tertiary">
                    {detail.episodeCount !== undefined && <span>{detail.episodeCount} 集全</span>}
                    {history !== undefined && (
                      <>
                        <span aria-hidden className="text-text-tertiary">
                          ·
                        </span>
                        <span>
                          {history.completed === true ? '看完' : '看到'}第 {history.episodeNumber} 集
                        </span>
                      </>
                    )}
                    {/* 追更角标（P1-8）：首页卡片用同一套高水位算法，两边数字永远一致。 */}
                    {followUpdates > 0 && <span className="font-medium text-accent-soft">更新 {followUpdates} 集</span>}
                  </div>

                  {detail.description !== undefined && (
                    <p className="mt-3 max-w-[65ch] line-clamp-4 text-xs leading-relaxed text-text-secondary sm:line-clamp-6 sm:text-sm">
                      {detail.description}
                    </p>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    {target !== undefined && (
                      <button
                        type="button"
                        onClick={() => {
                          void navigate(`/watch/${target.id}?series=${detail.id}`);
                        }}
                        className="flex h-11 min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden rounded-full bg-accent px-1 text-xs font-medium text-on-accent transition-[filter] hover:brightness-110 active:brightness-95 sm:gap-1.5 sm:px-5 sm:text-sm"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden
                          className="h-3.5 w-3.5 flex-none sm:h-4 sm:w-4"
                          fill="currentColor"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        {/*
                          文案单独包一层并截断：`min-w-0` 只允许按钮盒子缩小，不会裁掉
                          `whitespace-nowrap` 的文字；集号到四位数时文字会越过按钮边界盖住
                          右侧的追更按钮。完整文案仍是按钮的可访问名称。
                        */}
                        <span className="min-w-0 truncate">
                          {isResuming ? `继续看第 ${resume.episodeNumber} 集` : '开始观看'}
                        </span>
                      </button>
                    )}

                    {/*
                      追更按钮（P1-8）。用单个按钮循环三态，不做下拉：三态只有三个值，
                      下拉多一次点击且要自己实现弹层。循环顺序「未收藏 → 想看 → 在看 →
                      看完 → 取消」，当前态直接写在按钮上，点一下就是下一态。
                    */}
                    <button
                      type="button"
                      aria-label={
                        followRecord === undefined
                          ? '加入追更'
                          : `追更状态：${FOLLOW_STATE_LABELS[followRecord.state]}，点击切换`
                      }
                      onClick={() => {
                        const next = nextFollowState(followRecord?.state);
                        if (next === undefined) {
                          unfollow(seriesId);
                          return;
                        }
                        if (followRecord === undefined) {
                          const knownEpisodes = upstreamEpisodes ?? 0;
                          follow({
                            seriesId: detail.id,
                            seriesTitle: detail.title,
                            ...(detail.coverUrl === undefined ? {} : { coverUrl: detail.coverUrl }),
                            state: next,
                            knownEpisodes,
                            // 已经看过这部就看过一半了，不能让角标一上来就报「更新 104 集」。
                            confirmedEpisodes: Math.min(knownEpisodes, history?.episodeNumber ?? 0),
                          });
                          return;
                        }
                        setFollowState(seriesId, next);
                      }}
                      className={`flex h-11 flex-none items-center gap-0.5 whitespace-nowrap rounded-full px-2 text-xs transition-colors sm:gap-1.5 sm:px-4 sm:text-sm ${
                        followRecord === undefined
                          ? 'text-text-secondary ring-1 ring-border hover:text-text-primary'
                          : 'bg-surface-raised text-text-primary'
                      }`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden
                        className="h-3.5 w-3.5 flex-none sm:h-4 sm:w-4"
                        fill="currentColor"
                      >
                        <path d="M12 21l-1.9-1.7C4.6 14.1 2 11.8 2 8.9 2 6.6 3.8 5 6 5c1.3 0 2.5.6 3.4 1.6L12 9l2.6-2.4C15.5 5.6 16.7 5 18 5c2.2 0 4 1.6 4 3.9 0 2.9-2.6 5.2-8.1 10.4z" />
                      </svg>
                      {followRecord === undefined ? '追更' : FOLLOW_STATE_LABELS[followRecord.state]}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-10 border-t border-border-subtle pt-8">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="text-[13px] font-medium tracking-tight text-text-secondary">选集</h2>
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setDownloadPanelOpen(true)}
                    className="flex h-11 items-center gap-1 rounded-md px-3 text-xs text-text-tertiary transition-colors hover:text-text-primary"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    下载
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescending((value) => !value)}
                    className="flex h-11 items-center gap-1 rounded-md px-3 text-xs text-text-tertiary transition-colors hover:text-text-primary"
                  >
                    {descending ? '倒序' : '正序'}
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden
                      className={`h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                        descending ? 'rotate-180' : ''
                      }`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-8 md:grid-cols-10">
                {episodes.map((episode) => {
                  const isCurrent = currentEpisodeId === episode.id;
                  return (
                    <button
                      key={episode.id}
                      type="button"
                      disabled={!episode.playable}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => {
                        void navigate(`/watch/${episode.id}?series=${detail.id}`);
                      }}
                      className={`flex min-h-11 flex-col items-center justify-center overflow-hidden rounded-md px-1 py-1.5 tabular-nums transition-colors ${
                        isCurrent
                          ? 'bg-accent text-on-accent'
                          : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
                      } ${episode.playable ? '' : 'cursor-not-allowed opacity-35'}`}
                    >
                      <span className="text-[13px] font-medium leading-none">{episode.number}</span>
                      {/*
                        评论数放在集号下方而不是右上角绝对定位：绝对定位在 5 列窄格子里
                        会和集号抢位置，4 位数会压到边框上。纵向排列宽度天然够，
                        配合 truncate 也不会溢出。
                      */}
                      {shouldShowCount(episode.commentCount) && (
                        <span
                          className={`mt-1 max-w-full truncate text-[9px] leading-none ${
                            isCurrent ? 'text-on-accent' : 'text-text-tertiary'
                          }`}
                        >
                          {formatCount(episode.commentCount)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      <DownloadPanel
        open={downloadPanelOpen}
        episodes={episodes}
        entries={downloads.entries}
        queued={downloads.queued}
        onDownload={downloads.download}
        onDownloadMany={downloads.downloadMany}
        onCancel={downloads.cancel}
        onRetry={downloads.retry}
        onClose={() => setDownloadPanelOpen(false)}
      />
    </div>
  );
}
