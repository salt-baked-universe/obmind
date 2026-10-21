/**
 * 折叠状态保持。
 *
 * 编辑回写后要走 setData 重建整棵树，而重建会把 payload.fold 冲掉——
 * 用户辛苦折起来的十几个分支会全部弹开，这在实际使用里非常烦人。
 *
 * 这里用「从根出发的孩子索引路径」（"0/2/1"）来记住哪些节点是折叠的：
 * 纯数字下标，与节点文字无关，只改文字时结构不变，位置就一定对得上。
 */

import type { IPureNode } from "markmap-common";

export type IndexPath = string;

function isFolded(node: IPureNode): boolean {
  const fold = node.payload?.fold;
  return typeof fold === "number" && fold > 0;
}

/** 收集所有处于折叠状态的节点 */
export function collectFolds(root: IPureNode | undefined): Set<IndexPath> {
  const out = new Set<IndexPath>();
  if (!root) return out;

  const walk = (node: IPureNode, path: IndexPath): void => {
    if (isFolded(node)) out.add(path);
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], path ? `${path}/${i}` : String(i));
    }
  };
  walk(root, "");
  return out;
}

/** 把折叠状态写回新树的 payload，必须在 setData 之前调用 */
export function applyFolds(root: IPureNode, folded: Set<IndexPath>): void {
  if (folded.size === 0) return;

  const walk = (node: IPureNode, path: IndexPath): void => {
    if (folded.has(path)) node.payload = { ...node.payload, fold: 1 };
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], path ? `${path}/${i}` : String(i));
    }
  };
  walk(root, "");
}
