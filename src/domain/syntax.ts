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
  /** 非空表示这是一整个块（代码块 / 公式块），不做行内渲染 */
  block?: BlockInfo;
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

  for (let idx = lineOffset; idx < allLines.length; idx++) {
    const line: string = allLines[idx];
    if (line.trim() === "") continue;

    // 围栏代码块 / 公式块。
    // 以前这里是一个 inCodeBlock 开关，遇到就 continue —— 代码和公式在导图里
    // 直接消失，用户看到的是缺了关键内容的图。现在整块收成一个只读节点。
    const fence: FenceInfo | null = parseFence(line);
    if (fence) {
      let end: number = idx;
      let bodyLines = 0;

      if (!fence.single) {
        let j = idx + 1;
        for (; j < allLines.length; j++) {
          if (isFenceEnd(allLines[j], fence)) break;
          bodyLines++;
        }
        // 没写收尾围栏时一直吃到文末，不能把后面的正文也当成代码
        end = Math.min(j, allLines.length - 1);
      }

      const rawBlock: string = allLines.slice(idx, end + 1).join("\n");
      const label: string =
        fence.kind === "code"
          ? `代码块${fence.lang ? ` · ${fence.lang}` : ""}${bodyLines ? ` · ${bodyLines} 行` : ""}`
          : "公式";

      raws.push({
        text: label,
        headingLevel: null,
        block: {
          kind: fence.kind,
          lang: fence.lang,
          raw: dedentBlock(rawBlock, fence.indent),
          startLine: idx,
          endLine: end,
          lines: fence.single ? 1 : bodyLines,
        },
        src: {
          line: idx,
          bodyStart: 0,
          bodyEnd: line.length,
          full: line,
          marker: "",
          indent: fence.indent,
          checked: null,
          text: label,
          heading: false,
          level: null,
          depth: 0,
        },
      });

      idx = end;
      continue;
    }

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

    // 标题行
    const headingMatch: RegExpMatchArray | null = rest.match(HEADING_PREFIX);
    if (headingMatch) {
      marker = headingMatch[0];
      heading = true;
      rest = rest.slice(marker.length);
      restStart += marker.length;
    } else {
      // 正文分隔线
      if (RULE_LINE.test(rest.trim())) continue;

      // 剥离列表标记；任务列表的勾选框单独记下来
      const listMatch: RegExpMatchArray | null = rest.match(LIST_PREFIX);
      if (listMatch) {
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
    }

    const m = measure(rest, restStart);
    if (m.text === "") continue;

    raws.push({
      text: m.text,
      headingLevel: headingMatch ? headingMatch[1].length : null,
      src: {
        line: idx,
        bodyStart: m.start,
        bodyEnd: m.end,
        full: line,
        marker,
        indent: ws,
        checked,
        text: m.text,
        heading,
        level: headingMatch ? headingMatch[1].length : null,
        depth: 0,
      },
    });
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

  for (const r of raws) {
    let depth: number;
    if (hasHeadings && r.headingLevel !== null) {
      const level: number = r.headingLevel;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= level) {
        headingStack.pop();
      }
      headingStack.push(level);
      depth = headingStack.length;
      // 进入新小节，正文缩进重新从 0 起算
      indentStack.length = 1;
      indentStack[0] = 0;
    } else {
      const cols: number = colsOfIndent(r.src.indent);
      while (indentStack.length > 1 && cols < indentStack[indentStack.length - 1]) {
        indentStack.pop();
      }
      if (cols > indentStack[indentStack.length - 1]) indentStack.push(cols);
      const base: number = hasHeadings ? headingStack.length : 0;
      depth = base + indentStack.length;
    }
    if (depth < 1) depth = 1;

    r.src.depth = depth;
    nodes.push({ depth, raw: r });
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
    const shown: string =
      r.src.checked === null ? r.src.text : (r.src.checked ? "☑ " : "☐ ") + r.src.text;
    const node: IPureNode = r.block
      ? {
          // 先放一个占位：真正的 HTML 由视图层交给 MarkdownRenderer 渲染后替换。
          // 必须先定好尺寸再 setData —— markmap 是按 content 里的 DOM 量节点宽高的，
          // 灌完图再替换内容会和 foreignObject 脱节。
          content: `<span class="obmind-block">${escapeText(r.text)}</span>`,
          children: [],
          // 块节点不给 src：跨多行，改一行就会把块拆坏，故意做成只读
          payload: { block: r.block },
        }
      : {
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

/** 找出树里所有块节点（代码块 / 公式块），供视图层统一渲染 */
export function collectBlocks(
  root: IPureNode,
): { node: IPureNode; block: BlockInfo }[] {
  const out: { node: IPureNode; block: BlockInfo }[] = [];
  const walk = (n: IPureNode): void => {
    const block = n.payload?.block as BlockInfo | undefined;
    if (block && typeof block.raw === "string") out.push({ node: n, block });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}
