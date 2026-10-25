# obmind 项目约定

Obsidian 插件：笔记 → XMind 风格思维导图。当前 **1.18.16**（`manifest.json` / `package.json` / `versions.json` 三处同步）。

> 详细推导/实测数据见同目录 **`MARKMAP-NOTES.md`**（不自动注入，需要查证时再读）。

## 分层（单向向下，`domain` 不 import obsidian、不碰 DOM）

L0 `types.ts`（`SrcRef`/`BlockInfo`/`TreeNode`）→ L1 `domain/`（syntax、nav、stats）→ L2 `render/`（painter、frame、colors、viewport、geometry、wheel）+ `ui/` + `export/` → L3 `edit/`（writer＝`applyOp` 唯一写出口、move、create、block、text、inlineText、drag、boxSelect、paste）→ L4 `app/`（runtime、EditService/QueryService、NavStack/NavPolicy、History 快照上限 40、notePlan、plan、actions）→ L5 `MindmapView`（事件翻译 + 投影 + 面板 + 分发；`parser.ts` 只是组装层）。IO 走 `io/`。

## markmap 硬约束

1. 文字更新**绝不用 setData** → `applyPatch`；结构变才 setData（`duration:0` + 同步 `paintNow()`）。patch 不能重算 key，但**必须换引用回写 `__data__.payload.src`**，否则「卡片新字、点开编辑旧字」。
2. 内容 div 挂 `ResizeObserver(100)`；重建后必再整树重排。`reflowSoon/Now` 闸门**只挡 `rebuilding`**（编辑态 DOM 是完整的）。
3. key 含全局 DFS id → 插一行其后全换 key → 全量 enter，起点 `m[父id]||根rect` 而 `m` 只由 update 填充 → 全落根右下角。
4. `attr("class",…)` 整段重写抹掉 `obmind-selected` → 重排后必须 `paintSelection()`；它还 `style("opacity",1)`，折叠淡出一半时别调。
5. 观察器听 `transform`/`class`/`style`/`width`/`height`；同值过滤 transform 用 `oldValue===当前值`。childList 排除 `obmind-node-*` 与 foreignObject 内部。transform→`paintMoved` 必须**同步**画；结构那批先 `paintMoved` 再 `requestAll()`。
6. 连线是 **f(子卡片,父卡片)** → 父动子没动那帧子也要重画。取子用 `child.state.path`，**不是** `父path.下标`。`measureDrift()` 自证 `max>1` 即偏差。
7. 自绘装饰跟 markmap 淡出（`syncFadeFor` 读 `fo.style.opacity`，事件驱动、不过闸门）；判据只对 opacity **递减**生效：`v<1 && v<=entry.fade`。消失中的节点冻结连线。
8. 收放点：失去全部孩子也**不删** `<circle>`、不清零 r（按 `__data__.children` 判显示）；缩小用 `translate() scale(.7)`，`transform-box/origin` 写内联。
9. 折叠后子 `<g>` 从 DOM **删除**；可见序列读 `mm.state.data` 的 fold（解析树是旧副本）。
10. `paintAll` 返回「没画成数」，`paintNow` 隔帧重试 ≤3；`paintMoved` 补首次见的节点。SVG 内部测量只用属性，`getBoundingClientRect` 会被 scale 放大。
11. 打开偶现空白＝时序：fit 前 `waitStableSize` 等 **svg**；fit 后按 `state.rect` + `__zoom.k>0` 自检重试。导航不重置缩放（`keepViewport` 一次性）。
12. 不缓存「是否隐藏」布尔：`reset()` 后同 DOM 带旧 inline 回来 → 直接读 `el.style.display`。
13. markmap **自己会在 setData 后 ~100ms 再跑 `renderData`**。`attachSettleHook` 包住 `renderData`/`toggleNode`，开 1.2s 窗口按 duration 0 跑完再 `requestAll()`；`duration===0` 不消费窗口；手动折叠先清窗口。窗口**必须覆盖 `editing`**。
14. **卡片尺寸唯一输入是 `foreignObject` 的 width/height**；只改文字时坐标常一点没动 → transform 全同值被滤 → **位置通道收不到信号** → 必须听 width/height → `paintMoved`。
15. 「提交即预览」**不能把重画托付给别人**：发生在 `editing` 相位，`reflowNow` 会早退、`applyPatch` 又 `changed=false` → 一次没画。凡写了 `fo.width/height` 当场 `frames.paintMoved([g])`。
16. **`await setData()` 返回时 transform 还是 enter 起点** → `applyTree` 在 `paintNow()` 前 `syncStalePositions()`（只 `duration===0`、跳过 rect 为 0 的）。
17. 闪烁不是透明度问题（无 `fade.write` + `guard=true`）→ 查位置：`obs.structural jump`、`f.traj lag`。
18. **行号漂移不是结构变化**：`planProjection` 只在 children/depth/content 判结构，`line` 降级 `lineDrift` → `patch`+`relabel`。行号是所有定位的坐标系 → 用 `relabelTree` 把新树 `payload.src` **换引用**写回 `mm.state.data`（结构对不上返 `null` → 退回重建）。判定顺序 **depth 先于 line**。

