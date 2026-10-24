/**
 * 写代码块时的「语言」选择器。
 *
 * 为什么要有它：插入代码块后只得到一对裸围栏 ``` ，用户还得回头在笔记里补
 * `python` / `js` —— 高频操作里这一步纯属白敲。这里给一份常用语言清单，
 * 顺手记住上一次选的，下一次在块菜单里就是「代码块 · python」一键。
 *
 * 用 FuzzySuggestModal 而不是下拉框：Obsidian 里它就是「输入框 + 模糊匹配」，
 * 敲 `py` 就能选中 python，和命令面板的手感一致；清单里没有的语言也允许直接
 * 敲进去（临时补一个不常见的 info string 不会被拦住）。
 */

import { App, FuzzySuggestModal, type FuzzyMatch } from "obsidian";

/** 常用语言：前缀匹配的键盘流是按首字母找，所以按使用频率而不是字母序排 */
const LANGS: string[] = [
  "python",
  "javascript",
  "typescript",
  "ts",
  "js",
  "json",
  "bash",
  "shell",
  "sql",
  "html",
  "css",
  "scss",
  "yaml",
  "toml",
  "java",
  "kotlin",
  "go",
  "rust",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "swift",
  "dart",
  "lua",
  "r",
  "matlab",
  "julia",
  "scala",
  "perl",
  "haskell",
  "elixir",
  "clojure",
  "vue",
  "svelte",
  "jsx",
  "tsx",
  "mermaid",
  "markdown",
  "latex",
  "tex",
  "dockerfile",
  "makefile",
  "ini",
  "csv",
  "xml",
  "graphql",
  "protobuf",
  "diff",
];

/** 语言标识只允许字母数字与 `#+._-`，和围栏 info string 的解析规则一致 */
const LEGAL_LANG = /^[A-Za-z0-9#+._-]+$/;

const LAST_LANG_KEY = "obmind:code-lang";

/** 上一次用过的语言；没记录过就给 python（笔记里写代码的第一语言） */
export function lastCodeLang(): string {
  const saved: string | null = window.localStorage.getItem(LAST_LANG_KEY);
  return saved && LEGAL_LANG.test(saved) ? saved : "python";
}

export function rememberCodeLang(lang: string): void {
  if (LEGAL_LANG.test(lang)) window.localStorage.setItem(LAST_LANG_KEY, lang);
}

export class CodeLangModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly onPick: (lang: string) => void,
  ) {
    super(app);
    this.setPlaceholder("代码块语言：输入过滤，回车确认（如 python / js / mermaid）");
    // 清单本身不长，限制高度免得把整个画布盖住
    this.limit = 12;
  }

  getItems(): string[] {
    return LANGS;
  }

  getItemText(item: string): string {
    return item;
  }

  /**
   * 清单外的语言也放行：多插一条「就用你敲的这个」。
   *
   * 放在最前面是因为用户已经明确敲了它 —— 这时 fuzzy 匹配的结果对他没意义，
   * 回车就该落在他自己写的那个词上。
   */
  override getSuggestions(query: string): FuzzyMatch<string>[] {
    const out: FuzzyMatch<string>[] = super.getSuggestions(query);
    const q: string = query.trim();
    if (q !== "" && LEGAL_LANG.test(q) && !LANGS.includes(q.toLowerCase())) {
      out.unshift({ item: q, match: { score: 0, matches: [] } });
    }
    return out;
  }

  onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
    this.onPick(item);
  }
}
