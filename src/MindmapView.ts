import {
  Component,
  ItemView,
  Menu,
  Notice,
  WorkspaceLeaf,
  MarkdownRenderer,
  MarkdownView,
  TFile,
  debounce,
  normalizePath,
  setIcon,
} from "obsidian";
import type { Editor, EditorPosition, WorkspaceSplit } from "obsidian";
import { Markmap } from "markmap-view";
import type { INode, IPureNode } from "markmap-common";
import { collectBlockNodes, renderInline } from "./parser";
import type { BlockInfo, DropMode, SrcRef, WriteOp } from "./types";
import { resolveTheme, THEME_OPTIONS } from "./theme";
import type { MindmapTheme, ThemeSpec } from "./theme";
import { NodePainter } from "./render/painter";
import { measureLayoutLag, translateOf } from "./render/geometry";
import { BranchColors, branchKey, branchPathOf, hash32 } from "./render/colors";
import { FrameScheduler } from "./render/frame";
import {
  traceBindSvg,
  isTracing,
  traceElapsed,
  traceLog,
  traceLogEvery,
  traceSince,
} from "./render/trace";
import { waitStableSize } from "./render/viewport";
import { WheelGesture } from "./render/wheel";
import type { WheelIntent } from "./render/wheel";
import { applyFolds, collectFolds } from "./edit/folds";
import { firstChildRef, stepVisible, visibleLeafRefs } from "./domain/nav";
import type { NavNode } from "./domain/nav";
import { parseEditorValue } from "./edit/text";
import type { BlockKind } from "./edit/block";
import { CodeLangModal, lastCodeLang, rememberCodeLang } from "./ui/codeLang";
import { openInlineEditor } from "./edit/inlineText";
import type { EditorAction, InlineEditorHandle } from "./edit/inlineText";
import { applyOp, findEditor } from "./edit/writer";
import { DragController } from "./edit/drag";
import { blockRange } from "./edit/move";
import { BoxSelectController } from "./edit/boxSelect";
import { EditService } from "./app/EditService";
import type { EditSnapshot } from "./app/EditService";
import { pushEntry, pushEntryDetailed, topOf, truncateTo } from "./app/NavStack";
import type { NavEntry } from "./app/NavStack";
import {
  forwardTarget,
  normalizeNavSync,
  planBack,
  trackOpenedLeaf,
} from "./app/NavPolicy";
import type { ForwardTarget, NavSyncMode } from "./app/NavPolicy";
import { QueryService } from "./app/QueryService";
import {
  applyTemplate,
  hasWikiLink,
  linkLiteral,
  notePathOf,
  noteTitleOf,
  resolveNoteFolder,
} from "./app/notePlan";
import { canRedo, canUndo, EMPTY_HISTORY, record, redo, undo } from "./app/History";
import type { HistoryState } from "./app/History";
import { buildToolbar, GLOBAL_GROUPS, NODE_GROUPS } from "./ui/toolbar";
import type { ToolbarActionId, ToolbarHandle } from "./ui/toolbar";
import { NodeBar } from "./ui/nodeBar";
import { isTypingTarget } from "./ui/keyGuard";
import { formatStats, treeStats } from "./domain/stats";
import { ViewRuntime } from "./app/runtime";
import { matchAction } from "./app/actions";
import type { ActionId, ActionState } from "./app/actions";
import { systemClipboard } from "./io/clipboard";
import type { ClipboardPort } from "./io/clipboard";
import { planProjection, relabelTree } from "./app/plan";
import {
  buildSvgText,
  exportFileName,
  exportViewBox,
  isOpaqueColor,
} from "./export/svg";
import type { ViewBox } from "./export/svg";
import type MindmapPlugin from "./main";

// 必须带插件前缀。早先用的是通用名 "mindmap-view"，一旦 onload 中途抛错，
// Obsidian 禁用插件时不会回滚已注册的视图类型，残留会让下一次开启直接死在
// "Attempting to register an existing view type" 上，而且永久卡住。
export const MINDMAP_VIEW_TYPE = "obmind-view";

type MarkmapOptions = NonNullable<Parameters<typeof Markmap.create>[1]>;

/** 快捷键说明面板的内容。改一处就够，不必再维护标记里的长 tooltip。 */
const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["单击", "选中节点（之后可用下面的按键）"],
  ["选中后", "画布右侧浮出操作条：新建子级 / 同级、新建笔记、插入块、编辑、提升、删除"],
  ["双击 / F2 / 空格", "原地编辑（空格不需要先用鼠标点进画布）"],
  ["Tab / Enter", "新建子级 / 新建同级"],
  ["Ctrl/⌘+N", "按节点文字新建一篇笔记，节点变成指向它的双链（可套模板）"],
  ["Ctrl/⌘+V", "把剪贴板内容粘成选中节点的子节点（多行 = 多个同级子节点，粘完不进编辑框）"],
  ["插入块", "在选中节点下面加代码块 / 引用 / 表格，按 Obsidian 原生方式渲染，成为独立节点"],
  ["插入代码块", "菜单里直接给「代码块 · 上次用的语言」，换语言走「代码块（换语言）…」（可自己敲）"],
  ["块的位置", "块是一张独立卡片（只读）：双击不进编辑，选中后可以删除、可以拖到别处"],
  ["让块能拖", "在块上面加一行 <!-- obmind:block -->（插件插入的块会自动带）"],
  ["Callout", "`> [!note] 标题` 当容器：标题成节点，正文按 `>` 后的缩进挂在它下面"],
  ["↑ ↓", "换选中：在末级节点之间前后走（不落到分支上）"],
  ["← →", "换选中：父级 / 子级（折叠着会自动展开）"],
  ["Shift+Tab", "提升一级"],
  ["Delete", "删除节点及其全部子节点（只在没在编辑时生效）"],
  ["拖动节点", "按住左键拖到别的卡片上改变父子关系"],
  ["鼠标滚轮", "以指针为中心缩放（一格一格的滚法）"],
  ["触摸板双指", "平移画布：图跟着手指走（连续、带横向分量的一律按平移算）"],
  ["触摸板捏合", "缩放；驱动没合成捏合就用 Ctrl+滚轮"],
  ["Ctrl/⌘ + = / - / 0", "放大 / 缩小 / 缩放到适合窗口"],
  ["右键拖动 / Shift+滚轮", "平移画布（触摸板：双指按下再拖）"],
  ["Ctrl/⌘+单击", "加选 / 减选（点在已选节点上就把它去掉）"],
  ["Shift+单击", "选中同级区间：先点首，再 Shift 点尾"],
  ["Alt+单击", "按节点文字打开同名笔记"],
  ["Ctrl+Z / ⇧Ctrl+Z", "撤销 / 重做"],
  ["编辑框 ↵ / Tab", "提交并退出（结束输入只做这一件事）"],
  ["编辑框 Ctrl+↵", "提交并新建同级"],
  ["编辑框 ⇧+Tab", "提交并提升一级"],
  ["钉住", "锁定这张图：切笔记、点双链，图都不换（笔记窗口照常打开）"],
  ["Esc", "取消编辑、收起面板或取消选中"],
  ["点空白", "取消选中，收起节点操作条"],
  ["导出", "整张图存成 <笔记名>.mindmap.svg（笔记同目录）"],
];

/** 把 catch 到的东西变成一句能显示的话（unknown 不能直接拼字符串） */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 子树节点数，只给日志用。
 *
 * 调用方会先用 `isTracing()` 兜一下：这函数要遍历整棵树，
 * 关着日志时连算都不该算。
 */
function countNodes(root: IPureNode): number {
  let n = 1;
  for (const child of root.children ?? []) n += countNodes(child);
  return n;
}

/** 原文行数，只给日志用（判断这次变化是不是「插了一行」） */
function countLines(text?: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 归一化一段「人读的文字」，用于比对「编辑框的值」与「卡片上显示的字」。
 *
 * 两者来源不同（一个是源码行文本、一个是渲染后的 HTML），行内标记、空白、
 * 复选框符号必然有差异，不归一化就会天天误报。
 */
function normalizeLabel(s: string): string {
  return s
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/[☑☐]/g, "")
    .replace(/\[[ xX]\]/g, "");
}

/**
 * 调用来源（只给日志用）。
 *
 * 「整树重排」有好几个可能的发起者：markmap 自己的 ResizeObserver 防抖、
 * 我们的 reflowNow、setData 收尾、面板切换……光看事件顺序分不清，
 * 而该不该拦完全取决于是谁叫的。取栈里最前面的三个函数名足够定位。
 */
function callerOf(): string {
  const stack: string | undefined = new Error().stack;
  if (!stack) return "?";
  const names: string[] = [];
  for (const raw of stack.split("\n").slice(1)) {
    // 跳过本函数与包出来那一层（都是我们自己，没有信息量）
    if (raw.includes("callerOf") || raw.includes("patchedRender") || raw.includes("tracedTransition")) continue;
    const m = /at\s+([^\s(]+)/.exec(raw);
    names.push(m ? m[1].replace(/\s+/g, "_") : "?");
    if (names.length >= 3) break;
  }
  return names.join("<");
}

/** 日志里认节点用的短标签：剥掉 content 里的标签取前几个字（不然全是 `<span cla...`） */
function nodeLabel(g: SVGGElement): string {
  const d = (g as SVGGElement & { __data__?: IPureNode }).__data__;
  const raw: string = String(d?.content ?? "");
  const text: string = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 10) : "?";
}

/**
 * 从 inline style 的旧值里抠出 opacity。
 *
 * `attributeOldValue` 给的是**整条 style 属性**（如 `opacity: 0.42;`），
 * 不是单个声明的旧值，所以这里要自己解析。
 */
function styleOpacityOf(raw: string | null): string {
  if (!raw) return "-";
  const m = /opacity:\s*([^;]+)/.exec(raw);
  return m ? m[1].trim() : "-";
}

/** 导出提示里报文件大小，单位只在需要时出现 */
function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * 适配时认定「视口已就绪」的最小边长。
 *
 * 视图刚创建 / 侧栏滑出的过程中，svg 的尺寸会是 0 或几十像素。在这种尺寸上
 * fit 出来的 scale 要么是 0（缩成一个点），要么极小 —— 两者看起来都是空白。
 */
const MIN_VIEWPORT = 40;

/** 我们自己插进节点 g 的装饰元素（卡片 / 阴影 / 连线）的 class */
const DECOR_CLASSES = ["obmind-node-card", "obmind-node-shadow", "obmind-node-link"];

/**
 * 观察器的配置。
 *
 * - class：markmap 重排会重写节点 class（会把选中态抹掉）；
 * - style：节点文字的 opacity（淡入淡出），卡片要跟着淡；
 * - width/height：**只在值真的变了时才算数**（靠 `attributeOldValue` 过滤）。
 *
 *   为什么会加回来：卡片宽度是照 `foreignObject` 的 width 画的，而它是另一套
 *   元素，属性变了不会自己变大。markmap 在 `_relayout` 之后会写一次 width，
 *   但那次重排的**位置通常没变**（改文字只往右长，x/y 不动）—— transform 通道
 *   被同值过滤掉，class 通道只补选中框，于是**一次绘制都不会发生**，
 *   卡片永远停在旧宽度、新文字直接溢出边框（用户截图）。
 *
 *   它不贵：width/height 由 markmap 在每次 `renderData` 里写一次（不是每帧，
 *   折叠动画写的只有 transform），同值走 oldValue 比较直接丢。
 * - `attributeOldValue`：日志里要能写出「opacity 从 0.42 变成 0.58」这种斜坡，
 *   才分得清「重建时被抄了一次 0」和「真有一条过渡在跑」。只影响记录多带一个
 *   字符串，不参与任何判断。
 *
 * 抽成常量是因为 `raiseNodes` 里重新 `observe` 时要用同一份。
 */
const OBSERVE_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["transform", "class", "style", "width", "height"],
  attributeOldValue: true,
};

/**
 * 这条 childList 记录是不是「我们往节点里插装饰」造成的。
 *
 * 判据刻意收得很窄：只有「目标就是节点 g」且「增删的全是带装饰 class 的元素」
 * 才算。markmap 往 g 里插 foreignObject / circle 属于重建的一部分，必须当结构变化。
 */
function isOwnDecoration(rec: MutationRecord): boolean {
  const target = rec.target;
  if (!(target instanceof Element) || !target.classList.contains("markmap-node")) {
    return false;
  }
  const nodes: Node[] = [...Array.from(rec.addedNodes), ...Array.from(rec.removedNodes)];
  if (nodes.length === 0) return false;
  return nodes.every(
    (n: Node) => n instanceof Element && DECOR_CLASSES.some((c) => n.classList.contains(c)),
  );
}

/**
 * 这条 childList 记录是不是「节点卡片里的文字重新渲染了一遍」。
 *
 * `foreignObject` 里面那层 div 就是文字本身。改字走的是 `patch` 通道
 * （只换 innerHTML、不重建树），markmap 自己重排时也会重建那层内容 ——
 * 两者产生的记录都被当成「结构变化」，于是每次改一个字都要多付一次全量绘制：
 * `applyPatch → reflowSoon → renderData → paintNow`（第一次）
 * ＋ 观察器这一批 `requestAll → paintAll`（第二次）。
 *
 * 它不可能是节点增删：节点的 `<g>` 在 foreignObject **外面**，谁插删节点都
 * 不会把记录落在 fo 内部。
 */
function isContentChurn(rec: MutationRecord): boolean {
  const target = rec.target;
  if (!(target instanceof Element)) return false;
  // closest 含自身：目标可能就是 foreignObject（markmap 换整层内容时）
  return target.closest("foreignObject") !== null;
}

/**
 * 适配后认定「内容包围盒有效」的最小宽高。
 *
 * markmap 的 `state.rect` 是它自己算出来的内容范围。适配那一刻如果它还是
 * `{0,0,0,0}`（_relayout 没跑完、或者所有节点尺寸都是 0），内容会全部堆在
 * 原点，看上去就是一片空白 —— 这种情况只能重试，不能当成「图很小」。
 */
const MIN_CONTENT = 1;

/**
 * 上一次投影的快照。下一次刷新拿它做 diff，决定走哪条绘制通道。
 * 同时也是拖动用的节点树来源（折叠的节点不在 DOM 里，只能从树里取源坐标）。
 */
interface Snapshot {
  content: string;
  tree: IPureNode;
  /** 全部节点的源坐标，按行升序：新建节点要算子树范围 */
  nodes: SrcRef[];
  path: string;
  themeKey: string;
  filterFrontmatter: boolean;
}

/**
 * 思维导图视图。
 *
 * 职责边界：
 * - 本类只管「视图生命周期 + 工具栏 + 事件 + 选哪篇笔记 + 投影」；
 * - 状态闸门与重建串行化在 app/runtime.ts（一个显式 phase 代替一堆布尔）；
 * - 走哪条绘制通道在 app/plan.ts（纯函数，可单测）；
 * - 帧合并与全量/定向绘制在 render/frame.ts；
 * - 节点卡片/连线怎么画在 render/painter.ts；
 * - 节点几何与路径计算在 render/geometry.ts；
 * - 笔记文本 → 节点树在 parser.ts。
 */
export class MindmapView extends ItemView {
  private plugin: MindmapPlugin;
  private mm: Markmap | null = null;
  private svgEl: SVGSVGElement | null = null;
  private canvasEl: HTMLElement | null = null;
  /** 主题按钮（图标 + 菜单）：比原生 <select> 窄一半，也不用跟各主题的 select 样式搏斗 */
  private themeBtn: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** 尺寸还没就绪时挂起的首次适配请求 */
  private pendingFit = false;
  /**
   * 上一次「适配」时的视口尺寸。
   *
   * 有了它才能区分「尺寸变了」和「尺寸没变」：ResizeObserver 会因为
   * 一个像素的变化反复回调，每次都重新 fit 会把用户的视口按住不放。
   */
  private fittedSize: { w: number; h: number } | null = null;
  /**
   * 用户是否自己动过视口（滚轮缩放 / 拖动平移）。
   *
   * 动过之后就不再跟随容器尺寸自动适配 —— 用户已经摆好了位置，
   * 我们再去 fit 一次等于把他刚调好的视角抢走。点「适配」按钮会把它清掉。
   */
  private userView = false;
  /** 适配请求的版本号：新的请求作废还在等尺寸的旧请求 */
  private fitToken = 0;
  /** 自动适配的去抖定时器（0 表示没有排队） */
  private autoFitTimer = 0;
  /** 画布空态提示（没有可显示的笔记时） */
  private emptyEl: HTMLElement | null = null;
  /**
   * 分支 → 色板槽位。跨 setData 保留：新加/删除分支只影响新出现的那根，
   * 已有分支的颜色纹丝不动（见 render/colors.ts）。
   */
  private readonly branchColors = new BranchColors();
  private branchSlots = new Map<string, number>();
  private readonly painter = new NodePainter((path: string, size: number) =>
    this.branchSlot(path, size),
  );
  private readonly frames: FrameScheduler;
  /** 内容尺寸变了的重排排队号（0 = 没排） */
  private reflowFrame = 0;
  /**
   * 重建收尾的「挡住淡入」窗口（时间戳，0 = 不管）。
   *
   * 插入/删除一行会让它**后面所有兄弟节点的 key 改变**（markmap 的 key 里带
   * 孩子序号），d3 把它们当成新节点重新 enter：先写 `opacity: 0`，再起过渡。
   * 即使 `duration: 0`，过渡依然**异步到下一帧** —— `setData` 内部那次 await
   * 让出主线程时，浏览器画的就是「一排卡片有底色、没文字、连线也淡着」。
   * 这就是「新建节点闪一下」。
   *
   * 重建期间本来就不该有淡入（位置是瞬间到位的），所以这段时间里凡是 markmap
   * 往 foreignObject 上写 < 1 的 opacity，我们**当场抹掉**（写 `""`）。
   * MutationObserver 回调在微任务里跑，赶在浏览器绘制之前，用户看不到那一帧。
   */
  private fadeGuardUntil = 0;
  /**
   * 「收尾重排」窗口：见 `attachSettleHook`。
   *
   * markmap 自己对每个节点的内容 div 挂了 ResizeObserver（100ms 防抖 → renderData），
   * 而重建/改字之后它必然会再跑一遍整树重排。那一刻若 duration 已经恢复成 180，
   * 整张图就重新动画一次（实测 304 节点里挪了 303 个，最大 102px）。
   * 窗口内它的重排一律按 duration 0 跑，跑完补一次全量绘制。
   */
  private settleUntil = 0;
  /** 用户正在手动折叠/展开：这时候的重排是「该有动画」的，别压 */
  private toggleIntent = false;
  /**
   * 上一次重建结束的时刻（performance.now()）。
   *
   * 只给日志用：现在每次重建之后都有一次「整树又动了一遍」的波峰，需要回答
   * 「它离重建结束多久」——同一个值在不同机器/不同笔记上差得很多，
   * 没有这个计时就只能猜。
   */
  private rebuildEndAt = 0;
  /** 重建后的落位追踪：逐帧采样用的 rAF 句柄（0 = 没在跑） */
  private trajRaf = 0;
  /** 状态闸门 + 重建串行化（替代原来的 refreshing / pending / rebuilding / pendingRefresh） */
  private readonly rt: ViewRuntime;
  private currentSpec: ThemeSpec | null = null;
  // 当前要渲染的笔记。缓存它，避免焦点跑到导图视图上时拿不到活跃笔记。
  private targetFile: TFile | null = null;
  /**
   * 「钉住」：导图不再跟随 Obsidian 的活动笔记。
   *
   * 和导航栈的区别：栈是「顺着双链潜进去了，记得回去的路」，钉住是「我就想一直看这篇」。
   * 两者都不看活动笔记，但用途完全相反 —— 栈是临时的（一在别处切文件就作废），
   * 钉住得撑到用户亲手解开，否则「钉了还在跟着笔记换」等于没钉。
   *
   * 钉住锁的是**这张图**，不是**导航本身**：用户在图里点双链，笔记窗口照常打开
   * 那篇（链接不该变成死链），只是导图原地不动。所以钉住期间所有导航入口
   * （点链接 / Alt+单击 / 面包屑 / 新建笔记）都走 `navigate`，由它分叉到 `openFileOnly`。
   */
  private pinned = false;
  // 上一次成功投影的结果，下次刷新用它做 diff
  private snapshot: Snapshot | null = null;
  private editorHandle: InlineEditorHandle | null = null;
  /**
   * 块渲染用的 Obsidian 子组件（语法高亮 / MathJax / mermaid 的注册都挂在它上面）。
   *
   * 必须自己持有并 unload：`MarkdownRenderer.render` 会把渲染器当子组件挂进来，
   * 不释放的话每刷新一次就堆一批，内存和事件监听都会涨。
   * key = 文件路径|kind|lang|raw —— 与 blockCache 同构，方便一起淘汰。
   */
  private readonly blockParts = new Map<string, Component>();
  /**
   * 块渲染结果的 HTML 缓存。
   *
   * 同一段代码在一次编辑里会被反复解析（打字、折叠、切主题都重新 parse），
   * 每次都跑一遍 MarkdownRenderer + MathJax 是纯浪费。
   */
  private readonly blockCache = new Map<string, string>();
  // 当前笔记检测到的缩进步长（列数）与缩进单位（原文实际用的空白串，可能是制表符）
  private indentStep = 2;
  private indentUnit = "  ";
  // 新建同级节点后，等重建完成再把编辑框落到新行上
  private pendingEditLine = -1;
  /**
   * 剪贴板端口（IO）。
   *
   * 单独一行字段而不是到处调 `navigator.clipboard`：读剪贴板可能被宿主拒绝、
   * 而且是异步的，把它挡在一个接口后面，动作层就只剩「拿到字符串之后怎么办」。
   * 探针 / 用例可以把这里换成内存实现，不必真去申请权限。
   */
  private readonly clipboard: ClipboardPort = systemClipboard;
  /**
   * 下一次投影是否保留当前缩放/位置（不重新适配）。
   *
   * 只在「导图内跳转」时置位：面包屑回退、点双链换一篇，都属于顺着路径继续看，
   * 缩放被重置会让人瞬间找不到自己在哪。用户主动切笔记则照旧适配。
   */
  private keepViewport = false;
  /**
   * 当前选中集合（记源行号）。多选时多个节点同时高亮，批量删除 / 整体拖动都作用于它。
   */
  private selectedLines: Set<number> = new Set();
  /** 主选中节点（最后交互的那个）：单节点操作（改字/缩进/删除）作用于它，也是框选/拖动锚点 */
  private primaryLine = -1;
  /**
   * 上一次同步过的「文件:行」，避免同一个节点重复滚动。
   *
   * 重建（applyTree）之后 `paintSelection` 会被再调一次，选中集没变但 DOM 全新；
   * 这时候滚一下恰好是对的（用户刚改完这一行），所以判据只按「换行/换文件」，
   * 不按结构代数。
   */
  private revealedKey = "";
  /**
   * 「上一次往 DOM 上刷选中态时的 (结构代数, 选中集合) 」。
   *
   * `paintSelection` 每次都要遍历全部节点做 `srcOf()` + `classList.toggle()`，
   * 而它被调用的地方太多：每次 refresh（**哪怕 plan 判定「什么都没变」**）、
   * 每次重排、每次重建、每次提交编辑的收尾。打一个字能触发三轮 250 节点全扫。
   *
   * 但真正需要动的只有两种情况：选中集合变了，或者节点 `<g>` 被换过一批
   * （重建 / markmap 重排把 class 整段重写）。用一个字符串键把这两件事拼起来，
   * 键没变就直接返回 —— 那条路径上一次写下的 class 一定还在。
   */
  private selectionKey = "";
  /**
   * 结构代数：每次重建导图 / 整树重排 +1。
   *
   * 用来让 `selectionKey` 知道「DOM 上那些 class 已经不可信了」，
   * 同时不必为每次重建单独维护一份「哪些元素是新的」。
   */
  private structureGen = 0;
  /**
   * Shift+单击 的区间起点，记的是「上一次不带 Shift 选中/加选的那个节点」。
   *
   * 区间选择的手感必须和文件管理器一致：先点首（定锚点），再 Shift 点尾，
   * 中间整段一起选中；反复 Shift 点别的节点时锚点不动，区间跟着重算。
   * 锚点用行号而不是 DOM，理由同 selectedLines。
   */
  private anchorLine = -1;
  /**
   * 右键是否真的拖动过（区分「右键单击」与「右键拖动平移」）。
   * 拖动过则在 contextmenu 时压下菜单，避免松手弹出浏览器默认菜单。
   */
  private rightDragMoved = false;
  private rightDownX = 0;
  private rightDownY = 0;

  /** 滚轮 / 触摸板的手势判定（见 render/wheel.ts：两件设备的语义完全不同） */
  private wheelGesture = new WheelGesture();
  /**
   * 这一帧攒下的滚轮位移。
   *
   * 触摸板一次滑动能发上百个 wheel 事件，每个都直接改 transform 就是上百次
   * `g.attr("transform")` + 上百次区域重绘。攒到下一帧一次应用，
   * 数学上等价（平移相加、同一点缩放相乘），但每秒只重绘 60 次。
   */
  private wheelQueued = false;
  private wheelPanX = 0;
  private wheelPanY = 0;
  /** 累计缩放倍数，1 表示这一帧没有缩放请求 */
  private wheelZoom = 1;
  /** 缩放的锚点（画布坐标；捏合时手指在哪就以哪为中心） */
  private wheelAt: [number, number] | null = null;

