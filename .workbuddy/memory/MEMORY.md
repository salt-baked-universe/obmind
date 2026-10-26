# obmind 项目约定

Obsidian 插件：笔记 → XMind 风格思维导图。当前 **1.18.23**（`manifest.json`/`package.json`/`versions.json` 三处同步）。发布/上架/markmap 推导细节见同目录 **`MARKMAP-NOTES.md`**（不自动注入）。

## 分层（单向向下，`domain` 不 import obsidian、不碰 DOM）

L0 `types.ts` → L1 `domain/`（syntax、nav、stats）→ L2 `render/`（painter、frame、colors、viewport、geometry、wheel）+ `ui/` + `export/` → L3 `edit/`（writer＝`applyOp` 唯一写出口）→ L4 `app/`（runtime、EditService/QueryService、NavStack/NavPolicy、History 上限 40、notePlan、plan、actions）→ L5 `MindmapView`。IO 走 `io/`。

## markmap 硬约束

1. 文字更新**绝不用 setData** → `applyPatch`；结构变才 setData（`duration:0` + 同步 `paintNow()`）。patch 不重算 key，但**必须换引用回写 `__data__.payload.src`**，否则「卡片新字、点开编辑旧字」。
2. 内容 div 挂 `ResizeObserver(100)`；重建后必再整树重排。`reflowSoon/Now` 闸门**只挡 `rebuilding`**。
3. key 含全局 DFS id → 插一行其后全换 key → 全量 enter 起点取 `m[父id]||根rect`，而 `m` 只由 update 填充 → 全落根右下角。
4. `attr("class",…)` 整段重写抹掉 `obmind-selected` → 重排后必须 `paintSelection()`；它还 `style("opacity",1)`，折叠淡出一半时别调。
5. 观察器听 `transform`/`class`/`style`/`width`/`height`；同值过滤用 `oldValue===当前值`。childList 排除 `obmind-node-*` 与 foreignObject 内部。transform→`paintMoved` 必须**同步**画。
6. 连线是 **f(子卡片,父卡片)** → 父动子没动那帧子也要重画。取子用 `child.state.path`，**不是** `父path.下标`。`measureDrift()` 自证 `max>1` 即偏差。
7. 自绘装饰跟 markmap 淡出（`syncFadeFor` 读 `fo.style.opacity`）；判据只对 opacity **递减**生效：`v<1 && v<=entry.fade`。消失中的节点冻结连线。
8. 收放点：失去全部孩子也**不删** `<circle>`、不清零 r；缩小用 `translate() scale(.7)`，`transform-box/origin` 写内联。
9. 折叠后子 `<g>` 从 DOM **删除**；可见序列读 `mm.state.data` 的 fold（解析树是旧副本）。
10. `paintAll` 返回「没画成数」，`paintNow` 隔帧重试 ≤3；`paintMoved` 补首次见的节点。SVG 内部测量只用属性（`getBoundingClientRect` 被 scale 放大）。
11. 打开偶现空白＝时序：fit 前 `waitStableSize` 等 **svg**；fit 后按 `state.rect` + `__zoom.k>0` 自检重试。导航不重置缩放（`keepViewport` 一次性）。
12. 不缓存「是否隐藏」布尔 → 直接读 `el.style.display`（`reset()` 后同 DOM 带旧 inline 回来）。
13. markmap **自己会在 setData 后 ~100ms 再跑 `renderData`**。`attachSettleHook` 包住 `renderData`/`toggleNode` 开 1.2s 窗口；`duration===0` 不消费窗口；手动折叠先清窗口；窗口**必须覆盖 `editing`**。
14. **卡片尺寸唯一输入是 `foreignObject` 的 width/height**；只改文字时 transform 全同值被滤 → **必须听 width/height** → `paintMoved`。
15. 「提交即预览」**不能把重画托付给别人**（`editing` 相位下 `reflowNow` 早退 + `applyPatch` `changed=false` → 一次没画）。凡写了 `fo.width/height` 当场 `frames.paintMoved([g])`。
16. **`await setData()` 返回时 transform 还是 enter 起点** → `applyTree` 在 `paintNow()` 前 `syncStalePositions()`（只 `duration===0`、跳过 rect 为 0）。
17. 闪烁不是透明度问题 → 查位置：`obs.structural jump`、`f.traj lag`。
18. **行号漂移不是结构变化**：`planProjection` 只在 children/depth/content 判结构，`line` 降级 `lineDrift` → `patch`+`relabel`；`relabelTree` 把新树 `payload.src` **换引用**写回 `mm.state.data`（结构对不上返 `null` → 重建）。判定顺序 **depth 先于 line**。

