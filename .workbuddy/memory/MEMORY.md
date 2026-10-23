# obmind 项目约定

## 架构分层（目标）
依赖单向向下，`domain` 永不 import obsidian、不碰 DOM：
`types`(L0) → `domain` 纯函数(L1) → `render`/`ui`(L2) → `infra` Obsidian 适配(L3) → `app` 用例+会话状态(L4) → `view`(L5)。

进度（1.12.0）：
- L0 `src/types.ts`：SrcRef / BlockInfo / Span / WriteOp / EditorAction / DropMode。
- L1 `src/domain/syntax.ts`：buildTree、缩进度量。**行内渲染改为注入 `render` 参数**，
  domain 不认识 HTML，能在 Node 直接跑用例。
- L2 `src/render/`：inlineHtml、frame（全量 rAF 合并 + 增量**同步**）、
  painter（卡片/连线/收放点/淡出跟随）、geometry、
  **colors（分支粘性配色）**、viewport（适配前等尺寸稳定）。
  `src/ui/toolbar.ts`：单行全局操作栏（按钮声明成数据表）；
  `src/ui/nodeBar.ts`：选中节点时浮出的节点操作条（定位是纯函数，可单测）；
  `src/export/svg.ts`：导出独立 SVG（viewBox/文件名/颜色判断是纯函数）。
- L3 `src/edit/writer.ts`（applyOp 是唯一写入出口）、`edit/inlineText.ts`、`edit/drag.ts`。
- L4 `src/app/`：runtime（phase+rev）、plan（投影判定）、EditService（写用例）、
  QueryService（读用例）、NavStack（跳转栈，条目可带 leafId）、
  NavPolicy（面包屑↔笔记窗口四档联动，纯决策）、**History（撤销/重做，整篇快照）**。
- L5 `MindmapView`：约 1600 行，只做事件翻译 + 投影 + 面板渲染 + 操作分发。
- `parser.ts` 退化为组装层：注入 renderInline + re-export，不再含实现。

待办：View 还持有块渲染（MarkdownRenderer 缓存）与投影细节，可再抽 `BlockRenderer`。

## 核心约束（改代码前必读）
1. **一个显式 phase 代替布尔拼装**。新增「暂时不要重建」的需求时，加阶段而不是加 boolean。
2. **不要用 setData 做文字更新**。markmap 的 `state.key = 父id.子id + hash(content)`，
   内容变则 key 变，整棵树重新 enter。文字变化走 `applyPatch`（改 DOM，markmap 自己 ResizeObserver 重排）；
   结构变化才 setData，且必须 `duration: 0` + 同步 `paintNow()`，否则会闪出错误连线。
3. **patch 时绝不能重算 state.key**，否则等于宣布「这是新节点」，增量白做。
4. **块节点（代码/公式）的 content 是占位文案**，不含块内代码。任何「树比对判变化」的逻辑
   都必须再用原文兜一层，否则块内改字不会被刷新。
5. **SVG 内部测量只用属性/baseVal**，`getBoundingClientRect` 会被画布 scale 放大。
6. 回写必须先校验锚点行原文，宁可失败提示也不能错位写入。跨多行替换（如「改当前行 +
   在子树末尾插新行」）要加 `Span.checkEnd` 尾锚点，否则中间行被改动会被旧内容覆盖。
7. **新增节点的插入位置必须算子树末尾**（`subtreeEndOf`），不能插在「下一行」——
   父节点有孩子时下一行是它的第一个孩子，插那里会被缩进规则判成孩子。
8. 层级有两套体系：标题（`#` 级数）与正文（缩进）。新增节点按目标节点所属体系生成，
   不能混用。正文缩进用 `indentOfCols(cols + step, unit)`，不要拼字符串（tab 会被塞成空格）。
9. **左键选中 + 左键拖动，右键留给菜单**。选中态存源行号（`selectedLine`）不存 DOM 引用。
   左键按下即锁 `body.userSelect`（拖出阈值前浏览器已在选文字），`blur`/`pointercancel` 兜底恢复。
   拖动松手后紧跟的 click 必须用一次性捕获监听吞掉（pointerup 的 preventDefault 拦不住 click），
   否则会按旧行号选中错节点。
