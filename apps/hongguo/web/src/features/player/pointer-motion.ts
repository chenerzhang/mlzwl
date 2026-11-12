/**
 * 指针移动的「是否算用户活动」判定。
 *
 * 抽成纯函数是为了让播放器组件只管挂监听：去重规则有 4 条分支（首次事件带位移、
 * 首次事件无位移、坐标重复、坐标变化），写在 `player.tsx` 的 `useEffect` 里既
 * 无法测也无法读。模块不碰 DOM，`PointerEvent` 只按字段结构消费。
 */

/** 屏幕坐标（`screenX` / `screenY`）。 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * 判定所需的事件字段。
 *
 * `movementX` / `movementY` 显式允许 `undefined`：类型定义里它们是必填的
 * `number`，但部分浏览器运行时根本没有实现，读出来是 `undefined`。写成
 * `number | undefined` 才能在 `exactOptionalPropertyTypes` 下如实表达这一点。
 */
export interface PointerMotion {
  screenX: number;
  screenY: number;
  movementX?: number | undefined;
  movementY?: number | undefined;
}

/**
 * 判定结果。
 *
 * `next` 是下一次判定要用的基准坐标：
 * - 无位移的首次事件返回 `null`，这次事件不该成为基准（否则下一次同坐标的
 *   真实移动会被当成重复而吞掉）；
 * - 坐标重复时返回传入的 `previous` 引用本身，调用方可以用 `===` 判断基准没变。
 */
export type PointerMotionVerdict = { reveal: true; next: ScreenPoint } | { reveal: false; next: ScreenPoint | null };

/**
 * 判断这次 `pointermove` 是否应该唤出控件。
 *
 * 规则：
 * 1. 没有基准（首次事件）：两个 `movement` **都存在且都为 0** 时视为无位移，
 *    不唤出。这正是「进入/退出全屏时浏览器补发一次无位移的 `pointermove`」
 *    的根因——不拦就会让刚隐藏的控件闪一下又消失。
 * 2. 没有基准且 `movement` 缺失（浏览器不支持）：照常唤出。宁可多唤出一次，
 *    也不要因为拿不到位移字段就把用户的第一次真实移动吞掉。
 * 3. 有基准：优先看屏幕坐标。坐标不同就是真动了。
 * 4. **有基准、坐标相同、但 `movement` 明确非零**：屏幕坐标不可信（隐私模式、
 *    嵌入式 WebView 里 `screenX`/`screenY` 可能恒为 `0,0`），以 `movement` 为准
 *    唤出。不这样做，这类环境里首次唤出之后的每一次真实移动都会被吞掉，控件
 *    再也出不来。代价只是「指针抖出去又抖回来」时多显示一次，可接受。
 */
export function judgePointerMotion(previous: ScreenPoint | null, event: PointerMotion): PointerMotionVerdict {
  const current: ScreenPoint = { x: event.screenX, y: event.screenY };
  const moved = hasMovement(event);

  if (previous === null) {
    const { movementX, movementY } = event;
    if (movementX !== undefined && movementY !== undefined && movementX === 0 && movementY === 0) {
      return { reveal: false, next: null };
    }
    return { reveal: true, next: current };
  }

  if (previous.x === current.x && previous.y === current.y) {
    if (moved) {
      return { reveal: true, next: current };
    }
    // 坐标没变：保持原基准对象，避免调用方每次拿到新对象误判成「有变化」。
    return { reveal: false, next: previous };
  }

  return { reveal: true, next: current };
}

/**
 * `movementX` / `movementY` 是否明确表示「指针动了」。
 *
 * 两个字段都必须存在，且至少一个非零：
 * - 任一缺失 → `false`（浏览器不支持，不能拿它当判据）；
 * - 都为 0 → `false`（全屏切换补发的无位移事件）。
 */
function hasMovement(event: PointerMotion): boolean {
  const { movementX, movementY } = event;
  if (movementX === undefined || movementY === undefined) {
    return false;
  }
  return movementX !== 0 || movementY !== 0;
}
