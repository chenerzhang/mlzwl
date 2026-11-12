/**
 * 缓存键构造。
 *
 * 用固定分隔符拼接字段是不可靠的：`z.string()` 允许 NUL，URL 里的 `%00` 也能
 * 还原成真实 NUL 字节，所以 `{ content: 'a\0b', board: 'c' }` 与
 * `{ content: 'a', board: 'b\0c' }` 会拼出同一个键。用 `?? 'first'` 之类的
 * 默认值同样会与字面量 `"first"` 相撞。
 *
 * `JSON.stringify` 对字符串数组做转义，且用 `null` 表示「字段缺失」，因此
 * 缺失、空串、含分隔符的值都能被区分开。
 */
export function cacheKeyOf(...parts: readonly (string | undefined)[]): string {
  return JSON.stringify(parts.map((part) => part ?? null));
}