10. **导航两步走：先定「导图看哪篇」，再动 Obsidian 的 leaf**。
    `openDoc` 必须先 `targetFile = file` + 压栈，才能 `openFile` —— 否则
    `file-open` / `active-leaf-change` 会把这次自触发误判成「用户切了文件」而清栈、并闪一帧旧笔记。
    `file-open` 的判据是 `file.path === targetFile.path`。
    要不要动 leaf 由 `navSync` 四档决定（app/NavPolicy.ts），不要在 View 里写 if。
    栈内已有该 path 时走 `goBackTo`，不要当新跳转（否则 A→B→A 多开一个标签）。
11. **新标签开在主区**，不能用 `getLeaf("tab")`（跟随活动 leaf，导图在侧栏时笔记会进侧栏）：
    用主区 markdown 标签的 `parent` 走 `createLeafInParent`。激活导图用 `workspace.revealLeaf`。
12. **MutationObserver 只听 `transform`，不听 width/height**。实测 markmap 折叠动画每帧
    把全部节点的 foreignObject 宽高重写一遍（值不变），听它就等于每帧判定「尺寸变了」
    → 全量重绘。内容尺寸真变化的唯一路径是 `applyPatch`，它自己 `request("all")`。
    另：**不能用 `getAttribute(name) === rec.oldValue` 过滤同值重写** ——
    回调批量投递，DOM 已是最新值，比对必然不等。
    还有：childList 要排除**我们自己插进节点 g 的装饰**（带 `obmind-node-*` class 的
    rect/path），否则每次首绘都会多触发一次全量重绘；只有「g 本身被增删」才算结构变化。
13. **导航跳转不重置缩放**（`keepViewport` 一次性标记，在 stale 检查之后消费）。
    用户主动切笔记/首次打开才 fit。
14. 节点操作：`Delete`/`Backspace` 删**整棵子树**（不是一行），删完选中挪到父节点。
    写入的 `applyOp` 会顺带返回新全文，**不要再读一次文件**（多一次 IO 就是一次可感知的停顿）。
15. **markmap 的收放点有两个坑**：①节点失去全部孩子后它既不删 `<circle>` 也不把 `r` 归零
    （仍是 6）→ 必须按 `__data__.children` 判显示，不能看 `r`；②缩小用
    `transform: translate() scale(0.7)`，但 `transform-box/transform-origin` **必须 JS 写内联**
    （SVG 默认 origin 是 0 0，只靠样式表没匹配上就会把圆点拽偏）。
16. **不要给「是否隐藏某元素」缓存布尔**：`painter.reset()` 后同一个 DOM 会带着旧的
    inline 状态回来，缓存与实际不符就永远不恢复。直接读 `el.style.display`。
17. **@container 不提升优先级**，同优先级靠书写顺序 —— 容器查询必须放在基础规则之后。
    操作栏用 `container-type: inline-size`，240px 窄侧栏仍能一行放下（≤310px 图标 28→24、
    ≤280px 分隔线隐藏）；行级 `overflow: hidden`，任何时候都不换行（换行会让画布上下跳）。
    主题选择用 palette 图标 + `Menu`，**不要用原生 `<select>`**：92px 宽、样式改不动，
    在窄侧栏里最扎眼。
    **但 container-type 会建立层叠上下文**：容器内浮层的 `z-index` 只在这个上下文里比较，
    跟外层的兄弟节点（如画布）无关。所以浮层能不能压住画布，取决于**整块 header 的 z-index**
    （`.obmind-header` 100 / `.obmind-canvas` 0），给浮层自己写 30 是没用的 —— 踩过。
18. 撤销/重做存**整篇快照**（`app/History.ts`，纯函数，上限 40），不存反向操作；
    `runWrite(..., remember=false)` 给撤销自身用，否则「撤销」会把自己压进 past 原地打转。
19. **「打开偶现空白」是时序问题**：markmap 的 `fit()` 读 `svg.getBoundingClientRect()`，
    侧栏滑出期间尺寸走 `0 → 60 → 200 → 400`，在 0 上 fit 得到 scale=0（缩成点），
    在中间值上 fit 得到 0.07（缩在角落），之后没人重算。适配前必须用
    `render/viewport.ts` 的 `waitStableSize` 等「够大且连续两帧不变」，
    且要量 **svg** 而不是容器的 clientWidth。fit 后用 `state.rect` 是否为空 +
    `__zoom.k > 0` 自检并重试（别用「scale 够大」判定，大图在窄栏里本来就只有 0.02）。
    容器尺寸变化且用户没滚轮缩放过（`userView`）时跟随重适配。
