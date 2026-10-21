/**
 * 节点拖拽：把节点拖到别处改变父子关系（XMind 式）。
 *
 * 交互约定（对齐 XMind 的手感）：
 * - **左键按住节点拖动** → 改变父子关系；按下不动就是「选中」，位移超过阈值才算拖
 * - **右键留给菜单**，这里不碰 contextmenu
 * - 拖到目标卡片**中部** → 成为目标的子节点
 * - 拖到目标卡片**上沿** → 排在目标前面（兄弟）
 * - 拖到目标卡片**下沿** → 排在目标后面（兄弟）
 *
 * 三个必须处理的坑：
 * 1. **d3-zoom 会抢走 mousedown**。markmap 用 d3-zoom 绑了画布平移，
 *    在节点上按下会变成拖画布。所以命中节点时要拦掉 mousedown 的冒泡。
 * 2. **不能拖进自己的子树**。用 markmap 自带的孩子索引路径（"0.2.1"）判断，
 *    后代路径一定以 `源路径 + "."` 开头，比算几何范围可靠。
 * 3. **拖拽结束不能触发 click / dblclick**，否则松手会顺带选中
 *    （行号已经变了，选中的是错的节点）或直接进了编辑态。
 */

import type { SrcRef } from "../types";
import type { DropMode } from "./move";

/** 超过这个位移才算拖拽，否则当成普通点击 */
const DRAG_THRESHOLD = 5;

export interface DragCallbacks {
  /** 取节点的源坐标；根节点返回 null（文件名节点不可拖） */
  srcOf: (g: SVGGElement) => SrcRef | null;
  onDrop: (srcLine: number, targetLine: number, mode: DropMode) => void;
}

interface Target {
  g: SVGGElement;
  mode: DropMode;
}

export class DragController {
  private readonly svg: SVGSVGElement;
  private readonly container: HTMLElement;
  private readonly cb: DragCallbacks;

  private layer: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;
  private line: HTMLDivElement | null = null;

  private origin: SVGGElement | null = null;
  private originSrc: SrcRef | null = null;
  private startX = 0;
  private startY = 0;
  private active = false;
  private target: Target | null = null;
  /** 本次拖拽的候选目标，按下时算一次，避免每帧 querySelectorAll */
  private candidates: SVGGElement[] = [];

  constructor(svg: SVGSVGElement, container: HTMLElement, cb: DragCallbacks) {
    this.svg = svg;
    this.container = container;
    this.cb = cb;

    svg.addEventListener("mousedown", this.blockOnNode, true);
    svg.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    // 兜底收尾：窗口失焦、指针被系统打断（拖到窗口外松手）时收不到 pointerup，
    // 而按下时锁了选区 —— 不收拾的话整页文字会一直不可选。
    window.addEventListener("blur", this.onAbort);
    window.addEventListener("pointercancel", this.onAbort);
  }

  destroy(): void {
    this.svg.removeEventListener("mousedown", this.blockOnNode, true);
    this.svg.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("blur", this.onAbort);
    window.removeEventListener("pointercancel", this.onAbort);
    this.reset();
    this.layer?.remove();
    this.layer = null;
  }

  // -------------------------------------------------------------------------

  private onAbort = (): void => {
    if (this.origin) this.reset();
  };

  /** 命中节点时掐断 mousedown，否则 d3-zoom 会把它当成「拖画布」 */
  private blockOnNode = (e: MouseEvent): void => {
    const g = this.nodeAt(e.target as Element);
    if (g) e.stopPropagation();
  };

  private onPointerDown = (e: PointerEvent): void => {
    // 0 = 左键。右键留给菜单（不拦 contextmenu），中键留给画布自己的行为。
    if (e.button !== 0) return;
    const el = e.target as Element;
    // 链接、折叠圆点各有自己的用途
    if (el.closest("a") || el.closest("circle")) return;

    const g = this.nodeAt(el);
    if (!g) return;
    const src = this.cb.srcOf(g);
    if (!src) return; // 根节点不可拖

    // 掐断 pointerdown 的传播，免得某些版本的 d3-zoom 拿它来起手拖画布
    e.stopPropagation();

    this.origin = g;
    this.originSrc = src;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.active = false;
    this.target = null;

    // 按下就锁选区：否则拖出 5px 阈值之前，浏览器已经开始选文字了，
    // 松手时页面上留着一片蓝色高亮。单击（没拖动）也会在 reset 里立刻恢复。
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";

    const srcPath = pathOf(g);
    this.candidates = Array.from(
      this.svg.querySelectorAll<SVGGElement>("g.markmap-node"),
    ).filter((n) => {
      if (n === g) return false;
      const p = pathOf(n);
      // 自己 + 自己的整棵子树都不能当目标
      return !(srcPath && p && (p === srcPath || p.startsWith(srcPath + ".")));
    });
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.origin) return;

    if (!this.active) {
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.active = true;
      this.origin.classList.add("obmind-dragging");
      // 拖拽期间别顺手选中卡片文字（pointerdown 不能 preventDefault，
      // 那会掐掉后续的 click/dblclick，双击编辑就废了）
      document.body.style.userSelect = "none";
      this.ensureLayer();
    }

