import { useThemeStore } from '../features/theme/theme-store';
import { useResolvedTheme } from '../features/theme/use-theme-effect';

/**
 * 全站统一顶栏。
 *
 * 三个必须满足的条件：
 *
 * 1. **始终固定**。用 `sticky top-0` 而不是 `fixed`：`fixed` 会让内容被顶栏
 *    压住，必须再补一段等高 padding（`ui-ux-pro-max` 的 Sticky Navigation
 *    指引明确要求 `pt-<nav-height>` 补偿）。`sticky` 天然占位，不需要补偿，
 *    也不会在横屏或动态字号下算错高度。
 * 2. **安全区跟随**。`pt-safe` 放在 sticky 元素内部而不是页面容器上，否则
 *    刘海屏的 padding 会随滚动一起移出视口，顶栏内容顶到状态栏下面。
 * 3. **滚动内容从下方穿过**。背景必须不透明，否则列表滚动时文字会和顶栏
 *    标题叠在一起。这里用实底 `bg-surface` + 一条 1px `border-border-subtle`，
 *    **不用**半透明 + `backdrop-blur`：毛玻璃会把滚动中的封面糊成一片彩色
 *    噪点，是「廉价感」的典型来源。
 *
 * `sticky` 需要祖先链上没有 `overflow: hidden/auto`，否则会退化成普通定位。
 * 页面根节点只用 `pb-*`，不加 `overflow`。
 */
export interface PageHeaderProps {
  /** 左侧区域，通常是返回按钮或标题。 */
  left?: React.ReactNode;
  /** 居中标题。传了 `left` 时标题仍然居中，靠两侧等宽占位保持平衡。 */
  title?: string | undefined;
  /** 右侧操作区。 */
  right?: React.ReactNode;
  /** 顶栏下方额外一行，例如搜索框。 */
  children?: React.ReactNode | undefined;
  /** 内容最大宽度。保留该参数只为兼容调用方，取值已统一为 `SHELL_WIDTH`。 */
  maxWidth?: 'md' | 'lg' | 'xl' | 'wide';
  /** 是否在右侧自动追加主题切换按钮。默认开启。 */
  showThemeToggle?: boolean;
}

/**
 * 全站统一内容宽度。
 *
 * 之前四个页面各用一个宽度（首页 `max-w-7xl`、历史 `max-w-3xl`、详情 `max-w-4xl`），
 * 在 1440 视口下实测左边界分别是 80 / 336 / 272px。切页时内容左右横跳，
 * 是最明显的「没做完」信号。
 *
 * 现在只保留一个值：`SHELL_WIDTH`。顶栏与正文都用它，所以两者天然对齐。
 * 详情页的长描述需要窄行长，那是**文字内部**的约束（`max-w-[65ch]`），
 * 不是容器宽度的差异。
 */
export const SHELL_WIDTH = 'max-w-7xl';

export function PageHeader({
  left,
  title,
  right,
  children,
  showThemeToggle = true,
}: PageHeaderProps): React.JSX.Element {
  // 顶栏用不透明实底 + 一条 1px 极淡分隔线。之前是 `bg-surface/85 + backdrop-blur-xl`，
  // 滚动时封面在毛玻璃后面糊成一片彩色噪点，是「廉价」的典型来源。
  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface pt-safe">
      <div className={`mx-auto w-full ${SHELL_WIDTH} px-3 sm:px-5`}>
        {/*
          三栏都没传时，不渲染标题行——搜索页把返回按钮和输入框放在同一行更紧凑。

          左右两栏的伸缩行为要分开看：有居中标题时，两边必须**等宽**（`flex-1`），
          否则标题会偏；没有标题时右侧只能 `flex-none`，否则它会白占一半宽度。
          之前搜索页在 390px 上输入框被挤成一个图标，就是这个原因。
        */}
        {(left !== undefined || title !== undefined || right !== undefined || showThemeToggle) && (
          <div className="flex min-h-14 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
            {title !== undefined && (
              <h1 className="pointer-events-none truncate text-[15px] font-medium tracking-tight">{title}</h1>
            )}
            <div
              className={`flex min-w-0 items-center justify-end gap-1.5 ${title === undefined ? 'flex-none' : 'flex-1'}`}
            >
              {right}
              {showThemeToggle && <ThemeToggle />}
            </div>
          </div>
        )}
        {/* 附加行：需要整行宽度的内容（如搜索框）放这里，不要塞进 `left`。 */}
        {children !== undefined && <div className="pb-3">{children}</div>}
      </div>
    </header>
  );
}

/**
 * 深色 / 浅色切换。
 *
 * 用图标按钮而不是开关：短剧是内容优先的产品，顶栏要尽量轻。图标表达
 * 「点一下会变成什么」（当前深色显示太阳，当前浅色显示月亮），这比
 * 「显示当前状态」更符合按钮语义。
 *
 * `aria-pressed` 暴露切换状态，屏幕阅读器能读出「已按下」。
 */
function ThemeToggle(): React.JSX.Element {
  const resolved = useResolvedTheme();
  const toggle = useThemeStore((state) => state.toggle);
  const nextLabel = resolved === 'dark' ? '切换到浅色模式' : '切换到深色模式';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={nextLabel}
      title={nextLabel}
      aria-pressed={resolved === 'light'}
      className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay"
    >
      {resolved === 'dark' ? (
        /* 太阳：点它变亮 */
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        /* 月亮：点它变暗 */
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M21 12.8A8.5 8.5 0 1111.2 3a7 7 0 009.8 9.8z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** 顶栏图标按钮。命中区域 44×44，满足触摸目标要求。 */
export interface HeaderButtonProps {
  label: string;
  onClick: () => void;
  /** 图标。省略时直接渲染 `label` 文本。 */
  children?: React.ReactNode;
}

export function HeaderButton({ label, onClick, children }: HeaderButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      // 光学对齐：44px 命中区内居中一个 20px 图标，图标左侧留白 12px。
      // 因此向左外扩 12px（`-ml-3`），图标左沿才与正文内容左边界严格重合。
      // 用 `-ml-2`（8px）会差 4px，肉眼可辨。
      className="-ml-3 flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-primary transition-colors hover:bg-surface-overlay active:bg-surface-overlay"
    >
      {children ?? label}
    </button>
  );
}

/** 顶栏文字按钮。 */
export interface HeaderTextButtonProps {
  label: string;
  onClick: () => void;
  /** 按钮文本。省略时渲染 `label`。 */
  children?: React.ReactNode;
}

export function HeaderTextButton({ label, onClick, children }: HeaderTextButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      // 同上：`px-3` 是 12px，向左外扩 12px 让文字左沿对齐正文。
      className="-ml-3 flex h-11 flex-none items-center rounded-full px-3 text-sm text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay"
    >
      {children ?? label}
    </button>
  );
}