20. **GFM 表格按整块节点处理**（`BlockInfo.kind = "table"`），和代码块走同一条
    `renderBlocks`（MarkdownRenderer）。识别要「头行含 `|` + 分隔行 + 分隔行自身含 `|`」，
    否则「正文 `a | b` + `---`」会被误判成单列表格。缩进在列表项下的表格先 dedent。
    卡片里没有 `.markdown-rendered`，Obsidian 的表格样式挂不上，样式要自己写：
    `width: max-content; max-width: 320px`，单元格 `overflow-wrap: anywhere`。
21. **分支颜色绝不能用节点 path 的序号算**。path 是位置编码，插一行 / 删一行会整体平移，
    表现就是「新加一个节点满屏跳色」。走 `render/colors.ts` 的 `BranchColors`：
    以**分支名**（`branchKey` 归一化）为 key 的粘性槽位表，跨 setData 保留，
    已有 key 永不移位，「一增一减」直接过户（改名不换色），冷启动按哈希排序分配。
    槽位表必须在 `setData` **之前**刷新（markmap 的 `color` 回调在 render 里同步取色，
    那时候还没有节点 DOM，path 只能从孩子顺序推 `0.i`）。
22. 色板 8 色起（6 色在 5～10 根分支的常态下必撞色）；撞槽向后探测空位。
    实色卡片的文字色用 `readableOn`（白/深墨取对比度更高者），不要一律白字 ——
    橙黄系上白字只有 2.3，等于看不清。
23. 层级靠**浓淡**区分：`tintAt` 每深一层递减（地板 35%），非实色主题的一级节点
    用 `level1Tint`（≈tint*1.5），否则一级和二级是同一个色块的深浅。

24. **增量绘制（节点位移）必须同步，不能排 rAF**。d3 在 rAF 回调里写 transform，
    MutationObserver 回调在紧随其后的微任务里执行 —— 此刻重画连线仍是同一帧；
    排到下一个 rAF 就**迟一帧**，折叠动画里看着就是线在追节点、发飘。
    rAF 合并只留给**全量**绘制（它必须等 markmap `_relayout` 完）。
25. **自绘装饰必须跟着 markmap 的淡入淡出**。折叠时 markmap 把子树 transform 过渡到父节点、
    且**只**给 foreignObject 过渡 opacity；我们插进 g 的卡片/连线/收放点不跟就会
    「文字正常消失、彩色方块继续飞」。按 `fo.style.opacity` 同步到三者上；
    并且**正在消失的节点要冻结连线形状**，否则按被拖动的 transform 反推的路径会被拉成歪线。
26. 节点操作用**浮动条**（`ui/nodeBar.ts`），不要塞回顶部工具栏：它们只在选中后有意义，
    钉在顶部就是一排常驻灰按钮。隐藏用 `opacity + pointer-events`，**不要用 display:none**
    （隐藏态也要参与布局，否则读不到 offsetWidth，第一次弹出会先落左上角再跳过来）。
27. **`applyTree` 出口必须调 `paintSelection()` + `syncToolbar()`**：重建换掉整批 g，
    不重新挂就等于「选中态凭空丢了」，而 `selectedLine` 还指着那一行 ——
    用户按 Tab 会莫名多出一个子级。
28. **浮动条必须有三个关闭出口**：点画布空白、条上的「×」、Esc。
    只有 Esc 不够 —— 画布的 keydown 只在焦点在画布上时收得到，点过工具栏焦点就跑了，
    所以 Esc 要有一条 `document` 级兜底（对应 `onGlobalKeyDown`），
    但它必须**让路**给编辑框（`phase === "editing"`）和画布内事件
    （`canvas.contains(target)`），否则一次 Esc 会连着关两样东西。
29. **`NodeBar.attach` 在「目标没变且已收起」时必须直接 return**，不能落到 `start()`：
    否则每次取消选中都起一个永远空转的 rAF（`place()` 没目标立刻返回）。
30. **导出 SVG 三件事缺一不可**：① 清掉最外层 `g` 上的 zoom transform（否则只导出当前视口），
    用 `mm.state.rect` 当 viewBox；② 把 `getComputedStyle` 的字体/颜色/底色/边框内联到
    克隆体（原件与克隆体按下标对应，读原件）；③ 补背景色（画布自己通常 transparent，
    要沿 `.view-content` → `body` 往上找）。验收用 `<img src="data:image/svg+xml,...">`：
    它是隔离文档，不继承页面 CSS，能正常显示才算真导出成功。

