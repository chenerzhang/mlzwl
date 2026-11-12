import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service.js';
import { CatalogMapper } from './catalog.mapper.js';
import { CoverProxyService } from '../cover/cover-proxy.service.js';
import type { HongguoService } from '../hongguo/hongguo.service.js';
import { CoverTokenCodec } from '../cover/cover-token.js';

/**
 * 随机入口的服务级契约测试（P2-5）。
 *
 * 两个必须守住的东西：
 * 1. **封面必须经 `mapper.toSeriesSummary` 改写**成 `/api/cover/<不透明令牌>`。
 *    上游 CDN 直链与签名参数绝不能出现在响应里——这是本项目的核心安全契约。
 *    令牌化之后这个断言才真正可测：以前代理地址把原始 URL 放在 `u` 里，
 *    响应体里必然出现上游主机名，只能退而断言「以代理前缀开头」。
 * 2. **空池必须返回 `undefined`**，由 controller 转成 404 `no_random`。
 *
 * 不碰真实上游：`HongguoService.getClient()` 被替换成返回固定榜单的桩。走的是
 * 真实的 `loadRandomPool` → `toRandomCandidates` → `mapper` 链路。
 */

/** 白名单 CDN 域名，避免 `proxyUrl` 之外还触发白名单校验的意外。 */
const CDN = 'https://p3-reading-sign.fqnovelpic.com';

/**
 * 只提供 `proxyUrl` 的 `CoverProxyService` 桩。
 *
 * 用真实令牌编解码器而不是写死字符串：断言才有意义——令牌必须是不可读的密文，
 * 且能被解回原始上游地址。写死「查询串里带明文上游地址」的形态会让「不泄漏签名」
 * 这条断言失效。
 */
const testCodec = CoverTokenCodec.fromKey(Buffer.alloc(32, 11));

function stubCovers(): CoverProxyService {
  return { proxyUrl: (upstream: string) => `/api/cover/${testCodec.seal(upstream)}` } as CoverProxyService;
}

/** 从代理地址里取出令牌并解密，还原上游 URL；不是合法令牌时返回 null。 */
function openCover(coverUrl: string | undefined): string | null {
  if (coverUrl === undefined) {
    return null;
  }
  const prefix = '/api/cover/';
  if (!coverUrl.startsWith(prefix)) {
    return null;
  }
  return testCodec.open(coverUrl.slice(prefix.length));
}

/** 造一个只实现 `shortRank()` 的 `HongguoService` 桩。 */
function stubHongguo(ranking: unknown): HongguoService {
  return {
    getClient: () => Promise.resolve({ shortRank: () => Promise.resolve(ranking) }),
  } as unknown as HongguoService;
}

function makeService(ranking: unknown): CatalogService {
  const covers = stubCovers();
  return new CatalogService(stubHongguo(ranking), new CatalogMapper(covers));
}

