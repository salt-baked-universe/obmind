/*
 * obmind — Obsidian 笔记大纲 → 思维导图插件
 * Copyright (C) 2026 郭源潮
 *
 * 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证第 3 版
 * （或你选择的任何更新版本）条款重新分发和/或修改它。
 *
 * 本程序分发时希望它有用，但不提供任何担保，甚至不含适销性或特定用途适用性的
 * 默示担保。详见 GNU 通用公共许可证。
 *
 * 你应当已随本程序收到一份 GNU 通用公共许可证副本；若没有，见
 * <https://www.gnu.org/licenses/>。
 */
import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MindmapView, MINDMAP_VIEW_TYPE } from "./MindmapView";
import { DEFAULT_SETTINGS, ObmindSettingTab } from "./settings";
import type { ObmindSettings } from "./settings";
import { THEMES } from "./theme";
import type { MindmapTheme } from "./theme";
import {
  installTraceConsole,
  setTraceSaveHook,
  setTraceLevel,
  traceLevel,
  traceText,
} from "./render/trace";

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

    // 现场探针：装到 window.obmindTrace，并在命令面板里给出开关。
    // 放在最前面 —— 后面任何一步失败，用户都能打开日志把原因抓下来。
    this.safely("装载诊断探针", () => this.setupTrace());

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

      // 导图内的 Ctrl+N 已经被视图自己接住（见 MindmapView.onViewKeyDown），
      // 这里再注册一条命令：快捷键被别的插件抢走时，用户还能在设置里重新绑。
      this.addCommand({
        id: "mindmap-create-note",
        name: "为选中节点新建笔记并双链",
        callback: () => this.withMindmap((view) => void view.createNoteForSelected()),
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
   * 装现场探针。
   *
   * 为什么需要它：闪烁/抖动这类问题的证据只在**时序**里，一句「还是闪」
   * 拿不到任何可查的东西。这里给三个入口：控制台里的 `obmindTrace`、
   * 命令面板的「开始/停止」、以及把缓冲落成库里的一份 .log 文件。
   */
  private setupTrace(): void {
    installTraceConsole(() => ({
      version: this.manifest.version,
      theme: this.settings.theme,
      note: this.app.workspace.getActiveFile()?.path ?? "-",
      views: String(this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE).length),
    }));

    setTraceSaveHook(async () => this.saveTraceFile());

    this.addCommand({
      id: "trace-toggle",
      name: "诊断：开始/停止闪烁日志",
      callback: () => {
        const running: boolean = traceLevel() !== "off";
        setTraceLevel(running ? "off" : "events");
        new Notice(
          running
            ? "obmind：已停止记录"
            : "obmind：开始记录 —— 复现一次闪烁，再执行「诊断：保存闪烁日志」",
          6000,
        );
      },
    });

    this.addCommand({
      id: "trace-save",
      name: "诊断：保存闪烁日志到库根目录",
      callback: async () => {
        try {
          const path: string = await this.saveTraceFile();
          new Notice(`obmind：日志已保存到 ${path}`, 8000);
        } catch (err) {
          new Notice(
            `obmind：保存日志失败 —— ${err instanceof Error ? err.message : String(err)}`,
            10000,
          );
        }
      },
    });
  }

  /** 把当前缓冲写进库根的一个 .log 文件（同名覆盖） */
  private async saveTraceFile(): Promise<string> {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const path = `obmind-trace-${stamp}.log`;
    const text: string = traceText();
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, text);
    else await this.app.vault.create(path, text);
    return path;
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
