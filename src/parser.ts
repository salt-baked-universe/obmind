import type { IPureNode } from "markmap-common";

export interface ParseOptions {
  /** 是否跳过笔记顶部的 YAML frontmatter（属性区），默认 true */
  filterFrontmatter?: boolean;
}

/**
 * 节点在源文件里的落点，双向编辑的地基。
 *
 * 有了它，导图上的每次修改都能精确定位到「某一行的一小段字符」，
 * 而不是重排整篇笔记——这是安全回写的前提。
 */
export interface SrcRef {
  /** 原文行号（0 基，含 frontmatter 之前的行） */
  line: number;
  /** 正文首字符在整行中的列号 */
  bodyStart: number;
  /** 正文末字符（不含）在整行中的列号，行尾空白不纳入 */
  bodyEnd: number;
  /** 该行完整原文，写回前用它做冲突校验 */
  full: string;
  /** 列表 / 标题标记，如 "- "、"1. "、"## "；正文行可能为空串 */
  marker: string;
  /** 行首缩进（空格或制表符），新建同级节点时复用 */
  indent: string;
  /** 任务列表勾选状态；null 表示不是任务列表 */
  checked: boolean | null;
  /** 正文原文（已去掉 marker 与勾选框） */
  text: string;
  /** 是否为标题行 */
  heading: boolean;
  /** 标题级别（1-6）；非标题行为 null。拖动改层级时要用 */
  level: number | null;
  /** 在树里的深度，根为 0。拖动时用来算子树范围和缩进增量 */
  depth: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 属性值里只需要处理双引号（其余实体已在 escapeHtml 阶段处理过） */
function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;");
}

const INLINE_CODE_TOKEN = "\u0001";

/**
 * 把一行正文里的轻量 Markdown / Obsidian 双链渲染成 HTML。
 *
 * 支持：`code`、[[双链]]、[[双链|别名]]、[[笔记#标题]]、[文字](url)、
 * **粗体**、*斜体*、~~删除线~~、==高亮==。
 *
 * 输入是原始文本（未转义），函数内部会先做 HTML 转义，避免注入。
 */
export function renderInline(raw: string): string {
  let s = escapeHtml(raw.trim());

  // 行内代码先用占位符保护，避免内部符号被后续规则误伤
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m: string, code: string) => {
    codes.push(code);
    return `${INLINE_CODE_TOKEN}${codes.length - 1}${INLINE_CODE_TOKEN}`;
  });

  // Obsidian 双链 / 嵌入：[[笔记]]、[[笔记|别名]]、[[笔记#标题|别名]]
  s = s.replace(
    /!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g,
    (_m: string, targetRaw: string, aliasRaw: string | undefined) => {
      const target: string = targetRaw.trim();
      const path: string = target.split("#")[0] || target;
      const alias: string = (aliasRaw ?? target).trim();
      return `<a class="internal-link" data-href="${escapeAttr(path)}">${alias}</a>`;
    },
  );

  // 普通链接 / 图片：[文字](url)。
  // URL 里允许出现一层括号（Obsidian 把带括号的文件名写成 a%20(b).md），
  // 否则 `(ToT)` 的第一个右括号会把链接截断，剩下一截裸文本。
  s = s.replace(
    /!?\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))+)\)/g,
    (_m: string, text: string, url: string) => {
      const raw: string = url.trim();
      if (/^(https?:|mailto:|obsidian:|#)/i.test(raw)) {
        return `<a href="${escapeAttr(raw)}">${text}</a>`;
      }
      // 站内链接：Obsidian 常用 encodeURI 形式（a%20b.md），还原后再去掉 .md
      let path: string = raw;
      try {
        path = decodeURIComponent(raw);
      } catch {
        // 非法百分号序列时保持原样
      }
      path = path.replace(/\.md$/i, "");
      return `<a class="internal-link" data-href="${escapeAttr(path)}">${text}</a>`;
    },
  );

  // 粗体、删除线、高亮要先于斜体处理
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  // 还原行内代码
  const tokenRe = new RegExp(`${INLINE_CODE_TOKEN}(\\d+)${INLINE_CODE_TOKEN}`, "g");
  s = s.replace(tokenRe, (_m: string, idx: string) => `<code>${codes[Number(idx)] ?? ""}</code>`);

  return s;
}

interface RawLine {
  text: string;
  headingLevel: number | null;
  src: SrcRef;
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
function detectIndent(indents: string[]): { step: number; unit: string } {
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
 * - 行内语法（双链、链接、粗体、行内代码等）渲染成 HTML
 * - 层级深度做「最多 +1」钳制，避免跳级（如 0 空格直接到 4 空格）导致结构错乱
 *
 * 每个非根节点还会挂 `payload.src`（源行坐标），供双向编辑回写使用。
 * 根节点挂 `payload.step`（检测到的缩进步长）。
 */
export function buildTree(
  content: string,
  fileName: string,
  options: ParseOptions = {},
): IPureNode {
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

  // 2. 收集有效行（跳过空行、围栏代码块、分隔线）
  const raws: RawLine[] = [];
  let inCodeBlock = false;

  for (let idx = lineOffset; idx < allLines.length; idx++) {
    const line: string = allLines[idx];
    if (line.trim() === "") continue;
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

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
    content: escapeHtml(rootName),
    children: [],
    // step / unit 供双向编辑与拖动复用，与解析规则保持一致
    payload: { step, indentUnit: unit },
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
    const node: IPureNode = {
      content: renderInline(shown),
      children: [],
      payload: { src: r.src },
    };
    (parent ?? root).children.push(node);
    stack[n.depth] = node;
    stack.length = n.depth + 1;
  }

  return root;
}