describe('CatalogService.ranking', () => {
  const ranking = {
    contents: [{ id: 'all', name: '全部', boards: [{ id: 'ranklist_hot_sc', name: '推荐榜' }] }],
    content: 'all',
    board: 'ranklist_hot_sc',
    items: [
      {
        position: 1,
        series_id: 's1',
        title: '长生',
        cover_url: `${CDN}/ranking.jpg`,
        score: '8835万热度',
      },
    ],
    has_more: true,
    cursor: 'next',
  };

  it('rewrites every ranking cover through the mapper', async () => {
    const proxyUrl = vi.fn(() => `/api/cover/${testCodec.seal(`${CDN}/ranking.jpg`)}`);
    const service = new CatalogService(
      stubHongguo(ranking),
      new CatalogMapper({ proxyUrl } as unknown as CoverProxyService),
    );

    const result = await service.ranking({ content: 'all', board: 'ranklist_hot_sc' });

    expect(proxyUrl).toHaveBeenCalledWith(`${CDN}/ranking.jpg`);
    // 令牌不可读：解不回原地址说明它只是个不透明字符串。
    expect(result.entries[0]?.coverUrl).toMatch(/^\/api\/cover\/[A-Za-z0-9_-]+$/);
    expect(openCover(result.entries[0]?.coverUrl)).toBe(`${CDN}/ranking.jpg`);

    const covers = result.entries.map((entry) => entry.coverUrl).filter((url) => url !== undefined);
    expect(covers.length).toBeGreaterThan(0);
    for (const cover of covers) {
      expect(cover.startsWith('/api/cover/')).toBe(true);
      expect(cover.startsWith('http')).toBe(false);
    }

    // 令牌化之后这条断言才成立：整个响应体里不能出现上游主机名或签名参数。
    const body = JSON.stringify(result);
    expect(body).not.toContain('fqnovelpic');
    expect(body).not.toContain('x-signature');
  });

  it('keeps the upstream cursor on an empty intermediate page', async () => {
    const service = makeService({ ...ranking, items: [], has_more: true, cursor: 'next' });
    await expect(service.ranking({})).resolves.toMatchObject({ entries: [], cursor: 'next' });
  });

  it('isolates cache entries when content or board contains a colon', async () => {
    const shortRank = vi.fn((options: { content?: string; board?: string }) =>
      Promise.resolve({
        ...ranking,
        content: options.content,
        board: options.board,
        items: [{ position: 1, series_id: `${options.content}|${options.board}`, title: '榜单' }],
      }),
    );
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    const first = await service.ranking({ content: 'a:b', board: 'c' });
    const second = await service.ranking({ content: 'a', board: 'b:c' });

    expect(first.entries[0]?.seriesId).toBe('a:b|c');
    expect(second.entries[0]?.seriesId).toBe('a|b:c');
    expect(shortRank).toHaveBeenCalledTimes(2);
  });

  it('isolates a missing content from the literal content "undefined"', async () => {
    const shortRank = vi.fn((options: { content?: string }) =>
      Promise.resolve({
        ...ranking,
        items: [{ position: 1, series_id: options.content ?? 'missing', title: '榜单' }],
      }),
    );
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    const missing = await service.ranking({ board: 'hot' });
    const literal = await service.ranking({ content: 'undefined', board: 'hot' });

    expect(missing.entries[0]?.seriesId).toBe('missing');
    expect(literal.entries[0]?.seriesId).toBe('undefined');
    expect(shortRank).toHaveBeenCalledTimes(2);
  });

  it('isolates cache entries when content or board contains a NUL byte', async () => {
    // `z.string()` 不拒绝 NUL，URL 的 `%00` 能还原成真实 NUL 字节。
    // 用 NUL 当分隔符时这两个查询会拼出同一个键，第二个查询会拿到第一个的缓存。
    const shortRank = vi.fn((options: { content?: string; board?: string }) =>
      Promise.resolve({
        ...ranking,
        items: [{ position: 1, series_id: `${options.content}|${options.board}`, title: '榜单' }],
      }),
    );
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    const first = await service.ranking({ content: 'a\u0000b', board: 'c' });
    const second = await service.ranking({ content: 'a', board: 'b\u0000c' });

    expect(first.entries[0]?.seriesId).toBe('a\u0000b|c');
    expect(second.entries[0]?.seriesId).toBe('a|b\u0000c');
    expect(shortRank).toHaveBeenCalledTimes(2);
  });

  it('isolates a missing board from an empty board in the ranking cache', async () => {
    const shortRank = vi.fn((options: { board?: string }) =>
      Promise.resolve({
        ...ranking,
        items: [{ position: 1, series_id: 's1', title: '榜单', episode_count: options.board === undefined ? 1 : 2 }],
      }),
    );
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    const missing = await service.ranking({ content: 'all' });
    const empty = await service.ranking({ content: 'all', board: '' });

    expect(missing.entries[0]?.episodeCount).toBe(1);
    expect(empty.entries[0]?.episodeCount).toBe(2);
    expect(shortRank).toHaveBeenCalledTimes(2);
  });

  it('isolates different cursors in the ranking cache', async () => {
    const shortRank = vi.fn((options: { cursor?: string }) =>
      Promise.resolve({
        ...ranking,
        items: [{ position: 1, series_id: options.cursor ?? 'first', title: '榜单' }],
      }),
    );
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    const first = await service.ranking({ content: 'all', board: 'hot', cursor: 'page-1' });
    const second = await service.ranking({ content: 'all', board: 'hot', cursor: 'page-2' });

    expect(first.entries[0]?.seriesId).toBe('page-1');
    expect(second.entries[0]?.seriesId).toBe('page-2');
    expect(shortRank).toHaveBeenCalledTimes(2);
  });

  it('queries the same content, board and cursor only once within the cache window', async () => {
    const shortRank = vi.fn(() => Promise.resolve(ranking));
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    await service.ranking({ content: 'all', board: 'ranklist_hot_sc', cursor: 'page-2' });
    await service.ranking({ content: 'all', board: 'ranklist_hot_sc', cursor: 'page-2' });

    expect(shortRank).toHaveBeenCalledTimes(1);
  });

  it('includes boardName when the returned catalog contains the board', async () => {
    await expect(makeService(ranking).ranking({})).resolves.toMatchObject({ boardName: '推荐榜' });
  });

  it('omits boardName when the returned catalog does not contain the board', async () => {
    const result = await makeService({ ...ranking, board: 'unknown' }).ranking({});
    expect('boardName' in result).toBe(false);
  });

  it('returns a null cursor when has_more is false', async () => {
    const result = await makeService({ ...ranking, has_more: false }).ranking({});
    expect(result.cursor).toBeNull();
  });
});

describe('CatalogService.rankingCatalog', () => {
  it('returns only sections and boards from the upstream directory', async () => {
    const service = makeService({
      contents: [{ id: 'all', name: '全部', boards: [{ id: 'hot', name: '热播榜' }] }],
      items: [{ position: 1, series_id: 'ignored', title: '不应出现在目录' }],
    });

    await expect(service.rankingCatalog()).resolves.toEqual({
      sections: [{ id: 'all', name: '全部', boards: [{ id: 'hot', name: '热播榜' }] }],
    });
  });
});