## 解析（domain/syntax）

19. 两套层级：标题（`#`）与缩进。`indentOfCols(cols+step, unit)`；制表符按 4 列。深度用**缩进栈**推导（非 `floor`）；`detectIndent` 取「整除最多行且覆盖 ≥85% 缩进行的最小候选」，否则 GCD。
20. **块（围栏/公式/表格/普通引用）是宿主的独立只读子节点**：`RawLine.block`（单个），`src.line` = 代理行（free）或围栏行（bound），`blockStart/blockEnd` 记行区间，`proxyLine` 记代理行。块在缩进推导里拿深度但**不写缩进栈**（否则吞掉后面紧跟的节点）。`<!-- obmind:block -->` 是代理行：围栏最多缩 0–3 格，块自己扛不了缩进 —— 这条是整套设计的地基。归属看顺序，不看缩进。细节见 `MARKMAP-NOTES.md`。
21. **callout 是容器**：`> [!note] 标题` 自成节点，正文剥一层 `>` 当虚拟行继续分层；无标题用正文首行顶上（`promoted` 层级上移一层）。`v.orig/v.off` 换回原文坐标。
22. 回写先校验锚点行原文，宁可失败不能错位；跨多行加 `Span.checkEnd`。`applyOp` 顺带返回新全文，别再读文件。
23. 回写/移动保留引用前缀（`quoteOf`/`markOf`/`splitLine`）；进出 callout 用 `rebaseQuote` 换整块前缀。callout 标题的「同级」在引用外、`mark` 不沿用 `[!note] `；其子级不能再缩进。
24. 插入块插在**宿主行之后**。**围栏类块（代码/公式）一律顶格**，缩进全由代理行承担 —— 旧版对齐到列表内容列，11 层 tab 的提纲算成 42 列，既不在列表项里又超 3 格，Obsidian 当缩进代码块、` ```python ` 原样露出；引用/表格不是围栏，仍对齐列表内容列。callout 内每行带 `>`。`insertBlock` 自带代理行 + `insertBlockAt`（弹语言选择框前先抓行号，失焦会清选中集）；拖裸块由 `moveNode` 自动补代理行升级 free（`frozenIn` 只冻块体）。语言用 `ui/codeLang.ts` 的 FuzzySuggestModal，50 个常用 + 可自敲，上次的存 localStorage。
25. GFM 表格要「头行含 `|` + 分隔行 + 分隔行自身含 `|`」；列表下缩进表格先 dedent。

## 交互

26. 选中是**集合**：`selectedLines` + `primaryLine`。左键节点=拖、空白=框选、单击=选中、Ctrl=加减选、Shift=同级区间（先 Shift 后 Ctrl）、Alt=开同名笔记。右键=平移（`zoom.filter` 仅 `button===2`，每次 create/setOptions 后重设），>4px 才压 contextmenu。
27. 整体拖动/批量删除只作用顶层成员（`groupOf`）；删除把各区间求并集后一次性 whole 重写。`removeGroup` → View 必须 `applySelection([focus], focus, false)`。
28. `collectSrc` 不含 depth=0 的根 → `depth===0` 的根保护是死代码。
29. **「拖动时藏起来的线」是谓词不是动作**：`painter.markShifted(roots,on)`，`applyLink` 命中只给 `display:none`。提层走 `View.raiseNodes()`（`takeRecords` → `disconnect` → 挪 → `observe`；每次 appendChild 两条记录）。收尾 `sweepDragShift(skip)` 跳过 `drag.liveMembers()`。
30. 拖动整块：节点 g 扁平，只动根 transform 会让子树飘线 → 按 path 前缀收子树 + `groupOf`，给每个成员写 **CSS `translate`**（位移 `dx/k`）；摘掉「原父→块根」的线。遮挡靠 `appendChild` 提末尾。
31. 松手：`onDrop` 返 boolean（true 等重建 / false 当场弹回）。**别 rAF 轮询 `isConnected`**（d3 按 key 复用 → 空转到 900ms）。`applyTree` 调 `settleNow()` + `sweepDragShift()`。摘掉的线只在「不重建/兜底」时还原。
32. 拖动三坑：① 读 `__data__.state.path`（无 `data-path`）；② `display:""` 恢复不了 CSS 隐藏的；③ Escape/pointercancel 走 `reset(false)` 必须还原摘掉的线。松手后的 click 用一次性捕获监听吞掉。放行 `a`/`circle`/`.copy-code-button`；`bound` 块不启动拖动。
33. 方向键：↑↓ 走末端节点（`visibleLeafRefs`）、←→ 走父/长子；起点不在序列按**行号**就近。选中后 `ensureVisible({pad:32})`。
34. **编辑框永不产出结构变化**：Enter/Tab 提交退出、Ctrl+↵ 建同级、⇧+Tab 提升一级。空文本=放弃；删除只走画布 `removeGroup`。
35. 编辑框藏原文只用 `visibility: hidden`，**绝不用 opacity**（已被征用为消失进度）。导出时两者一起清。
36. `place()` 带输入签名缓存，follow 循环 240ms 无变化收尾；每帧落位＝每帧强制布局＝输入发虚。
37. **进编辑一律全选**：`startEdit(g)` 无双参，双击/Enter/F2/空格/新建都全选。`ta.select()` 必须在 `ta.focus()` **之后**。
38. 提交即预览：写盘前用同一个 `renderInline` 铺卡片，失败用返回的 revert 句柄退回。
39. 键盘拦截挂 `containerEl`；`keyGuard.isTypingTarget` 让路给输入控件与按钮。
40. 浮动条（`nodeBarPosition.ts` 纯函数，右侧竖排）单选才显示，隐藏用 `opacity + pointer-events`；出口：空白/×/Esc。`setHidden` 后要重 measure + place。

## 渲染与观感

41. 分支色**绝不用 path 序号**（插删一行满屏跳色）：`colors.ts` 用**分支名**为 key 的粘性槽位表，跨 setData 保留，`setData` **之前**刷新；8 色起撞槽后探；实色卡片文字用 `readableOn`；根级块用 `\u0000block:${kind}` 当 key。
42. 层级靠浓淡：`tintAt` 每深一层递减（地板 35%），非实色主题一级用 `level1Tint`。
43. 节点阴影**保持原样**（同尺寸 rect 下移 2px + 10% 纯色）。`filter: drop-shadow` 每节点一张离屏图，折叠必掉帧。
44. 操作栏：`@container` 不提升优先级（写基础规则之后）；`container-type` 建层叠上下文 → 浮层靠整块 header 的 z-index（100/画布 0）。用 palette + `Menu`。阈值 480/412/355/310/272。
45. **重绘成本 = 写进 DOM 的属性数**（冷启 197 节点 4954 写 / 9ms）。验收：缓存命中 writes=0，改一字 <30。**`reset()` 不能清 `entries`**（markmap 复用同 g），单条失效交给 `entryOf` 核对 `cached.g===box.g && card.isConnected`。
46. `paintMoved` 对尺寸变了的节点也要补 `applySize/applyCircle`。
47. `paintSelection` 用 `(structureGen, 选中集合)` 早退（`structureGen` 在 `applyTree`/`reflowNow` +1）；`prune()` 不能按数量相等短路。
48. 导出 SVG：清最外层 g 的 transform、viewBox 用 `mm.state.rect`；`getComputedStyle` 内联字体/色/底/边框；补背景；`stripHidden` 删 `display:none`（必须在 `inlineForeignStyles` **之后**），收放点 `<circle>` 单独删。验收用 `<img src="data:image/svg+xml,…">`。

## 块卡片

49. 块内容由 `MarkdownRenderer.render` 产 HTML，**必须包 `<div class="obmind-block-md markdown-rendered">`** —— 代码底色、高亮、表格线、引用条、公式全挂 `.markdown-rendered` 下。渲染必须在 `setData` **之前** await 完（markmap 读 `foreignObject > div > div` 的 scrollWidth/Height）。缓存 key=`file.path|kind|lang|raw`。
50. 复制按钮是**阅读视图后处理**加的，渲染器不给：`decorateCodeBlocks` 给每个 `<pre>` 补 `<button class="copy-code-button">`，点击走**画布事件委托**（字符串化会丢监听）。宽度只能 `:has(.obmind-block-md)` + `width:max-content; max-width:640px`（`width:auto` 会让内部 fit-content 塌成 26px；`--markmap-max-width` 无法逐节点设）。`pre` 强制 `pre-wrap`。
51. 块只读全链路：`startEdit` / 双击（`.obmind-block-md` 内 return，让文字可选）/ 新建 / 插块 / 提层 / 拖动 / 浮动条（只剩删除）/ 新建笔记；纯函数层 `EditService.commit|create|insertBlock`、`moveNode` 的 `child` 模式全拦。`plan` 层 `srcOf()` 对块返 `null` → 块**绝不走 patch 通道**（换 innerHTML 不重跑渲染器），改块即整树重建。

## 导航

52. 两步走：先定「导图看哪篇」（`targetFile`+压栈）再动 leaf。`openDoc` 必须先改 `targetFile` 再 `openFile`。动不动 leaf 由 `NavPolicy` 四档决定；栈内已有该 path 走 `goBackTo`。
53. 新标签开主区：用主区 markdown 标签的 `parent` 走 `createLeafInParent`，不能 `getLeaf("tab")`；`revealLeaf` 激活导图。
54. **钉住 = 锁「这张图」不锁导航**：点双链/面包屑/Alt+单击，笔记照开、导图不动。唯一分叉 `navigate(file)`：钉住→`openFileOnly`，否则→`openDoc`。map-only + 钉住点链接 = 什么都不发生。
55. 「节点 → 新笔记」（`app/notePlan.ts` 纯函数）：名字清 `# ^ [ ]` 与 Windows 非法字符；文件夹复用 `getConfig("newFileLocation"/"newFileFolderPath")`；同名复用；**先建文件后改节点**；带行内样式用别名 `[[名|**原文**]]`；跳前清选中集。Ctrl+N 挂 **document 捕获阶段**且只在 `containerEl.contains(target)` 时接管。

