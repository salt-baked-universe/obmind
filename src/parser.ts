import type { IPureNode } from "markmap-common";

export interface ParseOptions {
  /** 是否跳过笔记顶部的 YAML frontmatter（属性区），默认 true */
  filterFrontmatter?: boolean;
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
  indentTabs: number;
  indentSpaces: number;
}

/** 无序列表标记（含任务列表）与有序列表标记 */
const LIST_PREFIX = /^(?:[-*+]\s+(?:\[([ xX])\]\s+)?|\d{1,9}[.)]\s+)/;
/** 分隔线：--- / *** / ___ */
const RULE_LINE = /^([-*_])(?:\s*\1){2,}$/;

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
 */
export function buildTree(
  content: string,
  fileName: string,
  options: ParseOptions = {},
): IPureNode {
  const filterFrontmatter: boolean = options.filterFrontmatter !== false;
  const rootName: string = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

  let lines: string[] = content.split("\n");

  // 1. 跳过笔记顶部的 YAML frontmatter
  if (filterFrontmatter) {
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length && /^---\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^---\s*$/.test(lines[j])) j++;
      if (j < lines.length) lines = lines.slice(j + 1);
    }
  }

  // 2. 收集有效行（跳过空行、围栏代码块、分隔线）
  const raws: RawLine[] = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // 引用前缀（可能多层）去掉，只保留正文
    let body: string = line;
    while (/^\s*>/.test(body)) body = body.replace(/^\s*>\s?/, "");

    const wsMatch: RegExpMatchArray | null = body.match(/^[ \t]*/);
    const ws: string = wsMatch ? wsMatch[0] : "";
    let text: string = body.slice(ws.length);

    const indentTabs: number = (ws.match(/\t/g) ?? []).length;
    const indentSpaces: number = ws.length - indentTabs;

    // 标题行
    const heading: RegExpMatchArray | null = text.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const headingText: string = heading[2].trim();
      if (headingText !== "") {
        raws.push({
          text: headingText,
          headingLevel: heading[1].length,
          indentTabs: 0,
          indentSpaces: 0,
        });
      }
      continue;
    }

    // 正文分隔线
    if (RULE_LINE.test(text.trim())) continue;

    // 剥离列表标记，任务列表转成勾选框
    const listMatch: RegExpMatchArray | null = text.match(LIST_PREFIX);
    if (listMatch) {
      const checkbox: string | undefined = listMatch[1];
      text = text.slice(listMatch[0].length);
      if (checkbox !== undefined) {
        text = (checkbox === " " ? "☐ " : "☑ ") + text;
      }
    }

    text = text.trim();
    if (text === "") continue;

    raws.push({
      text,
      headingLevel: null,
      indentTabs,
      indentSpaces,
    });
  }

  const hasHeadings: boolean = raws.some((r) => r.headingLevel !== null);

  // 3. 检测缩进步长（正文行里最小的正空格数）
  let step = 2;
  let minSpaces = Infinity;
  for (const r of raws) {
    if (r.headingLevel === null && r.indentSpaces > 0 && r.indentSpaces < minSpaces) {
      minSpaces = r.indentSpaces;
    }
  }
  if (minSpaces !== Infinity) step = minSpaces;

  // 4. 计算每一行的深度（根为 0，第一层子节点为 1）
  const nodes: { depth: number; text: string }[] = [];
  let prevDepth = 0;
  const headingStack: number[] = [];

  for (const r of raws) {
    let depth: number;
    if (hasHeadings && r.headingLevel !== null) {
      const level: number = r.headingLevel;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= level) {
        headingStack.pop();
      }
      headingStack.push(level);
      depth = headingStack.length;
    } else {
      const indentLevel: number = r.indentTabs + Math.floor(r.indentSpaces / step);
      const base: number = hasHeadings ? headingStack.length : 0;
      depth = base + 1 + indentLevel;
    }
    // 钳制：至少 1 层；相对上一行最多深 1 层
    if (depth < 1) depth = 1;
    if (depth > prevDepth + 1) depth = prevDepth + 1;

    nodes.push({ depth, text: r.text });
    prevDepth = depth;
  }

  // 5. 按深度装配成树
  const root: IPureNode = { content: escapeHtml(rootName), children: [] };
  const stack: IPureNode[] = [root];

  for (const n of nodes) {
    const parent: IPureNode = stack[n.depth - 1] ?? root;
    const node: IPureNode = { content: renderInline(n.text), children: [] };
    parent.children.push(node);
    stack[n.depth] = node;
    stack.length = n.depth + 1;
  }

  return root;
}