## 构建与验证
- `node esbuild.config.mjs production`（Windows 沙箱内可能 EBUSY，需 `dangerouslyDisableSandbox`）。
- `tsc -noEmit -skipLibCheck` 先过类型。
- 浏览器行为验证用 **Python Playwright + channel="msedge"**。
  `msedge --headless=new --virtual-time-budget` 下 **rAF 不推进**，测不到 markmap 重排，别用它验证布局。
- 插件加载链路用 mock obsidian + `require("main.js")` 验证，含幂等注册路径。
- 部署目标：`D:/BJRepository/2. 知识星球/.obsidian/plugins/obmind`（copy 后比对 sha1）。

## 交互模型（1.13.0 起：框选/多选/整体拖动）
- **选中态是集合**：`selectedLines: Set<number>` + `primaryLine`；`get/set selectedLine`
  代理兜旧调用点（读=primary、写=单元素集）。多选操作都走集合，别退回单值。
- **左键**：按节点=拖动（DragController）、空白区拖=框选（`edit/boxSelect.ts`，ctrl/shift 加选）、
  单击节点=选中、**Ctrl/⌘+单击=加选/减选**、**Shift+单击=同级区间**（`anchorLine` 定锚点，
  `siblingLines` 按 depth 扫同层兄弟）、**Alt+单击=按节点文字开同名笔记**、单击空白=清空。
  判序必须**先 Shift 后 Ctrl**（Ctrl+Shift 是并入区间，反过来会被 Ctrl 吃掉）。
  **右键**=平移画布（`mm.zoom.filter` 仅 button===2 触发；create/setOptions 后要重设）。
  右键拖动过 >4px 才压 contextmenu。
- **整体拖动/批量删除只作用于「顶层成员」**：`groupOf(line)` 取选中集里不被其它选中节点
  子树覆盖的行；批量删除 `removeGroup` 把各子树范围求并集后一次性 whole 重写。
- **纯函数**：`moveNodes`（批量移动，edit/move.ts）、`EditService.moveGroup/removeGroup`。
  回归测试 `npm test`（scripts/testBatch.ts，esbuild+Node）。
- **坑**：解析器 `collectSrc` **不含 depth=0 的节点**（文件根 depth=1）→ 任何
  `depth===0` 的「根保护」判断都是死代码；删顶层节点会连带整篇，别指望它兜底。

## 编辑框手势（1.13.1）
- **编辑框里只改字，不改结构**：Tab = 提交 + 建子级（`EditorAction "child"`，
  `EditService.commit` 里与 `sibling` 合流，只有 `planCreate` 的 mode 不同），
  Shift+Tab = 提交 + 提升一级。曾经 Tab 绑 `indent`，用户按 XMind 习惯拿 Tab 收尾，
  结果节点被挪进上一个兄弟的子树 —— 这类「结束输入」的手势绝不能再动层级。
  换行/建同级仍是 Enter / Ctrl+Enter。
- 区间选择的锚点**要在算完区间后恢复**：`applySelection` 会把 `anchorLine` 重设为
  primary（框选那条路需要），`selectSiblingRange` 必须存一下再放回去，否则
  每按一次 Shift 都从新锚点重算，选不到「首→尾」。

## 导出与浮条（1.13.1）
31. **导出必须清掉「只被我们 CSS 隐藏」的元素**。`styles.css` 里 `path.markmap-link`
    和 `g.markmap-node > line` 都是 `display: none`，但 CSS 不跟文件走 —— 导出后
    markmap 自带的连线（双线，细的那条错开）和卡片内部的下划线（看着像「卡片中间
    横着一条线」）全回来了。`export/svg.ts` 的 `stripHidden` 用**活树计算样式**
    （`display === "none"` 就 remove），不写死类名；必须在 `inlineForeignStyles`
    **之后**跑，那一步靠 src/clone 下标对齐，先删就错位。收放点 `<circle>` 单独删：
    静态图里点不动。
32. **浮动条固定在画布右侧、垂直居中、竖排**（`ui/nodeBarPosition.ts` 纯函数，
    T12 覆盖；`nodeBar.ts` 只 re-export，这样纯函数能进 Node 单测）。跟着卡片
    跑试过「卡片下方」「卡片上方」，两个位置都在跟内容抢地方（下方压子树、上方压
    父级和刚点过的兄弟），而且每帧都要读 `getBoundingClientRect` 追折叠动画。
    固定后只在**画布尺寸变化**时重算（`ResizeObserver`），没有任何跟随开销。
    兜底：条子比画布还高 → 贴顶；画布比条子还窄 → 贴左。竖排后分组线要转 90°。
