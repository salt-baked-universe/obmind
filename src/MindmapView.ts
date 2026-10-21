import {
  ItemView,
  WorkspaceLeaf,
  MarkdownView,
  TFile,
  debounce,
} from "obsidian";
import { Transformer } from "markmap-lib";
import { Markmap, loadCSS, loadJS } from "markmap-view";
import { noteToMarkdown } from "./parser";

export const MINDMAP_VIEW_TYPE = "mindmap-view";

export class MindmapView extends ItemView {
  private transformer: Transformer;
  private mm: Markmap | null = null;
  private svgEl: SVGSVGElement | null = null;
  // 防止并发刷新导致对同一 svg 重复 create 出多个 Markmap 实例。
  private refreshing = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.transformer = new Transformer();
  }

  getViewType(): string {
    return MINDMAP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Mindmap";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement; // 通常是 .view-content
    container.empty();

    const svg = container.createSvg("svg");
    svg.style.width = "100%";
    svg.style.height = "100%";
    this.svgEl = svg;

    // 首次渲染
    void this.refresh();

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

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const activeMdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeMdView || !activeMdView.file) return;

      const basename = activeMdView.file.basename;
      const content = activeMdView.editor.getValue();
      const md = noteToMarkdown(content, basename);

      const { root, features } = this.transformer.transform(md);
      const { styles, scripts } = this.transformer.getUsedAssets(features);

      // loadCSS / loadJS 返回 Promise，必须在创建/更新前 await，
      // 否则 math / 代码高亮等依赖脚本可能未就绪。
      if (styles?.length) await loadCSS(styles);
      if (scripts?.length) await loadJS(scripts);

      if (!this.svgEl) return;

      if (this.mm) {
        await this.mm.setData(root);
      } else {
        this.mm = Markmap.create(this.svgEl, undefined, root);
      }
    } finally {
      this.refreshing = false;
    }
  }

  onNodeClick(e: MouseEvent): void {
    const target = e.target as Element;
    // 点击节点前的折叠圆点交给 markmap 自身处理，避免折叠与跳转冲突。
    if (target.closest("circle")) return;

    const g = target.closest("g.markmap-node") as SVGGElement | null;
    if (!g) return;

    // markmap 用 <foreignObject> 渲染文本，没有原生 <text>，故取 g.textContent。
    const text = g.textContent?.trim();
    if (!text) return;

    const dest = this.app.metadataCache.getFirstLinkpathDest(text, "");
    if (dest instanceof TFile) {
      void this.app.workspace.getLeaf("tab").openFile(dest);
    }
  }

  async onClose(): Promise<void> {
    this.mm?.destroy();
    this.mm = null;
    this.svgEl = null;
  }
}
