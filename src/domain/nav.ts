/**
 * 方向键导航（L1 domain）。
 *
 * 「上下左右换选中节点」这件事只依赖两样东西：节点的文档顺序（源行号）
 * 和谁被折叠了。两者都能从树本身算出来，所以放在 domain 里，用 Node 直接跑用例 ——
 * 不用启动 Obsidian，也不用等 markmap 把 DOM 画出来。
 *
 * 折叠状态从**活树**读（`mm.state.data`），不是从解析结果读：markmap 每次
 * 展开/折叠只改它自己手里那份 payload，解析出来的那棵树是旧的。
 *
 * 导航语义分两条轴，各管一件事（1.16.1 按用户要求定）：
 * - 上 / 下：**只走末端节点**（没有孩子的，或者折叠了的 —— 折叠的在屏幕上
 *   本来就是末端）。中间那些带子树的容器节点不参与，否则按几下 ↓ 就落到
 *   一个「看起来是一行字、其实是个分支」的节点上，手感跟在大纲里跳行完全不同。
 * - 左：父节点（根节点没有可选项，停在原地）
 * - 右：第一个孩子（折叠着就展开再进去）
 *
 * 两条轴互不干扰：层级只由左右负责，上下从不改变深度。
 */

import type { SrcRef } from "../types";

/** 导航需要的树的最小形状：只要源坐标和折叠标记 */
export interface NavNode {
  payload?: {
    src?: SrcRef;
    /** >0 表示折叠（markmap 的约定） */
    fold?: number;
  };
  children?: readonly NavNode[];
}

function isFolded(n: NavNode): boolean {
  const fold = n.payload?.fold;
  return typeof fold === "number" && fold > 0;
}

/**
 * 屏幕上真正看得见的节点，按文档顺序。
 *
 * - 根节点（文件名）没有 src，跳过 —— 它不能编辑、也不能删；
 * - 折叠节点的子树整片跳过：它们没有 DOM，方向键选过去就成了「选中框消失」。
 */
export function visibleRefs(root: NavNode | null | undefined): SrcRef[] {
  const out: SrcRef[] = [];
  const walk = (n: NavNode): void => {
    const src = n.payload?.src;
    if (src && typeof src.line === "number") out.push(src);
    if (isFolded(n)) return;
    for (const c of n.children ?? []) walk(c);
  };
  if (root) walk(root);
  return out;
}

/**
 * 可见的**末端**节点，按文档顺序。
 *
 * 末端 = 没有孩子，或者被折叠了。折叠节点在屏幕上就是一根末梢（子树没有 DOM），
 * 所以它自己也该算进来 —— 否则折叠之后这个节点永远选不到。
 *
 * 上下方向键只在这条序列里走：深度不会变，走到头也不会绕回。
 */
export function visibleLeafRefs(root: NavNode | null | undefined): SrcRef[] {
  const out: SrcRef[] = [];
  const walk = (n: NavNode): void => {
    const kids: readonly NavNode[] = isFolded(n) ? [] : (n.children ?? []);
    if (kids.length > 0) {
      for (const c of kids) walk(c);
      return;
    }
    const src = n.payload?.src;
    if (src && typeof src.line === "number") out.push(src);
  };
  if (root) walk(root);
  return out;
}

/**
 * 上 / 下：末端节点序列里的前一个 / 后一个。
 *
 * 到边界就停（不绕回另一头）—— 绕回会让人以为「按一下跑到了图的最下面」。
 * 没有任何选中时：向下取第一个，向上取最后一个。
 *
 * 起点不在序列里（选中的是带子树的容器节点：用 ← 从子级退回来，或刚点了一下
 * 分支标题）时，按行号找它之后 / 之前的第一个末端 —— 这样「↓」永远有个落点，
 * 不会因为「你不是叶子」就毫无反应。
 */
export function stepVisible(
  refs: readonly SrcRef[],
  line: number,
  dir: 1 | -1,
): SrcRef | null {
  if (refs.length === 0) return null;
  if (line < 0) return dir > 0 ? refs[0] : refs[refs.length - 1];

  const at = refs.findIndex((r) => r.line === line);
  if (at >= 0) {
    const next = at + dir;
    return next < 0 || next >= refs.length ? null : refs[next];
  }

  if (dir > 0) return refs.find((r) => r.line > line) ?? null;
  for (let i = refs.length - 1; i >= 0; i -= 1) if (refs[i].line < line) return refs[i];
  return null;
}

/**
 * 右：第一个孩子。
 *
 * 「紧跟在后面、恰好深一层」的那个就是长子 —— 中间插不进来别的节点，
 * 因为文档顺序里父节点之后第一行要么是它的第一个孩子，要么是更浅的下一段。
 * 扫描遇到同层或更浅就说明没有孩子。
 */
export function firstChildRef(
  nodes: readonly SrcRef[],
  line: number,
): SrcRef | null {
  const at = nodes.findIndex((n) => n.line === line);
  if (at < 0) return null;
  const depth = nodes[at].depth;
  for (let i = at + 1; i < nodes.length; i++) {
    const d = nodes[i].depth;
    if (d <= depth) return null;
    if (d === depth + 1) return nodes[i];
  }
  return null;
}
