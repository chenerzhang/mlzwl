import { Injectable } from '@nestjs/common';
import type { Episode, Series, SeriesSummary } from 'openhongguo';
import type { Episode as EpisodeDto, SeriesDetail, SeriesSummary as SeriesSummaryDto } from '@mlzwl/hongguo-shared';
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

  toSeriesSummary(source: SeriesSummary): SeriesSummaryDto {
    return {
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...(source.cover_url === undefined ? {} : { coverUrl: this.covers.proxyUrl(source.cover_url) }),
      ...(source.episode_count === undefined ? {} : { episodeCount: source.episode_count }),
      ...(source.author === undefined ? {} : { author: source.author }),
      ...(source.category === undefined ? {} : { category: source.category }),
    };
  }

  toEpisode(source: Episode): EpisodeDto {
    return {
      id: source.id,
      seriesId: source.series_id,
      number: source.number,
      ...(source.title === undefined ? {} : { title: source.title }),
      playable: source.playable,
      ...(source.cover_url === undefined ? {} : { coverUrl: this.covers.proxyUrl(source.cover_url) }),
      ...(source.comment_count === undefined ? {} : { commentCount: source.comment_count }),
      ...(source.digg_count === undefined ? {} : { diggCount: source.digg_count }),
    };
  }

  toSeriesDetail(source: Series, episodes: Episode[]): SeriesDetail {
    return {
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...(source.cover_url === undefined ? {} : { coverUrl: this.covers.proxyUrl(source.cover_url) }),
      ...(source.episode_count === undefined ? {} : { episodeCount: source.episode_count }),
      episodes: episodes.map((episode) => this.toEpisode(episode)),
    };
  }
}
