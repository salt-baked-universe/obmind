/**
 * 节点几何：从 markmap 渲染出的 DOM 里读出每个节点的位置与尺寸，
 * 并据此算出卡片矩形、连线路径。
 *
 * 这里全部是纯函数，不持有状态、不碰样式，方便复用与单测。
 * 读取时只用 getAttribute（属性字符串），刻意不用 getBBox / getComputedStyle /
 * transform.baseVal.consolidate()——那些会强制浏览器同步布局，在缩放和动画里
 * 每帧调用就是掉帧的元凶。
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

/** markmap 的 paddingX 选项值：foreignObject 在节点 g 内的 x 偏移 */
export const CONTENT_X = 6;

const TRANSLATE_RE = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个节点在绘制时需要的全部几何信息（坐标均相对节点自身 g） */
export interface NodeBox {
  g: SVGGElement;
  fo: SVGForeignObjectElement;
  path: string;
  depth: number;
  /** 节点 g 的 translate 原点 */
  ox: number;
  oy: number;
  /** foreignObject 内容宽高（markmap 已算好） */
  w: number;
  h: number;
  /** 卡片相对内容向外扩展的内边距 */
  padX: number;
  padY: number;
  /**
   * 该节点是否有孩子 —— 决定收放点该不该显示。
   *
   * 读的是节点数据而不是 DOM 里的 `r` 属性：markmap 在节点失去全部孩子后
   * 既不删那个 `<circle>`，也不把 `r` 归零，DOM 上完全看不出它已经是叶子。
   */
  hasChildren: boolean;
}

/** 取 g 的 translate 位移；解析不了就返回 null（宁可少画，也不读布局） */
export function readTranslate(g: SVGGElement): Point | null {
  return translateOf(g.getAttribute("transform"));
}

/**
 * 解析 transform 字符串里的 translate。
 *
 * 单独抽出来是因为日志要拿 `MutationRecord.oldValue` 比对新旧位移：
 * 「这一批到底是真的挪了，还是把同一个值又写了一遍」是判断闪烁的分水岭。
 */
export function translateOf(raw: string | null | undefined): Point | null {
  if (!raw) return null;
  const m = TRANSLATE_RE.exec(raw);
  if (!m) return null;
  return { x: Number.parseFloat(m[1]), y: Number.parseFloat(m[2]) };
}

/**
 * 「DOM 落后于布局」的量化报告。
 *
 * 为什么需要它：我们的卡片是按 `transform` 属性画的，而 `transform` 是 d3 在
 * **过渡的第一帧**才写进去的 —— `await mm.setData()` 返回时，刚 enter 的节点
 * 还停在 `renderData` 里那句同步 `$.attr("transform", …)` 写的**起点**
 * （起点统一是父节点的右下角，全量 enter 时等于根节点的右下角）。
 * 这一瞬间去画，卡片就出现在「根节点角落」，等 d3 把终点写进来再飞回去 ——
 * 用户看到的就是「新建节点，下面的节点飘到远处再飘回来」。
 *
 * `state.rect` 是 `_relayout()` 算出来的**真值**，与 DOM 里那个属性无关。
 * 两者差多少，就是「这一帧画错多少像素」。只读 getAttribute，不读布局。
 */
export interface LagReport {
  /** 位置与布局真值不一致的节点数 */
  n: number;
  /** 其中最大的差距（px） */
  max: number;
  /** `state.rect` 还是 0 的节点数（布局没把它算进去） */
  fresh: number;
  /** 差距最大的那个：`path@px` */
  worst: string;
}

export function measureLayoutLag(svg: SVGSVGElement): LagReport {
  const rep: LagReport = { n: 0, max: 0, fresh: 0, worst: "" };
  for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
    const node = (g as SVGGElement & {
      __data__?: { state?: { path?: string; rect?: { x: number; y: number; width: number; height: number } } };
    }).__data__;
    const rect = node?.state?.rect;
    if (!rect) continue;
    // 布局里宽度为 0 = 这个节点还没被算进去（新 enter 的第一次 renderData）
    if (rect.width <= 0 || rect.height <= 0) {
      rep.fresh++;
      continue;
    }
    const at = readTranslate(g);
    if (!at) continue;
    const d = Math.hypot(at.x - rect.x, at.y - rect.y);
    if (d <= 1) continue;
    rep.n++;
    if (d > rep.max) {
      rep.max = d;
      rep.worst = `${node?.state?.path ?? "?"}@${Math.round(d)}`;
    }
  }
  return rep;
}

/** "0.2.1" → 2（根节点为 0）。比 node.state.depth 可靠。 */
export function depthOf(path: string): number {
  let n = 0;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) === 46 /* . */) n++;
  }
  return n;
}