## 解析（domain/syntax）

19. 两套层级：标题（`#`）与缩进。制表符按 4 列。深度用**缩进栈**推导（非 `floor`）；`detectIndent` 取「整除最多行且覆盖 ≥85% 缩进行的最小候选」，否则 GCD。
20. **块（围栏/公式/表格/普通引用）是宿主的独立只读子节点**：`src.line` = 代理行（free）或围栏行（bound），`blockStart/blockEnd` 记区间。块拿深度但**不写缩进栈**（否则吞掉后面的节点）。**`<!-- obmind:block -->` 是代理行** —— 围栏最多缩 0–3 格，块自己扛不了缩进，这是整套设计的地基。归属看顺序不看缩进。
21. **callout 是容器**：`> [!note] 标题` 自成节点，正文剥一层 `>` 当虚拟行继续分层；无标题用正文首行顶上（`promoted` 层级上移一层）。`v.orig/v.off` 换回原文坐标。
22. 回写先校验锚点行原文，宁可失败不能错位；跨多行加 `Span.checkEnd`。`applyOp` 顺带返回新全文，别再读文件。
23. 回写/移动保留引用前缀（`quoteOf`/`markOf`/`splitLine`）；进出 callout 用 `rebaseQuote`。callout 标题的「同级」在引用外、`mark` 不沿用 `[!note] `；其子级不能再缩进。
24. 插入块插在**宿主行之后**。**围栏类块（代码/公式）一律顶格**，缩进全由代理行承担（对齐列表内容列会让 11 层 tab 算成 42 列 → Obsidian 当缩进代码块、` ```python ` 原样露出）；引用/表格不是围栏，仍对齐列表内容列。callout 内每行带 `>`。`insertBlockAt` 弹语言框前先抓行号；拖裸块由 `moveNode` 补代理行。语言走 `ui/codeLang.ts` FuzzySuggestModal。
25. GFM 表格要「头行含 `|` + 分隔行 + 分隔行自身含 `|`」；列表下缩进表格先 dedent。

## 交互

26. 选中是**集合**：`selectedLines` + `primaryLine`。左键节点=拖、空白=框选、单击=选中、Ctrl=加减选、Shift=同级区间、Alt=开同名笔记。右键/中键=平移（`zoom.filter` 只放行 `button 2|1`，每次 create/setOptions 后重设），右键 >4px 才压 contextmenu。
27. 整体拖动/批量删除只作用顶层成员（`groupOf`）；删除把各区间求并集后一次性 whole 重写。`removeGroup` → View 必须 `applySelection([focus], focus, false)`。
28. `collectSrc` 不含 depth=0 的根 → `depth===0` 的根保护是死代码。
29. **「拖动时藏起来的线」是谓词不是动作**：`painter.markShifted(roots,on)`，`applyLink` 命中只给 `display:none`。提层走 `View.raiseNodes()`（`takeRecords` → `disconnect` → 挪 → `observe`）。收尾 `sweepDragShift(skip)` 跳过 `drag.liveMembers()`。
30. 拖动整块：节点 g 扁平，只动根 transform 会让子树飘线 → 按 path 前缀收子树 + `groupOf`，给每个成员写 **CSS `translate`**（位移 `dx/k`）；摘掉「原父→块根」的线。遮挡靠 `appendChild` 提末尾。
31. 松手：`onDrop` 返 boolean（true 等重建 / false 当场弹回）。**别 rAF 轮询 `isConnected`**（d3 按 key 复用 → 空转到 900ms）。`applyTree` 调 `settleNow()` + `sweepDragShift()`。
32. 拖动三坑：① 读 `__data__.state.path`（无 `data-path`）；② `display:""` 恢复不了 CSS 隐藏的；③ Escape/pointercancel 走 `reset(false)` 必须还原摘掉的线。松手后的 click 用一次性捕获监听吞掉。放行 `a`/`circle`/`.copy-code-button`；`bound` 块不启动拖动。
33. 方向键：↑↓ 走末端节点（`visibleLeafRefs`）、←→ 走父/长子；起点不在序列按**行号**就近。选中后 `ensureVisible({pad:32})`。
34. **编辑框永不产出结构变化**：Enter/Tab 提交退出、Ctrl+↵ 建同级、⇧+Tab 提升一级。空文本=放弃；删除只走画布 `removeGroup`。
35. 编辑框藏原文只用 `visibility: hidden`，**绝不用 opacity**（已被征用为消失进度）。
36. `place()` 带输入签名缓存，follow 循环 240ms 无变化收尾；每帧落位＝每帧强制布局＝输入发虚。
37. **进编辑一律全选**：`startEdit(g)` 无双参。`ta.select()` 必须在 `ta.focus()` **之后**。
38. 提交即预览：写盘前用同一个 `renderInline` 铺卡片，失败用返回的 revert 句柄退回。
39. 键盘拦截挂 `containerEl`；`keyGuard.isTypingTarget` 让路给输入控件与按钮。
40. 浮动条（`nodeBarPosition.ts` 纯函数，右侧竖排）单选才显示，隐藏用 `opacity + pointer-events`；`setHidden` 后要重 measure + place。

## 渲染与观感

41. 分支色**绝不用 path 序号**（插删一行满屏跳色）：`colors.ts` 用**分支名**为 key 的粘性槽位表，`setData` **之前**刷新；实色卡片文字用 `readableOn`；根级块用 `\u0000block:${kind}`。
42. 层级靠浓淡：`tintAt` 每深一层递减（地板 35%），非实色主题一级用 `level1Tint`。
43. 节点阴影**保持原样**（同尺寸 rect 下移 2px + 10% 纯色）。`filter: drop-shadow` 每节点一张离屏图，折叠必掉帧。
44. 操作栏：`@container` 不提升优先级（写基础规则之后）；`container-type` 建层叠上下文 → 浮层靠整块 header 的 z-index（100/画布 0）。阈值 480/412/355/310/272。
45. **重绘成本 = 写进 DOM 的属性数**（冷启 197 节点 4954 写 / 9ms；验收：缓存命中 writes=0，改一字 <30）。**`reset()` 不能清 `entries`**，单条失效交给 `entryOf` 核对 `cached.g===box.g && card.isConnected`。
46. `paintMoved` 对尺寸变了的节点也要补 `applySize/applyCircle`。
47. `paintSelection` 用 `(structureGen, 选中集合)` 早退；`prune()` 不能按数量相等短路。
48. 导出 SVG：清最外层 g 的 transform、viewBox 用 `mm.state.rect`；`getComputedStyle` 内联字体/色/底/边框；`stripHidden` 删 `display:none`（必须在 `inlineForeignStyles` **之后**）。验收用 `<img src="data:image/svg+xml,…">`。

## 块卡片

49. 块 HTML **必须包 `<div class="obmind-block-md markdown-rendered">`**（代码底色/高亮/表格线/公式全挂 `.markdown-rendered` 下）。渲染必须在 `setData` **之前** await 完（markmap 读 `foreignObject > div > div` 的 scrollWidth/Height）。缓存 key=`file.path|kind|lang|raw`。
50. 复制按钮是**阅读视图后处理**加的：`decorateCodeBlocks` 给每个 `<pre>` 补 `.copy-code-button`，点击走**画布事件委托**。宽度只能 `:has(.obmind-block-md)` + `width:max-content; max-width:640px`（`width:auto` 会让内部 fit-content 塌成 26px）。`pre` 强制 `pre-wrap`。
51. 块只读全链路：`startEdit` / 双击 / 新建 / 插块 / 提层 / 拖动 / 浮动条（只剩删除）/ 新建笔记全拦。`plan` 层 `srcOf()` 对块返 `null` → 块**绝不走 patch 通道**，改块即整树重建。

## 导航

52. 两步走：先定「导图看哪篇」（`targetFile`+压栈）再动 leaf。`openDoc` 必须先改 `targetFile` 再 `openFile`。动不动 leaf 由 `NavPolicy` 四档决定；栈内已有该 path 走 `goBackTo`。
53. 新标签开主区：用主区 markdown 标签的 `parent` 走 `createLeafInParent`，不能 `getLeaf("tab")`。
54. **钉住 = 锁「这张图」不锁导航**：唯一分叉 `navigate(file)`：钉住→`openFileOnly`，否则→`openDoc`。map-only + 钉住点链接 = 什么都不发生。
55. 「节点 → 新笔记」（`app/notePlan.ts` 纯函数）：名字清 `# ^ [ ]` 与 Windows 非法字符；文件夹复用 `getConfig("newFileLocation"/"newFileFolderPath")`；同名复用；**先建文件后改节点**；带行内样式用别名 `[[名|**原文**]]`。Ctrl+N 挂 **document 捕获阶段**且只在 `containerEl.contains(target)` 时接管。
56. **键位只有一张表**（`app/actions.ts`）：`ACTIONS` = id + 归一化 keys(`mod/alt/shift`) + scopes(`canvas`/`view`) + `when(ActionState)`；`matchAction` 统一挡 `phase!=="idle"`，视图只剩 `runAction(id)`。加操作 = 表里一行 + 一个 case。两条键盘链判据必须同源。
57. **IO 走端口**：`io/clipboard.ts` 的 `ClipboardPort`（读失败返空串，不抛）。Ctrl+V → `edit/paste.ts` `planPaste`：一行一个同级子节点、**不按源缩进还原层级**、剥一层 `>`/列表标记/`#`、上限 200、粘完不进编辑框。读完剪贴板必须复查 `phase` 与 `primaryLine`。

