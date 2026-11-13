/**
 * 返回目标路由。
 *
 * **为什么不走 `history.back()`**：直接打开分享链接（或从微信、QQ 的内置
 * 浏览器点进来）时，history 栈里没有本站的上一页，`back()` 要么什么都不做，
 * 要么把用户弹回外部应用甚至关闭标签页。用显式目标路由，无论从哪进来都能
 * 回到站内一个确定的页面。
 *
 * **为什么用 `replace: true`**：显式目标是「回父级」，不是「前进到新页面」。
 * 用 push 会留下 `/ → /history → /` 这样的栈，用户再按浏览器后退又回到
 * `/history`，形成回环。replace 把当前页替换成目标页，栈保持线性。
 */

/** 首页路径。列表页的返回目标。 */
export const HOME_PATH = '/';

/**
 * 播放页的返回目标。
 *
 * 优先回剧集详情页：用户从详情页点「开始观看」进来时，这是唯一的上下文。
 * `seriesId` 为空说明是直接打开的单集链接，站内没有详情页可回，退回首页。
 */
export function playerBackTarget(seriesId: string | null | undefined): string {
  if (seriesId === null || seriesId === undefined || seriesId === '') {
    return HOME_PATH;
  }
  return `/series/${encodeURIComponent(seriesId)}`;
}
