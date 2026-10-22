/**
 * 操作栏：**一行**全局操作（主题 / 撤销恢复 / 折叠展开 / 适配 / 刷新 / 帮助）。
 *
 * 为什么从两行收成一行：
 * 原来第二行是「对选中节点」的操作（改 / 子 / 同 / 提 / 删）。这五个动作在
 * 没选中节点时全是灰的 —— 长期占着一行高度，却只有在选中后才有意义。
 * 而且两行图标靠一条竖线分组，视觉上像两个独立工具条叠在一起，很碎。
 * 现在它们搬到了 `ui/nodeBar.ts`，选中节点时浮在卡片下面（跟着上下文走）。
 *
 * 按钮的「图标 / 文案 / 快捷键」是数据不是流程 —— 声明成表之后，
 * 加一个操作就是加一行，不用再动事件绑定；可用态集中由 setEnabled 管，
 * 避免「删完了删除键还是亮的」这类不同步。
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

export interface ToolbarSpec {
  /** 行首的额外控件（主题按钮）：由调用方创建，这里只负责摆放 */
  leading?: HTMLElement | null;
  groups: readonly ToolbarGroup[];
  onAction: (id: ToolbarActionId) => void;
}

export interface ToolbarHandle {
  el: HTMLElement;
  /** 切换某个按钮的可用态（不可用时保留图标与 tooltip，用户仍能看见它能做什么） */
  setEnabled(id: ToolbarActionId, on: boolean): void;
}

/**
 * 造一个图标按钮。
 *
 * 导出的原因：节点浮动条（ui/nodeBar.ts）用的是同一批动作，视觉必须完全一致，
 * 否则「上面一排按钮 + 下面一排按钮」会长得不一样。
 */
export function createIconButton(
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
  const rowEl = el.createDiv({ cls: "obmind-toolbar" });
  const buttons = new Map<ToolbarActionId, HTMLButtonElement>();

  if (spec.leading) rowEl.appendChild(spec.leading);

  let firstGroup = true;
  for (const group of spec.groups) {
    if (group.pin) {
      rowEl.createDiv({ cls: "obmind-toolbar-spacer" });
      firstGroup = true;
    } else if (!firstGroup) {
      rowEl.createSpan({ cls: "obmind-toolbar-sep" });
    }
    for (const item of group.buttons) {
      buttons.set(item.id, createIconButton(rowEl, item, spec.onAction));
    }
    firstGroup = false;
  }

  return {
    el,
    setEnabled(id: ToolbarActionId, on: boolean): void {
      const btn = buttons.get(id);
      if (!btn) return;
      if (btn.disabled === !on) return;
      btn.disabled = !on;
    },
  };
}

/** 全局操作栏的按钮表（浮动条用的是另一份，见 nodeBar.ts） */
export const GLOBAL_GROUPS: readonly ToolbarGroup[] = [
  {
    buttons: [
      { id: "undo", icon: "undo-2", label: "撤销", key: "Ctrl+Z", fallback: "撤" },
      { id: "redo", icon: "redo-2", label: "重做", key: "Ctrl+Shift+Z", fallback: "重" },
    ],
  },
  {
    buttons: [
      { id: "collapseAll", icon: "chevrons-down-up", label: "折叠全部", fallback: "折" },
      { id: "expandAll", icon: "chevrons-up-down", label: "展开全部", fallback: "展" },
      { id: "fit", icon: "maximize", label: "缩放到适合窗口", fallback: "适" },
      { id: "refresh", icon: "refresh-cw", label: "重新读取笔记", fallback: "刷" },
    ],
  },
  {
    pin: true,
    buttons: [{ id: "help", icon: "help-circle", label: "操作与快捷键", fallback: "?" }],
  },
];

/** 选中节点时浮动条上的按钮表 */
export const NODE_GROUPS: readonly ToolbarGroup[] = [
  {
    buttons: [
      { id: "child", icon: "corner-down-right", label: "新建子级", key: "Tab", fallback: "子" },
      { id: "sibling", icon: "plus", label: "新建同级", key: "Enter", fallback: "同" },
      { id: "edit", icon: "pencil", label: "编辑节点", key: "F2 / 双击", fallback: "改" },
      { id: "outdent", icon: "corner-up-left", label: "提升一级", key: "Shift+Tab", fallback: "提" },
    ],
  },
  // 删除单独成组：破坏性操作不要和「新建 / 提升」贴在一起，
  // 手指连点时误触的代价太大
  {
    buttons: [{ id: "delete", icon: "trash-2", label: "删除节点", key: "Delete", fallback: "删" }],
  },
];
