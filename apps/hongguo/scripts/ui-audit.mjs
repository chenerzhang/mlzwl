/**
 * UI 审计脚本（浏览器内执行）。
 *
 * 用法：把 AUDIT 函数体作为 `page.evaluate` 的参数传入（Playwright MCP 的
 * `browser_run_code_unsafe` 里直接贴函数即可）。返回值是纯 JSON，可直接
 * 抄进 docs/ui-redesign-log.md。
 *
 * 为什么用 canvas 解析颜色：Tailwind 4 的 `bg-scrim/65` 编译成
 * `oklab(0 0 0 / 0.65)`。手写正则只认 `rgb()/rgba()`，遇到 oklab 返回 null，
 * 对比度会算成 1.00 的假失败。canvas 的 fillStyle 支持浏览器认识的全部颜色
 * 语法，getImageData 拿到的就是 sRGB 分量和 alpha。
 *
 * 背景合成：从元素向上收集所有 alpha > 0 的背景色，直到遇到完全不透明层，
 * 再自顶向下逐层 alpha 合成。只读 backgroundColor 不够——角标背景是半透明的，
 * 必须和下面的封面图、卡片底色一起算。
 *
 * 已知测量陷阱：播放器控件约 3.2s 自动隐藏。控件隐藏后点击坐标会落到视频区，
 * 效果是切换控件显示。测量前必须用 document.elementFromPoint(x, y) 确认
 * 命中的就是目标按钮。
 */

export function auditInPage() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const parse = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const over = (f, b) => ({
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (x) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const bgOf = (el) => {
    const stack = [];
    let node = el;
    while (node !== null && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c.a > 0) {
        stack.push(c);
        if (c.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    let base = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (base.a < 0.999) base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i -= 1) base = over(stack[i], base);
    return base;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
    );
  };

  const textFails = [];
  let minText = Number.POSITIVE_INFINITY;
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    const value = ratio(over(fg, bg), bg);
    const size = Number.parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (value < need) {
      textFails.push({
        text: el.textContent.trim().slice(0, 16),
        cls: String(el.className).slice(0, 46),
        ratio: +value.toFixed(2),
      });
    } else {
      minText = Math.min(minText, value);
    }
  }

  // 只检查边框相对于父级背景的对比度。元素自身的填充色不计入：
  // 实心按钮的底色与页面背景本就该有差，那是设计意图，不是可读性问题。
  const borderFails = [];
  for (const el of document.querySelectorAll('button, a, input, [role="slider"]')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (Number.parseFloat(cs.borderTopWidth) === 0) continue;
    const bg = bgOf(el.parentElement ?? el);
    const value = ratio(over(parse(cs.borderTopColor), bg), bg);
    if (value < 3) {
      borderFails.push({
        label: (el.getAttribute('aria-label') ?? el.textContent.trim()).slice(0, 16),
        ratio: +value.toFixed(2),
      });
    }
  }

  // 图标（内联 SVG）的对比度。这是独立于边框的检查：SVG 没有 border-width，
  // 只测边框会把它整类漏掉。取 stroke（描边图标）或 fill（实心图标），
  // 两者都继承 currentColor，所以实际就是文字色的对比度。
  const iconFails = [];
  let iconTotal = 0;
  for (const svg of document.querySelectorAll('svg')) {
    if (!visible(svg)) continue;
    const cs = getComputedStyle(svg);
    const color = cs.stroke && cs.stroke !== 'none' ? cs.stroke : cs.fill && cs.fill !== 'none' ? cs.fill : null;
    if (color === null) continue;
    iconTotal += 1;
    const bg = bgOf(svg);
    const value = ratio(over(parse(color), bg), bg);
    if (value < 3) {
      iconFails.push({
        label: (svg.parentElement?.getAttribute('aria-label') ?? '').slice(0, 16),
        ratio: +value.toFixed(2),
      });
    }
  }

  const cursors = {};
  for (const el of document.querySelectorAll(
    'button, a, [role="button"], [role="slider"], [role="tab"], summary, input, select, textarea, label[for]',
  )) {
    if (!visible(el)) continue;
    const state = el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled';
    const key = `${el.tagName.toLowerCase()}:${state}:${getComputedStyle(el).cursor}`;
    cursors[key] = (cursors[key] ?? 0) + 1;
  }

  const under44 = [];
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="slider"]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 44 || r.width < 44) {
      under44.push({
        label: (el.getAttribute('aria-label') ?? el.textContent.trim()).slice(0, 12),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }

  const grid = document.querySelector('.grid');
  let gridInfo = null;
  if (grid !== null) {
    const kids = [...grid.children];
    const cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
    const rows = new Map();
    for (const kid of kids) {
      const top = Math.round(kid.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    const last = kids[kids.length - 1];
    const firstSkeleton = kids.find((k) => k.tagName === 'DIV');
    gridInfo = {
      cols,
      total: kids.length,
      real: kids.filter((k) => k.tagName === 'BUTTON').length,
      skeleton: kids.filter((k) => k.tagName === 'DIV').length,
      multipleOfColumns: kids.length % cols === 0,
      perRow: [...rows.values()],
      widths: [...new Set(kids.map((k) => Math.round(k.getBoundingClientRect().width)))],
      skeletonSameRowAsLastReal:
        firstSkeleton !== undefined && last !== undefined
          ? Math.abs(firstSkeleton.getBoundingClientRect().top - last.getBoundingClientRect().top) < 2
          : null,
    };
  }

  return {
    theme: document.documentElement.dataset.theme ?? null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    textFails,
    minText: Number.isFinite(minText) ? +minText.toFixed(2) : null,
    borderFails,
    iconFails,
    iconTotal,
    cursors,
    under44,
    grid: gridInfo,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}
