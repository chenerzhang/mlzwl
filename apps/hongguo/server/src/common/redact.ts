/**
 * 跨边界的错误信息脱敏。
 *
 * 上游错误消息里经常夹着带签名的完整地址（`?sign=...`、`spade_a=...`），而这类
 * 字符串有两个出口：写进服务端日志、经 `MediaError` 回到浏览器。两个出口都不得
 * 出现临时凭证，所以统一在这里过一道。
 *
 * 四条规则：
 * 1. URL 只留 `protocol + host + pathname`，丢掉 userinfo、query、fragment。
 * 2. 裸键值对（没有 URL 上下文的 `sign=abc`）按值抹掉。
 * 3. 本项目的签名头（`x-gorgon` / `x-argus` / `x-ladon` / `x-ss-stub` / …）按值抹掉，
 *    header 风格（`x-argus: <token>`）与 query 风格（`x-ss-stub=<token>`）都算。
 * 4. 长度上限 4096，超出截断。
 *
 * **幂等**：`redact(redact(x)) === redact(x)`。脱敏后的输出仍会被再次脱敏（例如
 * 日志层再挡一次），不幂等的话每过一层都会变形。
 */

/** 单条消息的长度上限。上游错误里偶尔带整段 HTML，超过这个长度只保留开头。 */
const MAX_LENGTH = 4096;

/** 被抹掉的值统一替换成它。方括号让日志里一眼看出「这里被脱敏了」。 */
const MASK = '[redacted]';

/**
 * 形如 URL 的片段。
 *
 * 排除引号、尖括号与括号：日志里 URL 通常被 `"` 或 `()` 包住，把它们算进 URL 会让
 * `new URL()` 解析失败，白白丢成 `(invalid url)`。
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>()]+/g;

/**
 * 头字段：值一直到行尾。
 *
 * `Authorization: Bearer <token>` 里的 `Bearer` 只是方案名，真正的凭据在后半截，
 * 所以不能只抹到第一个空格。`Cookie` 同理（`a=1; b=2` 是一整串）。
 */
const HEADER_PATTERN = /\b(authorization|cookie)(\s*[:=]\s*)[^\r\n]+/gi;

/**
 * 本项目上游 SDK 的签名头与身份头。
 *
 * 键名自带连字符（`x-argus`、`x-ss-req-ticket`），所以前边界写成
 * `(?<![A-Za-z0-9])`：断言的是键名**开头那个 `x`/`s`** 的前一个字符，连字符在键名
 * 内部，不参与边界判断。（`\b` 在这里其实也成立——`-` 是非单词字符，`x` 是单词
 * 字符，两者之间就是词边界；但两个模式用同一种写法更容易核对，也不给后续加键名
 * 留坑。）
 *
 * `set-cookie` 必须显式列出：现有的 `cookie` 键靠 `\b` 也能撞上 `set-cookie`，但那是
 * 巧合——`\b` 只保证键名后面是分隔符，改一次写法就会漏。
 */
const SIGNATURE_KEY_SOURCE = 'x-gorgon|x-argus|x-ladon|x-ss-stub|x-ss-req-ticket|x-khronos|x-tt-trace-id|set-cookie';

/**
 * 签名头的 header 风格：`x-argus: <token>`，值一直到行尾。
 *
 * 与 `HEADER_PATTERN` 同样吃到行尾：`x-tt-trace-id: 00-abc,00-def` 这类值是整串，
 * 只抹第一个逗号之前等于把后半截留在日志里。
 */
const SIGNATURE_HEADER_PATTERN = new RegExp(`(?<![A-Za-z0-9])(${SIGNATURE_KEY_SOURCE})(\\s*:\\s*)[^\\r\\n]+`, 'gi');

/**
 * 签名头的 query 风格：`x-ss-stub=<token>`，值停在分隔符处。
 *
 * 不能也吃到行尾：`?x-ss-stub=def&next=1` 里的 `next=1` 是排障要用的上下文，
 * 一并抹掉会让日志失去价值。
 */
const SIGNATURE_PARAM_PATTERN = new RegExp(`(?<![A-Za-z0-9])(${SIGNATURE_KEY_SOURCE})(\\s*=\\s*)([^\\s&;,"']+)`, 'gi');

/**
 * 查询串或裸键值对。
 *
 * 只认 `=`：把 `:` 也当分隔符会误伤「content key: missing」这类正常叙述，头字段
 * 交给 `HEADER_PATTERN` 单独处理。长键名放在前面：`signature` 必须排在 `sign`
 * 之前，否则 `sign` 先匹配、剩下的 `ature` 会留在输出里。
 *
 * 前边界用 `(?<![A-Za-z0-9])` 而不是 `\b`：`csrf_token=abc` 里 `token` 前面是 `_`，
 * 两个都是单词字符，`\b` 不成立，漏掉一个真正需要抹的键；而 `monkey=1` 里 `key`
 * 前面是字母，应当放过。
 */
const SECRET_PATTERN =
  /(?<![A-Za-z0-9])(spade_a|content_key|contentkey|signature|sign|token|key)(\s*=\s*)([^\s&;,"']+)/gi;

/**
 * 脱敏一条消息。日志与响应体都走它。
 *
 * 先处理 URL 再处理裸键值：URL 里的 `?sign=abc` 会随 query 一起被丢掉，剩下的
 * 裸键值只可能是本来就没有 URL 上下文的片段。
 */
export function redact(input: string): string {
  const stripped = input.replace(URL_PATTERN, stripUrl);
  const masked = stripped
    .replace(HEADER_PATTERN, (_all: string, key: string, separator: string) => `${key}${separator}${MASK}`)
    .replace(SIGNATURE_HEADER_PATTERN, (_all: string, key: string, separator: string) => `${key}${separator}${MASK}`)
    .replace(SIGNATURE_PARAM_PATTERN, (_all: string, key: string, separator: string) => `${key}${separator}${MASK}`)
    .replace(SECRET_PATTERN, (_all: string, key: string, separator: string) => `${key}${separator}${MASK}`);
  return truncate(masked);
}

/**
 * 截断到 `MAX_LENGTH`。
 *
 * 落点如果在 `[redacted]` 中间，退回到该标记之前：半个标记会让下一次脱敏把
 * `[redac` 当成值再抹一遍，输出就变了，幂等性会破。
 */
function truncate(text: string): string {
  if (text.length <= MAX_LENGTH) {
    return text;
  }
  let head = text.slice(0, MAX_LENGTH);
  const lastOpen = head.lastIndexOf('[');
  if (lastOpen !== -1 && !head.slice(lastOpen).includes(']')) {
    head = head.slice(0, lastOpen);
  }
  return `${head}…`;
}

/**
 * 把错误压成可安全跨边界的两段文本。
 *
 * 只取 `name` 与脱敏后的 `message`：`stack` 里有源码路径与调用链，回给浏览器毫无
 * 用处，进日志也只是噪音。
 */
export function redactError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name === '' ? 'Error' : error.name, message: redact(error.message) };
  }
  return { name: 'unknown', message: redact(String(error)) };
}

/** 只保留 `protocol + host + pathname`；解析不了就整体替换，宁可丢信息也不留原文。 */
function stripUrl(match: string): string {
  try {
    const parsed = new URL(match);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(invalid url)';
  }
}
