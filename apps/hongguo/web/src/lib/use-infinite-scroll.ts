import { useEffect, useRef, useState } from 'react';

export interface InfiniteScrollOptions {
  /** 是否还有下一页。 */
  hasNextPage: boolean;
  /** 是否正在取下一页。 */
  isFetchingNextPage: boolean;
  /** 触发取下一页。 */
  fetchNextPage: () => void;
  /**
   * 距离底部多少像素时开始预取。默认 200px——约四分之一屏。
   *
   * 这个值不能太大。实测每页只增加约 340px 高度；若设为 800px，加载完一页
   * 哨兵仍在预取范围内，就会一直链式请求下去（实测拉了几十页）。
   * 200px 既能提前取，又能在内容撑满屏幕后自然停下。
   */
  rootMargin?: number;
  /**
   * 是否启用。
   *
   * 除了搜索页「还没输入关键词」这类场景，也承担「外部状态唤醒判定」的职责：
   * 判定 effect 依赖 `enabled`，所以调用方把影响判定结果的外部状态合进这个
   * 布尔值，状态翻转时就能唤醒一次判定。不要另加 `recheckKey` 之类的通道。
   */
  enabled?: boolean;
}

/** 两次触发之间的最小间隔，避免快速滚动时连环请求。 */
const COOLDOWN_MS = 700;

/**
 * 冷却到期后的重试间隔。
 *
 * 冷却不能「直接 return」就算完：大屏上首屏内容填不满视口时，哨兵永远在
 * 视口内，但 `IntersectionObserver` 只在**状态变化**时回调，不会因为冷却到期
 * 再叫一次。用户也无法滚动（`scrollHeight === clientHeight`），于是永远卡在
 * 15 张卡上。这里在冷却期间预约一次重查，保证「哨兵仍在视口内 + 冷却已过」
 * 这个条件能被重新评估。
 */
const RETRY_MS = 250;

/**
 * 滚动到底自动加载。
 *
 * 用 `IntersectionObserver` 而不是 `scroll` 事件：前者由浏览器在合成线程
 * 计算，不触发主线程重排，滚动更稳。
 *
 * **两段式设计**：observer 只记录「哨兵是否在视口内」，是否发请求由单独的
 * effect 判断。因为 `IntersectionObserver` 只在进入/离开时回调一次——如果
 * 挂载时首屏数据还没回来（`hasNextPage` 为 false），只靠回调永远不会再触发。
 * 拆开后，`hasNextPage` 由 false 变 true 时也能立刻补发。
 *
 * **所有回调都走 ref**。`fetchNextPage` 常写成内联箭头函数，每次渲染都是
 * 新引用；若放进依赖数组，effect 会在每次渲染后重跑，只要哨兵在视口内就
 * 立刻再发一次请求——这是链式无限加载的根因。依赖数组里只保留真正决定
 * 「该不该发」的布尔值和 tick。
 *
 * 防抖分三层：
 * 1. observer 只在状态变化时回调，不是每帧。
 * 2. `isFetchingNextPage` 挡住并发请求。
 * 3. `COOLDOWN_MS` 限制最小间隔。
 */
export function useInfiniteScroll<T extends HTMLElement = HTMLDivElement>({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  rootMargin = 200,
  enabled = true,
}: InfiniteScrollOptions): React.RefObject<T | null> {
  const sentinelRef = useRef<T>(null);
  /** 计数器：observer 报告「进入视口」时自增，用来触发下面的判定 effect。 */
  const [tick, setTick] = useState(0);
  /** 哨兵当前是否在（扩展后的）视口内。 */
  const intersecting = useRef(false);
  const lastTriggeredAt = useRef(0);

  const fetchRef = useRef(fetchNextPage);
  fetchRef.current = fetchNextPage;

  useEffect(() => {
    const node = sentinelRef.current;
    if (node === null) {
      return;
    }

    intersecting.current = false;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined) {
          return;
        }
        intersecting.current = entry.isIntersecting;
        if (entry.isIntersecting) {
          setTick((value) => value + 1);
        }
      },
      { rootMargin: `0px 0px ${rootMargin}px 0px`, threshold: 0 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  // 依赖里只有布尔量和 tick，不含回调函数，所以不会因重渲染而重复触发。
  useEffect(() => {
    // 显式返回 `undefined`，与其他分支的 cleanup 函数保持同一返回类型。
    if (!enabled) {
      return undefined;
    }
    if (!hasNextPage) {
      return undefined;
    }
    if (isFetchingNextPage) {
      return undefined;
    }
    if (!intersecting.current) {
      return undefined;
    }

    const now = Date.now();
    const wait = COOLDOWN_MS - (now - lastTriggeredAt.current);
    if (wait > 0) {
      // 冷却中：预约一次重查，而不是直接放弃。否则大屏上再也没有事件叫醒它。
      const timer = setTimeout(() => setTick((value) => value + 1), wait + RETRY_MS);
      return () => clearTimeout(timer);
    }

    lastTriggeredAt.current = now;
    fetchRef.current();
    return undefined;
  }, [enabled, hasNextPage, isFetchingNextPage, tick]);

  return sentinelRef;
}
