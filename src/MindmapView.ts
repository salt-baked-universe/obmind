import {
  ItemView,
  Menu,
  Notice,
  WorkspaceLeaf,
  MarkdownView,
  MarkdownRenderer,
  Component,
  TFile,
  debounce,
  normalizePath,
  setIcon,
} from "obsidian";
import type { WorkspaceSplit } from "obsidian";
import { Markmap } from "markmap-view";
import type { INode, IPureNode } from "markmap-common";
import { collectBlocks } from "./parser";
import type { BlockInfo, DropMode, SrcRef, WriteOp } from "./types";
import { resolveTheme, THEME_OPTIONS } from "./theme";
import type { MindmapTheme, ThemeSpec } from "./theme";
import { NodePainter } from "./render/painter";
import { BranchColors, branchKey, branchPathOf, hash32 } from "./render/colors";
import { FrameScheduler } from "./render/frame";
import { waitStableSize } from "./render/viewport";
import { applyFolds, collectFolds } from "./edit/folds";
import { openInlineEditor } from "./edit/inlineText";
import type { EditorAction, InlineEditorHandle } from "./edit/inlineText";
import { applyOp, findEditor } from "./edit/writer";
import { DragController } from "./edit/drag";
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
import { canRedo, canUndo, EMPTY_HISTORY, record, redo, undo } from "./app/History";
import type { HistoryState } from "./app/History";
import { buildToolbar, GLOBAL_GROUPS, NODE_GROUPS } from "./ui/toolbar";
import type { ToolbarActionId, ToolbarHandle } from "./ui/toolbar";
import { NodeBar } from "./ui/nodeBar";
import { ViewRuntime } from "./app/runtime";
import { planProjection } from "./app/plan";
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
  ["选中后", "卡片下方浮出操作条：新建子级 / 同级、编辑、提升、删除"],
  ["双击 / F2", "原地编辑"],
  ["Tab / Enter", "新建子级 / 新建同级"],
  ["Shift+Tab", "提升一级"],
  ["Delete", "删除节点及其全部子节点"],
  ["拖动节点", "按住左键拖到别的卡片上改变父子关系"],
  ["Ctrl/⌘+单击", "按节点文字打开同名笔记"],
  ["Ctrl+Z / ⇧Ctrl+Z", "撤销 / 重做"],
  ["编辑框 Tab", "缩进 / Shift+Tab 反缩进"],
  ["编辑框 Ctrl+↵", "提交并新建同级"],
  ["Esc", "取消编辑、收起面板或取消选中"],
  ["点空白", "取消选中，收起节点操作条"],
  ["导出", "整张图存成 <笔记名>.mindmap.svg（笔记同目录）"],
];

