import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MindmapView, MINDMAP_VIEW_TYPE } from "./MindmapView";
import { DEFAULT_SETTINGS, ObmindSettingTab } from "./settings";
import type { ObmindSettings } from "./settings";
import { THEMES } from "./theme";
import type { MindmapTheme } from "./theme";

const THEME_CYCLE: MindmapTheme[] = ["follow", ...THEMES.map((t) => t.id)];

export default class MindmapPlugin extends Plugin {
  settings: ObmindSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(
      MINDMAP_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new MindmapView(leaf, this),
    );

    this.addRibbonIcon("network", "obmind：打开当前笔记思维导图", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-outline-mindmap",
      name: "打开当前笔记思维导图",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "switch-mindmap-theme",
      name: "切换思维导图主题",
      callback: async () => {
        const index = THEME_CYCLE.indexOf(this.settings.theme);
        this.settings.theme = THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
        await this.saveSettings();
        this.refreshMindmap();
      },
    });

    this.addSettingTab(new ObmindSettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    const activeFile = workspace.getActiveFile();
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      if (!leaf) return;
      await leaf.setViewState({ type: MINDMAP_VIEW_TYPE, active: true });
    }
    // 把「打开导图时正在看的那篇笔记」交给视图，避免切到导图后拿不到活跃笔记
    const view = leaf.view;
    if (view instanceof MindmapView) {
      view.setTargetFile(activeFile instanceof TFile ? activeFile : null);
      void view.refresh();
    }
    workspace.revealLeaf(leaf);
  }

  /** 让所有已打开的思维导图视图重新渲染（主题/过滤设置变更时调用） */
  refreshMindmap() {
    for (const leaf of this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MindmapView) {
        void view.refresh();
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
