import { Injectable } from '@nestjs/common';
import type {
  Client,
  Episode,
  Page,
  SeriesDetail as UpstreamSeriesDetail,
  SeriesSummary,
  ShortRankQuery,
} from 'openhongguo';
import { OpenhongguoError } from 'openhongguo';
import type {
  EpisodePage,
  RankingCatalog,
  RankingPage as RankingPageDto,
  RankingQuery,
  SeriesDetail,
  SeriesPage,
  SeriesSummary as SeriesSummaryDto,
} from '@mlzwl/hongguo-shared';
import { TtlCache } from '../common/ttl-cache.js';
import { cacheKeyOf } from './cache-key.js';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { CatalogMapper } from './catalog.mapper.js';
import { pickRandom, toRandomCandidates } from './random-pick.js';
import { pickNextCursor, toRankingEntries } from './ranking-rows.js';
import { normalizeSearchText } from './search-text.js';

/** 首页每页数量。 */
const FEED_PAGE_SIZE = 12;

/** 推荐流缓存时间。上游单次约 2.5 秒，推荐内容变化很慢。 */
const FEED_TTL_MS = 60_000;
/** 剧集详情缓存时间。分集列表基本不变。 */
const SERIES_TTL_MS = 5 * 60_000;
/** 搜索缓存时间。短一些，关键词结果可能调整。 */
const SEARCH_TTL_MS = 60_000;
/** 联想缓存时间。30 秒足以覆盖连续输入，又不会让新内容长期不可见。 */
const SUGGEST_TTL_MS = 30_000;
/** 联想条数上限。下拉最多展示 8 条，上游返回更多时截断。 */
const SUGGEST_LIMIT = 8;
/** 随机候选池缓存时间。榜单变化很慢，60 秒足够，且避免每次点「随机」都打上游。 */
const RANDOM_TTL_MS = 60_000;
/** 随机池只有一个，缓存键固定。 */
const RANDOM_CACHE_KEY = 'default';
/**
 * 榜单比推荐流稳定，而且单榜实测需 557–879ms，缓存五分钟能显著减少切换榜单时的等待。
 */
const RANKING_TTL_MS = 5 * 60_000;
/** 目录只有一个版本，固定键避免没有意义的重复条目。 */
const RANKING_CATALOG_CACHE_KEY = 'default';

/** 搜索联想的响应体。 */
export interface SuggestResult {
  items: { text: string }[];
}

@Injectable()
export class CatalogService {
  /** 缓存键用 `cursor ?? 'first'`，避免 undefined 与字符串混淆。 */
  private readonly feedCache = new TtlCache<SeriesPage>(FEED_TTL_MS, 64);
  private readonly searchCache = new TtlCache<SeriesPage>(SEARCH_TTL_MS, 128);
  private readonly seriesCache = new TtlCache<SeriesDetail>(SERIES_TTL_MS, 64);
  private readonly suggestCache = new TtlCache<SuggestResult>(SUGGEST_TTL_MS, 128);
  /** 随机入口的候选池。上限 1：只有一个键，不需要淘汰。 */
  private readonly randomCache = new TtlCache<SeriesSummaryDto[]>(RANDOM_TTL_MS, 1);
  private readonly rankingCache = new TtlCache<RankingPageDto>(RANKING_TTL_MS, 32);
  private readonly rankingCatalogCache = new TtlCache<RankingCatalog>(RANKING_TTL_MS, 1);

  constructor(
    private readonly hongguo: HongguoService,
    private readonly mapper: CatalogMapper,
  ) {}

  async feed(cursor: string | undefined): Promise<SeriesPage> {
    const key = cacheKeyOf(cursor);
    return this.feedCache.get(key, async () => {
      const client = await this.hongguo.getClient();
      const page = await client.discover(cursor === undefined ? {} : { cursor });
      return this.toSeriesPage(page);
    });
  }

