import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'hongguo.theme.v1';

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

/** 把主题写到 `<html data-theme>`，同时同步 `color-scheme` 让滚动条等原生控件跟随。 */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.dataset['theme'] = resolved;
  root.style.colorScheme = resolved;
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
