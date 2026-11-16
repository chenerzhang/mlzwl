/**
 * 横向拖动调进度的纯逻辑。
 *
 * 抽成模块而不是写进 `use-seek-drag.ts`，是因为换算规则有若干边界：
 * 起拖门槛、方向锁定、边界夹取、时长未知。这些都不碰 DOM，可以单独推理。
 *
 * ## 与 `useGestures` 的分工
 *
 * `useGestures` 负责「短促手势」：单击、双击、长按、快速滑动（松手才判定）。
 * 本模块负责「持续拖动」：按下后横向移动超过门槛，进入拖动状态，期间每一帧
 * 都要更新目标时间。两者共用同一个 `pointerdown`，所以由调用方在
 * `useGestures` 之前决定这次手势归谁——见 `use-seek-drag.ts` 的说明。
 */

/** 起拖门槛（px）。小于这个位移视为点击，不进拖动状态。 */
export const SEEK_DRAG_THRESHOLD = 24;

/**
 * 方向锁定的宽高比。
 *
 * 横向位移必须明显大于纵向才算「横向拖动」。1.2 与 `use-gestures.ts` 的
 * 快速滑动判定保持一致，两个手势不会对同一次移动给出矛盾结论。
 */
export const SEEK_DRAG_AXIS_RATIO = 1.2;

/**
 * 拖动灵敏度：横向每移动 1px 对应多少秒。
 *
 * 按「屏幕宽度对应 90 秒」换算，这是主流播放器的量级（YouTube 大约
 * 90–120 秒/屏）。固定秒/像素而不是固定「整片长的百分比」：短剧一集只有
 * 1–3 分钟，百分比模式会让一屏拖过半个片子，手指稍微一动就跳很远。
 */
export const SECONDS_PER_PIXEL = 90 / 360;

export interface SeekDragInput {
  /** 起拖时的播放位置（秒）。 */
  startTime: number;
  /** 当前横向位移（px），右为正。 */
  dx: number;
  /** 当前纵向位移（px），仅用于方向锁定。 */
  dy: number;
  /** 总时长（秒）。未知时传 0。 */
  duration: number;
}

export type SeekDragVerdict = { kind: 'ignore' } | { kind: 'pending' } | { kind: 'seek'; time: number };

/**
 * 判定一次指针移动是否构成横向拖动，以及目标时间。
 *
 * 返回三态：
 * - `ignore`：位移太小，还看不出意图。调用方应保持原状。
 * - `pending`：位移够大但方向不是横向（偏纵向），这次手势不该由本模块接管，
 *   应让给 `useGestures` 的上/下滑切集。
 * - `seek`：确认是横向拖动，`time` 是夹取后的目标位置。
 *
 * 时长未知（`duration <= 0`）时一律 `ignore`：没有总长就无法夹取，也无法
 * 有意义地换算进度。
 */
export function judgeSeekDrag(input: SeekDragInput): SeekDragVerdict {
  const { startTime, dx, dy, duration } = input;
  if (!(duration > 0)) {
    return { kind: 'ignore' };
  }
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < SEEK_DRAG_THRESHOLD) {
    return { kind: 'ignore' };
  }
  if (absX <= absY * SEEK_DRAG_AXIS_RATIO) {
    return { kind: 'pending' };
  }
  return { kind: 'seek', time: clampTime(startTime + dx * SECONDS_PER_PIXEL, duration) };
}

/** 把时间夹进 `[0, duration]`。 */
export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) {
    return 0;
  }
  if (!(duration > 0)) {
    return 0;
  }
  return Math.min(Math.max(time, 0), duration);
}

/**
 * 拖动时的相对偏移文案。
 *
 * 显示 `+12 秒` / `-8 秒` 而不是绝对时间：用户拖动的意图是「往前一点」，
 * 相对量才是他要的信息。绝对值另有一行显示目标位置。
 *
 * 不足 1 秒时返回 `+0 秒` 而不是 `+0.4 秒`：拖动精度本来就到不了秒以下。
 */
export function formatSeekDelta(deltaSeconds: number): string {
  const rounded = Math.round(deltaSeconds);
  if (rounded === 0) {
    return '±0 秒';
  }
  return rounded > 0 ? `+${rounded} 秒` : `${rounded} 秒`;
}
