/**
 * 导图规模统计：节点数 + 树深。
 *
 * 为什么单独一个纯函数：这两个数字要显示在操作栏尾端，用户拿它判断
 * 「这张图是不是被前置元数据/空行吃掉了几个节点」「我到底写到第几层了」。
 * 逻辑只有一次遍历，但边界不少（空树、折叠着的子树、软换行的续行不算节点），
 * 放进纯函数就能在 Node 里直接断言，不用起浏览器。
 *
 * 注意统计的是**树**而不是源文件的节点表：源文件里多行节点的续行不是独立节点，
 * 而树里每一层都对应一个真实节点。节点数把根（笔记名）也算进去 ——
 * 屏幕上看到的第一张卡片就是它。
 */

import type { IPureNode } from "markmap-common";

export interface TreeStats {
  /** 节点总数（含根） */
  nodes: number;
  /** 层数：只有根时为 1 */
  depth: number;
}

export function treeStats(tree: IPureNode | null | undefined): TreeStats {
  if (!tree) return { nodes: 0, depth: 0 };

  let nodes = 0;
  let depth = 0;
  // 显式栈而不是递归：深度是用户可控的（有人真的写到十几层），
  // 递归在极端文件上会栈溢出，而这里本来就是一次线性遍历
  const stack: { node: IPureNode; level: number }[] = [{ node: tree, level: 1 }];
  while (stack.length > 0) {
    const { node, level } = stack.pop() as { node: IPureNode; level: number };
    // 块（代码 / 引用 / 表格）不是用户写的「节点」：它自己有卡片，但把它算进去
    // 会让人对着「257 节点」去数屏幕上的 250 张文字卡，永远数不对。
    const isBlock: boolean = !!(node.payload as { block?: unknown } | undefined)?.block;
    if (!isBlock) {
      nodes++;
      if (level > depth) depth = level;
    }
    const children = node.children ?? [];
    for (const child of children) stack.push({ node: child, level: level + 1 });
  }
  return { nodes, depth };
}

/** 操作栏尾端的一行文案。数字与单位之间不用空格，窄侧栏里能省一点宽度 */
export function formatStats(s: TreeStats): string {
  if (s.nodes <= 0) return "";
  return `${s.nodes} 节点 · 深 ${s.depth}`;
}
