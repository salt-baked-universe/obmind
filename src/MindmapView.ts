import {
  ItemView,
  Notice,
  WorkspaceLeaf,
  MarkdownView,
  TFile,
  debounce,
} from "obsidian";
import { Markmap } from "markmap-view";
import type { INode, IPureNode } from "markmap-common";
import { buildTree } from "./parser";
import type { SrcRef } from "./parser";
import { branchIndex, resolveTheme, THEME_OPTIONS } from "./theme";
import type { MindmapTheme, ThemeSpec } from "./theme";
import { NodePainter } from "./render/painter";
import { nodePathOf } from "./render/geometry";
import { applyFolds, collectFolds } from "./edit/folds";
import { openInlineEditor } from "./edit/inlineText";
import type { EditorAction, InlineEditorHandle } from "./edit/inlineText";
import { applySpan, findEditor, replaceAll } from "./edit/writer";
import type { Span } from "./edit/writer";
import { DragController } from "./edit/drag";
import { collectSrc, moveNode } from "./edit/move";
import type { DropMode } from "./edit/move";
import { indentBy, parseEditorValue, rewriteNode, siblingLine } from "./edit/text";
import type MindmapPlugin from "./main";

// 必须带插件前缀。早先用的是通用名 "mindmap-view"，一旦 onload 中途抛错，
// Obsidian 禁用插件时不会回滚已注册的视图类型，残留会让下一次开启直接死在
// "Attempting to register an existing view type" 上，而且永久卡住。
export const MINDMAP_VIEW_TYPE = "obmind-view";

type MarkmapOptions = NonNullable<Parameters<typeof Markmap.create>[1]>;

/**
 * 思维导图视图。
 *
 * 职责边界：
 * - 本类只管「视图生命周期 + 工具栏 + 事件 + 选哪篇笔记」；
 * - 节点卡片/连线怎么画在 render/painter.ts；
 * - 节点几何与路径计算在 render/geometry.ts；
 * - 笔记文本 → 节点树在 parser.ts。
 */
