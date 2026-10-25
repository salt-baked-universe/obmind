# Outline mindmap

Turn the headings and indentation of the current note into an interactive, XMind-style mind map — and edit the note by dragging nodes around.

把当前笔记的大纲（文件名当根、标题层级与缩进当分支）画成一张可交互的思维导图；改导图就是改笔记，拖动节点就是调整层级。

<!-- Screenshots: drop files into images/ and uncomment the lines below -->
<!-- ![Outline mindmap view](./images/screenshot.png) -->

## Why

An outline you can only read line by line is hard to reason about. This plugin draws the structure, and keeps it **two-way**: renaming, adding, deleting, and dragging nodes in the map writes back to the same Markdown note. There is no separate map file to keep in sync.

## Features

- **Live map of the active note** — opens in the right sidebar and follows the note you are editing.
- **The map is the note** — rename, add child/sibling, outdent, delete and drag-to-reparent all write back to the Markdown source. Anchor lines are verified before writing; a mismatch aborts instead of corrupting the file.
- **Drag to restructure** — drop a node onto another to re-parent it; multi-select and drag a whole subtree. No ghost lines left behind.
- **Blocks are nodes too** — code fences, math, tables and quotes hang under the nearest heading as read-only pills; callouts become containers.
- **Note from node** — `Ctrl+N` creates a note, links it with a `[[wikilink]]` and jumps there, optionally from a template (`{{title}}`, `{{date}}`, `{{time}}`, `{{from}}`).
- **Breadcrumb + pin** — walk into linked notes from the map, or pin the map so notes keep opening normally while the map stays put.
- **Five themes** — classic, business, dark, candy, minimal, plus follow-appearance.
- **SVG export** — exports the whole map (not just the viewport) with styles inlined, so it looks the same anywhere.
- **Wheel that fits the device** — a mouse wheel zooms notch by notch, a trackpad two-finger gesture pans and pinch zooms; the decision is made per gesture rather than assumed from a pixel constant.
- **No network, no telemetry** — the plugin makes no requests and only reads/writes notes in the current vault.

## Install

Search for `Outline mindmap` in **Settings → Community plugins → Browse** once it is listed.

Before that, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository.

Manual install: copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/obmind-map/`, restart Obsidian, then enable the plugin.

## Usage

1. Open a note that has headings or an indented outline.
2. Click the network icon in the left ribbon, or run "打开当前笔记思维导图" from the command palette.
3. The map opens in the right sidebar.

## Keyboard and mouse

| Action | Result |
| --- | --- |
| Click a node | Select it |
| Double-click / `F2` / `Space` | Edit in place (text starts fully selected) |
| `Enter` / `Tab` (canvas) | New sibling / child |
| `Enter` (editor) | Commit and exit |
| `Ctrl+Enter` (editor) | Commit and create a sibling |
| `Shift+Tab` | Outdent one level |
| `Delete` / `Backspace` | Delete the node and its subtree |
| `↑` `↓` | Move the selection along the document order (leaf nodes) |
| `←` `→` | Jump to parent / first child |
| `Ctrl+N` | Create a note for the selected node and link it |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Esc` | Clear the selection |
| `Alt`+click | Open the note with the same name |
| Right-drag | Pan the canvas |
| Wheel | Zoom (mouse) or pan (trackpad) |

## Compatibility

- Obsidian `1.7.2` or newer.
- Desktop first: the plugin loads on mobile but the gestures are designed for a desktop.

## License

[GNU General Public License v3.0](./LICENSE) (SPDX: `GPL-3.0-or-later`)

Copyright (C) 2026 郭源潮

Distributed forks must stay open source under the same license. For closed-source commercial use, contact the author for a separate grant.

The bundled dependencies (`obsidian` typings, `markmap`, `d3`) are MIT/ISC and compatible with GPL-3.0; their notices are kept in the banner of `main.js`.

---

## 中文说明

把 obmind（插件 id：`obmind-map`）的完整说明放在这里，方便中文用户直接看。

### 它解决什么问题

Obsidian 里写了一堆缩进大纲或标题层级，翻回原文只能一行行读。obmind 把这些结构直接画成图，而且**双向**：图上改字、拖节点、增删分支，落盘改的是同一份 Markdown 原文——不是另存一份导图文件。

### 特性