/** 把 catch 到的东西变成一句能显示的话（unknown 不能直接拼字符串） */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
  /** 状态闸门 + 重建串行化（替代原来的 refreshing / pending / rebuilding / pendingRefresh） */
  private readonly rt: ViewRuntime;
  private currentSpec: ThemeSpec | null = null;
  // 当前要渲染的笔记。缓存它，避免焦点跑到导图视图上时拿不到活跃笔记。
  private targetFile: TFile | null = null;
  // 上一次成功投影的结果，下次刷新用它做 diff
  private snapshot: Snapshot | null = null;
  private editorHandle: InlineEditorHandle | null = null;
  // 当前笔记检测到的缩进步长（列数）与缩进单位（原文实际用的空白串，可能是制表符）
  private indentStep = 2;
  private indentUnit = "  ";
  // 新建同级节点后，等重建完成再把编辑框落到新行上
  private pendingEditLine = -1;
  /**
   * 下一次投影是否保留当前缩放/位置（不重新适配）。
   *
   * 只在「导图内跳转」时置位：面包屑回退、点双链换一篇，都属于顺着路径继续看，
   * 缩放被重置会让人瞬间找不到自己在哪。用户主动切笔记则照旧适配。
   */
  private keepViewport = false;
  /** 当前选中的节点（记源行号，重建后仍能按行号恢复高亮） */
  private selectedLine = -1;
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
  /** 操作栏（图标按钮 + 主题按钮）。构建细节在 ui/toolbar.ts */
  private toolbar: ToolbarHandle | null = null;
  /** 选中节点时浮在卡片下方的节点操作条（ui/nodeBar.ts） */
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
  /** 块级渲染（代码块/公式块）用到的组件，下次重建前统一释放 */
  private blockParts: Component[] = [];
  /**
   * 块渲染结果缓存：`kind|lang|raw` → HTML。
   * 每打一个字都会重建整棵树，不缓存的话一篇有几十个代码块的笔记
   * 每次按键都要重新跑一遍高亮/MathJax，输入会明显发滞。
   */
  private blockCache = new Map<string, string>();

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

    this.toolbar = buildToolbar(header, {
      leading: themeBtn,
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
    const svg = canvas.createSvg("svg");
    // markmap 基础样式挂在 .markmap 上（文字色/字体变量），需手动补类
    svg.classList.add("markmap");
    svg.style.width = "100%";
    svg.style.height = "100%";
    this.svgEl = svg;

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

    // 拖动改变父子关系
    this.drag = new DragController(svg, canvas, {
      srcOf: (g: SVGGElement) => this.srcOf(g),
      onDrop: (srcLine: number, targetLine: number, mode: DropMode) =>
        this.onNodeDrop(srcLine, targetLine, mode),
    });

    // 用户滚轮缩放过之后，就不要再跟着容器尺寸自动适配了 ——
    // 他已经把视角调到自己想要的位置，我们再去 fit 一次等于把它抢走。
    // 用捕获阶段：d3-zoom 在 svg 上会 preventDefault，但事件仍会走到这里。
    this.registerDomEvent(
      canvas,
      "wheel",
      () => {
        this.userView = true;
      },
      { capture: true, passive: true },
    );

    // 初始没有导航，先置成隐藏，免得空容器占位
    this.renderBreadcrumb();

    // Esc 兜底：画布的 keydown 只在**焦点在画布上**时生效，而点过工具栏、
    // 点过侧栏、或者切过窗口之后焦点就不在了 —— 那时浮动条关不掉。
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => this.onGlobalKeyDown(e));

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
    this.observer = new MutationObserver((records: MutationRecord[]) => {
      let structural = false;
      const moved = new Set<SVGGElement>();

      for (const rec of records) {
        if (rec.type === "childList") {
          // 我们自己往节点 g 里插卡片/阴影/连线也会产生 childList。那不是
          // 结构变化 —— 若当成结构变化，每次首次绘制都会再触发一次全量重绘，
          // 折叠动画一开始就凭空多跑一遍。
          if (!isOwnDecoration(rec)) structural = true;
          continue;
        }
        const target = rec.target;
        if (
          !(target instanceof SVGGElement) ||
          !target.classList.contains("markmap-node")
        ) {
          continue;
        }
        moved.add(target);
      }

      if (structural) {
        this.frames.requestAll();
      } else if (moved.size > 0) {
        // 同步重绘，不走 rAF：d3 刚在这一帧的 rAF 回调里写完 transform，
        // MutationObserver 回调紧跟着在微任务里跑 —— 此刻重画连线仍是同一帧，
        // 线和节点一起落位。排到下一个 rAF 就会晚一帧，动画里看着线在追节点。
        this.frames.paintMoved(moved);
      }
    });
    this.observer.observe(svg, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["transform"],
    });
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
    if (file && file.extension === "md") this.targetFile = file;
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
      const base: string = branchKey(child.content ?? "");
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
        this.setSelectedLine(-1);
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
  private syncToolbar(): void {
    const src: SrcRef | null = this.nodeAt(this.selectedLine);
    // 根节点就是文件名本身：改不了、删不了、也无所谓缩进
    const onNode: boolean = src !== null && src.depth > 0;
    const onAny: boolean = src !== null;

    const bar = this.nodeBar;
    if (bar) {
      bar.setEnabled("edit", onNode);
      bar.setEnabled("child", onAny);
      bar.setEnabled("sibling", onAny);
      bar.setEnabled("outdent", onNode);
      bar.setEnabled("delete", onNode);
    }

    const t = this.toolbar;
    if (!t) return;
    t.setEnabled("undo", canUndo(this.history));
    t.setEnabled("redo", canRedo(this.history));
    const ready: boolean = this.mm !== null;
    t.setEnabled("fit", ready);
    t.setEnabled("collapseAll", ready);
    t.setEnabled("expandAll", ready);
    t.setEnabled("refresh", ready);
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
    if (node) this.startEdit(node, false);
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

    // 选中态与浮动条由 applyTree 自己在重建结束后挂回去
    void this.applyTree(tree);
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
  }

  private clearEmpty(): void {
    this.emptyEl?.hide();
  }

  /**
   * 把代码块 / 公式块交给 Obsidian 自己的 MarkdownRenderer 渲染。
   *
   * 为什么不自己渲染：
   * - 公式要么引 katex（打包多 300KB，还要带一整套字体），要么自己写 LaTeX 解析，都不划算；
   * - 代码高亮同理，Obsidian 内部已有一套且跟随主题配色。
   * 走官方渲染器的额外好处是观感和笔记里完全一致，用户不用适应两套排版。
   *
   * 必须在 setData **之前**跑完：markmap 是按 content 里的 DOM 量节点宽高的，
   * 先用占位灌图、事后再替换内容，节点尺寸会和实际文字脱节（裁剪或留白）。
   */
  private async renderBlocks(tree: IPureNode, file: TFile): Promise<void> {
    const jobs = collectBlocks(tree);
    // 上一轮的组件（MathJax、语法高亮注册）先释放，否则每刷新一次堆一批
    for (const part of this.blockParts) part.unload();
    this.blockParts = [];
    if (jobs.length === 0) return;

    await Promise.all(
      jobs.map(async ({ node, block }: { node: IPureNode; block: BlockInfo }) => {
        const key = `${block.kind}|${block.lang}|${block.raw}`;
        const cached: string | undefined = this.blockCache.get(key);
        if (cached !== undefined) {
          node.content = cached;
          return;
        }

        const holder = document.createElement("div");
        const part = new Component();
        // 先 load：MarkdownRenderer 会把高亮/MathJax 渲染器作为子组件挂上来，
        // 父组件没 load 的话子组件不会启动，公式就一直是原始 `$$…$$`。
        part.load();
        this.blockParts.push(part);
        try {
          await MarkdownRenderer.render(this.app, block.raw, holder, file.path, part);
          const html: string = holder.innerHTML.trim();
          if (html !== "") {
            node.content = html;
            // 缓存控制在几百条，够覆盖正常切换；无限涨没意义
            if (this.blockCache.size > 300) this.blockCache.clear();
            this.blockCache.set(key, html);
          }
        } catch (err) {
          // 渲染失败就保留占位（「代码块 · js · 12 行」），至少不整块消失
          console.warn("[obmind] 代码块/公式块渲染失败，保留占位", err);
        }
      }),
    );
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
      if (tries < 4) {
        this.pendingFit = true;
        this.scheduleFitRetry(tries);
      }
      return;
    }
    this.fittedSize = size;
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

    // 读路径统一走 QueryService（读 → 解析 → 节点坐标 + 缩进检测），一次产出只读快照。
    // 写回之后调用方直接传入刚写完的内容，不再依赖「读回来的东西是新的」，
    // 彻底避开「文件变了但导图不更新」的竞态。
    const doc =
      knownContent === undefined
        ? await this.query.load(file.path, file.basename, { filterFrontmatter: filter })
        : this.query.parse(knownContent, file.basename, { filterFrontmatter: filter });
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
    if (plan.kind === "patch" && this.applyPatch(plan.line, plan.content)) {
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

    // 结构变化：setData 全量重建
    // setData 会重建整棵树并把 payload.fold 冲掉，
    // 不接住的话用户折起来的分支每次编辑都会全弹开。
    applyFolds(tree, collectFolds(this.mm?.state.data));

    // 代码块/公式块必须在 setData 前渲染成真正的 HTML，
    // 否则 markmap 量到的是占位字符串的尺寸
    await this.renderBlocks(tree, file);
    if (this.rt.stale(rev)) return;

    const restructure = (): Promise<void> => this.applyTree(tree);

    if (!this.mm) {
      // 注意不要用 Markmap.create(svg, opts, tree)：传了 data 它会在内部
      // 直接 fit 一次，而 fit 带 180ms 过渡动画，打开视图时会看到画面缩一下。
      // 这里先建实例、再 setData，最后用无动画的 fitInstant 适配。
      this.mm = Markmap.create(this.svgEl, this.buildOptions(spec));
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
  private applyPatch(line: number, content: string): boolean {
    const g = this.findNodeByLine(line);
    if (!g) return false;

    const fo = g.querySelector<SVGForeignObjectElement>(":scope > foreignObject");
    // markmap 的结构是 foreignObject.markmap-foreign > div > div，最内层承载内容
    const box = fo?.firstElementChild?.firstElementChild ?? null;
    if (!fo || !box) return false;

    box.innerHTML = content;

    // 同步写回 markmap 手里的节点数据：后续拖动等逻辑读的是 DOM，
    // 但下次结构重建前若有其它代码看 state.data，内容不能是旧的。
    // 刻意不动 state.key —— 一改 key 就等于宣布「这是新节点」，patch 就白做了。
    const data = (g as SVGGElement & { __data__?: INode }).__data__;
    if (data) data.content = content;

    // 尺寸可能变了（文字变长/变短）。立刻量一次让卡片先跟上，
    // markmap 稍后自己重排时会把 width/height 覆盖成最终值，届时 observer 会再刷一次。
    const w: number = box.scrollWidth;
    const h: number = box.scrollHeight;
    if (w > 0 && h > 0) {
      fo.setAttribute("width", String(w));
      fo.setAttribute("height", String(h));
    }
    this.frames.requestAll();
    return true;
  }

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
    const prev: number = mm.options.duration;
    mm.setOptions({ duration: 0 });
    try {
      await mm.setData(tree);
      // 旧节点是走 transition 移除的，即使 duration=0 也要等一个 tick。
      // 这期间它们还在 DOM 里、文字已透明，但我们的卡片是不透明的 ——
      // 同步重绘会把这些「幽灵卡片」按旧几何画出来，屏幕上就会闪出几个空框。
      this.dropDetached();
      // 结构变了，缓存的 g/元素引用可能已经对应到别的节点上，全部作废重来
      this.frames.reset();
      this.frames.paintNow();
    } finally {
      mm.setOptions({ duration: prev });
      this.rt.setPhase("idle");
    }

    // 重建换掉了整批 g：选中高亮和节点浮动条都要按行号重新挂回去。
    // 不挂的话，折叠再展开、拖一次节点之后，「选中」在视觉上就凭空丢了，
    // 而 selectedLine 其实还指着那一行 —— 用户按 Tab 会莫名其妙多出一个子级。
    this.paintSelection();
    this.syncToolbar();
  }

  /**
   * 删掉 setData 之后残留的、在新树里已经不存在的节点元素。
   * 正常情况下就是「已被 markmap 标记为退出、还在等 transition 收尾」的那几个。
   *
   * 用**对象身份**比对，不能用 path：拖动之后旧节点的 path 很可能和新树里
   * 某个节点的 path 撞上（比如都叫 "0.0.1"），按 path 判断会漏掉它，
   * 于是屏幕上多出一个和真节点重叠的幽灵卡片。
   */
  private dropDetached(): void {
    const svg = this.svgEl;
    const root = this.mm?.state.data;
    if (!svg || !root) return;

    const alive = new Set<unknown>();
    const walk = (n: INode): void => {
      alive.add(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);

    for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const data: unknown = (g as SVGGElement & { __data__?: unknown }).__data__;
      if (!data || !alive.has(data)) g.remove();
    }
  }

  // -------------------------------------------------------------------------
  // 点击 / 编辑 / 拖动
  // -------------------------------------------------------------------------

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
        this.openDoc(dest);
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
      if (this.selectedLine >= 0) this.setSelectedLine(-1);
      return;
    }

    // 4) Ctrl/⌘ + 单击节点：把节点文字当笔记名打开（原行为保留）
    if (e.ctrlKey || e.metaKey) {
      const text: string = (g.textContent ?? "").trim();
      if (!text) return;
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        text,
        this.targetFile?.path ?? "",
      );
      if (dest instanceof TFile) this.openDoc(dest);
      return;
    }

    // 5) 普通左键单击 = 选中。选中之后 Tab 建子级、Enter 建同级才有基准。
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
      if (!last) item.addEventListener("click", () => this.goBackTo(i));
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
    this.setSelectedLine(g ? (this.srcOf(g)?.line ?? -1) : -1);
    // 画布拿到焦点，后面的 Tab / Enter 才有人接
    this.canvasEl?.focus({ preventScroll: true });
  }

  private setSelectedLine(line: number): void {
    if (this.selectedLine === line) return;
    this.selectedLine = line;
    this.paintSelection();
    // 选中态决定第二行按钮能不能点，状态一变就得同步
    this.syncToolbar();
  }

  /**
   * 把选中态刷到当前 DOM 上（卡片描边由 CSS 负责，这里只管 class），
   * 顺便把节点浮动条挂到选中的那个节点上。
   *
   * 浮动条每次重建后都要重新挂：markmap 的 setData 会换掉整批 g，
   * 拿着旧元素等于指着一个已经掉出 DOM 的东西。
   */
  private paintSelection(): void {
    const svg = this.svgEl;
    let hit: SVGGElement | null = null;
    if (svg) {
      for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
        const on: boolean =
          this.selectedLine >= 0 && this.srcOf(g)?.line === this.selectedLine;
        g.classList.toggle("obmind-selected", on);
        if (on) hit = g;
      }
    }
    this.nodeBar?.attach(hit);
  }

  /**
   * 画布上的键盘操作。
   *
   * 两道闸门：
   * - 事件目标必须是画布本身。编辑框也在画布内部，它的 Tab / Enter 不能被我截走；
   * - 输入法组字期间（e.isComposing）一律放行，否则中文拼音的回车会被当成「新建」。
   */
  private onCanvasKeyDown(e: KeyboardEvent): void {
    if (e.target !== this.canvasEl) return;
    if (e.isComposing) return;

    // 撤销 / 重做：与编辑器保持一致的手感（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）。
    // 只在画布自身持有焦点时生效 —— 否则会和编辑器里的撤销打架。
    if (e.ctrlKey || e.metaKey) {
      const key: string = e.key.toLowerCase();
      if (key === "z" || key === "y") {
        e.preventDefault();
        e.stopPropagation();
        void this.stepHistory(key === "y" || e.shiftKey ? "redo" : "undo");
        return;
      }
    }

    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.outdentSelected();
      else this.createNode("child");
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.createNode("sibling");
      return;
    }

    if (e.key === "Escape") {
      // 帮助面板开着时，Esc 先收面板（它盖住了画布，先关它更符合直觉）
      if (this.helpPanel && !this.helpPanel.hasClass("is-hidden")) {
        this.helpPanel.addClass("is-hidden");
        return;
      }
      this.setSelectedLine(-1);
      return;
    }

    // Delete / Backspace：删掉选中节点（含整棵子树）。
    // 没有撤销栈兜底场景是「笔记没开在编辑器里」，所以在提示里写清怎么撤回。
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      this.removeNode();
      return;
    }

    // F2：等价于双击，键盘流也能改字
    if (e.key === "F2") {
      e.preventDefault();
      const line: number = this.selectedLine;
      if (line < 0) return;
      const g = this.findNodeByLine(line);
      if (g) this.startEdit(g, false);
    }
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
    if (this.selectedLine >= 0) this.setSelectedLine(-1);
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
   * 删除选中节点及其子树（Delete / Backspace）。
   *
   * 删完把选中挪到父节点上：行号在删除后往前挪，但父节点在删除行之前，
   * 所以它的行号不变，可以直接定位。这样才能连着删兄弟节点。
   */
  private removeNode(): void {
    const line: number = this.selectedLine;
    if (line < 0) return;

    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return;

    const size: number = this.editSvc.subtreeSize(snap, line);
    const parentLine: number = this.editSvc.parentLineOf(snap, line);
    const out = this.editSvc.remove({ snap, line });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return;
    }
    if (out.kind === "none") return;

    // 不再等新节点的编辑框；选中改到父节点（根节点就取消选中）
    this.pendingEditLine = -1;
    this.selectedLine = parentLine;
    void this.applyPlan(file, out.op);

    // 一次删掉整棵分支时给个反馈：没有编辑器就没有 Ctrl+Z 兜底，用户要心里有数
    if (size > 1) {
      new Notice(`obmind：已删除该节点及其 ${size - 1} 个子节点`);
    }
  }

  /** 双击节点进入原地编辑 */
  private onNodeDblClick(e: MouseEvent): void {
    const target = e.target as Element;
    // 双链上双击是选中文字，不接管
    if (target.closest("a")) return;
    // 折叠圆点交给 markmap
    if (target.closest("circle")) return;

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

    this.startEdit(g, false);
  }

  /**
   * 拖拽落下：把「移动」交给 EditService，产出整篇重写的写入计划。
   *
   * 为什么不能走行区间替换：一行会被搬到很远的位置，中间所有行号都会变。
   * 分成「先删后插」两次写，中间那一瞬间笔记就是坏的（节点丢一半）。
   */
  private onNodeDrop(srcLine: number, targetLine: number, mode: DropMode): void {
    const file = this.targetFile;
    const snap = this.editSnapshot();
    if (!file || !snap) return;

    const out = this.editSvc.move({ snap, srcLine, targetLine, mode });
    if (out.kind === "error") {
      new Notice(`obmind：${out.reason}`);
      return;
    }
    if (out.kind === "none") return;

    void this.applyPlan(file, out.op);
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

  /** 打开原地编辑框；根节点（文件名）不可编辑 */
  private startEdit(g: SVGGElement, selectAll: boolean): void {
    if (this.rt.phase === "editing" || !this.canvasEl) return;

    // 重建正在进行时会把这个 g 换掉，等这一轮跑完再按行号重新定位
    if (this.rt.phase === "rebuilding") {
      const pendingLine: number | undefined = this.srcOf(g)?.line;
      if (pendingLine !== undefined) {
        window.setTimeout(() => {
          const next = this.findNodeByLine(pendingLine);
          if (next) this.startEdit(next, selectAll);
        }, 80);
      }
      return;
    }
    if (!g.isConnected) return;

    const data = (g as SVGGElement & { __data__?: INode }).__data__;
    const src = this.srcOf(g);
    // 根节点没有 src；折叠起来的节点不渲染，也不会有 DOM
    if (!src || data?.state?.depth === 0) return;

    const spec: ThemeSpec =
      this.currentSpec ?? resolveTheme(this.plugin.settings.theme, false);
    const value: string = this.editorValueOf(src);

    this.rt.setPhase("editing");
    const handle = openInlineEditor({
      container: this.canvasEl,
      target: g,
      value,
      spec,
      selectAll,
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
    try {
      if (action === "cancel") return;

      const file = this.targetFile;
      const snap = this.editSnapshot();
      if (!file || !snap) return;

      const out = this.editSvc.commit({ snap, src, action, value });
      if (out.kind === "error") {
        this.pendingEditLine = -1;
        new Notice(`obmind：${out.reason}`);
        return;
      }
      if (out.kind === "none") return;

      if (out.focusLine !== undefined) this.pendingEditLine = out.focusLine;
      const res = await this.runWrite(file, out.op);
      next = res.next;
    } catch (err) {
      this.pendingEditLine = -1;
      console.error("[obmind] 写回笔记失败", err);
      new Notice("写回笔记失败，详见控制台。");
    } finally {
      this.editorHandle = null;
      // 退出编辑态：runtime 会把编辑期间挂起的刷新请求自动补跑，
      // 这里再显式请求一次，保证刚写进编辑器缓冲的内容立刻反映到导图上。
      this.rt.setPhase("idle");
      this.refresh(next);
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
        if (g) this.startEdit(g, true);
      });
    });
  }

  async onClose(): Promise<void> {
    this.rt.dispose();
    this.editorHandle?.close();
    this.editorHandle = null;
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
    this.painter.reset();
    this.mm?.destroy();
    this.mm = null;
    for (const part of this.blockParts) part.unload();
    this.blockParts = [];
    this.blockCache.clear();
    this.drag?.destroy();
    this.drag = null;
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
    this.svgEl = null;
    this.canvasEl = null;
    this.emptyEl = null;
    this.themeBtn = null;
  }
}
