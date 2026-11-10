import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpriteMeta } from '@mlzwl/hongguo-shared';
import { formatDuration } from '../../lib/format';
import { ProgressBar } from './progress-bar';
import { SpritePreview } from './sprite-preview';
import { SpeedMenu } from './speed-menu';
import { VolumeControl } from './volume-control';
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
  /** 进度回调（秒），用于保存观看记录。 */
  onProgress?: (position: number, duration: number) => void;
}

/** 控件自动隐藏的延迟。拖动或长按期间不隐藏。 */
const HIDE_DELAY_MS = 3200;

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
  const [buffered, setBuffered] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  /** 倍速菜单是否展开。展开期间不自动隐藏控件，否则菜单会跟着消失。 */
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 拖动中的预览位置；`null` 表示没在拖。 */
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  /** 长按倍速前的原始倍速，松手时恢复。 */
  const speedBeforeHold = useRef(1);
  const [holding, setHolding] = useState(false);
  /** 控件是否被锁定显示（拖动中、长按中、悬停在控件上）。 */
  const controlsLocked = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
   * 三个前置条件任一成立就保持显示：控件被锁定、正在拖动、正在长按。
   * 这是「拖动时进度条突然消失」的根因修复。
   */
  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      if (controlsLocked.current) {
        return;
      }
      setShowControls(false);
    }, HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const revealControls = useCallback(() => {
    setShowControls(true);
    scheduleHide();
  }, [scheduleHide]);

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
    setBuffered(0);
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

  // 首屏自动播放。被浏览器拦截时静默失败，用户双击即可播放。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    void video.play().catch(() => undefined);
  }, [src]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    if (video.paused) {
      void video.play().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
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
      revealControls();
    },
    [revealControls],
  );

  /** 设置音量。0 会自动静音，>0 自动取消静音——与系统播放器一致。 */
  const setVolumeTo = useCallback(
    (next: number) => {
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      const clamped = Math.min(Math.max(next, 0), 1);
      video.volume = clamped;
      video.muted = clamped === 0;
      setVolume(clamped);
      setMuted(clamped === 0);
      revealControls();
    },
    [revealControls],
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
      controlsLocked.current = true;
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
      controlsLocked.current = false;
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
    controlsLocked.current = true;
    clearHideTimer();
    setShowControls(true);
    // 拖动时暂停，避免画面和预览位置脱节。
    videoRef.current?.pause();
  }, [clearHideTimer]);

  const onScrub = useCallback((seconds: number) => {
    setScrubPreview(seconds);
  }, []);

  const onScrubEnd = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      setScrubPreview(null);
      controlsLocked.current = false;
      if (video !== null) {
        video.currentTime = seconds;
        setCurrent(seconds);
        void video.play().catch(() => undefined);
      }
      scheduleHide();
    },
    [scheduleHide],
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
      setError('当前浏览器不支持全屏');
    }
    revealControls();
  }, [fullscreen, revealControls]);

  /**
   * 全屏快捷键。
   *
   * 单独一个 effect 而不是塞进已有的键盘 effect：那个 effect 依赖
   * `togglePlay` / `seekBy`，加进来会让它在每次倍速变化时重绑。
   * `F` 键是 YouTube / Bilibili 的通用约定，值得支持。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) {
        return;
      }
      if (event.code === 'KeyF') {
        event.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen]);

  // 桌面端键盘：空格播放/暂停，左右 10 秒，上下切集交给外层。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
        revealControls();
        return;
      }
      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        seekBy(-10);
        revealControls();
        return;
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault();
        seekBy(10);
        revealControls();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, revealControls]);

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
        className="h-full w-full object-contain"
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
            onProgress?.(next.position, next.duration);
          }
        }}
        onProgress={(event) => {
          const video = event.currentTarget;
          if (video.buffered.length > 0) {
            const end = video.buffered.end(video.buffered.length - 1);
            setBuffered(end);
          }
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
        onError={() => setError('当前浏览器无法播放该视频（HEVC 编码需要 Safari / Edge / Chrome）')}
      />

      {error !== null && (
        <div className="absolute inset-0 flex items-center justify-center bg-scrim/80 p-6 text-center text-sm text-text-secondary">
          {error}
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
          controlsLocked.current = true;
          clearHideTimer();
        }}
        onPointerLeave={() => {
          controlsLocked.current = false;
          scheduleHide();
        }}
      >
        <div className="flex items-center gap-3 text-xs text-on-scrim-muted">
          <span className="tabular-nums">{formatDuration(scrubPreview ?? current)}</span>
          <ProgressBar
            current={current}
            duration={duration}
            buffered={buffered}
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
              onToggleMute={() => {
                const video = videoRef.current;
                if (video === null) {
                  return;
                }
                video.muted = !video.muted;
                setMuted(video.muted);
                revealControls();
              }}
              onExpandedChange={(expanded) => {
                // 滑块展开时锁住控件，否则拖到一半控件就消失了。
                controlsLocked.current = expanded;
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
                    controlsLocked.current = next;
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
                    controlsLocked.current = false;
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
