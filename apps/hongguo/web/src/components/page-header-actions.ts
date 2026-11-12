export interface PageHeaderMenuItemSource {
  label: string;
  disabled?: boolean;
}

export type PageHeaderMenuItem<T extends PageHeaderMenuItemSource> = T & {
  disabled: boolean;
};

/**
 * 过滤条件操作并统一禁用态，菜单渲染因此不必在每个分支重复处理缺省值。
 */
export function buildMenuItems<T extends PageHeaderMenuItemSource>(
  actions: readonly (T | undefined)[],
): PageHeaderMenuItem<T>[] {
  return actions
    .filter((action): action is T => action !== undefined)
    .map((action) => ({ ...action, disabled: action.disabled ?? false }));
}
