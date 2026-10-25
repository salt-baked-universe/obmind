# Weaver Mindmap

**Draw your note as a mind map. Edit the map — the note follows.**

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](./LICENSE)
[![Obsidian 1.7.2+](https://img.shields.io/badge/Obsidian-1.7.2%2B-7c3aed)](https://obsidian.md)

Weaver Mindmap reads the outline of the note you are working on — its headings and its indentation — and draws it as an interactive, XMind-style map in the sidebar. Every change you make on the map (rename a node, add a child, outdent, delete a branch, drag a node onto a new parent) is written back to **the same Markdown file**. There is no second document to keep in sync and no private format to export from: after the plugin is gone, your notes are still just notes.

<!-- Screenshots: put files in images/ and uncomment
![Weaver Mindmap in the sidebar](./images/screenshot.png)
-->

## Why this one

Most mind-map plugins either export a snapshot, or keep the map in a separate file that silently drifts away from the note. This one takes the note as the only source of truth and edits it in place:

- **Two-way, not one-way.** The map is a view over the note, so there is nothing to reconcile.
- **Writes are verified before they land.** Every edit is checked against the exact source lines it was derived from. If the note changed underneath (another plugin, an external editor, a sync client), the write is aborted and you get a notice — never a shifted, half-rewritten file.
- **Blocks are real nodes.** A code fence, a formula, a table or a quote is not flattened into a text label: it hangs under its nearest heading as a read-only, fully rendered card, with syntax highlighting, KaTeX and a copy button.
- **Callouts become containers.** `> [!note] Title` gets its own node, and its body nests underneath it.
- **Gestures match the device.** A mouse wheel zooms notch by notch; a trackpad two-finger gesture pans and a pinch zooms. The decision is made per gesture, not from an assumed pixel-per-notch constant.
- **No network, no telemetry.** The plugin makes no requests and touches nothing outside the current vault.

## Features

| | |
| --- | --- |
| **Live map of the active note** | Opens in the right sidebar and follows the note you switch to. Edits in the note redraw the map. |
| **Edit the map, edit the note** | Rename, new child, new sibling, outdent, delete, drag-to-reparent. Anchor lines are verified before writing. |
| **Drag to restructure** | Drop a node on another to re-parent it; drop on empty canvas to cancel. Select several nodes and drag the whole subtree as one block. |
| **Multi-select** | `Ctrl`+click to add or remove, `Shift`+click for a range of siblings, drag on empty canvas for a box selection. |
| **Node bar** | Single selection pops a small vertical toolbar at the right edge of the canvas: edit / child / sibling / outdent / delete / new note. |
| **Note from node** | `Ctrl+N` creates a note named after the node, links it with a `[[wikilink]]`, and jumps there. Reuses an existing note with the same name; can fill from a template. |
| **Breadcrumb + pin** | Walk into linked notes from the map; pin the map to keep it on one note while notes keep opening normally. |
| **Blocks as first-class nodes** | Code, math, tables and quotes render as read-only cards; a copy button is injected into every code block. |
| **Paste as children** | `Ctrl+V` turns clipboard lines into child nodes of the selection — one line, one node. |
| **Five themes** | Classic, business, dark, candy, minimal — plus "follow appearance". Branch colours stick to a branch by name, so inserting a line does not repaint the map. |
| **SVG export** | Exports the whole map, not just the viewport, with styles inlined so it looks the same anywhere. |
| **Undo / redo** | Snapshot-based history over the whole note, `Ctrl+Z` / `Ctrl+Shift+Z`. |
| **Line sync** | Optionally scroll the editor to the line of the selected node. |

## How a note becomes a map

| In the note | On the map |
| --- | --- |
| File name | Root node |
| `#` … `######` | One level per heading depth |
| Indented lines / list items | One level per indent step (tabs count as 4 columns; the indent width is auto-detected per note) |
| Code fence, `$$…$$`, table, blockquote | Read-only card attached to the nearest preceding node |
| `> [!note] Title` callout | Its own node; the body is de-quoted one level and nests under it |

Only two hierarchies exist — headings and indentation — and new nodes follow whichever one their target belongs to, so the two never get mixed inside one branch.

## Install

**Community plugins** — once listed: *Settings → Community plugins → Browse* → search `Weaver Mindmap`.

**BRAT** — add this repository in [BRAT](https://github.com/TfTHacker/obsidian42-brat) before it is listed.

**Manual** — copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/obmind-map/`, restart Obsidian, enable the plugin.

## Getting started

1. Open a note that has headings or an indented outline.
2. Click the network icon in the left ribbon, or run **Open mind map for current note** from the command palette.
3. The map appears in the right sidebar. Click a node to select it, double-click to rename it, drag it to move it.

## Keyboard and mouse

| Input | Result |
| --- | --- |
| Click | Select a node |
| `Ctrl`+click | Add to / remove from the selection |
| `Shift`+click | Select a range of siblings |
| Drag on empty canvas | Box selection |
| Left-drag a node | Move it (drop on a node to re-parent, on empty canvas to cancel) |
| Right-drag | Pan |
| Double-click / `F2` / `Space` | Edit in place (text is fully selected, so typing replaces it) |
| `Enter` (editor) | Commit and exit |
| `Ctrl+Enter` (editor) | Commit and create a sibling |
| `Enter` (canvas) | New sibling |
| `Tab` (canvas) | New child |
| `Shift+Tab` | Outdent one level |
| `Delete` / `Backspace` | Delete the node and its subtree |
| `↑` `↓` | Move the selection along the document order |
| `←` `→` | Jump to the parent / first child |
| `Ctrl+N` | Create a note for the node and link it |
| `Ctrl+V` | Paste clipboard lines as children |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / fit |
| `Alt`+click | Open the note with the same name |
| `Esc` | Clear the selection, close the node bar |

## Settings

| Setting | What it does |
| --- | --- |
| **Filter frontmatter** (过滤笔记属性) | Skip the YAML block at the top of the note when building the map. On by default. |
| **Sync editor line** (选中节点同步笔记行) | Scroll the note editor to the selected node's line. |
| **Wheel action** (滚轮操作) | What the wheel / trackpad does inside the map: auto (detect per gesture, default), always zoom, always pan. `Ctrl`+wheel and pinch always zoom. |
| **Breadcrumb follow** (面包屑与笔记视图联动) | Four modes controlling whether the note pane follows when you open a link or go back from the map: map only, reuse the current pane (default), new tab closed on back, new tab kept on back. |
| **New note template** (新建笔记模板) | Path of a template note used by *Note from node*. Supports `{{title}}`, `{{date}}`, `{{time}}`, `{{from}}`, with date formats such as `{{date:YYYY-MM-DD}}`. Empty means a blank note. |

## Commands

Open mind map for current note · Switch mind-map theme · Collapse all · Expand all · Fit to window · Re-read note and redraw · Create note for selected node and link it.

Two diagnostic commands (*start / stop flicker log*, *save flicker log to vault root*) exist for bug reports. They write a log file into your vault and nothing else.

## Compatibility

- Obsidian **1.7.2** or newer.
- Desktop first: the plugin loads on mobile, but the gestures are designed for a mouse and a trackpad.

## Privacy and permissions

- **No network.** The plugin makes no requests of any kind and has no telemetry, no account, no update check of its own.
- **Vault only.** It reads the note you are looking at and writes back the lines you edited. Nothing outside the vault is touched, and the diagnostic log command writes its file into the vault root.
- **Clipboard.** The plugin reads the system clipboard only when you press `Ctrl+V` inside the map (to paste lines as child nodes), and writes to it only when you explicitly copy a node or a code block. Clipboard content is never stored or sent anywhere.
- **Local storage.** Two small preferences — the last code-block language you picked, and the diagnostic switch — are kept in the plugin's local storage in Obsidian, so they survive a restart. Notes and vault contents are never stored there.

## Troubleshooting

- **The map looks empty right after opening** — it waits for the pane to settle, then fits. If it stays blank, run *Re-read note and redraw*.
- **A write was refused** — the note changed while the map was open, so the plugin did not dare to write. Re-read the note (the map refreshes by itself) and repeat the edit.
- **The wheel pans when it should zoom** — your driver reports wheel gestures that look like a trackpad. Pin the behaviour in *Wheel action*.

## Development

```bash
npm install
npm run dev     # watch + rebuild
npm run build   # tsc --noEmit, then esbuild production
npm test        # unit tests (Node, no Obsidian needed)
```

`main.js` is a build artifact and ships with each release. The source is organised in layers (`domain` → `render` / `ui` / `export` → `edit` → `app` → `view`); `domain` never imports the Obsidian API, which is why most parsing and edit-planning logic is testable in plain Node.

## Acknowledgements

- [markmap](https://github.com/markmap/markmap) — the layout and rendering engine (MIT).
- [d3](https://d3js.org) — zoom and transitions (ISC).
- The Obsidian team, for a plugin API that makes a view like this possible.

## License

[GNU General Public License v3.0](./LICENSE) — SPDX `GPL-3.0-or-later`.

Copyright (C) 2026 郭源潮

You may use, study, modify and redistribute this plugin freely. **If you distribute a modified version, it must remain open source under the same license and include the source.** For closed-source commercial use, contact the author for a separate grant.

The bundled dependencies (markmap, d3) are MIT/ISC and compatible with the GPL; their notices are preserved in the banner of `main.js`.

---

## 中文说明

把当前笔记的大纲（文件名当根，标题层级与缩进当分支）画成一张可交互的思维导图；在图上改字、拖节点、增删分支，写回的都是同一份 Markdown 原文——不是另存一份导图文件，插件删了笔记还是笔记。

### 和同类插件的区别

多数思维导图插件要么导出一张快照，要么把导图存进另一个文件、与原文悄悄分叉。这个插件以笔记为唯一数据源，就地编辑：

- **双向，不是单向**：导图是笔记的一个视图，不存在「需要对齐」的第二份数据。
- **写入前校验锚点**：每次编辑都对照它起源的那几行原文校验；期间笔记被别的插件／同步工具改过，就中止写入并提示，绝不写出一份错位的文件。
- **块是独立节点**：代码块、公式、表格、引用不会压成一行文字，而是挂在最近的节点下面，按原样渲染（高亮、KaTeX、复制按钮）。
- **callout 是容器**：`> [!note] 标题` 自成节点，正文嵌在它下面。
- **手势按设备区分**：鼠标滚轮一格一格缩放，触摸板双指平移、捏合缩放。
- **不联网、不遥测**。

### 功能

- 右侧边栏打开，跟随当前笔记；笔记改动自动重绘
- 改字 / 建子级 / 建同级 / 提升层级 / 删除 / 拖动换父级，全部回写原文
- 多选：`Ctrl`+单击加减选、`Shift`+单击选同级区间、空白处拖框选
- 选中单个节点时右侧弹出浮动条：改 / 子 / 同 / 提 / 删 / 新建笔记
- 节点 → 新笔记：建文件、写双链、跳过去，可套模板
- 面包屑 + 钉住：顺双链在笔记间走，或钉住导图让笔记照常切换
- 五套主题（另有跟随外观）；分支色按**分支名**固定，插一行不会满屏跳色
- 导出完整图的 SVG（样式内联）
- 撤销 / 重做（整篇快照）
- 粘贴剪贴板内容为子节点（一行一个）
- 选中节点时笔记窗口可跟随滚动到对应行

### 笔记怎么变成图

| 原文 | 图上的样子 |
| --- | --- |
| 文件名 | 根节点 |
| `#` ~ `######` | 按级数分层 |
| 正文缩进 / 列表项 | 按缩进层级分层（制表符按 4 空格算，缩进宽度按整篇自动识别） |
| 代码块 / 公式 / 表格 / 引用 | 只读卡片，挂在**前面最近的节点**下 |
| `> [!note] 标题` callout | 自己成节点，正文剥一层 `>` 后继续分层 |

层级只有两套体系（标题 / 缩进），新增节点跟随目标所在的那一套，不会混着来。

### 安装

上架后：**设置 → 第三方插件 → 浏览** 搜 `Weaver Mindmap`。未上架前用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加本仓库。手动安装：把 `main.js`、`manifest.json`、`styles.css` 放进 `<库>/.obsidian/plugins/obmind-map/`，重启后在第三方插件里启用。

### 用法

1. 打开一篇有层级的笔记。
2. 点左侧栏的网络图标，或在命令面板执行「打开当前笔记思维导图」。
3. 导图出现在右侧边栏。单击选中、双击改名、拖动换位置。

### 键鼠

| 操作 | 效果 |
| --- | --- |
| 单击 / `Ctrl`+单击 / `Shift`+单击 | 选中 / 加减选 / 选同级区间 |
| 空白处拖动 | 框选 |
| 左键拖节点 | 移动（拖到节点上换父级，拖到空白处松手取消） |
| 右键拖动 | 平移画布 |
| 双击 / `F2` / 空格 | 进入编辑（默认全选，直接打字即替换） |
| `Enter` / `Tab`（画布） | 新建同级 / 子级 |
| `Enter`（编辑框） / `Ctrl+Enter` | 提交退出 / 提交并新建同级 |
| `Shift+Tab` | 提升一级 |
| `Delete` / `Backspace` | 删除节点及其整棵子树 |
| `↑` `↓` / `←` `→` | 按文章顺序移动 / 跳到父节点、长子节点 |
| `Ctrl+N` / `Ctrl+V` | 为节点建笔记并双链 / 粘贴为子节点 |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 适合窗口 |
| `Alt`+单击 | 按其文字打开同名笔记 |
| `Esc` | 取消选中、关闭浮动条 |

### 设置

- **过滤笔记属性**：生成导图时跳过笔记顶部的 YAML 属性区（默认开）。
- **选中节点同步笔记行**：把左侧笔记的光标 / 滚动跟到对应行。
- **滚轮操作**：`自动` / 永远缩放 / 永远平移。`Ctrl`+滚轮与捏合始终缩放。
- **面包屑与笔记视图联动**：四档，决定点双链或回退时笔记窗口怎么跟随。
- **新建笔记模板**：模板笔记路径，支持 `{{title}}`、`{{date}}`、`{{time}}`、`{{from}}`，日期可带格式如 `{{date:YYYY年MM月DD日}}`；留空则新建空白笔记。

### 兼容性

- 最低 Obsidian 版本：`1.7.2`
- 桌面优先。移动端可加载，但手势按桌面设计，未做触屏优化。

### 隐私与权限

- **不联网**：不发任何请求，无遥测、无账号、不自带更新检查。
- **只碰当前库**：读你正在看的笔记，写你改过的那几行；诊断日志写到库根目录。
- **剪贴板**：只在图里按 `Ctrl+V` 时读一次（把行粘成子节点），只在你明确点「复制」时写入；内容不落盘、不外发。
- **本地存储**：只在 Obsidian 的本地存储里放两项小偏好（上次选的代码块语言、诊断开关），不存笔记内容。

### 反馈

有问题请开 issue，附上 Obsidian 版本、插件版本、复现步骤。渲染类问题可执行「开始/停止闪烁日志」，复现一次后用「保存闪烁日志到库根目录」把日志一起贴上来。

### 开发

```bash
npm install
npm run dev     # 监听编译
npm run build   # 类型检查 + 打包 production
npm test        # Node 里跑用例，不需要 Obsidian
```

`main.js` 是构建产物，随 release 发布。源码按层组织（`domain` → `render` / `ui` / `export` → `edit` → `app` → 视图），`domain` 不 import Obsidian API，所以解析与编辑计划的大部分逻辑能在纯 Node 里测。
