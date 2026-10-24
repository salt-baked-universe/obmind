/**
 * 插入块（代码 / 引用 / 表格）的位置与文本。
 *
 * 纯函数，不碰文件也不碰 DOM —— 「插在哪一行、写成什么样」可以直接跑用例。
 *
 * 两条规则：
 * 1. 插在**节点自己那几行之后、子节点之前**。块的归属是「前面最近的那个节点行」，
 *    所以只有这个位置能让新块挂到用户选中的那个节点上；插到子树末尾会归给最后一个后代。
 * 2. 块的缩进只有两种：正文 / 标题体系里**顶格**（围栏块缩进 4 格就退化成
 *    「缩进代码块」，``` 变字面量）；列表项里缩进到**标记之后**
 *    （否则块会跳出列表项，Obsidian 里就成了列表外面的一段代码）。
 */

import type { SrcRef } from "../types";
import { colsOfIndent } from "../domain/syntax";

export type BlockKind = "code" | "quote" | "table";

export interface InsertBlockInput {
  /** 以哪个节点为宿主 */
  src: SrcRef;
}

export interface InsertBlockPlan {
  /** 插在这一行之后（0 基） */
  insertAfterLine: number;
  /** 完整行文本（已带缩进） */
  lines: string[];
  /** 插完新块之后光标/选中可以落到的块首行 */
  blockStartLine: number;
}

/** 三种块的空壳。代码块留一个空行，方便直接点进去写 */
const TEMPLATES: Record<BlockKind, string[]> = {
  code: ["```", "", "```"],
  quote: ["> "],
  table: ["| 列 1 | 列 2 |", "| --- | --- |", "|  |  |"],
};

/** 无序 / 有序列表标记：`- ` `* ` `1. ` `2) ` */
const LIST_MARK = /^(?:[-*+]\s+|\d{1,9}[.)]\s+)$/;

/**
 * 块的缩进。
 *
 * 列表项里的块必须缩进到「标记之后」的列（`- ` 是 2 列），否则它不在列表项内部 ——
 * 导图里归属不受影响（归属只看顺序），但笔记里那一块的版式会散开，
 * 用户回头改笔记时看到的就是「代码跑到列表外面了」。
 */
function blockIndent(src: SrcRef): string {
  if (src.heading || src.marker === "" || !LIST_MARK.test(src.marker)) return "";
  return src.indent + " ".repeat(colsOfIndent(src.marker) || src.marker.length);
}

/**
 * 节点所在行的引用前缀（`> ` / `  > `）。
 *
 * callout 里的行**每一行都必须以 `>` 开头**，否则围栏块会直接落在 callout 外面：
 * Obsidian 里就成了「引用结束 + 一段裸代码」，导图里那个块还会改归给引用之后的行。
 */
function quotePrefixOf(src: SrcRef): string {
  const m: RegExpExecArray | null = /^(?:[ \t]*>[ \t]?)+/.exec(src.full);
  return m ? m[0] : "";
}

export function insertBlockPlan(input: InsertBlockInput, kind: BlockKind): InsertBlockPlan {
  const { src } = input;
  // 跳过软换行续行与已有块：插在它们之前会把节点自己的行劈开
  const after: number = Math.max(src.line, src.endLine, src.blockEnd ?? src.line);
  const quote: string = quotePrefixOf(src);
  const indent: string = blockIndent(src);
  return {
    insertAfterLine: after,
    lines: TEMPLATES[kind].map((line: string) =>
      line === "" ? quote.replace(/[ \t]+$/, "") : quote + indent + line,
    ),
    blockStartLine: after + 1,
  };
}
