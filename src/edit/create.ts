/**
 * 新建节点的规则（纯函数，属于领域层）。
 *
 * 难点全在「一行文本怎么表达层级」这件事上，而笔记里有**两套**并行的层级体系：
 *
 * - 标题体系：`#` 的级数就是层级。新增子级 = 降一级标题。
 * - 正文体系：行首缩进就是层级。新增子级 = 多缩进一个步长。
 *
 * 两套不能混用，否则导图结构和笔记文本就对不上。所以这里先看目标节点属于哪套，
 * 再按那套规则生成新行。
 *
 * 另一个必须算对的东西是**插入位置**：同级节点要插在「整棵子树之后」，
 * 而不是「下一行」。父节点有孩子时，下一行是它的第一个孩子 ——
 * 插在那里，新行会变成自己的孩子，层级就错了（越加越深）。
 */

import type { SrcRef } from "../types";
import { colsOfIndent, indentOfCols } from "../domain/syntax";
import { markOf, quoteOf } from "./text";

/** 标题层级上限 */
const MAX_HEADING = 6;
/** 新节点的占位文本：写入后立刻进编辑框全选，用户直接打字覆盖 */
export const NEW_NODE_TEXT = "新节点";

export type CreateMode = "sibling" | "child";

export interface CreateInput {
  /** 以哪个节点为基准 */
  src: SrcRef;
  /** 全篇节点（按源行升序），用来算子树范围 */
  nodes: readonly SrcRef[];
  /** 缩进步长（列数） */
  step: number;
  /** 缩进单位原文（可能是制表符） */
  unit: string;
  mode: CreateMode;
  /** 占位文本，默认「新节点」 */
  placeholder?: string;
}

export interface CreatePlan {
  /** 插在第几行之后（0 基；等于 src.line 表示紧跟该节点） */
  insertAfterLine: number;
  /** 新行的完整文本 */
  line: string;
  /** 新节点预期落在第几行，供插入后自动进入编辑 */
  focusLine: number;
}

export type CreateResult =
  | { ok: true; plan: CreatePlan }
  | { ok: false; reason: string };

/**
 * 目标节点整棵子树的最后一行。
 *
 * 依赖一个前提：文档顺序与树的前序一致（由缩进/标题推导而来，成立）。
 * 所以「往下扫到第一个不比自己深的行」就是子树边界。
 */
export function subtreeEndOf(src: SrcRef, nodes: readonly SrcRef[]): number {
  let end: number = src.line;
  for (const n of nodes) {
    if (n.line <= src.line) continue;
    if (n.depth > src.depth) {
      end = n.line;
      continue;
    }
    // 同层或更浅：子树到此结束
    break;
  }
  return end;
}

/** 有序列表标记（`3. ` / `2) `）重置为第一项 */
function resetOrdered(mark: string): string {
  return mark.replace(/^(\s*)\d{1,9}([.)]\s+)/, "$11$2");
}

/**
 * 规划一次新建。
 *
 * 同级：沿用当前行的缩进与标记；有序列表编号重置为 1（避免出现 3. 后面还是 3.）。
 * 子级：标题降一级；正文多缩进一个步长，列表标记沿用父节点的样式。
 */
export function planCreate(input: CreateInput): CreateResult {
  const { src, nodes, step, unit, mode } = input;
  const text: string = input.placeholder ?? NEW_NODE_TEXT;
  const insertAfterLine: number = subtreeEndOf(src, nodes);
  const focusLine: number = insertAfterLine + 1;

  if (mode === "sibling") {
    const quote: string = quoteOf(src);
    let mark: string = markOf(src);
    if (!src.heading) mark = resetOrdered(mark);
    return {
      ok: true,
      plan: { insertAfterLine, focusLine, line: quote + src.indent + mark + text },
    };
  }

  // 子级
  if (src.heading) {
    const level: number = (src.level ?? 1) + 1;
    if (level > MAX_HEADING) {
      return { ok: false, reason: `标题最多 ${MAX_HEADING} 级，没法再加子级` };
    }
    const quote: string = quoteOf(src);
    return {
      ok: true,
      plan: {
        insertAfterLine,
        focusLine,
        line: `${quote}${"#".repeat(level)} ${text}`,
      },
    };
  }

  // 正文体系：缩进 + 一个步长。用列数相加而不是拼字符串，
  // 这样制表符缩进的笔记不会被硬塞空格（拖动时踩过这个坑）。
  const cols: number = colsOfIndent(src.indent) + Math.max(1, step);
  const indent: string = indentOfCols(cols, unit);
  let mark: string = markOf(src);
  if (src.checked !== null) mark = mark.replace(/\[[ xX]\]\s*$/, "[ ] ");
  mark = resetOrdered(mark);

  return {
    ok: true,
    plan: {
      insertAfterLine,
      focusLine,
      line: quoteOf(src) + indent + mark + text,
    },
  };
}
