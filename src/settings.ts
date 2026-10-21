import { App, PluginSettingTab, Setting } from "obsidian";
import type MindmapPlugin from "./main";
import type { MindmapTheme } from "./theme";

export type { MindmapTheme };
export { THEME_OPTIONS } from "./theme";

export interface ObmindSettings {
  theme: MindmapTheme;
  filterFrontmatter: boolean;
}

export const DEFAULT_SETTINGS: ObmindSettings = {
  theme: "follow",
  filterFrontmatter: true,
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
  }
}
