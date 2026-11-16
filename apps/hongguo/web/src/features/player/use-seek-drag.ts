import { useCallback, useRef, useState } from 'react';
import { judgeSeekDrag, type SeekDragVerdict } from './seek-drag';

export interface SeekDragState {
  /** 拖动中的目标时间（秒）；`null` 表示没在拖。 */
  time: number | null;
  /** 相对起拖位置的偏移（秒）。 */
  delta: number;
}

export interface SeekDragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}

/** 按下时命中这些元素就不进入拖动：滑块、按钮等自己有交互语义。 */
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="slider"], [data-no-gesture]';

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

export interface UseSeekDragOptions {
  /** 当前播放位置（秒）。起拖时冻结成基准。 */
  currentTime: number;
  /** 总时长（秒）。未知传 0。 */
  duration: number;
  /** 松手时提交。 */
  onSeek: (seconds: number) => void;
  /** 拖动开始/结束时通知调用方（用来锁控件、暂停等）。 */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** 是否禁用（例如全屏切换过程中）。 */
  disabled?: boolean;
}

/**
 * 横向拖动调进度。
 *
 * ## 为什么不塞进 `useGestures`
 *
 * `useGestures` 的模型是「松手时一次性判定」：上滑/下滑/左滑/右滑都在
 * `pointerup` 才分派。进度拖动必须在 `pointermove` 期间持续更新目标时间，
 * 否则用户看不到任何反馈，只能盲拖到松手才知道跳到哪。
 *
 * 两者共用同一个 `pointerdown`。分工靠**方向锁定**：横向位移超过门槛且明显
 * 偏横时，本 hook 接管；否则它一声不响，`useGestures` 照常处理纵向上/下滑
 * 切集和单击。
 *
 * ## 为什么不抢指针捕获
 *
 * 一旦 `setPointerCapture`，后续 `pointerup` 就只回到容器，`useGestures` 的
 * 窗口级兜底和按钮的 `click` 都会受影响。这里只在**确认进入拖动之后**才捕获，
 * 那时用户已经横向拖了 24px，不可能是想点按钮。
 */
export function useSeekDrag(options: UseSeekDragOptions): {
  state: SeekDragState;
  handlers: SeekDragHandlers;
} {
  const { currentTime, duration, onSeek, onDragStart, onDragEnd, disabled = false } = options;

  const [state, setState] = useState<SeekDragState>({ time: null, delta: 0 });

  /** 起拖基准。`null` 表示当前没有按下。 */
  const origin = useRef<{ x: number; y: number; time: number } | null>(null);
  /** 已确认进入拖动状态。 */
  const dragging = useRef(false);
  const activePointer = useRef<number | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  /**
   * 用 ref 存最新回调。
   *
   * `pointermove` 每秒触发几十次，若回调进依赖数组，hook 每次渲染都要重建
   * 四个 handler，父组件的 `useEffect` 依赖会跟着抖动。
   */
  const latest = useRef({ currentTime, duration, onSeek, onDragStart, onDragEnd });
  latest.current = { currentTime, duration, onSeek, onDragStart, onDragEnd };

  const reset = useCallback(() => {
    const container = containerRef.current;
    const pointerId = activePointer.current;
    if (container !== null && pointerId !== null) {
      try {
        if (container.hasPointerCapture(pointerId)) {
          container.releasePointerCapture(pointerId);
        }
      } catch {
        // 忽略：指针可能已释放。
      }
    }
    origin.current = null;
    activePointer.current = null;
    dragging.current = false;
    setState({ time: null, delta: 0 });
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (disabled) {
        return;
      }
      containerRef.current = event.currentTarget;
      if (isInteractive(event.target, event.currentTarget)) {
        origin.current = null;
        return;
      }
      origin.current = { x: event.clientX, y: event.clientY, time: latest.current.currentTime };
      activePointer.current = event.pointerId;
      dragging.current = false;
    },
    [disabled],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const start = origin.current;
    if (start === null) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (!dragging.current) {
      const verdict: SeekDragVerdict = judgeSeekDrag({
        startTime: start.time,
        dx,
        dy,
        duration: latest.current.duration,
      });
      if (verdict.kind === 'ignore') {
        return;
      }
      if (verdict.kind === 'pending') {
        // 偏纵向：让给 `useGestures` 的切集手势，本 hook 整段退出。
        origin.current = null;
        activePointer.current = null;
        return;
      }
      dragging.current = true;
      latest.current.onDragStart?.();
      const container = containerRef.current;
      const pointerId = activePointer.current;
      if (container !== null && pointerId !== null) {
        try {
          container.setPointerCapture(pointerId);
        } catch {
          // 忽略：部分浏览器对已释放的 pointerId 会抛错。
        }
      }
      setState({ time: verdict.time, delta: verdict.time - start.time });
      return;
    }

    const verdict = judgeSeekDrag({
      startTime: start.time,
      dx,
      dy,
      duration: latest.current.duration,
    });
    if (verdict.kind !== 'seek') {
      return;
    }
    setState({ time: verdict.time, delta: verdict.time - start.time });
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const start = origin.current;
      if (start === null || !dragging.current) {
        origin.current = null;
        activePointer.current = null;
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const verdict = judgeSeekDrag({
        startTime: start.time,
        dx,
        dy,
        duration: latest.current.duration,
      });
      reset();
      latest.current.onDragEnd?.();
      if (verdict.kind === 'seek') {
        latest.current.onSeek(verdict.time);
      }
    },
    [reset],
  );

  const onPointerCancel = useCallback((): void => {
    if (dragging.current) {
      reset();
      latest.current.onDragEnd?.();
    } else {
      origin.current = null;
      activePointer.current = null;
    }
  }, [reset]);

  return {
    state,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