## 滚轮 / 触摸板

58. **只有一个入口**：`applyZoomFilter` 对 wheel 返 `false` + `buildOptions` 的 `pan:false`（d3 的 `wheeled` 会 `stopImmediatePropagation()`；markmap 的 `handlePan` 抢同一个 wheel）；监听挂**捕获阶段** + `passive:false`（块卡片里的 `.table-wrapper`/embed 自己是滚动容器，冒泡阶段那一轴已被吃掉）。攒到下一帧一次 `scaleBy` / `translateBy(dx/k, dy/k)`。
59. **判据（`render/wheel.ts`）**：`ctrlKey`（捏合）/`Shift` 优先 → `wheelMode` 三档兜底 → auto 下**手势内自证**（鼠标这一格是首格的整数倍、容差 0.03）。**绝不猜「一格=多少像素」**（3 行@100%=100、1 行@100%=40、3 行@150%=66.67；1.18.16 写死 100/120、1.18.17 要求整数，两次都判错）。倍率**按格算**，一格恒 2^0.2。1.18.23 三处修正：① 首格缩放**挂一帧**（`takeFirstNotch()`），第二格推翻手势就整份丢弃（轴锁把 `deltaX` 压成 0 → 快滑首格必判鼠标 → 原来会跳 1.149 倍且不回滚）；② 零位移事件在**已有手势时续期 `last`**，否则超 `GESTURE_GAP` 会重新猜设备、中途跳回缩放（空闲时不续，否则第一格变「非 fresh 无结论」被当平移）；③ 同帧 zoom+pan 的 k 必须在**缩放落地之后**读，旧 k 让平移过冲 14.87%。
60. **双指锁单轴是 Windows 触摸板系统层锁的**（rails，手指要明显斜过阈值才解锁），Web 层拿不到原始两指轨迹 → **不可修**；`touch-action:none` 对它无效（双指平移在到页面之前已被合成成 wheel）。绕行：中键（三指点按）/右键拖动走 pointer，Shift+滚轮纯横移。**不要**加取整「平滑」（会把亚像素变 0，正好造出「幅度小就不动」），也不要加预测/惯性（系统已有加速曲线，两层叠必飘）。

