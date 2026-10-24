/**
 * 动作表：把「用户想做什么」和「按了哪个键 / 焦点在谁身上」拆开。
 *
 * 原来视图里有两条 if 链（`onCanvasKeyDown` 与 `onViewKeyDown`），键位、
 * 相位判断、节点类型判断混在一起。加一个操作要改三处（两条链 + 动作方法），
 * 而且两条链的判据还不一样：画布那条只看 `e.target === canvas`，
 * 视图那条看 `phase !== "idle"` —— 「重建中在画布上按 Tab」能拿到旧快照。
 *
 * 现在：
 * - 这个文件只描述 **键位 → 动作 id**，以及「当前状态能不能做」；
 * - 执行体留在视图（`runAction`），它才知道怎么调 EditService；
 * - IO 类能力（剪贴板、写文件）是端口，由视图注入，不在这里 import 宿主 API。
 *
 * 于是「加一个新操作」= 在 ACTIONS 里加一行 + 在 runAction 里加一个 case。
 * 想接别的地方（工具栏按钮、命令面板、右键菜单）时，直接按 id 派发即可，
 * 键位只是它的一个入口。
 *
 * 本文件**不 import obsidian**，用例可以在 Node 里跑完整判定。
 */

import type { Phase } from "./runtime";

/** 一个 id 就是一条用户意图。重复的入口（快捷键 / 按钮 / 菜单）共用同一个 id */
export type ActionId =
  | "undo"
  | "redo"
  | "newChild"
  | "newSibling"
  | "outdent"
  | "remove"
  | "edit"
  | "escape"
  | "navUp"
  | "navDown"
  | "navLeft"
  | "navRight"
  | "newNote"
  /** 把剪贴板内容粘成选中节点的子节点（XMind 手感） */
  | "paste";

/**
 * 动作能挂在哪个监听层。
 *
 * - `canvas`：画布自己持有焦点时（`e.target === canvas`）。编辑框里的按键、
 *   块卡片里选中的文字、工具栏按钮都不会走到这里 —— 它们的目标不是画布。
 * - `view`：视图根节点上的兜底。焦点可能落在 body / 面包屑 / 某个图标上，
 *   这时按空格的本意仍是「改这个节点」，不能因为焦点不在画布就收不到。
 *   这一层必须自己过滤输入控件（`isTypingTarget`）。
 */
export type ActionScope = "canvas" | "view";

/** 动作执行时的只读状态快照。视图每次按键现算，动作不持有任何状态 */
export interface ActionState {
  phase: Phase;
  /** 主选中行（-1 = 没选中任何节点） */
  primary: number;
  /** 选中集合大小（> 1 表示框选 / Shift 区间） */
  selectionSize: number;
  /** 主选中是块（只读叶子：能删、能拖，不能改字、不能在它下面建节点） */
  onBlock: boolean;
  /** 有没有可写的目标笔记 */
  hasFile: boolean;
}

export interface ActionDef {
  id: ActionId;
  /**
   * 归一化键位。`mod` = Ctrl / ⌘，修饰键顺序固定 mod → alt → shift：
   * `"mod+shift+z"`、`"shift+tab"`、`"space"`。
   */
  keys: readonly string[];
  scopes: readonly ActionScope[];
  /**
   * 额外条件。**相位不写在这里** —— `phase !== "idle"` 对所有动作一致，
   * 由 `matchAction` 统一挡掉，免得每个动作各判一次、漏一个就是「重建中改文件」。
   */
  when?: (state: ActionState) => boolean;
}

/** 「至少要选中一个节点」 */
const pick = (s: ActionState): boolean => s.primary >= 0;
/** 「选中的是普通节点」——块只读，改字 / 建子级 / 粘贴都得挡 */
const writable = (s: ActionState): boolean => s.primary >= 0 && !s.onBlock;

/**
 * 全部动作。
 *
 * 顺序有意义：同一个键被两条动作声明时，先声明的赢。所以把「更具体」的放前面
 * （`shift+tab` 与 `tab` 是两个不同键位，不会撞；真正会撞的是将来有人加
 *  `mod+v` 变体 —— 那时把它排在 `paste` 之前即可）。
 */
