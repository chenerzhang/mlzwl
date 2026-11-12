import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLocalStorageWriteQueue, createQueuedPersistStorage } from '../../lib/write-queue';
import { isValidDefinitionLabel } from './definition-selection';

/** 允许的倍速白名单。`<video>.playbackRate` 只接受这几个值。 */
export const SPEED_VALUES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** 落盘的播放偏好。 */
export interface PlayerPreferences {
  volume: number;
  muted: boolean;
  speed: number;
  /**
   * 上次选择的清晰度标签（例如 `1080p`）。
   *
   * `undefined` 表示没有偏好，让服务端自动挑档。换集时优先用它，
   * 但它不存在于新一集的可用档位时必须回退，不能硬发。
   */
  definition?: string;
  /**
   * 下载专用清晰度。
   *
   * 与播放档位**分开存**：用户常常想「在线看低档省流量、下载留最高档」，
   * 绑在一起会让他每次下载都要手动改回来。
   *
   * `undefined` 表示「没选过」，下载时取可用档位里的最高档。
   */
  downloadDefinition?: string;
}

const DEFAULT_PREFERENCES: PlayerPreferences = { volume: 1, muted: false, speed: 1 };

export interface VideoVolumePreference {
  muted: boolean;
  volume?: number;
}

/** 把持久化偏好映射成当前平台允许写入的 `<video>` 属性。 */
export function applyVolumePreference(
  preference: Pick<PlayerPreferences, 'volume' | 'muted'>,
  canSetVolume: boolean,
): VideoVolumePreference {
  const volume = Number.isFinite(preference.volume) ? Math.min(Math.max(preference.volume, 0), 1) : 1;
  const result: VideoVolumePreference = { muted: preference.muted || volume === 0 };
  if (canSetVolume) {
    result.volume = volume;
  }
  return result;
}

interface PlayerState extends PlayerPreferences {
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setSpeed: (speed: number) => void;
  setDefinition: (definition: string | undefined) => void;
  setDownloadDefinition: (definition: string | undefined) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 音量必须是 `[0, 1]` 内的有限数。`NaN` / `Infinity` 都会落到默认值。 */
function sanitizeVolume(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return DEFAULT_PREFERENCES.volume;
  }
  return raw;
}

/**
 * 倍速按白名单严格比对，不容忍浮点漂移。
 *
 * 存档里的 `1.0001` 或字符串 `"abc"` 都不是合法倍速，必须回 1，否则会被直接塞给
 * `video.playbackRate`（P1-11）。
 */
function sanitizeSpeed(raw: unknown): number {
  for (const value of SPEED_VALUES) {
    if (raw === value) {
      return value;
    }
  }
  return DEFAULT_PREFERENCES.speed;
}

/**
 * 校验落盘的播放偏好。
 *
 * 逐字段校验而不是整体丢弃：某一项被改坏时，其余合法的偏好仍然保留。
 * 非对象输入（`null`、数组、字符串）只能全用默认值。
 */
export function sanitizePlayerPreferences(raw: unknown): PlayerPreferences {
  if (!isRecord(raw)) {
    return { ...DEFAULT_PREFERENCES };
  }
  const result: PlayerPreferences = {
    volume: sanitizeVolume(raw['volume']),
    muted: typeof raw['muted'] === 'boolean' ? raw['muted'] : DEFAULT_PREFERENCES.muted,
    speed: sanitizeSpeed(raw['speed']),
  };
  const definition = sanitizeDefinition(raw['definition']);
  if (definition !== undefined) {
    result.definition = definition;
  }
  const downloadDefinition = sanitizeDefinition(raw['downloadDefinition']);
  if (downloadDefinition !== undefined) {
    result.downloadDefinition = downloadDefinition;
  }
  return result;
}

/**
 * 清晰度标签的合法性判定。
 *
 * 只要求「非空字符串且不含控制字符」。不写死分辨率白名单：上游随时可能加档，
 * 写死会让新档位静默消失。长度上限 32 与 `definition-selection` 保持一致。
 */
export function sanitizeDefinition(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const label = raw.trim();
  return isValidDefinitionLabel(label) ? label : undefined;
}

/** 音量、倍速的合法性判定，`set*` 与 `sanitize*` 共用同一份规则。 */
function isValidVolume(volume: number): boolean {
  return sanitizeVolume(volume) === volume;
}

function isValidSpeed(speed: number): boolean {
  return sanitizeSpeed(speed) === speed;
}

const playerQueue = createLocalStorageWriteQueue();

// 同 `history-store`：`pagehide` 与 `visibilitychange` 都要**同步**落盘，
// 异步 `flush()` 的微任务在 bfcache 冻结或进程被终止时不保证执行。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    playerQueue.flushSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      playerQueue.flushSync();
    }
  });
}

/** 播放器偏好。键沿用上游的 volume 键，便于迁移。 */
export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setVolume: (volume) => {
        if (!isValidVolume(volume)) {
          return;
        }
        set({ volume });
      },
      setMuted: (muted) => set({ muted }),
      setSpeed: (speed) => {
        if (!isValidSpeed(speed)) {
          return;
        }
        set({ speed });
      },
      setDownloadDefinition: (definition) => {
        const label = sanitizeDefinition(definition);
        if (label === undefined) {
          set((state) => {
            const { downloadDefinition: _removed, ...rest } = state;
            return rest as PlayerState;
          }, true);
          return;
        }
        set({ downloadDefinition: label });
      },
      setDefinition: (definition) => {
        const label = sanitizeDefinition(definition);
        // `undefined` 是合法输入：它表示「回到自动」，必须能清掉旧偏好。
        // `exactOptionalPropertyTypes` 下不能写 `{ definition: undefined }`，
        // 用函数式 set 显式删除键。
        if (label === undefined) {
          // 必须用 `replace: true`：zustand 默认**合并**，返回一个不含
          // `definition` 的对象不会删掉旧值，只会保留它。
          set((state) => {
            const { definition: _removed, ...rest } = state;
            return rest as PlayerState;
          }, true);
          return;
        }
        set({ definition: label });
      },
    }),
    {
      name: 'dsh-hongguo.watch-history.v1.volume',
      version: 1,
      storage: createQueuedPersistStorage<PlayerPreferences>(playerQueue),
      // 旧存档没有版本号（version 0），统一走一遍校验，把坏数据清掉。
      migrate: (persistedState) => sanitizePlayerPreferences(persistedState),
      // 水合时不信任存档里的类型：即便版本号匹配也要过一遍校验。
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...sanitizePlayerPreferences(persistedState),
      }),
    },
  ),
);
