import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface ProgressBarProps {
  /** 当前播放位置（秒）。 */
  current: number;
  /** 总时长（秒）。 */
  duration: number;
  /** 已缓冲到（秒）。 */
  buffered: number;
  /** 开始拖动。调用方据此锁住控件、暂停自动隐藏。 */
  onScrubStart: () => void;
  /** 拖动中。调用方更新预览位置，但不要 seek。 */
  onScrub: (seconds: number) => void;
  /** 结束拖动并 seek。 */
  onScrubEnd: (seconds: number) => void;
  /** 拖动时显示的预览元素，跟随滑块位置。 */
  renderPreview?: (seconds: number, ratio: number) => React.ReactNode;
  disabled?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 进度条。
 *
 * 不用 `<input type="range">`：它在移动端的触摸热区太窄，而且无法自定义拖动
 * 过程中的预览定位。这里用 Pointer Capture 自己实现，好处是：
 * 1. 手指拖出进度条范围后仍继续跟随（`setPointerCapture`）。
 * 2. 拖动期间能精确控制「不自动隐藏控件」。
 * 3. 预览图可以跟着滑块走，而不是固定居中。
 *
 * 所有 pointer 事件都 `stopPropagation`，避免被外层播放器手势当成滑动切集。
 */
export function ProgressBar({
  current,
  duration,
  buffered,
  onScrubStart,
  onScrub,
  onScrubEnd,
  renderPreview,
  disabled = false,
}: ProgressBarProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  /**
   * 鼠标悬停位置。`null` 表示没悬停。
   *
   * 用 pointerType 判断而不用 `@media (hover: hover)`：媒体查询在混合输入设备
   * （带触摸屏的笔记本）上不可靠，而 `pointerType === 'mouse'` 精确表示
   * “这次真的是鼠标”。触摸不会进入悬停流程，移动端不会多出多余预览。
   */
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  const value = drag ?? current;
  const ratio = duration > 0 ? clamp(value / duration, 0, 1) : 0;
  const bufferedRatio = duration > 0 ? clamp(buffered / duration, 0, 1) : 0;

  /** 预览位置：拖动优先，其次悬停。 */
  const previewSeconds = drag ?? hover;
  const previewRatio = previewSeconds === null ? 0 : duration > 0 ? clamp(previewSeconds / duration, 0, 1) : 0;

  /** 把指针横坐标换算成秒。 */
  const secondsAt = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (track === null || duration <= 0) {
        return 0;
      }
      const rect = track.getBoundingClientRect();
      const nextRatio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return nextRatio * duration;
    },
    [duration],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || duration <= 0) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    dragging.current = true;
    // 捕获指针：拖出轨道后仍继续跟随。某些浏览器对已失效的 pointerId
    // 会抛错，若不用 try/catch 包住，下面 setDrag 不执行，拖动就没预览。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 忽略：退化为只能在轨道内拖动。
    }
    const seconds = secondsAt(event.clientX);
    setDrag(seconds);
    onScrubStart();
    onScrub(seconds);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || duration <= 0) {
      return;
    }
    // 鼠标悬停预览。拖动中也走这里，避免拖出轨道后预览消失。
    if (event.pointerType === 'mouse') {
      setHover(secondsAt(event.clientX));
    }
    if (!dragging.current) {
      return;
    }
    event.stopPropagation();
    const seconds = secondsAt(event.clientX);
    setDrag(seconds);
    onScrub(seconds);
  };

  /** 鼠标离开轨道时收起预览。拖动中不收起，由 `finish` 处理。 */
  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragging.current) {
      return;
    }
    if (event.pointerType !== 'mouse') {
      return;
    }
    setHover(null);
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) {
      return;
    }
    event.stopPropagation();
    dragging.current = false;
    const seconds = secondsAt(event.clientX);
    setDrag(null);
    onScrubEnd(seconds);
  };

  const cancel = (): void => {
    if (!dragging.current) {
      return;
    }
    dragging.current = false;
    setDrag(null);
    onScrubEnd(value);
  };

  // 预览跟随滑块，但夹在 8%–92% 之间，避免贴边时被裁掉。
  const bubbleRatio = clamp(previewRatio, 0.08, 0.92);

  return (
    <div className="relative w-full">
      {previewSeconds !== null && renderPreview !== undefined && (
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-1"
          style={{ left: `${bubbleRatio * 100}%`, transform: 'translateX(-50%)' }}
        >
          {renderPreview(previewSeconds, bubbleRatio)}
        </div>
      )}

      {/* 外层给足触摸热区，内层才是可见的细条。 */}
      <div
        ref={trackRef}
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(value)}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onPointerLeave={onPointerLeave}
        className={`group relative flex h-11 touch-none items-center ${
          disabled ? 'cursor-default opacity-50' : 'cursor-pointer'
        }`}
      >
        <div className="relative h-1 w-full overflow-visible rounded-full bg-on-scrim/25 transition-all group-hover:h-1.5">
          {/* 已缓冲 */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-on-scrim/35"
            style={{ width: `${bufferedRatio * 100}%` }}
          />
          {/* 已播放 */}
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
          {/* 滑块 */}
          <div
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-on-scrim shadow transition-transform ${
              drag === null ? 'scale-0 group-hover:scale-100' : 'scale-125'
            }`}
            style={{ left: `${ratio * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
