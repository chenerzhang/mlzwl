import { useEffect, useRef, useState } from 'react';

/**
 * 会让页面向下滚动的按键。
 *
 * 空格配合 Shift 是「向上翻页」，必须排除，否则反向操作也会授权翻页。
 */
const DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End', ' ']);

/** 触摸方向判定的最小位移。小于这个值视为点击，不算滚动意图。 */
const TOUCH_THRESHOLD_PX = 8;

/**
 * 滚轮手势的静默窗口。
 *
 * 触控板一次滑动会连续派发几十个 `wheel`。用「最后一个 wheel 之后静默这么久
 * 算手势结束」来切分手势，而不是每个 wheel 事件都当成一次新意图。
 */
const WHEEL_IDLE_MS = 400;

/**
 * 这些元素上的按键属于操作控件，不是滚动页面。
 *
 * 典型反例：焦点在顶栏「随机看一部」按钮上时按空格，语义是点击按钮，
 * 不是往下翻。若不排除，超高视口下会在用户点按钮的同时把推荐流推进一档。
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
].join(',');

/** 判断键盘事件的落点是否是交互控件。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

export interface ScrollIntent {
  /** 当前是否存在一个「用户想继续往下看」的未消费意图。 */
  readonly pending: boolean;
  /** 消费意图。翻页成功后调用，避免一次手势触发多档翻页。 */
  consume: () => void;
}

/**
 * 跟踪「用户是否表达过向下滚动意图」，并让这个意图可以被消费。
 *
 * **为什么需要这个**：`IntersectionObserver` 只回答「哨兵现在是否可见」，不区分：
 * 1. 用户滚到底，哨兵进入视口 → 应该翻页；
 * 2. 页面刚加载，第一页内容填不满视口，哨兵从一开始就在视口内 → 不该翻页。
 *
 * 实测踩到第 2 种：视口 1440×2400 时 18 条填不满，哨兵常驻视口，补页被反复
 * 推进到 54 条、11 次请求，违反「PC 18 条」的契约。
 *
 * **为什么是「可消费的门闩 + 独立手势锁」**：
 * - 只有 `pending` 一个令牌不够。真实手势会产生**多个**事件（触控板连续 wheel、
 *   手指连续 touchmove、长按重复 keydown）。第一次翻页后 `consume()` 清掉令牌，
 *   同一个手势的下一个事件又会重新授权，一次滑动就能把 `visibleCount` 推到
 *   36、54。所以另设 `gestureLocked`：手势开始时锁住，结束时才解锁，锁住期间
 *   无论消费多少次都不会重新授权。
 * - 手势结束的判定按输入类型区分：触摸看 `touchend`/`touchcancel`，键盘看
 *   `keyup`，滚轮看静默窗口（没有明确的结束事件）。
 *
 * **为什么用 state 而不是 ref**：令牌翻转要能唤醒 `useInfiniteScroll` 的判定
 * effect。那个 effect 的依赖只有布尔量与 tick，ref 变化不会触发重跑。用
 * `boolean` state 且只在 `false → true` 时 set，同一手势内的重复事件不会重复渲染。
 *
 * **方向判定**：只认「向下」。向上滚轮、向上触摸、Shift+Space、焦点在按钮上的
 * 空格都是反向或非滚动操作，不该授权翻页。内容不足一屏时 `scroll` 事件根本
 * 不会派发，所以必须靠 `wheel` / `touchmove` / `keydown` 兜住这些场景。
 */
export function useScrollIntent(): ScrollIntent {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  /** 当前手势是否已经授权过。手势结束前不再授权。 */
  const gestureLocked = useRef(false);
  /** 上一次滚动位置，用来判断滚动方向。放 ref 里，避免多实例共享。 */
  const lastScrollY = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastScrollY.current = window.scrollY;

    const grant = (): void => {
      if (gestureLocked.current) {
        return;
      }
      gestureLocked.current = true;
      // 幂等：已有未消费的令牌就不再 setState，避免手势过程中反复渲染。
      if (pendingRef.current) {
        return;
      }
      pendingRef.current = true;
      setPending(true);
    };

    const onScroll = (): void => {
      const current = window.scrollY;
      const movedDown = current > lastScrollY.current;
      lastScrollY.current = current;
      if (movedDown) {
        grant();
      }
    };

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY <= 0) {
        return;
      }
      grant();
      // 滚轮没有结束事件：以静默窗口切分手势。滑动期间的重复事件不会因为
      // 锁已生效而延长窗口，所以窗口从最后一次有效 wheel 起算。
      if (wheelTimer.current !== null) {
        clearTimeout(wheelTimer.current);
      }
      wheelTimer.current = setTimeout(() => {
        wheelTimer.current = null;
        gestureLocked.current = false;
      }, WHEEL_IDLE_MS);
    };

    /** 当前触摸手势的起始 Y。只在单指手势下有意义。 */
    let touchStartY = 0;
    let touchActive = false;

    const onTouchStart = (event: TouchEvent): void => {
      // 多指（夹捏缩放等）不是滚动意图，直接放弃这次手势。
      if (event.touches.length !== 1) {
        touchActive = false;
        gestureLocked.current = false;
        return;
      }
      touchStartY = event.touches[0]?.clientY ?? 0;
      touchActive = true;
      gestureLocked.current = false;
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (!touchActive || event.touches.length !== 1) {
        return;
      }
      const currentY = event.touches[0]?.clientY ?? touchStartY;
      // 手指向上移动 = 内容向下滚动。
      if (touchStartY - currentY > TOUCH_THRESHOLD_PX) {
        grant();
      }
    };

    const onTouchEnd = (): void => {
      touchActive = false;
      gestureLocked.current = false;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      // 已由页面/控件处理的按键不再当作滚动意图。
      if (event.defaultPrevented) {
        return;
      }
      // 焦点在按钮等控件上时，空格与方向键是在操作控件。
      if (isInteractiveTarget(event.target)) {
        return;
      }
      // 长按产生的重复事件属于同一个手势，不重复授权。
      if (event.repeat) {
        return;
      }
      if (event.key === ' ' && event.shiftKey) {
        return;
      }
      if (DOWN_KEYS.has(event.key)) {
        grant();
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (DOWN_KEYS.has(event.key)) {
        gestureLocked.current = false;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      if (wheelTimer.current !== null) {
        clearTimeout(wheelTimer.current);
        wheelTimer.current = null;
      }
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  return {
    pending,
    consume: () => {
      if (!pendingRef.current) {
        return;
      }
      pendingRef.current = false;
      setPending(false);
      // 注意：这里**不**解锁 gestureLocked。解锁由手势结束事件负责，
      // 否则同一手势的下一个事件会重新授权，一次滑动翻多档。
    },
  };
}
