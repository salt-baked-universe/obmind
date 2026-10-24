/**
 * 结构解析（L1 domain）：把笔记正文变成 markmap 的节点树。
 *
 * 这一层是纯函数：不 import obsidian、不碰 DOM、不读文件。
 * 唯一的例外处理方式是**注入**——行内渲染（把 `[[双链]]` 变成 `<a>`）属于
 * 表现层，由调用方以 `render` 参数传进来。这样 domain 永远不认识 HTML 生成器，
 * 也就能在 Node 里直接跑用例，不需要浏览器。
 */

import type { IPureNode } from "markmap-common";
import type { BlockInfo, ParseOptions, SrcRef } from "../types";

interface RawLine {
  text: string;
  headingLevel: number | null;
  src: SrcRef;
  /**
   * 这一行**整体就是**一个块（代码 / 公式 / 引用 / 表格），`text` 只是回退标签。
   *
   * 块走缩进推导拿到自己的深度，但装配时**不写进缩进栈** —— 否则后面紧跟的
   * 节点会被它收养（「块吞掉下一行」那个老 bug）。它是个叶子，不接孩子。
   */
  block?: BlockInfo;
  /**
   * 所属 callout 区域编号（-1 / undefined = 不在 callout 里）。
   *
   * callout 是**容器**而不是块：`> [!NOTE] 标题` 自己是一个节点，里面每一行都是
   * 它的后代。原因是用户的问答笔记整篇正文都在 callout 里，收成一个 pill 等于
   * 把整篇内容藏起来（实测 10 篇核心笔记全中）。
   */
  region?: number;
  /** 本行是某个 callout 的标题时，值是那个 callout 的区域编号 */
  calloutRoot?: number;
  /** 标题是从正文第一行顶上来的（区域内的层级要整体上移一层） */
  promoted?: boolean;
}

/**
 * 送给行级解析的「虚拟行」：callout 正文已经剥掉一层 `>`，
 * 但行号与字符偏移仍指回原文，回写才不会错位。
 */
interface VLine {
  text: string;
  /** 原文行号 */
  orig: number;
  /** text 在原文行里的起始偏移（剥掉的前缀长度） */
  off: number;
  /** 所属 callout 区域编号，-1 = 不在 callout 里 */
  region: number;
  /** 本行是 callout 标题行时，记下它属于哪个区域 */
  calloutRoot?: number;
  /** 标题取自正文第一行（callout 没写标题） */
  promoted?: boolean;
}

interface FenceInfo {
  kind: "code" | "math";
  lang: string;
  /** 围栏字符：``` / ~~~ / $$ */
  marker: string;
  /** 围栏行自身的缩进 */
  indent: string;
  /** 单行公式 `$$ … $$`，起止在同一行 */
  single: boolean;
}