  /**
   * 兼容旧调用：单值选中 = 只选一个。写入会同步 selectedLines（赋 -1 即清空集合）。
   */
  private get selectedLine(): number { return this.primaryLine; }
  private set selectedLine(v: number) {
    const same: boolean =
      this.primaryLine === v &&
      (v < 0 ? this.selectedLines.size === 0 : this.selectedLines.size === 1);
    if (same) return;
    this.primaryLine = v;
    this.selectedLines = v >= 0 ? new Set([v]) : new Set();
    this.paintSelection();
    this.syncToolbar();
  }
  /**
   * 导图内跳转栈：点双链时把上一篇压进来，面包屑显示整条路径。
   *
   * 栈非空时导图显示的是**栈顶那篇**。笔记窗口要不要跟着走，
   * 由设置项 `navSync` 决定（见 app/NavPolicy.ts）—— 导图这边的"看哪篇"
   * 与 Obsidian 的 leaf 是两件事，四种联动方式只是对 leaf 的处理不同。
   */
  private navStack: NavEntry[] = [];
  private breadcrumbEl: HTMLElement | null = null;
  /**
   * 「新标签打开」模式下的标签编号 → leaf 映射。
   *
   * 栈本身是纯数据（只存编号），真正的 WorkspaceLeaf 留在这里 ——
   * 这样 NavStack 仍然可以在 Node 里跑用例，不需要 mock Obsidian。
   */
  private leafSeq = 0;
  private readonly leafById = new Map<number, WorkspaceLeaf>();
  private drag: DragController | null = null;
  /** 左键空白区拖拽框选（ctrl/shift 加选） */
  private boxSelect: BoxSelectController | null = null;
  /** 操作栏（图标按钮 + 主题按钮）。构建细节在 ui/toolbar.ts */
  private toolbar: ToolbarHandle | null = null;
  /** 操作栏尾端的规模统计（节点数 / 树深），每次刷新重写 */
  private statsEl: HTMLElement | null = null;
  /** 单选节点时贴在画布右侧的那条节点操作（ui/nodeBar.ts） */
  private nodeBar: NodeBar | null = null;
  /** 快捷键说明面板（点「?」浮出） */
  private helpPanel: HTMLElement | null = null;
  /**
   * 撤销/重做栈。
   *
   * 存的是「整篇快照」而不是反向操作：写路径产出的是行区间
   * （改哪几行、插在第几行之后），而每次写入都会让行号整体位移 ——
   * 反向计算锚点比直接存全文更容易错，而一篇纯文本才几十 KB。
   */
  private history: HistoryState = EMPTY_HISTORY;

  // --- 读写分离：视图只做「事件 → 用例 → 投影」，不自己算文本变更 ---------
  /** 写路径：编辑意图 → 写入计划（纯计算，不碰文件、不弹提示） */
  private readonly editSvc = new EditService();
  /** 读路径：内容 → 只读快照（解析 + 节点坐标 + 缩进检测） */
  private readonly query = new QueryService(async (path: string): Promise<string> => {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.readContent(file) : "";
  });

  constructor(leaf: WorkspaceLeaf, plugin: MindmapPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.rt = new ViewRuntime((err: unknown) => {
      console.error("[obmind] 重建导图失败", err);
      // 重建失败时快照不可信：留着它，下次会因「内容没变」直接短路，
      // 视图就永远停在半成品上。清掉，下一次刷新强制走全量。
      this.snapshot = null;
    });
    this.frames = new FrameScheduler(this.painter, {
      svg: () => this.svgEl,
      spec: () => this.currentSpec,
      // 重建期间的 DOM 是半成品，画出来必然是错的
      blocked: () => this.rt.phase === "rebuilding",
    });
  }