56. **键位只有一张表**（`app/actions.ts`）：`ACTIONS` = id + 归一化 keys(`mod/alt/shift`) + scopes(`canvas`/`view`) + `when(ActionState)`；`matchAction` 统一挡 `phase!=="idle"`（编辑/拖动/重建都不接），视图只剩 `runAction(id)` 的 switch。加操作 = 表里一行 + 一个 case。两条键盘链判据必须同源，否则「重建中在画布按 Tab」会拿旧快照建节点。
57. **IO 走端口**：`io/clipboard.ts` 的 `ClipboardPort`（读失败返空串，不抛）+ `memoryClipboard`。Ctrl+V → `edit/paste.ts` `planPaste`：一行一个同级子节点、**不按源缩进还原层级**（猜错会写出结构错的笔记）、剥一层 `>`/列表标记/`#`、第一行交 `planCreate` 再切前缀复用、上限 200、粘完不进编辑框。读完剪贴板必须复查 `phase` 与 `primaryLine`。

58. **滚轮只有一个入口**（1.18.16）：`applyZoomFilter` 对 wheel 返 `false` + `buildOptions` 的 `pan:false`（d3 的 `wheeled` 会 `stopImmediatePropagation()`；markmap 的 `handlePan` 抢同一个 wheel）。判定在 `render/wheel.ts`：`ctrlKey`/`Shift` 特判 → **手势内自证**（鼠标这一格是首格的整数倍，触摸板是连续值）→ 量级 `|dy|≥16` + `|dx|≈0` 才先按鼠标。**绝不猜「一格=多少像素」**：同一个鼠标，3 行@100% = 100、1 行@100% = 40、3 行@150% = 66.67（Chromium 按 `行数×40÷dsf`），1.18.16 写死 100/120、1.18.17 又要求整数，两次都把用户滚轮判成触摸板。倍率**按格算**（`notchPx` = 手势首值，一格恒 2^0.2）。设置项 `wheelMode`（auto/zoom/pan）是兜底出口。攒到下一帧一次 `scaleBy(f, 锚点, null)` / `translateBy(dx/k, dy/k, null)`；键盘兜底 `mod+= / - / 0`。

