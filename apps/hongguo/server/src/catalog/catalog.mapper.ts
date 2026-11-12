import { Injectable } from '@nestjs/common';
import type { Episode, Series, SeriesSummary } from 'openhongguo';
import type {
  Episode as EpisodeDto,
  RankingEntry,
  SeriesDetail,
  SeriesSummary as SeriesSummaryDto,
} from '@mlzwl/hongguo-shared';
import type { RankingRow } from './ranking-rows.js';
import { CoverProxyService } from '../cover/cover-proxy.service.js';

/**
 * 上游模型 → 自有契约。
 *
 * 上游的字段全是可选的松散 JSON，对外要收紧成明确类型。封面统一改写成自有
 * 代理地址，浏览器不接触上游 CDN。
 */
@Injectable()
export class CatalogMapper {
  constructor(private readonly covers: CoverProxyService) {}

  /**
   * 把上游封面地址改写成代理地址；拿不到可用的代理地址时返回空对象。
   *
   * `proxyUrl` 在上游地址过长时会返回 `undefined`（生成的令牌会超过 Fastify
   * `maxParamLength`）。这里统一收成「省略 `coverUrl`」，让四个映射方法不必各写
   * 一遍判空——写四遍最容易在新增字段时漏掉一处，漏掉那处就会发出一个 414 地址。
   */
  private cover(source: string | undefined): { coverUrl?: string } {
    if (source === undefined) {
      return {};
    }
    const url = this.covers.proxyUrl(source);
    return url === undefined ? {} : { coverUrl: url };
  }

  toSeriesSummary(source: SeriesSummary): SeriesSummaryDto {
    return {
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...this.cover(source.cover_url),
      ...(source.episode_count === undefined ? {} : { episodeCount: source.episode_count }),
      ...(source.author === undefined ? {} : { author: source.author }),
      ...(source.category === undefined ? {} : { category: source.category }),
    };
  }

  /**
   * 榜单封面也必须经过统一代理边界；让 service 手工改 URL 容易在新增字段时漏出 CDN 直链。
   */
  toRankingEntry(source: RankingRow): RankingEntry {
    return {
      position: source.position,
      seriesId: source.seriesId,
      title: source.title,
      ...this.cover(source.coverUrl),
      ...(source.episodeCount === undefined ? {} : { episodeCount: source.episodeCount }),
      ...(source.score === undefined ? {} : { score: source.score }),
      ...(source.promoted === undefined ? {} : { promoted: source.promoted }),
    };
  }

  toEpisode(source: Episode): EpisodeDto {
    return {
      id: source.id,
      seriesId: source.series_id,
      number: source.number,
      ...(source.title === undefined ? {} : { title: source.title }),
      playable: source.playable,
      ...this.cover(source.cover_url),
      ...(source.comment_count === undefined ? {} : { commentCount: source.comment_count }),
      ...(source.digg_count === undefined ? {} : { diggCount: source.digg_count }),
    };
  }

  toSeriesDetail(source: Series, episodes: Episode[]): SeriesDetail {
    return {
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...this.cover(source.cover_url),
      ...(source.episode_count === undefined ? {} : { episodeCount: source.episode_count }),
      episodes: episodes.map((episode) => this.toEpisode(episode)),
    };
  }
}
