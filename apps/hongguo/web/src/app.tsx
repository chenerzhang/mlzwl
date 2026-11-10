import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { FeedRoute } from './routes/feed-route';
import { HistoryRoute } from './routes/history-route';
import { PlayerRoute } from './routes/player-route';
import { SearchRoute } from './routes/search-route';
import { SeriesRoute } from './routes/series-route';
import { useThemeEffect } from './features/theme/use-theme-effect';

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

export function App(): React.JSX.Element {
  // 主题副作用必须挂在最外层，四个路由页都能共享。
  useThemeEffect();

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<FeedRoute />} />
          <Route path="/search" element={<SearchRoute />} />
          <Route path="/series/:id" element={<SeriesRoute />} />
          <Route path="/watch/:episodeId" element={<PlayerRoute />} />
          <Route path="/history" element={<HistoryRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
