import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../features/player/use-focus-trap';
import { useThemeStore } from '../features/theme/theme-store';
import { useResolvedTheme } from '../features/theme/use-theme-effect';
import { buildMenuItems } from './page-header-actions';

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
export interface PageHeaderAction {
  /** 菜单项文字。必填：列表中的纯图标无法让用户辨认操作含义。 */
  label: string;
  onClick: () => void;
  /** 菜单与桌面按钮使用的图标。 */
  icon?: React.ReactNode;
  /** 禁用态。用于「请求进行中」。 */
  disabled?: boolean;
  /** 桌面端是否只显示图标。默认显示文字，避免充足空间里仍要求用户猜图标。 */
  iconOnly?: boolean;
}

export interface PageHeaderProps {
  /** 左侧区域，通常是返回按钮或标题。 */
  left?: React.ReactNode;
  /** 标题在两侧剩余空间内居中，空间不足时截断。 */
  title?: string | undefined;
  /** 右侧始终可见的自定义内容。 */
  right?: React.ReactNode;
  /**
   * 右侧标准操作。移动端（`sm` 以下）收进「更多」菜单，桌面端平铺。
   *
   * 与 `right` 并存时排在它之后：既有 `right` 是必须常驻的自定义内容，新加的
   * `actions` 才是可折叠操作，先常驻、后操作的顺序更符合两者语义。
   */
  actions?: readonly PageHeaderAction[];
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
  actions = [],
  children,
  showThemeToggle = true,
}: PageHeaderProps): React.JSX.Element {
  const menuItems = buildMenuItems(actions);

  // 顶栏用不透明实底 + 一条 1px 极淡分隔线。之前是 `bg-surface/85 + backdrop-blur-xl`，
  // 滚动时封面在毛玻璃后面糊成一片彩色噪点，是「廉价」的典型来源。
  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface pt-safe">
      <div className={`mx-auto w-full ${SHELL_WIDTH} px-3 sm:px-5`}>
        {/*
          三栏都没传时，不渲染标题行——搜索页把返回按钮和输入框放在同一行更紧凑。

          伸缩策略：**标题是唯一可让位的元素**。
          - 没有标题：左栏 `flex-1`（首页的大标题需要它，`truncate` 才生效），右栏 `flex-none`。
          - 有标题：左右都 `flex-none`（按内容宽度），标题 `flex-1 min-w-0` 吃掉剩余空间。

          移动端只有 `right` 不折叠，所以它靠近操作区起点，后面的「更多」贴近视口边缘；
          桌面端沿用同一顺序，把 actions 放在 right 与主题切换之间，切换断点时视觉重心不跳。
        */}
        {(left !== undefined ||
          title !== undefined ||
          right !== undefined ||
          menuItems.length > 0 ||
          showThemeToggle) && (
          <div className="flex min-h-14 items-center gap-2">
            <div className={`flex min-w-0 items-center gap-2 ${title === undefined ? 'flex-1' : 'flex-none'}`}>
              {left}
            </div>
            {title !== undefined && (
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <h1 className="truncate text-center text-[15px] font-medium tracking-tight">{title}</h1>
              </div>
            )}
            <div className="flex min-w-0 flex-none items-center justify-end gap-1.5">
              {right}
              <div className="hidden items-center gap-1.5 sm:flex">
                {menuItems.map((action) => (
                  <DesktopHeaderAction key={action.label} action={action} />
                ))}
                {showThemeToggle && <ThemeToggle />}
              </div>
              {(menuItems.length > 0 || showThemeToggle) && (
                <div className="sm:hidden">
                  <MoreActionsMenu actions={menuItems} showThemeToggle={showThemeToggle} />
                </div>
              )}
            </div>
          </div>
        )}
        {/* 附加行：需要整行宽度的内容（如搜索框）放这里，不要塞进 `left`。 */}
        {children !== undefined && <div className="pb-3">{children}</div>}
      </div>
    </header>
  );
}

function DesktopHeaderAction({ action }: { action: PageHeaderAction }): React.JSX.Element {
  if (action.icon !== undefined && action.iconOnly === true) {
    return (
      <HeaderButton label={action.label} onClick={action.onClick} disabled={action.disabled ?? false}>
        {action.icon}
      </HeaderButton>
    );
  }

  return (
    <HeaderTextButton label={action.label} onClick={action.onClick} disabled={action.disabled ?? false}>
      {action.icon !== undefined ? (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-5 w-5">
            {action.icon}
          </span>
          <span>{action.label}</span>
        </span>
      ) : undefined}
    </HeaderTextButton>
  );
}

interface MoreActionsMenuProps {
  actions: readonly PageHeaderAction[];
  showThemeToggle: boolean;
}

