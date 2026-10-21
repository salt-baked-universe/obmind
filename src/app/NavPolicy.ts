/**
 * 面包屑跳转与笔记窗口的联动策略（L4 纯决策）。
 *
 * 背景：面包屑是「导图内的浏览路径」，但用户往往希望左边的笔记窗口也跟着走。
 * 跟不跟、怎么跟，有四种合理选择，做成配置项而不是写死。
 *
 * 四档语义（前进 = 点双链进入一篇笔记；后退 = 点面包屑某一级）：
 *
 * | 模式            | 前进                            | 后退                          |
 * |-----------------|---------------------------------|-------------------------------|
 * | map-only        | 只换导图                        | 只换导图                      |
 * | same-leaf       | 复用当前笔记窗口，换成目标      | 同一个窗口切回上级            |
 * | new-leaf-close  | 新标签打开，记住它              | 关掉当初为下级开的标签        |
 * | new-leaf-keep   | 新标签打开，记住它              | 不关闭、也不动当前窗口        |
 *
 * 这个文件只输出「该不该动 Obsidian 的 leaf」，不 import obsidian、不碰 DOM。
 * 具体的 openFile / detach 留在视图层执行 —— 决策能测试，执行能观察。
 */

/** 面包屑与笔记视图的联动方式 */
export type NavSyncMode = "map-only" | "same-leaf" | "new-leaf-close" | "new-leaf-keep";

export interface NavSyncOption {
  value: NavSyncMode;
  /** 设置页下拉里显示的短名 */
  label: string;
  /** 选中后的一行说明 */
  desc: string;
}

export const NAV_SYNC_OPTIONS: readonly NavSyncOption[] = [
  {
    value: "map-only",
    label: "仅导图跳转",
    desc: "笔记窗口完全不跟随，导图原地换内容。适合把导图当独立浏览器用。",
  },
  {
    value: "same-leaf",
    label: "跟随当前笔记窗口（默认）",
    desc: "在当前笔记窗口里打开目标笔记，后退时同一个窗口切回上级。标签栏不增加。",
  },
  {
    value: "new-leaf-close",
    label: "新标签打开，返回时关闭",
    desc: "目标笔记在新标签页打开，点面包屑回到上级时自动关掉那个标签。",
  },
  {
    value: "new-leaf-keep",
    label: "新标签打开，返回时保留",
    desc: "目标笔记在新标签页打开；回到上级时不关闭标签，也不切换过去，适合左右对照。",
  },
];

export const DEFAULT_NAV_SYNC: NavSyncMode = "same-leaf";

/** 旧配置里没有这个字段、或存了非法值时统一收敛到默认档 */
export function normalizeNavSync(value: unknown): NavSyncMode {
  const hit = NAV_SYNC_OPTIONS.find((o: NavSyncOption) => o.value === value);
  return hit ? hit.value : DEFAULT_NAV_SYNC;
}

/** 前进时目标笔记该出现在哪儿 */
export type ForwardTarget =
  /** 不在 Obsidian 里打开，只有导图换内容 */
  | "none"
  /** 复用当前正在看这篇笔记的窗口 */
  | "current"
  /** 新开一个标签 */
  | "new";

export function forwardTarget(mode: NavSyncMode): ForwardTarget {
  switch (mode) {
    case "map-only":
      return "none";
    case "same-leaf":
      return "current";
    default:
      return "new";
  }
}

/** 前进时新建的标签，要不要记进栈、以便后退时关闭 */
export function trackOpenedLeaf(mode: NavSyncMode): boolean {
  return mode === "new-leaf-close";
}

export interface BackPlan {
  /** 关闭「前进时新开的」标签 */
  closeOpened: boolean;
  /** 把当前笔记窗口切回上级 */
  followCurrent: boolean;
}

export function planBack(mode: NavSyncMode): BackPlan {
  switch (mode) {
    case "map-only":
      return { closeOpened: false, followCurrent: false };
    case "same-leaf":
      return { closeOpened: false, followCurrent: true };
    case "new-leaf-close":
      return { closeOpened: true, followCurrent: false };
    case "new-leaf-keep":
      return { closeOpened: false, followCurrent: false };
  }
}
