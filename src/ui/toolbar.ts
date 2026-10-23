/**
 * 操作栏：**一行**全局操作（主题 / 撤销恢复 / 折叠展开 / 适配 / 刷新 / 帮助）。
 *
 * 为什么从两行收成一行：
 * 原来第二行是「对选中节点」的操作（改 / 子 / 同 / 提 / 删）。这五个动作在
 * 没选中节点时全是灰的 —— 长期占着一行高度，却只有在选中后才有意义。
 * 而且两行图标靠一条竖线分组，视觉上像两个独立工具条叠在一起，很碎。
 * 现在它们搬到了 `ui/nodeBar.ts`，选中单个节点时贴在画布右侧（固定位置）。
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
  | "pin"
  | "undo"
  | "redo"
  | "collapseAll"
  | "expandAll"
  | "fit"
  | "refresh"
  | "export"
  | "deselect"
  | "edit"
  | "child"
  | "sibling"
  | "outdent"
  | "delete"
  | "newNote"
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
  /** 开关型按钮在「开启」时换用的图标（如 pin → pin-off 那一类） */
  iconActive?: string;
}

export interface ToolbarGroup {
  buttons: readonly ToolbarButton[];
  /** true = 贴到行尾（前面插一个可伸缩占位），用于「帮助」这类次要入口 */
  pin?: boolean;
}

export interface ToolbarSpec {
  /** 行首的品牌位（logo 占位）：现在是一个字标，将来换成真图标不用动布局 */
  brand?: string;
  /** 行首的额外控件（主题按钮）：由调用方创建，这里只负责摆放 */
  leading?: HTMLElement | null;
  /** 行尾的只读信息（节点数 / 树深）：同样由调用方创建与更新 */
  trailing?: HTMLElement | null;
  groups: readonly ToolbarGroup[];
  onAction: (id: ToolbarActionId) => void;
}

export interface ToolbarHandle {
  el: HTMLElement;
  /** 切换某个按钮的可用态（不可用时保留图标与 tooltip，用户仍能看见它能做什么） */
  setEnabled(id: ToolbarActionId, on: boolean): void;
  /**
   * 切换某个按钮的**开启态**（钉住、锁定这类开关型动作）。
   *
   * 与 setEnabled 是两件事：disabled 是「现在点不了」，active 是「这个开关是开着的」。
   * 顺手换 tooltip：同一个按钮在两种状态下要说两句不同的话（「钉住导图」/「取消钉住」），
   * 光靠高亮色用户读不出来点一下会发生什么。
   */
  setActive(id: ToolbarActionId, on: boolean, label?: string): void;
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
  const specs = new Map<ToolbarActionId, ToolbarButton>();

  // 品牌位在最左：它只是一块视觉锚点，不参与任何交互，所以不塞进领导控件里
  if (spec.brand) rowEl.createSpan({ cls: "obmind-brand", text: spec.brand });
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
      specs.set(item.id, item);
    }
    firstGroup = false;
  }

  // 统计放在**最后**（连 pin 的「帮助」之后）：它是只读信息，贴着右边缘
  // 才像是「状态栏」；插在按钮中间会被误认为又是一个按钮。
  if (spec.trailing) rowEl.appendChild(spec.trailing);

  return {
    el,
    setEnabled(id: ToolbarActionId, on: boolean): void {
      const btn = buttons.get(id);
      if (!btn) return;
      if (btn.disabled === !on) return;
      btn.disabled = !on;
    },
    setActive(id: ToolbarActionId, on: boolean, label?: string): void {
      const btn = buttons.get(id);
      const item = specs.get(id);
      if (!btn || !item) return;
      const changed: boolean = btn.classList.contains("is-active") !== on;
      if (!changed && !label) return;
      if (changed) btn.classList.toggle("is-active", on);
      // 开关型按钮的两个图标：钉住之后画「已钉住」那个，比只换颜色好认
      if (changed && item.iconActive) setIcon(btn, on ? item.iconActive : item.icon);
      btn.setAttribute(
        "aria-label",
        label ?? (item.key ? `${item.label}（${item.key}）` : item.label),
      );
    },
  };
}

/** 全局操作栏的按钮表（浮动条用的是另一份，见 nodeBar.ts） */
export const GLOBAL_GROUPS: readonly ToolbarGroup[] = [
  // 钉住排在最前：它决定「这张图跟着谁走」，比后面所有操作都更靠近「我在看哪篇」
  {
    buttons: [
      { id: "pin", icon: "pin", label: "钉住当前导图", fallback: "钉" },
    ],
  },
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
    buttons: [{ id: "export", icon: "download", label: "导出为 SVG", fallback: "导" }],
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
      // 「建笔记」紧跟着两个「建节点」：用户心里它们是同一类动作（从这一行长出东西），
      // 只是长出来的是节点还是一篇笔记。它只在节点还没有双链时出现（见 syncToolbar）。
      { id: "newNote", icon: "file-plus", label: "新建笔记并双链", key: "Ctrl+N", fallback: "记" },
      { id: "edit", icon: "pencil", label: "编辑节点", key: "F2 / 双击", fallback: "改" },
      { id: "outdent", icon: "corner-up-left", label: "提升一级", key: "Shift+Tab", fallback: "提" },
    ],
  },
  // 删除单独成组：破坏性操作不要和「新建 / 提升」贴在一起，
  // 手指连点时误触的代价太大
  {
    buttons: [{ id: "delete", icon: "trash-2", label: "删除节点", key: "Delete", fallback: "删" }],
  },
  // 取消选中：点画布空白和 Esc 也能收，但浮动条上有个明确的出口更符合直觉 ——
  // 「浮出来一个东西，却没有关掉它的按钮」会让人以为界面卡住了
  {
    buttons: [{ id: "deselect", icon: "x", label: "取消选中", key: "Esc", fallback: "关" }],
  },
];