- **就地可视化**：右侧边栏打开，跟随当前笔记；笔记改动自动重绘。
- **图即笔记**：改字、建子级/同级、提升层级、删除、拖动重排全部写回原文，先校验锚点行再写，写错就报错不落盘（宁可不写，也不错位）。
- **拖拽改层级**：拖到别的节点上就是换父级，拖到空白处松手即取消；多选后整块拖动，整棵子树一起走。
- **多选**：`Ctrl`+单击加减选、`Shift`+单击选同级区间、空白处拖框选。
- **节点浮动条**：选中单个节点时在画布右侧弹出改 / 子 / 同 / 提 / 删 / 新建笔记。
- **节点 → 新笔记**：一个动作建好笔记、写好双链、跳过去，可套模板（`{{title}}`、`{{date}}`、`{{from}}` 等变量）。
- **面包屑 + 钉住**：在导图里点双链可以顺着笔记走下去；钉住后导图锁在这张图，笔记照常打开。
- **五套主题**：经典 / 商务 / 深色 / 糖果 / 极简，另有「跟随外观」自动跟随 Obsidian 亮暗。
- **导出 SVG**：导出的是完整图（不只是当前视口），样式全部内联，丢进任何文档都能看。
- **撤销 / 重做**：整篇快照式撤销栈，`Ctrl+Z` / `Ctrl+Shift+Z`。
- **无网络、无遥测**：插件不发起任何网络请求，只读写当前库里的笔记。

### 安装

上架后可在 **设置 → 第三方插件 → 浏览** 里搜索 `Outline mindmap` 安装。

未上架前用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)：添加本仓库地址即可。

手动安装：把 `main.js`、`manifest.json`、`styles.css` 放进 `<库>/.obsidian/plugins/obmind-map/`，重启 Obsidian 后在第三方插件里启用。

### 用法

1. 打开一篇有层级的笔记。
2. 点左侧栏的网络图标，或命令面板执行「obmind：打开当前笔记思维导图」。
3. 导图出现在右侧边栏。

### 笔记怎么变成图

| 原文 | 图上的样子 |
| --- | --- |
| 文件名 | 根节点 |
| `#` ~ `######` 标题 | 按级数分层 |
| 正文缩进 | 按缩进层级分层（制表符按 4 空格算） |
| 代码块 / 公式 / 表格 / 引用 | 不属于任何一个节点，在**前面最近的节点**卡片里显示成一行 pill |
| `> [!note] 标题` callout | 自己成节点，正文按剥掉一层 `>` 后的相对缩进继续分层 |

层级只有两套体系（标题 / 缩进），新增节点会跟随目标所在的那一套，不会混着来。

### 键鼠操作

| 操作 | 效果 |
| --- | --- |
| 单击节点 | 选中 |
| 双击 / `F2` / 空格 | 进入编辑（默认全选，直接打字即替换） |
| `Enter` / `Tab`（画布） | 新建同级 / 子级 |
| `Enter`（编辑框） | 提交并退出 |
| `Ctrl+Enter`（编辑框） | 提交并新建同级 |
| `Shift+Tab` | 提升一级 |
| `Delete` / `Backspace` | 删除选中节点及其整棵子树 |
| `↑` `↓` | 按文章顺序在末端节点间移动选中 |
| `←` `→` | 跳到父节点 / 长子节点（折叠着的会先展开） |
| `Ctrl+N` | 为选中节点新建同名笔记并双链 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Esc` | 取消选中、关闭面板 |
| `Alt`+单击 | 按其文字打开同名笔记 |
| 右键拖动 | 平移画布 |
| 滚轮 | 缩放 |

### 设置

- **过滤笔记属性**：生成导图时跳过笔记顶部的 YAML frontmatter。
- **面包屑与笔记视图联动**：四档，决定点双链/回退时笔记窗口怎么跟随。
- **新建笔记模板**：从节点建笔记时套用的模板笔记路径；留空则新建空白笔记。支持 `{{title}}`、`{{date}}`、`{{time}}`、`{{from}}`，日期可带格式如 `{{date:YYYY年MM月DD日}}`。新建笔记放在哪里跟随 Obsidian 自己的「新建笔记的存放位置」。

### 命令

打开当前笔记思维导图、切换思维导图主题、折叠全部、展开全部、缩放到适合窗口、重新读取并重绘、为选中节点新建笔记并双链，另有两支诊断命令（记录/保存闪烁日志）用于反馈问题。

### 兼容性

- 最低 Obsidian 版本：`1.7.2`
- 桌面端优先。移动端可加载，但手势按桌面设计，未做触屏优化。

### 反馈

有问题请开 issue，尽量附上：Obsidian 版本、插件版本、复现步骤。若能复现渲染问题，可执行命令「obmind：诊断：开始/停止闪烁日志」，复现一次后用「保存闪烁日志到库根目录」把日志一起贴上来。

### 开发

```bash
npm install
npm run dev     # 监听编译
npm run build   # tsc 类型检查 + esbuild 打包 production
```

`main.js` 是构建产物，随 release 一起发布。

> 授权条款见上方 License 一节（中英双语只需一份）。
