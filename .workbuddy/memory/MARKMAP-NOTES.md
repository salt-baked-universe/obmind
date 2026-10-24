# obmind 项目约定

Obsidian 插件：笔记 → XMind 风格思维导图。当前 1.18.13（`manifest.json` / `package.json` / `versions.json` 三处同步）。

分层（依赖单向向下，`domain` 不 import obsidian、不碰 DOM）：
`types`(L0) → `domain`(L1，行内渲染以 `render` 注入) → `render`/`ui`(L2) → `edit`(L3) → `app`(L4) → `MindmapView`(L5)。
- L0 `types.ts` 跨层契约（`SrcRef` / `BlockInfo` / `TreeNode`）
- L1 `domain/`：syntax（buildTree / 块 / callout 摊平）、nav、stats
- L2 `render/`：painter、frame、colors、viewport、geometry、trace；`ui/`：toolbar、nodeBar、nodeBarPosition、keyGuard；`export/svg.ts`
- L3 `edit/`：writer（`applyOp` 唯一写出口）、move、create、block、text、inlineText、drag、boxSelect
- L4 `app/`：runtime（phase+rev）、EditService/QueryService、NavStack/NavPolicy、History（整篇快照，上限 40）、notePlan、plan（投影）
- L5 `MindmapView`：事件翻译 + 投影 + 面板渲染 + 操作分发；`parser.ts` 只是组装层

## markmap 硬约束