  /**
   * 搜索。
   *
   * **上游搜索接口不返回 `cover_url`**（实测 6/6 条都缺），所以结果全是空封面。
   * 用一次 `getSeriesBatch` 把封面补齐：单次请求、按顺序返回，代价可接受。
   *
   * 补封面失败时降级为无封面结果，不让整个搜索失败。
   */
  async search(keyword: string, cursor: string | undefined): Promise<SeriesPage> {
    // 先归一化：上游对全角标点很敏感（「长生，）」直接返回空结果）。归一化后为空
    // 说明输入全是标点/空白，直接给空页，不打上游也不进缓存。
    const normalized = normalizeSearchText(keyword);
    if (normalized === '') {
      return { items: [], cursor: null };
    }
    // 缓存键用归一化后的词，否则「长生，」与「长生」会各占一个条目。
    const key = cacheKeyOf(normalized, cursor);
    return this.searchCache.get(key, () => this.loadSearch(normalized, cursor));
  }

  /**
   * 搜索联想。
   *
   * 失败一律降级为空列表：联想是辅助功能，上游报错不该让用户看到错误，更不该
   * 阻塞搜索本身。catch 放在 `TtlCache.get` **外面**，失败就不落缓存——
   * 否则一次网络抖动会让这个前缀 30 秒内一直空着。
   *
   * 归一化后为空（例如刚输入一个全角逗号）同样直接返回空，不打上游。
   */
  async suggest(prefix: string): Promise<SuggestResult> {
    const normalized = normalizeSearchText(prefix);
    if (normalized === '') {
      return { items: [] };
    }
    return this.suggestCache
      .get(normalized, () => this.loadSuggest(normalized))
      .catch((error: unknown) => {
        // 只吞上游错误：联想失败不该阻塞搜索，返回空列表即可。
        // 其它异常（TypeError 等）是编程错误，吞掉会让 bug 静默成「永远没有联想」。
        if (error instanceof OpenhongguoError) {
          return { items: [] };
        }
        throw error;
      });
  }

  private async loadSuggest(prefix: string): Promise<SuggestResult> {
    const client = await this.hongguo.getClient();
    const suggestions = await client.suggest(prefix);
    return {
      items: suggestions
        .map((suggestion) => normalizeSearchText(suggestion.text))
        .filter((text) => text !== '')
        .slice(0, SUGGEST_LIMIT)
        .map((text) => ({ text })),
    };
  }

  private async loadSearch(keyword: string, cursor: string | undefined): Promise<SeriesPage> {
    const client = await this.hongguo.getClient();
    const page = await client.search(keyword, {
      pageSize: FEED_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });

    if (page.items.length === 0) {
      return this.toSeriesPage(page);
    }

    // 显式标注 `details` 的类型：SDK 的 `getSeriesBatch` 返回类型里有 `any`
    // 渗透（`SeriesDetail.series` 被推断成 any），不标注会触发
    // `no-unsafe-assignment` / `no-unsafe-member-access`。
    const enriched = await client
      .getSeriesBatch(page.items.map((item) => item.id))
      .then((details: UpstreamSeriesDetail[]) => new Map(details.map((detail) => [detail.series.id, detail.series])))
      .catch(() => new Map<string, SeriesSummary>());

    const merged = page.items.map((item) => {
      const full = enriched.get(item.id);
      if (full?.cover_url === undefined) {
        return item;
      }
      return { ...item, cover_url: full.cover_url };
    });

    return this.toSeriesPage({ ...page, items: merged });
  }

  /**
   * 随机取一部剧。
   *
   * 两个关键设计：
   *
   * 1. **缓存的是整个候选池，不是选中的那一条**。缓存结果会让「随机」在 60 秒内
   *    一直返回同一部剧——那就不叫随机了；缓存池子则每次请求都重新取样，同时
   *    每个 TTL 只打一次上游。
   * 2. **不用 `discover()`**。推荐流单次约 2.5 秒，而且是个性化流：同一用户短时间内
   *    反复进入会看到几乎相同的头部内容。排行榜是稳定榜单，一次请求就能拿到几十部
   *    互不重复的剧，更适合「随便看一部」。
   *
   * 池子为空时返回 `undefined`，由 controller 转成 404。
   */
  async random(): Promise<SeriesSummaryDto | undefined> {
    const pool = await this.randomCache.get(RANDOM_CACHE_KEY, () => this.loadRandomPool());
    if (pool.length === 0) {
      return undefined;
    }
    return pickRandom(pool);
  }

