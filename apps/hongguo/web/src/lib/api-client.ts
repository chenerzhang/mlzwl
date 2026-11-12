import type {
  EpisodePage,
  Playback,
  RankingCatalog,
  RankingPage,
  SeriesDetail,
  SeriesPage,
  SeriesSummary,
} from '@mlzwl/hongguo-shared';
import { apiErrorDetail, record } from './client-events';

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
    /** 服务端给的稳定错误码；响应体不是 `{ code, message }` 时为 `undefined`。 */
    readonly code: string | undefined = undefined,
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
    // 服务端错误体统一是 `{ code, message }`（见 shared 的 `ApiErrorBodySchema`）。
    // 解析不出来就退回纯文本：`/api` 下的 404 可能是 Fastify 自己的响应。
    const parsed = parseErrorBody(text);
    // 记一条前端事件供诊断使用。**只记 path**：`path` 参数本身可能带 query
    // （`search` 就是），而搜索词、cursor 都不该进诊断数据，所以先截掉 `?`
    // 之后的部分；错误消息也不记（服务端已脱敏，但没必要再抄一份）。
    record({ kind: 'api-error', detail: apiErrorDetail(path, response.status, parsed?.code) });
    throw new ApiError(
      response.status,
      parsed?.message ?? (text === '' ? `HTTP ${response.status}` : text),
      parsed?.code,
    );
  }
  return (await response.json()) as T;
}

/**
 * 从错误响应体里取 `{ code, message }`。
 *
 * 手写形状校验而不是用 shared 的 `ApiErrorBodySchema`：后者是 `zod` 对象，
 * 值导入会把 `zod` 打进浏览器包（实测 web 包 341 kB → 430 kB）。这里只有两个
 * 字符串字段，手写比引入运行时便宜。
 */
function parseErrorBody(text: string): { code: string; message: string } | undefined {
  if (text === '') {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { code, message } = body as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  return { code, message };
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

  /**
   * 搜索联想。
   *
   * 服务端把上游失败降级成 200 + 空列表，所以这里只有网络层错误才会 reject。
   * `signal` 用于取消上一次未完成的请求（P1-4）。
   */
  suggest: async (prefix: string, signal?: AbortSignal): Promise<string[]> => {
    const params = new URLSearchParams({ prefix });
    const result = await request<{ items: { text: string }[] }>(`/api/suggest?${params.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    });
    return result.items.map((item) => item.text);
  },

  /**
   * 随机一部剧。
   *
   * 没有可用候选时服务端返回 404 `{ code: 'no_random' }`，这里会抛 `ApiError`。
   * 调用方按 `code` 区分文案，不要假定总是成功。
   */
  random: (): Promise<SeriesSummary> => request('/api/random'),

  rankingCatalog: (): Promise<RankingCatalog> => request('/api/ranking/catalog'),

  ranking: (query: { content?: string; board?: string; cursor?: string }): Promise<RankingPage> => {
    const params = new URLSearchParams();
    if (query.content !== undefined) {
      params.set('content', query.content);
    }
    if (query.board !== undefined) {
      params.set('board', query.board);
    }
    if (query.cursor !== undefined) {
      params.set('cursor', query.cursor);
    }
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return request(`/api/ranking${suffix}`);
  },

  series: (id: string): Promise<SeriesDetail> => request(`/api/series/${encodeURIComponent(id)}`),

  episodes: (id: string): Promise<EpisodePage> => request(`/api/series/${encodeURIComponent(id)}/episodes`),

  playback: (episodeId: string, definition?: string): Promise<Playback> => {
    const suffix = definition === undefined ? '' : `?definition=${encodeURIComponent(definition)}`;
    return request(`/api/episodes/${encodeURIComponent(episodeId)}/playback${suffix}`);
  },

  /**
   * 服务端诊断信息（日志尾行、版本、运行时长）。
   *
   * 返回 `unknown` 而不是具体类型：形状校验统一在 `diagnostics-report.ts` 里做，
   * 这里再声明一遍接口只会让同一份契约有两处定义，改一处忘另一处。
   */
  diagnostics: (): Promise<unknown> => request('/api/diagnostics'),

  /** 服务端健康状态。同样返回 `unknown`，校验交给 `diagnostics-report.ts`。 */
  health: (): Promise<unknown> => request('/api/health'),

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