33. **只有单选才显示浮动条**（`paintSelection` 里 `selectedLines.size === 1`）。
    那五个动作语义都是「对这一个节点」，多选时改文字没意义、删除是灾难；
    钉在其中一张卡片上会让人误以为作用于全部。

## 交互与观感（1.14.0）
34. **编辑框：不带修饰键的键只结束输入**。Enter / Tab 都是「提交并退出」，
    结构操作只走修饰键（Ctrl+↵ 建同级、⇧+Tab 提升一级）或退出后在画布上按。
    上一版把 Tab 绑成「提交 + 建子级」，用户的实际感受是「改完按 Tab 又多出一个节点」。
    退出后焦点回画布（`pendingEditLine < 0`）才接得上画布上的 Tab；改字走 `patch`
    分支、快照同步更新，所以「提交后立刻按 Tab」不会有旧快照的竞态。
35. **节点阴影保持原样：和卡片同尺寸的 rect 下移 2px + 10% 纯色**。
    **别再动它了。** 试过两版都被否：8px 竖向渐变带被说「越改越大」；4px 径向
    渐隐（可见 3px、峰值 20%，已经把底边完全化开）也被说「还不如不改」。
    用户要的只是「底边那条线柔一点」，而这个形状（圆角 14 的胶囊卡片 + 2px 薄影）
    在零滤镜下没有更好的解 —— `filter: drop-shadow` 每个节点一张离屏图，
    折叠动画必掉帧，不能碰。要再提这件事，先拿到用户明确要求。
36. **操作栏两端**：`brand`（字标「低山」，logo 占位）+ `trailing`（`N 节点 · 深 M`）。
    统计用 `domain/stats.ts` 的 `treeStats`（显式栈，不是递归），文案没变不写 DOM。
    窄侧栏靠容器查询让步，**阈值按实测自然宽度倒推**（10 按钮 + 主题键）：
    28px 图标+分隔线 350、24px+分隔线 304、24px 无分隔线 264、20px 无分隔线 223。
    所以 ≤480 收统计、≤412 收字标、≤355 图标 24、≤310 收分隔线、≤272 图标 20。
    228px 以上零溢出、行高恒 37。
37. **编辑框最小宽度 7 格**（`MIN_EDIT_COLS × fontSize`），否则新节点「新节点」
    三格宽的卡片会让输入到第 4 个字就折行。

## 钉住（1.14.1）
38. **钉住只是「不跟随外部切换」，不是「锁死」。** `pinned` 是个布尔，不存路径：
    `resolveTargetFile` 里一旦钉住就返回 `targetFile` 自己，不再问 `getActiveFile`。
    点图里的双链照样能往下潜（那是用户在图上的明确动作），`file-open` 直接 early
    return —— **绝不能走 resetNav**，否则「去别的笔记翻一下回来面包屑就没了」，
    等于把钉住做成一钉就被重置。
39. **`setPinned` 自己不调 refresh**：解除钉住发生在 `refresh → resolveTargetFile →
    pinnedTarget`（目标文件被删那一路）内部，在那里再 refresh 会原地递归。
    要立刻重画的调用方（工具栏点击）自己 refresh。toolbar 的 `setActive` 与
    `setEnabled` 是两件事：前者是「开关开着」，还要顺手换 tooltip。

## 编辑体验（1.15.0）
40. **观察器必须听 `class`**：markmap 的 `renderData` 里有一句 `w.attr("class", …)`，
    把每个节点的 class 整个重写 —— `obmind-selected` 会被原地抹掉，而
    `selectedLines` 还在内存里。它自己的 ResizeObserver（100ms 防抖）在**每次内容
    尺寸变化**后都会重排一次，所以表现是「编辑完就丢选中框，按 Tab 却多出一个子级」。
    修法：`attributeFilter: ["transform", "class", "style"]`，class 记录交给
    `paintSelectionOn(els)` 只补「本该选中但没有」的节点（写同值不产生新记录，无死循环）。
