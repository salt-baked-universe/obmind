/**
 * 文本变换：把编辑动作翻译成「新的源行文本」。
 *
 * 刻意做成纯函数、不依赖 Obsidian —— 这里每一处都可能写坏用户笔记，
 * 与文件 IO 解耦后可以单独跑用例验证往返一致性。
 *
 * 铁律：不动缩进、不动列表符号、不动引用前缀，只换正文那一段。
 */

import type { SrcRef } from "../types";

/** 该行引用前缀（`> ` 可能多层） */
export function quoteOf(src: SrcRef): string {
  const m = /^(?:\s*>\s?)+/.exec(src.full);
  return m ? m[0] : "";
}

/** bodyStart 之前的「标记段」：列表符号 / 标题井号 / 任务勾选框 */
export function markOf(src: SrcRef): string {
  return src.full.slice(quoteOf(src).length + src.indent.length, src.bodyStart);
}

/**
 * 整行重写：只替换正文片段，缩进与标记原样保留。
 * @param indent 新的缩进；省略表示不变
 * @param checked 新的勾选状态；省略表示不变
 */
export function rewriteNode(
  src: SrcRef,
  text: string,
  checked?: boolean | null,
  indent?: string,
): string {
  const quote: string = quoteOf(src);
  let mark: string = markOf(src);
  const want: boolean | null = checked === undefined ? src.checked : checked;

  if (src.checked !== null && want !== src.checked) {
    mark = mark.replace(/\[[ xX]\](?=\s*$)/, want ? "[x]" : "[ ]");
  }

  const nextIndent: string = indent === undefined ? src.indent : indent;
  return quote + nextIndent + mark + text + src.full.slice(src.bodyEnd);
}

/** 计算缩进变化后的新缩进；null 表示无法再缩进/反缩进 */
export function indentBy(src: SrcRef, delta: number, step: number): string | null {
  const unit: string = src.indent.includes("\t") ? "\t" : " ".repeat(Math.max(1, step));
  if (delta > 0) return src.indent + unit;
  if (delta < 0) {
    if (src.indent.length === 0) return null;
    return src.indent.slice(0, Math.max(0, src.indent.length - unit.length));
  }
  return src.indent;
}

/**
 * 同级新节点的整行内容。
 * 有序列表要把编号 +1，任务列表沿用 `[ ]`，标题沿用相同级别。
 */
export function siblingLine(src: SrcRef, placeholder = "新节点"): string {
  const quote: string = quoteOf(src);
  let mark: string = markOf(src);

  const ordered: RegExpExecArray | null = /(\d+)([.)])(\s+)$/.exec(mark);
  if (ordered) {
    const next: number = Number.parseInt(ordered[1], 10) + 1;
    mark = mark.slice(0, ordered.index) + next + ordered[2] + ordered[3];
  }

  return quote + src.indent + mark + placeholder;
}

/**
 * 解析编辑框里的文本。
 * 任务列表的 ☐/☑ 会被剥离成勾选状态——用户把 ☐ 改成 ☑ 就等于勾上。
 */
export function parseEditorValue(
  src: SrcRef,
  raw: string,
): { text: string; checked: boolean | null } {
  let text: string = raw.trim();
  let checked: boolean | null = src.checked;

  if (src.checked !== null) {
    const m: RegExpExecArray | null = /^([☐☑])\s*/u.exec(text);
    if (m) {
      checked = m[1] === "☑";
      text = text.slice(m[0].length).trim();
    }
  }
  // 折叠内部换行：编辑框里粘贴进来的多行文本（或误触的软换行）一律压成空格，
  // 避免把一行节点拆成多个、污染导图结构。同时顺手归一化内部空白。
  text = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return { text, checked };
}
