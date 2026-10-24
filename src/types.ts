/**
 * 跨层契约（L0）。只有数据形状，没有逻辑，谁都允许依赖它。
 *
 * 这里放的是「多层都要用、但不属于任何一层」的类型。它们以前散在 parser.ts 里，
 * 结果是 plan / drag / text / move 为了拿一个 SrcRef 不得不依赖整个解析器。
 */

/** 解析选项 */
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
  /** 多行节点（软换行）占用的末行号（0 基，含）；单行节点等于 line */
  endLine: number;
  /** 软换行续行的正文（不含缩进/标记）；单行节点为 undefined */
  extra?: string[];
  /**
   * 依附在这个节点上的块（代码块 / 公式 / 引用 / 表格）占用的行区间。
   *
   * 块在树里是宿主的只读子节点，但它在源文件里占着几行，所以移动、删除、
   * 算插入位置时必须把它一起算进这个节点的地盘 —— 否则删节点会把代码留在原地
   *（然后它就「依附」到别的节点上去了）。块节点自己也带一份同样的区间，
   * 保证单独删掉一个块时只删块、不动宿主。
   */
  blockStart?: number;
  blockEnd?: number;
  /**
   * 这是一个**块节点**：代码块 / 公式 / 表格 / 引用。
   *
   * 它在树里是一等节点（有位置、能被选中、能删），但内容由 MarkdownRenderer
   * 渲染产出，绝不能走「原地改字」通道 —— 所以所有编辑入口都要靠这个标记拦住它。
   * 标记放在 SrcRef 而不是 payload 上：编辑层只拿得到 SrcRef 列表，看不见 payload。
   *
   * 两个档：
   * - `"bound"`：裸块，没有代理行。层级只能由围栏自己的缩进决定（0～3 格），
   *   再往里缩围栏就变成「缩进代码块」了，所以**不许拖动**。
   * - `"free"`：上面有一行 `<!-- obmind:block -->` 代理行。层级由那一行的缩进决定，
   *   块本体照旧顶格 —— 于是它可以像普通节点一样拖到任意位置。
   */
  blockNode?: "bound" | "free";
  /** 自由块的代理行行号（`<!-- obmind:block -->` 所在行）；裸块为 undefined */
  proxyLine?: number;
}

/**
 * 挂在一个节点上的整块内容：围栏代码块、`$$…$$` 公式块、GFM 表格、引用块。
 *
 * 归属规则：块的归属 = **它前面最近的那一个节点行**，与缩进无关。
 * 原因在于 Markdown 的两套坐标不正交：层级靠缩进（或在标题体系里靠 `#`），
 * 块却自带边界（围栏、`>` 前缀、表格行）。一旦让块靠缩进表达归属，
 * 围栏块就会出问题 —— 它只能缩 0～3 格，第 4 格起退化成「缩进代码块」，
 * ``` 变成字面量。所以块不用缩进说话，只按位置归属。
 *
 * 它在树里表现成宿主的**只读子节点**（位置 = children 开头，紧跟宿主之后）：
 * 有自己的卡片、自己的连线，宿主折叠时跟着收起。卡片内容是 Obsidian 自己的
 * MarkdownRenderer 渲染出来的，观感与笔记里完全一致（高亮 / mermaid / 表格 / 公式）。
 *
 * 只读：双击、F2、空格、Tab、拖动全部拦掉。要改内容回笔记里改。
 */
export interface BlockInfo {
  kind: "code" | "math" | "table" | "quote";
  /** 代码块的语言标识（```js 里的 js）；公式块 / 表格 / 引用为空串 */
  lang: string;
  /** 块原文（代码块含围栏）—— 交给 MarkdownRenderer 的就是它 */
  raw: string;
  /** 起始 / 结束行号（0 基，含围栏行 / 表头行） */
  startLine: number;
  endLine: number;
  /** 内容行数，用于占位文案 */
  lines: number;
  /**
   * 渲染失败 / 空块时的回退文案（如「代码块 · python · 12 行」）。
   * 也是块节点 `src.text` 的来源 —— 只给日志和工具条读，不可编辑。
   */
  label?: string;
}

/** 拖动落点：成为子级 / 插到目标之前 / 插到目标之后 */
export type DropMode = "child" | "before" | "after";

/**
 * 编辑框结束时告诉调用方的意图。
 *
 * 定义在 L0 而不是 inlineText.ts：应用层要消费它，但不该为了一个字符串联合
 * 去依赖「编辑框长什么样」。
 */
export type EditorAction =
  | "commit"
  /** 提交并新建同级（Enter） */
  | "sibling"
  /** 提交并新建子级（Tab）：XMind 手感，改完这一个顺手往下一层写 */
  | "child"
  /**
   * 把当前节点缩进一级。
   *
   * 编辑框**不再产出**这个动作：以前 Tab 绑的是它，用户按 XMind 的习惯用 Tab
   * 「结束输入」，结果节点被挪成了上一级的子节点 —— 结构被悄悄改了。
   * 现在 Tab 等于「提交 + 建子级」。缩进能力留给画布级别的结构键（暂未绑定）。
   */
  | "indent"
  | "outdent"
  /** 撤销这次编辑，原文不动 */
  | "cancel";
  // 曾经有一个 "delete"：编辑框里把字删空 = 删掉节点。
  // 实际用下来这是错的 —— 编辑时按退格只是「改字」，把节点删掉属于结构操作，
  // 必须发生在**没有聚焦**的选中态。所以删除只从画布的 Delete/Backspace 来。

/**
 * 一次行区间替换；空 lines 表示删除这些行。
 *
 * 定义在 L0 而不是 writer 里：service 要产出它，但 service 不该依赖
 * 「怎么写文件」那个模块。writer 反过来从这个文件取类型。
 */
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
  /**
   * 第二个锚点。
   *
   * 「改写当前行 + 在子树末尾插入新行」是一次跨越整个子树的替换，中间那些行
   * 会被原样回写。只校验首行的话，中间有行被改动就会被旧内容覆盖（静默回退）。
   * 加一个尾锚点，首尾都对得上才动手。
   */
  checkEnd?: { line: number; text: string };
}

/**
 * 一次写入意图（L4 的输入，L3 writer 的执行依据）。
 *
 * service 只产出它，不执行它 —— 这样 service 不碰文件、不弹提示，
 * 「怎么写」的全部细节（编辑器事务 / vault.process / 冲突校验）留在 writer 里。
 */
export type WriteOp =
  /** 改某几行（改字、缩进、新建、删除）：行号本身不变 */
  | { kind: "span"; span: Span }
  /** 整篇替换（拖动改层级：行号全变，只能整体重排） */
  | { kind: "whole"; content: string; expect: string };

/** 写操作的结果：要么成功，要么给出可展示的原因 */
export type WriteResult =
  | {
      ok: true;
      /**
       * 写入后的整篇内容（写的时候顺手算出来）。
       *
       * 带上它是为了省掉「写完再读一次文件」：vault 那条路径要等一次磁盘 IO，
       * 期间导图还是旧的，用户看到的就是「点了没反应，过一会儿才跳」。
       */
      next?: string;
    }
  | { ok: false; reason: string };
