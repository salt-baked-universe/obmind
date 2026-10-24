/**
 * 插入块（代码 / 引用 / 表格）的位置与文本。
 *
 * 纯函数，不碰文件也不碰 DOM —— 「插在哪一行、写成什么样」可以直接跑用例。
 *
 * 三条规则：
 * 1. 插在**节点自己那几行之后、子节点之前**。这样块在原文里的位置就紧跟着
 *    选中的节点，导图上也排在它下面。
 * 2. 插件插的块**一律带代理行** `<!-- obmind:block -->`：用户不该为了「让块能拖」
 *    去手写一行注释。有了它，块当场就能像节点一样拖动、换层级。
 * 3. 代理行与块本体用同一个缩进：列表项里缩到**标记之后**（否则块跳出列表），
 *    其余缩进一层（成为选中节点的子节点）。围栏最多能缩 3 格，一层的步长
 *    （2 格）刚好安全；再深的层级交给拖动去改代理行的缩进，块本体永远不动。
 */

import type { SrcRef } from "../types";
import { colsOfIndent } from "../domain/syntax";

export type BlockKind = "code" | "quote" | "table";

/** 自由块的代理行：它承载缩进与层级，块本体照旧顶格 */
export const BLOCK_MARK_LINE = "<!-- obmind:block -->";

export interface InsertBlockInput {
  /** 以哪个节点为宿主 */
  src: SrcRef;
  /** 缩进步长（列数），用来把代理行缩出一层 */
  step?: number;
  /** 缩进单位原文（可能是制表符）；空串表示用 step 个空格 */
  unit?: string;
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
  // 列表项里缩到标记之后；其余缩一层。两种都 ≤ 3 格，围栏照旧合法。
  const listed: string = blockIndent(src);
  const step: number = input.step && input.step > 0 ? input.step : 2;
  // 代理行承载层级，可以随便缩；块本体只能缩到「列表项标记之后」或顶格 ——
  // 围栏缩到 4 格就退化成缩进代码块了，这是唯一不能碰的底线。
  const anchorIndent: string = listed !== "" ? listed : src.indent + (input.unit || " ".repeat(step));

  const fenceLines: string[] = TEMPLATES[kind].map((line: string) =>
    line === "" ? quote.replace(/[ \t]+$/, "") : quote + listed + line,
  );
  return {
    insertAfterLine: after,
    // 代理行排在最前面：块能不能被拖动、能挂到哪一层，全看这一行的缩进
    lines: [quote + anchorIndent + BLOCK_MARK_LINE, ...fenceLines],
    // 光标落在块首行（跳过代理行），用户接着就能写内容
    blockStartLine: after + 2,
  };
}
