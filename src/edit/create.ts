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
  /** 插在第几行之后（0 基；等于 src.line 表示紧跟该节点；**-1 = 全文为空，插在最前面**） */
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
 *
 * 块的尾巴要算进来：块依附在节点上、本身不是节点，最后一个子节点可能带着
 * 一段代码/引用一直延伸到块末行。漏掉它，新建的同级节点会插进块中间 ——
 * 而块归「前一个节点」，于是那块内容就改挂到新节点上了。
 */
export function subtreeEndOf(src: SrcRef, nodes: readonly SrcRef[]): number {
  // 块是叶子：它的「子树」就是它自己那几行，下面缩进更深的正文属于别人
  if (src.blockNode) return Math.max(src.line, src.blockEnd ?? src.line);
  let end: number = Math.max(src.line, src.blockEnd ?? src.line);
  for (const n of nodes) {
    if (n.line <= src.line) continue;
    if (n.depth > src.depth) {
      end = Math.max(end, n.line, n.blockEnd ?? n.line);
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

  // callout 的标题行（`> [!NOTE] xxx`）：它不是列表项，`mark` 会算出 `[!NOTE] `，
  // 照搬会凭空造出一个新 callout；而它的「同级」必须落到引用**外面**，
  // 因为 callout 里面任何一行都是它的后代。
  const calloutHead: boolean = /^[ \t]*>[ \t]?\[!/.test(src.full);

  if (mode === "sibling") {
    const quote: string = calloutHead ? "" : quoteOf(src);
    let mark: string = calloutHead ? "" : markOf(src);
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

  // callout 的标题：子节点就是引用里的第一层，不能再缩进
  // （缩进一个步长会掉进「正文第一行的孩子」那一层）
  if (calloutHead) {
    return {
      ok: true,
      plan: {
        insertAfterLine,
        focusLine,
        line: quoteOf(src) + text,
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

/**
 * 根节点下新建子节点。
 *
 * 根节点是**文件名**，不是文档里的某一行 —— 它没有 `src`，所以 `planCreate`
 * 那套「照抄父行的缩进/标记」在这里完全用不上。根的子级就是文档里最外层的
 * 节点，写回去只有两种合法形态：
 *
 * - 文档有标题体系（存在 `#` 节点）：新行必须是一级标题 `# 新节点`，
 *   否则它会变成某个标题下的正文，挂在错误的父节点上；
 * - 文档没有标题（纯缩进体系）：新行必须是**顶格**正文。
 *
 * 位置放在全文末尾（= 根的最后一个子节点之后），和 XMind 里「Tab 在中心主题上
 * 加分支」一致。这里不能照搬 `subtreeEndOf`：根没有行号，而且根的子树就是全文，
 * 结果一样，但少一层对空文档的例外。
 */
export interface CreateRootInput {
  /** 整篇原文 */
  content: string;
  /** 全篇节点，只用来判断有没有标题体系 */
  nodes: readonly SrcRef[];
  /** 缩进单位原文（可能是制表符） */
  unit: string;
  placeholder?: string;
}

/** 围栏行（``` 或 ~~~，最多缩 3 格）。只用于判断「末尾是不是还在代码块里」 */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** 扫到 `end` 行为止，文档是否还停在未闭合的围栏里 */
function inOpenFence(lines: readonly string[], end: number): boolean {
  let marker: string | null = null;
  const last: number = Math.min(end, lines.length - 1);
  for (let i = 0; i <= last; i++) {
    const m: RegExpExecArray | null = FENCE_LINE.exec(lines[i]);
    if (!m) continue;
    if (marker === null) marker = m[1].charAt(0);
    else if (m[1].charAt(0) === marker) marker = null;
  }
  return marker !== null;
}

export function planCreateRoot(input: CreateRootInput): CreateResult {
  const text: string = input.placeholder ?? NEW_NODE_TEXT;
  const lines: string[] = input.content.split("\n");

  // 跳过末尾的空行：新节点接在最后一个有内容的行后面
  let at: number = lines.length - 1;
  while (at >= 0 && lines[at].trim() === "") at--;

  // 末尾还停在围栏里的话，插进去的那行会被当成代码 —— 用户敲的是标题，
  // 存下来变成一段代码，比直接拒绝更糟。
  if (inOpenFence(lines, at)) {
    return { ok: false, reason: "笔记末尾有个没写闭合的代码块，先补上 ``` 再新建" };
  }

  const heading: boolean = input.nodes.some((n: SrcRef) => n.heading);
  // at < 0 = 全文都是空行：插在最前面，得到的就是第 0 行
  return {
    ok: true,
    plan: {
      insertAfterLine: at,
      focusLine: at + 1,
      line: heading ? `# ${text}` : `${indentOfCols(0, input.unit)}${text}`,
    },
  };
}
