import { Controller, Get, HttpException, HttpStatus, Param, Query } from '@nestjs/common';
import { OpenhongguoError } from 'openhongguo';
import {
  CursorQuerySchema,
  MAX_SEARCH_KEYWORD_LENGTH,
  RankingQuerySchema,
  SearchQuerySchema,
  type CursorQuery,
  type EpisodePage,
  type RankingCatalog,
  type RankingPage,
  type RankingQuery,
  type SearchQuery,
  type SeriesDetail,
  type SeriesPage,
  type SeriesSummary,
} from '@mlzwl/hongguo-shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CatalogService, type SuggestResult } from './catalog.service.js';

/**
 * 联想参数。
 *
 * 上限与正式搜索词共用 `MAX_SEARCH_KEYWORD_LENGTH`。之前这里单独写 64，
 * 导致 65–80 字符的输入能正式搜索、但同一输入触发的联想会 400。
 * 两个入口不能有两套上限。
 *
 * `trim()` 在前，所以纯空白会被当成空串拒绝。
 *
 * 不放进 `@mlzwl/hongguo-shared`：这个 schema 只有 server 用，web 侧不校验响应
 * （它拿到什么就展示什么），放 shared 只会让 web 多一份无用类型。
 * 常量本身从 shared 导入，避免两处各写一个数字。
 */
export const SuggestQuerySchema = z.object({
  prefix: z.string().trim().min(1).max(MAX_SEARCH_KEYWORD_LENGTH),
});
type SuggestQuery = z.output<typeof SuggestQuerySchema>;

@Controller('api')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('feed')
  feed(@Query(new ZodValidationPipe(CursorQuerySchema)) query: CursorQuery): Promise<SeriesPage> {
    return this.catalog.feed(query.cursor);
  }

  @Get('search')
  search(@Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery): Promise<SeriesPage> {
    return this.catalog.search(query.keyword, query.cursor);
  }

  /**
   * 搜索联想。
   *
   * 失败也返回 200 + 空列表（在 service 里降级）：联想失败不该阻塞搜索，也不该
   * 让用户看到错误提示。
   */
  @Get('suggest')
  suggest(@Query(new ZodValidationPipe(SuggestQuerySchema)) query: SuggestQuery): Promise<SuggestResult> {
    return this.catalog.suggest(query.prefix);
  }

  /** 上游目录与榜单页分开缓存，切换榜单不会重复读取稳定目录。 */
  @Get('ranking/catalog')
  rankingCatalog(): Promise<RankingCatalog> {
    return this.catalog.rankingCatalog();
  }

  /**
   * 一页榜单。
   *
   * `content` / `board` 是客户端可控的路径参数，而它们会被原样交给上游。
   * 实测（2026-11-12）：给一个不存在的 `board` 时上游抛
   * `OpenhongguoError` + `code: 'CONTENT_UNAVAILABLE'`，不处理就一路冒到 Nest
   * 的默认异常过滤器，变成 **500 Internal Server Error**。
   *
   * 这是错的：服务端没坏，是请求里的 `board` 不存在。500 会让前端把它当成
   * 「服务挂了」而走重试/报错路径，也不会告诉用户该换一个榜单。所以把这两个
   * 错误码映射成 400，并在错误体里带上 `code`，前端能区分「参数错」与「服务错」。
   *
   * 映射范围刻意很窄：只拦 `CONTENT_UNAVAILABLE` 与 `PARAM_INVALID`。限流、
   * 签名失败、传输错误仍然是 5xx——那些是真的需要重试的服务端问题。
   */
  @Get('ranking')
  async ranking(@Query(new ZodValidationPipe(RankingQuerySchema)) query: RankingQuery): Promise<RankingPage> {
    try {
      return await this.catalog.ranking(query);
    } catch (error: unknown) {
      if (
        error instanceof OpenhongguoError &&
        (error.code === 'CONTENT_UNAVAILABLE' || error.code === 'PARAM_INVALID')
      ) {
        throw new HttpException(
          { code: 'ranking_unavailable', message: '这个榜单暂时不可用，换一个试试' },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw error;
    }
  }

  /**
   * 随机一部剧。
   *
   * 没有可用候选时返回 **404 + `{ code, message }`**，而不是 200 + `null`：
   * 前端 `request()` 把 2xx 的响应体直接当成功值返回，`null` 会一路传到
   * `navigate('/series/null')`——一个能渲染、但永远播不了的详情页，而且没有任何
   * 错误提示。404 会变成 `ApiError`，前端能读 `code === 'no_random'` 给出文案。
   *
   * 错误体形状与其它错误一致（`{ code, message }`），前端不需要额外分支。
   *
   * 路由注册在 `series/:id` 之前：`random` 与 `series/:id` 不同前缀本来不会冲突，
   * 但把不带参数的路由写在前面可以避免以后新增 `/:id` 式路由时被误捕获。
   */
  @Get('random')
  async random(): Promise<SeriesSummary> {
    const series = await this.catalog.random();
    if (series === undefined) {
      throw new HttpException({ code: 'no_random', message: '排行榜暂时没有可用的剧集' }, HttpStatus.NOT_FOUND);
    }
    return series;
  }

  @Get('series/:id')
  series(@Param('id') id: string): Promise<SeriesDetail> {
    return this.catalog.series(id);
  }

  @Get('series/:id/episodes')
  episodes(@Param('id') id: string): Promise<EpisodePage> {
    return this.catalog.episodes(id);
  }
}