  /**
   * 拉取并整理随机候选池。
   *
   * 过滤交给 `toRandomCandidates`（纯函数，可单测）：榜单里混着演员行和推广重复行，
   * 不过滤会让前端跳到 `/series/undefined`。
   *
   * 转换走 `mapper.toSeriesSummary` 而不是手工拼 DTO：封面必须由它改写成
   * `/api/cover?u=` 白名单代理地址，**上游 CDN 直链绝不能返回给浏览器**。
   */
  private async loadRandomPool(): Promise<SeriesSummaryDto[]> {
    const client = await this.hongguo.getClient();
    const ranking = await client.shortRank();
    return toRandomCandidates(ranking.items).map((candidate) =>
      this.mapper.toSeriesSummary({
        id: candidate.seriesId,
        title: candidate.title,
        ...(candidate.coverUrl === undefined ? {} : { cover_url: candidate.coverUrl }),
        ...(candidate.episodeCount === undefined ? {} : { episode_count: candidate.episodeCount }),
      }),
    );
  }

  /**
   * 读取榜单目录。
   *
   * 上游没有「只取目录」接口，`shortRank()` 必然顺带返回一页榜单；目录请求只关心
   * `contents`，丢弃 `items` 比为无用数据建立额外响应契约更安全。
   */
  async rankingCatalog(): Promise<RankingCatalog> {
    return this.rankingCatalogCache.get(RANKING_CATALOG_CACHE_KEY, async () => {
      const client = await this.hongguo.getClient();
      const ranking = await client.shortRank();
      return {
        sections: ranking.contents.map((section) => ({
          id: section.id,
          name: section.name,
          boards: section.boards.map((board) => ({ id: board.id, name: board.name })),
        })),
      };
    });
  }

  async ranking(query: RankingQuery): Promise<RankingPageDto> {
    const key = cacheKeyOf(query.content, query.board, query.cursor);
    return this.rankingCache.get(key, async () => {
      const client = await this.hongguo.getClient();
      const options: ShortRankQuery = {
        ...(query.content === undefined ? {} : { content: query.content }),
        ...(query.board === undefined ? {} : { board: query.board }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      };
      const ranking = await client.shortRank(options);
      const entries = toRankingEntries(ranking.items).map((entry) => this.mapper.toRankingEntry(entry));
      const boardName = ranking.contents
        .find((section) => section.id === ranking.content)
        ?.boards.find((board) => board.id === ranking.board)?.name;

      return {
        entries,
        cursor: pickNextCursor(ranking.has_more, ranking.cursor),
        board: ranking.board,
        ...(boardName === undefined ? {} : { boardName }),
      };
    });
  }

  async series(seriesId: string): Promise<SeriesDetail> {
    return this.seriesCache.get(seriesId, async () => {
      const client = await this.hongguo.getClient();
      const [detail, episodes] = await Promise.all([client.getSeries(seriesId), this.allEpisodes(client, seriesId)]);
      return this.mapper.toSeriesDetail(detail, episodes);
    });
  }

  async episodes(seriesId: string): Promise<EpisodePage> {
    const client = await this.hongguo.getClient();
    const episodes = await this.allEpisodes(client, seriesId);
    return { items: episodes.map((episode) => this.mapper.toEpisode(episode)), cursor: null };
  }

  /**
   * 取一部剧的全部分集。
   *
   * 实测 78/117 集的剧一次就返回完（`has_more: false`），但长剧可能分页。
   * 上限 20 页是保护：真到 20 页说明数据异常，不如报错让人看到。
   */
  private async allEpisodes(client: Client, seriesId: string): Promise<Episode[]> {
    const collected: Episode[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result: Page<Episode> = await client.listEpisodes(seriesId, cursor === undefined ? {} : { cursor });
      collected.push(...result.items);
      const next = result.cursor;
      if (!result.has_more || next === undefined || next === '') {
        return collected;
      }
      cursor = next;
    }
    throw new Error(`series ${seriesId} exceeded 20 episode pages`);
  }

  private toSeriesPage(page: Page<SeriesSummary>): SeriesPage {
    const cursor = page.cursor;
    return {
      items: page.items.map((item) => this.mapper.toSeriesSummary(item)),
      cursor: page.has_more && cursor !== undefined && cursor !== '' ? cursor : null,
    };
  }
}
