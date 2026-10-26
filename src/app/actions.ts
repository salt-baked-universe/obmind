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
  | "paste"
  /**
   * 缩放与归位。
   *
   * 为什么要有键盘路径：触摸板的「捏合」在 Chromium 里是 `ctrlKey` 的 wheel，
   * 但 Windows 的精密触摸板驱动不一定合成它（Electron 尤其飘）。没有这组键，
   * 一个只用触摸板的人就没有任何缩放手段 —— 滚轮已经被判成平移了。
   */
  | "zoomIn"
  | "zoomOut"
  | "zoomFit";

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

/**
 * 「中心主题」的伪行号。
 *
 * 根节点是**笔记文件名**，文档里没有这一行 —— 它没有 `src`，拿不到行号。
 * 但它是可以选中的（用户想点在它上面按 Tab 加一条分支），而选中态记的是源行号，
 * 所以给它一个负数身份：所有要求 `primary >= 0` 的动作（改字、删除、缩进、
 * 加同级、粘贴）都会自然把它排除，只有「新建子级」显式认它。
 *
 * 为什么不是 0：0 是合法行号，frontmatter 的 `---` 就在第 0 行。
 */
export const ROOT_LINE = -2;

/** 动作执行时的只读状态快照。视图每次按键现算，动作不持有任何状态 */
export interface ActionState {
  phase: Phase;
  /** 主选中行（-1 = 没选中任何节点） */
  primary: number;
  /** 选中集合大小（> 1 表示框选 / Shift 区间） */
  selectionSize: number;
  /** 主选中是块（只读叶子：能删、能拖，不能改字、不能在它下面建节点） */
  onBlock: boolean;
  /**
   * 主选中是**中心主题**（= 笔记文件名，没有源行）。
   *
   * 它能做的只有「新建子级」一件事：改字等于重命名文件、删除等于删掉整篇、
   * 加同级无处可加、缩进没有意义。所以这里不用一个 `primary >= 0` 混过去 ——
   * 根的行号是负数，所有要求 `primary >= 0` 的动作已经天然被挡，
   * 只有 `newChild` 显式放行。
   */
  onRoot: boolean;
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
 * 「能在它下面挂一个子节点」：普通节点，或中心主题本身。
 *
 * 中心主题是唯一没有源行却能长孩子的东西 —— 它的孩子就是文档最外层节点。
 * 粘贴也放行到这里，但 `runAction` 里对根只给一句提示不真干活：那条路要按行
 * 剥前缀再算缩进，根没有「父行」可参照，静默无反应比拒绝更像 bug。
 */
const childable = (s: ActionState): boolean => s.onRoot || (s.primary >= 0 && !s.onBlock);

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
  { id: "newChild", keys: ["tab"], scopes: ["canvas"], when: childable },
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
  { id: "paste", keys: ["mod+v"], scopes: ["canvas", "view"], when: childable },

  /**
   * 缩放与归位。三个键位都按**物理键位**注册：Shift+= 送来的 key 是 `+`、
   * Shift+- 是 `_`，但用户按的是同一个键，不该因为按住 Shift 就变成另一个动作
   * （见 keyOf 里按 `code` 归一化那一段）。所以 `mod+=` 与 `mod+shift+=` 都要列。
   *
   * 不挂在 `when: pick` 上：没选中节点也该能缩放，这是纯视口操作。
   */
  { id: "zoomIn", keys: ["mod+=", "mod+shift+="], scopes: ["canvas", "view"] },
  { id: "zoomOut", keys: ["mod+-", "mod+shift+-"], scopes: ["canvas", "view"] },
  { id: "zoomFit", keys: ["mod+0"], scopes: ["canvas", "view"] },
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
  // 等号 / 减号 / 零按**物理键位**归一：Shift+= 送来的 key 是 `"+"`、Shift+- 是
  // `"_"`，小键盘是 `"Add"` / `"Subtract"` / 布局差异更大。缩放键只关心「按了哪个
  // 位置」，不然同一件事要在表里写三四个键位字符串，而 shift 状态已经在前缀里了。
  else if (e.code === "Equal") key = "=";
  else if (e.code === "Minus") key = "-";
  else if (e.code === "NumpadAdd") key = "=";
  else if (e.code === "NumpadSubtract") key = "-";
  else if (e.code === "Digit0" || e.code === "Numpad0") key = "0";
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
