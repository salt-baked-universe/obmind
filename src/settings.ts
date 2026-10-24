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
  /**
   * 新建笔记时套用的模板笔记路径（空串 = 不套用，建空白笔记）。
   *
   * 存路径而不是内容：模板是用户笔记库里的一等公民，改模板就是改笔记，
   * 复制一份内容进插件设置之后必然会和原文件分叉。
   */
  noteTemplate: string;
  /** 选中节点时，把左侧同一篇笔记的光标 / 滚动位置跟到对应行 */
  syncNoteLine: boolean;
}

export const DEFAULT_SETTINGS: ObmindSettings = {
  theme: "follow",
  filterFrontmatter: true,
  navSync: DEFAULT_NAV_SYNC,
  noteTemplate: "",
  syncNoteLine: true,
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

    new Setting(containerEl)
      .setName("选中节点同步笔记行")
      .setDesc(
        "在导图里选中一个节点时，把同一篇笔记的编辑器光标与滚动位置跳转到它所在的行。" +
          "多选与框选不跳，避免画面乱窜。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncNoteLine);
        toggle.onChange(async (value) => {
          this.plugin.settings.syncNoteLine = value;
          await this.plugin.saveSettings();
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

    // 新建笔记的模板：只存「哪篇笔记当模板」，内容每次现读。
    // 变量名沿用核心 Templates 插件那一套，从那边迁过来不用重学。
    new Setting(containerEl)
      .setName("新建笔记模板")
      .setDesc(
        "从节点新建笔记（Ctrl+N）时套用这篇模板的内容；留空则新建一篇空白笔记。" +
          "可用变量：{{title}} 笔记名、{{date}} 今天、{{time}} 现在、" +
          "{{from}} 来源笔记的双链。日期时间可带格式，如 {{date:YYYY年MM月DD日}}。" +
          "新建笔记放在哪里，跟随 Obsidian 设置里的「新建笔记的存放位置」。",
      )
      .addText((text) => {
        text.inputEl.addClass("obmind-setting-input");
        text
          .setPlaceholder("模板/笔记模板.md（留空 = 空白笔记）")
          .setValue(this.plugin.settings.noteTemplate)
          .onChange(async (value: string) => {
            // 只改设置，不刷新导图：模板不参与当前的渲染
            this.plugin.settings.noteTemplate = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }
}
