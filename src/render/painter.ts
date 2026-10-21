/**
 * 节点绘制器：给 markmap 渲染出的每个节点补上卡片 / 阴影 / 自绘连线 / 折叠圆点定位。
 *
 * 为什么不用 CSS 而是插入 SVG 元素：
 * markmap 每次重排都会重建 foreignObject 内部结构，写在那层 div 上的背景、
 * 内边距会被冲掉（卡片会塌成一条线）。只有原生 <rect>/<path> 才稳。
 *
 * 性能设计（关键）：
 * 1. 两条绘制路径——
 *    paintAll()  结构变化（重建导图 / 节点增删 / 切主题）时全量画一遍；
 *    paintLinks() 只有节点位移（折叠展开动画）时只更新连线。
 *    卡片画在节点局部坐标里，跟节点位移无关，所以动画期间完全不用碰它。
 * 2. 读写分离——先一次性读完所有节点几何，再统一写属性，避免读写交错引发
 *    浏览器的强制同步布局（layout thrashing）。
 * 3. 分组签名——尺寸没变不重写宽高、配色没变不重写颜色、路径没变不重写 d。
 * 4. 零滤镜——阴影用一个偏移的深色 <rect> 模拟，不用 filter: drop-shadow。
 *    每个节点挂滤镜等于给每个节点建一张离屏图，缩放时必掉帧。
 */

import { branchIndex, nodeStyleAt } from "../theme";
import type { ThemeSpec } from "../theme";
import {
  SVG_NS,
  cardRect,
  circleOffset,
  linkPath,
  parentPathOf,
  readNodeBox,
} from "./geometry";
import type { NodeBox } from "./geometry";

const CLS_SHADOW = "obmind-node-shadow";
const CLS_LINK = "obmind-node-link";
const CLS_CARD = "obmind-node-card";

/**
 * 收放点的缩放系数。
 *
 * markmap 原生 r=6、描边 1.5，视觉直径约 13px —— 比卡片里的文字还抢眼。
 * 缩到 0.7（直径约 9px）既点得中，又不压住内容。
 *
 * 用 scale 而不是改 `r` 属性：r 由 markmap 的 transition 一路写（0→6），
 * 两边抢写同一个属性正是之前「收放点抖动」的根源；transform 与属性是叠加关系，
 * 各写各的，互不覆盖。
 */
const FOLD_SCALE = 0.7;

/** 每个节点的绘制缓存：元素引用 + 各维度上次写入的值 */
interface Entry {
  g: SVGGElement;
  shadow: SVGRectElement | null;
  link: SVGPathElement | null;
  card: SVGRectElement | null;
  circle: SVGCircleElement | null;
  /**
   * 上次写入的值。刻意存**原始数值**而不是拼接后的签名字符串：
   * 折叠动画期间每帧都要过一遍全部节点，若每次都拼字符串，
   * 上千节点就是每秒几万次临时字符串分配，GC 抖动会直接反映成掉帧。
   */
  w: number;
  h: number;
  themeKey: string;
  depth: number;
  branch: number;
  linkD: string;
  linkBranch: string;
  linkWidth: number;
  circleX: number;
  circleY: number;
}

export class NodePainter {
  private entries = new Map<string, Entry>();

  /** 视图重建导图时调用，丢掉所有缓存 */
  reset(): void {
    this.entries.clear();
  }

  /**
   * 全量绘制：结构发生变化时调用。
   * 只在「重建导图 / 节点增删 / 主题切换」这类低频事件里跑。
   */
  paintAll(svg: SVGSVGElement, spec: ThemeSpec): void {
    const { boxes, byPath } = this.collect(svg);
    if (boxes.length === 0) return;

    // 主题键提到循环外：折叠动画每帧都会走到这里，按节点拼一次字符串
    // 在两千节点的笔记上就是每秒几万次临时分配
    const themeKey = `${spec.id}|${spec.dark ? 1 : 0}`;
    for (const box of boxes) {
      const entry = this.entryOf(box);
      this.ensureLayers(box.g, entry);

      this.applyStyle(box, entry, spec, themeKey);
      this.applySize(box, entry);
      this.applyCircle(box, entry);

      if (box.depth === 0) continue;
      const parent = byPath.get(parentPathOf(box.path));
      if (parent) this.applyLink(box, parent, entry, spec);
    }

    this.prune(boxes);
  }