export class MindmapView extends ItemView {
  private plugin: MindmapPlugin;
  private mm: Markmap | null = null;
  private svgEl: SVGSVGElement | null = null;
  private canvasEl: HTMLElement | null = null;
  private themeSelect: HTMLSelectElement | null = null;
  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** 尺寸还没就绪时挂起的首次适配请求 */
  private pendingFit = false;
  private painter = new NodePainter();
  private currentSpec: ThemeSpec | null = null;
  /** 待执行的绘制帧（rAF），用它合并同一帧内的多次重绘请求 */
  private paintFrame = 0;
  /** 本次待绘制的内容：全量（结构变了）还是只刷连线（节点只是位移） */
  private paintMode: "all" | "links" = "links";
  /** 本帧发生位移的节点 path；空集表示「全部连线」 */
  private paintPaths = new Set<string>();
  // 当前要渲染的笔记。缓存它，避免焦点跑到导图视图上时拿不到活跃笔记。
  private targetFile: TFile | null = null;
  // 防止并发刷新导致对同一 svg 重复 create 出多个 Markmap 实例。
  private refreshing = false;
  private pending = false;
  // 记录已渲染的正文与主题，内容没变就不重建导图（避免打字时反复重排）
  private lastContent = "";
  private appliedThemeKey = "";
  // 上次渲染的笔记路径：只有换笔记时才重新适配视图
  private lastFilePath = "";
  // 编辑态闸门：编辑期间禁止重建导图，否则输入框会连同节点一起被冲掉
  private editing = false;
  private editorHandle: InlineEditorHandle | null = null;
  private pendingRefresh = false;
  // 重建导图期间暂停绘制：这段时间的 DOM 是半成品，画出来的线必然错
  private rebuilding = false;
  // 当前笔记检测到的缩进步长（列数）与缩进单位（原文实际用的空白串，可能是制表符）
  private indentStep = 2;
  private indentUnit = "  ";
  // 新建同级节点后，等重建完成再把编辑框落到新行上
  private pendingEditLine = -1;
  private drag: DragController | null = null;
  /** 最近一次渲染用的节点树：拖动时靠它取全部节点的源坐标（折叠的节点不在 DOM 里） */
  private lastTree: IPureNode | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MindmapPlugin) {
    super(leaf);
    this.plugin = plugin;
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

    // 顶部工具条：主题下拉 + 刷新
    const toolbar = container.createDiv({ cls: "obmind-toolbar" });
    const select = toolbar.createEl("select", { cls: "dropdown" });
    for (const opt of THEME_OPTIONS) {
      const optionEl = select.createEl("option", { text: opt.label });
      optionEl.value = opt.value;
    }
    select.value = this.plugin.settings.theme;
    select.addEventListener("change", () => {
      void this.onThemeChange(select.value as MindmapTheme);
    });
    this.themeSelect = select;

    const refreshBtn = toolbar.createEl("button", {
      cls: "obmind-refresh",
      text: "刷新",
    });
    refreshBtn.addEventListener("click", () => {
      this.lastContent = "";
      void this.refresh();
    });

    // 手动适配：折叠/展开不再自动缩放，想回到全览时点这里
    const fitBtn = toolbar.createEl("button", {
      cls: "obmind-fit",
      text: "适配",
      attr: { title: "缩放到适合窗口" },
    });
    fitBtn.addEventListener("click", () => {
      void this.mm?.fit();
    });

    // 双击编辑没有任何可见入口，给个悬浮说明，否则没人会发现
    toolbar.createSpan({
      cls: "obmind-hint",
      text: "?",
      attr: {
        title: [
          "双击节点：原地编辑",
          "Enter 完成 · Esc 取消 · Ctrl+Enter 新建同级",
          "Tab 缩进 · Shift+Tab 反缩进 · 清空后退格删除该行",
          "Ctrl/⌘ + 单击节点：打开同名笔记",
        ].join("\n"),
      },
    });

    // 画布
    const canvas = container.createDiv({ cls: "obmind-canvas" });
    this.canvasEl = canvas;
    const svg = canvas.createSvg("svg");
    // markmap 基础样式挂在 .markmap 上（文字色/字体变量），需手动补类
    svg.classList.add("markmap");
    svg.style.width = "100%";
    svg.style.height = "100%";
    this.svgEl = svg;

    this.observeLayout(svg);
    this.observeSize(canvas);

    // 首次渲染
    await this.refresh();

    // 编辑器内容变更（防抖 300ms）+ 活跃 leaf 切换
    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        debounce(() => void this.refresh(), 300, true),
      ),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void this.refresh()),
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
  }

  /**
   * 监听导图的结构与布局变化，并按变化类型分流：
   * - childList（节点增删）→ 全量绘制；
   * - 节点 g 的 transform（折叠展开动画里每帧都在变）→ 只刷连线。
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
      const moved = new Set<string>();

      for (const rec of records) {
        if (rec.type === "childList") {
          structural = true;
          continue;
        }
        const target = rec.target;
        if (
          !(target instanceof SVGGElement) ||
          !target.classList.contains("markmap-node")
        ) {
          continue;
        }
        const path = nodePathOf(target);
        if (path) moved.add(path);
      }

      if (structural) this.requestPaint("all");
      else if (moved.size > 0) this.requestPaint("links", moved);
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
   * 首次适配完全依赖它：视图创建时右侧栏还在滑出，容器尺寸是 0，
   * fitInstant 会挂起（pendingFit），等这里的尺寸真正就绪再补做，
   * 否则就会「打开一片空白，点一下适配才出来」。
   * 编辑框开着时尺寸变化要跟着重新对齐。
   */
  private observeSize(el: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.pendingFit) {
        void this.fitInstant();
        return;
      }
      if (this.editing) this.editorHandle?.reposition();
    });
    this.resizeObserver.observe(el);
  }

  /** 合并同一帧内的多次重绘请求，保证与浏览器刷新节奏同步 */
  private requestPaint(mode: "all" | "links", paths?: Set<string>): void {
    // 重建导图期间不画：此刻 DOM 是半成品（新节点的 g 可能还没拿到 transform，
    // 卡片/连线还挂在被复用的旧 g 上），画出来必然是错的。重建结束后统一同步全量画一次。
    if (this.rebuilding) return;

    if (mode === "all") {
      this.paintMode = "all";
      this.paintPaths.clear();
    } else if (this.paintMode !== "all" && paths) {
      for (const p of paths) this.paintPaths.add(p);
    }

    if (this.paintFrame) return;
    this.paintFrame = window.requestAnimationFrame(() => {
      this.paintFrame = 0;
      const svg = this.svgEl;
      const spec = this.currentSpec;
      if (!svg || !spec) return;

      if (this.paintMode === "all") {
        this.painter.paintAll(svg, spec);
      } else {
        this.painter.paintLinks(
          svg,
          spec,
          this.paintPaths.size ? this.paintPaths : null,
        );
      }
      this.paintMode = "links";
      this.paintPaths.clear();
    });
  }

  /**
   * 立刻同步画一遍，不等 rAF。
   *
   * 重建之后必须抢在浏览器绘制这一帧之前把卡片和连线摆正，否则会先画出一帧
   * 「新位置的节点 + 旧父节点的连线」，看起来就是线闪一下。
   */
  private paintAllSync(): void {
    const svg = this.svgEl;
    const spec = this.currentSpec;
    if (this.paintFrame) {
      window.cancelAnimationFrame(this.paintFrame);
      this.paintFrame = 0;
    }
    this.paintMode = "links";
    this.paintPaths.clear();
    if (!svg || !spec) return;
    this.painter.paintAll(svg, spec);
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
   * 紧跟着同步重绘一次（paintAllSync），整个过程在一帧内结束，不会播出中间态。
   * 折叠/展开的 180ms 动画不受影响：那是 markmap 自己 toggleNode 触发的，
   * 这里只临时改了本次 setData 的 duration。
   */
  private async applyTree(tree: IPureNode): Promise<void> {
    const mm = this.mm;
    const svg = this.svgEl;
    if (!mm || !svg) return;

    this.rebuilding = true;
    const prev: number = mm.options.duration;
    mm.setOptions({ duration: 0 });
    try {
      await mm.setData(tree);
      // 旧节点是走 transition 移除的，即使 duration=0 也要等一个 tick。
      // 这期间它们还在 DOM 里、文字已透明，但我们的卡片是不透明的 ——
      // 同步重绘会把这些「幽灵卡片」按旧几何画出来，屏幕上就会闪出几个空框。
      this.dropDetached();
      // 结构变了，缓存的 g/元素引用可能已经对应到别的节点上，全部作废重来
      this.painter.reset();
      this.paintAllSync();
    } finally {
      mm.setOptions({ duration: prev });
      this.rebuilding = false;
    }
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

  /** 供插件在激活视图时指定要展示的笔记 */
  setTargetFile(file: TFile | null): void {
    if (file && file.extension === "md") this.targetFile = file;
  }

  private async onThemeChange(theme: MindmapTheme): Promise<void> {
    this.plugin.settings.theme = theme;
    await this.plugin.saveSettings();
    await this.refresh();
  }

  /**
   * 解析当前应该渲染哪篇笔记。
   * 不能只依赖 getActiveViewOfType(MarkdownView)——用户点导图视图里的下拉框时，
   * 活跃视图就是导图自身，那样会拿不到笔记而中断刷新（之前“切换主题无效”的根因）。
   */
  private resolveTargetFile(): TFile | null {
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
        return spec.colors[branchIndex(node.state.path) % spec.colors.length];
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
   * 只在「首次打开」「切换笔记」时调用：
   * - 打开时用无动画版，避免画面先缩一下；
   * - 换笔记时必须重新适配（autoFit 已关，否则新笔记可能整个在视口外）。
   * 打字编辑时不调用，用户当前缩放/位置保持不变。
   */
  private async fitInstant(): Promise<void> {
    const mm = this.mm;
    const el = this.svgEl;
    if (!mm || !el) return;

    // 视图刚打开时右侧栏还在滑出，容器尺寸可能还是 0。
    // markmap 的 fit 直接取 svg.getBoundingClientRect()，宽高为 0 时
    // scale = Math.min(0/宽, 0/高) = 0，整张图缩成一个点 —— 画面上就是一片空白，
    // 直到用户手动点「适配」。这正是之前「打开是空白，点适配才有内容」的原因。
    // 所以尺寸没就绪就先挂起，交给 ResizeObserver 在真正有尺寸时补做。
    if (el.clientWidth < 8 || el.clientHeight < 8) {
      this.pendingFit = true;
      return;
    }

    // 让浏览器把这一帧的布局跑完，避免拿到过渡动画中途的中间尺寸
    await this.nextFrame();
    if (this.svgEl !== el || this.mm !== mm) return;

    this.pendingFit = false;
    const prev: number = mm.options.duration;
    mm.setOptions({ duration: 0 });
    try {
      await mm.fit();
    } finally {
      mm.setOptions({ duration: prev });
    }
  }

  private nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  async refresh(knownContent?: string): Promise<void> {
    if (this.editing) {
      // 编辑期间绝不重建：markmap 会重建 foreignObject，输入框和光标一起没
      this.pendingRefresh = true;
      return;
    }
    if (this.refreshing) {
      // 正在刷新时再来的请求（例如切主题）不能丢，结束后补一次
      this.pending = true;
      return;
    }
    this.refreshing = true;
    try {
      if (this.themeSelect) this.themeSelect.value = this.plugin.settings.theme;

      const file = this.resolveTargetFile();
      if (!file || !this.svgEl) return;

      // 写回之后调用方直接传入刚写完的内容，不再依赖「读回来的东西是新的」，
      // 彻底避开「文件变了但导图不更新」的竞态。
      const content: string = knownContent ?? (await this.readContent(file));
      const fileChanged = this.lastFilePath !== file.path;
      const isDark = document.body.classList.contains("theme-dark");
      const spec = resolveTheme(this.plugin.settings.theme, isDark);
      const themeKey = `${spec.id}:${spec.dark ? "d" : "l"}`;
      this.applyTheme(spec);

      // 内容与主题都没变（例如只是移动光标触发的 editor-change）：
      // 什么都不用画，直接返回。之前这里还会全量重绘一次，纯属浪费。
      if (
        !fileChanged &&
        this.mm &&
        content === this.lastContent &&
        themeKey === this.appliedThemeKey
      ) {
        // 内容没变就不重画，但排队中的「编辑下一个节点」还得接上，
        // 否则点过去那次双击会被这条短路永久吞掉。
        this.flushPendingEdit();
        return;
      }

      const tree = buildTree(content, file.basename, {
        filterFrontmatter: this.plugin.settings.filterFrontmatter,
      });
      this.lastContent = content;
      // 留给拖拽用：DOM 里只有展开的节点，折叠的节点只能从树里拿
      this.lastTree = tree;

      const step: unknown = tree.payload?.step;
      if (typeof step === "number" && step > 0) this.indentStep = step;
      const unit: unknown = tree.payload?.indentUnit;
      if (typeof unit === "string" && unit !== "") this.indentUnit = unit;

      // setData 会重建整棵树并把 payload.fold 冲掉，
      // 不接住的话用户折起来的分支每次编辑都会全弹开。
      applyFolds(tree, collectFolds(this.mm?.state.data));

      if (!this.mm) {
        // 注意不要用 Markmap.create(svg, opts, tree)：传了 data 它会在内部
        // 直接 fit 一次，而 fit 带 180ms 过渡动画，打开视图时会看到画面缩一下。
        // 这里先建实例、再 setData，最后用无动画的 fitInstant 适配。
        this.mm = Markmap.create(this.svgEl, this.buildOptions(spec));
        this.appliedThemeKey = themeKey;
        await this.applyTree(tree);
        await this.fitInstant();
      } else {
        // 主题变了才需要换一整套绘制选项（线宽、字号、maxWidth）。
        // setOptions 只合并选项、不渲染，但会重绑一次 zoom 手势，没必要每次重建都调。
        if (themeKey !== this.appliedThemeKey) {
          this.mm.setOptions(this.buildOptions(spec));
          this.appliedThemeKey = themeKey;
        }
        await this.applyTree(tree);
        // 换了一篇笔记才重新适配；同一篇里改内容保持用户的缩放与位置
        if (fileChanged) await this.fitInstant();
      }

      this.lastFilePath = file.path;
      this.flushPendingEdit();
    } finally {
      this.refreshing = false;
      if (this.pending) {
        this.pending = false;
        void this.refresh();
      }
    }
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
        void this.app.workspace.getLeaf("tab").openFile(dest);
      }
      return;
    }

    // 2) 折叠圆点交给 markmap 自己处理，避免折叠与跳转冲突
    if (target.closest("circle")) return;

    // 3) 节点整体：Ctrl/⌘ + 单击才把节点文字当笔记名打开。
    //    普通单击不做跳转——双击已经留给原地编辑，单击再跳转就会互相打架。
    if (!(e.ctrlKey || e.metaKey)) return;
    const g = target.closest("g.markmap-node") as SVGGElement | null;
    if (!g) return;
    const text: string = (g.textContent ?? "").trim();
    if (!text) return;

    const dest = this.app.metadataCache.getFirstLinkpathDest(
      text,
      this.targetFile?.path ?? "",
    );
    if (dest instanceof TFile) {
      void this.app.workspace.getLeaf("tab").openFile(dest);
    }
  }

  // -------------------------------------------------------------------------
  // 双向编辑
  // -------------------------------------------------------------------------

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
    if (this.editing || this.refreshing) {
      const pendingLine: number | undefined = this.srcOf(g)?.line;
      if (pendingLine !== undefined) this.pendingEditLine = pendingLine;
      return;
    }

    this.startEdit(g, false);
  }

  /**
   * 拖拽落下：把「移动」翻译成整篇新内容，一次性写回。
   *
   * 为什么不能走行区间替换：一行会被搬到很远的位置，中间所有行号都会变。
   * 分成「先删后插」两次写，中间那一瞬间笔记就是坏的（节点丢一半）。
   */
  private onNodeDrop(srcLine: number, targetLine: number, mode: DropMode): void {
    const file = this.targetFile;
    const tree = this.lastTree;
    const content: string = this.lastContent;
    if (!file || !tree || !content) return;

    const res = moveNode({
      lines: content.split("\n"),
      nodes: collectSrc(tree),
      step: this.indentStep,
      unit: this.indentUnit,
      srcLine,
      targetLine,
      mode,
    });

    if (!res.ok) {
      new Notice(`obmind：${res.reason}`);
      return;
    }

    void this.applyMove(file, res.lines.join("\n"), content);
  }

  private async applyMove(file: TFile, next: string, expect: string): Promise<void> {
    try {
      const ok: boolean = await replaceAll(this.app, file, next, expect);
      if (!ok) {
        new Notice("笔记内容已变化，本次移动未写入。请点「刷新」后重试。");
        return;
      }
      // 直接把刚写完的内容交给 refresh：不依赖读回结果，
      // 编辑器缓冲还没落盘时也能立刻重建（否则要手动点刷新）。
      await this.refresh(next);
    } catch (err) {
      console.error("[obmind] 移动节点失败", err);
      new Notice("移动节点失败，详见控制台。");
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
    if (this.editing || !this.canvasEl) return;

    // 重建正在进行时会把这个 g 换掉，等这一轮跑完再按行号重新定位
    if (this.refreshing) {
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

    const spec: ThemeSpec = this.currentSpec ?? resolveTheme(this.plugin.settings.theme, false);
    const value: string =
      src.checked === null ? src.text : `${src.checked ? "☑" : "☐"} ${src.text}`;

    this.editing = true;
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
      this.editing = false;
      return;
    }
    this.editorHandle = handle;
  }

  /** 编辑结束后：翻译成文本变更 → 写回笔记 → 重建导图 */
  private async commitEdit(
    action: EditorAction,
    value: string,
    src: SrcRef,
  ): Promise<void> {
    try {
      if (action === "cancel") return;

      const file = this.targetFile;
      if (!file) return;

      const parsed = parseEditorValue(src, value);
      let span: Span | null = null;

      // 只有「退格清空」才删行；否则空文本一律视为放弃修改。
      // 笔记里一行就是一条内容，误删比改不动代价大得多。
      if (parsed.text === "" && action !== "delete") return;

      if (action === "delete") {
        span = {
          start: src.line,
          end: src.line + 1,
          lines: [],
          checkLine: src.line,
          checkText: src.full,
        };
      } else if (action === "sibling") {
        // 改写当前行 + 插入同级行，合成一次写入，避免中途冲突
        span = {
          start: src.line,
          end: src.line + 1,
          lines: [rewriteNode(src, parsed.text, parsed.checked), siblingLine(src)],
          checkLine: src.line,
          checkText: src.full,
        };
        this.pendingEditLine = src.line + 1;
      } else if (action === "indent" || action === "outdent") {
        const nextIndent = indentBy(src, action === "indent" ? 1 : -1, this.indentStep);
        if (nextIndent === null) return;
        span = {
          start: src.line,
          end: src.line + 1,
          lines: [rewriteNode(src, parsed.text, parsed.checked, nextIndent)],
          checkLine: src.line,
          checkText: src.full,
        };
      } else {
        // 内容没变就别写文件，省掉一次无谓的重建
        if (parsed.text === src.text && parsed.checked === src.checked) return;
        span = {
          start: src.line,
          end: src.line + 1,
          lines: [rewriteNode(src, parsed.text, parsed.checked)],
          checkLine: src.line,
          checkText: src.full,
        };
      }

      const ok: boolean = await applySpan(this.app, file, span);
      if (!ok) {
        this.pendingEditLine = -1;
        new Notice("笔记内容已变化，本次修改未写入。请点「刷新」后重试。");
      }
    } catch (err) {
      this.pendingEditLine = -1;
      console.error("[obmind] 写回笔记失败", err);
      new Notice("写回笔记失败，详见控制台。");
    } finally {
      this.editorHandle = null;
      this.editing = false;
      // 编辑期间被挡下的刷新请求，这时候一并消化
      this.pendingRefresh = false;
      await this.refresh();
    }
  }

  /** 重建完成后，把编辑框落到新建的那一行上 */
  private flushPendingEdit(): void {
    const line: number = this.pendingEditLine;
    if (line < 0) return;
    this.pendingEditLine = -1;

    // markmap 的位置变化是 180ms 过渡，等它停稳再定位，否则会画在旧坐标上
    window.setTimeout(() => {
      const g = this.findNodeByLine(line);
      if (g) this.startEdit(g, true);
    }, 240);
  }

  async onClose(): Promise<void> {
    this.editorHandle?.close();
    this.editorHandle = null;
    this.editing = false;
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.pendingFit = false;
    if (this.paintFrame) {
      window.cancelAnimationFrame(this.paintFrame);
      this.paintFrame = 0;
    }
    this.painter.reset();
    this.mm?.destroy();
    this.mm = null;
    this.drag?.destroy();
    this.drag = null;
    this.lastTree = null;
    this.lastContent = "";
    this.lastFilePath = "";
    this.appliedThemeKey = "";
    this.paintPaths.clear();
    this.svgEl = null;
    this.canvasEl = null;
    this.themeSelect = null;
  }
}
