/**
 * 把当前导图导成一份独立的 SVG 文件。
 *
 * 为什么不直接用 `outerHTML` 一存了事：
 * 1. **坐标**：markmap 把 d3-zoom 的 transform 写在最外层 `<g>` 上，直接存下来
 *    只包含「当前视口看到的那一块」，缩放过就是歪的、平过就只剩半边。
 *    导出必须复位 transform、用内容包围盒当 viewBox，得到的是**整张图**。
 * 2. **样式**：节点文字是 `foreignObject` 里的 HTML，样式来自 Obsidian 的主题
 *    （CSS 变量 + 插件 styles.css）。文件离开 Obsidian 之后这些全失效，
 *    字体、颜色、代码块底色、表格边框一律退回浏览器默认 —— 导出图会变得
 *    和屏幕上完全不是一个东西。所以要把**计算后的**样式内联到每个元素上。
 * 3. **背景**：SVG 默认透明，深色主题的浅色文字放进白底阅读器里就看不见了。
 *
 * 纯逻辑部分（`exportViewBox` / `isOpaqueColor` / `exportFileName`）抽出来是为了
 * 能在 Node 里穷举边界；DOM 那部分只能靠浏览器验证。
 */

import { setOpacity, setVisibility } from "../render/domStyle";

/** markmap `state.rect` 的形状：内容包围盒（未应用 zoom 的坐标系） */
export interface ContentRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 内容包围盒 → viewBox。
 *
 * 留白是必须的：markmap 的 rect 只框住节点本身，卡片阴影和连线端点会溢出边界
 * 被裁掉一点点。宽度不足 2px 认为还没画完（`_relayout` 之前 rect 是 0），
 * 返回 null 让调用方给提示，而不是导出一个 0×0 的空文件。
 */
export function exportViewBox(rect: ContentRect, padding = 24): ViewBox | null {
  const w = rect.x2 - rect.x1;
  const h = rect.y2 - rect.y1;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return null;
  const pad = Number.isFinite(padding) ? Math.max(0, padding) : 24;
  return {
    x: Math.round(rect.x1 - pad),
    y: Math.round(rect.y1 - pad),
    width: Math.round(w + pad * 2),
    height: Math.round(h + pad * 2),
  };
}

/**
 * 这个颜色是否不透明。
 *
 * 用来决定要不要铺背景：`transparent` 和不带 alpha 的 `rgb()` 之外，
 * Obsidian 的很多容器背景是 `rgba(0,0,0,0)`。判据必须读 alpha 分量，
 * **不能**用 `/,0\)$/` 之类的粗糙匹配 —— `rgb(0,0,0)` 是纯黑，会被误判成透明。
 */
export function isOpaqueColor(color: string): boolean {
  const text = (color ?? "").trim();
  if (!text || text === "transparent") return false;

  // getComputedStyle 通常给 rgb()/rgba()，但主题变量里也可能伸手进来 hex
  const hex: RegExpExecArray | null = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const v: string = hex[1];
    if (v.length === 3 || v.length === 6) return true;
    if (v.length === 4) return Number.parseInt(v[3] + v[3], 16) > 2;
    if (v.length === 8) return Number.parseInt(v.slice(6), 16) > 2;
    return false;
  }

  const m: RegExpExecArray | null = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!m) return false;
  const parts: string[] = m[1].split(",").map((s: string) => s.trim());
  if (parts.length < 4) return true;
  const a: number = Number(parts[3]);
  return Number.isFinite(a) ? a > 0.01 : true;
}

