/**
 * 操作栏：工具条（第一行）+ 节点操作条（第二行）。
 *
 * 为什么单独成模块：
 * 1. 原来是一串 createEl + addEventListener，把 onOpen 撑得又长又难读；
 * 2. 按钮的「图标 / 文案 / 快捷键」是数据，不是流程 —— 声明成表之后，
 *    加一个操作就是加一行，不用再动事件绑定；
 * 3. 可用态集中由 setEnabled 管。按钮该不该点，只由「有没有选中节点」
 *    「能不能撤销」这类状态决定，避免各处的按钮状态互相不同步。
 *
 * 视觉上刻意用 Obsidian 内置的 `clickable-icon` + `setIcon`（lucide）：
 * hover/active/焦点环全部继承主题，插件不用自己画一遍按钮，
 * 也自动跟随用户的强调色与深色模式。
 */

import { setIcon } from "obsidian";

export type ToolbarActionId =
  | "undo"
  | "redo"
  | "collapseAll"
  | "expandAll"
  | "fit"
  | "refresh"
  | "edit"
  | "child"
  | "sibling"
  | "outdent"
  | "delete"
  | "help";

export interface ToolbarButton {
  id: ToolbarActionId;
  /** lucide 图标名 */
  icon: string;
  /** 中文动作名，作为 tooltip 与无障碍标签 */
  label: string;
  /** 快捷键提示，拼在 tooltip 里（不参与实际绑定） */
  key?: string;
  /**
   * 图标名在当前 Obsidian 版本里不存在时的兜底文字。
   *
   * setIcon 遇到不认识的图标名会**静默什么都不画**，按钮就变成一个空方块 ——
   * 用户看到一排空白，还以为插件坏了。有兜底至少还能当文字按钮用。
   */
  fallback?: string;
}

export interface ToolbarGroup {
  buttons: readonly ToolbarButton[];
  /** true = 贴到行尾（前面插一个可伸缩占位），用于「帮助」这类次要入口 */
  pin?: boolean;
}

export interface ToolbarRowSpec {
  /** 每组之间画一条竖分隔线 */
  groups: readonly ToolbarGroup[];
  /** 行尾推一个可伸缩占位 + 状态文字（把右侧内容对齐到边上） */
  status?: boolean;
}

export interface ToolbarSpec {
  /** 行首的额外控件（主题下拉框）：由调用方创建，这里只负责摆放 */
  leading?: HTMLElement | null;
  rows: readonly ToolbarRowSpec[];
  onAction: (id: ToolbarActionId) => void;
}

export interface ToolbarHandle {
  el: HTMLElement;
  /** 切换某个按钮的可用态（不可用时保留图标与 tooltip，用户仍能看见它能做什么） */
  setEnabled(id: ToolbarActionId, on: boolean): void;
  /** 只在需要时改文字；空字符串表示清空 */
  setStatus(text: string): void;
}

function iconButton(
  parent: HTMLElement,
  spec: ToolbarButton,
  onAction: (id: ToolbarActionId) => void,
): HTMLButtonElement {
  const btn = parent.createEl("button", { cls: "clickable-icon" });
  setIcon(btn, spec.icon);
  if (btn.childElementCount === 0 && (btn.textContent ?? "").trim() === "" && spec.fallback) {
    btn.setText(spec.fallback);
    btn.addClass("obmind-icon-fallback");
  }
  // 单行 tooltip：aria-label 会被 Obsidian 的悬浮提示接管，
  // 再额外写 title 会出现两个提示框叠在一起。
  btn.setAttribute("aria-label", spec.key ? `${spec.label}（${spec.key}）` : spec.label);
  btn.addEventListener("click", (e: MouseEvent) => {
    // 按钮在画布里，点完别让画布把焦点抢回去 ——
    // 否则连续点两个操作，第二次的 hover 状态就没了
    e.preventDefault();
    if (btn.disabled) return;
    onAction(spec.id);
  });
  return btn;
}

export function buildToolbar(parent: HTMLElement, spec: ToolbarSpec): ToolbarHandle {
  const el = parent.createDiv({ cls: "obmind-toolbars" });
  const buttons = new Map<ToolbarActionId, HTMLButtonElement>();
  let statusEl: HTMLElement | null = null;

  spec.rows.forEach((row: ToolbarRowSpec, index: number) => {
    const rowEl = el.createDiv({
      cls: index === 0 ? "obmind-toolbar" : "obmind-toolbar is-sub",
    });
    if (index === 0 && spec.leading) rowEl.appendChild(spec.leading);

    let firstGroup = true;
    for (const group of row.groups) {
      if (group.pin) {
        rowEl.createDiv({ cls: "obmind-toolbar-spacer" });
        firstGroup = true;
      } else if (!firstGroup) {
        rowEl.createSpan({ cls: "obmind-toolbar-sep" });
      }
      for (const item of group.buttons) {
        buttons.set(item.id, iconButton(rowEl, item, spec.onAction));
      }
      firstGroup = false;
    }

    if (row.status) {
      rowEl.createDiv({ cls: "obmind-toolbar-spacer" });
      statusEl = rowEl.createSpan({ cls: "obmind-status" });
    }
  });

  return {
    el,
    setEnabled(id: ToolbarActionId, on: boolean): void {
      const btn = buttons.get(id);
      if (!btn) return;
      if (btn.disabled === !on) return;
      btn.disabled = !on;
    },
    setStatus(text: string): void {
      if (!statusEl) return;
      statusEl.setText(text);
      statusEl.toggleClass("is-empty", text === "");
    },
  };
}
