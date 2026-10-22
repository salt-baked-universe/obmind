/**
 * 行内 HTML 渲染（L2 表现层）。
 *
 * 职责只有一个：把一行正文里的轻量 Markdown / 双链 / 手写 HTML 变成 HTML 字符串。
 * 它不解析结构、不读文件、不碰 DOM —— 只是字符串到字符串。
 *
 * 从 parser.ts 里拆出来的理由：结构解析是 domain（能在 Node 里跑用例），
 * 而行内渲染属于表现层（要懂 HTML、要防注入）。混在一起时，
 * domain 为了产出 content 不得不依赖 HTML 白名单，分层就断了。
 */

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

/** 标签内容在 escapeHtml 之前就被摘出来了，所以 & < > 都要自己转 */
function escapeAttrFull(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 行内允许透传的 HTML 标签：只放行表现型标签，脚本/框架/表单一律当文本 */
const INLINE_TAGS = new Set([
  "span", "font", "mark", "b", "strong", "i", "em", "u", "s", "del",
  "sup", "sub", "br", "small", "big", "kbd", "abbr", "q", "cite", "center",
]);

/** style 里允许保留的 CSS 属性（字色、字号、字背景等等） */
const STYLE_PROPS = new Set([
  "color", "background", "background-color", "font-size", "font-weight",
  "font-style", "font-family", "text-decoration", "line-height",
  "letter-spacing", "vertical-align", "text-align", "opacity",
]);

/** 行内 HTML 的占位符；用 \u0002 与行内代码的 \u0001 区分开 */
const HTML_TOKEN = "\u0002";
/** 标签名必须紧跟字母，避免把 `a < b` 里的 `<` 当成标签开头 */
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

/** 只留白名单里的 CSS 声明，并挡掉 url()/expression/脚本协议 */
function sanitizeStyle(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const i: number = decl.indexOf(":");
    if (i < 0) continue;
    const prop: string = decl.slice(0, i).trim().toLowerCase();
    const value: string = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || value === "") continue;
    if (/url\s*\(|expression\s*\(|javascript:|@import|\\/i.test(value)) continue;
    if (value.length > 160) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(";");
}

/**
 * 把用户手写的行内 HTML（`<span style="color:red">`、`<font size="5">`…）摘出来换成占位符。
 *
 * 必须在 escapeHtml 之前做：整条流程后面会把 `<` `>` 全部转义，
 * 标签一旦变成字面文本就再也回不来了。摘出来放占位符里，其余部分照旧走转义 →
 * markdown 行内语法，最后再把标签插回去。这样标签里的文字 `**粗体**` 依然生效。
 */
function splitInlineHtml(raw: string): { text: string; tags: string[] } {
  const tags: string[] = [];

  const text: string = raw.replace(
    TAG_RE,
    (whole: string, nameRaw: string, attrs: string): string => {
      const tag: string = nameRaw.toLowerCase();
      if (!INLINE_TAGS.has(tag)) return whole; // 不认识的标签留给 escapeHtml 转成文本

      const token = (payload: string): string => {
        tags.push(payload);
        return `${HTML_TOKEN}${tags.length - 1}${HTML_TOKEN}`;
      };

      if (whole.startsWith("</")) return token(`</${tag}>`);

      let open = `<${tag}`;
      const attrRe =
        /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(attrs)) !== null) {
        const key: string = m[1].toLowerCase();
        const quoted: string | undefined = m[2];
        const value: string = quoted ? quoted.replace(/^["']|["']$/g, "") : "";
        if (key === "style") {
          const style: string = sanitizeStyle(value);
          if (style !== "") open += ` style="${escapeAttrFull(style)}"`;
        } else if (
          key === "color" ||
          key === "face" ||
          key === "size" ||
          key === "align"
        ) {
          open += ` ${key}="${escapeAttrFull(value)}"`;
        } else if (key === "class") {
          const cls: string = value.replace(/[^\w\s-]/g, "").trim();
          if (cls !== "") open += ` class="${escapeAttrFull(cls)}"`;
        }
        // 其余属性（on*、href、src…）一律丢弃，标签只负责样式
      }
      return token(`${open}>`);
    },
  );

  return { text, tags };
}

const INLINE_CODE_TOKEN = "\u0001";

/**
 * 把一行正文里的轻量 Markdown / Obsidian 双链渲染成 HTML。
 *
 * 支持：`code`、[[双链]]、[[双链|别名]]、[[笔记#标题]]、[文字](url)、
 * **粗体**、*斜体*、~~删除线~~、==高亮==，
 * 以及笔记里手写的表现型 HTML（字色 / 字号 / 字背景，见 INLINE_TAGS）。
 *
 * 输入是原始文本（未转义），标签白名单外的内容会先做 HTML 转义，避免注入。
 */
export function renderInline(raw: string): string {
  // 标签先摘出来，否则下一步的转义会把它变成字面文本
  const { text: source, tags } = splitInlineHtml(raw.trim());
  let s = escapeHtml(source);

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

  // 还原手写标签。放最后：标签内的文字该走的 markdown 规则已经走完了
  const htmlRe = new RegExp(`${HTML_TOKEN}(\\d+)${HTML_TOKEN}`, "g");
  s = s.replace(htmlRe, (_m: string, idx: string) => tags[Number(idx)] ?? "");

  // 节点内软换行：解析阶段把续行并入同一节点的 src.text（以 \n 分隔），
  // 这里统一转成 <br>，让多行正文在导图里显示为换行而非空格。
  s = s.replace(/\n/g, "<br>");

  return s;
}