41. **观察器必须听 `style`（仅 foreignObject 的 opacity）**：markmap 折叠/展开每帧写一次。
    以前只在全量/增量绘制里**读一次** opacity 抄给卡片 —— enter 节点那一瞬是 0，
    抄下去就是透明卡片。能恢复全靠「后面还有 transform 写入再画一次」；一旦那次绘制
    被 `blocked()`（快速连按 Enter / 第二轮重建）挡掉，卡片就**永久**停在 opacity 0，
    屏幕上少一整块 —— 这就是「只渲染一半图」。`NodePainter.syncFadeFor` 必须做成
    事件驱动，且**不过 blocked 闸门**（只抄样式、不读布局）。实测 42 节点里 29 个卡死。
42. **`paintAll` 要返回「没画成的节点数」**（读不到 fo 宽高 / transform 的），
    `FrameScheduler.paintNow` 隔帧重试 ≤3 次；`paintMoved` 首次见到的节点要补齐
    样式/尺寸/收放点（只 `ensureLayers` 会得到一堆宽高未设置的 rect = 卡片消失）。
43. **提交即预览**：编辑框关闭后先别等写盘。用**同一个 `renderInline`** 把新文字铺到
    卡片上（连 fo 宽高一起改，再 `frames.paintNow()`），写盘在后面跑；真实投影到达时
    内容逐字节相同，`applyPatch` 里「innerHTML 相同就不赋值」。写失败/计划作废要用
    `previewText` 返回的 revert 句柄把 DOM 退回旧内容 —— 否则界面会停在没写进去的内容上。
44. **空文本 = 删节点**（`EditService.commit`）。以前「空文本一律放弃修改」，用户把字
    删完按回车，节点还在、旧文字回来。现在清空即删（整棵子树，撤销可回），
    `sibling`/`child` 也归到这里。编辑框里 `Delete` 与 `Backspace` **都要**认空文本删除
    （只认 Backspace 时，Ctrl+A 之后习惯用 Delete 的人会一直按、节点一直不删）；
    清空后给 placeholder 提示下一步。
45. **编辑框不能每帧落位**：`place()` 要带输入签名（位置 + fo 宽高 + 文本），
    follow 循环 240ms 没变化就收尾。每帧写 width/height 再读 scrollHeight 等于每帧
    强制同步布局，用户这时往往已经开始打字 —— 就是「输入时发虚」。
46. **键盘拦截挂在视图根节点上，判据抽成 `ui/keyGuard.ts`**：画布 keydown 要求
    `target === canvas`，焦点被工具栏/重建拿走后就永远收不到 —— 表现是「按了没反应」。
    空格 = 编辑选中节点（XMind 手感），但是 `button` / `[role=button]` 上的空格是
    「按下这个按钮」的无障碍语义，**必须让路**，否则「焦点在删除按钮上按空格」会开始编辑。
    `isTypingTarget` 用作单元判据（`isContentEditable` + closest 输入控件），
    真实 DOM 用例在 `tmp/keyGuardTest.py`（Node 侧没有 DOM，不进 testBatch）。
47. **编辑框永远不产出结构变化**（1.16.0 定论，之前两版都错）：空文本 = 放弃修改，
    节点原样留着；`EditorAction` 里没有 "delete"。删除只有一个入口 —— 画布选中态的
    Delete/Backspace → `EditService.removeGroup`。理由：全选想重打一行时，回车把整棵
    子树删掉是不可接受的意外。不要再往编辑框里加「清空即删」。
48. **删除后 `focusLine` 由 service 给，不要在 View 里算**：父节点在删除区间之前，
    行号不受影响；顶层节点的父是文件名（不可选），退一步给「落在删除位置上的节点」。
    View 侧必须 `applySelection([focus], focus, false)` —— 只写 `primaryLine` 不写
    `selectedLines` 等于「不画选中框」，这就是「删完框消失」的老 bug。
49. **折叠的子树没有 DOM，不是隐藏**（实测）：markmap 折叠后把子节点的 `<g>` 直接删掉，
    所以 `findNodeByLine` 返回 null 就代表「被折叠」，可以据此决定要不要 `toggleNode`。
    但**可见序列必须从 `mm.state.data` 读 fold**：解析出来的那棵树是旧的，
    用户点圆点折叠只改 markmap 手里那份（`setData` 时 children 被浅拷贝过）。
