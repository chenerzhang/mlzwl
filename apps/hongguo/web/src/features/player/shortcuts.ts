/** 快捷键能触发的动作。全部由调用方注入，模块本身不碰 DOM。 */
export interface ShortcutContext {
  togglePlay: () => void;
  seekBy: (deltaSeconds: number) => void;
  adjustVolume: (delta: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
}

/** 不带参数的动作。 */
export type SimpleShortcut = 'togglePlay' | 'toggleMute' | 'toggleFullscreen';

/** 带步长的动作。 */
export type RangedShortcut = 'seekBy' | 'adjustVolume';

/** 表里的一条：直接给动作名，或给带步长的动作名加一个 amount。 */
export type ShortcutBinding = SimpleShortcut | { action: RangedShortcut; amount: number };

/**
 * 默认快捷键表。
 *
 * 键名是 `normalizeKey` 的输出（`event.code` 优先），所以是 `Space` / `ArrowLeft`
 * 这种物理键标识，而不是 `' '` 或 `'ArrowLeft'` 这种随键盘布局变化的值。
 *
 * Shift 变体用 `Shift+` 前缀单独成条：`normalizeKey` 只看物理键，Shift 状态由
 * `handleShortcut` 拼前缀再查表。这样「Shift+→ 快进 15 秒」不会挤进物理键标识里，
 * 也让键位表保持可读。
 *
 * 步长与 hongguo-drama 对齐：← / → 5 秒，Shift + ← / → 15 秒，↑ / ↓ 音量 5%。
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<string, ShortcutBinding>> = Object.freeze({
  Space: 'togglePlay',
  ArrowLeft: { action: 'seekBy', amount: -5 },
  ArrowRight: { action: 'seekBy', amount: 5 },
  'Shift+ArrowLeft': { action: 'seekBy', amount: -15 },
  'Shift+ArrowRight': { action: 'seekBy', amount: 15 },
  ArrowUp: { action: 'adjustVolume', amount: 0.05 },
  ArrowDown: { action: 'adjustVolume', amount: -0.05 },
  KeyF: 'toggleFullscreen',
  KeyM: 'toggleMute',
} satisfies Record<string, ShortcutBinding>);

/**
 * 把键盘事件规范化成稳定的键标识。
 *
 * 优先 `event.code`：它表示物理键位，`KeyF` 在 Dvorak 布局上仍是同一个键，
 * 中文输入法激活时 `event.key` 还可能变成 `'Process'`。`code` 为空串时
 * （部分合成事件、老浏览器）退回小写的 `key`。
 */
export function normalizeKey(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  const code = event.code;
  if (typeof code === 'string' && code !== '') {
    return code;
  }
  const key = event.key;
  return typeof key === 'string' ? key.toLowerCase() : '';
}

/**
 * 目标是否是可编辑控件。
 *
 * 用结构判断而不是 `instanceof HTMLInputElement`：这个模块在 Node 里被单测直接
 * import，那里没有 `HTMLElement` 构造器，`instanceof` 会抛 `ReferenceError`。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') {
    return false;
  }
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) {
    return true;
  }
  if (typeof element.tagName !== 'string') {
    return false;
  }
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

/**
 * 把规范化后的键名展开成候选的物理键名。
 *
 * 表里的键名统一用 `event.code` 的写法（`KeyF`），而 `normalizeKey` 在 `code` 缺失时
 * 退回小写的 `key`（`f`）。两条路径必须能查到同一行，否则「老浏览器 / 合成事件没有
 * code」时字母快捷键会静默失效。
 */
function candidatesFor(base: string): string[] {
  if (/^[a-z]$/.test(base)) {
    return [base, `Key${base.toUpperCase()}`];
  }
  if (base === ' ') {
    return [base, 'Space'];
  }
  return [base];
}

/**
 * 查一次按键对应的绑定（含 Shift 变体）。没绑定时返回 `undefined`。
 *
 * 提出来是因为播放器还要用它判断「这个键是开关型还是连续型」：开关型动作在按住
 * 不放时不能跟着重复的 keydown 反复触发。
 */
export function bindingFor(event: Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey'>): ShortcutBinding | undefined {
  const base = normalizeKey(event);
  if (base === '') {
    return undefined;
  }
  for (const key of candidatesFor(base)) {
    const binding = DEFAULT_SHORTCUTS[event.shiftKey ? `Shift+${key}` : key] ?? DEFAULT_SHORTCUTS[key];
    if (binding !== undefined) {
      return binding;
    }
  }
  return undefined;
}

/**
 * 处理一次按键，命中则执行并返回 `true`。
 *
 * 三个前置条件都会让按键直接失效：
 * 1. 焦点在输入控件里（用户正在输入集数，空格和方向键属于输入框）。
 * 2. 带 Ctrl / Meta / Alt（`Ctrl+F` 是浏览器查找，不能被播放器吃掉）。
 * 3. 键不在表里。
 *
 * Shift 不算修饰键：`Shift+→` 是表里的一条更长步长，`Shift+Space` 则退化成
 * 普通的空格播放/暂停。
 */
export function handleShortcut(event: KeyboardEvent, context: ShortcutContext): boolean {
  if (isEditableTarget(event.target)) {
    return false;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const binding = bindingFor(event);
  if (binding === undefined) {
    return false;
  }
  if (typeof binding === 'string') {
    // 不带参数的动作：`context[binding]` 是三个零参函数的并集，可以直接调用。
    context[binding]();
  } else if (binding.action === 'seekBy') {
    context.seekBy(binding.amount);
  } else {
    context.adjustVolume(binding.amount);
  }
  event.preventDefault();
  return true;
}

/**
 * 找出键位表里出现多次的键，用于配置界面提示冲突。
 *
 * 入参是「动作名 → 键名」的映射（与 `DEFAULT_SHORTCUTS` 的形状相反），因为用户
 * 编辑的是每个动作绑哪个键，冲突要按键名统计。
 */
export function findShortcutConflicts(table: Readonly<Record<string, string>>): string[] {
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const key of Object.values(table)) {
    if (seen.has(key)) {
      conflicts.add(key);
      continue;
    }
    seen.add(key);
  }
  return [...conflicts].sort();
}