1. **文字更新绝不用 setData**（key = 父id.子id + content hash）→ `applyPatch` 改 DOM；结构变化才 setData（`duration: 0` + 同步 `paintNow()`）。patch 不能重算 state.key，但**必须回写 `__data__.payload.src`**（换引用，别 Object.assign），否则「卡片新字、点开编辑旧字」。
2. 每个内容 div 挂 `ResizeObserver(debounce 100)` → 重建后必再整树重排一次。`reflowSoon/reflowNow`（下一帧 duration=0 跑 `renderData`+`paintNow`+`paintSelection`），闸门只挡 `rebuilding`（编辑态 DOM 是完整的）。
3. key 含全局 DFS id → 插一行其后全换 key → 全量 enter。enter 起点是 `m[父id] || 根rect`，而 `m` 只由 **update 集合** 填充 → 全量 enter 全落根节点右下角。
4. `attr("class", …)` 整段重写会抹掉 `obmind-selected`：重排后必须 `paintSelection()`；它还会 `transition().style("opacity",1)`，折叠淡出到一半时别调。
5. 观察器听 `transform`/`class`/`style`/`width`/`height`。同值过滤：transform 用 `oldValue === 当前值`（每帧无条件重写全部 transform）；`width/height` 每次 renderData 才写一次。childList 排除自插的 `obmind-node-*` 与 foreignObject 内部（`isContentChurn`）。`transform` → `paintMoved` 必须**同步**画；结构那批常同时有 transform：先 `paintMoved(moved)` 再 `requestAll()`。
6. 连线是 **f(子卡片, 父卡片)** 纯函数 → 父动子没动的帧子也要重画。取子用 `child.state.path` 索引，**不是** `父path.下标`。`measureDrift()` 重算 `d` 与 DOM 比，`max>1` 即偏差。
7. 自绘装饰必须跟 markmap 淡出（`syncFadeFor` 按 `fo.style.opacity` 同步，事件驱动、不过 blocked 闸门）；消失中的节点冻结连线。判据只对 opacity **递减**生效：`v < 1 && v <= entry.fade`。
8. 收放点：①失去全部孩子时不删 `<circle>` 也不清零 r → 按 `__data__.children` 判显示；②缩小用 `translate() scale(.7)`，`transform-box/origin` 写内联。
9. 折叠后子节点 `<g>` 从 DOM **删除**；可见序列读 `mm.state.data` 的 fold（解析树是旧副本）。
10. `paintAll` 返回「没画成的节点数」，`paintNow` 隔帧重试 ≤3；`paintMoved` 首次见到的节点要补样式/尺寸/收放点。SVG 内部测量只用属性，`getBoundingClientRect` 会被 scale 放大。
11. 打开偶现空白 = 时序：fit 前 `waitStableSize` 等 **svg** 尺寸；fit 后用 `state.rect` 非空 + `__zoom.k > 0` 自检重试。导航跳转不重置缩放（`keepViewport` 一次性）。
12. 不要缓存「是否隐藏某元素」的布尔：`reset()` 后同一 DOM 带旧 inline 状态回来，直接读 `el.style.display`。
13. **markmap 自己在 setData 后约 100ms 再跑一遍 `renderData`**。`attachSettleHook` 包住实例 `renderData`/`toggleNode`，重建/reflow 后开 1.2s 窗口，窗口内按 duration 0 跑完再 `requestAll()`；`duration===0` 不消费窗口；手动折叠先清窗口（`toggleIntent`）。窗口**必须覆盖 `editing`**（否则进编辑后整图滑一下）。
14. **卡片尺寸只有一个输入：`foreignObject` 的 `width`/`height` 属性**，改它不会让自绘 `<rect>` 变大。只改文字时节点坐标常一点没动（往右长，x/y 不变），transform 全是同值被过滤 → **位置通道收不到信号** → 必须听 `width`/`height` → `paintMoved`。实测只改文字：`transform变=0 width变=1`。
15. 「提交即预览」**不能把重画托付给别人**：它发生在 `editing` 相位，`reflowNow` 曾早退，`applyPatch` 又因 innerHTML 已铺成一样 → `changed=false` → 一次绘制都没发生。凡写了 `fo.width/height` 就当场 `frames.paintMoved([g])`。
16. **`await setData()` 返回时 DOM transform 还是 enter 起点**（终点等 d3 那条 duration=0 过渡的第一帧）。实测（77 节点插 1 个）：+1ms 时 **75 个节点**错位、最大 **1260px**，一帧后归零，每节点只有 2 个 transform 值（**瞬移不是动画**）。修法：`applyTree` 在 `paintNow()` 前 `syncStalePositions()`（只在 `duration===0`、跳过 rect 宽高为 0 的）。
17. 闪烁**不是**透明度问题时：无 `fade.write` + `obs.fadeBatch guard=true` → 查位置（`obs.structural jump`、`f.traj lag`）。
18. **行号漂移不是结构变化**（1.18.12）：`planProjection` 只在 children / depth / content 上判结构，`line` 差异降级 `lineDrift` → 返回 `patch` + `relabel:true`。但行号是**所有定位操作的坐标系**（编辑框初始文本、拖动落点、写盘锚点、选中集），所以必须先把新树 `payload.src` 换引用写回 `mm.state.data`（`relabelTree` 纯函数；结构对不上返回 `null` → 退回重建，宁可慢也不能写错行）。DOM 的 `__data__` 就是 `state.data` 同一批对象，改它不动 `state.key`。判定顺序：**depth 先于 line**，否则「插入一个子级」会被报成 `why=line`。

## 解析（domain/syntax）

19. 层级两套体系：标题（`#` 级数）与正文（缩进），新增节点按目标体系生成。缩进用 `indentOfCols(cols+step, unit)`；制表符按 4 列，`colsOfIndent` 统一度量。深度用**缩进栈**推导（不是 `floor(cols/step)`）；`detectIndent` 取「整除最多行且覆盖 ≥85% 缩进行的最小候选」，否则回退 GCD。
20. **块（围栏代码/公式/表格/普通引用）是宿主的独立只读子节点**（1.18.13 定版）。CommonMark 围栏最多缩 0–3 格，缩到第 4 格退化成「缩进代码块」→ 用 `<!-- obmind:block -->` **代理行**替块承受缩进，块本体顶格；注释在任何 Markdown 工具里都不显示，也不抢 callout / 围栏 / `:::`。两档 `blockNode`：`bound`（裸块，无代理行，层级由围栏缩进决定，**不可拖**）/ `free`（有代理行，层级由代理行决定，可拖）。一个 `RawLine` 就是一个块（`RawLine.block` 非数组），`src.line` = 代理行或围栏行，`blockEnd` 块末行，`proxyLine` 代理行。块在缩进推导中拿深度但**不写缩进栈**（叶子，否则吞掉后续节点）。
21. **callout 是容器**：`> [!note] 标题` 自成节点，正文逐行剥一层 `>` 当虚拟行继续分层。无标题时用正文首行顶上（`promoted` → 区域内层级上移一层）。`buildVLines` 摊平，`v.orig/v.off` 换回原文坐标。
22. 回写先校验锚点行原文，宁可失败也不能错位写；跨多行加 `Span.checkEnd` 尾锚点。`applyOp` 顺带返回新全文，不要再读文件。
23. 回写/移动保留引用前缀（`quoteOf`/`markOf`/`splitLine`）；进出 callout 用 `rebaseQuote` 整块换前缀。callout 标题的「同级」在引用外、`mark` 不沿用 `[!note] `；其子级不能再缩进。
24. 插入块插在**宿主行之后**：代理行缩一层（`src.indent + step`）+ 围栏**顶格**，callout 内每行带 `>`。新建节点插在子树末尾（`subtreeEndOf`，块的子树 = 它自己到 `blockEnd`）。`insertBlock` 产出的块自带代理行；拖动裸块由 `moveNode` 自动补代理行升级为 free（`frozenIn` 只冻块体，代理行跟着缩进走）。
25. GFM 表格要「头行含 `|` + 分隔行 + 分隔行自身含 `|`」；列表项下缩进的表格先 dedent。