    e.preventDefault();
    this.target = this.hitTest(e.clientX, e.clientY);
    this.renderHint();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const originSrc = this.originSrc;
    const target = this.target;
    const wasActive = this.active;

    this.reset();

    if (!wasActive || !originSrc || !target) return;

    // 拖拽结束后别让这次松手变成 click / dblclick
    e.preventDefault();
    e.stopPropagation();
    // pointerup 上的 preventDefault 拦不住 click（click 由 down+up 合成），
    // 而拖动之后触发的 click 会按**旧行号**去选中节点 —— 位置已经变了，
    // 选中的就是错的节点。这里显式吞掉紧跟其后的那一次 click。
    swallowNextClick();

    const tgtSrc = this.cb.srcOf(target.g);
    if (!tgtSrc) return;
    this.cb.onDrop(originSrc.line, tgtSrc.line, target.mode);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.origin) this.reset();
  };

  // -------------------------------------------------------------------------

  private nodeAt(el: Element): SVGGElement | null {
    return el.closest("g.markmap-node") as SVGGElement | null;
  }

  /**
   * 目标节点的**卡片外框**（屏幕坐标）。
   *
   * 判定必须用卡片而不是 foreignObject：foreignObject 只是文字盒，卡片左右还各有
   * 16px 内边距，按文字盒判定的话这些区域点上去毫无反应，「拖不准」就是这么来的。
   * 卡片是节点 g 内的自绘 rect，getBoundingClientRect 已经把画布缩放与平移算进去了。
   */
  private cardBoxOf(g: SVGGElement): DOMRect | null {
    const card = g.querySelector<SVGRectElement>(":scope > rect.obmind-node-card");
    const el: Element = card ?? g.querySelector("foreignObject") ?? g;
    const r: DOMRect = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return r;
  }

  /** 找鼠标下方的目标节点，并按纵向位置决定「子节点 / 前面 / 后面」 */
  private hitTest(x: number, y: number): Target | null {
    let best: Target | null = null;
    let bestArea = Infinity;

    for (const g of this.candidates) {
      const r = this.cardBoxOf(g);
      if (!r) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;

      // 多个节点矩形重叠时取面积最小的（通常是真正压在鼠标下的那个）
      const area = r.width * r.height;
      if (area >= bestArea) continue;
      bestArea = area;

      const rel = (y - r.top) / r.height;
      const mode: DropMode = rel < 0.3 ? "before" : rel > 0.7 ? "after" : "child";
      best = { g, mode };
    }
    return best;
  }

  private ensureLayer(): void {
    if (this.layer) return;
    const layer = document.createElement("div");
    layer.className = "obmind-drop-layer";

    const box = document.createElement("div");
    box.className = "obmind-drop-box";
    const line = document.createElement("div");
    line.className = "obmind-drop-line";

    layer.append(box, line);
    this.container.appendChild(layer);
    this.layer = layer;
    this.box = box;
    this.line = line;
  }

  private renderHint(): void {
    const box = this.box;
    const line = this.line;
    if (!box || !line) return;

    if (!this.target) {
      box.style.display = "none";
      line.style.display = "none";
      return;
    }

    const r = this.cardBoxOf(this.target.g);
    if (!r) {
      box.style.display = "none";
      line.style.display = "none";
      return;
    }
    const base = this.container.getBoundingClientRect();
    const left = r.left - base.left;
    const top = r.top - base.top;

    if (this.target.mode === "child") {
      // 描边框正好压在卡片外沿：box 从外扩 2px 起算，与 2px 的 border 严丝合缝
      box.style.display = "block";
      box.style.left = `${left - 2}px`;
      box.style.top = `${top - 2}px`;
      box.style.width = `${r.width + 4}px`;
      box.style.height = `${r.height + 4}px`;
      line.style.display = "none";
      return;
    }

    // 前后插入：横线贴在卡片上下沿的外侧（落在兄弟间的空隙里，读起来就是"插在这"）
    box.style.display = "none";
    line.style.display = "block";
    line.style.left = `${left}px`;
    line.style.width = `${r.width}px`;
    line.style.top = `${this.target.mode === "before" ? top - 4 : top + r.height + 1}px`;
  }

  private reset(): void {
    this.origin?.classList.remove("obmind-dragging");
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    this.origin = null;
    this.originSrc = null;
    this.active = false;
    this.target = null;
    this.candidates = [];
    if (this.box) this.box.style.display = "none";
    if (this.line) this.line.style.display = "none";
  }
}

/**
 * 吞掉紧接着派发的那个 click。
 *
 * 用 capture 拦一次最省事；setTimeout(0) 兜底移除 ——
 * 万一浏览器这次没派发 click，也不会把用户的下一次点击一起吃掉。
 */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("click", swallow, true);
  window.setTimeout(() => document.removeEventListener("click", swallow, true), 0);
}

/** markmap 给每个节点挂的孩子索引路径，如 "0.2.1" */
function pathOf(g: SVGGElement): string {
  const data = (g as SVGGElement & { __data__?: { state?: { path?: string } } }).__data__;
  const path: string | undefined = data?.state?.path;
  return typeof path === "string" ? path : "";
}
