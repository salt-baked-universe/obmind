/**
 * 拖动改变层级：把「某一行 + 它下面所有后代行」整块搬到新位置。
 *
 * 为什么这件事比看起来麻烦：
 * 笔记的层级是靠**文本本身**表达的（缩进或 `#` 数量），不是靠某个结构字段。
 * 所以「移动节点」= 删除一段连续行 + 在别处插入 + 重写这一块里每一行的缩进/标题级别。
 * 一旦算错，笔记结构就毁了，而且用户很难手动修回来。
 *
 * 因此这里全部做成纯函数：不碰 DOM、不碰 Obsidian。
 * 输入原文行数组和解析出来的节点坐标，输出新的行数组，可以被单独跑用例验证。
 *
 * 两条硬规则：
 * 1. 标题节点和正文节点是**两套层级体系**（`#` 数量 vs 缩进空格），混着拖会互相破坏，
 *    所以只允许「标题↔标题」「正文↔正文」，以及「正文拖到标题下当子节点」。
 * 2. 位移量一律以**目标节点为参照物**做相对计算，不去推导全局的标题栈，
 *    这样混合结构（标题里有缩进列表）也不会算偏。
 *
 * 缩进相关的两个坑（都踩过）：
 * - **度量必须和解析一致**。制表符在解析里算 1 层、这里早先按 4 空格算，
 *   于是制表符缩进的笔记拖一次深度就翻倍。现在统一用 `colsOfIndent` 折成列数。
 * - **不要自己算「子节点该缩进多少」**。目标已有子节点时直接沿用那个子节点的缩进，
 *   这样新兄弟与老兄弟的缩进逐字符一致；只有没有子节点时才用「目标 + 步长」兜底。
 */

import type { IPureNode } from "markmap-common";
import { colsOfIndent } from "../domain/syntax";
import type { DropMode, SrcRef } from "../types";

