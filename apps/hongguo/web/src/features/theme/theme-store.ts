import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'hongguo.theme.v1';

/**
 * 两套主题的页面底色。
 *
 * 必须与 `styles/index.css` 的 `--color-surface` 逐字节一致：
 * - `theme-color` 供浏览器在移动端给地址栏/状态栏着色，取值只能是字面量，
 *   不能引用 CSS 变量。
 * - 值不一致时浏览器画的色带会和页面底色差一档，表现为屏幕边缘一条错色边。
 *
 * 不使用 `:root` 的 `--color-surface` 反查：Tailwind 4 把 `@theme` 变量发在
 * `:root` 上，但 `[data-theme='light']` 的覆盖也在同一层级，`getComputedStyle`
 * 读到的值依赖注入顺序，不如写死两个常量可靠。
 */
export const THEME_SURFACE: Record<'dark' | 'light', string> = {
  dark: '#08080a',
  light: '#f5f5f7',
};

/** 解析出实际要用的主题。`system` 时读系统偏好。 */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') {
    return mode;
  }
  if (typeof window === 'undefined') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * 把主题写到 `<html data-theme>`，同时同步 `color-scheme` 让滚动条等原生控件跟随。
 *
 * 同时改 `<meta name="theme-color">`：浏览器用它给移动端地址栏/状态栏着色，
 * 不跟随就会在浅色主题下继续涂深色。App 内的 WebView 不读这个 meta（系统栏由
 * `MainActivity.applyStatusBarAppearance()` 管），所以这条只影响浏览器访问。
 *
 * `index.html` 里有两份带 `media` 的 `theme-color`（分别对应系统浅色/深色），
 * 供首屏在 JS 执行前用。这里把**两份都**改成解析后的值：用户手动选的主题
 * 优先级高于系统，此时 `media` 不应再参与判断；只改一份的话另一份仍会命中。
 */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.dataset['theme'] = resolved;
  root.style.colorScheme = resolved;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((meta) => {
    meta.setAttribute('content', THEME_SURFACE[resolved]);
  });
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** 在 dark / light 之间来回切。`system` 时切到与当前显示相反的那一套。 */
  toggle: () => void;
}

/**
 * 主题偏好。
 *
 * 三态而不是两态：`system` 是首屏默认值，跟随操作系统；用户一旦手动切换就
 * 记成明确的 dark / light，不再被系统变化影响。
 *
 * 持久化到 localStorage，`onRehydrateStorage` 里立刻 `applyTheme`，
 * 避免「先渲染深色再跳浅色」的闪烁。
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      setMode: (mode) => {
        applyTheme(mode);
        set({ mode });
      },
      toggle: () => {
        const current = resolveTheme(get().mode);
        get().setMode(current === 'dark' ? 'light' : 'dark');
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ mode: state.mode }),
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.mode ?? 'system');
      },
    },
  ),
);
