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
import {
  branchIndex,
  nodeStyleAt,
  resolveTheme,
  THEME_OPTIONS,
} from "./theme";
import type { MindmapTheme, ThemeSpec } from "./theme";
import type MindmapPlugin from "./main";

export const MINDMAP_VIEW_TYPE = "mindmap-view";

type MarkmapOptions = NonNullable<Parameters<typeof Markmap.create>[1]>;

/** d3 会把绑定数据挂在元素上，借此拿到节点的 depth/path */
interface D3Element extends SVGGElement {
  __data__?: INode;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** markmap 的每个节点 g 用 translate(x, y) 定位，取出这个位移 */
function translateOf(g: SVGGElement): { x: number; y: number } {
  const raw: string = g.getAttribute("transform") ?? "";
  const m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(raw);
  if (m) return { x: Number.parseFloat(m[1]), y: Number.parseFloat(m[2]) };
  const t = g.transform.baseVal.consolidate();
  if (t) return { x: t.matrix.e, y: t.matrix.f };
  return { x: 0, y: 0 };
}

/** 一个节点绘制卡片/连线所需的全部几何信息 */
interface NodePaintInfo {
  g: D3Element;
  fo: SVGForeignObjectElement;
  path: string;
  depth: number;
  /** g 的 translate 原点 */
  ox: number;
  oy: number;
  /** foreignObject 的内容尺寸 */
  w: number;
  h: number;
  /** 卡片相对内容向外扩展的内边距 */
  padX: number;
  padY: number;
}

export class MindmapView extends ItemView {
  private plugin: MindmapPlugin;
  private mm: Markmap | null = null;
  private svgEl: SVGSVGElement | null = null;
  private canvasEl: HTMLElement | null = null;
  private themeSelect: HTMLSelectElement | null = null;
  private currentSpec: ThemeSpec | null = null;
  private observer: MutationObserver | null = null;
  private paintTimer: number | null = null;
  // 绘制卡片时会往 g 里插 rect，会触发自己的 MutationObserver，用这个标志防重入
  private painting = false;
  // 当前要渲染的笔记。缓存它，避免焦点跑到导图视图上时拿不到活跃笔记。
  private targetFile: TFile | null = null;
  // 防止并发刷新导致对同一 svg 重复 create 出多个 Markmap 实例。
  private refreshing = false;
  private pending = false;
  // 记录已应用的主题，仅在主题变化时 setOptions，避免每次刷新重置缩放。
  private appliedThemeKey = "";

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

    const refreshBtn = toolbar.createEl("button", { cls: "obmind-refresh", text: "刷新" });
    refreshBtn.addEventListener("click", () => void this.refresh());

    // 画布
    const canvas = container.createDiv({ cls: "obmind-canvas" });
    this.canvasEl = canvas;
    const svg = canvas.createSvg("svg");
    // markmap 基础样式挂在 .markmap 上（文字色/字体变量），需手动补类
    svg.classList.add("markmap");
    svg.style.width = "100%";
    svg.style.height = "100%";
    this.svgEl = svg;

