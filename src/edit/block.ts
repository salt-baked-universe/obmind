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
 * 3. **围栏类块（代码 / 公式）一律顶格**，代理行单独缩进。
 *
 * 第 3 条是踩出来的：早先让围栏跟着列表项缩到「标记之后」，浅层列表看着没问题，
 * 深层的（笔记里 11 层 tab 的提纲）算出来是 42 列 —— 列表内容列在 46，围栏比它
 * 少 4 列，既不在列表项里、又超过 3 格，Obsidian 直接当**缩进代码块**，用户看到的
 * 就是「```python 这行原样露出来」。而且这一行太脆：只要编辑器自动缩进动一下，
 * 又坏一次。顶格没有这个风险 —— 代码块跳出列表项是 Markdown 的正常形态，
 * 导图里的层级本来就只由代理行决定。
 *
 * 引用 / 表格不是围栏，`>` 与 `|` 缩到列表内容列仍然是合法的，留在列表项里更整齐。
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
  /** 代码块的语言标识（python / js / …）；留空就是裸围栏 */
  lang?: string;
}

export interface InsertBlockPlan {
  /** 插在这一行之后（0 基） */
  insertAfterLine: number;
  /** 完整行文本（已带缩进） */
  lines: string[];
  /** 插完新块之后光标/选中可以落到的块首行 */
  blockStartLine: number;
}

/** 块体是否必须顶格：围栏块缩到第 4 格就退化成缩进代码块（`>` 与 `|` 没这个限制） */
const NEEDS_TOP_FENCE: Record<BlockKind, boolean> = {
  code: true,
  quote: false,
  table: false,
};

/** 三种块的空壳。代码块留一个空行，方便直接点进去写 */
const TEMPLATES: Record<BlockKind, string[]> = {
  code: ["```", "", "```"],
  quote: ["> "],
  table: ["| 列 1 | 列 2 |", "| --- | --- |", "|  |  |"],
};

/** 语言标识只允许字母数字和 `#+._-`（和围栏 info string 的解析规则对齐） */
export function sanitizeLang(lang: string | undefined): string {
  return (lang ?? "").trim().replace(/[^A-Za-z0-9#+._-]/g, "");
}

/** 无序 / 有序列表标记：`- ` `* ` `1. ` `2) ` */
const LIST_MARK = /^(?:[-*+]\s+|\d{1,9}[.)]\s+)$/;

/**
 * 引用 / 表格的缩进。
 *
 * 列表项里的引用和表格缩进到「标记之后」的列（`- ` 是 2 列），它们就仍在列表项
 * 内部 —— 用户回头改笔记时看到的是「引用/表格属于这一条」，而不是散在外面。
 * 围栏块不走这里（缩到第 4 格就变字面量，见文件头第 3 条）。
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
  // 引用 / 表格缩到列表项的内容列；围栏类块顶格（见文件头第 3 条）
  const listed: string = NEEDS_TOP_FENCE[kind] ? "" : blockIndent(src);
  const step: number = input.step && input.step > 0 ? input.step : 2;
  // 代理行承载层级，可以随便缩：列表项里缩到标记之后没有意义（它已经不是列表项了），
  // 统一「比宿主深一层」，块挂成宿主的子节点。
  const anchorIndent: string = src.indent + (input.unit || " ".repeat(step));

  const lang: string = kind === "code" ? sanitizeLang(input.lang) : "";
  const fenceLines: string[] = TEMPLATES[kind].map((line: string, i: number) => {
    if (line === "") return quote.replace(/[ \t]+$/, "");
    const body: string = i === 0 && lang !== "" ? `${line}${lang}` : line;
    return quote + listed + body;
  });
  return {
    insertAfterLine: after,
    // 代理行排在最前面：块能不能被拖动、能挂到哪一层，全看这一行的缩进
    lines: [quote + anchorIndent + BLOCK_MARK_LINE, ...fenceLines],
    // 光标落在块首行（跳过代理行），用户接着就能写内容
    blockStartLine: after + 2,
  };
}