  /**
   * 只更新连线：节点位移时调用（折叠/展开的 180ms 动画里每帧都会来一次）。
   *
   * @param only 本帧发生位移的节点 path 集合；null 表示全部重算。
   *             传入集合时只处理「自己动了」和「父节点动了」的节点，
   *             节点越多收益越明显。
   */
  paintLinks(
    svg: SVGSVGElement,
    spec: ThemeSpec,
    only: Set<string> | null = null,
  ): void {
    // 先按节点数据里的 path（纯 JS 对象，不读 DOM 属性）筛出这一帧真正要碰的节点。
    // 折叠动画每帧都会进来一次，若每次都给全部节点做 readNodeBox，
    // 上千节点时每帧要读上万个 SVG 属性 —— 这正是「折叠/展开时发涩」的来源。
    const needed = new Set<string>();
    if (only) {
      for (const path of only) {
        needed.add(path);
        // 父节点也要量：连线的起点在父卡片右沿
        needed.add(parentPathOf(path));
      }
    }

    const boxes: NodeBox[] = [];
    const byPath = new Map<string, NodeBox>();
    for (const el of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      if (only) {
        const data = (el as SVGGElement & {
          __data__?: { state?: { path?: string } };
        }).__data__;
        const path: string | undefined = data?.state?.path;
        if (!path || !needed.has(path)) continue;
      }
      const box = readNodeBox(el);
      if (!box) continue;
      boxes.push(box);
      byPath.set(box.path, box);
    }
    if (boxes.length === 0) return;

    for (const box of boxes) {
      if (box.depth === 0) continue;
      const parentPath = parentPathOf(box.path);
      if (only && !only.has(box.path) && !only.has(parentPath)) continue;

      const parent = byPath.get(parentPath);
      if (!parent) continue;

      const entry = this.entryOf(box);
      if (!entry.link) this.ensureLayers(box.g, entry);
      this.applyLink(box, parent, entry, spec);
    }
  }

  /** 一次性读完所有节点几何，供写阶段使用 */
  private collect(svg: SVGSVGElement): {
    boxes: NodeBox[];
    byPath: Map<string, NodeBox>;
  } {
    const boxes: NodeBox[] = [];
    const byPath = new Map<string, NodeBox>();
    for (const el of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const box = readNodeBox(el);
      if (!box) continue;
      boxes.push(box);
      byPath.set(box.path, box);
    }
    return { boxes, byPath };
  }

  /** 取（或重建）节点缓存。g 被 markmap 重建、元素掉出 DOM 时都要重置。 */
  private entryOf(box: NodeBox): Entry {
    const cached = this.entries.get(box.path);
    if (cached && cached.g === box.g && cached.card?.isConnected) return cached;

    const g = box.g;
    const entry: Entry = {
      g,
      shadow: g.querySelector<SVGRectElement>(`:scope > rect.${CLS_SHADOW}`),
      link: g.querySelector<SVGPathElement>(`:scope > path.${CLS_LINK}`),
      card: g.querySelector<SVGRectElement>(`:scope > rect.${CLS_CARD}`),
      circle: g.querySelector<SVGCircleElement>(":scope > circle"),
      w: -1,
      h: -1,
      themeKey: "",
      depth: -1,
      branch: -1,
      linkD: "",
      linkBranch: "",
      linkWidth: -1,
      circleX: Number.NaN,
      circleY: Number.NaN,
    };
    this.entries.set(box.path, entry);
    return entry;
  }

  /** 节点被 markmap 移除后，缓存跟着清掉（path 可能被复用） */
  private prune(boxes: NodeBox[]): void {
    if (this.entries.size === boxes.length) return;
    const alive = new Set(boxes.map((b) => b.path));
    for (const key of Array.from(this.entries.keys())) {
      if (!alive.has(key)) this.entries.delete(key);
    }
  }

