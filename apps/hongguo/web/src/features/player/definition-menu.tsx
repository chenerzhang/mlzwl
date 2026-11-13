import { useEffect, useRef } from 'react';
import { CheckIcon } from '../../components/icons';
import { useFocusTrap } from './use-focus-trap';

/**
 * 清晰度选择弹层。
 *
 * 结构对齐 `SpeedMenu`：`role="menu"` + `role="menuitemradio"` + `aria-checked`，
 * 点外部关闭、Esc 关闭、打开时聚焦当前档位、关闭后焦点归还触发按钮。
 *
 * 与 `SpeedMenu` 的唯一结构差异是**不写死档位**：档位来自服务端的
 * `Playback.availableDefinitions`，上游随时可能加档。写死分辨率列表会让新档位
 * 静默消失。
 */
export interface DefinitionMenuProps {
  /** 可用档位，顺序即服务端给的低→高。 */
  available: readonly string[];
  /** 当前档位；不在列表里时没有任何一项被选中。 */
  value: string | undefined;
  /** 选择档位。 */
  onSelect: (definition: string) => void;
  /** 关闭菜单。 */
  onClose: () => void;
  /**
   * 触发按钮。点击它不算「点外部」。
   *
   * 否则会出现「关掉又立刻打开」：`pointerdown` 先触发外部关闭，紧接着按钮自己的
   * `click` 又把菜单 toggle 成打开。用户看到的是菜单关不掉。
   */
  anchor?: React.RefObject<HTMLElement | null>;
}

/**
 * 档位文案。
 *
 * `unknown` 是服务端在上游没给 `definition` 时的映射值，直接显示「未知」比
 * 显示英文原值可读。其余标签（`1080p` 等）原样展示：它们本身就是通用写法。
 */
function labelOf(definition: string): string {
  return definition === 'unknown' ? '未知' : definition;
}

export function DefinitionMenu({
  available,
  value,
  onSelect,
  onClose,
  anchor,
}: DefinitionMenuProps): React.JSX.Element {
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
      // 触发按钮自己会 toggle，这里不能再关一次，否则两次状态更新互相抵消。
      const trigger = anchor?.current;
      if (trigger !== null && trigger !== undefined && event.target instanceof Node && trigger.contains(event.target)) {
        return;
      }
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [anchor, onClose]);

  // Esc 关闭 + Tab 循环 + 关闭后焦点归还触发按钮。
  useFocusTrap(ref, { onClose });

  // 打开时把焦点放到当前档位。没有选中项时放到第一项，键盘用户仍能直接上下选。
  useEffect(() => {
    if (activeRef.current !== null) {
      activeRef.current.focus();
      return;
    }
    const first = ref.current?.querySelector('button');
    if (first instanceof HTMLElement) {
      first.focus();
    }
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="清晰度"
      className="absolute bottom-full left-0 mb-2 w-24 overflow-hidden rounded-xl border border-on-scrim/20 bg-scrim/95 py-1 shadow-2xl"
    >
      {available.map((definition) => {
        const active = definition === value;
        return (
          <button
            key={definition}
            ref={active ? activeRef : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => {
              onSelect(definition);
              onClose();
            }}
            className={`flex h-9 w-full items-center justify-between px-3 text-xs tabular-nums transition-colors ${
              active ? 'text-on-scrim' : 'text-on-scrim-muted'
            } hover:bg-on-scrim/15`}
          >
            <span className="truncate">{labelOf(definition)}</span>
            {active && <CheckIcon className="h-3.5 w-3.5" />}
          </button>
        );
      })}
    </div>
  );
}