/** 识别块的开头：围栏代码块，或 `$$` 公式块 */
function parseFence(line: string): FenceInfo | null {
  // 单行公式：$$ x = 1 $$
  const single = /^([ \t]*)\$\$(.+?)\$\$\s*$/.exec(line);
  if (single && single[2].trim() !== "") {
    return { kind: "math", lang: "", marker: "$$", indent: single[1], single: true };
  }
  // 多行公式的开头：单独一行 $$
  const math = /^([ \t]*)\$\$\s*$/.exec(line);
  if (math) {
    return { kind: "math", lang: "", marker: "$$", indent: math[1], single: false };
  }
  // 围栏代码块，info string 只取语言标识，后面的附加写法忽略
  const code = /^([ \t]*)(`{3,}|~{3,})\s*([A-Za-z0-9#+._-]*)/.exec(line);
  if (code) {
    return { kind: "code", lang: code[3], marker: code[2], indent: code[1], single: false };
  }
  return null;
}

/** 是否是该块的收尾行：字符相同、长度不短于开头 */
function isFenceEnd(line: string, info: FenceInfo): boolean {
  if (info.kind === "math") return /^[ \t]*\$\$\s*$/.test(line);
  const m: RegExpExecArray | null = /^[ \t]*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === info.marker[0] && m[1].length >= info.marker.length;
}

/** 把一行表格按竖线切开，去掉首尾可选的外框竖线 */
function tableCells(line: string): string[] {
  let s: string = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

/** 表格的分隔行：`| --- | :--: |`，每段只能是 `:?-+:?` */
function isTableDelim(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells: string[] = tableCells(line);
  if (cells.length === 0) return false;
  return cells.every((c: string) => /^\s*:?-+:?\s*$/.test(c));
}

/**
 * 判断某一行是否是 GFM 表格的表头行（下一行必须是分隔行），返回列数。
 *
 * 为什么要多看一眼分隔行：正文里带竖线的行非常常见（`a | b`、
 * `x || y`），只看本行会把它们误当成表格，整段正文就变成一张单行表格。
 * 反过来，像 `a | b` 后面紧跟 `---` 这种「裸管道 + 分隔线」的写法，
 * 与「正文 + 分隔线」在字面上无法区分，因此要求分隔行自身带竖线
 * （`--- | ---` / `| --- |`）才认成表格。
 */
function tableCols(head: string, delim: string): number {
  if (!head.includes("|")) return 0;
  if (!delim.includes("|")) return 0;
  if (!isTableDelim(delim)) return 0;
  return tableCells(head).length;
}

/**
 * 去掉块整体的缩进。
 *
 * 笔记里的块常常是缩进在某个列表项下面的（`- 示例` 下一行 `  ```js`）。
 * 直接把带缩进的原样丢给 MarkdownRenderer，CommonMark 对「缩进 4 格」会当成
 * 缩进代码块，渲染结果和原文不一致；这里按围栏行的缩进量逐行剥掉。
 */
function dedentBlock(text: string, prefix: string): string {
  const width: number = prefix.length;
  if (width === 0) return text;
  return text
    .split("\n")
    .map((line: string) => {
      let k = 0;
      while (k < width && (line[k] === " " || line[k] === "\t")) k++;
      return line.slice(k);
    })
    .join("\n");
}

/** Obsidian callout 的头部行：`> [!note] 标题`（可缩进，可带 `+` / `-` 折叠标记） */
const CALLOUT_HEAD = /^([ \t]*)>[ \t]?\[!([A-Za-z-]+)\][+-]?[ \t]*(.*)$/;

/** 去掉一层 `>` 前缀，返回剩余文本与它在原行里的起始偏移 */
function stripQuote(line: string): { text: string; off: number } {
  const m: RegExpExecArray | null = /^[ \t]*>[ \t]?/.exec(line);
  if (!m) return { text: line, off: 0 };
  return { text: line.slice(m[0].length), off: m[0].length };
}

/**
 * 把原文行摊平成「虚拟行」：callout 的 `>` 前缀在这一步剥掉。
 *
 * 为什么 callout 要当容器而不是块：
 * - 用户的问答笔记里整篇正文都写在 `> [!abstract]` 里面，收成一个 pill 等于
 *   把图的内容全部藏掉（实测 10 篇核心笔记全中）；
 * - callout 内部本来就常是列表（`> 1. …` / `> \t1. …`），按 `>` 后的相对缩进
 *   继续分层正是导图想要的结构。
 *
 * 剥掉 `>` 之后，里面的行对行级解析器来说就是普通正文（代码块、表格、列表都能
 * 照常识别），而 `off` 保证回写时仍然落在原行里对了位置。
 */
function buildVLines(allLines: string[], from: number): VLine[] {
  const out: VLine[] = [];
  let regionSeq = 0;

  for (let i = from; i < allLines.length; i++) {
    const head: RegExpExecArray | null = CALLOUT_HEAD.exec(allLines[i]);
    if (!head) {
      out.push({ text: allLines[i], orig: i, off: 0, region: -1 });
      continue;
    }

    // 区域范围 = 紧跟其后连续的 `>` 行。真正的空行会结束引用
    // （callout 内部的空行在 Markdown 里必须写成 `>`，所以这里不用特判）。
    let end: number = i;
    for (let j = i + 1; j < allLines.length; j++) {
      if (!/^[ \t]*>/.test(allLines[j])) break;
      end = j;
    }
    const region: number = regionSeq++;

    // 标题：优先取 `[!note]` 后面那句话；没写标题就用正文第一行当标题
    // （`[!abstract]` 后面直接跟正文的写法很常见，否则卡片上只剩 "abstract"）。
    const titleRaw: string = head[3].replace(/\s+$/, "");
    let titleLine: number = i;
    let titleText: string = titleRaw.trim();
    let titleOff: number = titleText === "" ? -1 : allLines[i].lastIndexOf(titleText);

    let promoted = false;
    if (titleText === "") {
      for (let j = i + 1; j <= end; j++) {
        const s = stripQuote(allLines[j]);
        if (s.text.trim() === "") continue;
        titleLine = j;
        // 整行交给行级解析：这样 `1. ` 这种标记会照常被剥掉
        titleText = s.text;
        titleOff = s.off;
        promoted = true;
        break;
      }
    }
    if (titleText === "") {
      i = end; // 空的 callout：不产生节点
      continue;
    }

    out.push({
      text: titleText,
      orig: titleLine,
      off: titleOff,
      region: -1,
      calloutRoot: region,
      promoted,
    });
    for (let j = i; j <= end; j++) {
      // 头部行永远不进正文；无标题时被顶上来的那一行也不能再来一次
      if (j === i || j === titleLine) continue;
      const s = stripQuote(allLines[j]);
      if (s.text.trim() === "") continue;
      out.push({ text: s.text, orig: j, off: s.off, region });
    }
    i = end;
  }

  return out;
}
/**
 * 「自由块」的标记行：`<!-- obmind:block -->`。
 *
 * 为什么用 HTML 注释而不是自造的围栏：
 * - 它在任何 Markdown 实现里都不显示，也不占用任何语法 —— 不抢 callout、
 *   不抢代码围栏、不抢其他插件的 `:::`；
 * - 没装这个插件的人看到的就是一段普通笔记，不会多出怪字符。
 */
const BLOCK_MARK = /^[ \t]*<!--\s*obmind:block\s*-->[ \t]*$/;

/**
 * 把一个块收成**独立节点**（不是挂在宿主卡片里的一行）。
 *
 * 为什么块能当节点：块自己不能缩进（围栏缩到第 4 格就退化成缩进代码块），
 * 所以它没法用缩进表达归属。`<!-- obmind:block -->` 这一行替它承受缩进 ——
 * 层级、顺序、拖动全看注释行，块本体照旧顶格。没有注释行的裸块，
 * 只能按围栏自己的缩进（0～3 格）落位，所以不许拖动。
 *
 * 节点行（line）= 代理行（有）或围栏行（无），endLine = 块末行：
 * 删除、选中、算子树的结束行都按这个区间走。
 */
function pushBlock(
  raws: RawLine[],
  block: BlockInfo,
  mark: VLine | null,
  fenceLine: VLine,
  allLines: string[],
): void {
  const anchor: VLine = mark ?? fenceLine;
  const first: string = anchor.text;
  const indent: string = (/^[ \t]*/.exec(first) ?? [""])[0];
  const src: SrcRef = {
    line: anchor.orig,
    bodyStart: indent.length,
    bodyEnd: first.trimEnd().length,
    full: allLines[anchor.orig] ?? first,
    marker: "",
    indent,
    checked: null,
    text: block.label ?? block.kind,
    heading: false,
    level: null,
    // 真正的深度在下面的缩进推导里统一算，这里只是占位
    depth: 0,
    endLine: block.endLine,
    // 整块的行区间：删除、选中、算子树的结束行都要用它
    blockStart: anchor.orig,
    blockEnd: block.endLine,
    blockNode: mark ? "free" : "bound",
    proxyLine: mark ? anchor.orig : undefined,
  };
  raws.push({
    text: src.text,
    headingLevel: null,
    src,
    block,
    region: anchor.region,
    calloutRoot: anchor.calloutRoot,
    promoted: anchor.promoted,
  });
}

/**
 * 引用块的那一行文案。
 *
 * 为什么不能只写「引用 · 3 行」：用户的笔记里 `>` 几乎都是 Obsidian 的 callout
 * （`> [!NOTE] 工作情况介绍`），一整篇正文都在里面。只说「引用 · 12 行」的话，
 * 导图上就只剩一个没有信息量的标签，等于把内容藏没了。
 * 所以取「第一句有意义的话」当标签：先剥 `[!TYPE]`，同一行还有字就用它，
 * 否则看下一行；再截断。全文仍在笔记里，悬停能看到前几行。
 */
function quoteLabel(indent: string, lines: string[], count: number): string {
  const strip = (l: string): string =>
    l
      .replace(new RegExp(`^${indent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*>\s?/, "")
      .trim();

  let title = "";
  for (const l of lines) {
    const body: string = strip(l);
    if (body === "") continue;
    const callout: RegExpExecArray | null = /^\[!([A-Za-z-]+)\][+-]?\s*(.*)$/.exec(body);
    if (callout) {
      // 同一行有标题就用标题，没有就继续往下找正文第一句
      if (callout[2].trim() !== "") {
        title = callout[2].trim();
        break;
      }
      continue;
    }
    title = body;
    break;
  }

  const clean: string = title.replace(/[*_`~]/g, "").replace(/\[\[|\]\]/g, "");
  const short: string = clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
  return short === "" ? `引用 · ${count} 行` : `引用 · ${short}`;
}

/** 制表符按 4 列计。只是把缩进折算成一个可比较的数值，不代表层级语义 */
const TAB_COLS = 4;
/**
 * 一段缩进（空格 / 制表符混合）折算成列数。
 *
 * 必须统一度量：早先解析按「tab 算 1 层」、写回按「tab 算 4 空格」，
 * 于是制表符缩进的笔记被拖动一次，深度就翻倍 —— 这就是「拖动后多空格、层级错乱」。
 */
export function colsOfIndent(ws: string): number {
  const tabs: number = (ws.match(/\t/g) ?? []).length;
  return tabs * TAB_COLS + (ws.length - tabs);
}

/** 把列数还原成缩进字符串：优先沿用原文的缩进单位 */
export function indentOfCols(cols: number, unit: string): string {
  if (cols <= 0) return "";
  const width: number = colsOfIndent(unit);
  if (width <= 0) return " ".repeat(cols);
  const times: number = Math.floor(cols / width);
  return unit.repeat(times) + " ".repeat(cols - times * width);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 检测缩进步长与缩进单位（实际的空白字符串，可能是制表符）。
 *
 * 不能用「最小正缩进」：笔记里只要有一行手误缩进 1 个空格，整篇步长就变成 1，
 * 之后缩进 2 空格会被算成第 2 层，整张导图立刻错乱（库里有 47 篇命中）。
 * 也不能简单取 GCD：混进一个奇数缩进就退化成 1。
 *
 * 这里取「能整除最多行的最小候选值」，且要求它至少解释 85% 的缩进行；
 * 都不满足时才退回 GCD。缩进单位取一行宽度正好等于步长的原文，
 * 这样回写时能沿用原文的写法（制表符继续用制表符），而不是硬塞空格。
 */
export function detectIndent(indents: string[]): { step: number; unit: string } {
  const items = indents
    .map((ws: string) => ({ ws, cols: colsOfIndent(ws) }))
    .filter((it) => it.cols > 0);
  if (items.length === 0) return { step: 2, unit: "  " };

  const distinct: number[] = Array.from(new Set(items.map((it) => it.cols))).sort(
    (a: number, b: number) => a - b,
  );

  let step = 0;
  for (const c of distinct) {
    if (c < 2) continue;
    let hit = 0;
    for (const it of items) if (it.cols % c === 0) hit++;
    if (hit / items.length >= 0.85) {
      step = c;
      break;
    }
  }
  if (step === 0) step = distinct.reduce((a: number, b: number) => gcd(a, b));
  if (step < 1) step = 1;

  // 缩进单位：宽度正好等于步长的那些行里，出现次数最多的写法
  const exact = new Map<string, number>();
  for (const it of items) {
    if (it.cols === step) exact.set(it.ws, (exact.get(it.ws) ?? 0) + 1);
  }
  let unit = "";
  let best = 0;
  for (const [ws, count] of exact) {
    if (count > best) {
      best = count;
      unit = ws;
    }
  }
  if (unit === "") unit = " ".repeat(step);
  return { step, unit };
}

/** 无序列表标记（含任务列表）与有序列表标记 */
const LIST_PREFIX = /^(?:[-*+]\s+(?:\[([ xX])\]\s+)?|\d{1,9}[.)]\s+)/;
/** 分隔线：--- / *** / ___ */
const RULE_LINE = /^([-*_])(?:\s*\1){2,}$/;
/** 标题标记 */
const HEADING_PREFIX = /^(#{1,6})\s+/;

/**
 * 把一段正文文本规整成「正文起点 / 终点」两个列号。
 * 头部空白推到 bodyStart 之后，这样重写该行时缩进不会被吃掉。
 */
function measure(text: string, base: number): { text: string; start: number; end: number } {
  const lead: number = text.length - text.trimStart().length;
  const trimmed: string = text.trim();
  const start: number = base + lead;
  return { text: trimmed, start, end: start + trimmed.length };
}

/** domain 层自己的最小转义：只用于根节点名与块占位文案，不涉及行内语法 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface BuildTreeOptions extends ParseOptions {
  /**
   * 行内渲染函数，由上层注入（通常是 render/inlineHtml 的 renderInline）。
   *
   * 做成参数而不是 import，是为了让 domain 层保持「不认识 HTML」——
   * 这样它能在 Node 里直接跑用例，不必为了一个字符串拼接去模拟浏览器。
   */
  render: (raw: string) => string;
}

/**
 * 把笔记内容直接构建成 markmap 的节点树（IPureNode），不经过 markdown 缩进解析。
 *
 * 规则：
 * - 根节点 = 笔记文件名（去掉 .md）
 * - 若正文里存在 Markdown 标题（#/##/###…）：按标题层级组织；标题下的正文作为其子节点，
 *   正文自身的缩进再叠加层级
 * - 若没有任何标题：按正文行首缩进（空格/Tab）组织层级
 * - 列表标记（-、*、+、1.）会被剥离，只保留文字，层级由缩进表达
 * - 任务列表的 [ ] / [x] 转成 ☐ / ☑
 * - 行内语法交给注入的 render，本层不关心它产出什么
 * - 层级深度做「最多 +1」钳制，避免跳级（如 0 空格直接到 4 空格）导致结构错乱
 *
 * 每个非根节点还会挂 `payload.src`（源行坐标），供双向编辑回写使用。
 * 根节点挂 `payload.step`（检测到的缩进步长）。
 */
export function buildTree(
  content: string,
  fileName: string,
  options: BuildTreeOptions,
): IPureNode {
  const { render } = options;
  const filterFrontmatter: boolean = options.filterFrontmatter !== false;
  const rootName: string = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

  const allLines: string[] = content.split("\n");
  let lineOffset = 0;

  // 1. 跳过笔记顶部的 YAML frontmatter
  if (filterFrontmatter) {
    let i = 0;
    while (i < allLines.length && allLines[i].trim() === "") i++;
    if (i < allLines.length && /^---\s*$/.test(allLines[i])) {
      let j = i + 1;
      while (j < allLines.length && !/^---\s*$/.test(allLines[j])) j++;
      if (j < allLines.length) lineOffset = j + 1;
    }
  }

  // 2. 收集有效行（跳过空行与分隔线；代码块 / 公式块整块收成一个节点）
  const raws: RawLine[] = [];
  /**
   * 上一个 `<!-- obmind:block -->` 标记行：它是**下一个块的代理节点行**。
   *
   * 块自己不能缩进 —— 围栏缩到第 4 格就退化成「缩进代码块」，``` 变成字面量。
   * 所以它没法用缩进表达归属。这一行注释替它承受缩进：层级、顺序、拖动全看它，
   * 块本体照旧顶格。注释在任何 Markdown 工具里都不显示，也不占任何原生语法。
   */
  let pendingMark: VLine | null = null;
  // 软换行合并：记录上一个「可合并」的列表项，后续续行（同缩进、无标记）并入它。
  let lastListRaw: RawLine | null = null;

  // callout 在这里摊平成虚拟行（`>` 前缀剥掉）。之后整条解析链路都跑在
  // 虚拟行上，行级规则的代码不用改；回写靠 v.orig / v.off 换回原文坐标。
  const vlines: VLine[] = buildVLines(allLines, lineOffset);
  /** 按虚拟行区间取原文（每行剥掉自己的 `>` 前缀），交给 MarkdownRenderer 渲染 */
  const rawOf = (a: number, b: number): string =>
    vlines
      .slice(a, b + 1)
      .map((v: VLine) => allLines[v.orig].slice(v.off))
      .join("\n");

  for (let idx = 0; idx < vlines.length; idx++) {
    const v: VLine = vlines[idx];
    const line: string = v.text;
    if (line.trim() === "") {
      lastListRaw = null;
      continue;
    }

    // 块的上方一行：`<!-- obmind:block -->`。它给下一个块当代理节点行，
    // 自己不产生节点、也不显示 —— 用户看到的就是一个普通的块。
    if (BLOCK_MARK.test(line)) {
      pendingMark = v;
      lastListRaw = null;
      continue;
    }

    // 围栏代码块 / 公式块。
    // 以前这里是一个 inCodeBlock 开关，遇到就 continue —— 代码和公式在导图里
    // 直接消失，用户看到的是缺了关键内容的图。现在整块收成一个只读节点。
    const fence: FenceInfo | null = parseFence(line);
    if (fence) {
      let end: number = idx;
      let bodyLines = 0;

      if (!fence.single) {
        let j = idx + 1;
        for (; j < vlines.length; j++) {
          if (isFenceEnd(vlines[j].text, fence)) break;
          bodyLines++;
        }
        // 没写收尾围栏时一直吃到文末，不能把后面的正文也当成代码
        end = Math.min(j, vlines.length - 1);
      }

      const rawBlock: string = rawOf(idx, end);
      const label: string =
        fence.kind === "code"
          ? `代码块${fence.lang ? ` · ${fence.lang}` : ""}${bodyLines ? ` · ${bodyLines} 行` : ""}`
          : `公式${bodyLines ? ` · ${bodyLines} 行` : ""}`;

      pushBlock(
        raws,
        {
          kind: fence.kind,
          lang: fence.lang,
          raw: dedentBlock(rawBlock, fence.indent),
          startLine: v.orig,
          endLine: vlines[end].orig,
          lines: fence.single ? 1 : bodyLines,
          label,
        },
        pendingMark,
        v,
        allLines,
      );
      pendingMark = null;

      // 块是结构性内容：打断软换行续行（块与正文之间不再并入）
      lastListRaw = null;
      idx = end;
      continue;
    }

    // GFM 表格：头行 + 分隔行，整块收成一个只读节点。
    // 表格的信息在「行与列的对齐」里，拆成一行一个节点之后只剩一堆带竖线的碎片，
    // 既看不出关系、也没法排版，所以和代码块一样按块交给 MarkdownRenderer。
    const cols: number =
      idx + 1 < vlines.length ? tableCols(line, vlines[idx + 1].text) : 0;
    if (cols > 0) {
      // 表格到空行、或不再含竖线的行为止；顺手挡住列表项 / 标题，
      // 否则紧跟着表格的 `- 说明` 会被吸进最后一行单元格。
      let end: number = idx + 1;
      for (let j = idx + 2; j < vlines.length; j++) {
        const l: string = vlines[j].text;
        if (l.trim() === "") break;
        if (!l.includes("|")) break;
        if (/^[ \t]*(?:[-*+]\s+|\d{1,9}[.)]\s+|#{1,6}\s+)/.test(l)) break;
        end = j;
      }

      const indentMatch: RegExpMatchArray | null = /^[ \t]*/.exec(line);
      const indent: string = indentMatch ? indentMatch[0] : "";
      const rows: number = end - idx - 1;
      const label: string = `表格 · ${cols} 列${rows > 0 ? ` · ${rows} 行` : ""}`;

      pushBlock(
        raws,
        {
          kind: "table",
          lang: "",
          // 缩进在列表项下面的表格，直接丢给解析器会被当成「缩进代码块」
          raw: dedentBlock(rawOf(idx, end), indent),
          startLine: v.orig,
          endLine: vlines[end].orig,
          lines: rows + 1,
          label,
        },
        pendingMark,
        v,
        allLines,
      );
      pendingMark = null;

      // 块是结构性内容：打断软换行续行（块与正文之间不再并入）
      lastListRaw = null;
      idx = end;
      continue;
    }

    // 引用块：连续的 `>` 行合成**一个块**，挂到前面最近的节点上。
    //
    // 以前每行 `>` 各成一个节点：引用边界消失，而且最后一行引用会把后面紧跟的
    // 缩进节点「收养」成自己的孩子（缩进栈看的是列数，引用行剥离后列数为 0，
    // 下一行却更深）—— 整块结构在用户眼里就是错的。
    // 顺带修掉「`> ```js` 碎成四行」：块识别现在发生在引用这一层，
    // 参考块里的 ``` 只是引用原文的一部分，不再单独解析。
    if (/^[ \t]*>/.test(line)) {
      let end: number = idx;
      for (let j = idx + 1; j < vlines.length; j++) {
        if (!/^[ \t]*>/.test(vlines[j].text)) break;
        end = j;
      }
      const indentMatch: RegExpMatchArray | null = /^[ \t]*/.exec(line);
      const indent: string = indentMatch ? indentMatch[0] : "";
      const count: number = end - idx + 1;
      pushBlock(
        raws,
        {
          kind: "quote",
          lang: "",
          raw: dedentBlock(rawOf(idx, end), indent),
          startLine: v.orig,
          endLine: vlines[end].orig,
          lines: count,
          label: quoteLabel(
            indent,
            vlines.slice(idx, end + 1).map((x: VLine) => x.text),
            count,
          ),
        },
        pendingMark,
        v,
        allLines,
      );
      pendingMark = null;

      lastListRaw = null;
      idx = end;
      continue;
    }

    // 标记行后面不是块（用户写错了位置）：标记本身不显示，这里就把它的代理身份丢掉，
    // 免得它去认领下面遥不可及的另一个块。
    pendingMark = null;

    // 引用前缀（可能多层）去掉，只保留正文；同时记住剥掉了多少字符
    let body: string = line;
    while (/^\s*>/.test(body)) body = body.replace(/^\s*>\s?/, "");
    const quoteLen: number = line.length - body.length;

    const wsMatch: RegExpMatchArray | null = body.match(/^[ \t]*/);
    const ws: string = wsMatch ? wsMatch[0] : "";

    let marker: string = "";
    let checked: boolean | null = null;
    let heading = false;
    let rest: string = body.slice(ws.length);
    let restStart: number = quoteLen + ws.length;

    // 标题行 / 列表行 / 分隔线：先识别结构，再决定能否接软换行续行。
    const headingMatch: RegExpMatchArray | null = rest.match(HEADING_PREFIX);
    const listMatch: RegExpMatchArray | null =
      headingMatch === null ? rest.match(LIST_PREFIX) : null;

    if (headingMatch) {
      marker = headingMatch[0];
      heading = true;
      rest = rest.slice(marker.length);
      restStart += marker.length;
    } else if (RULE_LINE.test(rest.trim())) {
      // 正文分隔线：结构性行，不参与软换行合并
      lastListRaw = null;
      continue;
    } else if (listMatch) {
      // 剥离列表标记；任务列表的勾选框单独记下来
      const checkbox: string | undefined = listMatch[1];
      const whole: string = listMatch[0];
      if (checkbox !== undefined) {
        checked = checkbox !== " ";
        marker = whole.replace(/\[[ xX]\]\s+$/, "");
      } else {
        marker = whole;
      }
      rest = rest.slice(whole.length);
      restStart += whole.length;
    }

    const m = measure(rest, restStart);
    if (m.text === "") continue;

    // 软换行续行：上一个节点是可合并的列表项、本行无引用前缀、不是标题/列表项，
    // 且缩进不浅于该列表项的标记缩进，就并入它（节点即"一行"，
    // 笔记里 Shift+Enter 产生的硬换行在这里当作节点内 <br> 而非新节点）。
    // 用前缀匹配而非严格相等：编辑器里 Shift+Enter 会把新行自动缩进到
    // 与列表项文字对齐（比标记缩进多 2 个空格），严格相等会漏掉、
    // 让续行落成更深的子节点（实测踩过）。
    const hasQuotePrefix: boolean = /^\s*>/.test(line);
    // 当前行首缩进（含 0 个空白的情况）：match 在 TS 眼中可能为空，用空串兜底
    const leadWs: string = (line.match(/^[ \t]*/) ?? [""])[0];
    if (
      lastListRaw !== null &&
      !hasQuotePrefix &&
      !headingMatch &&
      !listMatch &&
      lastListRaw.src.indent.length > 0 &&
      leadWs.startsWith(lastListRaw.src.indent)
    ) {
      const merged = lastListRaw;
      const bodyText: string = line
        .slice(merged.src.indent.length)
        .replace(/^[ \t]+/, "")
        .replace(/\s+$/, "");
      merged.src.text += "\n" + bodyText;
      if (!merged.src.extra) merged.src.extra = [];
      merged.src.extra.push(bodyText);
      merged.src.endLine = v.orig;
      continue;
    }

    // 普通节点：标题 / 列表项 / 段落，各自独立成行。
    const raw: RawLine = {
      text: m.text,
      headingLevel: headingMatch ? headingMatch[1].length : null,
      src: {
        line: v.orig,
        // 偏移要加回被剥掉的 `>` 前缀，否则回写会写进引用符号里
        bodyStart: v.off + m.start,
        bodyEnd: v.off + m.end,
        full: allLines[v.orig],
        marker,
        indent: ws,
        checked,
        text: m.text,
        heading,
        level: headingMatch ? headingMatch[1].length : null,
        depth: 0,
        endLine: v.orig,
      },
      region: v.region,
      calloutRoot: v.calloutRoot,
      promoted: v.promoted,
    };
    raws.push(raw);

    // 结构性行：标题 / 分隔线 / 列表项都重置"可合并"状态；
    // 只有普通列表项（非引用、非标题）才允许后续续行并入。
    if (listMatch && !heading && !hasQuotePrefix) {
      lastListRaw = raw;
    } else {
      lastListRaw = null;
    }
  }

  const hasHeadings: boolean = raws.some((r) => r.headingLevel !== null);

  // 3. 检测缩进步长与缩进单位（只用正文行，标题不吃缩进）
  const { step, unit } = detectIndent(
    raws.filter((r) => r.headingLevel === null).map((r) => r.src.indent),
  );

  // 4. 计算每一行的深度（根为 0，第一层子节点为 1）
  //
  // 层级用「缩进栈」推导，而不是 floor(列数 / 步长)：
  // 后者假设缩进严格是步长的整数倍，笔记里只要有一行手误缩进 1 个空格（库里 47 篇命中），
  // 整篇层级就全错。缩进栈只看「比栈顶深就下一层、比栈顶浅就弹回去」，
  // 天然容忍不规则缩进，而且同一缩进永远算出同一深度（旧版「相对上一行最多深 1 层」
  // 的钳制会让同缩进的兄弟深度不同，拖动时整块子树的范围就会算错）。
  //
  // 缩进量只存在，不需要知道步长；step 仍然检测出来，供拖动兜底与 Tab 缩进使用。
  const nodes: { depth: number; raw: RawLine }[] = [];
  const headingStack: number[] = [];
  const indentStack: number[] = [0];
  /** 每个 callout 区域：标题节点算出来的深度（区域里的内容从它的下一层起算） */
  const regionBase = new Map<number, number>();
  /** 每个 callout 区域自己的缩进栈（区域内的缩进从 0 重新起算） */
  const regionIndent = new Map<number, number[]>();
  /**
   * 标题是从正文第一行顶上来的区域：那行原本就在区域的第一层，
   * 现在它当了标题（上移一层），所以区域内所有行也要跟着上移一层 ——
   * 否则它的同级项会变成它的孩子，`1. …` / `2. …` 那种大纲会多套一层空壳。
   */
  const regionPromoted = new Set<number>();

  for (const r of raws) {
    let depth: number;
    const region: number = r.region ?? -1;

    if (r.calloutRoot !== undefined) {
      // callout 标题行：走外层缩进栈，算完把深度记成这个区域的基准
      depth = outerDepth(r);
      regionBase.set(r.calloutRoot, depth);
      if (r.promoted) regionPromoted.add(r.calloutRoot);
    } else if (region >= 0) {
      // callout 内部：缩进从 0 重新起算，深度 = 标题深度 + 1 + 内部层级
      const stack: number[] = regionIndent.get(region) ?? [0];
      const cols: number = colsOfIndent(r.src.indent);
      while (stack.length > 1 && cols < stack[stack.length - 1]) stack.pop();
      if (cols > stack[stack.length - 1]) stack.push(cols);
      regionIndent.set(region, stack);
      const shift: number = regionPromoted.has(region) ? 1 : 0;
      depth = (regionBase.get(region) ?? 0) + stack.length - shift;
    } else {
      depth = outerDepth(r);
    }
    if (depth < 1) depth = 1;

    r.src.depth = depth;
    nodes.push({ depth, raw: r });
  }

  /** 外层（不在任何 callout 里）的深度：标题栈或缩进栈 */
  function outerDepth(r: RawLine): number {
    if (hasHeadings && r.headingLevel !== null) {
      const level: number = r.headingLevel;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= level) {
        headingStack.pop();
      }
      headingStack.push(level);
      // 进入新小节，正文缩进重新从 0 起算
      indentStack.length = 1;
      indentStack[0] = 0;
      return headingStack.length;
    }
    const cols: number = colsOfIndent(r.src.indent);
    while (indentStack.length > 1 && cols < indentStack[indentStack.length - 1]) {
      indentStack.pop();
    }
    if (cols > indentStack[indentStack.length - 1]) indentStack.push(cols);
    const base: number = hasHeadings ? headingStack.length : 0;
    return base + indentStack.length;
  }

  // 5. 按深度装配成树
  const root: IPureNode = {
    content: escapeText(rootName),
    children: [],
    // step / unit 供双向编辑与拖动复用，与解析规则保持一致
    payload: { step, indentUnit: unit, hasHeadings },
  };
  const stack: IPureNode[] = [root];

  for (const n of nodes) {
    // 缩进跳级时中间层级并不存在（stack[depth-1] 为空），挂到最近的已存在祖先上。
    // 直接回退到根节点会让深层节点蹦到最外层，这是之前「结构错乱」的另一半原因。
    let parent: IPureNode | undefined = stack[n.depth - 1];
    for (let d = n.depth - 2; !parent && d >= 0; d--) parent = stack[d];
    const r: RawLine = n.raw;

    // 块是**独立节点**：位置由它的节点行（`<!-- obmind:block -->` 代理行，
    // 或者围栏行自己）的缩进决定。刻意不写进缩进栈 —— 它是叶子，
    // 写进去会把后面紧跟的节点收养走（就是「块吞掉下一行」那个老 bug）。
    if (r.block) {
      (parent ?? root).children.push(blockNode(r.block, r.src));
      continue;
    }

    const shown: string =
      r.src.checked === null ? r.src.text : (r.src.checked ? "☑ " : "☐ ") + r.src.text;
    const node: IPureNode = {
      content: render(shown),
      children: [],
      payload: { src: r.src },
    };
    (parent ?? root).children.push(node);
    stack[n.depth] = node;
    stack.length = n.depth + 1;
  }

  return root;
}

/**
 * 块节点：一个只读的叶子。
 *
 * `content` 只是占位（渲染失败时它就留在卡片上，至少不让块凭空消失）；
 * 真正的 HTML 由视图层交给 Obsidian 的 MarkdownRenderer 渲染后整个替换掉，
 * 而且必须赶在 setData 之前完成 —— markmap 是按 content 里的 DOM 量宽高的。
 *
 * 源坐标直接用 `pushBlock` 算好的那一份：`line` 是节点行（代理行 / 围栏行），
 * `endLine` 是块末行，所以删除和选中天然覆盖整个块。
 */
function blockNode(b: BlockInfo, src: SrcRef): IPureNode {
  const label: string = b.label ?? b.kind;
  return {
    content: `<span class="obmind-block-pill" data-kind="${b.kind}">${escapeText(label)}</span>`,
    children: [],
    payload: { block: b, src },
  };
}

/**
 * 找出树里所有块节点。
 *
 * 视图层靠它把这批节点统一交给 MarkdownRenderer 渲染 —— 列表在树里，
 * 渲染在表现层，各管各的。判定用 `payload.block`：块节点的 content 是渲染结果，
 * 从内容上认不出来。
 */
export function collectBlockNodes(root: IPureNode): Array<{ node: IPureNode; block: BlockInfo }> {
  const out: Array<{ node: IPureNode; block: BlockInfo }> = [];
  const walk = (n: IPureNode): void => {
    const block = n.payload?.block as BlockInfo | undefined;
    if (block && typeof block.raw === "string") out.push({ node: n, block });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

