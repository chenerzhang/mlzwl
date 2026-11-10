import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 全屏状态。
 *
 * - `supported`：当前浏览器是否支持元素全屏。iPhone Safari 在 iOS 上
 *   **不支持** `Element.requestFullscreen`，只支持 `<video>` 的
 *   `webkitEnterFullscreen`。这是浏览器能力差异，不是代码问题。
 * - `active`：是否处于全屏。
 * - `enter` / `exit` / `toggle`：控制方法。
 */
export interface FullscreenState {
  supported: boolean;
  active: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
}

export interface UseFullscreenOptions {
  /**
   * 是否在全屏后尝试锁横屏。
   *
   * 只在触屏设备上传 true。桌面浏览器普遍拒绝 `lock('landscape')`
   * （没有物理旋转），每次全屏都会产生一个被拒绝的 Promise——
   * 虽然已被 catch，但没必要制造。桌面全屏本身就是横屏窗口。
   */
  lockLandscape?: boolean;
}

/**
 * 读取「当前全屏元素」，兼容 webkit 前缀。
 *
 * Safari 只暴露 `webkitFullscreenElement`，标准属性是 `undefined` 而不是
 * `null`，所以两者都要判。
 */
function getFullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** 元素请求全屏，兼容 webkit 前缀。返回是否成功发起。 */
function requestElementFullscreen(node: HTMLElement): Promise<void> | null {
  const el = node as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
  if (el.requestFullscreen !== undefined) {
    return el.requestFullscreen();
  }
  if (el.webkitRequestFullscreen !== undefined) {
    return Promise.resolve(el.webkitRequestFullscreen());
  }
  return null;
}

/** 退出全屏，兼容 webkit 前缀。 */
function exitDocumentFullscreen(): Promise<void> | null {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
  if (doc.exitFullscreen !== undefined) {
    return doc.exitFullscreen();
  }
  if (doc.webkitExitFullscreen !== undefined) {
    return Promise.resolve(doc.webkitExitFullscreen());
  }
  return null;
}

/**
 * 带方向锁的 `ScreenOrientation`。
 *
 * TS 5.9 的 DOM lib 里 `ScreenOrientation` 只有 `angle` / `type`，
 * `lock` / `unlock` 仍标记为实验性、未收录。TS 6 的 lib 已收录。
 * 这里用局部类型补上，避免用 `any` 绕过。
 */
interface LockableOrientation {
  lock?: (orientation: 'landscape' | 'portrait') => Promise<void>;
  unlock?: () => void;
}

/**
 * 元素全屏 + 移动端强制横屏。
 *
 * ## 为什么全屏的是容器而不是 `<video>`
 *
 * 用 `video.requestFullscreen()` 会进入**浏览器原生视频全屏**：控件、倍速
 * 菜单、选集抽屉、手势全部被原生 UI 覆盖，等于放弃自己的播放器。
 *
 * 所以全屏目标是包裹 video 和控件层的那个 `div`。代价是移动端不会自动
 * 横屏（原生视频全屏才会），必须显式调 `screen.orientation.lock`。
 *
 * ## 移动端横屏
 *
 * 全屏后调用 `screen.orientation.lock('landscape')`。三个必须处理的失败：
 *
 * 1. **iOS Safari 不支持**。`screen.orientation.lock` 在 iOS 上不存在，
 *    且 iPhone 的 Safari 也不支持 `Element.requestFullscreen`。此时
 *    `supported` 为 false，播放器会退回原生视频全屏。
 * 2. **必须全屏后才能锁方向**。在非全屏状态下调用会抛
 *    `InvalidStateError`，所以顺序不能反。
 * 3. **锁可能被拒绝**。桌面浏览器普遍拒绝 `lock('landscape')`（没有物理
 *    旋转），抛出的错误必须吞掉，否则会打断全屏流程。
 *
 * 退出全屏时主动 `unlock()`，让设备回到系统方向。
 */
export function useFullscreen(
  target: React.RefObject<HTMLElement | null>,
  options: UseFullscreenOptions = {},
): FullscreenState {
  const { lockLandscape = false } = options;
  const [active, setActive] = useState(false);
  const [supported] = useState(() => {
    if (typeof document === 'undefined') {
      return false;
    }
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: unknown };
    return el.requestFullscreen !== undefined || el.webkitRequestFullscreen !== undefined;
  });
  /** 是否是本 hook 主动进入的全屏。用来区分用户按 Esc 退出。 */
  const enteredByUs = useRef(false);

  // 同步全屏状态。用户按 Esc、或浏览器自行退出时都要能反映到 UI。
  useEffect(() => {
    const onChange = (): void => {
      const isActive = getFullscreenElement() !== null;
      setActive(isActive);
      if (!isActive && enteredByUs.current) {
        enteredByUs.current = false;
        // 退出全屏后解除方向锁，否则设备会卡在横屏。
        (screen.orientation as LockableOrientation | undefined)?.unlock?.();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const enter = useCallback(() => {
    const node = target.current;
    if (node === null) {
      return;
    }
    enteredByUs.current = true;
    const pending = requestElementFullscreen(node);
    if (pending === null) {
      enteredByUs.current = false;
      return;
    }

    void pending
      .then(() => {
        /*
         * 必须等全屏生效后再锁方向：非全屏状态下调用会抛 InvalidStateError。
         * 桌面浏览器会拒绝横屏锁（没有物理旋转），所以失败必须静默。
         */
        if (!lockLandscape) {
          return;
        }
        const orientation = screen.orientation as LockableOrientation | undefined;
        if (orientation?.lock === undefined) {
          return;
        }
        void Promise.resolve(orientation.lock('landscape')).catch(() => undefined);
      })
      .catch(() => {
        // 用户拒绝、或浏览器策略不允许。保持当前状态，不报错。
        enteredByUs.current = false;
      });
  }, [target, lockLandscape]);

  const exit = useCallback(() => {
    if (getFullscreenElement() === null) {
      return;
    }
    void exitDocumentFullscreen()?.catch(() => undefined);
  }, []);

  const toggle = useCallback(() => {
    if (active) {
      exit();
    } else {
      enter();
    }
  }, [active, enter, exit]);

  return { supported, active, enter, exit, toggle };
}

/**
 * 进入 iOS 原生视频全屏。
 *
 * iPhone 上唯一能真正全屏并自动横屏的路径是 `<video>` 的
 * `webkitEnterFullscreen()`。代价是进入后是系统播放器 UI，不是我们的控件层。
 * 这是 iOS 的硬限制：`Element.requestFullscreen` 在 iPhone Safari 上不存在。
 *
 * 返回是否成功发起，调用方可据此决定是否提示。
 */
export function enterIosNativeFullscreen(video: HTMLVideoElement | null): boolean {
  if (video === null) {
    return false;
  }
  const node = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  if (node.webkitEnterFullscreen === undefined) {
    return false;
  }
  node.webkitEnterFullscreen();
  return true;
}