## 构建与验证

- 链路：`npx tsc -noEmit -skipLibCheck` → `npm test`（esbuild + Node，`scripts/testBatch.ts`，T1–T27）→ `node esbuild.config.mjs production`（Windows 沙箱可能 EBUSY）→ `node tmp/smoke.cjs` → 部署到 `D:/BJRepository/2. 知识星球/.obsidian/plugins/obmind` 比 sha1。
- 埋点规矩：**每个可能出问题的分支都要有数字**；假证据比没证据更浪费时间。**1.18.12 起业务侧埋点全部注释停用**（`src/render/trace.ts` 与命令开关保留），要排查就在原处解开，别另起一套。
- 浏览器行为用 **Python Playwright + `channel="msedge"`**（`D:/Program Files/Python314/python.exe`）；`--virtual-time-budget` 下 rAF 不推进。探针 `tmp/*.ts|py`：`lagProbe`/`paintProbe`/`dragProbe`/`widenProbe`/`createProbe3`/`blockProbe2`。探针里没有 `MarkdownRenderer`，原生样式只能真机验。
- 现场探针三档 off/events/frames，开关存 localStorage `obmind:trace`；`window.obmindTrace` + 两条诊断命令。热路径先 `isTracing()`；`installTraceConsole` 不能幂等。

## 发布

- 授权 **GPL-3.0-or-later**（二开必须同样开源）。`LICENSE` 用 gnu.org 全文；`src/main.ts` 顶部三段式；**`esbuild.config.mjs` banner 必须带 GPL 声明 + 第三方版权**（markmap MIT / d3 ISC / @babel/runtime MIT）—— 上架后用户只拿得到 `main.js`。
- 上架：`community.obsidian.md` 登录 + 绑 GitHub + Add plugin（不提 PR）。tag 严格等于版本号（无 `v`）。仓库仍**无 git remote**，`authorUrl` 待补。