/** 从节点树里按行号顺序取出所有源坐标（折叠中的节点也在树里，不会漏） */
export function collectSrc(root: IPureNode): SrcRef[] {
  const out: SrcRef[] = [];
  const walk = (n: IPureNode): void => {
    const src = (n.payload as { src?: SrcRef } | undefined)?.src;
    if (src) out.push(src);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out.sort((a, b) => a.line - b.line);
}

export type { DropMode } from "../types";

export interface MoveInput {
  /** 整篇正文按 \n 切分的行数组 */
  lines: string[];
  /** 解析时的节点坐标，必须按 line 升序 */
  nodes: SrcRef[];
  /** 缩进步长（列数） */
  step: number;
  /** 缩进单位：原文实际用的空白串（可能是制表符）；空串表示用 step 个空格 */
  unit?: string;
  srcLine: number;
  targetLine: number;
  mode: DropMode;
}

export type MoveResult =
  | { ok: true; lines: string[]; reason?: undefined }
  | { ok: false; lines?: undefined; reason: string };

const HEADING_RE = /^(#{1,6})(\s+)/;
/** 引用前缀（`> ` 可能多层），与解析器用同一套规则 */
const QUOTE_PREFIX = /^(?:\s*>\s?)+/;

/** 一行的「引用前缀 + 引用段内的缩进」拆开 */
function splitLine(line: string): { quote: string; ws: string; body: string } {
  const q: RegExpExecArray | null = QUOTE_PREFIX.exec(line);
  const quote: string = q ? q[0] : "";
  const rest: string = line.slice(quote.length);
  const m: RegExpExecArray | null = /^[ \t]*/.exec(rest);
  const ws: string = m ? m[0] : "";
  return { quote, ws, body: rest.slice(ws.length) };
}

/** 一行缩进的列数（引用段之内，与解析器同一套度量） */
function colsOf(line: string): number {
  return colsOfIndent(splitLine(line).ws);
}

/** 把列数还原成缩进字符串：优先用原文的缩进单位，余数补空格 */
function renderIndent(cols: number, unit: string, step: number): string {
  const safeStep: number = Math.max(1, step);
  const levels: number = Math.floor(cols / safeStep);
  const rest: number = cols - levels * safeStep;
  const one: string = unit === "" ? " ".repeat(safeStep) : unit;
  return one.repeat(levels) + " ".repeat(rest);
}

/**
 * 一个节点在原文里占据的行区间：从它自己那行，到它最后一个后代那行。
 * 中间的空行、代码块都会被一起带走——它们属于这一块内容。
 *
 * 注意尾巴不一定落在某个节点行上：块（代码 / 引用 / 表格）**依附**在节点上、
 * 本身不是节点，所以最后一个子节点的块可能一直延伸到块末行。
 * 只看 `nodes[i].line` 会把块留在原地 —— 搬走节点之后，那段代码就「依附」
 * 到别人身上去了（内容还在，但导图里跑到了另一个节点下面）。
 */
export function blockRange(nodes: SrcRef[], index: number): { start: number; end: number } {
  const start: number = nodes[index].line;
  const depth: number = nodes[index].depth;
  let end: number = Math.max(start, nodes[index].blockEnd ?? start);
  for (let i = index + 1; i < nodes.length; i++) {
    if (nodes[i].depth <= depth) break;
    end = Math.max(end, nodes[i].line, nodes[i].blockEnd ?? nodes[i].line);
  }
  return { start, end };
}

/**
 * 行区间 [start, end] 里哪些行是**块**（相对下标）。
 *
 * 搬动一个节点时，块行必须逐字保留：
 * - 加缩进会改掉代码本身的缩进（Java/Python 代码立刻变形）；
 * - 一旦缩进到 4 格，围栏块在 CommonMark 里就退化成「缩进代码块」，``` 变字面量。
 * 块按位置归属，所以原样搬走仍然属于同一个节点，不需要任何重排。
 */
function frozenIn(nodes: readonly SrcRef[], start: number, end: number): Set<number> {
  const out = new Set<number>();
  for (const n of nodes) {
    const bs: number | undefined = n.blockStart;
    const be: number | undefined = n.blockEnd;
    if (bs === undefined || be === undefined) continue;
    if (be < start || bs > end) continue;
    const from: number = Math.max(start, bs);
    const to: number = Math.min(end, be);
    for (let l = from; l <= to; l++) out.add(l - start);
  }
  return out;
}

/** 这一行的引用前缀（`> ` / `  > `），move 系列要用它把整块搬进/搬出 callout */
function quoteOf(src: SrcRef): string {
  const m: RegExpExecArray | null = QUOTE_PREFIX.exec(src.full);
  return m ? m[0] : "";
}

/**
 * 目标位置该用什么引用前缀。
 *
 * - 拖到 callout 里的行上：沿用那一层的 `>`（否则块会掉到引用外面）；
 * - 拖到 callout 的**标题**上：`child` 是进到 callout 里面（保留 `>`），
 *   而 before / after 是「跟这个 callout 平级」，必须到引用外面（清空 `>`）。
 */
function targetQuoteFor(tgt: SrcRef, mode: DropMode): string {
  const head: boolean = /^[ \t]*>[ \t]?\[!/.test(tgt.full);
  if (head && mode !== "child") return "";
  return quoteOf(tgt);
}

/** 把整块行的引用前缀统一换成目标位置的前缀（缩进、标记、块内容都原样保留） */
function rebaseQuote(block: string[], to: string): string[] {
  return block.map((line: string) => {
    if (line.trim() === "") return line;
    const { quote, ws, body } = splitLine(line);
    if (quote === to) return line;
    return to + ws + body;
  });
}

/** 把一块行整体平移缩进；delta 为 0 的行原样保留（不动原文写法） */
function shiftBlock(
  block: string[],
  delta: number,
  unit: string,
  step: number,
  frozen?: Set<number>,
): string[] {
  if (delta === 0) return block.slice();

  return block.map((line: string, i: number): string => {
    if (line.trim() === "") return line;
    // 块（代码 / 引用 / 表格）是内容，不是结构：一个字符都不动
    if (frozen?.has(i)) return line;
    const { quote, ws, body } = splitLine(line);
    const cols: number = colsOfIndent(ws);
    const next: number = Math.max(0, cols + delta);
    if (next === cols) return line;
    return quote + renderIndent(next, unit, step) + body;
  });
}

/**
 * 标题块只改 `#` 数量，正文子行不动（它们的深度由标题栈自动跟随）。
 *
 * 块行同样不动：shell / yaml 里的 `# 注释` 也会命中标题正则，
 * 跟着改级数就把代码改坏了。
 */
function rewriteHeadingBlock(
  block: string[],
  fromBase: number,
  toBase: number,
  frozen?: Set<number>,
): string[] {
  const delta: number = toBase - fromBase;
  if (delta === 0) return block.slice();

  return block.map((line: string, i: number): string => {
    if (line.trim() === "") return line;
    if (frozen?.has(i)) return line;
    const m: RegExpExecArray | null = HEADING_RE.exec(line);
    if (!m) return line;
    const level: number = Math.min(6, Math.max(1, m[1].length + delta));
    return "#".repeat(level) + line.slice(m[1].length);
  });
}

/**
 * 目标节点「第一层子节点」的缩进列数。
 *
 * 直接沿用现有子节点的缩进，比按步长自己算可靠：笔记里同一层可能用 2 空格也可能用
 * 制表符，甚至夹杂手写的奇数缩进，自己算出来的缩进会和老兄弟不一致，
 * 在导图上就表现为「多空格、层级突然变了」。
 */
function childIndentCols(nodes: SrcRef[], tgtIdx: number): number | null {
  const tgt: SrcRef = nodes[tgtIdx];
  for (let i = tgtIdx + 1; i < nodes.length; i++) {
    if (nodes[i].depth <= tgt.depth) break;
    // 标题节点下面可能先出现子标题，子标题不吃缩进，跳过
    if (!nodes[i].heading) return colsOfIndent(nodes[i].indent);
  }
  return null;
}

/**
 * 计算一次拖动后的完整正文。
 * 返回新行数组；不合法时返回原因，调用方不该写文件。
 */
export function moveNode(input: MoveInput): MoveResult {
  const { lines, nodes, step, srcLine, targetLine, mode } = input;
  const unit: string = input.unit ?? "";

  const srcIdx: number = nodes.findIndex((n) => n.line === srcLine);
  const tgtIdx: number = nodes.findIndex((n) => n.line === targetLine);
  if (srcIdx < 0 || tgtIdx < 0) return { ok: false, reason: "找不到对应节点" };
  if (srcIdx === tgtIdx) return { ok: false, reason: "不能拖到自己身上" };

  const src: SrcRef = nodes[srcIdx];
  const tgt: SrcRef = nodes[tgtIdx];

  const srcBlock = blockRange(nodes, srcIdx);
  const tgtBlock = blockRange(nodes, tgtIdx);

  // 拖进自己的子树 = 把自己挂到自己下面，结构会成环
  if (tgt.line > srcBlock.start && tgt.line <= srcBlock.end) {
    return { ok: false, reason: "不能移到自己的子节点下面" };
  }

  // 标题与正文互拖：只有「正文 → 标题下当子节点」这一种说得通
  if (src.heading && !tgt.heading) {
    return { ok: false, reason: "标题不能拖到正文节点上" };
  }
  if (!src.heading && tgt.heading && mode !== "child") {
    return { ok: false, reason: "正文不能和标题平级，只能拖到标题上当子节点" };
  }

  const block: string[] = lines.slice(srcBlock.start, srcBlock.end + 1);
  if (block.length === 0) return { ok: false, reason: "空节点" };
  /** 块行原样搬（不加缩进、不改 `#` 级数） */
  const frozen: Set<number> = frozenIn(nodes, srcBlock.start, srcBlock.end);

  // 插入位置：before 插在目标行之前；after 插在目标整块之后。
  // child 拖到标题上时插在标题行的正下方（成为第一个子节点）——
  // 若插到整块末尾，会落到该标题最后一个小节的后面，深度就比预期深一层。
  // 「正下方」要跳过标题自己依附的块，否则新节点会插在块前面，
  // 而块归「前一个节点」—— 于是块就改挂在刚插进来的新节点上了。
  const insertAfterHeading: boolean = mode === "child" && tgt.heading;
  const rawInsertAt: number = insertAfterHeading
    ? Math.min((tgt.blockEnd ?? tgt.line) + 1, lines.length)
    : mode === "before"
      ? tgt.line
      : Math.min(tgtBlock.end + 1, lines.length);
  let insertAt: number = rawInsertAt;

  let rewritten: string[];

  if (src.heading) {
    const srcLevel: number = src.level ?? 1;
    const tgtLevel: number = tgt.level ?? 1;
    const newLevel: number = mode === "child" ? tgtLevel + 1 : tgtLevel;
    if (newLevel > 6) return { ok: false, reason: "标题层级超过 6 级了" };
    rewritten = rewriteHeadingBlock(block, srcLevel, newLevel, frozen);
  } else {
    const srcCols: number = colsOf(src.full);
    const tgtCols: number = colsOf(tgt.full);
    let newCols: number;

    if (mode === "child") {
      const childCols: number | null = childIndentCols(nodes, tgtIdx);
      if (childCols !== null) newCols = childCols;
      else if (tgt.heading) newCols = 0; // 标题不吃缩进，它的直接子节点缩进为 0
      else newCols = tgtCols + step;
    } else {
      newCols = tgtCols; // 变成目标的兄弟：缩进与目标一致
    }

    rewritten = shiftBlock(block, newCols - srcCols, unit, step, frozen);
  }
  rewritten = rebaseQuote(rewritten, targetQuoteFor(tgt, mode));

  // 先删后插，注意插入点落在被删区间之后时要前移
  const rest: string[] = lines.slice(0, srcBlock.start).concat(lines.slice(srcBlock.end + 1));
  if (insertAt > srcBlock.end) insertAt -= block.length;
  if (insertAt < 0) insertAt = 0;

  rest.splice(insertAt, 0, ...rewritten);

  // 注意：不能用「缩进没变」判断位置没变。
  // 同层的 A 拖到 B 前面，缩进一样但位置确实变了，那样判会误拒。
  // 只有整篇结果和原来逐行相同时，才算真的没动。
  if (rest.join("\n") === lines.join("\n")) {
    return { ok: false, reason: "位置没有变化" };
  }
  return { ok: true, lines: rest };
}

export interface MoveGroupInput {
  /** 整篇正文按 \n 切分的行数组 */
  lines: string[];
  /** 解析时的节点坐标，必须按 line 升序 */
  nodes: SrcRef[];
  /** 缩进步长（列数） */
  step: number;
  /** 缩进单位原文（可能是制表符）；空串表示用 step 个空格 */
  unit?: string;
  /** 要整体移动的源节点行号（多个）；互相嵌套的情况由 groupOf 在视图层已经剥离 */
  srcLines: number[];
  targetLine: number;
  mode: DropMode;
}

/**
 * 整体移动一组节点（框选后整体拖动）。
 *
 * 思路与 moveNode 一致，但一次搬多块：
 * 1. 每块按 blockRange 取出，按源行升序排好（保证彼此不嵌套，由视图层 groupOf 保证）；
 * 2. 每块各自按目标重写层级（标题改 # 数、正文改缩进），逻辑逐块复用 moveNode；
 * 3. 从后往前整块删掉，再按「目标插入点之前被删了多少行」修正插入下标，把重写后的块
 *    按原相对顺序整段插回去。
 *
 * 整篇重写（whole）和单节点移动同等级别的安全：写回时校验整篇原文未变（expect）。
 */
export function moveNodes(input: MoveGroupInput): MoveResult {
  const { lines, nodes, step, targetLine, mode, srcLines } = input;
  const unit: string = input.unit ?? "";

  const tgtIdx: number = nodes.findIndex((n) => n.line === targetLine);
  if (tgtIdx < 0) return { ok: false, reason: "找不到目标节点" };
  const tgt: SrcRef = nodes[tgtIdx];
  const tgtBlock = blockRange(nodes, tgtIdx);

  // 收集每个源块的区间；去重 + 按源行升序
  const blocks: Array<{ start: number; end: number; idx: number }> = [];
  for (const ln of srcLines) {
    const i: number = nodes.findIndex((n) => n.line === ln);
    if (i < 0) continue;
    const src: SrcRef = nodes[i];
    // 根节点（笔记本身）不能移动
    if (src.depth === 0) return { ok: false, reason: "根节点不能移动" };
    const sb = blockRange(nodes, i);
    // 不能把任何选中块拖进它自己的子树
    if (targetLine >= sb.start && targetLine <= sb.end) {
      return { ok: false, reason: "不能移到自己的子节点下面" };
    }
    // 和单节点一致的层级体系约束
    if (src.heading && !tgt.heading) {
      return { ok: false, reason: "标题不能拖到正文节点上" };
    }
    if (!src.heading && tgt.heading && mode !== "child") {
      return { ok: false, reason: "正文不能和标题平级，只能拖到标题上当子节点" };
    }
    blocks.push({ start: sb.start, end: sb.end, idx: i });
  }
  if (blocks.length === 0) return { ok: false, reason: "找不到源节点" };
  blocks.sort((a, b) => a.start - b.start);
  // 防御：选中集里若仍有互相嵌套的块（例如用户没走 groupOf 直接调用），直接拒绝
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start <= blocks[i - 1].end) {
      return { ok: false, reason: "选中的节点存在嵌套，无法整体移动" };
    }
  }

  // 插入点：和 moveNode 同一套算法
  const insertAfterHeading: boolean = mode === "child" && tgt.heading;
  const rawInsertAt: number = insertAfterHeading
    ? Math.min((tgt.blockEnd ?? tgt.line) + 1, lines.length)
    : mode === "before"
      ? tgt.line
      : Math.min(tgtBlock.end + 1, lines.length);

  // 逐块重写层级
  const extracted: Array<{ block: string[]; bad?: string }> = blocks.map((b) => {
    const src: SrcRef = nodes[b.idx];
    const block: string[] = lines.slice(b.start, b.end + 1);
    const frozen: Set<number> = frozenIn(nodes, b.start, b.end);
    if (src.heading) {
      const srcLevel: number = src.level ?? 1;
      const tgtLevel: number = tgt.level ?? 1;
      const newLevel: number = mode === "child" ? tgtLevel + 1 : tgtLevel;
      if (newLevel > 6) return { block, bad: "标题层级超过 6 级了" };
      return { block: rewriteHeadingBlock(block, srcLevel, newLevel, frozen) };
    }
    const srcCols: number = colsOf(src.full);
    const tgtCols: number = colsOf(tgt.full);
    let newCols: number;
    if (mode === "child") {
      const childCols: number | null = childIndentCols(nodes, tgtIdx);
      if (childCols !== null) newCols = childCols;
      else if (tgt.heading) newCols = 0; // 标题不吃缩进，直接子节点缩进为 0
      else newCols = tgtCols + step;
    } else {
      newCols = tgtCols; // 变成目标的兄弟：缩进与目标一致
    }
    return { block: shiftBlock(block, newCols - srcCols, unit, step, frozen) };
  });
  for (const e of extracted) {
    if (e.bad) return { ok: false, reason: e.bad };
  }

  // 从后往前整块删除（保持下标有效）
  let rest: string[] = lines.slice();
  for (let i = blocks.length - 1; i >= 0; i--) {
    rest.splice(blocks[i].start, blocks[i].end - blocks[i].start + 1);
  }
  // 修正插入下标：源块里落在 rawInsertAt 之前的行都被删掉了，下标要前移相应数量
  let before = 0;
  for (const b of blocks) {
    for (let l = b.start; l <= b.end; l++) if (l < rawInsertAt) before++;
  }
  let insertAt: number = rawInsertAt - before;
  if (insertAt < 0) insertAt = 0;

  const quote: string = targetQuoteFor(tgt, mode);
  const rewritten: string[] = extracted
    .map((e) => rebaseQuote(e.block, quote))
    .flat();
  rest.splice(insertAt, 0, ...rewritten);

  if (rest.join("\n") === lines.join("\n")) {
    return { ok: false, reason: "位置没有变化" };
  }
  return { ok: true, lines: rest };
}
