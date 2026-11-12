/**
 * 搜索词归一化。
 *
 * 上游搜索接口对全角标点很敏感：实测搜「长生，）」返回空结果，搜「长生」正常。
 * 所以调用上游之前先把用户输入收敛成上游能识别的形式。
 *
 * 只做三件事（不做大小写折叠、不做 Unicode 变体折叠）：全角转半角、去首尾标点与
 * 空白、折叠连续空白。范围刻意收窄——每多一条规则就多一类「用户输入被悄悄改写」
 * 的可能，而搜索页的 `keyword` 会原样显示在结果标题里。
 */

/** 全角 ASCII 字符：U+FF01 `！` 到 U+FF5E `～`。 */
const FULLWIDTH_ASCII = /[\uFF01-\uFF5E]/g;
/** 全角与半角的码位差（U+FF01 − U+0021）。 */
const FULLWIDTH_OFFSET = 0xfee0;
/** 全角空格 U+3000。不在上面的区间内，单独处理。 */
const IDEOGRAPHIC_SPACE = /\u3000/g;

/**
 * 需要从首尾剥离的字符：空白 + 常见中英文标点。
 *
 * 全角标点在第一步已被转成 ASCII，这里保留全角集合只是为了让规则本身读得懂
 * 「中文标点也算标点」，不依赖转换顺序。`「」` 与 `《》` 是中文引号/书名号，
 * 用户复制剧名时经常带上。
 */
const EDGE_CHARS = String.raw`\s，。、；：？！“”‘’（）【】《》「」,.;:?!"'()\[\]{}<>~`;
const EDGE_PUNCTUATION = new RegExp(`^[${EDGE_CHARS}]+|[${EDGE_CHARS}]+$`, 'g');

const WHITESPACE_RUN = /\s+/g;

/** 归一化搜索词：全角转半角、去首尾标点与空白、折叠连续空白。 */
export function normalizeSearchText(input: string): string {
  const halfwidth = input
    .replace(FULLWIDTH_ASCII, (char) => String.fromCharCode(char.charCodeAt(0) - FULLWIDTH_OFFSET))
    .replace(IDEOGRAPHIC_SPACE, ' ');

  // 顺序有讲究：先剥首尾标点，再折叠空白。反过来的话「长生 ，」中间的标点会
  // 变成「长生 ,」里的内部字符而保留下来，但它其实在原文末尾。
  return halfwidth.replace(EDGE_PUNCTUATION, '').replace(WHITESPACE_RUN, ' ').trim();
}
