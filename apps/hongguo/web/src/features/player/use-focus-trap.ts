import { useEffect, useRef, type RefObject } from 'react';

export interface FocusTrapOptions {
  /** Esc 时调用。 */
  onClose: () => void;
  /** 是否启用，默认 true。 */
  enabled?: boolean;
}

/** 可聚焦元素的选取范围。`[tabindex="-1"]` 排除掉只用于编程聚焦的元素。 */
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * 容器内当前可聚焦的元素。
 *
 * 每次 Tab 时重新计算，不缓存：选集抽屉里切换分组后按钮会整批替换，缓存下来
 * 会把焦点还给已经从文档里移除的节点，Tab 就再也动不了。
 *
 * `disabled` 用属性判断而不是 `:disabled`：选择器里的 `:disabled` 只匹配表单控件，
 * 对 `<div tabindex="0">` 这类自定义控件无效。`getClientRects().length === 0` 用来
 * 过滤 `display: none` 与折叠起来的元素（`offsetParent` 在 `position: fixed` 的
 * 祖先下会误判，`getClientRects` 不会）。
 */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return [...nodes].filter((node) => !node.hasAttribute('disabled') && node.getClientRects().length > 0);
}

/**
 * 把 Tab 循环限制在 `ref` 容器内，Esc 时调 `onClose`，卸载时把焦点还给打开前的元素。
 *
 * 三个弹层（选集抽屉、倍速菜单、音量滑块）共用同一套键盘约定，抽出来是为了避免
 * 每个弹层各写一遍还各自漏一条：Esc 关闭、Tab 循环、焦点归还。
 *
 * 只挂 `keydown`，不挂 `focusin`：`focusin` 会在用户点页面其他地方时也把焦点抢回来，
 * 而抽屉背后是可以点的（遮罩自己就是关闭按钮）。
 *
 * **Tab 只在焦点已经在容器内时接管**。音量滑块是 hover 展开的，鼠标划过就抢走整个
 * 页面的 Tab 导航比不拦更糟。弹层要进入陷阱，得自己先把焦点移进来（选集抽屉与倍速
 * 菜单都在打开时做了这件事）。
 *
 * **Esc 不受此限制**：菜单开着、Esc 就该关——包括鼠标划过展开的音量滑块，那时刻
 * 焦点还在别处。也是选集抽屉原本的行为（之前是一个 window 级 keydown）。
 *
 * `onClose` 存在 ref 里而不是放进依赖数组：调用方普遍传内联箭头函数，放进依赖会让
 * 每次重渲染都拆掉重装一次监听，卸妆时还会把焦点还给触发按钮——菜单还开着，焦点
 * 却已经跳回去了。
 *
 * import 期不访问 `window` / `document`，全部在 `useEffect` 里读，模块才能在 Node
 * 里被单测直接 import 而不炸。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, options: FocusTrapOptions): void {
  const { onClose, enabled = true } = options;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const container = ref.current;
    if (container === null) {
      return;
    }
    const previouslyFocused = document.activeElement;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const active = document.activeElement;
      const inside = active === container || (active !== null && container.contains(active));
      if (!inside) {
        return;
      }
      const items = focusableWithin(container);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        // 容器里没有任何可聚焦元素：把 Tab 拦下来，焦点不会跑到背景页面上。
        event.preventDefault();
        return;
      }
      if (event.shiftKey) {
        // 容器自己拿到焦点（`tabindex="-1"` 的面板）时也当作首元素，否则
        // Shift+Tab 会直接跳回背景页面。
        if (active === first || active === container) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // 焦点还给触发元素。`isConnected` 过滤掉「打开弹层的按钮已经不在文档里」
      // 的情况（例如切集后整个播放器重新挂载），那时 focus 会静默失败。
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [ref, enabled]);
}
