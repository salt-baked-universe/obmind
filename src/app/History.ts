/**
 * 撤销 / 重做。
 *
 * 为什么是「整篇快照」而不是「操作反向」：
 * 写路径产出的是 Span（改哪几行），反向操作需要重新算一遍锚点，
 * 而行号在每次写入后都会变 —— 反向操作的最难点恰恰在这里。
 * 一篇笔记的纯文本最多几百 KB，存 40 份也就几 MB，用内存换正确性值得。
 *
 * 纯函数、不可变：undo/redo 返回新的历史对象，不在原对象上改。
 * 这样调用方可以先把结果算出来、写文件成功后再提交历史 —— 写入失败时
 * 历史不会出现「已经撤销但文件没变」的错位。
 *
 * 记的是**写入前的内容**：past 里每一项都是「某个时刻文件曾经的样子」。
 */

export interface HistoryState {
  /** 写入前的历史内容，栈顶在末尾 */
  past: readonly string[];
  /** 撤销掉的、还能重做的内容，最近一次在开头 */
  future: readonly string[];
}

/** 上限：40 步足够覆盖一次连续编辑，再多意义不大 */
export const HISTORY_LIMIT = 40;

export const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

export function canUndo(h: HistoryState): boolean {
  return h.past.length > 0;
}

export function canRedo(h: HistoryState): boolean {
  return h.future.length > 0;
}

/**
 * 记录一次写入：把「写之前的内容」压入 past。
 *
 * 任何新写入都会让 future 作废 —— 这是所有编辑器的共识，
 * 否则重做会把用户刚做的新操作覆盖掉。
 */
export function record(h: HistoryState, before: string): HistoryState {
  const past: string[] = [...h.past, before];
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: [],
  };
}

export interface HistoryStep {
  /** 应该写回文件的内容 */
  write: string;
  /** 提交这一步之后的历史 */
  state: HistoryState;
}

/** 撤销一步；没得撤销返回 null（调用方据此禁用按钮，不必自己判空） */
export function undo(h: HistoryState, current: string): HistoryStep | null {
  if (h.past.length === 0) return null;
  const write: string = h.past[h.past.length - 1];
  return {
    write,
    state: {
      past: h.past.slice(0, -1),
      future: [current, ...h.future].slice(0, HISTORY_LIMIT),
    },
  };
}

/** 重做一步 */
export function redo(h: HistoryState, current: string): HistoryStep | null {
  if (h.future.length === 0) return null;
  const write: string = h.future[0];
  const past: string[] = [...h.past, current];
  return {
    write,
    state: {
      past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
      future: h.future.slice(1),
    },
  };
}
