import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './use-focus-trap';

export interface VolumeControlProps {
  /** 当前音量 0–1。 */
  value: number;
  /** 是否静音。 */
  muted: boolean;
  /** 拖动或点击时回调。 */
  onChange: (volume: number) => void;
  /** 切换静音。 */
  onToggleMute: () => void;
  /** 滑块展开状态变化，播放器据此暂停自动隐藏。 */
  onExpandedChange: (expanded: boolean) => void;
  /**
   * 是否渲染可拖动的滑块。
   *
   * 由**设备类型**决定，不由视口宽度决定。iOS（iPhone 与 iPad）的
   * `HTMLMediaElement.volume` 是只读的，拖动滑块不会改变音量。
   *
   * 早期实现用 `sm:block`（≥640px）控制显隐，在全屏横屏的手机上失效：
   * 横屏后宽度变成约 844px，滑块会重新出现，但依然拖不动。
   * 必须传设备能力，不能传宽度。
   */
  allowSlider: boolean;
}

/**
 * 音量控制：喇叭按钮 + 悬停/点击展开的滑块。
 *
 * **为什么只在桌面显示滑块**：iOS Safari 的 `HTMLMediaElement.volume` 是
 * 只读的（写进去不报错也不生效），移动端调音量只能按系统音量键。移动端
 * 保留静音按钮，滑块隐藏——给一个拖不动的滑块比不给更糟。
 *
 * **为什么悬停展开也要支持点击**：纯 hover 在触控板、平板、键盘用户那里
 * 不可达。点击展开对所有人有效，hover 只是桌面的额外便利。
 *
 * **键盘**：滑块展开后 Esc 收起、Tab 不会跑到弹层外面，收起时焦点回到喇叭按钮。
 * 这些行为由 `useFocusTrap` 统一提供，与选集抽屉、倍速菜单一致。
 */
export function VolumeControl({
  value,
  muted,
  onChange,
  onToggleMute,
  onExpandedChange,
  allowSlider,
}: VolumeControlProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setExpandedBoth = useCallback(
    (next: boolean) => {
      setExpanded(next);
      onExpandedChange(next);
    },
    [onExpandedChange],
  );

  useEffect(
    () => () => {
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current);
      }
    },
    [],
  );

  const open = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (!expanded) {
      setExpandedBoth(true);
    }
  }, [expanded, setExpandedBoth]);

  /** 延迟收起，留出从按钮移到滑块的移动时间。 */
  const closeSoon = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
    }
    hideTimer.current = setTimeout(() => {
      setExpandedBoth(false);
    }, 260);
  }, [setExpandedBoth]);

  const level = muted ? 0 : value;
  const label = muted || value === 0 ? '取消静音' : '静音';

  // 滑块展开时才抢焦点：收起状态下容器里只剩一个喇叭按钮，拦 Tab 会打断页面导航。
  useFocusTrap(containerRef, { onClose: () => setExpandedBoth(false), enabled: expanded && allowSlider });

  return (
    <div
      ref={containerRef}
      className="relative flex items-center"
      onPointerEnter={(event) => {
        // 只在鼠标上展开；触屏 hover 事件不可靠。
        if (event.pointerType === 'mouse') {
          open();
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          closeSoon();
        }
      }}
    >
      <button
        type="button"
        onClick={onToggleMute}
        aria-label={label}
        className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-on-scrim transition-colors hover:bg-on-scrim/15 active:bg-on-scrim/20"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
          {/* 喇叭主体 */}
          <path d="M4 9v6h4l5 4V5L8 9H4z" strokeLinecap="round" strokeLinejoin="round" />
          {level === 0 ? (
            /* 静音：一个叉 */
            <path d="M17 9l4 6M21 9l-4 6" strokeLinecap="round" />
          ) : (
            /* 有声：两道弧线，音量低时只画一道 */
            <>
              <path d="M16.5 8.5a5 5 0 010 7" strokeLinecap="round" />
              {level > 0.5 && <path d="M19 6a8.5 8.5 0 010 12" strokeLinecap="round" />}
            </>
          )}
        </svg>
      </button>

      {/*
        滑块容器用宽度过渡而不是 `display` 切换：`display` 无法过渡，
        展开时会「跳」一下。`w-0 → w-24` 有 200ms 的连续变化。

        不支持写音量的设备（iOS）**根本不渲染**滑块，而不是渲染后隐藏：
        渲染出来再 `w-0` 会让它在无障碍树里留下一个「音量」滑块，
        屏幕阅读器用户可以聚焦到一个完全无效的控件。
      */}
      {allowSlider && (
        <div
          className={`overflow-hidden transition-[width,opacity] duration-200 ${
            expanded ? 'w-24 opacity-100' : 'w-0 opacity-0'
          }`}
        >
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(level * 100)}
            onChange={(event) => {
              onChange(Number(event.currentTarget.value) / 100);
              open();
            }}
            onPointerDown={open}
            aria-label="音量"
            className="volume-range mx-2 h-1 w-20 cursor-pointer appearance-none rounded-full bg-on-scrim/25 outline-none"
            style={{
              // 已播放部分用实心白，未播放部分用半透明，与进度条一致。
              background: `linear-gradient(to right, var(--color-on-scrim) ${level * 100}%, color-mix(in oklab, var(--color-on-scrim) 25%, transparent) ${level * 100}%)`,
            }}
          />
        </div>
      )}
    </div>
  );
}
