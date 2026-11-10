import { useEffect } from 'react';
import { applyTheme, resolveTheme, useThemeStore } from './theme-store';

/**
 * 主题副作用：把 store 里的偏好同步到 `<html>`，并在 `system` 模式下监听
 * 系统配色变化。
 *
 * 为什么不用 `<html data-theme>` 的内联脚本做首屏防闪烁：本应用是 SPA，
 * 首屏 HTML 是空的 `<div id="root">`，没有内容会「先白后黑」。真正需要防的是
 * React 挂载到 store 水合之间的那一帧——这段用 `applyTheme` 在
 * `onRehydrateStorage` 里同步执行即可。
 */
export function useThemeEffect(): void {
  const mode = useThemeStore((state) => state.mode);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') {
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);
}

/** 当前实际生效的主题（`system` 会解析成 dark / light）。 */
export function useResolvedTheme(): 'dark' | 'light' {
  const mode = useThemeStore((state) => state.mode);
  return resolveTheme(mode);
}
