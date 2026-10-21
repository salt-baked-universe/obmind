import { App, PluginSettingTab, Setting } from "obsidian";
import type MindmapPlugin from "./main";
import type { MindmapTheme } from "./theme";
import { DEFAULT_NAV_SYNC, NAV_SYNC_OPTIONS, normalizeNavSync } from "./app/NavPolicy";
import type { NavSyncMode, NavSyncOption } from "./app/NavPolicy";

export type { MindmapTheme };
export { THEME_OPTIONS } from "./theme";

export interface ObmindSettings {
  theme: MindmapTheme;
  filterFrontmatter: boolean;
  /** 面包屑跳转时，笔记窗口是否跟随、怎么跟随 */
  navSync: NavSyncMode;
}

export const DEFAULT_SETTINGS: ObmindSettings = {
  theme: "follow",
  filterFrontmatter: true,
  navSync: DEFAULT_NAV_SYNC,
};

export class ObmindSettingTab extends PluginSettingTab {
  private plugin: MindmapPlugin;

  constructor(app: App, plugin: MindmapPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("过滤笔记属性")
      .setDesc("生成导图时跳过笔记顶部的 YAML frontmatter（属性区）。主题请在思维导图视图顶部切换。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.filterFrontmatter);
        toggle.onChange(async (value) => {
          this.plugin.settings.filterFrontmatter = value;
          await this.plugin.saveSettings();
          this.plugin.refreshMindmap();
        });
      });

    // 面包屑与笔记视图的联动：四档，默认「跟随当前笔记窗口」。
    // 说明文字跟着选择变，否则四档的差别只能靠标签猜。
    const hint = containerEl.createDiv({ cls: "setting-item-description obmind-nav-hint" });
    const paintHint = (mode: NavSyncMode): void => {
      const hit: NavSyncOption | undefined = NAV_SYNC_OPTIONS.find(
        (o: NavSyncOption) => o.value === mode,
      );
      hint.setText(hit ? hit.desc : "");
    };

    new Setting(containerEl)
      .setName("面包屑与笔记视图联动")
      .setDesc("在导图里点双链、或用面包屑回退时，笔记窗口怎么跟随。")
      .addDropdown((dd) => {
        for (const opt of NAV_SYNC_OPTIONS) dd.addOption(opt.value, opt.label);
        const current: NavSyncMode = normalizeNavSync(this.plugin.settings.navSync);
        dd.setValue(current);
        paintHint(current);
        dd.onChange(async (value: string) => {
          const mode: NavSyncMode = normalizeNavSync(value);
          this.plugin.settings.navSync = mode;
          paintHint(mode);
          await this.plugin.saveSettings();
        });
      });
  }
}
