import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { OpenhongguoError, type ErrorCode } from 'openhongguo';
import {
  MAX_SEARCH_KEYWORD_LENGTH,
  SearchQuerySchema,
  type RankingPage,
  type SeriesSummary,
} from '@mlzwl/hongguo-shared';
import { CatalogController, SuggestQuerySchema } from './catalog.controller.js';
import type { CatalogService } from './catalog.service.js';

/**
 * `GET /api/random` 的 HTTP 层契约（P2-5）。
 *
 * service 层测试已经覆盖了「池子为空时返回 `undefined`」，但真正决定前端行为的
 * 是 controller 把它转成什么。两条必须守住：
 * 1. 空池 → **404 + `{ code: 'no_random' }`**，不是 200 + `null`。
 * 2. 有候选 → 原样返回 `SeriesSummary`，不再包一层。
 *
 * 只构造 controller、把 service 换成桩：不启 Nest 容器，不发网络请求。
 */

const SERIES: SeriesSummary = { id: 's1', title: '长生', coverUrl: '/api/cover/opaque-token' };

/**
 * 造一个上游错误。
 *
 * SDK 的 `.d.ts` **没有声明构造函数参数**，所以类型上继承 `Error` 的
 * `(message?, options?)`；但运行时实现接受一个对象
 * `{ code, message, retryable, retryAfterMs }`。声明与实现不一致，只能用断言构造。
 *
 * 不用 `new OpenhongguoError('x')` 再改 `code`：`code` 在类型上是 `readonly`。
 */
function makeUpstreamError(code: ErrorCode): OpenhongguoError {
  const Ctor = OpenhongguoError as unknown as new (init: { code: ErrorCode; message: string }) => OpenhongguoError;
  return new Ctor({ code, message: code });
}

/** 只实现 `random()` 的 `CatalogService` 桩。 */
function makeController(random: () => Promise<SeriesSummary | undefined>): CatalogController {
  return new CatalogController({ random } as unknown as CatalogService);
}

describe('CatalogController.ranking', () => {
  it('passes a ranking page through unchanged', async () => {
    const page: RankingPage = {
      entries: [{ position: 1, seriesId: 's1', title: '长生', score: '8835万热度' }],
      cursor: 'next',
      board: 'hot',
      boardName: '热播榜',
    };
    const controller = new CatalogController({ ranking: () => Promise.resolve(page) } as unknown as CatalogService);

    await expect(controller.ranking({ board: 'hot' })).resolves.toBe(page);
  });

  it('returns an empty ranking page without turning it into 404', async () => {
    const page: RankingPage = { entries: [], cursor: null, board: 'hot' };
    const controller = new CatalogController({ ranking: () => Promise.resolve(page) } as unknown as CatalogService);

    await expect(controller.ranking({ board: 'hot' })).resolves.toEqual(page);
  });

  /**
   * 不存在的 `board` 必须是 400，不能是 500。
   *
   * 实测（2026-11-12）：给一个不存在的 board 时上游抛 `CONTENT_UNAVAILABLE`，
   * 不拦就是 500，前端会把它当成「服务挂了」。这条用例锁住映射关系。
   */
  it('maps an unknown board to 400 instead of leaking a 500', async () => {
    const controller = new CatalogController({
      ranking: () => Promise.reject(makeUpstreamError('CONTENT_UNAVAILABLE')),
    } as unknown as CatalogService);

    const error = await controller.ranking({ board: 'nope' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((error as HttpException).getResponse()).toEqual({
      code: 'ranking_unavailable',
      message: '这个榜单暂时不可用，换一个试试',
    });
  });

  /** 限流是真需要重试的服务端问题，不能被误降成 400。 */
  it('keeps a rate-limit error as a 5xx path', async () => {
    const original = makeUpstreamError('RATE_LIMITED');
    const controller = new CatalogController({
      ranking: () => Promise.reject(original),
    } as unknown as CatalogService);

    await expect(controller.ranking({ board: 'hot' })).rejects.toBe(original);
  });
});

describe('CatalogController.random', () => {
  it('returns the series when the pool has a candidate', async () => {
    const controller = makeController(() => Promise.resolve(SERIES));
    await expect(controller.random()).resolves.toBe(SERIES);
  });

  it('throws 404 with code no_random when the pool is empty', async () => {
    const controller = makeController(() => Promise.resolve(undefined));

    // 不能用 `resolves`：这里必须断言抛的是带正确状态码与错误体的 HttpException。
    // 前端 `request()` 靠 `status` 判失败、靠 `code` 选文案，两者都不能少。
    const error = await controller.random().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.getResponse()).toEqual({
      code: 'no_random',
      message: '排行榜暂时没有可用的剧集',
    });
  });

  it('does not return 200 with a null body for an empty pool', async () => {
    // 回归护栏：`null` 会一路传到 `navigate('/series/null')`，渲染一个永远
    // 播不了的详情页且没有任何错误提示。
    const controller = makeController(() => Promise.resolve(undefined));
    await expect(controller.random()).rejects.toBeInstanceOf(HttpException);
  });
});

/**
 * 联想接口与正式搜索必须共用同一个长度上限。
 *
 * 回归护栏：`SearchQuerySchema` 用 80、联想用 64 时，65–80 字符的输入能正式搜索，
 * 但同一输入触发的联想稳定 400。前端会静默降级，所以这个不一致不会报错，
 * 只会让联想功能在那段长度区间里永久失效。
 *
 * 直接测 schema 而不是走 controller：Zod 校验在 `ZodValidationPipe` 里，
 * 直接调 controller 方法不会经过管道，测不到上限。
 */
describe('suggest query length contract', () => {
  it('uses the same keyword limit as search', () => {
    expect(SuggestQuerySchema.safeParse({ prefix: 'a'.repeat(MAX_SEARCH_KEYWORD_LENGTH) }).success).toBe(true);
    expect(SuggestQuerySchema.safeParse({ prefix: 'a'.repeat(MAX_SEARCH_KEYWORD_LENGTH + 1) }).success).toBe(false);
  });

  it('matches the search schema boundary exactly', () => {
    const atLimit = { keyword: 'a'.repeat(MAX_SEARCH_KEYWORD_LENGTH) };
    const overLimit = { keyword: 'a'.repeat(MAX_SEARCH_KEYWORD_LENGTH + 1) };
    expect(SearchQuerySchema.safeParse(atLimit).success).toBe(true);
    expect(SearchQuerySchema.safeParse(overLimit).success).toBe(false);
  });
});
