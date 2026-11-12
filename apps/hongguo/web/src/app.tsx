import { Suspense, lazy } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { FeedRoute } from './routes/feed-route';
import { useThemeEffect } from './features/theme/use-theme-effect';

/**
 * 首屏之外的路由按需加载。
 *
 * 播放器页一个文件就超过 1000 行，还带选集抽屉、进度条、倍速菜单、音量面板、
 * 雪碧图预览；搜索页带联想下拉与历史。这些代码对「打开首页看推荐流」毫无用处，
 * 但打进同一个 chunk 会让首屏白下载一半以上。首页保持同步导入：它是入口，
 * 拆出去只会多一次往返。
 */
const SearchRoute = lazy(() => import('./routes/search-route').then((module) => ({ default: module.SearchRoute })));
const SeriesRoute = lazy(() => import('./routes/series-route').then((module) => ({ default: module.SeriesRoute })));
const PlayerRoute = lazy(() => import('./routes/player-route').then((module) => ({ default: module.PlayerRoute })));
const HistoryRoute = lazy(() => import('./routes/history-route').then((module) => ({ default: module.HistoryRoute })));
const FavoritesRoute = lazy(() =>
  import('./routes/favorites-route').then((module) => ({ default: module.FavoritesRoute })),
);
const RankingRoute = lazy(() => import('./routes/ranking-route').then((module) => ({ default: module.RankingRoute })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * 服务端已有 TTL 缓存（feed 60s、series 5min），前端再压一层避免
       * 切页回来就重新请求。两者叠加后，一次会话里首屏只打一次上游。
       */
      staleTime: 5 * 60_000,
      /** 返回列表时不要重新拉取，直接复用内存数据，切页更跟手。 */
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

/**
 * 路由级懒加载的占位。
 *
 * 不用骨架屏：拆出来的页面形状各不相同，做一个通用骨架只会同时错多种。
 * 留一片与页面底色一致的空白，切换时不会闪白。
 */
function RouteFallback(): React.JSX.Element {
  return <div className="min-h-dvh bg-surface" aria-busy="true" />;
}

export function App(): React.JSX.Element {
  // 主题副作用必须挂在最外层，所有路由页都能共享。
  useThemeEffect();

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<FeedRoute />} />
            <Route path="/search" element={<SearchRoute />} />
            <Route path="/series/:id" element={<SeriesRoute />} />
            <Route path="/watch/:episodeId" element={<PlayerRoute />} />
            <Route path="/history" element={<HistoryRoute />} />
            <Route path="/favorites" element={<FavoritesRoute />} />
            <Route path="/ranking" element={<RankingRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
