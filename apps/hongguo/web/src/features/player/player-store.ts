import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PlayerState {
  /** 音量 0–1。 */
  volume: number;
  /** 是否静音。 */
  muted: boolean;
  /** 上次选择的倍速。 */
  speed: number;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setSpeed: (speed: number) => void;
}

/** 播放器偏好。键沿用上游的 volume 键，便于迁移。 */
export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      volume: 1,
      muted: false,
      speed: 1,
      setVolume: (volume) => set({ volume }),
      setMuted: (muted) => set({ muted }),
      setSpeed: (speed) => set({ speed }),
    }),
    { name: 'dsh-hongguo.watch-history.v1.volume' },
  ),
);