50. **方向键两条轴分工（1.16.1 用户定）**：↑↓ 只走**末端节点**（无孩子，或 fold>0 ——
    折叠的在屏幕上就是末梢，它自己也进序列），层级只由左右负责；← = 父，→ = 长子
    （折叠着先展开）。上下用 `visibleLeafRefs`，**不能**用 `visibleRefs`：后者含分支，
    按 ↓ 会落到「看起来是一行、其实是整个分支」的节点上（B 有孩子也照样停下），
    用户的原话就是「上下是叶子节点，左右是父子节点」。
    起点不在末端序列里（点中分支标题 / ← 从子级退回）时按**行号**找它之后/之前的
    第一个末端，别按 index 找（index=-1 会被当成「没选中」而跳到序列首尾）。
    选中后要 `mm.ensureVisible(data, {pad:32})`：只平移不改缩放，连按十几下也不会跑出画布。
51. **改一个字会「闪」的真正机制（1.16.2 实测）**：markmap 对每个节点的内容 div
    挂了 `ResizeObserver(debounce(..., 100))`，**100ms 后**才 `renderData`；
    renderData 里的位置变化又走 `options.duration`（180ms）的 transition。
    所以「卡片已经变宽、孩子列还停在旧位置」的错位要持续约 233ms。
    修法：尺寸变了立刻 `reflowSoon()` —— 下一帧 duration 置 0 主动
    `mm.renderData()`（`renderData` 是 public），再 `paintNow()` + `paintSelection()`。
    两个坑：① renderData 里 `attr("class", …)` 会整段重写，选中标记必须补回；
    ② 它还会 `transition(K).style("opacity", 1)`，折叠淡出正演到一半时别调。
    另：`applyPatch` 要判 `changed`，previewText 铺过的内容不要重复重排。
    **修正（1.16.3）**：setData 干净只是假象 —— 见下条。用逐帧采样才会看到
    「36/43 个卡片同时透明」，肉眼全量审计根本抓不到。
52. **新建节点必闪的真正机制（1.16.3 实测，43 节点树）**：markmap 的节点 key 里带
    **孩子序号**，插入/删除一行会让**它后面所有兄弟**的 key 改变 → d3 把它们当新节点
    重新 enter → 先写 `opacity: 0`，再起过渡。**`duration: 0` 的过渡也是异步到下一帧的**，
    而 `setData` 内部本来就 await 让出主线程，浏览器就在这一帧绘制了「一排卡片有底色、
    没有文字」。更糟的是我们的全量绘制紧随其后，把这个 `opacity: 0` **抄给了卡片**：
    实测 36/43 个卡片一帧全消失（`?noguard` 对照实验）。
    修法三层：
    ① `inFadeGuard()` —— `rebuilding` 期 + 结束后 50ms 内，凡是 foreignObject 上
       < 1 的 opacity **当场抹成 `""`**（MutationObserver 回调在微任务里，赶在绘制之前）；
       **`phase === "editing"` 必须豁免**，那里 opacity 0 是我们自己设的（防重影）。
    ② `clearFade()` —— setData 返回后把所有残余 opacity 清掉（`removeProperty`，
       不写 "1"，否则会卡住 markmap 后续过渡的插值）。
    ③ `measureMissing()` —— 刚 enter 的节点还没有 width/height 属性，全量绘制读不到
       几何 → 新节点第一帧没有卡片。只对缺失的节点读一次 `scrollWidth`（强制布局，
       不能对所有节点做）。
    窗口别开太长（50ms 够）：这期间用户若点收放点折叠，淡出会被一起抹掉。
53. **`reflowNow` 必须让路给重建**：`previewText` 排的 rAF 可能正好撞进
    `applyTree` 的 rebuilding 期，那时 `renderData` 会把半成品 DOM 重排一遍（还会
    重写 opacity/class）。开头与 await 之后都要查 `phase !== "idle"` 直接返回，
    重建结束的 `paintNow` 会做同一件事。
