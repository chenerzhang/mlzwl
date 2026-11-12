import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpriteMeta } from '@mlzwl/hongguo-shared';
import { formatDuration } from '../../lib/format';
import {
  describePlaybackError,
  isStalled,
  probePlaybackError,
  type PlaybackErrorAction,
  type PlaybackErrorHint,
} from './playback-error';
import { applyVolumePreference, usePlayerStore } from './player-store';
import { ProgressBar } from './progress-bar';
import { SpritePreview } from './sprite-preview';
import { SpeedMenu } from './speed-menu';
import { VolumeControl } from './volume-control';
import { toRanges, type TimeRange } from './buffered-ranges';
import { judgePointerMotion, type ScreenPoint } from './pointer-motion';
import { isLocked, withLock, withoutLock, type LockSource } from './controls-lock';
import { isExpired, objectFitFor, remainingMs, sleepDeadlineMinutes, type FrameMode } from './frame-mode';
import { bindingFor, handleShortcut, normalizeKey, type ShortcutContext } from './shortcuts';
import { enterIosNativeFullscreen, useFullscreen } from './use-fullscreen';
import { useGestures } from './use-gestures';

export interface PlayerProps {
  /** 视频地址，指向本服务的 `/api/media/:episodeId`。 */
  src: string;
  poster?: string;
  /** 起始播放位置（秒），用于续播。 */
  initialTime?: number;
  /** 雪碧图信息；没有时不显示缩略预览。 */
  sprite?: { meta: SpriteMeta; sheetUrls: string[] };
  title?: string;
  /** 集号，显示在标题旁。 */
  episodeLabel?: string;
  /** 播放结束回调，用于自动切下一集。 */
  onEnded?: () => void;
  /** 点击「选集」按钮。 */
  onOpenEpisodes?: () => void;
  /** 上滑：切下一集。 */
  onNextEpisode?: () => void;
  /** 下滑：切上一集。 */
  onPrevEpisode?: () => void;
  /** 是否还有上一集。桌面端按钮据此显隐。 */
  canPrev?: boolean;
  /** 是否还有下一集。 */
  canNext?: boolean;
  /**
   * 进度回调（秒），用于保存观看记录与预热下一集。
   *
   * 第三个参数是当前倍速：预热要按墙钟时间判断剩余时长，2 倍速下 60 秒的剩余
   * 片长只剩 30 秒真实等待。
   */
  onProgress?: (position: number, duration: number, speed: number) => void;
}

/** 控件自动隐藏的延迟。拖动或长按期间不隐藏。 */
const HIDE_DELAY_MS = 3200;

/**
 * 焦点还在控件内时，复查一次「能不能隐藏」的间隔。
 *
 * 比 `HIDE_DELAY_MS` 短得多：这段时间里控件本来就该保持显示，不需要再等完整的
 * 3.2 秒才反应；但也别短到变成忙等——1 秒一次对定时器开销可以忽略。
 */
const FOCUS_HOLD_RECHECK_MS = 1000;

/** 停滞检测的采样周期。2 秒一次：比 20 秒窗口细得多，又不会每帧读 DOM。 */
const STALL_POLL_MS = 2_000;

/** 画幅模式的三档与显示文案。 */
const FRAME_MODES: readonly { mode: FrameMode; label: string }[] = [
  { mode: 'contain', label: '适应' },
  { mode: 'cover', label: '裁剪' },
  { mode: 'fill', label: '拉伸' },
];

/** 睡眠定时器档位（分钟）。关闭不在列表里：已设置时按钮会变成倒计时兼取消。 */
const SLEEP_MINUTES: readonly number[] = [1, 15, 30, 60];

/**
 * 停滞分支写的两条文案。
 *
 * 提成常量是为了让「进度恢复时清空提示」能精确判定来源：只有停滞分支写的文案
 * 才能被清掉，`onError` 造成的真实错误（黑屏、解码失败）必须留在屏幕上。
 */
const STALL_RELOAD_MESSAGE = '播放停滞，正在自动重新加载';
const STALL_MESSAGE = '播放停滞';

/** 播放错误覆盖层的内容。`action` 决定显示哪个按钮。 */
interface PlayerErrorState {
  message: string;
  action: Exclude<PlaybackErrorAction, 'switch-definition'>;
}

/**
 * 把纯逻辑层的 hint 转成组件状态。
 *
 * `switch-definition` 在这里降级成 `none`：当前播放器没有清晰度切换 UI（切档要回到
 * 播放信息查询、换 `src`、重新下载），为一个错误提示新造一套切换控件不划算。
 * 文案本身已经写着「建议换一档清晰度」，用户可以从选集/重进页面自行换档。
 */
function toErrorState(hint: PlaybackErrorHint): PlayerErrorState {
  return { message: hint.message, action: hint.action === 'switch-definition' ? 'none' : hint.action };
}