/** 导出文件名：跟着笔记名走，重导覆盖同名文件 */
export function exportFileName(basename: string): string {
  const safe: string = (basename || "mindmap")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe || "mindmap"}.mindmap.svg`;
}

/**
 * 需要内联的样式。
 *
 * 刻意不是「把 getComputedStyle 全抄一遍」：每个元素抄几十个属性，
 * 一张 100 节点的图就是上百万字符。这里挑的是**决定观感**的那些 ——
 * 字体、字重、颜色、底色、圆角、边框、内边距、对齐方式。
 */
const COPY_PROPS: readonly string[] = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "border-radius",
  "text-align",
  "text-decoration-line",
  "white-space",
  "overflow-wrap",
  "word-break",
  "vertical-align",
  "display",
  "list-style-type",
];

/** 这些值写进内联样式是噪声（等于没写），跳过能省不少体积 */
const SKIP_VALUES = new Set([
  "",
  "none",
  "normal",
  "auto",
  "0px",
  "0",
  "rgba(0, 0, 0, 0)",
  "transparent",
  "visible",
  "start",
]);

/**
 * 把 `foreignObject` 里每个 HTML 元素的计算样式写进克隆体的内联 style。
 *
 * 原树和克隆体按**下标一一对应**：cloneNode 保留了结构，两边 querySelectorAll
 * 的顺序必然一致。读样式必须读**原树**（克隆体不在文档里，getComputedStyle 拿不到值）。
 */
function inlineForeignStyles(source: SVGSVGElement, clone: SVGSVGElement): void {
  const srcFos: SVGForeignObjectElement[] = Array.from(
    source.querySelectorAll<SVGForeignObjectElement>("foreignObject"),
  );
  const dstFos: SVGForeignObjectElement[] = Array.from(
    clone.querySelectorAll<SVGForeignObjectElement>("foreignObject"),
  );

  for (let i = 0; i < srcFos.length; i++) {
    const dst: SVGForeignObjectElement | undefined = dstFos[i];
    if (!dst) break;
    const srcEls: Element[] = [srcFos[i], ...Array.from(srcFos[i].querySelectorAll("*"))];
    const dstEls: Element[] = [dst, ...Array.from(dst.querySelectorAll("*"))];
    const n: number = Math.min(srcEls.length, dstEls.length);

    for (let k = 0; k < n; k++) {
      const cs: CSSStyleDeclaration = getComputedStyle(srcEls[k]);
      const decls: string[] = [];

      for (const prop of COPY_PROPS) {
        const v: string = cs.getPropertyValue(prop).trim();
        if (!v || SKIP_VALUES.has(v)) continue;
        decls.push(`${prop}:${v}`);
      }

      // 内边距：shorthand 在部分浏览器里拿不到，四个方向自己拼
      const pad: string[] = ["top", "right", "bottom", "left"].map((s: string) =>
        cs.getPropertyValue(`padding-${s}`).trim() || "0px",
      );
      if (pad.some((v: string) => v !== "0px" && v !== "0")) {
        decls.push(`padding:${pad.join(" ")}`);
      }

      // 边框：只处理四边一致的（markmap 的表格、代码块都是这种情况），
      // 不一致就逐边写，保证表格线不丢
      const side = (s: string): string => {
        const w: string = cs.getPropertyValue(`border-${s}-width`).trim() || "0px";
        if (w === "0px" || w === "0") return "";
        const style: string = cs.getPropertyValue(`border-${s}-style`).trim() || "solid";
        const color: string = cs.getPropertyValue(`border-${s}-color`).trim();
        return `${w} ${style} ${color}`;
      };
      const tops: string = side("top");
      if (tops) {
        const all: string[] = ["top", "right", "bottom", "left"].map(side);
        if (all.every((v: string) => v === tops)) decls.push(`border:${tops}`);
        else {
          decls.push(`border-top:${all[0]}`);
          decls.push(`border-right:${all[1]}`);
          decls.push(`border-bottom:${all[2]}`);
          decls.push(`border-left:${all[3]}`);
        }
      }

      if (decls.length === 0) continue;
      // 原有的内联样式放后面：markmap 写在 foreignObject 上的 opacity、
      // painter 写在 fo 上的 color 都必须保住
      const old: string = dst.getAttribute("style") ?? "";
      dst.setAttribute("style", old ? `${decls.join(";")};${old}` : decls.join(";"));
    }
  }
}

/**
 * 删掉「在 Obsidian 里本来就被 CSS 隐藏」的元素。
 *
 * 这是导出最容易翻车的地方，两个最刺眼的 bug 都出自这里：
 *
 * - markmap 自带的 `.markmap-link`（它的连线接在节点底边，和我们的卡片对不上，
 *   所以 `styles.css` 里整条 `display: none`）。CSS 不跟文件走 → 导出后每条
 *   连线都变成**双线**：一条细的（markmap）、一条粗的（我们自绘），还互相错开。
 * - markmap 给每个节点画的 `<line>`（最早「线托着文字」的那条下划线）也被我们
 *   隐藏了，导出后它横在卡片内部 —— 看着就是「卡片中间有一条线」。
 *
 * 判据用**活树的计算样式**而不是写死类名：用户自己的 CSS 片段、主题若改动了
 * 显隐，导出结果自动跟着变，不用改插件。
 *
 * 下标对齐的前提是此时结构还没被改过（`inlineForeignStyles` 之后、删圆点之前）。
 */
function stripHidden(source: SVGSVGElement, clone: SVGSVGElement): void {
  const srcEls: Element[] = Array.from(source.querySelectorAll("*"));
  const dstEls: Element[] = Array.from(clone.querySelectorAll("*"));
  const n: number = Math.min(srcEls.length, dstEls.length);
  for (let i = 0; i < n; i++) {
    if (getComputedStyle(srcEls[i]).display === "none") dstEls[i].remove();
  }
}

export interface SvgExportOptions {
  /** 背景色；不透明才会铺一层 rect */
  background?: string;
  /** 写进 `<title>`，在浏览器/阅读器里作为图片说明 */
  title?: string;
}

/**
 * 生成可独立打开的 SVG 文本。
 *
 * 传进来的 svg 必须是**活的、已渲染完的**那个 —— 要读它的计算样式。
 */
export function buildSvgText(
  svg: SVGSVGElement,
  box: ViewBox,
  opts: SvgExportOptions = {},
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // 顺序很重要：先按原树/克隆体的下标对齐内联样式，之后才能随便改克隆体结构
  inlineForeignStyles(svg, clone);

  // 只有「屏幕上没显示」的东西才需要在这里消失，顺序同样不能提前
  stripHidden(svg, clone);

  // 收放点是运行时的开关：静态图里点不动，摆在那儿只会让人以为「这里能折叠」。
  // 而且它会偏 —— painter 把 `transform-box: fill-box` 写在**内联样式**里没问题，
  // 但 transform 一旦离开 transform-origin 的加持，圆心就落进卡片内部（实测压字）。
  for (const dot of Array.from(clone.querySelectorAll('g[class~="markmap-node"] > circle'))) {
    dot.remove();
  }

  // 选中描边、悬停态不该出现在导出的图里（这些 class 的样式也不在文件里，
  // 留着只是给阅读器的 CSS 留个口子）
  for (const el of Array.from(clone.querySelectorAll(".obmind-selected"))) {
    el.classList.remove("obmind-selected");
  }

  // 淡入淡出残留：折叠动画正跑到一半时导出，会有一半节点是 opacity 0。
  // visibility 是编辑框留下的（它把原文藏起来，好让输入框盖在上面）——
  // 导出的是「这张图」，不是「这一刻的屏幕」，原文得还回来。
  for (const fo of Array.from(clone.querySelectorAll<SVGForeignObjectElement>("foreignObject"))) {
    setOpacity(fo, "");
    setVisibility(fo, "");
    if (fo.getAttribute("style") === "") fo.removeAttribute("style");
  }
  for (const deco of Array.from(clone.querySelectorAll<SVGElement>('[class^="obmind-node"]'))) {
    setOpacity(deco, "");
    if (deco.getAttribute("style") === "") deco.removeAttribute("style");
  }

  // 复位缩放：d3-zoom 把 transform 写在最外层 g 上，存下来只是「当前视口」
  for (const g of Array.from(clone.querySelectorAll<SVGGElement>(":scope > g"))) {
    g.removeAttribute("transform");
  }

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  // 明确宽高：有些阅读器不认只有 viewBox 的 SVG，会按 100% 撑满
  clone.setAttribute("width", String(box.width));
  clone.setAttribute("height", String(box.height));
  // 原来的 width/height 是 100%，留在 style 里会和上面打架
  clone.removeAttribute("style");

  const root: SVGGElement | null = clone.querySelector<SVGGElement>(":scope > g");
  const bg: string = opts.background ?? "";
  if (root && isOpaqueColor(bg)) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(box.x));
    rect.setAttribute("y", String(box.y));
    rect.setAttribute("width", String(box.width));
    rect.setAttribute("height", String(box.height));
    rect.setAttribute("fill", bg);
    clone.insertBefore(rect, root);
  }

  if (opts.title) {
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = opts.title;
    clone.insertBefore(title, clone.firstChild);
  }

  const xml: string = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}