54. **「节点 → 新笔记」（1.17.0）的定论**：
    决策全在 `app/notePlan.ts` 的纯函数里（`noteTitleOf` / `resolveNoteFolder` /
    `applyTemplate` / `linkLiteral`），View 只做 IO 编排，所以命名规则能跑用例（T17）。
    ① **名字必须清 `# ^ [ ]`**：它们不是文件系统限制，是**双链语法**限制 ——
       `[[Q3 复盘 #会议]]` 指向的是「Q3 复盘」这篇的「会议」小节。斜杠/冒号等
       才是 Windows 限制（`\ / : * ? " < > |`），一并换成空格。
    ② 文件夹**复用 Obsidian 自己的设置**（`vault.getConfig("newFileLocation")` /
       `"newFileFolderPath"`），不另立一项。`Vault.getConfig` 运行时一直在但**没写进
       d.ts** → 按可选能力探测，拿不到当「库根」，降级不抛错。
    ③ 同名笔记已存在就**复用它**，不新建：双链按名字解析，库里多一篇同名的
       会让 `[[标题]]` 指向不确定的那一篇。
    ④ **先建文件、后改节点**。反过来一旦建文件失败，节点上就留一条红链。
    ⑤ 原文带行内样式时用别名 `[[重点|**重点**]]`：名字干净，卡片上的字不变 ——
       用户改的是「它有没有链接」，不是「它的字」。
    ⑥ 跳转必须走 `openDoc`（面包屑 / 跳回自动就有），不要自己 `targetFile = x`。
       跳之前 `applySelection([], -1, false)`：选中集存的是**上一篇的行号**，
       换文件后会指着新图里无关的节点。
    ⑦ **Ctrl+N 要挂 document 的捕获阶段**。Obsidian 的全局热键在 document 冒泡处理，
       排在它后面就等于「一篇空笔记已经开出去了才轮到你」。捕获里先
       `preventDefault + stopPropagation`，元素级的同名分支自然被 defaultPrevented 挡住。
       只在 `containerEl.contains(target)` 时接管，别处的 Ctrl+N 仍归 Obsidian。
    ⑧ 「新建笔记」按钮在节点已有双链时**隐藏**（`.is-gone` → display:none），
       不是置灰：置灰会让人反复点它试为什么点不动。NodeBar.setHidden 里
       **必须重 measure + place** —— 条子右对齐，少一个按钮整条位置就偏一格。
55. **钉住 = 锁「这张图」，不是锁「导航」（1.17.2 定为终版）**：
    语义（用户原话）：「文件切换，导图不切换」。所以钉住期间点卡片双链，
    **笔记照常打开**，只有导图原地不动。1.17.1 曾做成「拦住跳转」，
    等于把双链在钉住期间变成死链 —— 方向错了，已推翻。
    分叉点只有一个：`navigate(file)` —— 没钉住 → `openDoc`（换图 + 按 navSync 联动）；
    钉住 → `openFileOnly`（只动 leaf，**绝不碰** targetFile / navStack / leafId 记账）。
    四个入口全走 `navigate`：点双链、Alt+单击、面包屑（钉住时直取 `getAbstractFileByPath`
    后调 `openFileOnly`，非钉住仍走 `goBackTo` 裁剪栈）、新建笔记。
    `openDoc` 保持纯执行不判 pinned，这样程序性跳转也有通道。
    两个必须记住的点：
    ① **为什么动了 targetFile 就是换图**：`resolveTargetFile()` 里 `pinnedFile()`（栈顶）
       优先于 pinned 分支，栈非空时导图跟着栈顶走 —— 所以「在 openDoc 里判 pinned」是假拦截，
       真正的锁是「根本不进 openDoc」。
    ② **`openFileOnly` 不要 revealLeaf**：openDoc 里 reveal 是为了「新标签抢走焦点后
       面包屑还能点」，钉住时面包屑不需要点，reveal 只会把刚打开的笔记又塞回标签栏。
    map-only 模式下 `forwardTarget === "none"`：钉住 + 点链接 = 什么都不发生，必须给一句提示。
    外链 `https?` / `mailto` 一律不进 navigate：那是浏览器的事，本来就动不了导图。
56. **编辑框藏原文只能用 `visibility`，绝对不能用 `opacity`（1.17.3 修）**：
    症状：双击/空格进入编辑，那个节点的**卡片和连线整块消失**，屏幕上只剩一个
    孤零零的输入框（用户：「编辑时没有线？」）。看起来像「连线没画」，其实是画了又被透明掉。
    因果链：`inlineText` 里 `fo.style.opacity = "0"` → MutationObserver 的 style 分支
    把它当成「markmap 正在淡入淡出」→ `faded` → `painter.syncFadeFor` →
    `writeFade` 把同一个值抄给阴影/卡片/**连线**/收放点。编辑框的隐藏被误解成淡出。
    **这是「借用别处语义」的经典代价**：opacity 在本项目里已经被征用为
    「消失进度」的信号（折叠/enter 过渡），任何「我想暂时看不见」都不该走这条通道。
    `visibility: hidden` 保留布局盒（`getBoundingClientRect` 照常返回真实尺寸，
    编辑框定位不受影响）、不参与 opacity 通道。
    另外：`export/svg.ts` 里清 opacity 的地方要**一起清 visibility**，
    否则编辑中导出的 SVG 会缺那个节点的文字。