/**
 * 容器内是否还有处于 `:focus-visible` 的元素。
 *
 * 两种「没有」都要显式处理：容器未挂载时可选链给出 `undefined`，`querySelector`
 * 没有匹配时返回 `null`。写成 `!container.querySelector(...)` 也能跑，但真值反转
 * 把「没挂载」「没匹配」混成同一个假值，读的人要反推两层含义；显式比较更清楚。
 *
 * 必须包 `try/catch`：`:focus-visible` 在部分旧浏览器的选择器引擎里不合法，
 * `querySelector` 会抛 `SyntaxError` 而不是返回 `null`。此时降级为「没有焦点」，
 * 走正常隐藏分支——控件永远不隐藏比少隐藏一次糟糕得多。
 */
function hasVisibleFocus(container: HTMLElement | null): boolean {
  if (container === null) {
    return false;
  }
  try {
    return container.querySelector(':focus-visible') !== null;
  } catch {
    return false;
  }
}

/**
 * 短剧播放器。
 *
 * 交互约定（与主流短视频一致）：
 * - **单击**：显示/隐藏控件。不改变播放状态。
 * - **双击**：播放/暂停。
 * - **长按**：临时 2 倍速，松手恢复。
 * - **上下滑**：切集。
 * - **左右滑**：快退/快进 10 秒。
 *
 * 早期版本把单击绑成播放/暂停，导致「想调进度条却先暂停了」。单击改成切换
 * 控件后，暂停由双击承担，拖动进度条也不会再误触暂停。
 */
