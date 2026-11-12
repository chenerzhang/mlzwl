import { useEffect, useRef } from 'react';
import { useFocusTrap } from './use-focus-trap';

/**
 * 可选倍速。
 *
 * 上限放到 3×：短剧单集通常 1–3 分钟，用户扫剧时经常想再快一档。
 * 2× 封顶会把「已经很熟、只想确认剧情」的场景挡在门外。
 * 3× 对 HEVC 解码没有额外压力——播放器只改 `playbackRate`，不解码更多帧。
 */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export type Speed = (typeof SPEEDS)[number];

export interface SpeedMenuProps {
  /** 当前倍速。 */
  value: number;
  /** 选择倍速。 */
  onSelect: (speed: number) => void;
  /** 关闭菜单。 */
  onClose: () => void;
}

/**
 * 倍速选择弹层。
 *
 * 为什么不是「点一下循环切换」：6–7 个档位循环点击要按 5 次才能从 1× 到 3×，
 * 而且看不到有哪些档位。主流播放器（YouTube / Bilibili / Netflix）都是
 * 点开列表直接选。
 *
 * 交互细节：
 * - `role="menu"` + `role="menuitemradio"` + `aria-checked`，屏幕阅读器能读出
 *   当前选中项，而不是只读一串数字。
 * - 点击外部关闭、Esc 关闭。Esc 与 Tab 循环由 `useFocusTrap` 统一处理，
 *   关闭后焦点回到触发按钮。
 * - 打开时把焦点移到当前档位，键盘用户不需要再 Tab 一遍。
 * - 向上弹出（`bottom-full`），因为按钮在屏幕底部。
 */
export function SpeedMenu({ value, onSelect, onClose }: SpeedMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // 点外部关闭。用 `pointerdown` 而不是 `click`：点击瞬间就关，不用等抬起。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = ref.current;
      if (node === null) {
        return;
      }
      if (event.target instanceof Node && node.contains(event.target)) {
        return;
      }
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  // Esc 关闭 + Tab 循环 + 关闭后焦点归还触发按钮。
  useFocusTrap(ref, { onClose });

  // 打开时把焦点放到当前档位，键盘用户可以直接上下选。
  // `useFocusTrap` 只在焦点已经进入容器后才拦 Tab / Esc，所以这一步是陷阱生效的前提。
  useEffect(() => {
    activeRef.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="播放速度"
      className="absolute bottom-full left-0 mb-2 w-28 overflow-hidden rounded-xl border border-on-scrim/20 bg-scrim/95 py-1 shadow-2xl"
    >
      {SPEEDS.map((speed) => {
        const active = speed === value;
        return (
          <button
            key={speed}
            ref={active ? activeRef : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => {
              onSelect(speed);
              onClose();
            }}
            className={`flex h-9 w-full items-center justify-between px-3 text-xs tabular-nums transition-colors ${
              active ? 'text-on-scrim' : 'text-on-scrim-muted'
            } hover:bg-on-scrim/15`}
          >
            <span>{speed === 1 ? '正常' : `${speed}×`}</span>
            {active && (
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
