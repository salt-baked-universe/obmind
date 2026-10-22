/**
 * 节点浮动条：选中节点时，在卡片正下方浮出一排「对这个节点」的操作。
 *
 * 为什么不再放在顶部工具栏里：
 * 这五个动作（子 / 同 / 改 / 提 / 删）只有在选中节点后才有意义，放在工具栏里
 * 就成了一排长期挂着的灰按钮 —— 占了一行高度，还让操作栏看起来是两截。
 * 挪到节点旁边之后，操作跟着上下文走：看得见它作用于谁，也不用先把视线
 * 从卡片挪到顶部再挪回来。XMind 的浮动工具条、Notion 的选区工具条都是这个路子。
 *
 * 定位逻辑（`nodeBarPosition`）是纯函数：给矩形算位置，能在 Node 里穷举边界
 * （贴底、贴左、卡片比视口还高）。DOM 那部分只负责把算出来的值写进 style。
 */

import type { ToolbarActionId, ToolbarButton } from "./toolbar";
import { createIconButton } from "./toolbar";

export interface BarRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface BarAnchor {
  /** 选中卡片在视口里的矩形（已含缩放） */
  target: BarRect;
  /** 容器可用区域（画布） */
  host: { width: number; height: number };
  /** 浮动条自身尺寸 */
  bar: { width: number; height: number };
  /** 与卡片的间距 */
  gap?: number;
  /** 距容器边缘的最小留白 */
  margin?: number;
}

export interface BarBox {
  left: number;
  top: number;
}

/**
 * 算浮动条位置：默认贴在卡片正下方居中。
 *
 * 三条兜底，都是为了「不要跑到看不见的地方」：
 * 1. 下方放不下（卡片贴着画布底边）→ 翻到卡片上方；
 * 2. 上方也放不下（卡片比可视区还高，常见于缩放很小 + 长文本）→ 贴底边；
 * 3. 左右越界 → 夹到容器内，宁可偏一点也不能出去。
 */
export function nodeBarPosition(a: BarAnchor): BarBox {
  const gap: number = a.gap ?? 6;
  const margin: number = a.margin ?? 4;
  const { target, host, bar } = a;

  const center: number = target.left + target.width / 2 - bar.width / 2;
  const left: number = Math.min(
    Math.max(center, margin),
    Math.max(margin, host.width - bar.width - margin),
  );

  let top: number = target.bottom + gap;
  if (top + bar.height > host.height - margin) {
    const above: number = target.top - bar.height - gap;
    // 上方也放不下就贴底边：至少整条可见，只是会盖住卡片下沿
    top = above >= margin ? above : Math.max(margin, host.height - bar.height - margin);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

const CLS = "obmind-nodebar";

export class NodeBar {
  readonly el: HTMLElement;
  private readonly host: HTMLElement;
  private target: SVGGElement | null = null;
  private frame = 0;
  private lastLeft = Number.NaN;
  private lastTop = Number.NaN;
  private barW = 0;
  private barH = 0;
  private readonly buttons = new Map<ToolbarActionId, HTMLButtonElement>();

  constructor(
    host: HTMLElement,
    spec: { groups: readonly { buttons: readonly ToolbarButton[] }[] },
    onAction: (id: ToolbarActionId) => void,
  ) {
    this.host = host;
    // 不用 display: none 隐藏 —— 隐藏态也要参与布局才能读到尺寸（见 measure）
    this.el = host.createDiv({ cls: `${CLS} is-out` });
    let first = true;
    for (const group of spec.groups) {
      if (!first) this.el.createSpan({ cls: "obmind-toolbar-sep" });
      for (const item of group.buttons) {
        const btn = createIconButton(this.el, item, onAction);
        // 按钮拿焦点会把键盘焦点从画布上拽走，之后 Tab/Enter 就没人接了
        btn.tabIndex = -1;
        btn.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault());
        this.buttons.set(item.id, btn);
      }
      first = false;
    }
  }

  /** 换一个目标节点；传 null 收起。同一个目标重复调用只重新定位（重建后 g 会换） */
  attach(target: SVGGElement | null): void {
    if (target === this.target) {
      // 已是「收起」状态就什么都不做 —— 否则每次取消选中都白起一个 rAF 循环，
      // 而循环里的 place() 因为没目标立刻 return，等于每帧空转
      if (target) this.place();
      return;
    }

    this.target = target;
    if (!target) {
      this.close();
      return;
    }
    // 先摆好再淡入：否则会先从上一个位置滑过来
    this.lastLeft = Number.NaN;
    this.lastTop = Number.NaN;
    this.el.removeClass("is-out");
    this.measure();
    this.place();
    this.el.addClass("is-in");
    this.start();
  }

  setEnabled(id: ToolbarActionId, on: boolean): void {
    const btn = this.buttons.get(id);
    if (!btn) return;
    if (btn.disabled === !on) return;
    btn.disabled = !on;
  }

  destroy(): void {
    this.stop();
    this.target = null;
    this.el.remove();
  }

  /**
   * 尺寸只量一次。
   *
   * 每帧都读 offsetWidth 会触发样式/布局重算；浮层内容和字号在生命周期内
   * 不会变，量大一次就够。
   */
  private measure(): void {
    this.barW = this.el.offsetWidth;
    this.barH = this.el.offsetHeight;
  }

  private close(): void {
    this.stop();
    this.el.removeClass("is-in");
    this.el.addClass("is-out");
  }

  /**
   * 跟随用 rAF 循环，而不是在各个地方挂监听。
   *
   * 会让卡片移动的东西太多了：滚轮缩放、拖动画布、折叠展开、重建、侧栏宽度变化。
   * 每个都挂一遍必然漏掉某一个（之前编辑框就漏过折叠动画）。循环只在选中期间跑，
   * 且位置没变就不写 style —— 静止时每帧只有一次 getBoundingClientRect。
   */
  private start(): void {
    if (this.frame !== 0) return;
    const loop = (): void => {
      this.frame = window.requestAnimationFrame(loop);
      this.place();
    };
    this.frame = window.requestAnimationFrame(loop);
  }

  private stop(): void {
    if (this.frame === 0) return;
    window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private place(): void {
    const g = this.target;
    if (!g) return;
    // 节点被 markmap 移除（折叠、重建）后就没得指了，收起来别再跟
    if (!g.isConnected) {
      this.target = null;
      this.close();
      return;
    }
    const fo = g.querySelector<SVGForeignObjectElement>(":scope > foreignObject");
    if (!fo) return;

    const r: DOMRect = fo.getBoundingClientRect();
    const h: DOMRect = this.host.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || h.width < 1) return;

    const box: BarBox = nodeBarPosition({
      target: {
        left: r.left - h.left,
        top: r.top - h.top,
        right: r.right - h.left,
        bottom: r.bottom - h.top,
        width: r.width,
        height: r.height,
      },
      host: { width: h.width, height: h.height },
      bar: { width: this.barW, height: this.barH },
    });

    if (box.left === this.lastLeft && box.top === this.lastTop) return;
    this.lastLeft = box.left;
    this.lastTop = box.top;
    this.el.style.transform = `translate(${box.left}px, ${box.top}px)`;
  }
}
