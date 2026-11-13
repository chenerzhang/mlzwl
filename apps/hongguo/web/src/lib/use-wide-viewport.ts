import { useSyncExternalStore } from 'react';

/**
 * 视口断点。
 *
 * 640px 与项目 Tailwind 的 `sm` 断点一致，避免为 feed 再建立一套响应式语义。
 */
const WIDE_QUERY = '(min-width: 640px)';

/**
 * 复用的 `MediaQueryList`。
 *
 * 惰性创建一次：`subscribe` 与 `getSnapshot` 必须读同一个对象。分别
 * `window.matchMedia()` 会拿到两个独立实例，虽然 `matches` 值相同，但语义上
 * 快照来源与订阅来源不一致，以后若换成有状态的实现就会出错。
 */
let mediaQuery: MediaQueryList | null = null;

function getMediaQuery(): MediaQueryList {
  mediaQuery ??= window.matchMedia(WIDE_QUERY);
  return mediaQuery;
}

/**
 * 订阅断点变化。
 *
 * **为什么同时监听 `resize`**：`matchMedia` 的 `change` 事件在部分环境不可靠。
 * 实测 Playwright 的 `setViewportSize` 把视口从 1440 改成 393 后，`matches`
 * 已经是 `false`，但 `change` 监听器一次都没触发；连 `resize` 计数也是 0。
 * 这是 `Emulation.setDeviceMetricsOverride` 的行为，不是浏览器常态。
 * 真实浏览器拖动窗口会同时派发 `resize` 与 `change`，两条路径都订阅比只订阅
 * 一条更稳，成本是一个监听器。
 *
 * 重复触发无副作用：`getSnapshot` 是幂等读取，React 比对返回值不变就不重渲染。
 *
 * `subscribe` 必须是稳定引用，否则每次渲染都重新订阅，所以定义在组件外。
 */
function subscribe(onChange: () => void): () => void {
  const query = getMediaQuery();
  query.addEventListener('change', onChange);
  window.addEventListener('resize', onChange);
  return () => {
    query.removeEventListener('change', onChange);
    window.removeEventListener('resize', onChange);
  };
}

function getSnapshot(): boolean {
  return getMediaQuery().matches;
}

/**
 * 服务端渲染快照。
 *
 * 本项目是纯客户端 SPA，没有 SSR 路径，这个函数不会被调用。但
 * `useSyncExternalStore` 在 hydration 时要求它存在，缺失会直接报错，
 * 所以显式给出「按窄视口处理」的保守值。
 */
function getServerSnapshot(): boolean {
  return false;
}

/** 当前视口是否达到宽屏断点（>= 640px）。 */
export function useWideViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