export const ACTIONS: readonly ActionDef[] = [
  // 撤销 / 重做：只在画布持有焦点时接管，否则会和编辑器里的撤销打架
  { id: "undo", keys: ["mod+z"], scopes: ["canvas"] },
  { id: "redo", keys: ["mod+shift+z", "mod+y"], scopes: ["canvas"] },

  // 结构操作
  { id: "newChild", keys: ["tab"], scopes: ["canvas"], when: writable },
  { id: "newSibling", keys: ["enter"], scopes: ["canvas"], when: writable },
  { id: "outdent", keys: ["shift+tab"], scopes: ["canvas"], when: pick },
  { id: "remove", keys: ["delete", "backspace"], scopes: ["canvas"], when: pick },

  // 改字：F2 在画布上，空格是视图级兜底（焦点跑到 body 时也要能改）
  { id: "edit", keys: ["f2", "space"], scopes: ["canvas", "view"], when: writable },

  // 方向键只换选中，不产生写入，多选时也能用
  { id: "navUp", keys: ["up"], scopes: ["canvas"] },
  { id: "navDown", keys: ["down"], scopes: ["canvas"] },
  { id: "navLeft", keys: ["left"], scopes: ["canvas"] },
  { id: "navRight", keys: ["right"], scopes: ["canvas"] },

  // Esc 两层都要：焦点常在别处
  { id: "escape", keys: ["esc"], scopes: ["canvas", "view"] },

  // Ctrl+N 只在视图层：画布层的 Ctrl+N 留给 Obsidian 自己（新建笔记）
  { id: "newNote", keys: ["mod+n"], scopes: ["view"], when: pick },

  /**
   * 粘贴 = 新建子节点 + 用剪贴板文本填充。
   *
   * 和 `newSibling` 的区别不只是键位：它**不自动进编辑框**，因为内容已经是
   * 用户想要的文字（XMind 里粘贴完就是成品主题，再弹一个全选的输入框只会挡路）。
   */
  { id: "paste", keys: ["mod+v"], scopes: ["canvas", "view"], when: writable },
];

/** `keyOf` 只用到这几个字段，用最小结构类型是为了用例能直接构造事件对象 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * 把键盘事件归一化成一个键位字符串。
 *
 * 两个容易出错的地方：
 * - `key` 受 Shift 影响（Shift+Z 是 `"Z"`），而 Shift 已经单独进前缀，
 *   所以单字符键一律转小写，否则 `mod+shift+z` 得同时写 `"z"` 和 `"Z"`；
 * - 空格在部分环境里 `key` 是 `" "`、`code` 是 `"Space"`，两个都认。
 */
export function keyOf(e: KeyLike): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  let key: string = e.key;
  if (key === " " || e.code === "Space") key = "space";
  else if (key === "Escape") key = "esc";
  else if (key === "ArrowUp") key = "up";
  else if (key === "ArrowDown") key = "down";
  else if (key === "ArrowLeft") key = "left";
  else if (key === "ArrowRight") key = "right";
  else key = key.toLowerCase();

  parts.push(key);
  return parts.join("+");
}

/**
 * 这次按键对应哪个动作（不关心怎么执行）。
 *
 * `phase !== "idle"` 一律返回 null：编辑中（键盘归输入框）、拖动中、重建中
 * （行号随时会失效）都不接受结构操作。这一条以前分散在两条 if 链里，
 * 画布那条还漏了 —— 重建中在画布上按 Tab 会拿旧快照建节点。
 */
export function matchAction(e: KeyLike, scope: ActionScope, state: ActionState): ActionId | null {
  if (state.phase !== "idle") return null;

  const key: string = keyOf(e);
  for (const a of ACTIONS) {
    if (!a.scopes.includes(scope)) continue;
    if (!a.keys.includes(key)) continue;
    if (a.when && !a.when(state)) continue;
    return a.id;
  }
  return null;
}
