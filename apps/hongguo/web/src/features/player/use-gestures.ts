import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** 手势判定结果。 */
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export interface GestureHandlers {
  onSwipe?: (direction: SwipeDirection) => void;
  /** 单击。双击场景下会延迟到确认非双击后才触发。 */
  onTap?: () => void;
  onDoubleTap?: () => void;
  onLongPressStart?: () => void;
  onLongPressEnd?: () => void;
}

/** 位移超过 60px 且明显偏某一轴，才算滑动。 */
const SWIPE_THRESHOLD = 60;
/** 超过这个位移就取消长按判定，否则拖动会被当成「按住不放」。 */
const LONG_PRESS_CANCEL_DISTANCE = 12;
const LONG_PRESS_MS = 350;
const DOUBLE_TAP_MS = 240;

/** 按下时命中的元素若属于这些选择器，就不进入手势流程，交给原生点击。 */
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="slider"], [data-no-gesture]';

/**
 * 判断事件目标是否落在交互控件内。
 *
 * 从 `target` 一路向上找到手势容器，任意一层命中交互选择器就返回 true。
 * 这是「按钮点不动」的根因修复：手势容器若接管了 `pointerdown`，后续
 * `pointerup` 会被重定向，浏览器就不会在按钮上派发 `click`。
 */
function isInteractive(target: EventTarget | null, container: HTMLElement): boolean {
  let node: Node | null = target instanceof Node ? target : null;
  while (node !== null && node !== container) {
    if (node instanceof Element && node.matches(INTERACTIVE_SELECTOR)) {
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

/**
 * 短剧播放器手势。
 *
 * 单击与双击天然冲突：单击要立刻响应，双击又要等第二次点击。这里把单击
 * **延迟到双击判定窗口结束**（240ms），换取双击可靠。误判成双击会让人莫名
 * 暂停，代价大于 240ms 的延迟感。
 *
 * ## 两条关键约束
 *
 * **一、交互控件必须能正常点击。**
 * 早期实现在 `pointerdown` 时立刻 `setPointerCapture`，结果浏览器把后续
 * `pointerup` 也发给容器，`click` 就不再派发到按钮上——实测返回、上一集、
 * 下一集、静音、倍速、选集全部失效。现在的做法是：
 * 1. 按下的目标在交互控件内 → 整段手势直接跳过，不捕获、不启定时器。
 * 2. 指针捕获**延迟到长按真正成立时**才调用，此时用户已按住 350ms，
 *    不可能是想点按钮。
 *
 * **二、长按必须能可靠结束。**
 * 指针拖出窗口后浏览器不再派发 `pointerup`，长按状态就永远不结束——实测
 * 表现为「2 倍速卡住不恢复」。所以长按成立时立刻捕获指针，让后续事件
 * 一定回到容器；另外补 `lostpointercapture`、窗口级 `pointerup` /
 * `pointercancel` / `blur` 四重兜底，全部指向幂等的 `endLongPress()`。
 */
export function useGestures(handlers: GestureHandlers): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
} {
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** 当前手势的 pointerId，长按成立时用来捕获指针。 */
  const activePointer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最近一次手势容器，供窗口级兜底判断。 */
  const containerRef = useRef<HTMLElement | null>(null);

  // 用 ref 存 handlers，避免每次渲染重建回调导致事件抖动。
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  /** 结束长按并恢复调用方的状态。幂等。 */
  const endLongPress = useCallback(() => {
    if (longPressed.current) {
      longPressed.current = false;
      handlersRef.current.onLongPressEnd?.();
    }
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const clearTap = useCallback(() => {
    if (tapTimer.current !== null) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
    }
  }, []);

  /** 释放指针捕获，失败时忽略（pointerId 可能已失效）。 */
  const releaseCapture = useCallback(() => {
    const container = containerRef.current;
    const pointerId = activePointer.current;
    if (container === null || pointerId === null) {
      return;
    }
    try {
      if (container.hasPointerCapture(pointerId)) {
        container.releasePointerCapture(pointerId);
      }
    } catch {
      // 忽略：指针已释放。
    }
  }, []);

  /**
   * 兜底：窗口级 `pointerup` / `pointercancel` / `blur`。
   *
   * 指针捕获通常已覆盖，但 iOS Safari 在某些情况下会跳过捕获元素上的事件。
   * 这里再挂一层，确保长按状态一定结束。
   */
  useEffect(() => {
    const finish = (): void => {
      if (origin.current === null && !longPressed.current) {
        return;
      }
      clearLongPress();
      endLongPress();
      releaseCapture();
      origin.current = null;
      activePointer.current = null;
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
    };
  }, [clearLongPress, endLongPress, releaseCapture]);

  useEffect(
    () => () => {
      clearLongPress();
      clearTap();
    },
    [clearLongPress, clearTap],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    containerRef.current = event.currentTarget;

    // 按在按钮 / 滑块 / 输入框上：完全让路，不捕获、不启定时器。
    // 这是「播放页按钮点不动」的根因修复。
    if (isInteractive(event.target, event.currentTarget)) {
      origin.current = null;
      activePointer.current = null;
      return;
    }

    origin.current = { x: event.clientX, y: event.clientY };
    activePointer.current = event.pointerId;
    longPressed.current = false;
    clearLongPress();

    longPressTimer.current = setTimeout(() => {
      longPressed.current = true;
      // 长按已成立，此刻才捕获指针：保证拖出窗口也能收到 pointerup。
      const container = containerRef.current;
      const pointerId = activePointer.current;
      if (container !== null && pointerId !== null) {
        try {
          container.setPointerCapture(pointerId);
        } catch {
          // 忽略：某些浏览器对已释放的 pointerId 会抛错。
        }
      }
      handlersRef.current.onLongPressStart?.();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const start = origin.current;
    if (start === null) {
      return;
    }
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    // 一旦移动就说明不是长按，立刻取消，避免滑动时误触发倍速。
    if (distance > LONG_PRESS_CANCEL_DISTANCE && !longPressed.current) {
      clearLongPress();
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    clearLongPress();
    const start = origin.current;
    const pointerId = activePointer.current;
    origin.current = null;
    activePointer.current = null;

    // 长按中松手：先结束长按，再释放捕获。
    if (longPressed.current) {
      endLongPress();
      const container = containerRef.current;
      if (container !== null && pointerId !== null) {
        try {
          if (container.hasPointerCapture(pointerId)) {
            container.releasePointerCapture(pointerId);
          }
        } catch {
          // 忽略。
        }
      }
      return;
    }

    if (start === null) {
      return;
    }

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absY > SWIPE_THRESHOLD && absY > absX * 1.2) {
      handlersRef.current.onSwipe?.(dy < 0 ? 'up' : 'down');
      return;
    }
    if (absX > SWIPE_THRESHOLD && absX > absY * 1.2) {
      handlersRef.current.onSwipe?.(dx < 0 ? 'left' : 'right');
      return;
    }

    // 已有待确认的单击 → 这是双击。
    if (tapTimer.current !== null) {
      clearTap();
      handlersRef.current.onDoubleTap?.();
      return;
    }

    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      handlersRef.current.onTap?.();
    }, DOUBLE_TAP_MS);
  };

  const onPointerCancel = (): void => {
    clearLongPress();
    endLongPress();
    releaseCapture();
    origin.current = null;
    activePointer.current = null;
  };

  const onLostPointerCapture = (): void => {
    // 捕获意外丢失时同样要结束长按，否则倍速会一直停在 2 倍。
    clearLongPress();
    endLongPress();
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture };
}
