import type { EpisodePage, Playback, SeriesDetail, SeriesPage } from '@mlzwl/hongguo-shared';

/**
 * 后端接口客户端。
 *
 * 用相对路径：开发期由 Vite 代理到后端，生产期由同一个源提供。这样浏览器
 * 不接触上游 CDN，也不需要配置 base URL。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, text === '' ? `HTTP ${response.status}` : text);
  }
  return (await response.json()) as T;
}

export const api = {
  feed: (cursor?: string): Promise<SeriesPage> =>
    request(cursor === undefined ? '/api/feed' : `/api/feed?cursor=${encodeURIComponent(cursor)}`),

  search: (keyword: string, cursor?: string): Promise<SeriesPage> => {
    const params = new URLSearchParams({ keyword });
    if (cursor !== undefined) {
      params.set('cursor', cursor);
    }
    return request(`/api/search?${params.toString()}`);
  },

  series: (id: string): Promise<SeriesDetail> => request(`/api/series/${encodeURIComponent(id)}`),

  episodes: (id: string): Promise<EpisodePage> => request(`/api/series/${encodeURIComponent(id)}/episodes`),

  playback: (episodeId: string, definition?: string): Promise<Playback> => {
    const suffix = definition === undefined ? '' : `?definition=${encodeURIComponent(definition)}`;
    return request(`/api/episodes/${encodeURIComponent(episodeId)}/playback${suffix}`);
  },

  sprite: (
    episodeId: string,
  ): Promise<{
    gridX: number;
    gridY: number;
    cellWidth: number;
    cellHeight: number;
    frameCount: number;
    interval: number;
    sheetCount: number;
    sheetUrls: string[];
  }> => request(`/api/sprite/${encodeURIComponent(episodeId)}`),
};
