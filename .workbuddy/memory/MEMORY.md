# obmind 项目约定

## 架构分层（目标）
依赖单向向下，`domain` 永不 import obsidian、不碰 DOM：
`types`(L0) → `domain` 纯函数(L1) → `render`/`ui`(L2) → `infra` Obsidian 适配(L3) → `app` 用例+会话状态(L4) → `view`(L5)。

进度（1.8.0）：
- L0 `src/types.ts`：SrcRef / BlockInfo / Span / WriteOp / EditorAction / DropMode。
- L1 `src/domain/syntax.ts`：buildTree、缩进度量。**行内渲染改为注入 `render` 参数**，
  domain 不认识 HTML，能在 Node 直接跑用例。
- L2 `src/render/`：inlineHtml、frame（rAF 合并）、painter（卡片/连线/收放点）、geometry。
  `src/ui/toolbar.ts`：操作栏（按钮声明成数据表 + setEnabled/setStatus）。
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
    操作栏用 `container-type: inline-size`，260px 窄侧栏仍能一行放下（图标 24、分隔线隐藏、
    下拉收缩；图标按钮绝不缩，缩了就点不中）。
18. 撤销/重做存**整篇快照**（`app/History.ts`，纯函数，上限 40），不存反向操作；
    `runWrite(..., remember=false)` 给撤销自身用，否则「撤销」会把自己压进 past 原地打转。

## 构建与验证
- `node esbuild.config.mjs production`（Windows 沙箱内可能 EBUSY，需 `dangerouslyDisableSandbox`）。
- `tsc -noEmit -skipLibCheck` 先过类型。
- 浏览器行为验证用 **Python Playwright + channel="msedge"**。
  `msedge --headless=new --virtual-time-budget` 下 **rAF 不推进**，测不到 markmap 重排，别用它验证布局。
- 插件加载链路用 mock obsidian + `require("main.js")` 验证，含幂等注册路径。
- 部署目标：`D:/BJRepository/2. 知识星球/.obsidian/plugins/obmind`（copy 后比对 sha1）。