## 交互

26. 选中是**集合**：`selectedLines: Set<number>` + `primaryLine`。左键节点=拖动、空白=框选、单击=选中、Ctrl+单击=加减选、Shift+单击=同级区间（先 Shift 后 Ctrl）、Alt+单击=开同名笔记。右键=平移（`mm.zoom.filter` 仅 `button===2`，create/setOptions 后重设），>4px 才压 contextmenu。
27. 整体拖动/批量删除只作用「顶层成员」（`groupOf`）；删除把各区间求并集后一次性 whole 重写。`removeGroup` 返回 `focusLine` → View 必须 `applySelection([focus], focus, false)`。
28. `collectSrc` 不含 depth=0 的根（文件根 depth=1）→ `depth===0` 的根保护是死代码。
29. **「拖动时藏起来的线」必须是谓词不是动作**：`painter.markShifted(roots, on)`，`applyLink` 命中只保证 `display:none`（不写 d、不动缓存），判据消失自然恢复。提层走 `View.raiseNodes()`（`takeRecords` 消化积压 → `disconnect` → 挪 → `observe`；每次 appendChild 产生**两条**记录，别按 class 猜）。收尾 `sweepDragShift(skip)` 跳过 `drag.liveMembers()`。
30. 拖动整块走：节点 g 扁平，只动根 transform 会让子树留原地（飘线）。按 path 前缀收子树 + `groupOf`，给每个成员写 **CSS `translate`**（与 `transform` 叠加，位移 `dx / k`）；摘掉「原父→块根」的线（多选有多个块根）。遮挡靠 `appendChild` 提末尾。
31. 松手：`onDrop` 返回 boolean；true 保持位移等重建，false 当场弹回。**别 rAF 轮询 `isConnected`**（d3 按 key 复用 → 空转到 900ms 兜底）。`applyTree` 调 `drag.settleNow()` + `sweepDragShift()`。摘掉的线只在「不重建 / 900ms 兜底」时还原（松手当场还原 = 斜线飘在屏幕上）。
32. 拖动三坑：① 没有 `data-path` 属性，读 `__data__.state.path`；② `display:""` 恢复不了被 CSS 隐藏的元素；③ Escape/pointercancel 走 `reset(false)`，必须还原摘掉的线。松手后紧跟的 click 用一次性捕获监听吞掉。`onPointerDown` 放行 `a` / `circle` / `.copy-code-button`；`blockNode === "bound"` 不启动拖动。
33. 方向键：↑↓ 只走末端节点（`visibleLeafRefs`），←→ 走父/长子。起点不在序列时按**行号**找最近的。选中后 `ensureVisible(data, {pad:32})`。
34. **编辑框永不产出结构变化**：Enter/Tab 提交退出、Ctrl+↵ 建同级、⇧+Tab 提升一级。空文本=放弃修改；删除只有画布 `removeGroup` 一条路。
35. 编辑框藏原文只用 `visibility: hidden`，**绝不用 opacity**（opacity 已被征用为「消失进度」）。导出时两者一起清。
36. `place()` 带输入签名缓存（位置+fo 尺寸+文本），follow 循环 240ms 无变化收尾；每帧落位 = 每帧强制布局 = 输入发虚。
37. **进编辑一律全选**（用户定版）：`startEdit(g)` 无双参，双击/Enter/F2/空格/新建都全选。`ta.select()` 必须在 `ta.focus()` **之后**。
38. 提交即预览：写盘前用同一个 `renderInline` 铺到卡片，失败用返回的 revert 句柄退回。
39. 键盘拦截挂 `containerEl`；`ui/keyGuard.ts` 的 `isTypingTarget` 让路给输入控件与按钮。
40. 节点浮动条（`ui/nodeBarPosition.ts` 纯函数，右侧竖排），单选才显示。隐藏用 `opacity + pointer-events`。出口：点空白/×/Esc（document 兜底）。`setHidden` 后要重 measure + place。