  /**
   * 保证三个自绘元素存在，且 z 序固定为 阴影 → 连线 → 卡片 → markmap 原有内容。
   * 已经有序时只做几次属性比较，不碰 DOM。
   */
  private ensureLayers(g: SVGGElement, entry: Entry): void {
    const shadow = entry.shadow;
    const link = entry.link;
    const card = entry.card;
    if (
      shadow && link && card &&
      shadow.isConnected && link.isConnected && card.isConnected &&
      shadow.nextElementSibling === link &&
      link.nextElementSibling === card
    ) {
      return;
    }

    const anchor = this.anchorOf(g);
    if (!entry.shadow) entry.shadow = this.createElement("rect", CLS_SHADOW) as SVGRectElement;
    if (!entry.link) entry.link = this.createElement("path", CLS_LINK) as SVGPathElement;
    if (!entry.card) entry.card = this.createElement("rect", CLS_CARD) as SVGRectElement;

    // insertBefore 对已存在元素等价于移动，重复插入也能纠正顺序
    g.insertBefore(entry.shadow, anchor);
    g.insertBefore(entry.link, anchor);
    g.insertBefore(entry.card, anchor);
    entry.circle = g.querySelector<SVGCircleElement>(":scope > circle");
  }

  /** markmap 自己的第一个子元素（连线/卡片都插在它前面） */
  private anchorOf(g: SVGGElement): Element | null {
    for (const child of Array.from(g.children)) {
      const cls = child.classList;
      if (cls.contains(CLS_SHADOW) || cls.contains(CLS_LINK) || cls.contains(CLS_CARD)) continue;
      return child;
    }
    return null;
  }

  private createElement(tag: "rect" | "path", cls: string): SVGElement {
    const el = document.createElementNS(SVG_NS, tag) as SVGElement;
    el.setAttribute("class", cls);
    return el;
  }

  /** 配色：只在主题 / 层级 / 分支变化时写 */
  private applyStyle(box: NodeBox, entry: Entry, spec: ThemeSpec, themeKey: string): void {
    const card = entry.card;
    const shadow = entry.shadow;
    if (!card || !shadow) return;

    const branch: number = branchIndex(box.path);
    if (
      entry.themeKey === themeKey &&
      entry.depth === box.depth &&
      entry.branch === branch
    ) {
      return;
    }
    entry.themeKey = themeKey;
    entry.depth = box.depth;
    entry.branch = branch;

    const style = nodeStyleAt(spec, box.depth, spec.colors[branch % spec.colors.length]);
    const isRoot = box.depth === 0;
    const radius = Math.max(0, Number.parseFloat(spec.radius) || 0);
    const rx = String(isRoot ? radius + 2 : radius);

    card.setAttribute("fill", style.bg);
    card.setAttribute("opacity", style.bg === "transparent" ? "0" : "1");
    card.setAttribute("rx", rx);

    shadow.setAttribute("fill", spec.dark ? "rgba(0,0,0,0.45)" : "rgba(15,23,42,0.10)");
    shadow.setAttribute("rx", rx);
    shadow.setAttribute("opacity", spec.card ? "1" : "0");

    // 文字色写在 foreignObject 上，节点内容继承（这个不会被 markmap 冲掉）
    box.fo.style.color = style.fg;
  }

  /** 卡片尺寸：只依赖内容宽高，与节点位移无关，所以动画期间零写入 */
  private applySize(box: NodeBox, entry: Entry): void {
    const card = entry.card;
    if (!card) return;
    if (entry.w === box.w && entry.h === box.h) return;
    entry.w = box.w;
    entry.h = box.h;

    const r = cardRect(box);
    card.setAttribute("x", String(r.x));
    card.setAttribute("y", String(r.y));
    card.setAttribute("width", String(r.w));
    card.setAttribute("height", String(r.h));

    if (entry.shadow) {
      const s = cardRect(box, 2);
      entry.shadow.setAttribute("x", String(s.x));
      entry.shadow.setAttribute("y", String(s.y));
      entry.shadow.setAttribute("width", String(s.w));
      entry.shadow.setAttribute("height", String(s.h));
    }
  }