## 构建与验证

- 链路：`npx tsc -noEmit -skipLibCheck` → `npm test`（`scripts/testBatch.ts`，T1–T30，T30 覆盖滚轮 60+ 条）→ `node esbuild.config.mjs production`（沙箱可能 EBUSY）→ `node tmp/smoke.cjs` → 部署到 `D:/BJRepository/2. 知识星球/.obsidian/plugins/obmind-map`（目录名必须等于 id）比 sha1。
- 埋点规矩：**每个可能出问题的分支都要有数字**；假证据比没证据更浪费时间。**1.18.12 起业务侧埋点全部注释停用**，要排查就在原处解开，别另起一套。
- 浏览器行为用 **Python Playwright + `channel="msedge"`**（`D:/Program Files/Python314/python.exe`）；`--virtual-time-budget` 下 rAF 不推进。探针 `tmp/*.ts|py`：`wheelDiag`（真 d3-zoom + 真 WheelEvent，含帧长/延迟/锁轴序列）、`lagProbe`/`paintProbe`/`dragProbe`/`widenProbe`/`createProbe3`/`blockProbe2`。探针里没有 `MarkdownRenderer`，原生样式只能真机验。
- 现场探针三档 off/events/frames，开关存 localStorage `obmind:trace`；热路径先 `isTracing()`；`installTraceConsole` 不能幂等。

> 三条硬事实：id 与目录名都是 `obmind-map`（永久不可改），显示名 `Weaver Mindmap`；非 tty 环境 push 拿不到 GCM 登录态，push/release 由用户自己做；提交前必跑 `npx eslint src`（0 error）。