  getViewType(): string {
    return MINDMAP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "obmind";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement; // .view-content
    container.empty();
    container.classList.add("obmind-container");

    // 顶部（上→下）：
    // 1) 操作栏 —— 「我能做什么」：两行，第一行作用于整张图，第二行作用于选中节点
    // 2) 面包屑 —— 「我在哪」：导图内的跳转路径
    // 两者语义不同，各占一行。挤在一行时路径一长就会把按钮顶出可视区，
    // 而且面包屑出现/消失会让工具条高度跳动。
    const header = container.createDiv({ cls: "obmind-header" });

    // 主题选择：图标按钮 + 菜单。
    // 原来是一个原生 <select>：宽 92px，字号/高度/箭头一律改不动，在 300px 的
    // 侧栏里是最扎眼的控件，而且各主题都给它塞自己的样式。换成图标按钮之后
    // 与其余操作共用一套视觉，当前选中项用菜单里的对勾表示。
    const themeBtn = header.createEl("button", {
      cls: "clickable-icon obmind-theme-btn",
    });
    setIcon(themeBtn, "palette");
    // setIcon 遇到不认识的图标名会静默什么都不画，按钮就变成空方块
    if (themeBtn.childElementCount === 0) {
      themeBtn.setText("主题");
      themeBtn.addClass("obmind-icon-fallback");
    }
    themeBtn.addEventListener("click", (ev: MouseEvent) => {
      ev.preventDefault();
      this.openThemeMenu(themeBtn);
    });
    this.themeBtn = themeBtn;
    this.syncThemeButton();

    // 尾端的规模统计：先造好元素再交给 buildToolbar 摆到最右，
    // 内容由 syncStats 在每次刷新后写入（树变了才有必要重写）
    this.statsEl = header.createSpan({ cls: "obmind-stats" });

    this.toolbar = buildToolbar(header, {
      // logo 占位：现在只有两个字，将来换成图标只要换这一个字段
      brand: "低山",
      leading: themeBtn,
      trailing: this.statsEl,
      groups: GLOBAL_GROUPS,
      onAction: (id: ToolbarActionId) => this.onToolbar(id),
    });

    this.helpPanel = this.toolbar.el.createDiv({ cls: "obmind-help-panel is-hidden" });
    this.buildHelpPanel();

    // 面包屑独占一行：横向可滚动，路径再长也不会挤压上面的按钮
    this.breadcrumbEl = header.createDiv({ cls: "obmind-breadcrumb" });
    this.breadcrumbEl.addClass("is-hidden");

    // 画布
    const canvas = container.createDiv({ cls: "obmind-canvas" });
    this.canvasEl = canvas;
    // 画布必须可聚焦，否则选中节点后收不到 Tab / Enter。
    // 点击节点时会主动 focus，键盘操作才有落点。
    canvas.setAttribute("tabindex", "0");
    canvas.addEventListener("keydown", (e: KeyboardEvent) => this.onCanvasKeyDown(e));
    // 代码块的「复制」按钮：内容每次重建都会重写 innerHTML，逐个绑监听会全丢，
    // 所以统一在画布上做事件委托（e.target 一定是按钮本身）。
    canvas.addEventListener("click", this.onCopyClick, true);
    // 空格进编辑：挂在整个视图上，而不是只挂画布。
    // 画布的 keydown 只在「焦点正好在画布上」才收得到，而点过工具栏、拖过框选、
    // 或者一轮重建之后，焦点经常落在别处 —— 那时按空格毫无反应，用户只会觉得
    // 「选中了却改不了字」。挂在容器上，焦点在这个视图里的任何位置都算数。
    this.registerDomEvent(this.containerEl, "keydown", (e: KeyboardEvent) =>
      this.onViewKeyDown(e),
    );
    const svg = canvas.createSvg("svg");
    // markmap 基础样式挂在 .markmap 上（文字色/字体变量），需手动补类
    svg.classList.add("markmap");
    svg.style.width = "100%";
    svg.style.height = "100%";
    this.svgEl = svg;
    // 探针要一个具体的 svg 才能逐帧采样（frames 档）
    traceBindSvg(svg);

    // 节点操作条挂在画布上（不是节点 DOM 里）：它的位置按卡片的屏幕坐标算，
    // 不参与 SVG 的坐标系，缩放/平移都不用重算内部布局。
    this.nodeBar = new NodeBar(canvas, { groups: NODE_GROUPS }, (id: ToolbarActionId) =>
      this.onToolbar(id),
    );

    this.observeLayout(svg);
    this.observeSize(canvas);

    // 首次渲染
    this.refresh();

    // 编辑器内容变更（防抖 300ms）+ 活跃 leaf 切换
    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        debounce(() => this.refresh(), 300, true),
      ),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh()),
    );
    // 在同一个标签页里换文件时 active-leaf-change 不会触发（leaf 没变），
    // 只靠上面那个监听，就会出现「切了笔记，导图还停在上篇」。
    // file-open 才是真正的钩子。
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (!file || file.extension !== "md") return;
        // 钉住期间：别人换文件跟我无关。这里**不能**走下面的 resetNav ——
        // 钉住时用户在图里可能已经潜了几层，去别的笔记翻一下就清栈，
        // 回来时面包屑已经没了，等于把「钉住」做成了「每次都被重置」。
        if (this.pinned) return;
        // 导图自己打开的笔记（面包屑前进/后退）也会触发 file-open。
        // 判据：打开的正是导图当前显示的那篇 —— 那就是 obmind 自己干的，不能清栈。
        // 只是移动光标、或者切回同一篇，也走这条短路。
        if (file.path === this.targetFile?.path) return;
        // 用户确实在别处换了文件 = 这次「潜入」结束，面包屑作废
        this.resetNav();
        this.targetFile = file;
        this.refresh();
      }),
    );

    // 绑定点击跳转
    svg.addEventListener("click", (e: MouseEvent) => this.onNodeClick(e));
    // 双击编辑必须走捕获阶段：markmap 在 foreignObject 上绑了 dblclick
    // 并调用了 stopPropagation，冒泡阶段收不到。
    svg.addEventListener("dblclick", (e: MouseEvent) => this.onNodeDblClick(e), true);

    // 右键拖拽平移画布（d3-zoom 过滤器已设为「仅右键触发平移」）：
    // 这里负责在「右键拖动过」之后压下 contextmenu，避免松手弹出浏览器菜单；
    // 右键单击（没拖动）仍照常弹出菜单。
    this.registerDomEvent(canvas, "contextmenu", (e: MouseEvent) => {
      if (this.rightDragMoved) {
        e.preventDefault();
        this.rightDragMoved = false;
      }
    });
    this.registerDomEvent(canvas, "pointerdown", (e: PointerEvent) => {
      if (e.button === 2) {
        this.rightDragMoved = false;
        this.rightDownX = e.clientX;
        this.rightDownY = e.clientY;
      }
    });
    this.registerDomEvent(canvas, "pointermove", (e: PointerEvent) => {
      if (e.buttons & 2) {
        if (Math.hypot(e.clientX - this.rightDownX, e.clientY - this.rightDownY) > 4) {
          this.rightDragMoved = true;
        }
      }
    });

    // 拖动改变父子关系
    this.drag = new DragController(svg, canvas, {
      srcOf: (g: SVGGElement) => this.srcOf(g),
      groupLines: (line: number) => this.groupOf(line),
      onDrop: (srcLine: number, targetLine: number, mode: DropMode): boolean =>
        this.onNodeDrop(this.groupOf(srcLine), targetLine, mode),
      raiseNodes: (els: SVGGElement[]) => this.raiseNodes(els),
      onShift: (roots: SVGGElement[], on: boolean) => this.painter.markShifted(roots, on),
    });

    // 左键在空白区拖拽 = 框选（ctrl/shift 加选）；命中节点的拖动交给 DragController。
    this.boxSelect = new BoxSelectController(svg, canvas, {
      srcOf: (g: SVGGElement) => this.srcOf(g),
      onSelect: (lines: number[], additive: boolean) =>
        this.applySelection(lines, -1, additive),
    });

    // 滚轮 / 触摸板：自己接管，交给 render/wheel.ts 判定「这是鼠标还是双指滑动」。
    // d3 的 zoom 过滤器已经不再收 wheel（见 applyZoomFilter），所以这里是唯一入口。
    //
    // `passive: false` 是硬要求：不 preventDefault 的话，触摸板的惯性滚动会穿到
    // 底下的编辑区 —— 图没动，笔记先滚走一屏。它同时承担「用户动过视口」的记账
    // （滚过之后就别再跟着容器尺寸自动适配了，否则一调窗口就把视角抢走）。
    this.registerDomEvent(canvas, "wheel", (e: WheelEvent) => this.onWheel(e), {
      passive: false,
    });

    // 初始没有导航，先置成隐藏，免得空容器占位
    this.renderBreadcrumb();

    // Esc 兜底：画布的 keydown 只在**焦点在画布上**时生效，而点过工具栏、
    // 点过侧栏、或者切过窗口之后焦点就不在了 —— 那时浮动条关不掉。
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => this.onGlobalKeyDown(e));

    // Ctrl/⌘+N 必须挂在 document 的**捕获**阶段 —— Obsidian 的快捷键表把这个组合
    // 绑成了「新建笔记」，它在 document 冒泡阶段处理；我们排在其后就会晚一步，
    // 等收到时一篇空笔记已经开出去了。捕获阶段跑在所有元素监听之前（见 onHotkeyCapture）。
    this.registerDomEvent(
      document,
      "keydown",
      (e: KeyboardEvent) => this.onHotkeyCapture(e),
      true,
    );

    // 点面板外面就收起快捷键说明。
    // 忽略工具栏内的点击，否则点「?」的同一个事件会立刻把它关掉。
    this.registerDomEvent(document, "click", (e: MouseEvent) => {
      if (!this.helpPanel || this.helpPanel.hasClass("is-hidden")) return;
      const target = e.target as Element | null;
      if (target?.closest(".obmind-help-panel") || target?.closest(".obmind-toolbar")) return;
      this.helpPanel.addClass("is-hidden");
    });

    this.syncToolbar();
  }

  /**
   * 当前是否处于「重建收尾、要挡掉 markmap 淡入」的窗口。
   *
   * 三种情况：
   * - 重建中（`setData` 内部那几帧就是元凶，必须算在内）；
   * - 重建刚结束的一小段时间（d3 的过渡可能晚一帧才写）；
   * - **编辑态除外**：编辑期间不该去改 markmap 的属性。
   *   注意编辑框藏原文用的是 `visibility` 而**不是** opacity（见 edit/inlineText.ts）——
   *   用 opacity 会被下面的 faded 通道当成「淡出中」，把卡片和连线一起抄成透明，
   *   编辑时整块图就只剩一个输入框了。
   */
  private inFadeGuard(): boolean {
    if (this.rt.phase === "editing") return false;
    if (this.rt.phase === "rebuilding") return true;
    return this.fadeGuardUntil !== 0 && performance.now() < this.fadeGuardUntil;
  }

  /**
   * 给 markmap 自己那次「收尾重排」压时间。
   *
   * 现场日志里每次 `rebuild.end` 之后 700–800ms 都会冒出一次 `obs.class n=全部节点`
   * ——那是 markmap 在跑 `renderData`（`w.attr("class")` 写在每一个节点上）。
   * 它来自构造时挂在**每个节点内容 div** 上的 ResizeObserver：
   * 新节点的 div 是在 `setData` 里才被 observe 的，浏览器布局完成后立刻报一次
   * 尺寸变化，防抖 100ms 后就是一次整树重排。
   *
   * 问题是那时我们早已把 duration 恢复成 180，于是整张图重新动画一遍。
   * `tmp/resizeProbe2.ts`（304 节点，加两个节点后重建）实测：
   *
   * ```
   * [1744.9] rebuild.end          ← 我们画完，duration 已恢复 180
   * [1860.0] renderData#4 start duration=180
   * 位置差异 moved=303/304 max=101.9px
   * ```
   *
   * 也就是说重建结束时画的那一遍是**中间态**，一百毫秒后整张图又滑 100px 到位 ——
   * 用户看到的就是「改完字画面再抖一下」，动到一半的线看着就是「飘线」。
   *
   * 这里把实例的 `renderData` 包一层：落在窗口内就压成 duration 0，跑完立刻补一次
   * 全量绘制（这一遍才是最终布局）。用户手动折叠/展开会先清掉窗口 —— 那种动画
   * 是用户要看的，不能压。
   */
  private attachSettleHook(mm: Markmap): void {
    // 折叠圆点走的是 markmap 自己的 handleClick → this.toggleNode，
    // 命中实例属性，所以包这一层两条入口都能拦住。
    const origToggle = mm.toggleNode.bind(mm);
    const patchedToggle = async (node: never, recursive?: boolean): Promise<void> => {
      this.toggleIntent = true;
      // 用户出手了，收尾窗口立刻作废：否则待会儿那次防抖重排会把折叠动画中途掐断
      this.settleUntil = 0;
      try {
        await origToggle(node, recursive);
      } finally {
        this.toggleIntent = false;
      }
    };
    (mm as unknown as { toggleNode: typeof patchedToggle }).toggleNode = patchedToggle;

    const origRender = mm.renderData.bind(mm);
    const patchedRender = async (target?: INode): Promise<void> => {
      // **每一次** renderData 都要留痕。
      //
      // 原来只记 `settle.pass` / `settle.catch` 这两种结果，于是「日志里整棵树动了一次、
      // 却没有对应的 settle 行」这种情况无法解释 —— 只能猜「是不是别的路径写的 transform」。
      // 现在入口无条件记一行：dur=此刻的 duration（0 表示调用方自己就要求瞬间到位）、
      // arg=折叠时传进来的那个节点（整树重排时为空）、from=调用来源。
      // 判据：看到一批 transform 写入，就在它之前找 `render.enter`；找不到 → 那次写入
      // 来自**更早创建的那条过渡**（去 `tr.create` 里按 dur 与 n 对号）。
      if (isTracing()) {
        const t = target as (INode & { state?: { path?: string } }) | undefined;
        // traceLog("render.enter", {
        //   dur: mm.options.duration,
        //   phase: this.rt.phase,
        //   left: Math.round(this.settleUntil - performance.now()),
        //   arg: t?.state?.path ?? "-",
        //   from: callerOf(),
        // });
      }
      // 重建期间照原样跑（applyTree 已经把 duration 置 0，这里再包一层会打架）；
      // duration 已经是 0 说明调用方自己就是按「瞬间到位」来的（reflowNow），
      // 这时**不要消费窗口** —— 后面 markmap 自己那次防抖重排才是要拦的对象。
      //
      // 这里**必须包含 `editing`**。原来只放行 `idle`，于是「打开编辑框之后
      // markmap 自己那次防抖重排」永远漏网：现场日志里那条
      // `settle.pass dur=180 phase=editing left=453` 就是它 —— 250 个节点一起
      // 播 180ms 位移，用户看到的就是「一进编辑（或改完字）整张图滑一下」。
      // 编辑态下更该压平：这期间屏幕上有一个浮层输入框贴着某张卡片，
      // 底下的图一动，输入框就得跟着重贴位置，看起来就是抖。
      const inWindow: boolean =
        this.rt.phase !== "rebuilding" &&
        this.toggleIntent === false &&
        mm.options.duration !== 0 &&
        performance.now() < this.settleUntil;
      if (!inWindow) {
        // 没拦下来的每一次整树重排都会重写全部 transform。位置若和重建时不同，
        // 屏幕上就是「整张图又滑一下」——但只看事件流分不清它是谁叫的：
        // dur=0 说明别的路径已经把它压成瞬间了；dur=180 才是真正漏掉的动画。
        // 现场日志里重建后 230–425ms 必有一次「252 个节点全动」，
        // 而它前后都没有 settle.catch，就是在这里留痕的。
        // traceLog("settle.pass", {
        //   dur: mm.options.duration,
        //   phase: this.rt.phase,
        //   left: Math.round(this.settleUntil - performance.now()),
        //   // 取栈很贵，只有真在记录时才做
        //   from: isTracing() ? callerOf() : undefined,
        // });
        return origRender();
      }

      this.settleUntil = 0;
      const prev: number = mm.options.duration;
      // traceLog("settle.catch", { duration: prev });
      mm.setOptions({ duration: 0 });
      try {
        await origRender();
      } finally {
        mm.setOptions({ duration: prev });
      }
      if (this.rt.phase === "rebuilding") return;
      // 位置在下一 tick 才写进 transform（d3 的 0ms 过渡也异步），
      // 这里先排一次全量：observer 的 transform 通道会同步补连线，这一遍兜尺寸与收放点。
      // 编辑态也排：这一遍现在几乎不写属性（缓存按 g 身份保留），
      // 但能把「重排后卡片尺寸变了」的那一个节点补正。
      this.frames.requestAll();
    };
    (mm as unknown as { renderData: typeof patchedRender }).renderData = patchedRender;

    // 再包一层 `transition(sel)`：markmap 里**所有**会写 transform / 半径 / 位置的地方
    // 都经过它（`renderData` 里 10 处，`fit`/`ensureVisible` 也走它）。
    // 记下「谁在什么时候创建了一条多大的过渡、当时 duration 是多少」，
    // 才能在日志里解释「这批 transform 是谁写的」——尤其是那些**创建得很早、
    // 落地得很晚**的过渡（它们的写入发生在 creation + duration 之后，
    // 现场会表现为「重建结束 260ms 后整树又动一下，却没有 render.enter」）。
    const withTransition = mm as unknown as { transition?: (sel: unknown) => unknown };
    const origTransition = withTransition.transition?.bind(mm);
    if (typeof origTransition === "function") {
      withTransition.transition = function tracedTransition(sel: unknown): unknown {
        if (isTracing()) {
          const sized = sel as { size?: () => number };
          // traceLog("tr.create", {
          //   dur: mm.options.duration,
          //   n: typeof sized.size === "function" ? sized.size() : -1,
          //   from: callerOf(),
          // });
        }
        return origTransition(sel);
      };
    }
  }

  /**
   * 监听导图的布局变化，并按变化类型分流。
   *
   * **只听 transform，不听 width/height**。实测（257 节点、折叠一帧动画）：
   * markmap 每帧都会把全部节点的 foreignObject 宽高重写一遍（257×2 条记录/帧），
   * 而值根本没变。听它就等于每帧判定「尺寸变了」→ 全量重绘，
   * 上千节点时折叠/展开必然掉帧。而内容尺寸真正变化的场景只有「原地改字」，
   * 那条路径（applyPatch）自己会请求全量重绘，不需要观察器兜底。
   *
   * - childList（节点增删，折叠展开也会触发）→ 全量绘制；
   * - 节点 g 的 transform（折叠动画里每帧都在变）→ 只刷连线。
   *
   * 卡片画在节点局部坐标里，与 transform 无关，所以动画期间一次都不用重写；
   * 只有跨节点的连线需要重算起终点。
   *
   * 刻意排除外层 g 的 transform：滚轮缩放/平移改的是那一层，
   * 节点局部坐标没变，重绘纯属浪费（这是缩放抖动的主因）。
   */
  private observeLayout(svg: SVGSVGElement): void {
    this.observer?.disconnect();
    this.observer = new MutationObserver((records: MutationRecord[]) =>
      this.handleMutations(records),
    );
    this.observer.observe(svg, OBSERVE_OPTIONS);
  }

  /**
   * 观察器的回调体（单独抽成方法，是为了能被 `raiseNodes` 手动调用一次 ——
   * 见那里的注释：提层前先把积压的记录消化掉，不能直接丢掉）。
   */
  private handleMutations(records: MutationRecord[]): void {
    let structural = false;
    const moved = new Set<SVGGElement>();
    /**
     * 文字层宽高真的变了的节点。
     *
     * 和 `moved` 分开是因为**它们往往不重叠**：改一段文字让卡片往右长，
     * 节点坐标一点没动（transform 同值被过滤），线也不用重画，只有卡片尺寸要跟上。
     * 混进 `moved` 会让 `obs.transform` 的 jump 统计失真。
     */
    const resized = new Set<SVGGElement>();
    /** markmap 重写 class 的节点（选中 class 会被它原地抹掉） */
    const recls = new Set<SVGGElement>();
    /** foreignObject 透明度变了的节点 g（淡入淡出，要跟着一起淡） */
    const faded = new Set<SVGGElement>();
    /**
     * 本批「文字层透明度被改」的明细（`节点 old→new`）。
     *
     * 这是「闪烁」最直接的证据：重建本该瞬间到位（duration 0），
     * 若日志里出现 `0.42→0.58` 这种斜坡，就说明有一条过渡没被挡掉、
     * 而我们的卡片正在跟着它一起透明。
     */
    const fades: string[] = [];
    /** 本批被 fadeGuard 当场抹掉的次数（正常应该覆盖所有 <1 的写入） */
    let guardStrips = 0;
    /** 本批「非装饰」childList 记录数：>0 就是真结构变化 */
    let childRecords = 0;
    /** 本批里单个节点的最大位移（px）：只用来记日志，回答「画面到底跳了多少」 */
    let jumpPx = 0;

    for (const rec of records) {
      if (rec.type === "childList") {
        // 我们自己往节点 g 里插卡片/阴影/连线也会产生 childList。那不是
        // 结构变化 —— 若当成结构变化，每次首次绘制都会再触发一次全量重绘，
        // 折叠动画一开始就凭空多跑一遍。
        //
        // 卡片里那段文字（foreignObject 内部）重新渲染也不是结构变化：
        // 节点的增删只会落在 `<g>` 上，落不到 fo 里面去。见 isContentChurn。
        if (!isOwnDecoration(rec) && !isContentChurn(rec)) {
          structural = true;
          childRecords++;
        }
        continue;
      }

      const target = rec.target;

      // 文字层（foreignObject）的宽高：卡片尺寸唯一的输入源。
      // 只比值 —— markmap 每次 renderData 都会把 250 个节点的 width/height
      // 无条件重写一遍，同值的那批必须直接丢掉，否则每次重排都是一次全量重绘。
      if (rec.attributeName === "width" || rec.attributeName === "height") {
        if (
          target instanceof SVGForeignObjectElement &&
          target.getAttribute(rec.attributeName) !== rec.oldValue
        ) {
          const parent = target.parentElement;
          if (parent instanceof SVGGElement && parent.classList.contains("markmap-node")) {
            resized.add(parent);
          }
        }
        continue;
      }

      // markmap 的 renderData 里有一句 `w.attr("class", ...)` —— 它把每个节点的
      // class 重写一遍。**内存里的选中态不会变**，但 DOM 上的 obmind-selected
      // 被抹掉了，表现就是「编辑完（或过一会儿）选中框自己没了」，
      // 而 selectedLine 还指着那一行：再按 Tab 会凭空多出一个子级。
      // 它每次重排都会触发（内容尺寸变化 → 它自己的 ResizeObserver → 100ms 后重排），
      // 所以必须当成事件来跟，不能只在重建后补一次。
      if (rec.attributeName === "class") {
        if (target instanceof SVGGElement && target.classList.contains("markmap-node")) {
          recls.add(target);
        }
        continue;
      }

      // 节点内文字的透明度：markmap 折叠/展开时每帧写一次。
      // 我们的卡片/连线/收放点是自绘的，得跟着它一起淡，否则「字淡没了、方块还在飞」。
      if (rec.attributeName === "style") {
        const parent = target.parentElement;
        if (
          target instanceof SVGForeignObjectElement &&
          parent instanceof SVGGElement &&
          parent.classList.contains("markmap-node")
        ) {
          // 重建收尾这一小段里，< 1 的 opacity 是 d3 的 enter 过渡（不是折叠动画）。
          // duration 0 的重建本该瞬间到位，可过渡仍然异步到下一帧 —— 那一帧画出来
          // 就是「新建节点时整排兄弟卡片没字」。这里当场抹掉，赶在绘制之前。
          if (this.inFadeGuard() && target.style.opacity !== "") {
            target.style.opacity = "";
            guardStrips++;
            continue;
          }
          // style 里改的不一定是 opacity：编辑器打开时那层 `visibility: hidden`
          // 也走这条分支（见 edit/inlineText.ts）。那种改动跟淡入淡出无关，
          // 混进来会在日志里留下一条 `obs.fade 节点 -->-` 的假证据 ——
          // 上一份现场日志里三条 obs.fade 全是它，白让人怀疑「谁把文字弄透明了」。
          const before: string = styleOpacityOf(rec.oldValue);
          const after: string = target.style.opacity === "" ? "-" : target.style.opacity;
          if (before === after) continue;
          faded.add(parent);
          // 只留少量明细：折叠动画一秒几百条，全记会把有用的行冲掉
          if (fades.length < 6) {
            fades.push(`${nodeLabel(parent)} ${before}->${after}`);
          }
        }
        continue;
      }

      if (
        !(target instanceof SVGGElement) ||
        !target.classList.contains("markmap-node")
      ) {
        continue;
      }
      // markmap 的 `renderData` 会**无条件**把每个节点的 transform 重写一遍
      // （走 selectAll.merge 的 transition），值往往一模一样；折叠动画里更是
      // 每帧写一遍。同值重写不是「动了」——放进去就等于每帧重画几百条
      // 一模一样的连线，而日志里的 n 也永远是全量，看不出「真挪了几个」。
      if (rec.oldValue !== null) {
        const raw = target.getAttribute("transform");
        if (raw === rec.oldValue) continue;
        // 位移差就是「这一批画面真实挪了多少像素」——闪烁的量化证据
        const from = translateOf(rec.oldValue);
        const to = translateOf(raw);
        if (from && to) {
          const d: number = Math.hypot(to.x - from.x, to.y - from.y);
          if (d > jumpPx) jumpPx = d;
        }
      }
      moved.add(target);
    }

    if (structural) {
      // 结构变化那一批里通常**同时**有一堆 transform 变化（新节点 enter 前后，
      // 兄弟整列让位）。只 requestAll 的话，全量绘制要等到下一帧 ——
      // 中间这一帧屏幕上就是「卡片已经到新位置、线还停在旧位置」。
      // 先把这一批同步补一遍（成本只和本批节点数成正比），再让全量兜尺寸与收放点。
      if (moved.size > 0) this.frames.paintMoved(moved);
      this.frames.requestAll();
      // jump / dt 是这一批最要紧的两个数：
      // - jump：本批单点最大位移（px）。重建之后 300ms 又冒出 jump=100 就是「图又跳了一下」；
      // - dt：距上次重建结束多少毫秒。同一个 jump 在重建当帧出现是正常的落位，
      //   在 +400ms 出现才是有人又重排了一遍。
      // traceLog("obs.structural", {
      //   recs: records.length,
      //   child: childRecords,
      //   moved: moved.size,
      //   jump: Math.round(jumpPx),
      //   dt: Math.round(performance.now() - this.rebuildEndAt),
      // });
    } else if (moved.size > 0) {
      // 同步重绘，不走 rAF：d3 刚在这一帧的 rAF 回调里写完 transform，
      // MutationObserver 回调紧跟着在微任务里跑 —— 此刻重画连线仍是同一帧，
      // 线和节点一起落位。排到下一个 rAF 就会晚一帧，动画里看着线在追节点。
      this.frames.paintMoved(moved);
      // 折叠动画里每帧一批；限流到 100ms 一条，用来回答「什么时候又有一大批节点在动」
      // ——改字重排完之后若还冒出一批，就是 markmap 自己那个 100ms 防抖重排又跑了一遍。
      // jump = 这一批里单个节点最大位移（px）：>50 且出现在 rebuild 之后 = 画面又整体跳了一下。
      // traceLogEvery("transform", 100, "obs.transform", {
      //   n: moved.size,
      //   jump: Math.round(jumpPx),
      // });
    }
    // 只变宽变高、位置没动的那批：单独补一次增量绘制（每节点只有 8 个属性写）。
    // 不做这一步的后果就是用户截图那张：新文字比旧卡片宽，直接顶出边框，
    // 而且要等到下一次**别的原因**触发全量绘制才会回正。
    if (resized.size > 0 && !structural) {
      this.frames.paintMoved(resized);
      // traceLog("obs.resize", { n: resized.size });
    }
    if (recls.size > 0) {
      this.paintSelectionOn(recls);
      // traceLog("obs.class", { n: recls.size });
    }
    // if (guardStrips > 0) traceLog("guard.strip", { n: guardStrips });
    // 埋点已停用：原来按批量大小分别写 obs.fade / obs.fadeBatch ——
    // 少量时逐条记（「某几个卡片莫名变透明」的可疑现场就是它），成批淡出只记数量。
    // if (faded.size > 0) {
    //   if (faded.size <= 3) { for (const f of fades) traceLog("obs.fade", { node: f }); }
    //   else { traceLog("obs.fadeBatch", { n: faded.size, guard: this.inFadeGuard() }); }
    // }
  }

  /**
   * 把一批节点 g 提到父容器末尾（拖动时用，SVG 没有 z-index）。
   *
   * 两件事必须一起做：
   * 1. 先把**积压**的记录交给 `handleMutations` —— 直接 `disconnect` 会把它们
   *    一起丢掉，那批记录里可能正有「节点动了」，丢了线就停在旧位置；
   * 2. 提层本身产生的 childList 记录必须**吞掉**：每个 `appendChild` 会产生两条
   *    （add=0/rem=1 与 add=1/rem=0，实测），被当成结构变化就会触发一次全图重绘，
   *    而重绘会把拖动块刚刚摘掉的对外线接回来 —— 现场日志 `drag.links n=1`
   *    之后 170ms 冒出 `paint.all boxes=257`，接着整段拖动都带着一根线。
   *
   * 用 `disconnect` + 重新 `observe` 而不是「按 class 猜哪条是我干的」：
   * 回调可能被主线程拖后几百毫秒（日志里 9713 → 9879），那时 class 早被摘掉了，
   * 启发式必然失效。
   */
  private raiseNodes(els: SVGGElement[]): void {
    const parent: Element | null = els[0]?.parentElement ?? null;
    if (!parent) return;
    const ob = this.observer;
    const svg = this.svgEl;
    if (ob) {
      const pending: MutationRecord[] = ob.takeRecords();
      if (pending.length > 0) this.handleMutations(pending);
      ob.disconnect();
    }
    try {
      for (const g of els) parent.appendChild(g);
    } finally {
      if (ob && svg) ob.observe(svg, OBSERVE_OPTIONS);
    }
    // traceLog("drag.raise", { n: els.length });
  }

  /**
   * 监听画布尺寸。
   *
   * 两个职责，以前只做了第一个：
   * 1) 首帧适配的兜底：视图创建时右侧栏还在滑出、容器尺寸是 0，
   *    fitInstant 会挂起（pendingFit），等这里尺寸真正就绪再补做；
   * 2) **尺寸变化后跟随适配**：侧栏宽度被拖动、窗口缩放、编辑区关掉，
   *    都会让可视区变小/变大。不重新适配的话，内容会整体偏到视口外 ——
   *    看起来就是「打开是空白的」。用户自己缩放/平移过（userView）则不动他。
   */
  private observeSize(el: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      const w: number = el.clientWidth;
      const h: number = el.clientHeight;
      // 尺寸掉到 0（视图被隐藏、侧栏折叠）：标记待适配，
      // 等它重新有尺寸时再补一次，否则切回来还是一张缩成点的图
      if (w < MIN_VIEWPORT || h < MIN_VIEWPORT) {
        this.pendingFit = true;
        return;
      }
      if (this.pendingFit) {
        void this.fitInstant();
        return;
      }
      if (this.rt.phase === "editing") this.editorHandle?.reposition();
      if (!this.userView) this.requestAutoFit(w, h);
    });
    this.resizeObserver.observe(el);
  }

  /**
   * 尺寸变化后安排一次适配（去抖）。
   *
   * 侧栏滑出/收起是 200ms 左右的过渡，ResizeObserver 会在过渡期间回调十几帧。
   * 每帧都 fit 一遍纯属浪费，而且会把 markmap 的 zoom 反复重置。等它停下来再适配。
   */
  private requestAutoFit(w: number, h: number): void {
    const prev = this.fittedSize;
    if (prev && Math.abs(prev.w - w) < 4 && Math.abs(prev.h - h) < 4) return;
    if (this.autoFitTimer !== 0) return;
    this.autoFitTimer = window.setTimeout(() => {
      this.autoFitTimer = 0;
      void this.fitInstant();
    }, 140);
  }

  /** 供插件在激活视图时指定要展示的笔记 */
  setTargetFile(file: TFile | null): void {
    // 从 ribbon / 命令重新打开导图 = 明确要求看「当前笔记」，
    // 结束之前的导图内导航，否则会继续停在栈顶那篇上。
    // 这时把导航过程中新开的笔记标签一并收掉：那次「潜入」已经结束了。
    if (this.navStack.length > 0) {
      this.closeTracked(this.navStack);
      this.navStack = [];
      this.renderBreadcrumb();
    }
    // 同理，钉住也一起解除：命令的名字就是「打开**当前笔记**的导图」，
    // 钉着不动会让这条命令看起来失效。
    this.setPinned(false, true);
    if (file && file.extension === "md") this.targetFile = file;
  }

  /**
   * 开关「钉住」。
   *
   * 只改状态和按钮，**自己不触发重绘**：解除钉住往往发生在 refresh 内部
   * （目标文件被删那一路），在那里再调一次 refresh 会原地递归。
   * 请调用方在需要立刻重画时自己 refresh。
   *
   * silent 用于非用户主动触发的解除（文件被删、命令重新打开视图）：
   * 那些场合弹一句「已取消钉住」只会让人莫名其妙。
   */
  private setPinned(on: boolean, silent = false): void {
    if (this.pinned === on) {
      this.syncPinButton();
      return;
    }
    this.pinned = on;
    this.syncPinButton();

    if (on) {
      const name: string = this.targetFile?.basename ?? "当前笔记";
      new Notice(
        `obmind：已钉住「${name}」，切换笔记时这张图保持不动（点双链只切笔记）`,
        4000,
      );
      return;
    }

    // 解除钉住 = 重新跟随。栈里可能还停着一篇「潜入」的子笔记，
    // 不清掉的话导图会继续显示它，看起来像没解除成功。
    if (this.navStack.length > 0) this.resetNav();
    if (!silent) new Notice("obmind：已取消钉住，导图重新跟随笔记", 3000);
  }

  /** 工具栏上点钉住 */
  private togglePin(): void {
    if (this.pinned) {
      this.setPinned(false);
      this.refresh();
      return;
    }
    if (!this.targetFile) {
      new Notice("obmind：当前没有可钉住的笔记");
      return;
    }
    this.setPinned(true);
  }

  /** 钉住期间该显示哪篇；目标没了就自动解除，免得钉在一片空白上 */
  private pinnedTarget(): TFile | null {
    const file: TFile | null = this.targetFile;
    if (file && this.app.vault.getAbstractFileByPath(file.path)) return file;
    this.setPinned(false, true);
    return null;
  }

  private syncPinButton(): void {
    const t = this.toolbar;
    if (!t) return;
    t.setActive(
      "pin",
      this.pinned,
      this.pinned ? "已钉住（点击恢复跟随笔记）" : "钉住当前导图，切换笔记时不变",
    );
    t.setEnabled("pin", this.mm !== null || this.targetFile !== null);
  }

  /**
   * 结束一次导图内导航：清栈。
   *
   * 只丢映射、**不**关标签 —— 用户已经在别处切走了，那些标签现在归他管。
   */
  private resetNav(): void {
    if (this.navStack.length === 0) return;
    this.navStack = [];
    this.leafById.clear();
    this.renderBreadcrumb();
  }

  /** 当前生效的联动策略（配置缺失或非法值时退回默认档） */
  private navSync(): NavSyncMode {
    return normalizeNavSync(this.plugin.settings.navSync);
  }

  private async onThemeChange(theme: MindmapTheme): Promise<void> {
    this.plugin.settings.theme = theme;
    await this.plugin.saveSettings();
    this.refresh();
  }

  /** 主题按钮的提示要跟着当前主题变，否则用户看不出现在是哪套 */
  private syncThemeButton(): void {
    const btn = this.themeBtn;
    if (!btn) return;
    const current: MindmapTheme = this.plugin.settings.theme;
    const label: string = THEME_OPTIONS.find((o) => o.value === current)?.label ?? "主题";
    btn.setAttribute("aria-label", `主题：${label}`);
    // 「跟随外观」时图标压暗一档：表示这一步没有手动覆盖
    btn.toggleClass("is-overridden", current !== "follow");
  }

  private openThemeMenu(anchor: HTMLElement): void {
    const rect: DOMRect = anchor.getBoundingClientRect();
    const menu = new Menu();
    for (const opt of THEME_OPTIONS) {
      menu.addItem((item) => {
        item
          .setTitle(opt.label)
          .setChecked(this.plugin.settings.theme === opt.value)
          .onClick(() => void this.onThemeChange(opt.value));
      });
    }
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  /**
   * 算出「一级分支 → 色板槽位」。**必须在 setData 之前**调用：
   * markmap 的 color 回调是在 render 里同步取色的，那时还没有节点 DOM，
   * 只能从树的孩子顺序推 path（根是 "0"，第 i 个一级分支就是 "0.i"）。
   *
   * 用分支名而不是序号做 key，是为了「插一行 / 删一行」时不跳色 ——
   * 序号会整体平移，名字不会。细节见 render/colors.ts。
   */
  private syncBranchSlots(tree: IPureNode, size: number): void {
    const children: readonly IPureNode[] = tree.children ?? [];
    const seen = new Map<string, number>();
    const keys: string[] = children.map((child: IPureNode) => {
      // 根级的块：content 是 MarkdownRenderer 渲染出来的 HTML，拿它当分支名的话
      // 同一段代码换个主题/换次渲染就会变，色槽跟着满屏跳。
      const block = (child.payload as { block?: { kind: string } } | undefined)?.block;
      const base: string = block ? `\u0000block:${block.kind}` : branchKey(child.content ?? "");
      const n: number = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      // 同名分支（例如两个「其他」）必须分开，否则它们会共用一个颜色
      return n === 0 ? base : `${base}\u0000${n}`;
    });

    const slots: Map<string, number> = this.branchColors.sync(keys, size);
    this.branchSlots.clear();
    keys.forEach((key: string, i: number) => {
      const slot: number | undefined = slots.get(key);
      if (slot !== undefined) this.branchSlots.set(`0.${i}`, slot);
    });
  }

  /** path → 色板槽位；表里没有（刚新建、还没重建）时按 path 哈希兜底 */
  private branchSlot(path: string, size: number): number {
    const branch: string = branchPathOf(path);
    const slot: number | undefined = this.branchSlots.get(branch);
    if (slot !== undefined) return slot;
    return hash32(branch) % Math.max(1, size);
  }

  // -------------------------------------------------------------------------
  // 操作栏
  // -------------------------------------------------------------------------

  /** 操作栏的唯一分发点：按钮只报 id，具体做什么集中在这里 */
  private onToolbar(id: ToolbarActionId): void {
    switch (id) {
      case "pin":
        this.togglePin();
        break;
      case "undo":
        void this.stepHistory("undo");
        break;
      case "redo":
        void this.stepHistory("redo");
        break;
      case "collapseAll":
        this.setAllFolds(true);
        break;
      case "expandAll":
        this.setAllFolds(false);
        break;
      case "fit":
        this.fitView();
        break;
      case "refresh":
        // 手点刷新 = 明确要求忽略缓存，作废快照强制重建
        this.snapshot = null;
        this.refresh();
        break;
      case "export":
        void this.exportSvg();
        break;
      case "deselect":
        this.applySelection([], -1, false);
        break;
      case "edit":
        this.editSelected();
        break;
      case "child":
      case "sibling":
        this.createNode(id);
        break;
      case "outdent":
        this.outdentSelected();
        break;
      case "newNote":
        void this.createNoteForSelected();
        break;
      case "block":
        this.openBlockMenu();
        break;
      case "delete":
        this.removeNode();
        break;
      case "help":
        this.toggleHelp();
        break;
    }
  }

  /**
   * 同步按钮可用态。
   *
   * 集中在这一处而不是散在各操作里：按钮该不该点亮只取决于「有没有选中节点」
   * 「能不能撤销」这两三个状态，散着写必然出现「删完了删除键还是亮的」这类不同步。
   *
   * 节点操作现在在浮动条上，可用态跟着它一起走 —— 没有选中节点时浮动条本身就
   * 不出现，所以那排灰按钮的问题不存在了。
   */
  /**
   * 操作栏尾端的规模统计。
   *
   * 只在文案真的变了才写 DOM：这个方法在每次 refresh 都会跑（包括「只是移动
   * 光标」的空转刷新），无脑 setText 会让工具条每秒重排好几次。
   */
  private syncStats(tree: IPureNode | null): void {
    const el = this.statsEl;
    if (!el) return;
    const text: string = tree ? formatStats(treeStats(tree)) : "";
    if (el.textContent === text) return;
    el.setText(text);
    el.toggleClass("is-empty", text === "");
  }

  private syncToolbar(): void {
    const src: SrcRef | null = this.nodeAt(this.selectedLine);
    // 根节点就是文件名本身：改不了、删不了、也无所谓缩进
    const onNode: boolean = src !== null && src.depth > 0;
    const onAny: boolean = src !== null;
    // 块（代码 / 公式 / 表格 / 引用）是只读叶子：文字不能改、下面不能挂节点。
    // 唯一说得通的操作是删除 —— 在图里想删掉一段代码是很自然的诉求。
    const onBlock: boolean = src?.blockNode !== undefined;

    const bar = this.nodeBar;
    if (bar) {
      bar.setEnabled("edit", onNode && !onBlock);
      bar.setEnabled("child", onAny && !onBlock);
      bar.setEnabled("sibling", onAny && !onBlock);
      bar.setEnabled("outdent", onNode && !onBlock);
      bar.setEnabled("delete", onNode);
      // 插入块也是「从这一行长出东西」，多选时没有唯一宿主，只能单选
      bar.setEnabled("block", onAny && !onBlock && this.selectedLines.size === 1);
      // 「新建笔记」不是置灰而是隐藏：节点已经有双链时它没有任何意义，
      // 留一个灰图标在那儿，用户只会反复点它试为什么点不动（见 canCreateNoteFor）
      bar.setHidden("newNote", !this.canCreateNoteFor(src));
    }

    const t = this.toolbar;
    if (!t) return;
    t.setEnabled("undo", canUndo(this.history));
    t.setEnabled("redo", canRedo(this.history));
    const ready: boolean = this.mm !== null;
    this.syncPinButton();
    t.setEnabled("fit", ready);
    t.setEnabled("collapseAll", ready);
    t.setEnabled("expandAll", ready);
    t.setEnabled("refresh", ready);
  }

  /**
   * 判断这个节点该不该露出「新建笔记」入口。
   *
   * 判据是「有没有必要」而不是「能不能写回」：
   * - 已经有双链的节点，点了也是白点；
   * - 多行节点（软换行）写回只改首行，会把节点拆坏 —— 编辑也不允许改它；
   * - 根节点就是这篇笔记自己，给它再建一篇同名笔记没有意义。
   */
  private canCreateNoteFor(src: SrcRef | null): boolean {
    if (!src) return false;
    if (this.selectedLines.size !== 1) return false;
    if (src.depth === 0) return false;
    if (src.blockNode) return false;
    if (src.endLine > src.line) return false;
    if (hasWikiLink(src.text)) return false;
    return noteTitleOf(src.text) !== "";
  }

  /** 当前行号对应的节点坐标（不动 EditService，视图侧只需只读查询） */
  private nodeAt(line: number): SrcRef | null {
    if (line < 0) return null;
    const nodes = this.snapshot?.nodes;
    if (!nodes) return null;
    return nodes.find((n) => n.line === line) ?? null;
  }

  /** 编辑选中节点（操作栏的铅笔按钮） */
  private editSelected(): void {
    const node = this.findNodeByLine(this.selectedLine);
    if (node) this.startEdit(node);
  }

  /**
   * 提升一级（Shift+Tab / 操作栏）。
   *
   * 复用 EditService 的 outdent：它已经在用例里覆盖了「已在最外层」
   * 「制表符与空格的缩进单位」这些边界，画布上没必要再写一遍。
   */
  private outdentSelected(): void {
    const file = this.targetFile;
    const snap = this.editSnapshot();
    const src = this.nodeAt(this.selectedLine);
    if (!file || !snap || !src) {
      this.syncToolbar();
      return;
    }
    if (src.blockNode) {
      new Notice("obmind：块是只读的，不能改层级");
      return;
    }

    const out = this.editSvc.commit({
      snap,
      src,
      action: "outdent",
      value: this.editorValueOf(src),
    });
    if (out.kind === "error" || out.kind === "none") {
      // 明确点了按钮就得有反馈：没反应最难判断
      new Notice(`obmind：${out.reason}`);
      return;
    }
    void this.applyPlan(file, out.op);
  }

  /**
   * 给选中节点新建一篇笔记，并把这个节点改成指向它的双链（Ctrl+N / 浮动条）。
   *
   * 五步，顺序不能换：
   * 1. 取名字：notePlan 的纯函数去掉行内标记、清掉文件名与双链语法的非法字符；
   * 2. 算落地文件夹：复用 Obsidian 自己的「新建笔记存放位置」设置；
   * 3. 建文件：已有同名笔记就直接用那一篇（撞名失败，不如顺势链过去）；
   * 4. 把节点正文换成 `[[名字]]`（原文带行内样式时用别名形式，字面不变）；
   * 5. openDoc 跳过去 —— 走的是导图内跳转那条路，所以面包屑自动带上
   *    「从哪来」，点第一级就能跳回原来那篇。
   *
   * 公开是为了命令面板：万一 Ctrl+N 被别的插件占了、或者用户改过快捷键表，
   * 还能在「快捷键」设置里给这个动作另绑一个组合。
   */
  async createNoteForSelected(): Promise<void> {
    const file = this.targetFile;
    const src = this.nodeAt(this.primaryLine);
    if (!file || !src) {
      new Notice("obmind：先左键点一下要建笔记的节点");
      return;
    }
    if (!this.canCreateNoteFor(src)) {
      // 按钮已经隐藏了，能走到这儿只有快捷键：说清为什么不做，别静默
      new Notice(
        hasWikiLink(src.text)
          ? "obmind：这个节点已经是双链了"
          : "obmind：这个节点现在不能建笔记（多行节点 / 取不出名字）",
      );
      return;
    }

    const title: string = noteTitleOf(src.text);
    const folder: string = resolveNoteFolder({
      location: this.vaultConfig("newFileLocation"),
      folder: this.vaultConfig("newFileFolderPath"),
      currentPath: file.path,
    });

    // 同名笔记已经有了就不再新建：Obsidian 的双链按名字解析，
    // 库里多出一篇同名笔记，`[[标题]]` 指向哪一篇就变成说不准的事。
    let note: TFile | null = this.app.metadataCache.getFirstLinkpathDest(
      title,
      file.path,
    );
    const reused: boolean = note !== null;
    if (!note) {
      note = await this.createNoteFile(folder, title, file);
      if (!note) return;
    }

    // 先建文件、再改节点：反过来一旦建文件失败，节点上就留了一条连不到东西的红链。
    const raw: string = src.text.trim();
    const link: string = linkLiteral(title, raw === title ? undefined : raw);
    const snap = this.editSnapshot();
    if (snap) {
      const out = this.editSvc.commit({ snap, src, action: "commit", value: link });
      if (out.kind === "write") await this.applyPlan(file, out.op);
      else if (out.kind === "error") {
        new Notice(`obmind：${out.reason}`);
        return;
      }
    }

    // 选中集记的是上一篇的行号，换文件之后会指着无关的节点，先清掉
    this.applySelection([], -1, false);

    // 钉住时笔记照常打开，只是导图不跟着换 —— 钉住锁的是「这张图」，
    // 不是「不许看别的笔记」。走 navigate 就自动分好叉。
    this.navigate(note);
    new Notice(
      `obmind：已${reused ? "链接到已有笔记" : "新建笔记"}「${title}」` +
        (this.pinned ? "（导图保持钉住）" : ""),
    );
  }

  /**
   * 读 Obsidian 自己的库级设置（这里只用「新建笔记的存放位置」两项）。
   *
   * `Vault.getConfig` 运行时一直都在，但没写进公开的 d.ts —— 所以按可选能力探测：
   * 拿不到就返回空串，resolveNoteFolder 会把空值当成「放库根」，
   * 也就是 Obsidian 的默认行为。降级而不是抛错。
   */
  private vaultConfig(key: string): string {
    const api = this.app.vault as unknown as { getConfig?: (k: string) => unknown };
    const value: unknown = typeof api.getConfig === "function" ? api.getConfig(key) : null;
    return typeof value === "string" ? value : "";
  }

  /**
   * 真正落盘：读模板 → vault.create。
   *
   * 失败只提示不抛：模板路径写错、目标文件夹被删这些都属于配置问题，
   * 用户改一下设置就好，没必要让一次点击以异常栈收场。
   */
  private async createNoteFile(
    folder: string,
    title: string,
    from: TFile,
  ): Promise<TFile | null> {
    const path: string = notePathOf(folder, title);
    const raw: string = await this.readTemplate();
    const content: string =
      raw === "" ? "" : applyTemplate(raw, { title, from: from.basename });
    try {
      return await this.app.vault.create(path, content);
    } catch (err) {
      // 索引还没跟上（刚建的文件、或大小写不同的同名）会走到这儿：
      // 目标确实在就直接复用，比抛一句 “File already exists” 有用
      const exist = this.app.vault.getAbstractFileByPath(path);
      if (exist instanceof TFile) return exist;
      new Notice(`obmind：新建笔记失败：${errText(err)}`);
      return null;
    }
  }

  /** 读模板原文；没配模板 / 文件不在了都返回 ""（= 建一篇空白笔记） */
  private async readTemplate(): Promise<string> {
    const path: string = (this.plugin.settings.noteTemplate ?? "").trim();
    if (path === "") return "";
    const abs: string = /\.md$/i.test(path) ? path : `${path}.md`;
    const file: unknown =
      this.app.vault.getAbstractFileByPath(normalizePath(abs)) ??
      this.app.metadataCache.getFirstLinkpathDest(path, "");
    if (!(file instanceof TFile)) {
      new Notice(`obmind：找不到模板笔记「${path}」，这次新建的是空白笔记`);
      return "";
    }
    try {
      return await this.app.vault.read(file);
    } catch (err) {
      console.error("[obmind] 读取模板失败", err);
      return "";
    }
  }

  /**
   * 「适配」按钮：无条件把内容缩放回可视区。
   *
   * 走 fitInstant 而不是 mm.fit()：
   * - mm.fit() 带 180ms 过渡，点下去要等一下才到位；按钮的语义是「立刻归位」；
   * - 顺带把 userView 清掉 —— 用户主动要求适配，就等于同意重新接受
   *   「跟着容器尺寸自动适配」这件事。
   */
  fitView(): void {
    this.userView = false;
    void this.fitInstant();
  }

  /**
   * 导出当前导图为独立 SVG，写在笔记同目录（同名覆盖）。
   *
   * 三个「不能直接存 outerHTML」的理由见 export/svg.ts 的文件头：
   * 缩放要复位、样式要内联、背景要补上。
   *
   * 用 `viewBox` 而不是当前视口，意味着导出的永远是**整张图**，
   * 和用户此刻缩放到哪儿无关 —— 想只导一部分是另一个功能（截图），
   * 这里给的是可以贴进文档、能二次编辑的矢量图。
   */
  private async exportSvg(): Promise<void> {
    const svg = this.svgEl;
    const mm = this.mm;
    const file = this.resolveTargetFile();
    if (!svg || !mm || !file) {
      new Notice("obmind：没有可导出的导图");
      return;
    }

    // 还没 _relayout 完时 rect 是 0×0，导出来会是个空文件
    const box: ViewBox | null = exportViewBox(mm.state.rect, 28);
    if (!box) {
      new Notice("obmind：导图还没画完，稍等一下再试");
      return;
    }

    let text: string;
    try {
      text = buildSvgText(svg, box, {
        background: this.exportBackground(),
        title: file.basename,
      });
    } catch (err) {
      new Notice(`obmind：导出失败（${errText(err)}）`);
      return;
    }

    const name: string = exportFileName(file.basename);
    const path: string = normalizePath(file.parent?.path ? `${file.parent.path}/${name}` : name);
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      // 同名覆盖而不是加序号：反复导出不该在库里堆一串 mindmap-2/-3
      if (existing instanceof TFile) await this.app.vault.modify(existing, text);
      else await this.app.vault.create(path, text);
    } catch (err) {
      new Notice(`obmind：写入失败（${errText(err)}）`);
      return;
    }
    new Notice(`obmind：已导出 ${path}（${formatSize(text.length)}）`, 5000);
  }

  /**
   * 导出图的底色。
   *
   * 画布自身通常是透明（底色来自 Obsidian 的内容区），要逐级往上找，
   * 否则深色主题导出来的 SVG 是「浅色文字 + 透明底」，丢进白底阅读器就没了。
   */
  private exportBackground(): string {
    const pick = (el: Element | null): string => {
      if (!el) return "";
      const c: string = getComputedStyle(el).backgroundColor;
      return isOpaqueColor(c) ? c : "";
    };
    return (
      pick(this.canvasEl) ||
      pick(this.containerEl.querySelector(".view-content")) ||
      pick(document.body) ||
      "#ffffff"
    );
  }

  /**
   * 全部折叠 / 全部展开。
   *
   * 只改 payload.fold 再把同一棵树灌回 markmap，不重新解析笔记 ——
   * 折叠是纯视图状态，没有理由去碰文件。
   *
   * applyTree 内部 duration=0：两千个节点同时折叠时若带过渡，
   * 会看到几百条线一起飞，反而看不出结构变化。
   */
  setAllFolds(fold: boolean): void {
    const tree = this.snapshot?.tree;
    if (!tree || !this.mm) return;

    let changed = false;
    const walk = (node: IPureNode): void => {
      const kids: IPureNode[] = node.children ?? [];
      if (kids.length === 0) return;
      const folded: boolean =
        typeof node.payload?.fold === "number" && (node.payload.fold as number) > 0;
      if (folded !== fold) {
        node.payload = { ...node.payload, fold: fold ? 1 : 0 };
        changed = true;
      }
      for (const kid of kids) walk(kid);
    };
    walk(tree);
    if (!changed) return;

    // 快照里的树有可能是「patch 通道」留下的那一份：那条路径不重建 DOM，
    // 所以树里块节点还停在解析期的占位。直接灌进去会让所有代码块变成一行标签。
    // 这里补一次渲染（缓存命中，成本≈0）再重建。
    const file = this.targetFile;
    void (async (): Promise<void> => {
      if (file) await this.renderBlocks(tree, file);
      // 选中态与浮动条由 applyTree 自己在重建结束后挂回去
      await this.applyTree(tree);
    })();
  }

  /**
   * 撤销 / 重做一步。
   *
   * 写入用「整篇替换」：历史里存的就是某一时刻的完整内容。
   * expect 用当前快照内容 —— 若用户在编辑器里改过，锚点对不上就整体放弃，
   * 绝不会把别处的改动覆盖掉。
   */
  private async stepHistory(kind: "undo" | "redo"): Promise<void> {
    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return;

    const step = kind === "undo" ? undo(this.history, snap.content) : redo(this.history, snap.content);
    if (!step) {
      this.syncToolbar();
      return;
    }

    const res = await this.runWrite(
      file,
      { kind: "whole", content: step.write, expect: snap.content },
      false,
    );
    if (!res.ok) {
      this.syncToolbar();
      return;
    }
    this.history = step.state;
    // 撤销后行号整体位移，原来的选中已无意义：清掉，免得下一次 Delete 删错节点
    this.selectedLine = -1;
    this.refresh(step.write);
    this.syncToolbar();
  }

  private buildHelpPanel(): void {
    const el = this.helpPanel;
    if (!el) return;
    el.createDiv({ cls: "obmind-help-title", text: "操作与快捷键" });
    for (const [keys, text] of HELP_ROWS) {
      const row = el.createDiv({ cls: "obmind-help-row" });
      row.createSpan({ cls: "obmind-help-key", text: keys });
      row.createSpan({ text });
    }
  }

  private toggleHelp(): void {
    const el = this.helpPanel;
    if (!el) return;
    el.toggleClass("is-hidden", !el.hasClass("is-hidden"));
  }

  /**
   * 解析当前应该渲染哪篇笔记。
   * 不能只依赖 getActiveViewOfType(MarkdownView)——用户点导图视图里的下拉框时，
   * 活跃视图就是导图自身，那样会拿不到笔记而中断刷新（之前“切换主题无效”的根因）。
   */
  private resolveTargetFile(): TFile | null {
    // 面包屑导航中：导图显示栈顶那篇，不跟随编辑器。
    // 「复用当前视图」就是靠这一句实现的 —— 不碰 Obsidian 的 leaf。
    const pinned: TFile | null = this.pinnedFile();
    if (pinned) {
      this.targetFile = pinned;
      return pinned;
    }

    // 钉住了就完全不看活动笔记：用户就是想在切来切去的时候一直看这张图
    if (this.pinned) {
      const kept: TFile | null = this.pinnedTarget();
      if (kept) {
        this.targetFile = kept;
        return kept;
      }
      // 目标没了 → 已经自动解除钉住，往下走正常流程
    }

    const activeFile: TFile | null = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      this.targetFile = activeFile;
      return activeFile;
    }
    if (this.targetFile && this.app.vault.getAbstractFileByPath(this.targetFile.path)) {
      return this.targetFile;
    }
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        this.targetFile = view.file;
        return view.file;
      }
    }
    return null;
  }

  /** 取笔记正文。
   *
   * 优先用「正打开这篇笔记的编辑器」里的实时内容。注意不能只看活跃视图：
   * 用户拖导图时活跃视图是导图自己，`getActiveViewOfType(MarkdownView)` 返回 null，
   * 于是退回 cachedRead —— 而刚通过 editor.transaction 写进编辑器缓冲的内容
   * 还没被 Obsidian 自动保存到磁盘，读回来是旧的，内容比对就判「没变化」直接短路，
   * 表现为「文件明明变了，导图要手动刷新才更新」。
   *
   * 没有编辑器时用 vault.read（不走缓存）：写完之后读缓存同样可能拿到旧数据。
   */
  private async readContent(file: TFile): Promise<string> {
    const editor = findEditor(this.app, file);
    if (editor) return editor.getValue();
    return this.app.vault.read(file);
  }

  /**
   * 画布空态提示。
   *
   * 只在「没有可显示的笔记」时出现。以前这种情况直接 return，画布是一片空白，
   * 用户无法区分「没渲染」「渲染了但跑到视口外」「渲染器挂了」三种情况。
   */
  private showEmpty(text: string): void {
    const canvas = this.canvasEl;
    if (!canvas) return;
    if (!this.emptyEl) this.emptyEl = canvas.createDiv({ cls: "obmind-empty" });
    this.emptyEl.setText(text);
    this.emptyEl.show();
    // 没有导图就没有规模可言，右下角挂着一个旧数字只会误导
    this.syncStats(null);
  }

  private clearEmpty(): void {
    this.emptyEl?.hide();
  }

  /** 把主题应用到画布与 svg 上（背景、CSS 变量、卡片开关） */
  private applyTheme(spec: ThemeSpec): void {
    const changed = !this.currentSpec || this.currentSpec.id !== spec.id ||
      this.currentSpec.dark !== spec.dark;
    this.currentSpec = spec;
    if (!changed) return;

    this.containerEl.classList.toggle("markmap-dark", spec.dark);
    if (this.canvasEl) {
      this.canvasEl.style.background = spec.bg;
      this.canvasEl.classList.toggle("obmind-card", spec.card);
      this.canvasEl.style.setProperty("--obmind-link-width", String(spec.linkWidth));
    }
    const style = this.svgEl?.style;
    if (!style) return;
    style.setProperty("--markmap-text-color", spec.nodeText);
    style.setProperty("--markmap-circle-open-bg", spec.circle);
    style.setProperty("--markmap-a-color", spec.colors[0]);
    style.setProperty("--markmap-a-hover-color", spec.colors[1] ?? spec.colors[0]);
    style.setProperty("--markmap-font", "400 14px/20px var(--font-interface, sans-serif)");
  }

  private buildOptions(spec: ThemeSpec): MarkmapOptions {
    return {
      // 连线与折叠圆点的颜色：根节点用强调色，其余跟随所属一级分支
      color: (node: INode): string => {
        if (!node.state || node.state.depth === 0) return spec.rootBg;
        return spec.colors[this.branchSlot(node.state.path, spec.colors.length)];
      },
      paddingX: 6,
      spacingHorizontal: 64,
      // 卡片上下各外扩 5px，垂直间距留够，否则相邻卡片视觉上会粘在一起
      spacingVertical: 16,
      duration: 180,
      maxWidth: spec.card ? 380 : 640,
      // 关键：必须关掉 markmap 的自动适配。
      // 它每次 render 结尾都会 fit（折叠/展开也算一次 render），
      // 而 fit 本身是 180ms 的缩放+平移动画——点一下圆点整个画布就缩放一次，
      // 既是「收放点抖动」的来源，也是「收起后回到默认缩放级别」的原因。
      // 现在改成只在我们认为该适配的时机手动调 fit（见 fitInstant / 适配按钮）。
      autoFit: false,
      fitRatio: 0.94,
      // 滚轮平移也关掉：markmap 会在 svg 上额外绑一个 `wheel`（handlePan），
      // 而 d3 的缩放处理里有一句 stopImmediatePropagation —— 两套同时存在时
      // 谁生效取决于构造顺序，等于一个薛定谔的滚轮。现在唯一的入口是 onWheel。
      pan: false,
    };
  }

  /**
   * 无动画地把内容缩放适配到窗口。
   *
   * 调用时机：首次打开、切换笔记、容器尺寸变化、点「适配」。
   * 打字编辑时不调用，用户当前缩放/位置保持不变。
   *
   * 这里比「调一次 mm.fit()」多做了三件事，都是为了治「打开偶现空白」：
   *
   * 1) **量 svg，不量 canvas**。markmap 的 fit 用的是
   *    `svg.getBoundingClientRect()`，我们却拿 canvas 的 clientWidth 判就绪。
   *    两者在 flex 布局里不是同一时刻就绪的（svg 是 100%/100% 的块级子元素，
   *    要等父级定宽高之后才有尺寸），判据错位就会在 svg 还是 0 的时候去 fit，
   *    算出 scale = 0，整张图缩成一个点 —— 屏幕上就是空白。
   *
   * 2) **等尺寸稳定**。侧栏滑出是 200ms 过渡，中途会读到 60px 这种中间值。
   *    在中间值上 fit，scale 按 60px 算出来极小，等容器长到 400px 就再也没有
   *    人去重算 —— 于是图一直是一个缩在角落的小点。要求连续两帧尺寸一致才动手。
   *
   * 3) **fit 完自检**。fit 之后读一次实际缩放比例，如果小到只剩个点
   *    （说明那一刻 markmap 的包围盒还没算出来，或者视口又被改了），
   *    就把 pendingFit 置回 true 再排一次重试，而不是把空白留在屏幕上。
   */
  private async fitInstant(tries = 0): Promise<void> {
    const mm = this.mm;
    const el = this.svgEl;
    if (!mm || !el) {
      // 视图已经关掉：顺手把标记清干净，别留一个永远等不到补做的 pendingFit
      this.pendingFit = false;
      return;
    }

    const token: number = ++this.fitToken;
    const size = await this.stableViewport(el, mm, token);
    // 等待期间视图被重建 / 有更新的适配请求：这一轮作废
    if (this.mm !== mm || this.svgEl !== el || token !== this.fitToken) return;

    if (!size) {
      this.pendingFit = true;
      this.scheduleFitRetry(tries);
      return;
    }

    this.pendingFit = false;
    const prev: number = mm.options.duration;
    mm.setOptions({ duration: 0 });
    try {
      await mm.fit();
    } finally {
      mm.setOptions({ duration: prev });
    }
    if (this.mm !== mm || this.svgEl !== el) return;

    // 自检：fit 之后确认「包围盒有效 + 缩放有效」。
    // 判据不用「缩放比例够大」—— 上千节点的图在窄侧栏里 scale 本来就只有 0.02，
    // 那是正确结果不是故障。真正的故障是这两种：
    //   · markmap 的包围盒还是空的（rect 宽高为 0）：内容全堆在原点，看上去一片空白；
    //   · 视口尺寸为 0 时 fit 出来的 scale = 0：整张图缩成一个点。
    if (!this.fitHealthy()) {
      // 包围盒空 / scale 为 0：这一次适配等于把图留在模糊状态，紧接着会重试
      // traceLog("fit.unhealthy", { tries, k: this.zoomScale().toFixed(3) });
      if (tries < 4) {
        this.pendingFit = true;
        this.scheduleFitRetry(tries);
      }
      return;
    }
    this.fittedSize = size;
    // 每次 fit 都会动整张图的缩放：短时间内连续出现多条 = 画面在整体抖
    // traceLog("fit.done", { w: size.w, h: size.h, k: this.zoomScale().toFixed(3), tries });
  }

  /** fit 之后的自检：包围盒非空、缩放比例是有效正数 */
  private fitHealthy(): boolean {
    const mm = this.mm;
    if (!mm) return false;
    const r = mm.state.rect;
    if (!r) return false;
    const w: number = r.x2 - r.x1;
    const h: number = r.y2 - r.y1;
    const k: number = this.zoomScale();
    return w > MIN_CONTENT && h > MIN_CONTENT && Number.isFinite(k) && k > 0;
  }

  /**
   * 等到视口尺寸「既够大、又稳定」再返回。
   *
   * 判定逻辑在 render/viewport.ts（纯函数，可在 Node 里穷举时序）。
   * 这里只负责把它接到真实的 DOM 与 markmap 实例上。
   *
   * @returns 稳定后的尺寸；等不到（仍是 0 或一直抖）返回 null
   */
  private async stableViewport(
    el: SVGSVGElement,
    mm: Markmap,
    token: number,
  ): Promise<{ w: number; h: number } | null> {
    return waitStableSize({
      read: () => {
        const r: DOMRect = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      },
      nextFrame: () => this.nextFrame(),
      // 等待期间视图被重建、或来了更新的适配请求：这一轮作废
      stale: () => this.mm !== mm || this.svgEl !== el || token !== this.fitToken,
      min: MIN_VIEWPORT,
    });
  }

  /** 尺寸一直不达标时，隔一小段时间再试（最多 6 次，约 0.8s） */
  private scheduleFitRetry(tries: number): void {
    if (tries >= 6) return;
    window.setTimeout(() => {
      if (this.pendingFit) void this.fitInstant(tries + 1);
    }, 120);
  }

  /** 当前画布的缩放比例。d3-zoom 把 transform 存在 svg 节点的 __zoom 上 */
  private zoomScale(): number {
    const el = this.svgEl as (SVGSVGElement & { __zoom?: { k?: number } }) | null;
    const z = el?.__zoom;
    return z && typeof z.k === "number" ? z.k : Number.NaN;
  }

  /**
   * 重设 markmap 的缩放过滤器：左键(0)不再平移画布（留给节点拖动 / 框选），
   * 右键(2)拖拽平移画布，触屏捏合保持。
   *
   * **`wheel` 一律返回 false** —— 滚轮不再交给 d3。两个理由：
   * 1. d3 的 `wheeled` 只认「滚多少就缩放多少」，它没有「这次的滚轮是鼠标还是
   *    触摸板」这个概念（markmap 用 UA 猜：Mac 一个样、Windows 另一个样，
   *    而同一台 Windows 笔记本上鼠标和触摸板是混着用的）；
   * 2. 更要紧的是它调用 `stopImmediatePropagation()` —— 只要放行，画布上
   *    挂的 wheel 监听就再也收不到事件。
   * 现在 wheel 的语义判定在 `render/wheel.ts`，d3 只负责把算好的 transform 落地。
   */
  private applyZoomFilter(): void {
    const mm = this.mm;
    if (!mm) return;
    mm.zoom.filter((event: any): boolean => {
      if (event.type === "wheel") return false;
      if (event.type === "touchstart" || event.type === "touchmove") return true;
      // 仅右键（button 2）拖拽平移
      return event.button === 2;
    });
  }

  // -------------------------------------------------------------------------
  // 视口：滚轮 / 触摸板 / 缩放键
  // -------------------------------------------------------------------------

  /**
   * 滚轮入口。
   *
   * 三种设备行为，全部由 `WheelGesture` 判定（判据与理由都在那个文件里）：
   * - **鼠标滚轮**（一格一格）→ 以指针为中心缩放，和以前一样；
   * - **触摸板双指滑动**（连续、零碎、常有横向分量）→ 平移，图跟着手指走；
   * - **捏合 / Ctrl+滚轮**（`ctrlKey` 的 wheel）→ 缩放。
   *
   * 位移攒到下一帧统一应用：触摸板一次滑动能发上百个事件，每个都改一次
   * transform 就是上百次重绘。攒起来数学上等价（平移相加、同一点缩放相乘）。
   */
  private onWheel(e: WheelEvent): void {
    if (!this.mm) return;
    const viewport: number = this.canvasEl?.clientHeight || window.innerHeight;
    const intent: WheelIntent | null = this.wheelGesture.classify(e, viewport);
    if (!intent) return;

    // 一律拦掉默认行为：不拦的话触摸板的惯性滚动会穿到后面的笔记编辑区
    e.preventDefault();
    this.userView = true;

    if (intent.kind === "pan") {
      this.wheelPanX += intent.dx;
      this.wheelPanY += intent.dy;
    } else {
      this.wheelZoom *= intent.factor;
      this.wheelAt = this.pointerInSvg(e);
    }
    this.flushWheelSoon();
  }

  /** 把这一帧攒下的位移交给 d3-zoom 落地（一帧最多一次） */
  private flushWheelSoon(): void {
    if (this.wheelQueued) return;
    this.wheelQueued = true;
    window.requestAnimationFrame(() => {
      this.wheelQueued = false;
      const zoom: number = this.zoomScale();
      const k: number = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      if (this.wheelZoom !== 1) {
        const factor: number = this.wheelZoom;
        // 键盘缩放没有指针位置，就以视口中心为锚点（和用户此刻盯着的地方一致）
        const at: [number, number] = this.wheelAt ?? this.svgCenter();
        this.wheelZoom = 1;
        this.wheelAt = null;
        this.applyZoom((sel) => sel.call(this.zoomBehavior().scaleBy, factor, at, null));
      }
      if (this.wheelPanX !== 0 || this.wheelPanY !== 0) {
        const dx: number = this.wheelPanX;
        const dy: number = this.wheelPanY;
        this.wheelPanX = 0;
        this.wheelPanY = 0;
        // translateBy 的 x/y 是**内容坐标**（内部会乘 k），所以先按当前比例换成内容位移
        this.applyZoom((sel) => sel.call(this.zoomBehavior().translateBy, dx / k, dy / k, null));
      }
    });
  }

  /**
   * 把 svg 的 d3 selection 与 zoom 行为一起拿出来用。
   *
   * 这里不 import d3：transform 的玩法（`zoom.scaleBy` / `zoom.translateBy`）
   * 由 markmap 实例提供，我们只负责算「该缩多少、该移多少」。类型上用最小形状，
   * 因为 d3 的类型包没装，markmap 那边只能退化成 any。
   */
  private zoomBehavior(): any {
    return this.mm?.zoom;
  }

  private applyZoom(op: (sel: { call: (fn: unknown, ...args: unknown[]) => void }) => void): void {
    const mm = this.mm;
    if (!mm) return;
    op(mm.svg as unknown as { call: (fn: unknown, ...args: unknown[]) => void });
  }

  /** 指针在 svg 用户坐标系里的位置（d3 的 pointer 算法，兼容 viewBox 与 CSS 缩放） */
  private pointerInSvg(e: { clientX: number; clientY: number }): [number, number] {
    const svg = this.svgEl;
    if (!svg) return [0, 0];
    try {
      const p = svg.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const q = p.matrixTransform(ctm.inverse());
        return [q.x, q.y];
      }
    } catch {
      // 极老的实现没有 createSVGPoint，退回矩形换算
    }
    const r: DOMRect = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** 视口中心（svg 用户坐标），给没有指针位置的缩放当锚点 */
  private svgCenter(): [number, number] {
    const svg = this.svgEl;
    if (!svg) return [0, 0];
    const r: DOMRect = svg.getBoundingClientRect();
    return this.pointerInSvg({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  }

  /** 以画布中心为锚点缩放（键盘缩放走这条） */
  private zoomBy(factor: number): void {
    this.wheelZoom *= factor;
    this.wheelAt = null;
    this.userView = true;
    this.flushWheelSoon();
  }

  private nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // 投影：一次内容变化该走哪条通道
  // -------------------------------------------------------------------------

  /**
   * 请求把最新状态画出来。
   *
   * 这里不再自己做「正在刷新就排队 / 正在编辑就跳过」的判断——那些交给
   * ViewRuntime：非 idle 阶段自动挂起，回到 idle 自动补跑，并发请求只保留最新一个。
   */
  refresh(knownContent?: string): void {
    this.rt.request((rev: number) => this.project(rev, knownContent));
  }

  private async project(rev: number, knownContent?: string): Promise<void> {
    const t0 = traceSince();
    this.syncThemeButton();

    if (!this.svgEl) return;
    const file = this.resolveTargetFile();
    // 没有可显示的笔记时别留一张纯白的画布 —— 用户分不清是「没渲染」还是
    // 「渲染了但内容在视口外」。给一句人话，比让他去点「适配」猜强。
    if (!file) {
      this.showEmpty("没有可显示的笔记 —— 先在主区打开一篇 Markdown 笔记");
      return;
    }
    this.clearEmpty();

    const prev = this.snapshot;
    const filter: boolean = this.plugin.settings.filterFrontmatter;
    const parseOpts: { filterFrontmatter: boolean } = { filterFrontmatter: filter };

    // 读路径统一走 QueryService（读 → 解析 → 节点坐标 + 缩进检测），一次产出只读快照。
    // 写回之后调用方直接传入刚写完的内容，不再依赖「读回来的东西是新的」，
    // 彻底避开「文件变了但导图不更新」的竞态。
    const doc =
      knownContent === undefined
        ? await this.query.load(file.path, file.basename, parseOpts)
        : this.query.parse(knownContent, file.basename, parseOpts);
    // 读文件期间用户可能又改了一版、或者切走了笔记：这一轮作废，新请求会接管
    if (this.rt.stale(rev)) return;

    // 面包屑 / 双链跳转是「同一张导图里换个地方看」，不是重新打开一篇：
    // 这时候重置缩放会让人瞬间失去方位感。读一次即清，不影响真正的换文件。
    const keepViewport: boolean = this.keepViewport;
    this.keepViewport = false;

    const content: string = doc.content;
    const tree: IPureNode = doc.tree;
    this.indentStep = doc.step;
    this.indentUnit = doc.unit;

    const isDark = document.body.classList.contains("theme-dark");
    const spec = resolveTheme(this.plugin.settings.theme, isDark);
    const themeKey = `${spec.id}:${spec.dark ? "d" : "l"}`;
    this.applyTheme(spec);
    // 规模统计跟着树走：放在 applyTheme 之后、所有早退分支之前，
    // 这样「只是移动光标」这类空转刷新也不会让数字停在旧值上
    this.syncStats(tree);

    const sameFile = prev !== null && prev.path === file.path;
    const sameTheme = prev !== null && prev.themeKey === themeKey;
    const sameFilter = prev !== null && prev.filterFrontmatter === filter;

    // 内容、主题、解析参数都没变（例如只是移动光标触发的 editor-change）：
    // 什么都不用画，但排队中的「编辑下一个节点」还得接上。
    if (sameFile && sameTheme && sameFilter && prev.content === content) {
      this.flushPendingEdit();
      return;
    }

    const plan = planProjection({
      prev: prev?.tree ?? null,
      next: tree,
      forceStructure: !sameFile || !sameTheme || !sameFilter,
      sourceSame: prev !== null && prev.content === content,
    });

    // 走哪条通道决定了「会不会闪」：none/patch 都不重建 DOM，
    // 只有结构通道要 setData 换掉整批 g —— 日志里看到 rebuild 就该往重建链路想。
    // why 是「为什么必须重建」（见 app/plan.ts 的 StructureReason）：
    // 改一个字却出现 why=line/depth，说明是行号位移或缩进变了，不是文字变了。
    // traceLog("refresh.plan", {
    //   kind: plan.kind,
    //   why: plan.kind === "structure" ? plan.reason : undefined,
    //   at: plan.kind === "structure" ? plan.at : plan.kind === "patch" ? plan.line : undefined,
    //   lines: isTracing() ? `${countLines(prev?.content)}->${countLines(content)}` : undefined,
    //   nodes: isTracing() ? `${countNodes(prev?.tree ?? tree)}->${countNodes(tree)}` : undefined,
    //   file: file.basename,
    //   load: traceElapsed(t0),
    // });

    // 埋点已停用：why 只说「哪一类原因」，原来这里把「具体哪几个节点、行号/文字
    // 怎么变的」也写进 refresh.diff。要恢复诊断：解开下面三行，并把 explainDiff
    // 加回文件头的 import。
    // if (isTracing() && plan.kind === "structure" && prev) {
    //   for (const detail of explainDiff(prev.tree, tree, 4)) traceLog("refresh.diff", { detail });
    // }

    if (plan.kind === "none") {
      this.snapshot = {
        content,
        tree,
        nodes: doc.nodes,
        path: file.path,
        themeKey,
        filterFrontmatter: filter,
      };
      this.flushPendingEdit();
      return;
    }

    // 只改了一处文字：直接换那个节点的 DOM，不 setData。
    // markmap 的 key 里带内容哈希，setData 会让整棵树重新 enter（DOM 全量重建）；
    // 而它自己对节点内容挂了 ResizeObserver，尺寸一变会重排，这就是官方支持的增量路径。
    if (plan.kind === "patch") {
      // 这一改可能让后面的行号整体漂了（文字从一行变两行、或上面多了一段）。
      // 行号是所有定位操作的坐标系，必须先写回 DOM —— 否则下面的
      // findNodeByLine 找的还是旧行号，patch 必然落空、又退回重建。
      const relabeled: boolean = plan.relabel ? this.applyRelabel(tree) : true;
      if (relabeled && this.applyPatch(plan.line, plan.content, plan.src)) {
        this.snapshot = {
          content,
          tree,
          nodes: doc.nodes,
          path: file.path,
          themeKey,
          filterFrontmatter: filter,
        };
        this.flushPendingEdit();
        return;
      }
    }

    // 结构变化：setData 全量重建
    // setData 会重建整棵树并把 payload.fold 冲掉，
    // 不接住的话用户折起来的分支每次编辑都会全弹开。
    applyFolds(tree, collectFolds(this.mm?.state.data));

    // 块节点的 content 必须在这一刻就是**渲染后的真 HTML**：markmap 是按 content
    // 里的 DOM 量宽高的。缓存命中时几乎零成本，所以每次重建都跑一遍没有负担。
    await this.renderBlocks(tree, file);

    if (this.rt.stale(rev)) return;

    const restructure = (): Promise<void> => this.applyTree(tree);

    if (!this.mm) {
      // 注意不要用 Markmap.create(svg, opts, tree)：传了 data 它会在内部
      // 直接 fit 一次，而 fit 带 180ms 过渡动画，打开视图时会看到画面缩一下。
      // 这里先建实例、再 setData，最后用无动画的 fitInstant 适配。
      this.mm = Markmap.create(this.svgEl, this.buildOptions(spec));
      this.applyZoomFilter();
      this.attachSettleHook(this.mm);
      this.snapshot = {
        content,
        tree,
        nodes: doc.nodes,
        path: file.path,
        themeKey,
        filterFrontmatter: filter,
      };
      await restructure();
      await this.fitInstant();
    } else {
      // 主题变了才需要换一整套绘制选项（线宽、字号、maxWidth）。
      // setOptions 只合并选项、不渲染，但会重绑一次 zoom 手势，没必要每次重建都调。
      if (!sameTheme) this.mm.setOptions(this.buildOptions(spec));
      this.applyZoomFilter();
      this.snapshot = {
        content,
        tree,
        nodes: doc.nodes,
        path: file.path,
        themeKey,
        filterFrontmatter: filter,
      };
      await restructure();
      // 换了一篇笔记才重新适配；同一篇里改内容保持用户的缩放与位置。
      // 导航跳转（面包屑 / 双链）也保持视口 —— 想回全览点「适配」。
      if (!sameFile && !keepViewport) {
        // 新笔记 = 新的视口语境：恢复「跟着容器尺寸自动适配」
        this.userView = false;
        this.fittedSize = null;
        await this.fitInstant();
      }
    }

    this.flushPendingEdit();
  }

  /**
   * 把新树的源坐标写回 DOM 树（`mm.state.data`）——只改行号坐标系，不碰 DOM 结构。
   *
   * 什么时候需要：一次编辑只改了**一个**节点的文字，但让后面所有节点的行号
   * 整体漂了（把一行改成两行、在它上面插了一段…）。树的形状没变，所以不该重建；
   * 可 DOM 里每个 g 的 `payload.src` 还指着旧行号，而编辑框初始文本、拖动落点、
   * 写盘锚点、选中集**全都按行号定位** —— 不写回去，点开编辑就会读到隔壁行的字。
   *
   * 真正的写回逻辑在 `relabelTree`（纯函数，有单测）；这里只处理视图侧的两件事：
   * 选中集要跟着挪、DOM 上那份高亮要重挂。
   */
  private applyRelabel(next: IPureNode): boolean {
    const root = (this.mm?.state.data ?? null) as IPureNode | null;
    if (!root) return false;
    const moved = relabelTree(root, next);
    if (!moved) return false;
    if (moved.size === 0) return true;

    // 选中集也是行号：不跟着挪，刷新之后高亮会挂到别人的卡片上
    if (this.selectedLines.size > 0) {
      const sel = new Set<number>();
      for (const ln of this.selectedLines) sel.add(moved.get(ln) ?? ln);
      this.selectedLines = sel;
    }
    if (this.primaryLine >= 0) {
      this.primaryLine = moved.get(this.primaryLine) ?? this.primaryLine;
    }
    // DOM 上那份 obmind-selected 是按旧行号挂的，代数 +1 让 paintSelection 重挂
    this.structureGen++;
    this.paintSelection();
    return true;
  }

  /**
   * 原地改字：只替换该节点的内容 DOM，不 setData。
   *
   * 为什么能这么做：markmap 的节点 key 是 `父id.子id + hash(content)`，
   * 一旦 setData，内容变了的节点 key 全变，d3 会把整个子树重新 enter
   * （foreignObject、内容 DOM、代码高亮、公式全部重来）。而它内部对每个节点的
   * 内容 div 挂了 ResizeObserver（100ms 防抖 → renderData），
   * 所以「改 DOM」本身就是它支持的增量路径：不重建，只重排。
   *
   * @returns false 表示这个节点当前不在 DOM 里（折叠/已被替换），只能退回全量重建
   */
  private applyPatch(line: number, content: string, src: SrcRef): boolean {
    const g = this.findNodeByLine(line);
    if (!g) {
      // 节点不在 DOM 里（折叠 / 刚被换掉）→ 这次会退回结构重建，下次就看到 rebuild 了
      // traceLog("patch.miss", { line });
      return false;
    }

    const fo = g.querySelector<SVGForeignObjectElement>(":scope > foreignObject");
    // markmap 的结构是 foreignObject.markmap-foreign > div > div，最内层承载内容
    const box = fo?.firstElementChild?.firstElementChild ?? null;
    if (!fo || !box) return false;

    // 内容已经一样就别再赋值：innerHTML 赋值会把内部 DOM 全部重建一遍，
    // 视觉上就是文字闪一下（「提交即预览」已经把新文字画上去了，这里多数时候是同值）。
    const changed: boolean = box.innerHTML !== content;
    if (changed) box.innerHTML = content;
    // changed=false 是正常路径（预览已经铺过），日志里出现大量 true 说明预览没接上
    // traceLog("patch.apply", { line, changed });

    // 同步写回 markmap 手里的节点数据：后续拖动等逻辑读的是 DOM，
    // 但下次结构重建前若有其它代码看 state.data，内容不能是旧的。
    // 刻意不动 state.key —— 一改 key 就等于宣布「这是新节点」，patch 就白做了。
    //
    // **src 必须一起换（1.18.5）**：编辑框的初始文本来自 `payload.src.text`，
    // 而 patch 通道是唯一不改这棵树的路径 —— 不写回去，节点上显示的是新内容、
    // 点开编辑却是上一次的文字（新建节点后第一次改字必然踩到：那句话就是「新节点」）。
    const data = (g as SVGGElement & { __data__?: INode }).__data__;
    if (data) {
      data.content = content;
      const payload = data.payload as { src?: SrcRef } | undefined;
      if (payload && payload.src) {
        const before: string = payload.src.text;
        // 换引用而不是 Object.assign：新行可能少了 endLine / blockStart 之类的字段，
        // 逐字段覆盖会把这些「上一次才有」的值留下来，于是 startEdit 会误判成多行节点。
        payload.src = src;
        // traceLog("patch.src", { line, from: before.slice(0, 12), to: src.text.slice(0, 12) });
      } else {
        // 拿不到 payload 就没法回写 —— 下一步必然又是「显示新字、编辑旧字」
        // traceLog("patch.src.miss", { line });
      }
    }

    // 尺寸可能变了（文字变长/变短）。立刻量一次让卡片先跟上。
    //
    // 量完必须当场把**这一个节点**画一遍：`fo.width` 是 markmap 的文字层，
    // 我们的卡片是另一个 `<rect>` —— 改属性不会让它自己变大。以前这里指望
    // 「随后的 reflowNow 会画一次」，但那条路在编辑态被相位闸门挡掉了
    // （见 reflowNow 的注释），于是卡片停在旧宽度：新文字比卡片宽，直接顶出
    // 边框（用户截图），而且之后**没有任何事件**会来修它。
    // paintMoved 是同步的，只写这个节点（命中缓存时约 8 个属性），成本可忽略；
    // 邻居让位仍然交给 reflowSoon 的整树重排。
    const w: number = box.scrollWidth;
    const h: number = box.scrollHeight;
    if (w > 0 && h > 0) {
      fo.setAttribute("width", String(w));
      fo.setAttribute("height", String(h));
      this.frames.paintMoved([g]);
    }
    // 幂等：内容没换（提交即预览已经铺过）就不必再排一次整树布局
    if (changed) this.reflowSoon();
    return true;
  }

  /**
   * 内容尺寸变了 → 立刻让 markmap 重排一次，别等它自己的 100ms 防抖。
   *
   * 「改一个字闪一下」就是这么来的：markmap 对每个节点的内容 div 挂了
   * ResizeObserver，**防抖 100ms** 才跑 renderData；renderData 里的位置变化又走
   * `options.duration`（180ms）的 transition。于是「卡片已经变宽、孩子/邻居那一列
   * 还停在旧位置」的错位要持续约 280ms —— 肉眼就是压住一下再滑开。
   * 实测（tmp/probeFlicker.ts）：改一个分支标题后，卡片互相压住从 8ms 一直到 233ms。
   *
   * 这里压到一帧：duration 置 0 主动 renderData（位置瞬间到位），再补画卡片和选中框。
   * 代价是一次整树布局（两千节点的笔记几十毫秒），只在真的改了文字时跑；
   * 而且本来 100ms 后 markmap 也要跑同一件事，只是那时带着 180ms 的滑动。
   *
   * 排到下一帧而不是立刻跑：previewText 与随后的 applyPatch 会在同一轮里各改一次，
   * 合并成一次重排就够。
   */
  /**
   * 是否正在重建（DOM 是半成品，绘制与重排都得让路）。
   *
   * 单独抽成方法而不是写 `this.rt.phase === "rebuilding"` 两次：TS 会把第一次
   * 早退的窄化**一直带到 await 之后**，第二次同样的比较会报「两个类型没有重叠」——
   * 而那一处恰恰是必须保留的判断（`renderData` 期间可能又开始一轮重建）。
   */
  private rebuilding(): boolean {
    return this.rt.phase === "rebuilding";
  }

  private reflowSoon(): void {
    if (this.reflowFrame !== 0) {
      // 合并掉一次：previewText 和随后的 applyPatch 会在同一轮里各改一次，
      // 正常现象。若这里频繁出现而 reflow.start 不多，说明重排被合并得过头。
      // traceLog("reflow.coalesce");
      return;
    }
    // traceLog("reflow.soon");
    this.reflowFrame = window.requestAnimationFrame(() => {
      this.reflowFrame = 0;
      void this.reflowNow();
    });
  }

  private async reflowNow(): Promise<void> {
    const mm = this.mm;
    const svg = this.svgEl;
    if (!mm || !svg) return;

    // 撞上重建就别插手：这一帧的 DOM 正在被 setData 换掉，再调一次 renderData
    // 只会把半成品重排一遍（还会重写 opacity/class）。重建结束的 paintNow 会做同一件事。
    //
    // **编辑态要放行**（1.18.10）。判据以前是 `!== "idle"`，于是「提交即预览」
    // 那次重排永远被跳过 —— 预览是在 phase 还是 editing 的时候调的，而写盘是异步的，
    // rAF 早就到了：日志里就是一串 `reflow.skip phase=editing`。
    // 跳过之后写盘的 applyPatch 又因为「预览已经把 innerHTML 铺成一样」不请求重排，
    // 结果是这个节点**一次绘制都没发生**：文字层换了新宽度，自绘卡片还是旧 rect，
    // 屏幕上就是「文字溢出卡片边框」，且永远不会自己恢复。
    // 编辑态下 DOM 是完整的（编辑框是浮层，原文只是 visibility: hidden），安全。
    if (this.rebuilding()) {
      // traceLog("reflow.skip", { phase: this.rt.phase });
      return;
    }

    const t0 = traceSince();
    // duration 进日志：这条路径临时把它改成 0，恢复时若 prev 已经是 0 会退回 180。
    // 若日志里反复出现「duration=180 而本来应该是别的值」，动画速度就被改过了。
    // traceLog("reflow.start", { duration: mm.options.duration });
    const prev: number = mm.options.duration;
    // 这一遍 renderData 会让内容 div 再一次「变尺寸」，markmap 自己的防抖回调
    // 100ms 后还会再排一次（现场日志：reflow.rendered 之后 200ms 又冒一个
    // obs.class n=全部节点 + paint.moved n=全部节点）。同一个窗口把那次也压平。
    this.settleUntil = performance.now() + 1200;
    mm.setOptions({ duration: 0 });
    try {
      await mm.renderData();
    } catch {
      // 布局失败不影响已经画上去的内容；下一次真实刷新会再算一遍
    } finally {
      // prev 可能已经是 0（上一次重排还没收尾）：退回默认值，别把动画永久关掉
      mm.setOptions({ duration: prev > 0 ? prev : 180 });
      // traceLog("reflow.rendered", { dt: traceElapsed(t0), prev });
    }

    // 等 renderData 的这几帧里可能又开始了一轮重建：别用刚被换掉的 DOM 去画
    if (this.rebuilding()) {
      // traceLog("reflow.abort", { phase: this.rt.phase });
      return;
    }
    // 节点位置变了，卡片/连线要按新几何重新摆；renderData 同时会把每个节点的
    // class 整段重写（attr("class", …)），选中标记会被抹掉，所以顺手补回。
    // 整树重排 = 「DOM 上的 class 全部不可信」，代数 +1 强制重刷一次。
    this.structureGen++;
    this.frames.paintNow();
    this.paintSelection();
  }

  /**
   * 把块节点（代码 / 公式 / 表格 / 引用）交给 Obsidian 自己的 MarkdownRenderer 渲染。
   *
   * 为什么不自己画：代码高亮、MathJax、mermaid 全在 Obsidian 内部，走官方渲染器的
   * 额外好处是观感和笔记里**完全一致** —— 用户不用在两套排版之间切换。
   *
   * 必须在 setData **之前** await 完成：markmap 的布局读的是
   * `foreignObject > div > div` 的 scrollWidth/scrollHeight。先灌占位、事后再替换，
   * 节点尺寸就和真实内容脱节了（卡片被裁、或者留一大块白）。
   *
   * 渲染失败或空块时不开天窗：解析层已经往 content 里放了一个薄标签，留着就行。
   */
  private async renderBlocks(tree: IPureNode, file: TFile): Promise<void> {
    const jobs = collectBlockNodes(tree);
    if (jobs.length === 0) return;

    const alive = new Set<string>();
    await Promise.all(
      jobs.map(async ({ node, block }: { node: IPureNode; block: BlockInfo }) => {
        // 路径进 key：MarkdownRenderer 会按 sourcePath 解析 ![[图.png]] 和相对链接，
        // 跨笔记复用同一段代码的渲染结果会把别人的图贴过来。
        const key = `${file.path}|${block.kind}|${block.lang}|${block.raw}`;
        alive.add(key);

        const cached: string | undefined = this.blockCache.get(key);
        if (cached !== undefined) {
          node.content = cached;
          return;
        }

        const holder = document.createElement("div");
        const part = new Component();
        // 先 load：渲染器（高亮 / MathJax / mermaid）是作为子组件挂上来的，
        // 父组件没 load 的话它们不会启动，公式就一直是原始 `$$…$$`。
        part.load();
        try {
          await MarkdownRenderer.render(this.app, block.raw, holder, file.path, part);
          this.decorateCodeBlocks(holder);
          const html: string = holder.innerHTML.trim();
          // 空块（```js``` 里什么都没有）不值得撑一张空白卡片
          if (html === "") {
            part.unload();
            return;
          }
          // `markdown-rendered` 是关键：Obsidian 的阅读视图样式（代码底色、语法高亮、
          // 表格线、引用条、callout、公式排版）全都挂在这个类下面。不加它，块在我们
          // 手里就只剩「排得下」而已 —— 颜色和底色全丢。
          const wrapped: string = `<div class="obmind-block-md markdown-rendered">${html}</div>`;
          node.content = wrapped;
          if (this.blockCache.size > 300) this.blockCache.clear();
          this.blockCache.set(key, wrapped);
          this.blockParts.set(key, part);
        } catch (err) {
          part.unload();
          // 保留解析期的薄标签：整块消失比排得难看糟糕得多
          console.warn("[obmind] 块渲染失败，保留占位标签", err);
        }
      }),
    );

    // 这一轮没再用到的组件要释放，否则切来切去会堆一串 MathJax 注册
    for (const [key, part] of Array.from(this.blockParts)) {
      if (alive.has(key)) continue;
      part.unload();
      this.blockParts.delete(key);
    }
  }

  /**
   * 给块里的每个 <pre> 配一个复制按钮。
   *
   * `MarkdownRenderer.render` 只产 HTML，复制按钮是阅读视图后处理加的，这里没有。
   * 按钮元素直接写进字符串（innerHTML 序列化会丢事件监听，所以点击统一用
   * 画布上的事件委托处理，见 onCopyClick）。
   */
  private decorateCodeBlocks(holder: HTMLElement): void {
    for (const pre of Array.from(holder.querySelectorAll("pre"))) {
      if (pre.querySelector(":scope > .copy-code-button")) continue;
      const btn = document.createElement("button");
      btn.className = "copy-code-button";
      btn.type = "button";
      btn.textContent = "复制";
      pre.appendChild(btn);
    }
  }

  /**
   * 复制按钮的委托处理。
   *
   * 为什么不逐个 addEventListener：块内容是字符串，每次重建都会重新 innerHTML，
   * 之前绑的监听全丢。委托挂在画布上，重建多少次都有效。
   */
  private onCopyClick = (e: MouseEvent): void => {
    const btn = (e.target as Element).closest<HTMLElement>(".copy-code-button");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const pre = btn.closest("pre");
    const text: string = (pre?.querySelector("code") ?? pre)?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      btn.textContent = "已复制";
      window.setTimeout(() => {
        btn.textContent = "复制";
      }, 1200);
    });
  };

  /**
   * 把新树灌进 markmap，并在同一帧内把卡片/连线摆正。
   *
   * 结构变化（拖动改层级、增删节点）**绝不能带位置过渡**：
   * 1. 节点的孩子索引路径（"0.2.1"）会整篇重编，g 元素按索引被复用到别的节点上，
   *    过渡期间旧连线是从「错的父节点」出发的；
   * 2. 过渡要 180ms，这期间 MutationObserver 每帧都在按半路位置重算连线，
   *    两边叠加就是「线乱飞」。这就是拖动后 view 更新时闪一下的原因。
   *
   * 改成 duration=0 瞬间到位后，位置在第一次 tick 就落定，
   * 紧跟着同步重绘一次（paintNow），整个过程在一帧内结束，不会播出中间态。
   * 折叠/展开的 180ms 动画不受影响：那是 markmap 自己 toggleNode 触发的，
   * 这里只临时改了本次 setData 的 duration。
   */
  private async applyTree(tree: IPureNode): Promise<void> {
    const mm = this.mm;
    const svg = this.svgEl;
    if (!mm || !svg) return;

    // 槽位表必须在 setData 之前刷新：markmap 的 color 回调在 render 里同步取色，
    // 那时节点 DOM 还没建出来，只能从树上推 path
    this.syncBranchSlots(tree, this.currentSpec?.colors.length ?? 6);

    this.rt.setPhase("rebuilding");
    // 挡住这一轮重建的淡入（见 fadeGuardUntil）：`setData` 内部的 await 会让出
    // 一两帧给浏览器，那几帧若不挡，用户看到的就是「整排兄弟卡片文字消失」。
    //
    // **窗口必须从 `setData` 返回之后才开始算**。1.18.1 的日志实测：251 个节点的
    // `setData` 同步阻塞 400–550ms，而这里原本的 50ms 是调用前就开始计时的 ——
    // 也就是整个 setData 期间窗口早就过期（日志里 `guardLeft=-468`），
    // 真正会写 opacity 的那批 enter/exit 过渡恰好发生在 setData 返回后的 1–2 帧
    // （日志：`rebuild.end` 之后 2.7ms 冒出 `obs.fadeBatch n=72 guard=false`），
    // 于是卡片被抄成半透明、下一帧再恢复 —— 闪的就是这一下。
    // 所以在 `await` 之后再重设一次窗口（见下面），这里只是先挡住中途那几帧。
    this.fadeGuardUntil = performance.now() + 50;

    // 记录起点：下面每一步的 dt 都是「距上一阶段」。
    // 注意 guard 窗口是从**现在**算的 50ms —— 若 setData 本身跑了 200ms，
    // 收尾阶段其实已经没有保护了（日志里 guardLeft 为负就是这个意思）。
    const t0 = traceSince();
    // traceLog("rebuild.start", {
    //   duration: mm.options.duration,
    //   nodes: isTracing() ? countNodes(tree) : undefined,
    // });

    const prev: number = mm.options.duration;
    mm.setOptions({ duration: 0 });
    try {
      await mm.setData(tree);
      // 真正的 enter/exit 过渡从这一刻才开始（setData 内部那次 await 期间主线程
      // 一直被占着，d3 的 timer 根本轮不到）。窗口在这里重设，才真的盖住那 1–2 帧。
      // 120ms：足够 d3 跑完 duration 0 的收尾，又短到不会误伤用户手点的折叠淡出。
      this.fadeGuardUntil = performance.now() + 120;
      // 同理：markmap 自己挂的 ResizeObserver 会在 setData 之后（现场实测 700–800ms）
      // 再跑一遍整树重排，那时 duration 已恢复成 180 → 整张图重播一遍动画。
      // 给它一个 1.2s 的窗口，落进来就按 duration 0 跑（见 attachSettleHook）。
      this.settleUntil = performance.now() + 1200;
      // traceLog("rebuild.setData", { dt: traceElapsed(t0) });

      // 旧节点是走 transition 移除的，即使 duration=0 也要等一个 tick。
      // 这期间它们还在 DOM 里、文字已透明，但我们的卡片是不透明的 ——
      // 同步重绘会把这些「幽灵卡片」按旧几何画出来，屏幕上就会闪出几个空框。
      let step = traceSince();
      const ghosts: number = this.dropDetached();
      // traceLog("rebuild.ghost", {
      //   n: ghosts,
      //   dt: traceElapsed(step),
      //   guardLeft: Math.round(this.fadeGuardUntil - performance.now()),
      // });

      // 重建期间没挡住的残余（比如 observer 还没跑到的那几条记录）在这里清掉：
      // 位置已经是瞬间到位的，任何 < 1 的透明度都不该留下来。
      step = traceSince();
      const faded: number = this.clearFade();
      // traceLog("rebuild.clearFade", { n: faded, dt: traceElapsed(step) });

      // 刚 enter 的节点 markmap 还没来得及写 width/height（它下一次 renderData 才量），
      // 此刻全量绘制会读不到几何 → 新节点第一帧**没有卡片**，只有裸文字。
      // 缺尺寸的才去量（scrollWidth 会强制同步布局，不能对所有节点做）。
      step = traceSince();
      const measured: number = this.measureMissing();
      // traceLog("rebuild.measure", { n: measured, dt: traceElapsed(step) });

      // 丢掉「按位置索引」的缓存（path → g）与「整块平移中」的登记。
      // **绘制缓存不丢**：d3 按 key join，没变的节点复用同一个 `<g>`，
      // 全丢会让紧接着的 paintAll 对每个节点重写 24 个属性（250 节点 ≈ 5 500 次写），
      // 把整张图的 style/layout 全部作废 —— 而其中九成值根本没变。
      // 单条失效交给 entryOf 的身份核对（g 换了就重建那一条）。
      this.frames.reset();
      // 必须在画之前清：拖动块是用 CSS `translate` 跟着鼠标走的，
      // 而 d3 重建时很可能**复用同一个 g**（key 没变）—— 那份 translate 会留在
      // 新节点上，于是卡片带着整个鼠标位移被画到错误的位置，连线还被拉成一条斜的
      // （用户说的「飘线」）。现场日志 `drag.shift.gone ms=672` 就是这个窗口。
      //
      // 但「正在拖的那一块」不能清：用户放手后立刻抓下一个节点时，上一次的重建
      // 正好在这时收尾，无条件全清会把手上这块当场拽回原处。
      const liveMembers: Set<SVGGElement> = new Set(this.drag?.liveMembers() ?? []);
      const liveRoots: SVGGElement[] = this.drag?.liveRoots() ?? [];
      this.drag?.settleNow();
      this.sweepDragShift(liveMembers);
      // reset 已经把登记清空了，这里只把还在手上的块根补回去
      if (liveRoots.length > 0) this.painter.markShifted(liveRoots, true);
      // 画之前先把「DOM 位置」追平「布局真值」——这是「新建节点后子树飘走再飘回来」的解药。
      //
      // `await setData()` 返回的那一刻，DOM 里的 transform 还是 enter 起点
      // （`renderData` 里那句同步的 `$.attr("transform", …)`，全量 enter 时统一是根节点右下角），
      // 终点要等 d3 那条 duration=0 的过渡在第一帧才写进来。
      // 而我们的卡片是**按 transform 画的** —— 这一刻画下去，卡片就落在根节点角落，
      // 于是屏幕上「新建的那个节点和它后面所有节点一起飘到远处」，等 d3 写完再跳回来。
      // 探针实测（`tmp/lagProbe.ts`，77 节点插一个）：setData 返回 +1ms 时 **75 个节点**
      // 位置与 `state.rect` 不符、最大偏 **1260px**，一帧后归零（每节点只出现过 2 个
      // transform 值 = 一次瞬移，不是动画）。
      // 这里既然已经把 duration 置 0 了（语义就是「瞬间到位」），就把终点直接写进去，
      // 让 d3 第一帧无事可做。实测追平后再看 40 帧：一次都没被改回去。
      const synced = this.syncStalePositions();
      // if (synced.n > 0) traceLog("rebuild.syncPos", { n: synced.n, max: Math.round(synced.max) });
      step = traceSince();
      this.frames.paintNow();
      // 这一遍画下去之后，卡片位置与「布局真值」(`state.rect`) 差多少？
      //
      // 关键判据：**卡片是按 DOM 里的 transform 画的，而 transform 是 d3 过渡的第一帧
      // 才写进去的**。`await setData()` 返回时，刚 enter 的节点还停在 `renderData` 里
      // 那句同步 `$.attr("transform", …)` 写的起点（= 根节点的右下角）。
      // 所以这里 lag>0 就说明「这一帧画下去的卡片是错的」，max 就是它偏了多少像素；
      // 紧接着的 `f.traj` 会逐帧给出「它什么时候才回来」。
      // 埋点已停用（paint.lag / f.traj）：这一段原本是「画完立刻核对位置」的自检。
      // if (isTracing()) {
      //   const lag = measureLayoutLag(svg);
      //   traceLog("paint.lag", { lag: lag.n, max: Math.round(lag.max), fresh: lag.fresh, worst: lag.worst });
      // }
      // traceLog("rebuild.paint", { dt: traceElapsed(step), total: traceElapsed(t0) });
    } finally {
      mm.setOptions({ duration: prev });
      this.rt.setPhase("idle");
      this.rebuildEndAt = performance.now();
      // traceLog("rebuild.end", { total: traceElapsed(t0) });
    }

    // 重建换掉了整批 g：选中高亮和节点浮动条都要按行号重新挂回去。
    // 不挂的话，折叠再展开、拖一次节点之后，「选中」在视觉上就凭空丢了，
    // 而 selectedLine 其实还指着那一行 —— 用户按 Tab 会莫名其妙多出一个子级。
    // 代数 +1：让 paintSelection 知道「DOM 上那些 obmind-selected 已经不可信了」。
    this.structureGen++;
    this.paintSelection();
    this.syncToolbar();
    // 逐帧采样已停用（f.traj）：它每帧都要遍历全部节点比对位置，只在排查时开。
    // this.startTrajTrace();
  }

  /**
   * 把 DOM 里落后的 `transform` 直接写成布局真值 `state.rect`。
   *
   * 只在重建路径调用（那时 `duration` 已经是 0，「瞬间到位」本来就是它的语义）。
   * 返回改了几个、最大偏差多少（-1 表示没量）。
   *
   * 三个边界：
   * - `state.rect` 宽高为 0 = `_relayout` 还没把这个节点算进去（新 enter 且内容没量出来），
   *   跳过 —— 交给 markmap 下一次 renderData 与我们的 `obs.resize` 通道。
   * - 值相同就不写（绝大多数节点都不变，这一步对它们零成本）。
   * - d3 那条过渡的第一帧会读当前值当起点，所以写完它算出来的插值就是「原地不动」，
   *   不会把值改回去（探针 `tmp/lagProbe.ts` 场景 B 验过 40 帧）。
   */
  private syncStalePositions(): { n: number; max: number } {
    const svg = this.svgEl;
    const mm = this.mm;
    if (!svg || !mm) return { n: 0, max: 0 };
    // 有过渡在跑就别插手：那样会打断真正的动画（折叠、markmap 自己的收尾重排）
    if (mm.options.duration !== 0) return { n: 0, max: 0 };
    let n = 0;
    let max = 0;
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const rect = (
        g as SVGGElement & {
          __data__?: { state?: { rect?: { x: number; y: number; width: number; height: number } } };
        }
      ).__data__?.state?.rect;
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const at = translateOf(g.getAttribute("transform"));
      if (!at) continue;
      const d: number = Math.hypot(at.x - rect.x, at.y - rect.y);
      if (d <= 0.5) continue;
      if (d > max) max = d;
      g.setAttribute("transform", `translate(${rect.x},${rect.y})`);
      n++;
    }
    return { n, max };
  }

  /**
   * 重建之后逐帧记录「卡片画的 vs 布局真值」的差距（只在开日志时跑）。
   *
   * 为什么非要逐帧：`paint.lag` 只拍一张快照，只能说「这一刻画错了」；用户说的
   * 「飘到远处再飘回来」到底是**一次瞬移**（一帧错、几帧后跳回来）还是
   * **一条 180ms 的过渡**（十几帧连续中间值），只有连续采样能分开 —— 两者的修法
   * 完全不同：前者要改绘制时机，后者要去掐那条过渡的 duration。
   *
   * 采样内容：`lag`=位置与 `state.rect` 不一致的节点数、`max`=最大偏差、`worst`=最差的那个、
   * `fresh`=`state.rect` 还是 0 的节点数（布局压根没把它算进去）。
   * 判读：`lag` 从大变小、若干帧后归零 → 瞬移；`lag` 连续十几帧都 >0 且 `max` 单调变小
   * → 真的是动画在飞。
   */
  private startTrajTrace(): void {
    if (!isTracing()) return;
    if (this.trajRaf !== 0) {
      window.cancelAnimationFrame(this.trajRaf);
      this.trajRaf = 0;
    }
    const t0 = performance.now();
    // 1600ms 上限：现场最慢的收尾重排是 700–800ms，再留一倍余量。
    // 正常情况下 2–3 帧就落定，整个循环只写两三行。
    const deadline = t0 + 1600;
    let sawLag = false;
    let quiet = 0;
    const tick = (): void => {
      this.trajRaf = 0;
      const el = this.svgEl;
      if (!el) return;
      const rep = measureLayoutLag(el);
      const t: number = Math.round(performance.now() - t0);
      if (rep.n > 0) {
        sawLag = true;
        quiet = 0;
        // traceLog("f.traj", {
        //   t,
        //   lag: rep.n,
        //   max: Math.round(rep.max),
        //   fresh: rep.fresh,
        //   worst: rep.worst,
        // });
      } else if (sawLag) {
        // 落定那一帧也记一条（用户真正看到的「回到正确位置」就是这个时刻）
        quiet++;
        // traceLog("f.traj", { t, lag: 0, fresh: rep.fresh, note: "settled" });
        if (quiet >= 2) return;
      }
      if (performance.now() > deadline) {
        // traceLog("f.traj.end", { t, sawLag });
        return;
      }
      this.trajRaf = window.requestAnimationFrame(tick);
    };
    this.trajRaf = window.requestAnimationFrame(tick);
  }

  /**
   * 清掉拖动留下的整块位移（CSS `translate`）与拖动态。
   *
   * 拖动时给块里每个 `g` 写一份 `translate`（见 edit/drag.ts）。松手会触发一次
   * 重建，**但 d3 是按 key 复用元素的**：拖动的节点只要 key 没变，换上去的还是
   * 同一个 `<g>`，而我们写在 style 上的位移没人清 —— 卡片就带着整个鼠标位移被
   * 画在错误的位置，连线从原父节点斜斜地拉过来。
   *
   * 现场日志里 `drag.shift.gone ms=672` 说明这个窗口能有 672ms 长：
   * 松手时块停在鼠标处（这是设计）、线也被还原（这一步是 bug），
   * 于是屏幕上出现一根两端都不挨着的线 —— 就是「飘线」。
   *
   * 所以不靠「谁记得清」，而是在重建收尾统一扫一遍。正常情况下这里一个都扫不到。
   *
   * @param skip 正在被拖的那一批：清掉它们的位移等于「拖到一半跳回去」
   */
  private sweepDragShift(skip: Set<SVGGElement>): void {
    const svg = this.svgEl;
    if (!svg) return;
    let n = 0;
    for (const g of Array.from(
      // 只有我们自己会往节点 g 上写 translate（收放点写的是 circle 的 transform）
      svg.querySelectorAll<SVGGElement>('g.markmap-node[style*="translate"]'),
    )) {
      if (skip.has(g)) continue;
      g.style.removeProperty("translate");
      n++;
    }
    // if (n > 0) traceLog("drag.shift.sweep", { n });
    // class 也可能被复用的元素带过来：留着就是那个节点永远半透明
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node.obmind-dragging"))) {
      if (skip.has(g)) continue;
      g.classList.remove("obmind-dragging");
    }
  }

  /**
   * 把节点文字上残留的半透明清掉。
   *
   * 重建是 `duration: 0` 的瞬间到位，不该有任何淡入淡出。但 markmap 的
   * enter/exit 过渡即使 duration 为 0 也异步到下一帧，`setData` 返回时
   * 这些 `opacity: 0` 还挂在 DOM 上 —— 我们的全量绘制会把它们抄给卡片，
   * 于是那一帧整排兄弟卡片是空的。
   *
   * 用 `removeProperty` 而不是写 `"1"`：属性没了，markmap 后面的过渡想插值
   * 也能从默认值继续，不会被我留的 inline 值卡住。
   *
   * @returns 清掉了几个（> 0 说明重建期间确实有淡入漏网）
   */
  private clearFade(): number {
    const svg = this.svgEl;
    if (!svg) return 0;
    let n = 0;
    for (const fo of Array.from(
      svg.querySelectorAll<SVGForeignObjectElement>("g.markmap-node > foreignObject"),
    )) {
      if (fo.style.opacity !== "") {
        fo.style.removeProperty("opacity");
        n++;
      }
    }
    return n;
  }

  /**
   * 给「markmap 还没量过」的节点补一次尺寸。
   *
   * 全量绘制靠 foreignObject 的 width/height 属性算几何（刻意不读 getBBox）。
   * 刚 enter 的节点这两个属性还是空的，于是那一帧它没有卡片 —— 屏幕上先是
   * 一段裸文字，下一帧卡片才包上去。新建节点时这个「裸文字」特别显眼。
   *
   * 只处理缺失的节点：`scrollWidth` 会强制同步布局，对两千个节点逐个读
   * 就是一次几十毫秒的卡顿，而正常情况下缺失的只有刚加的那一两个。
   *
   * @returns 补了几个（新建节点时应该是 1，出现十几说明 markmap 这一轮没量全）
   */
  private measureMissing(): number {
    const svg = this.svgEl;
    if (!svg) return 0;
    let n = 0;
    for (const fo of Array.from(
      svg.querySelectorAll<SVGForeignObjectElement>("g.markmap-node > foreignObject"),
    )) {
      const w: number = Number.parseFloat(fo.getAttribute("width") ?? "");
      const h: number = Number.parseFloat(fo.getAttribute("height") ?? "");
      if (w > 0 && h > 0) continue;
      const box = fo.firstElementChild?.firstElementChild as HTMLElement | null;
      if (!box) continue;
      const bw: number = box.scrollWidth;
      const bh: number = box.scrollHeight;
      if (bw > 0 && bh > 0) {
        fo.setAttribute("width", String(bw));
        fo.setAttribute("height", String(bh));
        n++;
      }
    }
    return n;
  }

  /**
   * 删掉 setData 之后残留的、在新树里已经不存在的节点元素。
   * 正常情况下就是「已被 markmap 标记为退出、还在等 transition 收尾」的那几个。
   *
   * 用**对象身份**比对，不能用 path：拖动之后旧节点的 path 很可能和新树里
   * 某个节点的 path 撞上（比如都叫 "0.0.1"），按 path 判断会漏掉它，
   * 于是屏幕上多出一个和真节点重叠的幽灵卡片。
   *
   * @returns 删掉了几个（正常情况下是 0，或者只有被折叠掉的那一两个）
   */
  private dropDetached(): number {
    const svg = this.svgEl;
    const root = this.mm?.state.data;
    if (!svg || !root) return 0;

    const alive = new Set<unknown>();
    const walk = (n: INode): void => {
      alive.add(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);

    let n = 0;
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const data: unknown = (g as SVGGElement & { __data__?: unknown }).__data__;
      if (!data || !alive.has(data)) {
        // 记前几个的名字：`rebuild.ghost n=10` 只说数量，说不出「被换掉的是哪几个」，
        // 而那正是判断「为什么这次要重建」的关键（比如每次都是同一个父节点）
        // if (isTracing() && n < 3) traceLog("rebuild.ghostItem", { node: nodeLabel(g) });
        g.remove();
        n++;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // 点击 / 编辑 / 拖动
  // -------------------------------------------------------------------------

  /**
   * 导图内导航的统一入口：点双链 / Alt+单击 / 面包屑 / 新建笔记都走这里。
   *
   * 分叉只取决于钉住：
   * - 没钉住 → `openDoc`：切换导图内容，并按 navSync 联动笔记窗口；
   * - 钉住了 → `openFileOnly`：笔记窗口照常打开，导图留在原地。
   *
   * 为什么钉住时**不能**直接拦掉跳转：用户的动作是「点这个链接」，
   * 链接的天职就是打开那篇。拦下来等于把双链在钉住期间做成死链，
   * 而用户真正的诉求只是「这张图别跟着跑」。
   */
  private navigate(file: TFile): void {
    if (this.pinned) {
      this.openFileOnly(file);
      return;
    }
    this.openDoc(file);
  }

  /**
   * 钉住状态下的「只切笔记」：把文件呈现到 Obsidian 里，**不碰** targetFile / navStack。
   *
   * 三处刻意不动：
   * - `targetFile`：钉住时「导图看哪篇」由它决定，改了就是换图；
   * - `navStack`：栈是「导图内的浏览路径」，图没换，路就没变；
   * - `leafId` 记账：那是为了回退时关闭标签，钉住期间没有回退。
   *
   * 也不 reveal 导图：这里用户要看的是笔记内容，把导图抢到前台等于把刚打开的
   * 笔记又藏回标签栏（导图在侧栏时本来就互不影响）。
   */
  private openFileOnly(file: TFile): void {
    const target: ForwardTarget = forwardTarget(this.navSync());
    if (target === "none") {
      // map-only 本来就是「不动笔记窗口」：钉住后再点链接就什么都不发生了，
      // 不说一句会像卡了。
      new Notice("obmind：导图已钉住，且设置为「仅导图跳转」，笔记窗口不会打开", 3000);
      return;
    }

    if (target === "current") {
      const previous: TFile | null = this.app.workspace.getActiveFile();
      const leaf: WorkspaceLeaf | null =
        this.leafShowing(previous) ??
        this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ??
        null;
      if (leaf) {
        this.openInLeaf(leaf, file);
        return;
      }
    }
    this.openInLeaf(this.newNoteLeaf(), file);
  }

  onNodeClick(e: MouseEvent): void {
    const target = e.target as Element;

    // 1) 行内链接（双链 / 外链）
    const link = target.closest("a") as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const href: string =
        link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
      if (!href) return;
      if (/^(https?|mailto):/i.test(href)) {
        window.open(href, "_blank");
        return;
      }
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        href,
        this.targetFile?.path ?? "",
      );
      if (dest instanceof TFile) {
        // 外链照常开浏览器；站内链接进 navigate —— 钉住时只切笔记、图不动
        this.navigate(dest);
      }
      return;
    }

    // 2) 折叠圆点交给 markmap 自己处理，避免折叠与跳转冲突
    if (target.closest("circle")) return;

    const g = target.closest("g.markmap-node") as SVGGElement | null;
    // 3) 点在空白处 = 取消选中，浮动条跟着收起。
    // 这是关掉浮动条最自然的手势；之前这里直接 return，于是「一旦选中就再也
    // 关不掉」—— 只能去点另一个节点，浮动条永远挂在某个卡片下面。
    if (!g) {
      if (this.selectedLines.size > 0) this.applySelection([], -1, false);
      return;
    }

    // 4) Alt + 单击节点：把节点文字当笔记名打开（原 Ctrl+单击 的行为）。
    //    这个功能必须让位给选择：Ctrl/⌘ + 单击是「加选 / 减选」的通用手势，
    //    被「按名字开笔记」占着，用户想多选一个节点时点到的是跳转 —— 等于
    //    这个手势在导图里根本用不了。Alt 一次性、好记、不抢标准手势。
    if (e.altKey) {
      const text: string = (g.textContent ?? "").trim();
      if (!text) return;
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        text,
        this.targetFile?.path ?? "",
      );
      if (dest instanceof TFile) {
        this.navigate(dest);
      }
      return;
    }

    const line: number = this.srcOf(g)?.line ?? -1;

    // 5) Shift + 单击 = 选中「同级区间」：锚点 → 这一下之间，同层的节点全选上。
    //    先判 Shift 再判 Ctrl：Ctrl+Shift 是「把这一段并进已有选中」，
    //    顺序反过来的话会被 Ctrl 那条吃掉，变成「只切换这一个」。
    if (e.shiftKey) {
      this.selectSiblingRange(line, e.ctrlKey || e.metaKey);
      this.canvasEl?.focus({ preventScroll: true });
      return;
    }

    // 6) Ctrl/⌘ + 单击 = 加选 / 减选（点在已选中的节点上就把它剔出去）。
    //    必须在这一层拦下：漏过去就会落到「普通单击 = 只选这一个」，
    //    前面的选中集当场被清空 —— 就是「Ctrl 点第二个节点，第一个没了」。
    if (e.ctrlKey || e.metaKey) {
      this.toggleSelection(line);
      this.canvasEl?.focus({ preventScroll: true });
      return;
    }

    // 7) 普通左键单击 = 只选这一个（并把它设为下次 Shift 的锚点）。
    //    选中之后 Tab 建子级、Enter 建同级才有基准。
    this.selectNode(g);
  }

  /**
   * 打开一篇笔记 —— 这里是「导图内跳转」的唯一入口。
   *
   * 两件事必须分开看：
   * 1. 导图看哪篇：永远是 `targetFile`（配合 navStack 栈顶），与 Obsidian 的 leaf 无关；
   * 2. 笔记窗口要不要跟、怎么跟：由设置项 navSync 决定，交给 presentNote。
   *
   * 顺序很讲究：先压栈 + 定 targetFile，**再**动 leaf。因为 openFile 会触发
   * file-open，而处理器判断「打开的是不是导图当前显示的那篇」，只有先改完
   * targetFile，自己触发的打开才不会被误判成「用户切了笔记」而清栈。
   */
  private openDoc(file: TFile): void {
    // 走到栈里已有的条目 = 回退，不是新跳转。
    // 交给 goBackTo 才能走对策略：2.3 要关掉中间那些标签，2.4 一个都不动；
    // 若当成新跳转处理，会在 A › B › A 时白白再开一个 A 的标签。
    const hit: number = this.navStack.findIndex((e: NavEntry) => e.path === file.path);
    if (hit >= 0) {
      this.goBackTo(hit);
      return;
    }

    const mode: NavSyncMode = this.navSync();
    const current: TFile | null = this.targetFile;
    const previous: TFile | null = current && current.path !== file.path ? current : null;

    // 起点压栈：第一次跳转时面包屑要有「从哪来」（A › B）
    if (this.navStack.length === 0 && previous) {
      this.navStack = pushEntry(this.navStack, {
        path: previous.path,
        title: previous.basename,
      });
    }

    // 顺着链接继续看，不重置缩放（见 keepViewport 说明）
    this.keepViewport = true;
    this.targetFile = file;

    // 先压栈、后动 leaf。
    // presentNote 里会 openFile，而 openFile 可能同步触发 active-leaf-change /
    // file-open；那一刻栈里必须已经是新条目，否则回调会按旧栈顶再画一次旧笔记（闪一下）。
    const res = pushEntryDetailed(this.navStack, {
      path: file.path,
      title: file.basename,
    });
    this.navStack = res.stack;
    // 被上限挤掉的条目如果当初开过标签，现在没人会再回退到它了 —— 一并收掉
    this.closeTracked(res.dropped);

    const leafId: number | undefined = this.presentNote(file, mode, previous);
    if (leafId !== undefined) {
      const last: NavEntry = this.navStack[this.navStack.length - 1];
      this.navStack = [...this.navStack.slice(0, -1), { ...last, leafId }];
    }

    this.renderBreadcrumb();
    this.refresh();
  }

  /**
   * 把目标笔记"呈现"到 Obsidian 里，返回新分配标签的编号。
   *
   * 决策在 app/NavPolicy.ts（纯函数），这里只执行：
   * - map-only：什么都不做，导图自己换内容；
   * - same-leaf：复用正在显示上一篇的编辑器；
   * - new-leaf-*：新标签打开，2.3 额外记下编号以便回退时关闭。
   */
  private presentNote(
    file: TFile,
    mode: NavSyncMode,
    previous: TFile | null,
  ): number | undefined {
    const target: ForwardTarget = forwardTarget(mode);
    if (target === "none") return undefined;

    if (target === "current") {
      // "当前笔记窗口" = 正在显示上一篇的那个编辑器。
      // 找不到（比如导图独占整个区域）就退化成新标签 —— 点了双链却什么都看不到更糟。
      const leaf: WorkspaceLeaf | null =
        this.leafShowing(previous) ??
        this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ??
        null;
      if (leaf) {
        this.openInLeaf(leaf, file);
        return undefined;
      }
    }

    const leaf: WorkspaceLeaf = this.newNoteLeaf();
    this.openInLeaf(leaf, file);
    // 新标签会激活自己、把导图挤到后台 —— 那样面包屑就点不到了。
    // 把导图重新显示到前台：笔记留在标签栏里，要对照可以自己拖成分屏。
    void this.app.workspace.revealLeaf(this.leaf);

    if (!trackOpenedLeaf(mode)) return undefined;
    const id: number = ++this.leafSeq;
    this.leafById.set(id, leaf);
    return id;
  }

  /** 在指定 leaf 里打开笔记；失败只记日志，不打断导航（导图仍会换内容） */
  private openInLeaf(leaf: WorkspaceLeaf, file: TFile): void {
    void leaf.openFile(file).catch((err: unknown) => {
      console.error("[obmind] 打开笔记失败", err);
    });
  }

  /**
   * 在主编辑区新开一个标签。
   *
   * 不能直接用 `getLeaf("tab")`：它是在「当前活动 leaf 所在区域」新建的，
   * 而点双链时活动 leaf 往往就是侧栏里的导图 —— 笔记会被塞进侧栏的标签组。
   * 有主区的 markdown 标签就用它的父容器建标签；一个都没有才退回 getLeaf。
   */
  private newNoteLeaf(): WorkspaceLeaf {
    const main = this.app.workspace.rootSplit;
    const anchor: WorkspaceLeaf | undefined = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf: WorkspaceLeaf) => leaf.getRoot() === main);
    const parent = anchor?.parent ?? null;
    if (parent) {
      // children 是运行时的内部数组，类型声明里没公开；拿不到就插到 0
      const split = parent as WorkspaceSplit;
      const kids = (split as unknown as { children?: unknown[] }).children;
      const at: number = Array.isArray(kids) ? kids.length : 0;
      return this.app.workspace.createLeafInParent(split, at);
    }
    return this.app.workspace.getLeaf("tab");
  }

  /** 正在显示某篇笔记的编辑器；没有就返回 null */
  private leafShowing(file: TFile | null): WorkspaceLeaf | null {
    if (!file) return null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) return leaf;
    }
    return null;
  }

  /**
   * 关掉「当初为导航新开」的标签。
   *
   * 不看当前模式：条目上带 leafId 就说明那个标签是 obmind 为这次跳转开的，
   * 用户中途改设置也不该把它变成孤儿。
   */
  private closeTracked(entries: readonly NavEntry[]): void {
    for (const entry of entries) this.detachLeaf(entry.leafId);
  }

  private detachLeaf(id: number | undefined): void {
    if (id === undefined) return;
    const leaf: WorkspaceLeaf | undefined = this.leafById.get(id);
    this.leafById.delete(id);
    if (!leaf) return;
    try {
      leaf.detach();
    } catch (err) {
      // 用户可能已经手动关了它，或所属 pane 已销毁 —— 不该影响导航
      console.warn("[obmind] 关闭导航标签失败", err);
    }
  }

  /** 栈顶对应的文件；文件没了就作废整条栈，回到跟随编辑器 */
  private pinnedFile(): TFile | null {
    const top = topOf(this.navStack);
    if (!top) return null;
    const file = this.app.vault.getAbstractFileByPath(top.path);
    if (file instanceof TFile) return file;
    // 标签可能还在显示这个已删除的文件，交给 Obsidian 处理，这里不 detach
    this.resetNav();
    return null;
  }

  /** 点面包屑某一级：截断到它，导图换回那篇 */
  private goBackTo(index: number): void {
    const entry: NavEntry | undefined = this.navStack[index];
    if (!entry) return;

    const target = this.app.vault.getAbstractFileByPath(entry.path);
    if (!(target instanceof TFile)) {
      // 上级文件没了，这条路径没法还原：整条栈作废
      this.resetNav();
      this.refresh();
      return;
    }

    const back = planBack(this.navSync());
    const dropped: NavEntry[] = this.navStack.slice(index + 1);
    const shown: TFile | null = this.targetFile;

    // 同样先改「看哪篇」再动 leaf：关闭标签会触发 active-leaf-change，
    // 那一刻若 targetFile 还停在子笔记，导图会先闪回子笔记再跳到上级。
    this.keepViewport = true;
    this.navStack = truncateTo(this.navStack, index);
    this.targetFile = target;

    // 先关标签再切换：关闭会让活跃标签变化，顺序反了会把刚打开的那篇挤掉
    this.closeTracked(dropped);

    if (back.followCurrent) {
      // 「跟随当前窗口」：把正在看下级的那篇编辑器切回上级
      const leaf: WorkspaceLeaf | null = this.leafShowing(shown);
      if (leaf) this.openInLeaf(leaf, target);
    }

    this.renderBreadcrumb();
    this.refresh();
  }

  /**
   * 重画面包屑。
   *
   * 用 span 而不是 a：这是一级级往回退，不是打开新文档，
   * 用链接会被 Obsidian 的链接处理器接管。
   */
  private renderBreadcrumb(): void {
    const el = this.breadcrumbEl;
    if (!el) return;
    el.empty();
    el.toggleClass("is-hidden", this.navStack.length === 0);
    if (this.navStack.length === 0) return;

    el.setAttribute("title", "导图内的跳转路径：点前面任意一级返回");

    this.navStack.forEach((entry: NavEntry, i: number) => {
      if (i > 0) el.createSpan({ cls: "obmind-crumb-sep", text: "›" });
      const last: boolean = i === this.navStack.length - 1;
      const item = el.createSpan({ cls: "obmind-crumb", text: entry.title });
      item.toggleClass("is-current", last);
      item.setAttribute("aria-label", entry.path);
      item.setAttribute("title", last ? entry.path : `${entry.path}（点击返回）`);
      // 面包屑也是导航：钉住时只把笔记窗口切到那一级，导图不动（见 navigate）。
      // 非钉住仍走 goBackTo —— 它要裁剪栈、按策略关掉当初为下级开的标签，
      // 这些都不是「打开一个文件」能覆盖的。
      if (!last) {
        item.addEventListener("click", () => {
          if (this.pinned) {
            const dest = this.app.vault.getAbstractFileByPath(entry.path);
            if (dest instanceof TFile) this.openFileOnly(dest);
            return;
          }
          this.goBackTo(i);
        });
      }
    });

    // 当前项永远在最后。路径一长默认滚到最左，用户只看得到最早的几级 ——
    // 滚到最右，让「我现在在哪」始终可见。
    el.scrollLeft = el.scrollWidth;
  }

  /**
   * 选中一个节点。
   *
   * 选中态记的是**源行号**而不是 DOM 引用：每次 setData 之后 g 元素都是新的一批，
   * 存引用等于存了个已经断掉的东西。行号在重建后仍然有效，重新挂 class 就行。
   */
  private selectNode(g: SVGGElement | null): void {
    const line: number = g ? (this.srcOf(g)?.line ?? -1) : -1;
    this.selectedLine = line;
    this.anchorLine = line;
    // 画布拿到焦点，后面的 Tab / Enter 才有人接
    this.canvasEl?.focus({ preventScroll: true });
  }

  /**
   * 选中某一源行对应的节点，并把它带进视野。
   *
   * 键盘换选中必须顺手滚一下视图：连着按十几下方向键之后，选中框很可能已经在
   * 画布外面了 —— 屏幕上看不出选中到了哪，等于键盘没法用。
   * `ensureVisible` 只在节点真的出去时才平移，不会每按一下都把画面拽动一次。
   */
  private selectByLine(line: number): void {
    const g = this.findNodeByLine(line);
    if (!g) return;
    this.selectNode(g);

    const data = (g as SVGGElement & { __data__?: INode }).__data__;
    if (!data || !this.mm) return;
    const pad = 32;
    void this.mm
      .ensureVisible(data, { left: pad, right: pad, top: pad, bottom: pad })
      .catch(() => undefined);
  }

  /**
   * 选中一个节点 → 把左侧那篇笔记滚到它所在的行（设置项 `syncNoteLine`）。
   *
   * 三个「不跳」都是刻意留白的：
   * - 找不到这篇笔记的编辑器（笔记关掉了 / 只有导图标签）：静默放过，
   *   不为了跳一下去开标签 —— 那会把用户的分屏布局改掉；
   * - 阅读模式没有可滚动的位置（CM 实例是隐藏的）：调用无害，滚动不生效；
   * - 同一个行号已经跳过：`paintSelection` 在每次重建后都会走一遍，
   *   不去重的话「改一个字 → 整篇重排 → 编辑器又被拽回那一行」。
   *
   * 光标会跟着移动，但**不抢焦点**：抢了之后方向键就落进编辑器，
   * 导图的键盘导航当场失效（而选中的第一反应往往就是接着按方向键）。
   */
  private revealNoteLine(line: number): void {
    if (!this.plugin.settings.syncNoteLine) return;
    if (line < 0) return;
    const file: TFile | null = this.targetFile;
    if (!file || file.extension !== "md") return;

    const key: string = `${file.path}:${line}`;
    if (key === this.revealedKey) return;

    const editor: Editor | null = findEditor(this.app, file);
    if (!editor) return;

    const last: number = Math.max(0, editor.lineCount() - 1);
    const at: number = Math.min(Math.max(0, line), last);
    this.revealedKey = key;

    try {
      const from: EditorPosition = { line: at, ch: 0 };
      const to: EditorPosition = { line: at, ch: editor.getLine(at).length };
      // 第二个参数 true = 居中（默认是「露出来就行」，行贴着底边看着像没跳到位）
      editor.scrollIntoView({ from, to }, true);
      editor.setCursor(from);
    } catch (err) {
      // 编辑器可能正在切换文件 / 已被回收：跳转失败不该影响导图本身
      console.warn("[obmind] 同步笔记行号失败", err);
    }
  }

  /**
   * 方向键导航：两条轴各管一件事。
   *
   * 上下只走**末端节点**（没有孩子的、或折叠了的）：折叠的子树在屏幕上不存在，
   * 让选中跳进去就是「按一下方向键，选中框凭空消失」；而中间那些带分支的容器
   * 节点也不进这条序列 —— 上下要是能落到「B」这种还有子级的分支上，看起来就跟
   * 在大纲里跳行不是一回事。层级只由左右负责。
   *
   * 起点本身不是末端（点中了一个分支标题、或按 ← 从子级退回来）时，上下按行号
   * 找它之后 / 之前的第一个末端，所以不会是「按了没反应」。
   *
   * 序列本身由 `domain/nav.ts` 的纯函数算，用 Node 跑用例即可，不必等 DOM。
   *
   * 右侧遇到折叠的父节点：先展开再进长子。否则按右毫无反应，用户只能去点圆点。
   */
  private moveSelection(key: string): void {
    const snap = this.editSnapshot();
    if (!snap) return;
    const cur: number = this.primaryLine;

    if (key === "ArrowLeft") {
      // 父节点是根（文件名）时不动：根既不能编辑也不能删，选中它只是让
      // 操作条上的按钮全部变灰。
      const parent: number = cur >= 0 ? this.editSvc.parentLineOf(snap, cur) : -1;
      if (parent >= 0) this.selectByLine(parent);
      return;
    }

    if (key === "ArrowRight") {
      if (cur < 0) return;
      const child: SrcRef | null = firstChildRef(snap.nodes, cur);
      if (!child) return;
      if (this.findNodeByLine(child.line)) this.selectByLine(child.line);
      else void this.expandInto(cur, child.line);
      return;
    }

    const refs: SrcRef[] = visibleLeafRefs(
      this.mm?.state.data as unknown as NavNode | undefined,
    );
    const next: SrcRef | null = stepVisible(refs, cur, key === "ArrowDown" ? 1 : -1);
    if (next) this.selectByLine(next.line);
  }

  /** 展开某个节点、再选中它的长子（右侧遇到折叠时用） */
  private async expandInto(line: number, childLine: number): Promise<void> {
    const g = this.findNodeByLine(line);
    const data = g ? (g as SVGGElement & { __data__?: INode }).__data__ : undefined;
    if (!data || !this.mm) return;

    const fold = data.payload?.fold;
    if (typeof fold !== "number" || fold <= 0) return;
    // toggleNode 是 markmap 自己折叠圆点走的那条路：就地改 payload.fold 再重排，
    // 不去碰笔记。await 之后子节点的 DOM 才存在。
    await this.mm.toggleNode(data);
    this.selectByLine(childLine);
  }

  /** 直接设定整组选中（框选结果）；additive=true 时并入现有集合。 */
  private applySelection(lines: number[], primary: number, additive: boolean): void {
    if (!additive) this.selectedLines.clear();
    for (const l of lines) if (l >= 0) this.selectedLines.add(l);
    this.primaryLine =
      primary >= 0 ? primary : this.selectedLines.size ? Math.max(...this.selectedLines) : -1;
    // 整组替换后，锚点跟着新的主选中走 —— 否则接着 Shift 单击会从一个
    // 早就不在选中集里的老节点开始算区间
    this.anchorLine = this.primaryLine;
    this.paintSelection();
    this.syncToolbar();
  }

  /**
   * Ctrl/⌘ + 单击：在选中集合里加一个 / 去掉一个。
   *
   * 去掉时不改锚点（用户是在「剔除」，没在指定新的起点）；
   * 加入时把锚点挪到它上面，这样「Ctrl 点一圈、再 Shift 拉区间」的直觉成立。
   */
  private toggleSelection(line: number): void {
    if (line < 0) return;
    if (this.selectedLines.has(line)) {
      this.selectedLines.delete(line);
      // 剔掉的正好是主选中：主选中退到剩下里行号最大的那个，操作条跟着走
      if (this.primaryLine === line) {
        this.primaryLine = this.selectedLines.size ? Math.max(...this.selectedLines) : -1;
      }
    } else {
      this.selectedLines.add(line);
      this.primaryLine = line;
      this.anchorLine = line;
    }
    this.paintSelection();
    this.syncToolbar();
  }

  /**
   * 某个节点所在「同级组」的全部行号（按文档顺序）。
   *
   * 判定只看 depth：从自己往前扫，比它浅的那一行就是父节点，组从这里开始；
   * 往后扫到第一个比它浅的为止。同级之间夹着的后代（depth 更深）会被跳过，
   * 但不影响组的边界 —— 这正是「同层兄弟」的定义。
   */
  private siblingLines(line: number): number[] {
    const nodes = this.snapshot?.nodes;
    if (!nodes) return [line];
    const at: number = nodes.findIndex((n) => n.line === line);
    if (at < 0) return [line];
    const depth: number = nodes[at].depth;

    let start = at;
    while (start > 0 && nodes[start - 1].depth >= depth) start--;
    let end = at;
    while (end + 1 < nodes.length && nodes[end + 1].depth >= depth) end++;

    const out: number[] = [];
    for (let i = start; i <= end; i++) {
      if (nodes[i].depth === depth) out.push(nodes[i].line);
    }
    return out.length ? out : [line];
  }

  /**
   * Shift + 单击：选中「锚点 → 这一下」之间的同层节点。
   *
   * 只处理同级区间（文件管理器的多选就是这么用的）。锚点不在同一组时
   * （比如锚点在另一根分支上），退化成「只选这个」并把它设为新锚点 ——
   * 跨父节点的区间没有明确含义，猜一个反而更像 bug。
   *
   * @param additive 同时按着 Ctrl/⌘：区间并入现有选中，不替换
   */
  private selectSiblingRange(line: number, additive: boolean): void {
    if (line < 0) return;
    const group: number[] = this.siblingLines(line);
    const from: number = group.indexOf(this.anchorLine);
    const to: number = group.indexOf(line);

    if (from < 0 || to < 0) {
      this.applySelection([line], line, additive);
      return;
    }
    // 锚点在算完区间后要原样留着：区间选择是「锚点不动、尾巴随便点」，
    // 每按一次 Shift 都从同一个起点重算。applySelection 会把锚点挪到新的
    // 主选中上（框选那条路需要），所以这里存一下再放回去。
    const anchor: number = this.anchorLine;
    const lo: number = Math.min(from, to);
    const hi: number = Math.max(from, to);
    // 主选中 = 这一下点中的那个（浮动条挂它，跟着鼠标走）
    this.applySelection(group.slice(lo, hi + 1), line, additive);
    this.anchorLine = anchor;
  }

  /**
   * 把选中态刷到当前 DOM 上：所有在 selectedLines 里的节点都加 obmind-selected 类。
   *
   * 浮动条只在**单选**时出现（它是画布右侧的固定操作区，不再跟着节点跑）。
   * 那几个按钮（子 / 同 / 改 / 提 / 删）语义都是「对这一个节点」：作用到一堆节点上，
   * 改文字没意义、删除是灾难。框选完一排卡片之后还留着一排按钮，看起来就像
   * 「这些操作会作用于全部」—— 批量操作是另一套（整块拖动、批量删除走键盘），
   * 不给一个含糊的入口。
   */
  private paintSelection(): void {
    const svg = this.svgEl;
    if (svg) {
      const sel = this.selectedLines;
      // 「结构代数 + 选中集合」都没变 → DOM 上的 class 一定是上一次写下的状态，
      // 一个都不用碰。这条早退是空转 refresh（plan 判 none）唯一的成本来源：
      // 250 次 querySelectorAll 迭代 + 250 次 srcOf + 250 次 classList.toggle。
      const key = `${this.structureGen}|${Array.from(sel).sort((a, b) => a - b).join(",")}`;
      if (key === this.selectionKey) {
        this.nodeBar?.setVisible(sel.size === 1);
        return;
      }
      this.selectionKey = key;
      for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
        const on: boolean = sel.has(this.srcOf(g)?.line ?? -1);
        g.classList.toggle("obmind-selected", on);
      }
    }
    this.nodeBar?.setVisible(this.selectedLines.size === 1);
    // 选中 → 笔记跟随（设置项 syncNoteLine）。只在单选时跳：框选一整片
    // 还把编辑器拽来拽去，等于让人对着滚动的文档猜自己选了什么。
    if (this.selectedLines.size === 1) this.revealNoteLine(this.primaryLine);
  }

  /**
   * 只修指定节点的选中 class。
   *
   * 由 MutationObserver 在「markmap 重写了节点 class」时调用：它重排一次就把
   * `obmind-selected` 抹掉，而内存里的选中态还在 —— 用户看到的是选中框凭空消失。
   * 这里只补「本该选中、现在没有」的节点；classList.toggle 写同值不产生新记录，
   * 不会和观察器互相触发。
   */
  private paintSelectionOn(els: Iterable<SVGGElement>): void {
    const sel = this.selectedLines;
    for (const g of els) {
      if (!g.isConnected) continue;
      const on: boolean = sel.has(this.srcOf(g)?.line ?? -1);
      if (on === g.classList.contains("obmind-selected")) continue;
      g.classList.toggle("obmind-selected", on);
    }
  }

  /**
   * 画布上的键盘操作。
   *
   * 现在只剩三道闸门，具体键位全部在 `app/actions.ts` 的 ACTIONS 表里：
   * - 事件目标必须是画布本身：编辑框也在画布内部，它的 Tab / Enter 不能被我截走；
   * - 输入法组字期间（e.isComposing）一律放行，否则中文拼音的回车会被当成「新建」；
   * - 相位必须是 idle —— 由 matchAction 统一挡（编辑中 / 拖动中 / 重建中都不接）。
   *
   * 把「哪个键做什么」搬出去的理由：同一张表还要服务视图层兜底（焦点跑到 body 时）、
   * 以后的工具栏按钮和命令面板；写在 if 链里就只能服务一个入口，而且两条链的
   * 判据迟早会不一致（画布那条以前就没看相位，重建中按 Tab 会用旧快照建节点）。
   */
  private onCanvasKeyDown(e: KeyboardEvent): void {
    if (e.target !== this.canvasEl) return;
    if (e.isComposing) return;

    const id: ActionId | null = matchAction(e, "canvas", this.actionState());
    if (!id) return;
    // Esc 不拦默认：它在 Obsidian 里还有「退全屏 / 关面板」的意思，抢了就是 bug
    if (id !== "escape") {
      e.preventDefault();
      e.stopPropagation();
    }
    this.runAction(id);
  }

  /**
   * 动作状态快照。
   *
   * 每次按键现算，不缓存：相位和选中集合都是「这一刻」的事，缓存旧值比不判更糟。
   * `onBlock` 必须现查节点 —— 块是只读叶子，所有写入类动作都靠它让路。
   */
  private actionState(): ActionState {
    const line: number = this.primaryLine;
    const at = line >= 0 ? this.nodeAt(line) : null;
    return {
      phase: this.rt.phase,
      primary: line,
      selectionSize: this.selectedLines.size,
      onBlock: at?.blockNode !== undefined,
      hasFile: this.targetFile !== null,
    };
  }

  /**
   * 动作 id → 真正干活。
   *
   * 这是「加一个新操作的第二处」：ACTIONS 里加一行键位，这里加一个 case。
   * 相位 / 块 / 有没有选中这些前置条件不在每个 case 里重判 —— 已经由
   * `matchAction` 的 `when` 挡过一遍，这里只回答「能做之后怎么做」。
   */
  private runAction(id: ActionId): void {
    switch (id) {
      case "undo":
        void this.stepHistory("undo");
        return;
      case "redo":
        void this.stepHistory("redo");
        return;
      case "newChild":
        this.createNode("child");
        return;
      case "newSibling":
        this.createNode("sibling");
        return;
      case "outdent":
        this.outdentSelected();
        return;
      case "remove":
        this.removeNode();
        return;
      case "edit": {
        const line: number = this.primaryLine;
        if (line < 0) return;
        const g = this.findNodeByLine(line);
        if (g) this.startEdit(g);
        return;
      }
      case "escape": {
        // 帮助面板盖在画布上，先收它更符合直觉
        if (this.helpPanel && !this.helpPanel.hasClass("is-hidden")) {
          this.helpPanel.addClass("is-hidden");
          return;
        }
        this.applySelection([], -1, false);
        return;
      }
      case "navUp":
        this.moveSelection("ArrowUp");
        return;
      case "navDown":
        this.moveSelection("ArrowDown");
        return;
      case "navLeft":
        this.moveSelection("ArrowLeft");
        return;
      case "navRight":
        this.moveSelection("ArrowRight");
        return;
      case "newNote":
        void this.createNoteForSelected();
        return;
      case "paste":
        void this.pasteIntoSelected();
        return;
      // 一档 ≈ 1.2 倍：和鼠标滚轮一格的幅度接近，连按几下不会一下冲出可视区
      case "zoomIn":
        this.zoomBy(1.2);
        return;
      case "zoomOut":
        this.zoomBy(1 / 1.2);
        return;
      case "zoomFit":
        this.fitView();
        return;
    }
  }

  /**
   * 视图内的兜底按键（焦点不在画布上时）。
   *
   * 为什么还要第二层：画布的 keydown 要求 `target === canvas`，而焦点很容易不在那儿 ——
   * 点过工具栏图标、点过面包屑、一轮重建之后焦点落到 body，这些时候按空格本意都是
   * 「改这个节点的字」，收不到就是「按了没反应」。
   *
   * 这一层必须先让路给输入控件：编辑框 / 按钮里的空格是打字或「按下按钮」的
   * 无障碍语义，抢过来就是 bug。键位仍然查同一张表（scope = "view"）。
   */
  private onViewKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    if (isTypingTarget(e.target)) return;

    const id: ActionId | null = matchAction(e, "view", this.actionState());
    if (!id) return;
    // Esc 的兜底在 onGlobalKeyDown：那里刻意不拦默认、也不阻断冒泡
    if (id === "escape") return;

    e.preventDefault();
    // 空格必须拦默认：否则会把页面 / 侧栏往下滚一格，编辑框跟着跳
    e.stopPropagation();
    this.runAction(id);
  }

  /**
   * Ctrl/⌘ + N：给选中节点建笔记。
   *
   * 这个组合在 Obsidian 里是「新建笔记」，导图里必须抢过来并拦住默认行为 ——
   * 否则会先在别处开出一篇空笔记，用户还得自己关掉。
   *
   * @returns 是否已经消费这次按键
   */
  private tryNewNoteHotkey(e: KeyboardEvent): boolean {
    if (e.isComposing) return false;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
    if (e.code !== "KeyN" && e.key.toLowerCase() !== "n") return false;
    // 编辑框 / 输入控件里，Ctrl+N 仍归 Obsidian 自己
    if (isTypingTarget(e.target)) return false;

    e.preventDefault();
    e.stopPropagation();
    void this.createNoteForSelected();
    return true;
  }

  /**
   * 导图视图内的全局热键（目前只有 Ctrl/⌘+N），挂在 document 捕获阶段。
   *
   * 只在焦点确实在这个视图里时才接管：别处的 Ctrl+N 仍归 Obsidian 的新建笔记。
   * 与 onViewKeyDown 里的同名分支并存不冲突 —— 这里先跑并 stopPropagation，
   * 那边第一行就因 defaultPrevented 退出了。
   */
  private onHotkeyCapture(e: KeyboardEvent): void {
    if (this.rt.phase !== "idle") return;
    const target = e.target;
    if (!(target instanceof Node) || !this.containerEl.contains(target)) return;
    this.tryNewNoteHotkey(e);
  }

  /**
   * 焦点不在画布上时的 Esc 兜底。
   *
   * 只做两件事：收起帮助面板、取消选中。**不拦默认行为也不阻断冒泡** ——
   * Obsidian 自己的 Esc（关模态、退全屏）要继续工作，抢了就成 bug。
   * 画布内部的按键仍由 onCanvasKeyDown 处理，这里直接让路。
   */
  private onGlobalKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // 编辑框里的 Esc 是「撤销这次编辑」，交给 inlineText 自己处理
    if (this.rt.phase === "editing") return;
    if (this.canvasEl && e.target instanceof Node && this.canvasEl.contains(e.target)) return;

    if (this.helpPanel && !this.helpPanel.hasClass("is-hidden")) {
      this.helpPanel.addClass("is-hidden");
      return;
    }
    if (this.selectedLines.size > 0) this.applySelection([], -1, false);
  }

  /**
   * 浮动条上的「插入块」：弹一个小菜单选类型。
   *
   * 为什么不排三个图标：浮动条只有一行，窄侧栏（240px）里多三个图标就直接溢出画布。
   * 菜单锚在按钮正下方 —— 用按钮自己的 rect 而不是鼠标位置，键盘/触控板点也一样。
   */
  private openBlockMenu(): void {
    const line: number = this.selectedLine;
    if (line < 0) return;
    const anchor = this.nodeBar?.el.querySelector<HTMLElement>('[data-action="block"]');
    const rect: DOMRect | null = anchor ? anchor.getBoundingClientRect() : null;
    if (!rect || rect.width < 1) return;

    const menu = new Menu();
    const add = (title: string, icon: string, kind: BlockKind, lang?: string): void => {
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon(icon)
          .onClick(() => this.insertBlock(kind, lang)),
      );
    };
    // 记住上次的语言：绝大多数人一段笔记里只写一种语言，这里一键就够
    const lang: string = lastCodeLang();
    add(`代码块 · ${lang}`, "code", "code", lang);
    menu.addItem((item) =>
      item
        .setTitle("代码块（换语言）…")
        .setIcon("languages")
        .onClick(() => this.pickCodeLang()),
    );
    add("引用", "quote", "quote");
    add("表格", "table", "table");
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4, width: rect.width });
  }

  /**
   * 选一个代码块语言再插入：菜单里「换语言」走这条路。
   *
   * 行号先抓在手里：弹 Modal 会让画布失焦，选中集可能被清掉，
   * 等用户选完语言再去读 selectedLine 就是 -1 了。
   */
  private pickCodeLang(): void {
    const line: number = this.selectedLine;
    if (line < 0) return;
    new CodeLangModal(this.app, (lang: string) => {
      rememberCodeLang(lang);
      this.insertBlockAt(line, "code", lang);
    }).open();
  }

  private insertBlock(kind: BlockKind, lang?: string): void {
    this.insertBlockAt(this.selectedLine, kind, lang);
  }

  /**
   * 在指定节点下面插入一个块。
   *
   * 块是**宿主的子节点**（独立节点、只读），不是卡片里多一行 —— 见 types.ts 的 BlockInfo。
   * 写完不动选中框：用户多半接着操作同一个节点。
   */
  private insertBlockAt(line: number, kind: BlockKind, lang?: string): void {
    if (line < 0) {
      new Notice("obmind：先选中一个节点");
      return;
    }
    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return;

    const at = this.nodeAt(line);
    if (at?.blockNode) {
      new Notice("obmind：块是只读叶子，不能在它下面再插块");
      return;
    }
    const out = this.editSvc.insertBlock({ snap, line, kind, lang });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return;
    }
    if (out.kind === "none") return;
    void this.applyPlan(file, out.op);
  }

  /** 在选中节点上新建同级 / 子级，写完立刻把编辑框落到新行上 */
  private createNode(mode: "sibling" | "child"): void {    const line: number = this.selectedLine;
    if (line < 0) {
      new Notice("obmind：先左键点一下要挂在哪个节点上");
      return;
    }
    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return;

    const at = this.nodeAt(line);
    if (at?.blockNode) {
      new Notice("obmind：块是只读叶子，不能在它下面建节点");
      return;
    }
    const out = this.editSvc.create({ snap, line, mode });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return;
    }
    if (out.kind === "none") return;

    if (out.focusLine !== undefined) {
      this.pendingEditLine = out.focusLine;
      this.selectedLine = out.focusLine;
    }
    void this.applyPlan(file, out.op);
  }

  /**
   * Ctrl+V：把剪贴板内容粘成选中节点的子节点。
   *
   * 与新建的区别是**不自动进编辑框** —— 内容已经是用户想要的，再弹一个全选的
   * 输入框只会让人多按一次 Esc。粘完把选中落在第一个新节点上，想接着加就在它
   * 下面按 Tab。
   */
  private async pasteIntoSelected(): Promise<void> {
    const line: number = this.primaryLine;
    if (line < 0) return;
    await this.pasteAt(line);
  }

  /**
   * 把剪贴板内容粘到 `line` 这个节点下面。
   *
   * 读剪贴板是这条链上唯一的 await IO，回来时世界可能已经变了，所以有两个复查点：
   * 1. 读完先看相位与行号 —— 期间用户可能切了节点、进了编辑、或触发了一轮重建；
   * 2. 写入仍走 runWrite，与所有其它写路径共用锚点校验（行号漂了就失败，不会写错）。
   */
  private async pasteAt(line: number): Promise<void> {
    const file = this.targetFile;
    if (!file) {
      new Notice("obmind：没有打开的笔记");
      return;
    }
    if (this.rt.phase !== "idle") return;

    const text: string = await this.clipboard.readText();
    if (!text.trim()) {
      new Notice("obmind：剪贴板是空的（或没有读取剪贴板的权限）");
      return;
    }
    // 读的过程中可能已经切走：宁可什么都不做，也不要粘到「现在选中的那一行」上
    if (this.rt.phase !== "idle" || this.primaryLine !== line) return;

    const snap = this.editSnapshot();
    if (!snap) return;

    const out = this.editSvc.paste({ snap, line, text });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return;
    }
    if (out.kind === "none") return;

    if (out.notice) new Notice(`obmind：${out.notice}`);
    if (out.focusLine !== undefined) {
      // 粘贴后选中第一个新节点，但**不**打开编辑框
      this.pendingEditLine = -1;
      this.selectedLine = out.focusLine;
    }
    void this.applyPlan(file, out.op);
  }

  /**
   * 删除选中节点及其子树（Delete / Backspace）。
   *
   * 删完把选中挪到父节点上：行号在删除后往前挪，但父节点在删除行之前，
   * 所以它的行号不变，可以直接定位。这样才能连着删兄弟节点。
   */
  private removeNode(): void {
    const selected: number[] = [...this.selectedLines].filter((l) => l >= 0);
    if (selected.length === 0) return;

    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return;

    const out = this.editSvc.removeGroup({ snap, lines: selected });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return;
    }
    if (out.kind === "none") return;

    // 选中交给父节点：删除后行号整体前移，选中框要么消失、要么指到别人身上，
    // 用户看到的是「删完一个就断了，得重新点」。父节点在删除区间之前，
    // 行号不受影响，直接用它恢复选中框（没有父节点 = 删的是顶层，就取消选中）。
    this.pendingEditLine = -1;
    const focus: number | undefined = out.focusLine;
    if (focus !== undefined && focus >= 0) this.applySelection([focus], focus, false);
    else this.applySelection([], -1, false);
    void this.applyPlan(file, out.op);

    if (selected.length > 1) {
      new Notice(`obmind：已删除 ${selected.length} 个节点`);
    }
  }

  /** 双击节点进入原地编辑 */
  private onNodeDblClick(e: MouseEvent): void {
    const target = e.target as Element;
    // 双链上双击是选中文字，不接管
    if (target.closest("a")) return;
    // 折叠圆点交给 markmap
    if (target.closest("circle")) return;

    // 块里的文字要能双击选词、复制：不接管，也不进编辑态
    if (target.closest(".obmind-block-md")) return;

    const g = target.closest("g.markmap-node") as SVGGElement | null;
    if (!g) return;

    e.preventDefault();
    e.stopPropagation();

    // 正在编辑上一个节点、或正在重建时，双击另一个节点不能被丢掉：
    // 记下目标行号，等这一轮提交+重建跑完自动接上。
    // 否则「改完一个想接着改下一个」点过去毫无反应，就是没法连着编辑。
    if (this.rt.phase !== "idle") {
      const pendingLine: number | undefined = this.srcOf(g)?.line;
      if (pendingLine !== undefined) this.pendingEditLine = pendingLine;
      return;
    }

    this.startEdit(g);
  }

  /**
   * 拖拽落下：把「移动」交给 EditService，产出整篇重写的写入计划。
   *
   * 为什么不能走行区间替换：一行会被搬到很远的位置，中间所有行号都会变。
   * 分成「先删后插」两次写，中间那一瞬间笔记就是坏的（节点丢一半）。
   *
   * @returns 是否真的发出了写入（拖动块要不要留在鼠标位置等重建，看这个）
   */
  private onNodeDrop(srcLines: number[], targetLine: number, mode: DropMode): boolean {
    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return false;

    // Bug 2 修复：多行合并节点暂不支持拖动（续行写回会错位），请在笔记里调整层级。
    for (const srcLine of srcLines) {
      const dragSrc = this.nodeAt(srcLine);
      if (!dragSrc) continue;
      // 裸块没有代理行，拖动会把围栏缩进到 4 格以上，整段代码变成字面量。
      // （自由块可以拖，但拖的是代理行 —— 见 frozenIn。）
      if (dragSrc.blockNode === "bound") {
        new Notice("obmind：这个块不能拖动 —— 在它上面加一行 <!-- obmind:block --> 就能拖了");
        return false;
      }
      // 自由块天生跨多行（代理行 + 块本体），不能再按「软换行节点」拦一次
      if (dragSrc.blockNode) continue;
      if (dragSrc.endLine !== undefined && dragSrc.endLine > dragSrc.line) {
        new Notice("obmind：多行节点暂不支持拖动，请在笔记里调整层级");
        return false;
      }
    }

    const out =
      srcLines.length === 1
        ? this.editSvc.move({ snap, srcLine: srcLines[0], targetLine, mode })
        : this.editSvc.moveGroup({ snap, srcLines, targetLine, mode });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return false;
    }
    if (out.kind === "none") return false;

    void this.applyPlan(file, out.op);
    return true;
  }

  /**
   * 给定节点行号，返回拖动时应一起移动的行号集合：
   * 若该节点属于 size>1 的选中集，取选中集里所有「不被其它选中节点子树覆盖」的顶层成员；
   * 否则只返回它自己。
   */
  private groupOf(line: number): number[] {
    const snap = this.editSnapshot();
    if (!snap || this.selectedLines.size <= 1 || !this.selectedLines.has(line)) return [line];
    const nodes = snap.nodes as SrcRef[];
    const selected = [...this.selectedLines];
    const keep: number[] = [];
    for (const s of selected) {
      const si = nodes.findIndex((n) => n.line === s);
      if (si < 0) continue;
      const end: number = blockRange(nodes, si).end;
      const covered: boolean = selected.some((o) => o !== s && o > s && o <= end);
      if (!covered) keep.push(s);
    }
    return keep.length ? keep : [line];
  }

  /** 执行写入计划并刷新（拖动、新建节点这类不属于编辑框的操作走这里） */
  private async applyPlan(file: TFile, op: WriteOp): Promise<void> {
    try {
      const res = await this.runWrite(file, op);
      // 直接把刚写完的内容交给 refresh：不依赖读回结果，
      // 编辑器缓冲还没落盘时也能立刻重建（否则要手动点刷新）。
      if (res.ok) this.refresh(res.next);
    } catch (err) {
      console.error("[obmind] 写入失败", err);
      new Notice("写入失败，详见控制台。");
    }
  }

  /** 从节点的绑定数据里取源行坐标 */
  private srcOf(g: SVGGElement): SrcRef | null {
    const data = (g as SVGGElement & { __data__?: INode }).__data__;
    const src = data?.payload?.src as SrcRef | undefined;
    return src && typeof src.line === "number" ? src : null;
  }

  /** 找到渲染在指定源行上的节点（新建节点后定位用） */
  private findNodeByLine(line: number): SVGGElement | null {
    const svg = this.svgEl;
    if (!svg) return null;
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      if (this.srcOf(g)?.line === line) return g;
    }
    return null;
  }

  /**
   * 打开原地编辑框；根节点（文件名）不可编辑。
   *
   * 打开即**全选**，不管从哪条路进来（双击 / Enter / F2 / 空格 / 新建节点）。
   * 理由：节点的「改字」几乎总是整体重写（一句话重打一遍），而不是在某个字
   * 后面插一个字。带选区进来时，第一个字符就直接覆盖全部，和 XMind 一致；
   * 想插字的话按一下 ←/→ 或者点一下就能把选区收掉，代价比「先全选」小得多。
   *
   * 曾经只有「新建节点」传 selectAll，其余路径把光标放在末尾 —— 用户反馈
   * 「点开编辑还要自己先 Ctrl+A」，这正是本轮要求的来源。
   */
  private startEdit(g: SVGGElement): void {
    if (this.rt.phase === "editing" || !this.canvasEl) return;

    // 重建正在进行时会把这个 g 换掉，等这一轮跑完再按行号重新定位
    if (this.rt.phase === "rebuilding") {
      const pendingLine: number | undefined = this.srcOf(g)?.line;
      if (pendingLine !== undefined) {
        window.setTimeout(() => {
          const next = this.findNodeByLine(pendingLine);
          if (next) this.startEdit(next);
        }, 80);
      }
      return;
    }
    if (!g.isConnected) return;

    const data = (g as SVGGElement & { __data__?: INode }).__data__;
    const src = this.srcOf(g);
    // 根节点没有 src；折叠起来的节点不渲染，也不会有 DOM
    if (!src || data?.state?.depth === 0) return;

    // 块是只读的：它的卡片是 MarkdownRenderer 渲染出来的 HTML，双击进去改字
    // 等于把一段 HTML 当正文写回笔记。要改就回笔记里改。
    if (src.blockNode) {
      new Notice("obmind：块是只读的，请回笔记里改");
      return;
    }

    // Bug 2 修复：多行合并节点（软换行）在 UI 里只读，请在笔记中编辑，
    // 避免续行被单独写回、把节点拆坏。
    if (src.endLine !== undefined && src.endLine > src.line) {
      new Notice("obmind：多行节点请在笔记中编辑");
      return;
    }

    const spec: ThemeSpec =
      this.currentSpec ?? resolveTheme(this.plugin.settings.theme, false);
    const value: string = this.editorValueOf(src);
    this.traceEditValue(g, src, value);

    this.rt.setPhase("editing");
    const handle = openInlineEditor({
      container: this.canvasEl,
      target: g,
      value,
      spec,
      selectAll: true,
      onFinish: (action: EditorAction, text: string) => {
        this.editorHandle = null;
        void this.commitEdit(action, text, src);
      },
    });

    if (!handle) {
      this.rt.setPhase("idle");
      return;
    }
    this.editorHandle = handle;
  }

  /**
   * 「点开编辑，看到的是上一次的文字」这条 bug 的自检。
   *
   * 编辑框的初始值来自 `payload.src.text`，而用户看到的是卡片里**渲染后的**文字。
   * patch 通道（只改 innerHTML、不重建树）最容易让这两者脱节 —— 1.18.5 之前
   * 就漏了回写 src，症状是「卡片明明已经是新内容，点开却是旧内容」。
   * 与其等下一次现场复现，不如每次打开编辑框都比一次，对不上就直接写进日志。
   */
  private traceEditValue(g: SVGGElement, src: SrcRef, value: string): void {
    if (!isTracing()) return;
    const box = g.querySelector<HTMLElement>("foreignObject > div > div");
    let card = "";
    if (box) card = normalizeLabel(box.textContent ?? "");
    const editor = normalizeLabel(value);
    const stale: boolean = card !== "" && editor !== "" && card !== editor;
    // traceLog("edit.value", {
    //   line: src.line,
    //   val: editor.slice(0, 12),
    //   stale,
    //   card: stale ? card.slice(0, 12) : undefined,
    // });
  }

  /**
   * 编辑结束后：交给 EditService 算出写入计划 → 写文件 → 重建导图。
   *
   * 视图这里只剩三件事：准备快照、拿计划、执行计划。
   * 「改一个字该动哪几行」全部在 app/EditService.ts 里，能单独跑用例断言。
   */
  private async commitEdit(
    action: EditorAction,
    value: string,
    src: SrcRef,
  ): Promise<void> {
    let next: string | undefined;
    /** 「提交即预览」的撤销句柄：写失败/计划作废时把 DOM 还原成旧内容 */
    let revertPreview: (() => void) | null = null;
    try {
      // 提交链路的每一步都留痕：现场「输入完按回车却什么都没写」最难查 ——
      // 屏幕上没变化时，用户说不清是没提交、被判成「没变」、还是写失败。
      // traceLog("edit.commit", {
      //   act: action,
      //   line: src.line,
      //   val: value.slice(0, 12),
      //   same: value === this.editorValueOf(src),
      // });
      if (action === "cancel") return;

      const file = this.targetFile;
      const snap = this.editSnapshot();
      if (!file || !snap) {
        // traceLog("edit.commit.nosnap", { file: Boolean(file), snap: Boolean(snap) });
        return;
      }

      // 先把结果画上去，再去写文件。
      //
      // 编辑框一关，节点文字会退回**旧内容**等写入完成（一次 vault 事务通常十几毫秒，
      // 赶上编辑器里还有未落盘的改动会更久），然后才跳到新内容 —— 眼睛看到的就是
      // 「按完回车，字闪一下」。XMind 这类编辑器是当场改的，写盘在背后跑；
      // 这里同样：先用同一个 inline 渲染器把新文字铺上去，写完的真实投影到达时
      // 内容已经一致（applyPatch 会跳过重复赋值），视觉上零切换。
      revertPreview = this.previewText(src, value);

      const out = this.editSvc.commit({ snap, src, action, value });
      if (out.kind === "error") {
        revertPreview?.();
        revertPreview = null;
        this.pendingEditLine = -1;
        // traceLog("edit.commit.error", { reason: out.reason });
        new Notice(`obmind：${out.reason}`);
        return;
      }
      if (out.kind === "none") {
        // 计划说「不用写」：预览得撤回去，否则会和真实内容对不上。
        // 「输入了内容却没写进去」就是这个分支 —— 日志里能直接看到当时的值，
        // 对照 `edit.value`（编辑框打开时的初始值）就知道是不是值本身没变。
        revertPreview?.();
        revertPreview = null;
        // traceLog("edit.commit.none", { line: src.line, val: value.slice(0, 12) });
        return;
      }

      if (out.focusLine !== undefined) this.pendingEditLine = out.focusLine;
      const res = await this.runWrite(file, out.op);
      next = res.next;
      // traceLog("edit.commit.ok", { line: src.line, ok: res.ok });
      if (!res.ok) revertPreview?.();
      revertPreview = null;
    } catch (err) {
      revertPreview?.();
      revertPreview = null;
      this.pendingEditLine = -1;
      // traceLog("edit.commit.throw", { msg: errText(err).slice(0, 40) });
      console.error("[obmind] 写回笔记失败", err);
      new Notice("写回笔记失败，详见控制台。");
    } finally {
      this.editorHandle = null;
      // 退出编辑态：runtime 会把编辑期间挂起的刷新请求自动补跑，
      // 这里再显式请求一次，保证刚写进编辑器缓冲的内容立刻反映到导图上。
      this.rt.setPhase("idle");
      this.refresh(next);
      // Bug 1 修复：编辑框移除后把焦点交还给画布，否则下一次 Enter/Tab
      // 因 e.target !== canvas 被 onCanvasKeyDown 提前 return，无法继续加节点。
      // 仅在不会立刻打开新编辑框（pendingEditLine<0）时夺回焦点，
      // 避免抢走 Ctrl/⌘+Enter 新建同级时即将打开的兄弟编辑框。
      if (this.pendingEditLine < 0) this.canvasEl?.focus({ preventScroll: true });
    }
  }

  /** 当前快照 → EditService 的输入（只读视图，写路径不修改它） */
  private editSnapshot(): EditSnapshot | null {
    const s = this.snapshot;
    if (!s) return null;
    return { content: s.content, nodes: s.nodes, step: this.indentStep, unit: this.indentUnit };
  }

  /**
   * 节点在编辑框里的初始文本。
   *
   * 任务列表带勾选框：编辑时要能看见并改它，所以把勾选状态拼成 ☑/☐ 前缀，
   * 提交时由 parseEditorValue 再解析回去。画布上「提升一级」也走这条路 ——
   * 否则会把任务项改写成普通列表项。
   */
  private editorValueOf(src: SrcRef): string {
    return src.checked === null ? src.text : `${src.checked ? "☑" : "☐"} ${src.text}`;
  }

  /**
   * 提交即预览：把编辑框里的新文字直接铺到卡片上，不等文件写完。
   *
   * 用**同一个** renderInline 渲染，所以后面真实投影到达时 innerHTML 逐字节相同，
   * applyPatch 会跳过赋值 —— 屏幕上文字一次都不跳。
   *
   * 不预览的两种情况：
   * - 文本被清空（提交时会放弃这次修改，节点保持原样，没有新内容可预览）；
   * - 内容没变（白白重排一次）。
   *
   * @returns 还原函数；写失败时调用，把卡片退回旧内容
   */
  private previewText(src: SrcRef, raw: string): (() => void) | null {
    const parsed = parseEditorValue(src, raw);
    if (parsed.text === "") return null;
    if (parsed.text === src.text && parsed.checked === src.checked) return null;

    const g = this.findNodeByLine(src.line);
    if (!g) return null;
    const fo = g.querySelector<SVGForeignObjectElement>(":scope > foreignObject");
    const box = fo?.firstElementChild?.firstElementChild as HTMLElement | null;
    if (!fo || !box) return null;

    const shown: string =
      parsed.checked === null
        ? parsed.text
        : `${parsed.checked ? "☑" : "☐"} ${parsed.text}`;
    // 块已经不在宿主卡片里了（它们各自是子节点），这里只换文字
    const html: string = renderInline(shown);

    const prevHtml: string = box.innerHTML;
    const prevW: string = fo.getAttribute("width") ?? "";
    const prevH: string = fo.getAttribute("height") ?? "";

    if (prevHtml !== html) box.innerHTML = html;

    // 卡片尺寸要同步长出来：只换文字不改 foreignObject 宽高的话，会先出现一帧
    // 「新文字溢出旧卡片」，等 markmap 自己重排（100ms 防抖）才回正。
    //
    // 而且**必须当场重画这一个节点**：fo.width 是文字层，卡片是另一个 <rect>，
    // 改属性不会让它变大。预览发生在编辑态，靠 reflowNow 兜不住（它在编辑态
    // 以前是直接早退的），结果卡片永远停在旧宽度 —— 就是「文字顶出边框」那张截图。
    // 邻居让位仍交给 reflowSoon 的整树重排；这里只补自己那 8 个属性。
    const w: number = box.scrollWidth;
    const h: number = box.scrollHeight;
    if (w > 0 && h > 0) {
      fo.setAttribute("width", String(w));
      fo.setAttribute("height", String(h));
      this.frames.paintMoved([g]);
    }
    this.reflowSoon();

    return (): void => {
      if (!fo.isConnected || !box.isConnected) return;
      box.innerHTML = prevHtml;
      if (prevW) fo.setAttribute("width", prevW);
      if (prevH) fo.setAttribute("height", prevH);
      // 退回旧尺寸也要把卡片画回去，否则写盘失败时留下同样一张「文字溢出」的卡片
      this.frames.paintMoved([g]);
      this.reflowSoon();
    };
  }

  /**
   * 执行一次写入计划。
   *
   * 这里是视图与文件 IO 的唯一接触点：计划怎么写由 writer 决定
   * （有编辑器走 transaction 保留 Ctrl+Z，没有才退回 vault.process）。
   *
   * @param remember 是否记入撤销历史。撤销/重做本身不能再记，
   *                 否则「撤销」会把自己也压进 past，点两下就原地打转。
   */
  private async runWrite(
    file: TFile,
    op: WriteOp,
    remember = true,
  ): Promise<{ ok: boolean; next?: string }> {
    const res = await applyOp(this.app, file, op);
    if (!res.ok) {
      this.pendingEditLine = -1;
      new Notice(`obmind：${res.reason}`);
      return { ok: false };
    }
    // writer 顺手把写入后的内容算出来了，直接用 —— 不再读一次文件。
    // 少的那次 IO 正是「按了 Delete/Enter 之后画面要停顿一下才更新」的原因。
    if (remember) {
      const before: string = this.snapshot?.content ?? "";
      if (res.next !== undefined && res.next !== before) {
        this.history = record(this.history, before);
      }
    }
    this.syncToolbar();
    return { ok: true, next: res.next };
  }

  /** 重建完成后，把编辑框落到新建的那一行上 */
  private flushPendingEdit(): void {
    // 重建后 g 元素全换了，选中态要按行号重新挂上
    this.paintSelection();
    // 快照换了，节点是否还存在于新树里要重新判定（比如撤销后选中的节点没了）
    this.syncToolbar();

    const line: number = this.pendingEditLine;
    if (line < 0) return;
    this.pendingEditLine = -1;

    // 结构更新的 duration 是 0，节点在 setData 完成时就已经落到最终位置了，
    // 所以等两帧（浏览器布局 + markmap 的 renderData 收尾）就能开框。
    // 原来固定等 240ms —— 那段空白就是「新建后先看到占位文字、随后被输入框盖住」的闪。
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (this.rt.phase !== "idle") {
          // 又赶上一轮重建：重新排队，等那一轮结束再开
          this.pendingEditLine = line;
          window.setTimeout(() => this.flushPendingEdit(), 60);
          return;
        }
        const g = this.findNodeByLine(line);
        if (g) this.startEdit(g);
      });
    });
  }

  async onClose(): Promise<void> {
    this.rt.dispose();
    this.editorHandle?.close();
    this.editorHandle = null;
    // 块渲染器（高亮 / MathJax / mermaid）挂在 Component 上，视图关掉必须卸干净
    for (const part of this.blockParts.values()) part.unload();
    this.blockParts.clear();
    this.blockCache.clear();
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.pendingFit = false;
    // 作废排队中的适配：定时器和 fitToken 两道都要清，
    // 否则关闭后仍会有一次 fitInstant 摸到已经 destroy 的 markmap
    this.fitToken++;
    if (this.autoFitTimer !== 0) {
      window.clearTimeout(this.autoFitTimer);
      this.autoFitTimer = 0;
    }
    this.fittedSize = null;
    this.frames.cancel();
    if (this.trajRaf !== 0) {
      window.cancelAnimationFrame(this.trajRaf);
      this.trajRaf = 0;
    }
    this.painter.reset();
    this.mm?.destroy();
    this.mm = null;
    this.drag?.destroy();
    this.drag = null;
    this.boxSelect?.destroy();
    this.boxSelect = null;
    this.snapshot = null;
    this.navStack = [];
    // 只丢映射，不 detach：插件卸载 / 视图关闭不该替用户关掉笔记标签
    this.leafById.clear();
    this.breadcrumbEl = null;
    this.selectedLine = -1;
    this.history = EMPTY_HISTORY;
    this.toolbar = null;
    this.nodeBar?.destroy();
    this.nodeBar = null;
    this.helpPanel = null;
    traceBindSvg(null);
    this.svgEl = null;
    this.canvasEl = null;
    this.emptyEl = null;
    this.themeBtn = null;
  }
}