## 渲染与观感

41. 分支颜色绝不用 path 序号（插删一行满屏跳色）：`render/colors.ts` 用**分支名**为 key 的粘性槽位表，跨 setData 保留，槽位表在 `setData` **之前**刷新。8 色起撞槽后探；实色卡片文字用 `readableOn`。根级块用 `\u0000block:${kind}` 当分支 key。层级靠浓淡：`tintAt` 每深一层递减（地板 35%），非实色主题一级用 `level1Tint`。
42. 节点阴影**保持原样**（同尺寸 rect 下移 2px + 10% 纯色）。`filter: drop-shadow` 每节点一张离屏图，折叠必掉帧。
43. 操作栏：`@container` 不提升优先级（写在基础规则之后）；`container-type` 建层叠上下文 → 浮层靠整块 header 的 z-index（100 / 画布 0）。主题选择用 palette + `Menu`。阈值：480/412/355/310/272。
44. **重绘成本 = 写进 DOM 的属性数**。`paintAll` 冷启 197 节点 = 4954 次写（9ms）。验收线：缓存命中 writes = 0，改一字 < 30。**`reset()` 不能清 `entries`**（markmap 复用同一 g）：单条失效交给 `entryOf` 身份核对（`cached.g === box.g && card.isConnected`）。实测改一字 4954 → 25。
45. `paintMoved` 对尺寸变了的节点也要补 `applySize/applyCircle`。
46. `paintSelection` 用 `(structureGen, 选中集合)` 早退；`structureGen` 在 `applyTree`/`reflowNow` 里 +1。`prune()` 不能按数量相等短路。
47. 导出 SVG：① 清最外层 g 的 zoom transform，viewBox 用 `mm.state.rect`；② `getComputedStyle` 字体/颜色/底色/边框内联到克隆体；③ 补背景色；④ `stripHidden` 用活树样式删 `display:none`（必须在 `inlineForeignStyles` **之后**），收放点 `<circle>` 单独删。验收用 `<img src="data:image/svg+xml,…">`。

## 块卡片（1.18.13）

48. 内容由 `MarkdownRenderer.render` 产 HTML，**必须包一层 `<div class="obmind-block-md markdown-rendered">`** —— 代码底色、语法高亮 token、表格线、引用条、callout、公式全挂在 `.markdown-rendered` 下，少了它只剩「排得下」。渲染必须在 `setData` **之前** await 完成（markmap 读 `foreignObject > div > div` 的 scrollWidth/Height）。缓存 key = `file.path|kind|lang|raw`，`Component` 按轮释放。
49. 复制按钮是**阅读视图后处理**加的，渲染器不给：`decorateCodeBlocks` 给每个 `<pre>` 追加 `<button class="copy-code-button">`，点击走**画布事件委托**（捕获阶段；字符串化会丢监听）。`width: auto` 会让内部 fit-content 塌成 26px → 用 `width: max-content; max-width: 640px`；按节点区分只能靠 `:has(.obmind-block-md)`（`--markmap-max-width` 无法逐节点设）。`pre` 强制 `white-space: pre-wrap; overflow-wrap: anywhere`。
50. 块只读全链路：`startEdit` / 双击（`.obmind-block-md` 内直接 return，让文字可选中）/ 新建 / 插块 / 提层 / 拖动 / 浮动条（只剩删除）/ 新建笔记；纯函数层 `EditService.commit|create|insertBlock`、`moveNode` 的 `child` 模式（块是叶子）全拦。`plan` 层 `srcOf()` 对块返回 `null` → 块绝不走 patch 通道（换 innerHTML 不会重跑渲染器），改块就整树重建；比较用 `kind|lang|raw` 指纹。

