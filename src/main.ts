import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MindmapView, MINDMAP_VIEW_TYPE } from "./MindmapView";
import { DEFAULT_SETTINGS, ObmindSettingTab } from "./settings";
import type { ObmindSettings } from "./settings";
import { THEMES } from "./theme";
import type { MindmapTheme } from "./theme";

const THEME_CYCLE: MindmapTheme[] = ["follow", ...THEMES.map((t) => t.id)];

export default class MindmapPlugin extends Plugin {
  settings: ObmindSettings = DEFAULT_SETTINGS;

  async onload() {
    // 设置读不出来不该拖垮整个插件，退回默认值继续跑。
    try {
      await this.loadSettings();
    } catch (err) {
      console.error("[obmind] 读取设置失败，改用默认设置", err);
      this.settings = { ...DEFAULT_SETTINGS };
    }

    // 视图注册必须幂等。
    // 上一次加载若在 onload 中途抛错，Obsidian 禁用插件时**不会**回滚已注册的视图类型；
    // 残留会让下一次开启直接死在 "Attempting to register an existing view type" 上，
    // 而且从此永久卡死——每次重试都撞同一堵墙。
    this.safely("注册视图", () => {
      this.registerView(
        MINDMAP_VIEW_TYPE,
        (leaf: WorkspaceLeaf) => new MindmapView(leaf, this),
      );
    });

    this.safely("添加侧边栏图标", () => {
      this.addRibbonIcon("network", "obmind：打开当前笔记思维导图", () => {
        void this.activateView();
      });
    });

    this.safely("添加命令", () => {
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

      // 操作栏上的按钮同样能在命令面板里找到 ——
      // 键盘用户不必为了「全部折叠」去够鼠标，也让这些动作可以被快捷键绑定。
      this.addCommand({
        id: "mindmap-collapse-all",
        name: "折叠全部节点",
        callback: () => this.withMindmap((view) => view.setAllFolds(true)),
      });

      this.addCommand({
        id: "mindmap-expand-all",
        name: "展开全部节点",
        callback: () => this.withMindmap((view) => view.setAllFolds(false)),
      });

      this.addCommand({
        id: "mindmap-fit",
        name: "缩放导图到适合窗口",
        callback: () => this.withMindmap((view) => view.fitView()),
      });

      this.addCommand({
        id: "mindmap-reread",
        name: "重新读取笔记并重绘导图",
        callback: () => this.withMindmap((view) => void view.refresh()),
      });
    });

    this.safely("添加设置页", () => {
      this.addSettingTab(new ObmindSettingTab(this.app, this));
    });
  }

  onunload(): void {
    // 不清理的话，重载插件后旧视图仍挂在 leaf 上，
    // 持有 markmap 实例与 MutationObserver，既泄漏又会让类型注册不清爽。
    this.app.workspace.detachLeavesOfType(MINDMAP_VIEW_TYPE);
  }

  /**
   * 执行一步 UI 注册，失败只提示不抛出。
   * 插件「能加载、少个入口」远好过「整个插件加载失败被禁用」。
   */
  private safely(step: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const detail: string =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (/existing view type/i.test(detail)) {
        // 残留注册，说明这个视图已经可用，忽略即可
        console.warn(`[obmind] ${step}：视图类型已存在，跳过`, err);
        return;
      }
      console.error(`[obmind] ${step}失败`, err);
      new Notice(`obmind ${step}失败：${detail}`, 15000);
    }
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

  /**
   * 对「当前打开的那个导图」执行一个动作。
   *
   * 命令面板不区分焦点在哪个面板，所以这里统一取第一个导图视图；
   * 没有打开时给一句明确提示，而不是静默什么都不发生 ——
   * 静默失败是最难排查的一类问题。
   */
  private withMindmap(action: (view: MindmapView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MindmapView) {
        action(view);
        return;
      }
    }
    new Notice("obmind：先打开思维导图（左侧图标，或命令「打开当前笔记思维导图」）");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