    // markmap 在折叠/展开时会自己增删节点（不经过 setData），
    // 用观察者兜底补样式，否则折叠后新出现的节点没有卡片配色。
    // 另外必须监听 transform：折叠后其它节点会重新布局，markmap 只改 g 的 transform
    // 属性、不增删 DOM，若不跟着重算，自绘连线的 d 会停在旧坐标上（表现为线缩成一截）。
    this.observer = new MutationObserver((records: MutationRecord[]) => {
      for (const rec of records) {
        if (rec.type === "childList") {
          this.schedulePaint();
          return;
        }
        if (rec.type === "attributes" && rec.attributeName === "transform") {
          this.schedulePaint();
          return;
        }
      }
    });
    this.observer.observe(svg, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["transform"],
    });

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
    this.currentSpec = spec;
    this.containerEl.classList.toggle("markmap-dark", spec.dark);
    if (this.canvasEl) {
      this.canvasEl.style.background = spec.bg;
      this.canvasEl.classList.toggle("obmind-card", spec.card);
      this.canvasEl.style.setProperty("--obmind-node-radius", spec.radius);
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

  /**
   * 给每个节点画一张卡片。
   *
   * 这里刻意**不改 markmap 内部那层 div 的样式**：实测 markmap 会在每次重排时重建
   * foreignObject / 重置内部结构，写上去的 background 会被冲掉，卡片最终只剩节点自带的
   * 那条横线（看起来像“线托着文字”）。
   *
   * 因此改为在节点自己的 <g> 里插入一个 <rect>：
   * - 用节点局部坐标 (0,0) 绘制，自动跟随节点的位移与缩放，不用做任何坐标换算
   * - rect 是原生 SVG，填充/圆角/阴影必定渲染
   * - 插在 g 的最前面，位于连线与文字之下
   */
  private paintNodes(): void {
    const svg = this.svgEl;
    const spec = this.currentSpec;
    if (!svg || !spec) return;
    this.painting = true;
    try {
      const infos: NodePaintInfo[] = [];
      const byPath = new Map<string, NodePaintInfo>();

      for (const el of Array.from(svg.querySelectorAll("g.markmap-node"))) {
        const g = el as D3Element;
        const node = g.__data__;
        if (!node || !node.state) continue;
        const fo = g.querySelector<SVGForeignObjectElement>("foreignObject");
        if (!fo) continue;
        const w = Number.parseFloat(fo.getAttribute("width") ?? "");
        const h = Number.parseFloat(fo.getAttribute("height") ?? "");
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;

        const path: string = node.state.path;
        // 用 path 的段数算层级：根 "0" → 0，"0.2" → 1，"0.2.1" → 2
        const depth: number = path.split(".").length - 1;
        const origin = translateOf(g);
        const info: NodePaintInfo = {
          g,
          fo,
          path,
          depth,
          ox: origin.x,
          oy: origin.y,
          w,
          h,
          // 卡片比内容框四周各外扩一点，模拟卡片内边距（不参与布局，绝不挤压文字）
          padX: depth === 0 ? 12 : 9,
          padY: depth === 0 ? 7 : 5,
        };
        infos.push(info);
        byPath.set(path, info);
      }

      for (const info of infos) this.paintCard(info, spec);
      for (const info of infos) {
        if (info.depth === 0) continue;
        const parentPath = info.path.split(".").slice(0, -1).join(".");
        this.paintLink(info, byPath.get(parentPath) ?? null, spec);
      }
    } finally {
      this.painting = false;
    }
  }

  /** 给单个节点画卡片（原生 rect，插在 g 最前面，位于连线与文字之下） */
  private paintCard(info: NodePaintInfo, spec: ThemeSpec): void {
    const { g, fo, depth, padX, padY, w, h } = info;
    const isRoot = depth === 0;
    const branch = spec.colors[branchIndex(info.path) % spec.colors.length];
    const st = nodeStyleAt(spec, depth, branch);

    let card = g.querySelector(":scope > rect.obmind-node-card") as SVGRectElement | null;
    if (!card) {
      card = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
      card.setAttribute("class", "obmind-node-card");
      g.insertBefore(card, g.firstChild);
    }
    // foreignObject 在 g 内的 x 是 paddingX(6)，内容从 6 开始
    card.setAttribute("x", String(6 - padX));
    card.setAttribute("y", String(-padY));
    card.setAttribute("width", String(w + padX * 2));
    card.setAttribute("height", String(h + padY * 2));
    card.setAttribute("rx", String(isRoot ? 10 : Number.parseFloat(spec.radius) || 8));
    card.setAttribute("fill", st.bg);
    card.setAttribute("opacity", st.bg === "transparent" ? "0" : "1");

    // markmap 把折叠圆点放在节点右下角（(w, h) 处）。卡片比内容框大一圈，
    // 看起来就"不居中"。统一挪到卡片右边缘的垂直中心，与 XMind 一致。
    const circle = g.querySelector(":scope > circle") as SVGCircleElement | null;
    if (circle) {
      circle.setAttribute("cx", String(6 + w + padX));
      circle.setAttribute("cy", String(h / 2));
    }

    // 文字色写到 foreignObject 上，节点内容会继承
    fo.style.color = st.fg;
    g.classList.toggle("obmind-root", isRoot);
  }

  /**
   * 画一条 XMind 风格的入线：从父卡片右边缘的**垂直中心**，平滑弯到子卡片左边缘的垂直中心。
   *
   * markmap 自带的连线接在每个节点矩形的**底边**（所以看起来像“线贴在卡片下面”），
   * 且粗细/位置都无法通过选项调整，因此原生连线已在 CSS 里隐藏，这里全部自绘。
   *
   * 路径画在**子节点自己的 g 内**，坐标为子节点的局部坐标：
   * 父节点的绝对位移减去子节点位移即可，自动跟随平移与缩放，无需任何屏幕坐标换算。
   */
  private paintLink(info: NodePaintInfo, parent: NodePaintInfo | null, spec: ThemeSpec): void {
    if (!parent) return;
    const { g, ox, oy, h, padX } = info;

    // 父卡片右边缘（绝对坐标 → 子节点局部坐标）
    const startX = parent.ox + 6 + parent.w + parent.padX - ox;
    // 父卡片垂直中心
    const startY = parent.oy + parent.h / 2 - oy;
    // 子卡片左边缘 / 垂直中心
    const endX = 6 - padX;
    const endY = h / 2;

    const span = endX - startX;
    const ctrl = Math.max(10, Math.abs(span) * 0.45);
    const dir = span >= 0 ? 1 : -1;
    const d =
      `M ${startX} ${startY} ` +
      `C ${startX + ctrl * dir} ${startY}, ${endX - ctrl * dir} ${endY}, ${endX} ${endY}`;

    let link = g.querySelector(":scope > path.obmind-node-link") as SVGPathElement | null;
    if (!link) {
      link = document.createElementNS(SVG_NS, "path") as SVGPathElement;
      link.setAttribute("class", "obmind-node-link");
      // 插到卡片之前：卡片后绘制，能盖住线头，视觉上正好接在边缘
      const card = g.querySelector(":scope > rect.obmind-node-card");
      g.insertBefore(link, card ?? g.firstChild);
    }
    const branch = spec.colors[branchIndex(info.path) % spec.colors.length];
    link.setAttribute("d", d);
    link.setAttribute("fill", "none");
    link.setAttribute("stroke", branch);
    link.setAttribute("stroke-width", String(spec.linkWidth));
    link.setAttribute("stroke-linecap", "round");
    link.setAttribute("opacity", "0.9");
  }

  private schedulePaint(): void {
    if (this.painting) return;
    if (this.paintTimer !== null) return;
    this.paintTimer = window.setTimeout(() => {
      this.paintTimer = null;
      this.paintNodes();
    }, 30);
  }

  private buildOptions(spec: ThemeSpec): MarkmapOptions {
    return {
      // 连线与折叠圆点的颜色：根节点用强调色，其余跟随所属一级分支
      color: (node: INode): string => {
        if (!node.state || node.state.depth === 0) return spec.rootBg;
        return spec.colors[branchIndex(node.state.path) % spec.colors.length];
      },
      paddingX: 6,
      spacingHorizontal: 72,
      // 卡片上下各外扩 5px，垂直间距留够，否则相邻卡片视觉上会粘在一起
      spacingVertical: 18,
      duration: 200,
      maxWidth: spec.card ? 380 : 640,
      autoFit: true,
      fitRatio: 0.92,
    };
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
      const tree = buildTree(content, file.basename, {
        filterFrontmatter: this.plugin.settings.filterFrontmatter,
      });

      const isDark = document.body.classList.contains("theme-dark");
      const spec = resolveTheme(this.plugin.settings.theme, isDark);
      this.applyTheme(spec);

      const opts = this.buildOptions(spec);
      const themeKey = `${spec.id}:${spec.dark ? "d" : "l"}`;

      if (!this.mm) {
        this.mm = Markmap.create(this.svgEl, opts, tree);
      } else {
        if (themeKey !== this.appliedThemeKey) this.mm.setOptions(opts);
        // setData 会重新走一遍 renderData，连线/圆点颜色按新色板刷新
        await this.mm.setData(tree);
      }
      this.appliedThemeKey = themeKey;
      this.paintNodes();
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
    if (this.paintTimer !== null) {
      window.clearTimeout(this.paintTimer);
      this.paintTimer = null;
    }
    this.mm?.destroy();
    this.mm = null;
    this.svgEl = null;
    this.canvasEl = null;
    this.themeSelect = null;
  }
}
