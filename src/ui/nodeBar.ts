/**
 * 节点浮动条：选中**单个**节点时，在画布右侧固定浮出一排「对这个节点」的操作。
 *
 * 为什么不再放在顶部工具栏里：
 * 这五个动作（子 / 同 / 改 / 提 / 删）只有在选中节点后才有意义，放在工具栏里
 * 就成了一排长期挂着的灰按钮 —— 占了一行高度，还让操作栏看起来是两截。
 *
 * 为什么固定在右侧竖排，而不是跟着卡片跑：
 * 跟着卡片时先后试过「卡片下方」和「卡片上方」，两个位置都在跟内容抢地方 ——
 * 下方压住子树（新节点都长在那儿），上方压住父级和刚点过的兄弟；而且它每帧
 * 都要读一次 `getBoundingClientRect` 追着折叠动画飞。固定右侧之后位置永远是
 * 同一个点，肌肉记忆能建立，也不再有任何跟随开销。
 *
 * 只做「写 style + 显隐」，位置怎么算是 `nodeBarPosition.ts` 里的纯函数。
 */

import type { ToolbarActionId, ToolbarButton } from "./toolbar";
import { createIconButton } from "./toolbar";
import { nodeBarPosition } from "./nodeBarPosition";
import type { BarBox } from "./nodeBarPosition";

export type { BarAnchor, BarBox } from "./nodeBarPosition";
export { nodeBarPosition } from "./nodeBarPosition";

const CLS = "obmind-nodebar";

export class NodeBar {
  readonly el: HTMLElement;
  private readonly host: HTMLElement;
  private visible = false;
  private lastLeft = Number.NaN;
  private lastTop = Number.NaN;
  private barW = 0;
  private barH = 0;
  private readonly buttons = new Map<ToolbarActionId, HTMLButtonElement>();
  private readonly observer: ResizeObserver | null;

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

    // 侧栏被拖动、窗口缩放都会改画布尺寸，条子是右对齐的，必须跟着重算 ——
    // 只看画布自己的尺寸变化（内容是 SVG，父容器的尺寸变化会传下来）
    this.observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (this.visible) this.place();
          });
    this.observer?.observe(host);
  }

  /**
   * 显示 / 收起。
   *
   * 只收一个布尔而不是目标节点：位置已经和「哪个节点」无关了。
   * 多选时由调用方传 false（那五个动作语义都是「对这一个节点」）。
   */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    if (!on) {
      this.el.removeClass("is-in");
      this.el.addClass("is-out");
      return;
    }
    // 先摆好再淡入：否则第一次弹出会从上一个位置滑过来
    this.lastLeft = Number.NaN;
    this.lastTop = Number.NaN;
    this.measure();
    this.place();
    this.el.removeClass("is-out");
    this.el.addClass("is-in");
  }

  setEnabled(id: ToolbarActionId, on: boolean): void {
    const btn = this.buttons.get(id);
    if (!btn) return;
    if (btn.disabled === !on) return;
    btn.disabled = !on;
  }

  /**
   * 显隐某个按钮（不是置灰）。
   *
   * 「新建笔记」这类入口是**条件性**的：节点已经有双链时它没有任何意义，
   * 留一个永久灰掉的图标在那里，用户只会反复点它试为什么不能点。
   * 隐藏之后条子变窄，右对齐的位置要重算 —— 否则会偏离右边缘一格按钮的宽度。
   */
  setHidden(id: ToolbarActionId, on: boolean): void {
    const btn = this.buttons.get(id);
    if (!btn) return;
    if (btn.hasClass("is-gone") === on) return;
    btn.toggleClass("is-gone", on);
    if (!this.visible) return;
    this.measure();
    this.lastLeft = Number.NaN;
    this.lastTop = Number.NaN;
    this.place();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.visible = false;
    this.el.remove();
  }

  /**
   * 尺寸只量一次。
   *
   * 每帧都读 offsetWidth 会触发样式/布局重算；条子内容是固定的五个图标，
   * 字号变了也只会在下一轮 attach 时重新量。
   */
  private measure(): void {
    this.barW = this.el.offsetWidth;
    this.barH = this.el.offsetHeight;
  }

  private place(): void {
    if (!this.visible) return;
    if (this.barW < 1 || this.barH < 1) this.measure();

    const h: DOMRect = this.host.getBoundingClientRect();
    if (h.width < 1) return;

    const box: BarBox = nodeBarPosition({
      host: { width: h.width, height: h.height },
      bar: { width: this.barW, height: this.barH },
    });

    if (box.left === this.lastLeft && box.top === this.lastTop) return;
    this.lastLeft = box.left;
    this.lastTop = box.top;
    this.el.style.transform = `translate(${box.left}px, ${box.top}px)`;
  }
}
