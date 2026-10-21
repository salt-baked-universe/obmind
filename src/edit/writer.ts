/**
 * 回写层：把一次行区间替换安全地落到笔记文件里。
 *
 * 设计原则（都是踩过的坑）：
 * 1. 只动目标行，不重排整篇 —— 具体的文本变换在 edit/text.ts（纯函数）。
 * 2. 写之前校验：锚点行必须仍是解析时读到的那一行。用户在编辑器里同时改了
 *    导致行号漂移时，宁可失败并提示，也不能错位写入（那是数据损坏）。
 * 3. 有打开的编辑器就走 Editor API（transaction）——保留光标、保留 Ctrl+Z；
 *    没有才退回 vault.process。
 */

import { App, Editor, EditorPosition, MarkdownView, TFile } from "obsidian";

/** 一次行区间替换；空 lines 表示删除这些行 */
export interface Span {
  /** 起始行（0 基） */
  start: number;
  /** 结束行（不含） */
  end: number;
  /** 替换成的行 */
  lines: string[];
  /** 冲突校验：第 checkLine 行必须仍等于 checkText */
  checkLine: number;
  checkText: string;
}

/** 找到正在打开这篇笔记的编辑器（优先活跃视图） */
export function findEditor(app: App, file: TFile): Editor | null {
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.file?.path === file.path) return active.editor;
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path) return view.editor;
  }
  return null;
}

/** 把 Span 折算成 Editor 的一次区间替换（注意换行符的归属） */
function buildChange(
  editor: Editor,
  span: Span,
): { from: EditorPosition; to: EditorPosition; text: string } {
  const last = Math.max(0, editor.lineCount() - 1);
  const joined = span.lines.join("\n");

  // 插入：插在 start 行之前（start 可以大于最后一行，即追加到文末）
  if (span.start === span.end) {
    if (span.start > last) {
      const ch = editor.getLine(last).length;
      return { from: { line: last, ch }, to: { line: last, ch }, text: "\n" + joined };
    }
    return { from: { line: span.start, ch: 0 }, to: { line: span.start, ch: 0 }, text: joined + "\n" };
  }

  // 删除到文件末尾：连上一行的换行一起吃掉，否则会留下一个空行
  if (span.end > last) {
    if (span.lines.length === 0 && span.start > 0) {
      const prev = span.start - 1;
      const ch = editor.getLine(prev).length;
      return {
        from: { line: prev, ch },
        to: { line: last, ch: editor.getLine(last).length },
        text: "",
      };
    }
    return {
      from: { line: span.start, ch: 0 },
      to: { line: last, ch: editor.getLine(last).length },
      text: joined,
    };
  }

  // 普通替换 / 删除：右端落在行首，顺带吃掉这些行的换行符
  return {
    from: { line: span.start, ch: 0 },
    to: { line: span.end, ch: 0 },
    text: span.lines.length === 0 ? "" : joined + "\n",
  };
}

/**
 * 整篇替换。拖动改变层级没法用「行区间替换」表达——一行会被搬到很远的地方，
 * 所以直接算好整篇新内容再一次性写入，中途不存在半个状态。
 *
 * @returns true = 已写入；false = 文件已变化（与 expect 不一致），什么都没做
 */
export async function replaceAll(
  app: App,
  file: TFile,
  next: string,
  expect: string,
): Promise<boolean> {
  const editor = findEditor(app, file);

  if (editor) {
    // 用户在编辑器里同时改过，就不动，宁可失败也不覆盖别人的改动
    if (editor.getValue() !== expect) return false;
    const last: number = Math.max(0, editor.lineCount() - 1);
    editor.transaction({
      changes: [
        {
          from: { line: 0, ch: 0 },
          to: { line: last, ch: editor.getLine(last).length },
          text: next,
        },
      ],
    });
    return true;
  }

  let ok = false;
  await app.vault.process(file, (data: string) => {
    if (data !== expect) return data;
    ok = true;
    return next;
  });
  return ok;
}

/**
 * 应用一次行区间替换（改文字、缩进、新建同级、删行都走这里）。
 * @returns true = 已写入；false = 源文件已变化（锚点行对不上），什么都没做
 */
export async function applySpan(app: App, file: TFile, span: Span): Promise<boolean> {
  const editor = findEditor(app, file);

  if (editor) {
    if (span.checkLine >= editor.lineCount()) return false;
    if (editor.getLine(span.checkLine) !== span.checkText) return false;
    editor.transaction({ changes: [buildChange(editor, span)] });
    return true;
  }

  let ok = false;
  await app.vault.process(file, (data: string) => {
    const lines: string[] = data.split("\n");
    if (lines[span.checkLine] !== span.checkText) return data;
    ok = true;
    lines.splice(span.start, span.end - span.start, ...span.lines);
    return lines.join("\n");
  });
  return ok;
}