/** "0.2.1" → "0.2"；根节点返回空串 */
export function parentPathOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * 取节点在 markmap 里的路径（"0.2.1" 这种）。
 * d3 把绑定数据挂在元素上，这是唯一不读布局就能拿到节点身份的方式。
 */
export function nodePathOf(g: SVGGElement): string | null {
  const node = (g as SVGGElement & { __data__?: { state?: { path?: unknown } } }).__data__;
  const path = node?.state?.path;
  return typeof path === "string" ? path : null;
}

/** 直接子元素里找指定标签。比 `querySelector(":scope > x")` 快得多 ——
 *  折叠动画每帧要对几百个节点读几何，选择器解析的开销会累加出来。 */
function directChild<T extends Element>(g: Element, tag: string): T | null {
  for (let el = g.firstElementChild; el; el = el.nextElementSibling) {
    if (el.tagName === tag) return el as unknown as T;
  }
  return null;
}

/** 从节点 g 读取几何信息，读不到（还没布局）返回 null */
export function readNodeBox(g: SVGGElement): NodeBox | null {
  const path = nodePathOf(g);
  if (!path) return null;

  const fo = directChild<SVGForeignObjectElement>(g, "foreignObject");
  if (!fo) return null;

  const w = Number.parseFloat(fo.getAttribute("width") ?? "");
  const h = Number.parseFloat(fo.getAttribute("height") ?? "");
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

  const origin = readTranslate(g);
  if (!origin) return null;

  const depth = depthOf(path);
  const data = (g as SVGGElement & { __data__?: { children?: unknown[] } }).__data__;
  return {
    g,
    fo,
    path,
    depth,
    ox: origin.x,
    oy: origin.y,
    w,
    h,
    hasChildren: Array.isArray(data?.children) && data.children.length > 0,
    // 卡片在内容四周各外扩一点，模拟内边距（不参与布局，绝不会挤压文字）。
    // 左右留得比上下宽：中文节点在 XMind 里就是左右宽松、上下紧凑，
    // 文字贴边会显得局促，也让人误以为卡片只是「文字外面套了个框」。
    padX: depth === 0 ? 20 : 16,
    padY: depth === 0 ? 7 : 5,
  };
}

/** 卡片矩形（节点局部坐标）。dy 用于画阴影时整体下移。 */
export function cardRect(box: NodeBox, dy = 0): Rect {
  return {
    x: CONTENT_X - box.padX,
    y: -box.padY + dy,
    w: box.w + box.padX * 2,
    h: box.h + box.padY * 2,
  };
}

/** 卡片右边缘的 x（连线起点所在的竖线） */
export function cardRightX(box: NodeBox): number {
  return CONTENT_X + box.w + box.padX;
}

/** 卡片垂直中心 y。上下扩展对称，正好等于内容中线。 */
export function cardCenterY(box: NodeBox): number {
  return box.h / 2;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 折叠圆点的位移量（用 CSS transform 平移，而不是改写 cx/cy）。
 *
 * markmap 每次重渲染都会把圆点的 cx/cy 重置成内容框右下角，
 * 若我们再去改写同一个属性，就是两边抢写——动画期间会看到圆点抖动。
 * 改成写 style.transform 后，d3 写属性、我们写内联样式，两者叠加互不覆盖。
 *
 * @param nativeCx markmap 当前设置的 cx（圆心原始 x）
 * @param nativeCy markmap 当前设置的 cy（圆心原始 y）
 */
export function circleOffset(
  box: NodeBox,
  nativeCx: number,
  nativeCy: number,
): Point {
  return {
    x: round2(cardRightX(box) - nativeCx),
    y: round2(cardCenterY(box) - nativeCy),
  };
}

/**
 * 父 → 子的连线路径（画在子节点局部坐标里）。
 *
 * 从父卡片右边缘的垂直中心，平滑弯到子卡片左边缘的垂直中心。
 * 这是 XMind 的接法；markmap 自带连线接在节点底边，已隐藏。
 */
export function linkPath(child: NodeBox, parent: NodeBox): string {
  const startX = round2(parent.ox + cardRightX(parent) - child.ox);
  const startY = round2(parent.oy + cardCenterY(parent) - child.oy);
  const endX = CONTENT_X - child.padX;
  const endY = round2(cardCenterY(child));

  const span = endX - startX;
  const ctrl = Math.max(10, Math.abs(span) * 0.45);
  const dir = span >= 0 ? 1 : -1;

  const c1x = round2(startX + ctrl * dir);
  const c2x = round2(endX - ctrl * dir);
  return `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;
}