function MoreActionsMenu({ actions, showThemeToggle }: MoreActionsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 触发按钮和弹层共用一个外部边界，否则再次点击触发按钮会先关后开，看起来无法关闭。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const wrapper = wrapperRef.current;
      if (wrapper !== null && event.target instanceof Node && !wrapper.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="flex h-11 w-11 items-center justify-center rounded-full text-text-primary transition-colors hover:bg-surface-overlay active:bg-surface-overlay"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M5 7h14M5 12h14M5 17h14" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <HeaderActionsPopover actions={actions} showThemeToggle={showThemeToggle} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

interface HeaderActionsPopoverProps extends MoreActionsMenuProps {
  onClose: () => void;
}

function HeaderActionsPopover({ actions, showThemeToggle, onClose }: HeaderActionsPopoverProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstEnabledRef = useRef<HTMLButtonElement>(null);
  const resolved = useResolvedTheme();
  const toggleTheme = useThemeStore((state) => state.toggle);
  const themeLabel = resolved === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  const firstEnabledIndex = actions.findIndex((action) => action.disabled !== true);

  useFocusTrap(menuRef, { onClose });

  // 焦点主动进入菜单后，`useFocusTrap` 才能接管 Tab；全禁用时主题项或面板本身兜底。
  useEffect(() => {
    firstEnabledRef.current?.focus();
    if (firstEnabledRef.current === null) {
      menuRef.current?.focus();
    }
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="更多操作"
      tabIndex={-1}
      className="absolute right-0 top-full z-40 mt-1 min-w-44 overflow-hidden rounded-xl bg-surface-raised py-1 shadow-xl ring-1 ring-border-subtle"
    >
      {actions.map((action, index) => {
        const content = (
          <>
            {action.icon !== undefined && (
              <span aria-hidden className="flex h-5 w-5 flex-none items-center justify-center">
                {action.icon}
              </span>
            )}
            <span>{action.label}</span>
          </>
        );
        if (action.disabled) {
          // 原生 `disabled` 不属于 menuitem 的 ARIA 状态；不可用项退出 Tab 顺序但仍保留可读标签。
          return (
            <div
              key={action.label}
              role="menuitem"
              aria-disabled="true"
              tabIndex={-1}
              className="flex min-h-11 w-full cursor-not-allowed items-center gap-3 px-3 text-left text-sm text-text-primary opacity-50"
            >
              {content}
            </div>
          );
        }
        return (
          <button
            key={action.label}
            ref={index === firstEnabledIndex ? firstEnabledRef : undefined}
            type="button"
            role="menuitem"
            onClick={() => {
              action.onClick();
              onClose();
            }}
            className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-overlay"
          >
            {content}
          </button>
        );
      })}
      {showThemeToggle && (
        <button
          ref={firstEnabledIndex === -1 ? firstEnabledRef : undefined}
          type="button"
          role="menuitem"
          onClick={() => {
            toggleTheme();
            onClose();
          }}
          className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-overlay"
        >
          <ThemeIcon resolved={resolved} />
          <span>{themeLabel}</span>
        </button>
      )}
    </div>
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
      <ThemeIcon resolved={resolved} />
    </button>
  );
}

function ThemeIcon({ resolved }: { resolved: 'dark' | 'light' }): React.JSX.Element {
  return resolved === 'dark' ? (
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
  );
}

/** 顶栏图标按钮。命中区域 44×44，满足触摸目标要求。 */
export interface HeaderButtonProps {
  label: string;
  onClick: () => void;
  /** 图标。省略时直接渲染 `label` 文本。 */
  children?: React.ReactNode;
  /**
   * 禁用态，默认 `false`。用于「请求进行中」：禁用后连点不会再发请求。
   *
   * 禁用时同时输出 `aria-busy`，让屏幕阅读器知道按钮正在忙，而不只是「不可用」。
   * 未禁用时**不输出** `aria-busy="false"`：那是噪音，辅助技术默认就当它不存在。
   */
  disabled?: boolean;
}

export function HeaderButton({ label, onClick, children, disabled = false }: HeaderButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      // `title` 与 `aria-label` 同文：鼠标用户能看到「随机看一部」这样的提示，
      // 否则纯图标按钮在桌面端是个猜谜游戏。
      title={label}
      disabled={disabled}
      aria-busy={disabled ? true : undefined}
      onClick={() => {
        // `<button disabled>` 已阻止点击，这层判断只是保险：禁用态由调用方通过
        // state 控制，中间可能有一帧 class 生效但事件已入队。
        if (disabled) {
          return;
        }
        onClick();
      }}
      // 光学对齐：44px 命中区内居中一个 20px 图标，图标左侧留白 12px。
      // 因此向左外扩 12px（`-ml-3`），图标左沿才与正文内容左边界严格重合。
      // 用 `-ml-2`（8px）会差 4px，肉眼可辨。
      //
      // 禁用态用 `disabled:` 变体而不是拼接字符串：hover 底色必须一起关掉，
      // 否则鼠标划过禁用按钮仍会亮起，看起来像还能点。
      className="-ml-3 flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-primary transition-colors hover:bg-surface-overlay active:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:active:bg-transparent"
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
  /**
   * 禁用态，默认 `false`。用于「异步操作进行中」：禁用后连点不会再触发一次。
   *
   * 与 `HeaderButton` 的同名 prop 完全对称（同样的 `aria-busy`、同样的
   * `disabled:` 变体、同样的 handler 提前返回）：两个顶栏按钮都放在同一行里，
   * 禁用行为不一致会让「为什么这个能连点、那个不能」变成要读源码才知道的事。
   */
  disabled?: boolean;
}

export function HeaderTextButton({
  label,
  onClick,
  children,
  disabled = false,
}: HeaderTextButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={disabled ? true : undefined}
      onClick={() => {
        // 与 `HeaderButton` 同样的保险：禁用态由调用方通过 state 控制，中间可能
        // 有一帧 class 已生效但事件已入队。
        if (disabled) {
          return;
        }
        onClick();
      }}
      // 同上：`px-3` 是 12px，向左外扩 12px 让文字左沿对齐正文。
      // 禁用态必须把 hover / active 底色一起关掉，否则鼠标划过禁用按钮仍会
      // 亮起，看起来像还能点。
      className="-ml-3 flex h-11 flex-none items-center rounded-full px-3 text-sm text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text-primary active:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:active:bg-transparent"
    >
      {children ?? label}
    </button>
  );
}
