/**
 * 框选：左键在画布空白区拖出一个矩形，松手后选中矩形内所有节点。
 *
 * 与 DragController 的分工：
 * - **命中节点**的左键拖动 → 改父子关系（DragController 负责）；
 * - **空白区**的左键拖动 → 框选（本控制器负责）；
 * - 右键拖动 → 平移画布（d3-zoom 过滤器已设为「仅右键平移」）；
 * - 左键单击空白 → 取消选中（由 MindmapView 的 click 处理，本控制器不抢）。
 *
 * 加选规则：拖动时按住 Ctrl / ⌘ / Shift = 并入现有选中集合（additive），
 * 否则替换整组选中。
 *
 * 和 DragController 一样的收尾坑：拖拽结束后必须吞掉紧跟的 click，
 * 否则那个 click 会按旧坐标去清空我们刚写好的框选结果。
 */

import type { SrcRef } from "../types";
import { hideElement, setDisplay, setUserSelect } from "../render/domStyle";

/** 超过这个位移才算框选，否则当成普通点击（交给 click 去取消选中） */
const BOX_THRESHOLD = 5;

export interface BoxSelectCallbacks {
  /** 取节点的源坐标；根节点也会返回（框选可能框到它） */
  srcOf: (g: SVGGElement) => SrcRef | null;
  /** 松手后把命中的节点行号交给视图层；additive=true 时并入现有选中 */
  onSelect: (lines: number[], additive: boolean) => void;
}

export class BoxSelectController {
  private readonly svg: SVGSVGElement;
  private readonly container: HTMLElement;
  private readonly cb: BoxSelectCallbacks;

  private layer: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;

  /** 是否在空白区按下了左键（起手） */
  private armed = false;
  /** 位移超过阈值后才算真正框选 */
  private active = false;
  private startX = 0;
  private startY = 0;
  private endX = 0;
  private endY = 0;
  private additive = false;

  constructor(svg: SVGSVGElement, container: HTMLElement, cb: BoxSelectCallbacks) {
    this.svg = svg;
    this.container = container;
    this.cb = cb;

    svg.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("blur", this.onAbort);
    window.addEventListener("pointercancel", this.onAbort);
  }

  destroy(): void {
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
    if (this.armed) this.reset();
  };

  private onPointerDown = (e: PointerEvent): void => {
    // 只接左键；右键留给画布平移，中键留给系统。
    if (e.button !== 0) return;
    const el = e.target as Element;
    // 命中节点 / 链接 / 折叠圆点 → 各自有主（DragController、markmap），不框选
    if (el.closest("g.markmap-node") || el.closest("a") || el.closest("circle")) return;

    this.armed = true;
    this.active = false;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.endX = e.clientX;
    this.endY = e.clientY;
    this.additive = e.ctrlKey || e.metaKey || e.shiftKey;

    // 按下就锁选区：拖动期间不该出现浏览器选文字的蓝条。
    // 没拖动（纯点击）会在 reset 里立刻恢复，并放行 click 去取消选中。
    setUserSelect(document.body, "none");
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.armed) return;
    this.endX = e.clientX;
    this.endY = e.clientY;

    if (!this.active) {
      if (Math.hypot(e.clientX - this.startX, e.clientY - this.startY) < BOX_THRESHOLD) return;
      this.active = true;
      this.ensureLayer();
    }
    this.renderBox();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.armed) return;
    const wasActive = this.active;
    this.reset();

    if (!wasActive) return; // 没拖动过：放行 click，让视图层去取消选中

    // 框选结束别让这次松手变成 click，否则 click 会按旧坐标清空刚选好的结果。
    e.preventDefault();
    e.stopPropagation();
    swallowNextClick();

    const lines: number[] = this.computeSelection();
    this.cb.onSelect(lines, this.additive);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.armed) this.reset();
  };

  // -------------------------------------------------------------------------

  private reset(): void {
    this.armed = false;
    this.active = false;
    setUserSelect(document.body, "");
    if (this.box) hideElement(this.box);
  }

  /** 节点卡片的外框（屏幕坐标），与 DragController 同款判定 */
  private cardBoxOf(g: SVGGElement): DOMRect | null {
    const card = g.querySelector<SVGRectElement>(":scope > rect.obmind-node-card");
    const el: Element = card ?? g.querySelector("foreignObject") ?? g;
    const r: DOMRect = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return r;
  }

  /** 矩形与框选相交的节点行号 */
  private computeSelection(): number[] {
    const x1 = Math.min(this.startX, this.endX);
    const y1 = Math.min(this.startY, this.endY);
    const x2 = Math.max(this.startX, this.endX);
    const y2 = Math.max(this.startY, this.endY);

    const out: number[] = [];
    for (const g of Array.from(this.svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const r = this.cardBoxOf(g);
      if (!r) continue;
      // 相交判定（含边界）
      if (r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2) continue;
      const src = this.cb.srcOf(g);
      if (src && src.line >= 0) out.push(src.line);
    }
    return out;
  }

  private ensureLayer(): void {
    if (this.layer) return;
    const layer = document.createElement("div");
    layer.className = "obmind-select-layer";
    const box = document.createElement("div");
    box.className = "obmind-select-box";
    layer.appendChild(box);
    this.container.appendChild(layer);
    this.layer = layer;
    this.box = box;
  }

  private renderBox(): void {
    const box = this.box;
    if (!box) return;
    const base = this.container.getBoundingClientRect();
    const left = Math.min(this.startX, this.endX) - base.left;
    const top = Math.min(this.startY, this.endY) - base.top;
    const width = Math.abs(this.endX - this.startX);
    const height = Math.abs(this.endY - this.startY);
    setDisplay(box, "block");
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  }
}

/**
 * 吞掉紧接着派发的那个 click（capture 拦一次；setTimeout(0) 兜底移除，
 * 万一浏览器这次没派发 click，也不会把用户的下一次点击一起吃掉）。
 */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("click", swallow, true);
  window.setTimeout(() => document.removeEventListener("click", swallow, true), 0);
}