  /**
   * 折叠圆点：移到卡片右边缘中点，并按 FOLD_SCALE 缩小。
   *
   * 两件事都靠 CSS transform 完成，不改 cx/cy/r —— markmap 每次重渲染都会把
   * 这些属性重写一遍，两边抢写同一个属性就会互相打架。
   *
   * 另外这里顺手补上 markmap 的一个缺口：**节点失去全部孩子后，它既不删掉
   * 那个 `<circle>`，也不把 r 归零**（实测 r 仍然是 6）。于是叶子节点右侧会挂
   * 着一个永远点不出东西的收放点 —— 就是「刚操作过的卡片旁边多出一个小圆点」。
   * 判据必须用节点数据里的 children，不能看 DOM 上的 r。
   */
  private applyCircle(box: NodeBox, entry: Entry): void {
    let circle = entry.circle;
    if (!circle || !circle.isConnected) {
      circle = box.g.querySelector<SVGCircleElement>(":scope > circle");
      entry.circle = circle;
      entry.circleX = Number.NaN;
      entry.circleY = Number.NaN;
      if (circle) {
        // 缩放要绕圆点自身中心，否则会绕着 SVG 原点缩放、整个点飞出去。
        // 写内联样式而不是只靠 styles.css：SVG 元素的 transform-origin 默认是
        // 0 0（不是 CSS 那套 50% 50%），样式表一旦没匹配上，位置就会错得很离谱；
        // 内联样式优先级最高，主题改不动它。
        circle.style.setProperty("transform-box", "fill-box");
        circle.style.setProperty("transform-origin", "center");
      }
    }
    if (!circle) return;

    // 判据是节点数据里的 children，不是 DOM 上的 r：
    // markmap 在节点失去全部孩子后既不删 circle、也不把 r 归零（实测仍是 6），
    // 只按 r 判断会把它当成「还有孩子」，叶子卡片右侧就挂着一个点不动的残留点。
    //
    // 这里直接读 style.display 而不是缓存一个布尔：缓存会和 reset() 之后
    // 重新拿到的旧 DOM 对不上（实测过，隐藏了就再也不会显回来）。
    const hidden: boolean = circle.style.display === "none";
    if (!box.hasChildren) {
      if (!hidden) circle.style.display = "none";
      return;
    }
    if (hidden) circle.style.display = "";

    const nativeCx = Number.parseFloat(circle.getAttribute("cx") ?? "");
    const nativeCy = Number.parseFloat(circle.getAttribute("cy") ?? "");
    if (!Number.isFinite(nativeCx) || !Number.isFinite(nativeCy)) return;

    const offset = circleOffset(box, nativeCx, nativeCy);
    if (offset.x === entry.circleX && offset.y === entry.circleY) return;
    entry.circleX = offset.x;
    entry.circleY = offset.y;

    // 变换原点在圆点自身中心，所以 translate 之后再做 scale 只改大小、不改位置：
    // 直径 12 → 8.4，圆心仍精确落在卡片右沿（实测，见 .tmp 的 paint 用例）。
    circle.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${FOLD_SCALE})`;
  }

  /** 自绘连线：父卡片右边缘中点 → 子卡片左边缘中点 */
  private applyLink(
    box: NodeBox,
    parent: NodeBox,
    entry: Entry,
    spec: ThemeSpec,
  ): void {
    const link = entry.link;
    if (!link) return;

    const branch: string = spec.colors[branchIndex(box.path) % spec.colors.length];
    const d = linkPath(box, parent);
    if (entry.linkD === d && entry.linkBranch === branch && entry.linkWidth === spec.linkWidth) {
      return;
    }
    entry.linkD = d;
    entry.linkBranch = branch;
    entry.linkWidth = spec.linkWidth;

    link.setAttribute("d", d);
    link.setAttribute("fill", "none");
    link.setAttribute("stroke", branch);
    link.setAttribute("stroke-width", String(spec.linkWidth));
    link.setAttribute("stroke-linecap", "round");
  }
}