## 导航

51. 两步走：先定「导图看哪篇」（`targetFile` + 压栈），再动 leaf。`openDoc` 必须先改 `targetFile` 再 `openFile`。动不动 leaf 由 `navSync` 四档（`NavPolicy`）决定。栈内已有该 path 走 `goBackTo`。
52. 新标签开主区：用主区 markdown 标签的 `parent` 走 `createLeafInParent`，不能 `getLeaf("tab")`；`revealLeaf` 激活导图。
53. **钉住 = 锁「这张图」不锁导航**（用户定版）：点双链/面包屑/Alt+单击，笔记照开、导图不动。唯一分叉 `navigate(file)`：钉住 → `openFileOnly`；否则 `openDoc`。map-only + 钉住点链接 = 什么都不发生。
54. 「节点 → 新笔记」（`app/notePlan.ts` 纯函数）：名字清 `# ^ [ ]` 与 Windows 非法字符；文件夹复用 `vault.getConfig("newFileLocation"/"newFileFolderPath")`；同名复用；**先建文件后改节点**；带行内样式用别名 `[[名|**原文**]]`；跳前清选中集。Ctrl+N 挂 **document 捕获阶段**且只在 `containerEl.contains(target)` 时接管。已有双链时按钮隐藏。

## 构建与验证

- 链路：`npx tsc -noEmit -skipLibCheck` → `npm test`（esbuild + Node，`scripts/testBatch.ts`，T1–T27）→ `node esbuild.config.mjs production`（Windows 沙箱可能 EBUSY）→ `node tmp/smoke.cjs` → 部署到 `D:/BJRepository/2. 知识星球/.obsidian/plugins/obmind` 比 sha1。
- 埋点规矩：**每个可能出问题的分支都要有数字**。`obs.structural` 带 `jump`(px)/`dt`；`render.enter` 记每次重排；`paint.lag` + `f.traj` 量化「DOM 落后布局」；`obs.fade` 只报 opacity 真变了的。假证据比没证据更浪费时间。
- **埋点 1.18.12 起全部停用**：业务侧 60 处 `traceLog`/`traceLogEvery` 与 `startTrajTrace`/`scheduleDrift` 采样体都注释掉了（`src/render/trace.ts` 与命令面板开关保留）。重新排查就在原处解开注释 —— 别另起一套。
- 浏览器行为用 **Python Playwright + `channel="msedge"`**（`D:/Program Files/Python314/python.exe`）；`--virtual-time-budget` 下 rAF 不推进。探针在 `tmp/*.ts|py`：`lagProbe`（落位滞后）、`paintProbe`（writes 成本）、`dragProbe`（真鼠标拖动）、`widenProbe`（改字变宽）、`createProbe3`（duration 量化）、`blockProbe2`（块卡片尺寸）。探针里没有 `MarkdownRenderer`，原生样式只能真机验。
- 现场探针 `src/render/trace.ts`：三档 off/events/frames，开关存 localStorage `obmind:trace`；`window.obmindTrace` + 两条诊断命令。行格式 `+123.4 f0123 tag k=v`。热路径先 `isTracing()`；`installTraceConsole` **不能幂等**。

## 发布

- 授权 **GPL-3.0-or-later**（用户定版：二开必须同样开源）。`LICENSE` 用 gnu.org 官方全文；`src/main.ts` 顶部三段式声明；**`esbuild.config.mjs` 的 banner 必须带 GPL 声明 + 第三方版权许可**（markmap MIT / d3 ISC / @babel/runtime MIT）—— 上架后用户只拿得到 `main.js`。
- 上架流程：`community.obsidian.md` 登录 + 绑 GitHub + Add plugin（不再提 PR）。tag 严格等于版本号（无 `v` 前缀）。
- 仓库仍**无 git remote**，`authorUrl` 待补。