describe('CatalogService.random', () => {
  it('rewrites the upstream cover URL through the proxy', async () => {
    const service = makeService({
      items: [{ series_id: 's1', title: '长生', cover_url: `${CDN}/cover.jpg`, episode_count: 78 }],
    });

    const series = await service.random();

    expect(series).toBeDefined();
    // 上游 CDN 直链绝不能出现在响应里，令牌必须能解回原始地址。
    expect(openCover(series?.coverUrl)).toBe(`${CDN}/cover.jpg`);
    expect(JSON.stringify(series)).not.toContain(CDN);
    expect(JSON.stringify(series)).not.toContain('fqnovelpic');
  });

  it('returns undefined when the ranking has no usable candidate', async () => {
    // 全是演员行（没有 series_id）：过滤后池子为空，controller 会转成 404。
    const service = makeService({ items: [{ actor: '某演员' }, { series_id: '', title: '空 id' }] });
    await expect(service.random()).resolves.toBeUndefined();
  });

  it('returns undefined when the ranking is empty', async () => {
    const service = makeService({ items: [] });
    await expect(service.random()).resolves.toBeUndefined();
  });

  it('queries the upstream ranking only once within the cache window', async () => {
    // 缓存的是**候选池**，不是选中的那一条：60 秒内可以多次随机不同结果，
    // 但每个 TTL 只打一次上游。
    const shortRank = vi.fn(() => Promise.resolve({ items: [{ series_id: 's1', title: '甲' }] }));
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ shortRank }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );

    await service.random();
    await service.random();
    await service.random();

    expect(shortRank).toHaveBeenCalledTimes(1);
  });

  it('drops rows whose episode_count is a numeric string', async () => {
    // 上游是松散 JSON：`"78"` 不是非负整数，整条丢弃，而不是当成 78 集展示。
    const service = makeService({
      items: [
        { series_id: 'bad', title: '字符串集数', episode_count: '78' },
        { series_id: 'ok', title: '合法', episode_count: 12 },
      ],
    });

    const series = await service.random();

    expect(series?.id).toBe('ok');
  });
});

describe('CatalogService.feed', () => {
  /** 造一个只实现 `discover()` 的 `HongguoService` 桩，按传入游标回显。 */
  function makeFeedService(): { service: CatalogService; discover: ReturnType<typeof vi.fn> } {
    const discover = vi.fn((options: { cursor?: string }) =>
      Promise.resolve({
        items: [{ id: `s-${options.cursor ?? 'first'}`, title: '剧', episode_count: 1 }],
        has_more: true,
        cursor: options.cursor,
      }),
    );
    const service = new CatalogService(
      { getClient: () => Promise.resolve({ discover }) } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );
    return { service, discover };
  }

  it('isolates a missing cursor from the literal cursor "first"', async () => {
    // 旧实现用 `cursor ?? 'first'` 当键，字面量游标 "first" 会撞上「没有游标」，
    // 第二次请求会直接命中第一次的缓存而不打上游。
    const { service, discover } = makeFeedService();

    const missing = await service.feed(undefined);
    const literal = await service.feed('first');

    expect(missing.items[0]?.id).toBe('s-first');
    expect(literal.items[0]?.id).toBe('s-first');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('queries the same cursor only once within the cache window', async () => {
    const { service, discover } = makeFeedService();

    await service.feed('page-1');
    await service.feed('page-1');

    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe('CatalogService.search', () => {
  /** 造一个只实现 `search()` 的桩，按游标回显集数以便区分。 */
  function makeSearchService(): { service: CatalogService; search: ReturnType<typeof vi.fn> } {
    const search = vi.fn((keyword: string, options: { cursor?: string }) =>
      Promise.resolve({
        items: [{ id: 's1', title: keyword, episode_count: options.cursor === undefined ? 1 : 2 }],
        has_more: false,
        cursor: undefined,
      }),
    );
    const service = new CatalogService(
      {
        getClient: () =>
          Promise.resolve({
            search,
            // `loadSearch` 会拿搜索结果批量补详情，缺失时整条链路抛 TypeError。
            getSeriesBatch: () => Promise.resolve([]),
          }),
      } as unknown as HongguoService,
      new CatalogMapper(stubCovers()),
    );
    return { service, search };
  }

  it('isolates a missing cursor from the literal cursor "first"', async () => {
    // 与 feed 同源缺陷：`cursor ?? 'first'` 会让字面量 "first" 命中「没有游标」的缓存。
    const { service, search } = makeSearchService();

    const missing = await service.search('长生', undefined);
    const literal = await service.search('长生', 'first');

    expect(missing.items[0]?.episodeCount).toBe(1);
    expect(literal.items[0]?.episodeCount).toBe(2);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
