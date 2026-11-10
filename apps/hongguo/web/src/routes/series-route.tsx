import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { formatCount, shouldShowCount } from '../lib/format';
import { useHistoryStore } from '../features/history/history-store';
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
  /** 分集倒序。104 集时正序要点很多次才能看到最新集，倒序是真实需求。 */
  const [descending, setDescending] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.series(seriesId),
    queryFn: () => api.series(seriesId),
    enabled: seriesId !== '',
  });

  const detail = query.data;

  const episodes = useMemo(() => {
    const list = detail?.episodes ?? [];
    return descending ? [...list].reverse() : list;
  }, [detail, descending]);

  const startEpisode = history !== undefined ? detail?.episodes.find((e) => e.id === history.episodeId) : undefined;
  const target = startEpisode ?? detail?.episodes[0];

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
                        <span>看到第 {history.episodeNumber} 集</span>
                      </>
                    )}
                  </div>

                  {detail.description !== undefined && (
                    <p className="mt-3 max-w-[65ch] line-clamp-4 text-xs leading-relaxed text-text-secondary sm:line-clamp-6 sm:text-sm">
                      {detail.description}
                    </p>
                  )}

                  {target !== undefined && (
                    <button
                      type="button"
                      onClick={() => {
                        void navigate(`/watch/${target.id}?series=${detail.id}`);
                      }}
                      className="mt-3 flex h-11 items-center gap-1.5 rounded-full bg-accent px-5 text-sm font-medium text-on-accent transition-[filter] hover:brightness-110 active:brightness-95"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      {startEpisode !== undefined ? `继续看第 ${startEpisode.number} 集` : '开始观看'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-10 border-t border-border-subtle pt-8">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="text-[13px] font-medium tracking-tight text-text-secondary">选集</h2>
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

              <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-8 md:grid-cols-10">
                {episodes.map((episode) => {
                  const isCurrent = history?.episodeId === episode.id;
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
    </div>
  );
}