export function Player({
  src,
  poster,
  initialTime,
  sprite,
  title,
  episodeLabel,
  onEnded,
  onOpenEpisodes,
  onNextEpisode,
  onPrevEpisode,
  canPrev = false,
  canNext = false,
  onProgress,
}: PlayerProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(initialTime ?? 0);
  const [duration, setDuration] = useState(0);
  /** 已缓冲区间（已合并）。进度条按区间分别绘制，不再只画到最后一个 `end`。 */
  const [bufferedRanges, setBufferedRanges] = useState<readonly TimeRange[]>([]);
  /** 画幅模式。默认 `contain`：竖屏视频在横屏容器里留黑，不裁掉人物。 */
  const [frameMode, setFrameMode] = useState<FrameMode>('contain');
  /** 睡眠定时器的 deadline（`performance.now()` 毫秒）。`null` 表示未设置。 */
  const [sleepDeadline, setSleepDeadline] = useState<number | null>(null);
  /** 睡眠定时器剩余秒数，只用于按钮上的显示。 */
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState(0);
  // 初始偏好取存档值：否则控件显示与实际媒体属性不一致。
  const storedSpeed = usePlayerStore((state) => state.speed);
  const storedMuted = usePlayerStore((state) => state.muted);
  const storedVolume = usePlayerStore((state) => state.volume);
  const [speed, setSpeed] = useState(storedSpeed);
  const [muted, setMuted] = useState(storedMuted || storedVolume === 0);
  const [volume, setVolume] = useState(Math.min(Math.max(storedVolume, 0), 1));
  /** 倍速菜单是否展开。展开期间不自动隐藏控件，否则菜单会跟着消失。 */
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [error, setError] = useState<PlayerErrorState | null>(null);
  /** 拖动中的预览位置；`null` 表示没在拖。 */
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  /** 长按倍速前的原始倍速，松手时恢复。 */
  const speedBeforeHold = useRef(1);
  /**
   * 已按下的物理键（`event.code`）。
   *
   * 用物理键而不是 `event.key` 记录：按住 Shift 再按 →，然后**先松 Shift**，
   * keyup 的 `key` 仍是 `ArrowRight` 但 `shiftKey` 已经变了；若记录的是带修饰键的
   * 组合值，keyup 就配不上 keydown，键会永久留在「按下」集合里。
   * `blur` 时清空：切走窗口后所有 keyup 都收不到。
   */
  const pressedKeys = useRef<Set<string>>(new Set());
  const [holding, setHolding] = useState(false);
  /**
   * 控件隐藏锁的**来源集合**。
   *
   * 不能用一个布尔值：锁有五个互相独立的来源（悬停底栏、拖进度条、长按加速、
   * 倍速菜单、音量滑块）。单布尔值时任一来源释放就把整把锁打开：鼠标停在底栏
   * 不动、开再关倍速菜单，关闭分支会把锁设成 `false`，3.2 秒后控件就在鼠标还
   * 悬停其上时消失。集合只在**最后一个**来源释放时才算解锁。
   *
   * 用 ref 而不是 state：这些写入发生在事件回调与定时器里，不能引起重渲染。
   */
  const locks = useRef<Set<LockSource>>(new Set());
  /** 加/解一个锁源。`release` 为 true 时释放，否则占用。 */
  const setLock = useCallback((source: LockSource, release: boolean) => {
    locks.current = release ? withoutLock(locks.current, source) : withLock(locks.current, source);
  }, []);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上一次 `pointermove` 的屏幕坐标，用于去重。`null` 表示还没收到过事件。 */
  const lastPointerScreen = useRef<ScreenPoint | null>(null);
  /**
   * 停滞检测的进度观测点。
   *
   * 记「上次看到 currentTime 变化的时间」而不是连续采样相等：缓冲 1 秒就恢复
   * 的情况不该报停滞，时间戳差天然带上了这段抖动容忍。
   */
  const lastProgress = useRef({ currentTime: 0, at: Date.now() });
  /** 停滞提示的状态：`reported` 防止每 2 秒重复报一次，`autoReloaded` 限制自动重载次数。 */
  const stall = useRef({ reported: false, autoReloaded: false });
  /**
   * 全屏。目标是容器而不是 `<video>`：全屏 video 会进入浏览器原生播放器，
   * 倍速菜单、选集、手势全部失效。
   */
  /** 触屏设备：全屏后需要主动锁横屏，桌面不需要。 */
  const [isTouch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  /**
   * 设备是否允许写 `video.volume`。
   *
   * iOS（iPhone + iPad）上该属性只读：赋值不报错，但音量不变。判定方式是
   * 实际赋值后读回——比 UA 嗅探可靠，也比 `matchMedia` 精确。
   * 用一次性探测，不依赖宽度，因此全屏横屏后判断结果不会翻转。
   */
  const [canSetVolume] = useState(() => {
    if (typeof document === 'undefined') {
      return true;
    }
    const probe = document.createElement('video');
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) < 0.01;
  });
  const fullscreen = useFullscreen(containerRef, { lockLandscape: isTouch });
  const progressRef = useRef<{ position: number; duration: number }>({ position: 0, duration: 0 });

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  /**
   * 安排自动隐藏。
   *
   * 到点后有三条分支：控件被锁定（拖动、长按、悬停在控件上、菜单展开）时保持显示，
   * 这是「拖动时进度条突然消失」的根因修复；容器里还有 `:focus-visible` 元素时
   * 推迟隐藏并重排；否则隐藏。
   */
  const scheduleHide = useCallback(() => {
    clearHideTimer();

    /**
     * 真的到点时做判定，需要推迟时用新间隔重排。
     *
     * 为什么这个循环不会失控：每次重排前都**重新查一次** `:focus-visible`。焦点一旦
     * 离开控件（Tab 走开、点击画面、焦点被移除），`hasVisibleFocus` 就返回 false，
     * 下一次到点直接走正常隐藏分支，链就断了。也就是说循环只在「用户一直把焦点
     * 留在控件里」时继续，而这正是该保持显示的状态；频率是 1 秒一次，不是忙等。
     * `isLocked(locks.current)` 命中时直接返回、**不再重排**，由最后一个锁源的
     * 释放方（`pointerleave`、菜单关闭、拖动结束）重新 `scheduleHide()`。
     */
    const armHide = (delay: number): void => {
      hideTimer.current = setTimeout(() => {
        if (isLocked(locks.current)) {
          return;
        }
        // 键盘用户 Tab 到进度条上时不能抢走焦点：控件一旦隐藏，聚焦的元素跟着
        // 不可见，用户就丢掉了当前操作位置。
        if (hasVisibleFocus(containerRef.current)) {
          armHide(FOCUS_HOLD_RECHECK_MS);
          return;
        }
        setShowControls(false);
      }, delay);
    };

    armHide(HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const revealControls = useCallback(() => {
    setShowControls(true);
    scheduleHide();
  }, [scheduleHide]);

  /**
   * 指针移动唤出控件。
   *
   * **为什么不复用 `useGestures` 的 `onPointerMove`**：它在按到交互控件
   * （`button` / `input` / `[role="slider"]` 等）上时整段让路，`origin.current` 是
   * `null`，后续 `pointermove` 在函数开头就 `return`。而鼠标最常停留和移动的地方
   * 恰恰是底部控件，这条路径直接拿不到事件。所以这里在容器上单独挂一个原生监听，
   * 与手势逻辑完全解耦，也不会因为 `{...gestures}` 的 prop 覆盖而丢失。
   *
   * **为什么用 `screenX` / `screenY`**：全屏切换会重排布局，`clientX` / `clientY`
   * 是相对视口的坐标，会因重排而变化，看上去就像「指针动了」；`screenX` / `screenY`
   * 是物理屏幕坐标，布局变化不影响它，能真正区分「指针动了」和「布局动了」。
   *
   * **为什么首次事件要看 `movementX` / `movementY`**：第一次事件没有基准坐标可以比较。
   * 进入/退出全屏时浏览器会补发一次无位移的 `pointermove`，此时 `movement` 全为 0，
   * 只能靠它识别。反之，如果浏览器没实现 `movement`（读出来是 `undefined`），则照常
   * 唤出：宁可多显示一次，也不能吞掉用户的第一次真实移动。具体规则在
   * `judgePointerMotion` 里（纯函数，有单测）。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const onPointerMove = (event: PointerEvent): void => {
      const verdict = judgePointerMotion(lastPointerScreen.current, event);
      lastPointerScreen.current = verdict.next;
      if (!verdict.reveal) {
        return;
      }
      revealControls();
    };
    /**
     * 焦点进入容器时唤出控件。
     *
     * **没有这一条，`:focus-visible` 那条就是假生效**：控件隐藏只是加
     * `opacity-0 pointer-events-none`，DOM 节点仍在 Tab 序列里。键盘用户 Tab 到
     * 一个「隐藏」的按钮时，焦点会落到一个看不见的元素上，而控件不会自己出现——
     * 用户完全不知道自己现在在哪。参考实现同时挂 `focusin` / `focusout`，正是为此。
     *
     * `focusout` 后重排隐藏：焦点离开控件（Tab 走开、点到画面）就该回到正常节奏，
     * 否则 `armHide` 的复查循环会一直以为还有焦点。
     */
    const onFocusIn = (): void => {
      revealControls();
    };
    const onFocusOut = (): void => {
      scheduleHide();
    };
    // passive：回调只读坐标、不阻止默认行为，声明 passive 后浏览器不必等回调返回
    // 就能继续处理后续输入，避免高频 pointermove 拖慢主线程。
    container.addEventListener('pointermove', onPointerMove, { passive: true });
    // `focusin` / `focusout` 冒泡，可以挂在容器上；`focus` / `blur` 不冒泡。
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    return () => {
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
    };
  }, [revealControls, scheduleHide]);

  useEffect(
    () => () => {
      clearHideTimer();
    },
    [clearHideTimer],
  );

  // 换集时重置状态并跳到起始位置。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    setError(null);
    setCurrent(initialTime ?? 0);
    setBufferedRanges([]);
    lastProgress.current = { currentTime: video.currentTime, at: Date.now() };
    stall.current = { reported: false, autoReloaded: false };
    if (initialTime !== undefined && initialTime > 0) {
      const apply = (): void => {
        video.currentTime = initialTime;
      };
      if (video.readyState >= 1) {
        apply();
      } else {
        video.addEventListener('loadedmetadata', apply, { once: true });
      }
    }
  }, [src, initialTime]);

  // 把当前倍速写进 `<video>`。元素默认 1，换集重挂后也要重新应用一次。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    video.playbackRate = speed;
  }, [speed, src]);

  // 应用持久化音量偏好；iOS 只写 muted，不碰只读的 video.volume。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const preference = applyVolumePreference({ volume, muted }, canSetVolume);
    if (preference.volume !== undefined) {
      video.volume = preference.volume;
    }
    video.muted = preference.muted;
  }, [volume, muted, canSetVolume, src]);

  // 首屏自动播放。被浏览器拦截时静默失败，用户双击即可播放。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    void video.play().catch(() => undefined);
  }, [src]);

  /**
   * 重试当前地址。
   *
   * `load()` 会回到 0 秒，所以先把位置记下来、在 `loadedmetadata` 后恢复：
   * 停滞通常发生在中段，从头播等于让用户重新看一遍。
   */
  const retryPlayback = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const position = video.currentTime;
    setError(null);
    stall.current.reported = false;
    lastProgress.current = { currentTime: position, at: Date.now() };
    video.load();
    if (position > 0) {
      video.addEventListener(
        'loadedmetadata',
        () => {
          video.currentTime = position;
        },
        { once: true },
      );
    }
    void video.play().catch((reason: unknown) => {
      setError({ message: reason instanceof Error ? reason.message : String(reason), action: 'retry' });
    });
  }, []);

  /**
   * `<video>` 的 `error` 事件只给 `MediaError` 枚举，拿不到 HTTP 状态码，因此无法
   * 区分「上游 500」「被风控拦成 HTML」与「编码不支持」。这里补一次 2 字节的 Range
   * 探测拿服务端的稳定 `code`，再按 code 选文案与动作。
   */
  const explainFailure = useCallback(async () => {
    const code = await probePlaybackError(src);
    setError(toErrorState(describePlaybackError(code)));
  }, [src]);

  /**
   * 停滞检测：每 `STALL_POLL_MS` 采一次，20 秒没有进度就提示并**自动重载一次**。
   *
   * `playing` 直接读 `video.paused`、`hidden` 读 `document.hidden`，避免定时器闭包
   * 里拿到过期的 state。`autoReloaded` 只允许一次自动重载：无限重试会把上游和本地
   * 解密一起打满，且对「编码不支持」这类确定性失败毫无帮助。
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      const now = Date.now();
      const previous = lastProgress.current;
      if (video.currentTime !== previous.currentTime) {
        lastProgress.current = { currentTime: video.currentTime, at: now };
        if (stall.current.reported) {
          stall.current.reported = false;
          // 只清停滞提示。无条件 `setError(null)` 会把 `onError` 造成的真实错误
          // （例如上游 502）一并抹掉，用户只看到一个没有任何解释的黑屏。
          setError((current) =>
            current !== null && (current.message === STALL_RELOAD_MESSAGE || current.message === STALL_MESSAGE)
              ? null
              : current,
          );
        }
        return;
      }
      const stalled = isStalled({
        playing: !video.paused,
        hidden: document.hidden,
        currentTime: video.currentTime,
        lastProgressAt: previous.at,
        now,
      });
      if (!stalled || stall.current.reported) {
        return;
      }
      stall.current.reported = true;
      if (!stall.current.autoReloaded) {
        // 第一次停滞：自动重载一次，不要求用户点按钮。重载成功后进度恢复，
        // 上面的「进度变化」分支会把提示清掉。
        stall.current.autoReloaded = true;
        retryPlayback();
        setError({ message: STALL_RELOAD_MESSAGE, action: 'none' });
        return;
      }
      setError({ message: STALL_MESSAGE, action: 'retry' });
    }, STALL_POLL_MS);
    return () => clearInterval(timer);
  }, [retryPlayback]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    if (video.paused) {
      void video.play().catch((reason: unknown) => {
        setError({
          message: reason instanceof Error ? reason.message : String(reason),
          action: 'retry',
        });
      });
    } else {
      video.pause();
    }
  }, []);

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const target = Math.min(Math.max(video.currentTime + delta, 0), video.duration || 0);
    video.currentTime = target;
    setCurrent(target);
  }, []);

  const setSpeedTo = useCallback(
    (next: number) => {
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      video.playbackRate = next;
      setSpeed(next);
      // 写回偏好存储，下次进播放器沿用这个倍速。
      usePlayerStore.getState().setSpeed(next);
      revealControls();
    },
    [revealControls],
  );

  const setMutedTo = useCallback(
    (next: boolean) => {
      const video = videoRef.current;
      if (video !== null) {
        video.muted = next;
      }
      setMuted(next);
      usePlayerStore.getState().setMuted(next);
      revealControls();
    },
    [revealControls],
  );

  /** 设置音量。0 会自动静音，>0 自动取消静音——与系统播放器一致。 */
  const setVolumeTo = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(next, 0), 1);
      const nextMuted = clamped === 0;
      const video = videoRef.current;
      if (video !== null) {
        if (canSetVolume) {
          video.volume = clamped;
        }
        video.muted = nextMuted;
      }
      setVolume(clamped);
      setMuted(nextMuted);
      usePlayerStore.getState().setVolume(clamped);
      usePlayerStore.getState().setMuted(nextMuted);
      revealControls();
    },
    [canSetVolume, revealControls],
  );

  const gestures = useGestures({
    onTap: () => {
      setShowControls((visible) => {
        if (visible) {
          clearHideTimer();
          return false;
        }
        scheduleHide();
        return true;
      });
    },
    onDoubleTap: () => {
      togglePlay();
      revealControls();
    },
    onLongPressStart: () => {
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      speedBeforeHold.current = video.playbackRate;
      video.playbackRate = 2;
      setHolding(true);
      setLock('long-press', false);
      setShowControls(true);
      clearHideTimer();
    },
    onLongPressEnd: () => {
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      video.playbackRate = speedBeforeHold.current;
      setHolding(false);
      setLock('long-press', true);
      scheduleHide();
    },
    onSwipe: (direction) => {
      if (direction === 'left') {
        seekBy(-10);
      } else if (direction === 'right') {
        seekBy(10);
      } else if (direction === 'up') {
        onNextEpisode?.();
      } else {
        onPrevEpisode?.();
      }
    },
  });

  const onScrubStart = useCallback(() => {
    setLock('scrub', false);
    clearHideTimer();
    setShowControls(true);
    // 拖动时暂停，避免画面和预览位置脱节。
    videoRef.current?.pause();
  }, [clearHideTimer, setLock]);

  const onScrub = useCallback((seconds: number) => {
    setScrubPreview(seconds);
  }, []);

  const onScrubEnd = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      setScrubPreview(null);
      setLock('scrub', true);
      if (video !== null) {
        video.currentTime = seconds;
        setCurrent(seconds);
        void video.play().catch(() => undefined);
      }
      scheduleHide();
    },
    [scheduleHide, setLock],
  );

  /**
   * 全屏切换。分三条路径：
   *
   * 1. **已在全屏** → 退出（两个平台都一样）。
   * 2. **触屏 + 支持元素全屏**（Android Chrome / iPad Safari 16+）→
   *    对容器请求全屏，然后锁横屏。这条路径保留我们自己的控件层。
   * 3. **触屏 + 不支持元素全屏**（iPhone Safari）→ 退回
   *    `video.webkitEnterFullscreen()`。这是 iPhone 上唯一能全屏并自动
   *    横屏的路径，代价是进入系统播放器 UI。
   *
   * 桌面走第 2 条：`screen.orientation.lock('landscape')` 会被拒绝，
   * hook 里已经静默吞掉，所以桌面上就是普通全屏。
   */
  const toggleFullscreen = useCallback(() => {
    if (fullscreen.active) {
      fullscreen.exit();
      revealControls();
      return;
    }
    if (fullscreen.supported) {
      fullscreen.enter();
      revealControls();
      return;
    }
    // 走到这里说明不支持元素全屏。iPhone 上退回原生视频全屏。
    if (!enterIosNativeFullscreen(videoRef.current)) {
      setError({ message: '当前浏览器不支持全屏', action: 'none' });
    }
    revealControls();
  }, [fullscreen, revealControls]);

  /**
   * 键盘快捷键。
   *
   * 键位表与规范化在 `shortcuts` 模块里（纯逻辑，有单测）；这里只负责把动作接到
   * 播放器上。原来的两段硬编码 keydown（Space/←/→ 与 F）合并成一段：分两段时
   * 两处都自己判 `instanceof HTMLInputElement`，且都不处理修饰键。
   *
   * 上下方向键不再交给外层切集：音量优先，切集靠手势与按钮。
   */
  useEffect(() => {
    const context: ShortcutContext = {
      togglePlay,
      seekBy,
      adjustVolume: (delta) => {
        setVolumeTo(volume + delta);
      },
      toggleMute: () => {
        setMutedTo(!muted);
      },
      toggleFullscreen,
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const code = normalizeKey(event);
      const alreadyHeld = pressedKeys.current.has(code);
      pressedKeys.current.add(code);
      // 按住不放时浏览器会持续派发 keydown。开关型动作（播放/暂停、全屏、静音）
      // 重复触发只会让画面反复闪，按住不放就不该连发；快进快退与音量相反，
      // 连续触发正是长按连跳，必须放行。
      const binding = bindingFor(event);
      if (alreadyHeld && typeof binding === 'string') {
        // 仍然拦掉默认行为：空格在可滚动页面上会滚动页面，按住不放不该滚。
        event.preventDefault();
        return;
      }
      if (handleShortcut(event, context)) {
        revealControls();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      pressedKeys.current.delete(normalizeKey(event));
    };
    // 切走窗口后所有 keyup 都收不到，集合必须清空，否则键会永久处于「按下」。
    const onBlur = (): void => {
      pressedKeys.current.clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [togglePlay, seekBy, setVolumeTo, setMutedTo, volume, muted, revealControls, toggleFullscreen]);

  /**
   * 睡眠定时器。
   *
   * 时间基准是 `performance.now()`（单调时钟）：`Date.now()` 会被 NTP 校时和用户
   * 手改系统时间影响，设了 30 分钟定时器后系统时间往前跳就会立刻到点。
   * 每秒轮询一次而不是用 `setTimeout(deadline - now)`：浏览器在后台会节流定时器，
   * 一次性定时器会拖得更晚才触发；每秒重算剩余时间至少能在回到前台时立刻发现自己
   * 已过点。
   */
  useEffect(() => {
    if (sleepDeadline === null) {
      setSleepRemainingSeconds(0);
      return;
    }
    const tick = (): void => {
      const now = performance.now();
      setSleepRemainingSeconds(Math.ceil(remainingMs(sleepDeadline, now) / 1000));
      if (isExpired(sleepDeadline, now)) {
        videoRef.current?.pause();
        setSleepDeadline(null);
      }
    };
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [sleepDeadline]);

  return (
    <div
      ref={containerRef}
      className="player-shell relative h-full w-full touch-none select-none overflow-hidden bg-scrim"
      {...gestures}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        playsInline
        muted={muted}
        className="h-full w-full"
        style={{ objectFit: objectFitFor(frameMode) }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          setCurrent(video.currentTime);
          // 进度回调按秒节流：timeupdate 每秒约 4 次，写 localStorage 太频繁。
          const next = { position: video.currentTime, duration: video.duration || 0 };
          const previous = progressRef.current;
          if (Math.abs(next.position - previous.position) >= 1 || next.duration !== previous.duration) {
            progressRef.current = next;
            onProgress?.(next.position, next.duration, video.playbackRate);
          }
        }}
        onProgress={(event) => {
          // 保留每段缓冲区间，而不是只取最后一个 `end`：拖动后会出现「中间没缓冲、
          // 两端有」的情形，只画到最后一个 end 会把整段未缓冲区域也画成已缓冲。
          setBufferedRanges(toRanges(event.currentTarget.buffered));
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
        onError={() => {
          void explainFailure();
        }}
      />

      {error !== null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim/80 p-6 text-center text-sm text-text-secondary">
          <p>{error.message}</p>
          {error.action === 'retry' && (
            <button type="button" onClick={retryPlayback} className="rounded-full bg-surface-raised px-5 py-2">
              重试
            </button>
          )}
        </div>
      )}

      {/* 长按倍速提示 */}
      {holding && (
        <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-scrim/80 px-4 py-1.5 text-xs">
          2× 倍速中
        </div>
      )}

      {/* 顶部标题与返回 */}
      <div
        className={`absolute inset-x-0 top-0 bg-gradient-to-b from-scrim/75 via-scrim/35 to-transparent p-4 pt-safe transition-opacity duration-200 ${
          showControls ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex items-center gap-2">
          {/*
            返回按钮：44×44 命中区 + 图标，不再是纯文本胶囊。
            桌面端鼠标 hover 会显示底色，移动端只有按压反馈。
          */}
          <button
            type="button"
            onClick={() => window.history.back()}
            aria-label="返回"
            className="-ml-2 flex h-11 w-11 flex-none items-center justify-center rounded-full text-on-scrim transition-colors hover:bg-on-scrim/15 active:bg-on-scrim/20"
          >
            <svg viewBox="0 0 24 24" aria-hidden className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/*
            标题与集数放在**同一行**。之前是上下两行，返回按钮只有 44px 高，
            两行文字块比它高，视觉上「第 N 集」就掉到了返回按钮下方——
            用户直接指出「第一集没和返回同一行」。
            现在标题可截断、集数不收缩，两个都与返回按钮垂直居中。
          */}
          <div className="flex min-w-0 items-center gap-2">
            {title !== undefined && <p className="truncate text-sm font-medium text-on-scrim">{title}</p>}
            {episodeLabel !== undefined && (
              <span className="flex-none text-xs tabular-nums text-on-scrim-muted">{episodeLabel}</span>
            )}
          </div>
        </div>
      </div>

      {/*
        中央播放按钮：只在「真正暂停且没在拖进度」时出现。
        拖动时 player 会主动 pause，若不排除就会在画面正中弹出一个按钮挡住预览。
      */}
      {!playing && scrubPreview === null && error === null && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            togglePlay();
            revealControls();
          }}
          aria-label="播放"
          className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-scrim/45"
        >
          <svg viewBox="0 0 24 24" className="h-8 w-8 fill-white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      )}

      {/*
        桌面端切集按钮。放在 Player 内部而不是路由层，这样它会跟随控件一起
        显隐——放在外面时控件已隐藏、按钮还挂在画面上，观感很突兀。
      */}
      {showControls && (canPrev || canNext) && (
        <>
          {canPrev && (
            <button
              type="button"
              onClick={() => {
                onPrevEpisode?.();
              }}
              aria-label="上一集"
              className="absolute left-3 top-1/2 hidden h-11 -translate-y-1/2 items-center gap-1 rounded-full bg-scrim/75 px-3.5 text-xs text-on-scrim transition-colors hover:bg-scrim/90 lg:flex"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              上一集
            </button>
          )}
          {canNext && (
            <button
              type="button"
              onClick={() => {
                onNextEpisode?.();
              }}
              aria-label="下一集"
              className="absolute right-3 top-1/2 hidden h-11 -translate-y-1/2 items-center gap-1 rounded-full bg-scrim/75 px-3.5 text-xs text-on-scrim transition-colors hover:bg-scrim/90 lg:flex"
            >
              下一集
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </>
      )}

      {/* 底部控件 */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-scrim/80 to-transparent px-4 pb-safe transition-opacity duration-200 ${
          showControls ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        // 鼠标停在控件上时不自动隐藏，桌面端体验必需。
        onPointerEnter={() => {
          setLock('hover', false);
          clearHideTimer();
        }}
        onPointerLeave={() => {
          setLock('hover', true);
          scheduleHide();
        }}
      >
        {/*
          第二排：画幅模式与睡眠定时器。

          为什么不放进下面那一排：那一排已经有音量、倍速、选集、全屏，再加上
          3 档画幅 + 4 个定时器档位，在 375px 宽的手机上会溢出或者把按钮压得
          只剩图标。这两组都是低频开关，单独一排 `flex-wrap` 更稳。
        */}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 pb-1">
          {/*
            画幅模式：竖屏视频在横屏容器里默认 `contain`（两侧留黑不裁切），
            想铺满时切 `cover`，需要满屏拉伸才用 `fill`。
            不用 Tailwind 的 `object-contain` 类：这里要按状态动态切三档。
          */}
          <div className="flex items-center" role="group" aria-label="画幅模式">
            {FRAME_MODES.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                aria-pressed={frameMode === mode}
                onClick={() => {
                  setFrameMode(mode);
                  revealControls();
                }}
                className={`h-8 rounded-full px-2.5 text-[11px] transition-colors hover:bg-on-scrim/15 ${
                  frameMode === mode ? 'text-on-scrim' : 'text-on-scrim-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/*
            睡眠定时器。已设置时只显示一个带剩余时间的取消按钮：再摆一排分钟数
            会让人分不清当前生效的是哪一个。
          */}
          <div className="flex items-center" role="group" aria-label="睡眠定时器">
            {sleepDeadline === null ? (
              SLEEP_MINUTES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => {
                    setSleepDeadline(sleepDeadlineMinutes(minutes, performance.now()));
                    revealControls();
                  }}
                  aria-label={`${minutes} 分钟后暂停`}
                  className="h-8 rounded-full px-2.5 text-[11px] tabular-nums text-on-scrim-muted transition-colors hover:bg-on-scrim/15"
                >
                  {minutes} 分
                </button>
              ))
            ) : (
              <button
                type="button"
                onClick={() => {
                  setSleepDeadline(null);
                  revealControls();
                }}
                aria-label="关闭睡眠定时器"
                className="h-8 rounded-full px-2.5 text-[11px] tabular-nums text-on-scrim transition-colors hover:bg-on-scrim/15"
              >
                睡眠 {formatDuration(sleepRemainingSeconds)} · 取消
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-on-scrim-muted">
          <span className="tabular-nums">{formatDuration(scrubPreview ?? current)}</span>
          <ProgressBar
            current={current}
            duration={duration}
            bufferedRanges={bufferedRanges}
            onScrubStart={onScrubStart}
            onScrub={onScrub}
            onScrubEnd={onScrubEnd}
            renderPreview={(seconds) =>
              sprite === undefined ? (
                <div className="rounded bg-scrim/80 px-2 py-1 text-xs tabular-nums text-on-scrim">
                  {formatDuration(seconds)}
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-on-scrim/25 shadow-lg">
                  <SpritePreview position={seconds} meta={sprite.meta} sheetUrls={sprite.sheetUrls} />
                  <div className="bg-scrim/80 px-2 py-0.5 text-center text-[11px] tabular-nums text-on-scrim">
                    {formatDuration(seconds)}
                  </div>
                </div>
              )
            }
          />
          <span className="tabular-nums">{formatDuration(duration)}</span>
        </div>

        <div className="flex items-center justify-between pb-2">
          <div className="flex items-center gap-1">
            {/*
              音量：喇叭按钮 + 悬停/点击展开的滑块。
              移动端只有喇叭（iOS 的 video.volume 只读，滑块拖不动）。
            */}
            <VolumeControl
              allowSlider={canSetVolume}
              value={volume}
              muted={muted}
              onChange={setVolumeTo}
              onToggleMute={() => setMutedTo(!muted)}
              onExpandedChange={(expanded) => {
                // 滑块展开时锁住控件，否则拖到一半控件就消失了。
                setLock('volume', !expanded);
                if (expanded) {
                  clearHideTimer();
                } else {
                  scheduleHide();
                }
              }}
            />

            {/* 倍速：点开列表选，不再循环点击。 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setSpeedMenuOpen((open) => {
                    const next = !open;
                    setLock('speed-menu', !next);
                    if (next) {
                      clearHideTimer();
                    } else {
                      scheduleHide();
                    }
                    return next;
                  });
                }}
                aria-haspopup="menu"
                aria-expanded={speedMenuOpen}
                aria-label={`播放速度 ${speed} 倍`}
                className="flex h-11 items-center rounded-full px-4 text-xs tabular-nums text-on-scrim transition-colors hover:bg-on-scrim/15"
              >
                {speed === 1 ? '倍速' : `${speed}×`}
              </button>
              {speedMenuOpen && (
                <SpeedMenu
                  value={speed}
                  onSelect={setSpeedTo}
                  onClose={() => {
                    setSpeedMenuOpen(false);
                    setLock('speed-menu', true);
                    scheduleHide();
                  }}
                />
              )}
            </div>

            {onOpenEpisodes !== undefined && (
              <button
                type="button"
                onClick={onOpenEpisodes}
                className="flex h-11 items-center rounded-full px-4 text-xs text-on-scrim transition-colors hover:bg-on-scrim/15"
              >
                选集
              </button>
            )}

            {/*
              全屏按钮。放在控件行最右侧、紧邻进度时间，与主流播放器一致。
              不满足全屏条件时（iPhone Safari）隐藏而不是禁用：
              一个永远点不动的按钮只会让人反复尝试。
            */}
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={fullscreen.active ? '退出全屏' : '全屏'}
              aria-pressed={fullscreen.active}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-on-scrim transition-colors hover:bg-on-scrim/15 active:bg-on-scrim/20"
            >
              {fullscreen.active ? (
                /* 四角向内：退出全屏 */
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                /* 四角向外：进入全屏 */
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-[11px] text-on-scrim-muted">双击暂停 · 长按倍速</p>
        </div>
      </div>
    </div>
  );
}
