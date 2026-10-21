import {
  ItemView,
  WorkspaceLeaf,
  MarkdownView,
  TFile,
  debounce,
} from "obsidian";
import { Markmap } from "markmap-view";
import type { INode } from "markmap-common";
import { buildTree } from "./parser";
import { branchIndex, resolveTheme, THEME_OPTIONS } from "./theme";
import type { MindmapTheme, ThemeSpec } from "./theme";
import { NodePainter } from "./render/painter";
import { nodePathOf } from "./render/geometry";
import type MindmapPlugin from "./main";

export const MINDMAP_VIEW_TYPE = "mindmap-view";

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

  /** 合并同一帧内的多次重绘请求，保证与浏览器刷新节奏同步 */
  private requestPaint(mode: "all" | "links", paths?: Set<string>): void {
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

  /** 取笔记正文：正在编辑时用编辑器里的实时内容，否则读缓存 */
  private async readContent(file: TFile): Promise<string> {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.file && mdView.file.path === file.path) {
      return mdView.editor.getValue();
    }
    return this.app.vault.cachedRead(file);
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
    if (!mm) return;
    const prev: number = mm.options.duration;
    mm.setOptions({ duration: 0 });
    try {
      await mm.fit();
    } finally {
      mm.setOptions({ duration: prev });
    }
  }

  async refresh(): Promise<void> {
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

      const content: string = await this.readContent(file);
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
        return;
      }

      const tree = buildTree(content, file.basename, {
        filterFrontmatter: this.plugin.settings.filterFrontmatter,
      });
      this.lastContent = content;

      if (!this.mm) {
        // 注意不要用 Markmap.create(svg, opts, tree)：传了 data 它会在内部
        // 直接 fit 一次，而 fit 带 180ms 过渡动画，打开视图时会看到画面缩一下。
        // 这里先建实例、再 setData，最后用无动画的 fitInstant 适配。
        this.mm = Markmap.create(this.svgEl, this.buildOptions(spec));
        this.appliedThemeKey = themeKey;
        await this.mm.setData(tree);
        this.painter.reset();
        this.requestPaint("all");
        await this.fitInstant();
      } else {
        // setOptions 只在主题变化时调用：它会触发一次重新渲染，没必要每次都做
        if (themeKey !== this.appliedThemeKey) {
          this.mm.setOptions(this.buildOptions(spec));
          this.appliedThemeKey = themeKey;
        }
        await this.mm.setData(tree);
        this.painter.reset();
        this.requestPaint("all");
        // 换了一篇笔记才重新适配；同一篇里改内容保持用户的缩放与位置
        if (fileChanged) await this.fitInstant();
      }

      this.lastFilePath = file.path;
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

    // 3) 节点整体点击：文字能匹配到笔记就打开
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

  async onClose(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    if (this.paintFrame) {
      window.cancelAnimationFrame(this.paintFrame);
      this.paintFrame = 0;
    }
    this.painter.reset();
    this.mm?.destroy();
    this.mm = null;
    this.lastContent = "";
    this.lastFilePath = "";
    this.appliedThemeKey = "";
    this.paintPaths.clear();
    this.svgEl = null;
    this.canvasEl = null;
    this.themeSelect = null;
  }
}
