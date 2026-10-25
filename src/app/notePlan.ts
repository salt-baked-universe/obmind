/**
 * 「节点 → 新笔记」的纯决策（L4 app）。
 *
 * 这条链路里真正容易错的都不是 IO，而是**命名**：
 *
 *   `**重点**` 当文件名 → 文件叫「**重点**」，双链写成 `[[**重点**]]` 一眼看不懂；
 *   `A/B 方案` 当文件名 → Windows 上直接建不出来，macOS 上会多一层目录；
 *   `Q3 复盘 #会议` 当文件名 → `#` 在双链里是「标题锚点」，`[[Q3 复盘 #会议]]`
 *   指向的是「Q3 复盘」这篇笔记的「会议」小节，不是这篇新笔记。
 *
 * 于是把「取名字」「算落地文件夹」「展开模板」全部收在这里，做成不碰
 * Obsidian、不读 DOM 的纯函数 —— 都能在 Node 里直接断言（scripts/testBatch.ts）。
 */

/** 这行正文里是否已经有双链（有就不再提供「新建笔记」入口） */
const WIKILINK_RE = /\[\[[^[\]]+\]\]/;

export function hasWikiLink(text: string): boolean {
  return WIKILINK_RE.test(text);
}

/**
 * 去掉行内标记，留下「能当文件名用」的纯文字。
 *
 * 只处理导图里会显示出来的那些语法（行内代码 / 链接 / 强调 / 高亮 / 行内 HTML），
 * 不做完整 Markdown 解析：这一行的目的是取名字，不是渲染。
 */
export function plainTextOf(md: string): string {
  let s: string = md;
  // 行内代码：内容才是字
  s = s.replace(/`([^`]*)`/g, "$1");
  // 图片 / 普通链接：[文字](url) → 文字
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 行内 HTML 标签（<u> 之类）
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // 强调 / 删除线 / 高亮；先长后短，避免 ** 被单个 * 先吃掉
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");
  s = s.replace(/==(.*?)==/g, "$1");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1$2");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1$2");
  // 行内公式的 $ 包壳
  s = s.replace(/\$([^$]+)\$/g, "$1");
  // 任务勾选框：画布上不显示，编辑框里带 ☐/☑ 前缀
  s = s.replace(/^[☐☑]\s*/u, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 文件名里不能出现的字符。
 *
 * 前一半是 Windows 的硬限制（Obsidian 跨平台，按最严的来）；
 * 后一半（`# ^ [ ]`）不是文件系统限制，而是**双链语法**限制 ——
 * 留着它们，`[[名字]]` 会解析成别的东西（锚点、块引用、嵌套链接）。
 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/** 名字最长多少字：再长 Windows 整条路径就超限了，40 个汉字当标题也够 */
const MAX_NAME = 80;

export function sanitizeFileName(name: string): string {
  const out: string = name
    .replace(ILLEGAL_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    // 结尾的点和空格在 Windows 上会被静默吃掉，直接自己去掉
    .replace(/[. ]+$/g, "");
  return out.length > MAX_NAME ? out.slice(0, MAX_NAME).trim() : out;
}

/** 节点正文 → 笔记名；空串表示这行给不出名字（调用方要提示而不是建「无标题.md」） */
export function noteTitleOf(md: string): string {
  return sanitizeFileName(plainTextOf(md));
}

export interface NoteLocationInput {
  /** Obsidian 设置「新建笔记的存放位置」：root / current / folder */
  location: string | null | undefined;
  /** location === "folder" 时的目标文件夹（Obsidian 设置里的那一项） */
  folder: string | null | undefined;
  /** 当前这篇笔记的路径（location === "current" 时用来取它的目录） */
  currentPath: string | null | undefined;
}

function normalizeDir(path: string | null | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * 按 Obsidian 自己的「新建笔记存放位置」设置决定目标文件夹，返回 "" 表示库根。
 *
 * 刻意复用 Obsidian 的设置而不是插件自己再加一项：用户在哪里找得到新笔记，
 * 应该由他早就设好的那条规则决定 —— 插件另立一套，只会让新笔记散在两个地方。
 */
export function resolveNoteFolder(input: NoteLocationInput): string {
  if (input.location === "folder") return normalizeDir(input.folder);
  if (input.location === "current") {
    const path: string = normalizeDir(input.currentPath);
    const cut: number = path.lastIndexOf("/");
    return cut < 0 ? "" : path.slice(0, cut);
  }
  // root / 未设置 / 不认识的取值：都落库根，和 Obsidian 的默认一致
  return "";
}

/** 文件夹 + 名字 → 全路径 */
export function notePathOf(folder: string, title: string): string {
  const dir: string = normalizeDir(folder);
  return dir === "" ? `${title}.md` : `${dir}/${title}.md`;
}

export interface TemplateVars {
  /** 笔记名（已 sanitize） */
  title: string;
  /** 来源笔记名（导图当时显示的那篇），用于 `{{from}}` */
  from?: string;
  /** 注入时钟，方便用例 */
  now?: Date;
}

const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT = "HH:mm";

/** 按 moment 那套 token 拼日期，但只实现 Templates 插件常用的那几个 */
export function formatDate(d: Date, fmt: string): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const table: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    mm: pad(d.getMinutes()),
    m: String(d.getMinutes()),
    ss: pad(d.getSeconds()),
    s: String(d.getSeconds()),
  };
  // 长 token 必须排在短 token 前面，否则 YYYY 会被 YY 先行匹配
  return fmt.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/g, (t: string) => table[t] ?? t);
}

/**
 * 模板变量。
 *
 * 变量名沿用 Obsidian 核心 Templates 插件的写法（`{{title}}` / `{{date}}`），
 * 用户从那边迁过来不用重新学；`{{from}}` 是本插件加的「我从哪来的」双链。
 */
const TOKEN_RE = /\{\{\s*(title|date|time|from)(?:\s*:\s*([^}]+?))?\s*\}\}/gi;

export function applyTemplate(raw: string, vars: TemplateVars): string {
  const now: Date = vars.now ?? new Date();
  return raw.replace(
    TOKEN_RE,
    (whole: string, name: string, fmt: string | undefined): string => {
      switch (name.toLowerCase()) {
        case "title":
          return vars.title;
        case "from":
          return vars.from ? linkLiteral(vars.from) : "";
        case "date":
          return formatDate(now, fmt?.trim() || DEFAULT_DATE_FORMAT);
        case "time":
          return formatDate(now, fmt?.trim() || DEFAULT_TIME_FORMAT);
        default:
          return whole;
      }
    },
  );
}

/**
 * 写进节点的双链字面量。
 *
 * 原文带行内标记（`**重点**`）时用别名形式 `[[重点|**重点**]]`：名字干净，
 * 卡片上看起来还是原来那个样子 —— 用户改的是「它有没有链接」，不是「它的字」。
 */
export function linkLiteral(title: string, alias?: string): string {
  // 别名里的 | 会提前终止别名段，必须去掉
  const shown: string = (alias ?? "").replace(/\|/g, "").trim();
  if (shown === "" || shown === title) return `[[${title}]]`;
  return `[[${title}|${shown}]]`;
}
