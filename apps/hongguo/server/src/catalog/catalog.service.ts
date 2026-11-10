import { Injectable } from '@nestjs/common';
import type { Client, Episode, Page, SeriesDetail as UpstreamSeriesDetail, SeriesSummary } from 'openhongguo';
import type { EpisodePage, SeriesDetail, SeriesPage } from '@mlzwl/hongguo-shared';
import { TtlCache } from '../common/ttl-cache.js';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { CatalogMapper } from './catalog.mapper.js';

/** 首页每页数量。 */
const FEED_PAGE_SIZE = 12;

/** 推荐流缓存时间。上游单次约 2.5 秒，推荐内容变化很慢。 */
const FEED_TTL_MS = 60_000;
/** 剧集详情缓存时间。分集列表基本不变。 */
const SERIES_TTL_MS = 5 * 60_000;
/** 搜索缓存时间。短一些，关键词结果可能调整。 */
const SEARCH_TTL_MS = 60_000;

@Injectable()
export class CatalogService {
  /** 缓存键用 `cursor ?? 'first'`，避免 undefined 与字符串混淆。 */
  private readonly feedCache = new TtlCache<SeriesPage>(FEED_TTL_MS, 64);
  private readonly searchCache = new TtlCache<SeriesPage>(SEARCH_TTL_MS, 128);
  private readonly seriesCache = new TtlCache<SeriesDetail>(SERIES_TTL_MS, 64);

  constructor(
    private readonly hongguo: HongguoService,
    private readonly mapper: CatalogMapper,
  ) {}

  async feed(cursor: string | undefined): Promise<SeriesPage> {
    const key = cursor ?? 'first';
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
    const key = `${keyword}\u0000${cursor ?? 'first'}`;
    return this.searchCache.get(key, () => this.loadSearch(keyword, cursor));
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
