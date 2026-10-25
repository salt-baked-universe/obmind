/**
 * 批量操作纯函数验证（moveNodes / removeGroup）。
 * 用真实解析器 buildTree 造节点坐标，断言整篇重写结果正确，不走 Obsidian。
 */
import { buildTree, collectBlockNodes } from "../src/domain/syntax";
import { collectSrc } from "../src/edit/move";
import { moveNode, moveNodes } from "../src/edit/move";
import { blockRange } from "../src/edit/move";
import { subtreeEndOf } from "../src/edit/create";
import { insertBlockPlan } from "../src/edit/block";
import { EditService } from "../src/app/EditService";
import { planProjection, relabelTree } from "../src/app/plan";
import { nodeBarPosition } from "../src/ui/nodeBarPosition";
import { PASTE_MAX_NODES } from "../src/edit/paste";
import { ACTIONS, keyOf, matchAction } from "../src/app/actions";
import type { ActionState, KeyLike } from "../src/app/actions";
import { looksLikeWheel, normalizeWheelPin, toPixels, WheelGesture } from "../src/render/wheel";
import type { WheelEventLike } from "../src/render/wheel";
import { formatStats, treeStats } from "../src/domain/stats";
import {
  firstChildRef,
  stepVisible,
  visibleLeafRefs,
  visibleRefs,
} from "../src/domain/nav";
import type { NavNode } from "../src/domain/nav";
import {
  applyTemplate,
  formatDate,
  hasWikiLink,
  linkLiteral,
  notePathOf,
  noteTitleOf,
  resolveNoteFolder,
  sanitizeFileName,
} from "../src/app/notePlan";
import type { SrcRef, WriteOp } from "../src/types";

function parse(content: string): { nodes: SrcRef[]; step: number; unit: string } {
  const tree = buildTree(content, "test.md", { render: (s) => s });
  const nodes = collectSrc(tree);
  const root = tree as unknown as { payload?: { step?: number } };
  return { nodes, step: root.payload?.step ?? 2, unit: "" };
}

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed++;
    console.error("  ✗ FAIL:", msg);
  } else {
    console.log("  ✓", msg);
  }
}

function show(label: string, content: string): void {
  console.log(`\n[${label}]\n` + content.split("\n").map((l, i) => `${i}\t| ${l}`).join("\n"));
}

/**
 * 在测试里执行一次写入计划（writer 那层的极简替身）。
 *
 * 只做 span 替换 / whole 整篇替换，不碰文件、不做锚点校验 ——
 * 这里验的是「计划长什么样」。锚点校验另有各处的 checkLine 断言。
 */
function applySpan(content: string, op: WriteOp): string {
  if (op.kind === "whole") return op.content;
  const lines: string[] = content.split("\n");
  const { start, end, lines: repl } = op.span;
  return [...lines.slice(0, start), ...repl, ...lines.slice(end)].join("\n");
}

// ---------------------------------------------------------------------------
console.log("=== T1: 单节点移动（回归） ===");
{
  const content = [
    "# Root",
    "## A",
    "## B",
    "## C",
  ].join("\n");
  const { nodes, step, unit } = parse(content);
  const res = moveNode({
    lines: content.split("\n"),
    nodes,
    step,
    unit,
    srcLine: 1, // A
    targetLine: 3, // C
    mode: "after",
  });
  assert(res.ok, "单节点 move 成功");
  if (res.ok) {
    const out = res.lines.join("\n");
    show("T1 out", out);
    assert(out.includes("## B") && out.includes("## C") && out.includes("## A"), "三节都在");
    assert(out.indexOf("## C") < out.indexOf("## A"), "A 被挪到 C 之后");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T2: 整体拖动 两个兄弟到另一节点下当子节点 ===");
{
  // 结构：root > A,B,C（同级标题）；把 A 和 C 一起拖到 B 下面当子节点。
  const content = [
    "# Root",
    "## A",
    "## B",
    "## C",
  ].join("\n");
  const { nodes, step, unit } = parse(content);
  const res = moveNodes({
    lines: content.split("\n"),
    nodes,
    step,
    unit,
    srcLines: [1, 3], // A, C
    targetLine: 2, // B
    mode: "child",
  });
  assert(res.ok, "整体移动成功");
  if (res.ok) {
    const out = res.lines.join("\n");
    show("T2 out", out);
    // 期望顺序：Root, B, A, C
    const ri = out.indexOf("# Root");
    const bi = out.indexOf("## B");
    const ai = out.indexOf("## A");
    const ci = out.indexOf("## C");
    assert(ri < bi && bi < ai && ai < ci, "B 在前，A、C 紧跟其后成为其子节点");
    assert((out.match(/## /g) || []).length === 3, "仍是 3 个二级节点，没丢没增");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T3: 整体拖动 保持相对顺序（A 在 C 前，移动后仍是 A 在 C 前） ===");
{
  const content = [
    "# Root",
    "## A",
    "text a",
    "## B",
    "## C",
  ].join("\n");
  const { nodes, step, unit } = parse(content);
  const res = moveNodes({
    lines: content.split("\n"),
    nodes,
    step,
    unit,
    srcLines: [1, 4], // A(含 body), C
    targetLine: 3, // B
    mode: "child",
  });
  assert(res.ok, "整体移动（含带 body 的块）成功");
  if (res.ok) {
    const out = res.lines.join("\n");
    show("T3 out", out);
    const ai = out.indexOf("## A");
    const ci = out.indexOf("## C");
    assert(ai < ci, "A 仍排在 C 之前（相对顺序保留）");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T4: 选中集含嵌套 → 整体移动应拒绝（防环/防错位） ===");
{
  // A 有子节点 A1；若同时选 A 和 A1 当作整体移动应被拒（视图层 groupOf 会先剥离，
  // 但 moveNodes 也要能防御）。
  const content = [
    "# Root",
    "## A",
    "### A1",
    "## B",
  ].join("\n");
  const { nodes, step, unit } = parse(content);
  const res = moveNodes({
    lines: content.split("\n"),
    nodes,
    step,
    unit,
    srcLines: [1, 2], // A 和 A1（A1 在 A 子树内）
    targetLine: 3, // B
    mode: "child",
  });
  assert(!res.ok, "嵌套选中整体移动被拒绝");
  if (!res.ok) console.log("  (reason:", res.reason, ")");
}

// ---------------------------------------------------------------------------
console.log("\n=== T5: 批量删除 两个完整不相邻子树 ===");
{
  const content = [
    "# Root",
    "## A",
    "### A1",
    "## B",
    "### B1",
    "#### B2",
    "## C",
  ].join("\n");
  const { nodes } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step: 2, unit: "" };
  const out = svc.removeGroup({ snap, lines: [1, 3] }); // 删 A 整棵 + B 整棵
  assert(out.kind === "write", "批量删除产出写入计划");
  if (out.kind === "write") {
    const deleted = (out.op as { content: string }).content;
    show("T5 out", deleted);
    assert(!deleted.includes("## A") && !deleted.includes("### A1"), "A 子树整棵没了");
    assert(!deleted.includes("## B") && !deleted.includes("### B1") && !deleted.includes("#### B2"), "B 子树整棵没了");
    assert(deleted.includes("## C"), "C 保留");
    assert(deleted.includes("# Root"), "Root 保留");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T6: 批量删除 重叠范围自动合并（不会删两次/漂移） ===");
{
  const content = [
    "# Root",
    "## A",
    "### A1",
    "### A2",
    "## B",
  ].join("\n");
  const { nodes } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step: 2, unit: "" };
  // A 和它的子 A1 同时选中（范围重叠），应合并成 [A..A2] 一次性删
  const out = svc.removeGroup({ snap, lines: [1, 2] });
  assert(out.kind === "write", "重叠批量删除产出计划");
  if (out.kind === "write") {
    const deleted = (out.op as { content: string }).content;
    show("T6 out", deleted);
    assert(deleted.includes("## B"), "B 仍在");
    assert(!deleted.includes("## A"), "A 被删");
    const count = (deleted.match(/^## /gm) || []).length;
    assert(count === 1, "只剩 B 一个二级节点（合并删除没多删）");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T7: 批量删除 只删叶子 → 其余（含顶层）保留 ===");
{
  // 注意：解析器里文件根节点 depth=1（没有 depth=0 的节点），顶层节点可被删，
  // 删它会连带整篇；这里只删一个叶子（B），验证非选中部分不受影响。
  const content = [
    "# Root",
    "## A",
    "## B",
  ].join("\n");
  const { nodes } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step: 2, unit: "" };
  const out = svc.removeGroup({ snap, lines: [2] }); // 只删 B
  assert(out.kind === "write", "批量删除（单叶子）产出计划");
  if (out.kind === "write") {
    const deleted = (out.op as { content: string }).content;
    show("T7 out", deleted);
    assert(deleted.includes("# Root"), "Root 保留");
    assert(deleted.includes("## A"), "A 保留");
    assert(!deleted.includes("## B"), "B 被删");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T8: blockRange 自检（确认依赖可用） ===");
{
  const content = ["# R", "## A", "### A1", "## B"].join("\n");
  const { nodes } = parse(content);
  const ai = nodes.findIndex((n) => n.line === 1);
  const r = blockRange(nodes, ai);
  assert(r.start === 1 && r.end === 2, "A 的子树范围 [1..2] 含 A1");
}

// ---------------------------------------------------------------------------
console.log("\n=== T9: 编辑框 Tab（child）→ 提交文字并建子级，当前节点层级不变 ===");
{
  // 回归：以前编辑框 Tab 等于「把当前节点缩进一级」，改完字按 Tab 会把它
  // 挪成上一个兄弟的子节点 —— 改字的手势不该动结构。
  const content = ["# Root", "## A", "### A1", "## B"].join("\n");
  const { nodes, step, unit } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  const src = nodes.find((n) => n.line === 1);
  assert(!!src, "找到节点 A");
  const out = svc.commit({ snap, src: src!, action: "child", value: "A改" });
  assert(out.kind === "write", "Tab 产出写入计划");
  if (out.kind === "write") {
    const next = applySpan(content, out.op);
    show("T9 out", next);
    const lines = next.split("\n");
    assert(lines[1] === "## A改", "A 仍是二级标题，只改了文字（没被缩进）");
    assert(lines[2] === "### A1", "原有子节点 A1 原样保留");
    assert(lines[3] === "### 新节点", "新子级插在子树末尾、比 A 深一级");
    assert(lines[4] === "## B", "B 还在原位置");
    assert(out.focusLine === 3, "焦点落在新行上");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T10: 编辑框 Tab（child）→ 无子节点时直接跟一行子级 ===");
{
  const content = ["# Root", "## A", "## B"].join("\n");
  const { nodes, step, unit } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  const src = nodes.find((n) => n.line === 1)!;
  const out = svc.commit({ snap, src, action: "child", value: "A2" });
  assert(out.kind === "write", "无子节点时也产出计划");
  if (out.kind === "write") {
    const next = applySpan(content, out.op);
    show("T10 out", next);
    assert(next === ["# Root", "## A2", "### 新节点", "## B"].join("\n"), "结构：A2 后紧跟它的子级");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T11: 编辑框 Tab（child）→ 正文缩进体系按步长加深 ===");
{
  const content = ["- A", "  - A1", "- B"].join("\n");
  const { nodes, step, unit } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  const src = nodes.find((n) => n.line === 0)!;
  const out = svc.commit({ snap, src, action: "child", value: "A!" });
  assert(out.kind === "write", "正文体系产出计划");
  if (out.kind === "write") {
    const next = applySpan(content, out.op);
    show("T11 out", next);
    assert(next === ["- A!", "  - A1", "  - 新节点", "- B"].join("\n"), "新行缩进一个步长，A 本身不变");
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T12: 浮动条贴画布右侧、垂直居中 ===");
{
  const host = { width: 400, height: 300 };
  const bar = { width: 34, height: 200 };

  // 常规：右对齐（留 8px），上下均分（150 - 100 = 50）
  const mid = nodeBarPosition({ host, bar });
  assert(mid.left === 400 - 34 - 8, `右对齐留白（实际 ${mid.left}）`);
  assert(mid.top === 50, `垂直居中（实际 ${mid.top}）`);

  // 奇数高度 → 取整，不能出现半个像素
  const odd = nodeBarPosition({ host: { width: 400, height: 301 }, bar });
  assert(odd.top === 51, `301 高时 50.5 取整（实际 ${odd.top}）`);

  // 条子比画布还高（窄侧栏 + 横向很矮）→ 贴顶边，第一个按钮一定可见
  const tall = nodeBarPosition({ host: { width: 240, height: 120 }, bar });
  assert(tall.top === 8, `条子过高时贴顶（实际 ${tall.top}）`);
  assert(tall.left === 240 - 34 - 8, "右边距不受高度影响");

  // 正好放得下（300 - 284 = 16，两侧各 8）
  const exact = nodeBarPosition({ host, bar: { width: 34, height: 284 } });
  assert(exact.top === 8, `正好放下时贴 8（实际 ${exact.top}）`);

  // 画布比条子还窄（侧栏拖到极窄）→ 不留负偏移
  const narrower = nodeBarPosition({ host: { width: 30, height: 300 }, bar });
  assert(narrower.left === 8, `窄到 30px 时贴左边（实际 ${narrower.left}）`);

  // 自定义边距
  const m = nodeBarPosition({ host, bar, margin: 16 });
  assert(m.left === 400 - 34 - 16 && m.top === 50, "margin 可配");
}

// ---------------------------------------------------------------------------
console.log("\n=== T13: 规模统计（节点数 / 树深）===");
{
  type N = { content: string; children?: N[] };
  const stats = (tree: N | null) => treeStats(tree as never);

  assert(formatStats(stats(null)) === "", "空树不产生文案");

  // 只有根：一个节点、一层
  const root: N = { content: "笔记名", children: [] };
  const s1 = stats(root);
  assert(s1.nodes === 1 && s1.depth === 1, `只有根（实际 ${s1.nodes}/${s1.depth}）`);

  //      根
  //     /   \
  //    A     B
  //   / \     \
  //  A1 A2     B1
  const tree: N = {
    content: "根",
    children: [
      { content: "A", children: [{ content: "A1" }, { content: "A2" }] },
      { content: "B", children: [{ content: "B1" }] },
    ],
  };
  const s2 = stats(tree);
  assert(s2.nodes === 6, `节点数含根（实际 ${s2.nodes}）`);
  assert(s2.depth === 3, `树深按层数算（实际 ${s2.depth}）`);
  assert(formatStats(s2) === "6 节点 · 深 3", `文案（实际 ${formatStats(s2)}）`);

  // 深链：显式栈实现，5000 层也不能栈溢出
  let chain: N = { content: "叶子" };
  for (let i = 0; i < 5000; i++) chain = { content: `第${i}层`, children: [chain] };
  const s3 = stats(chain);
  assert(s3.nodes === 5001 && s3.depth === 5001, `深链（实际 ${s3.nodes}/${s3.depth}）`);

  // children 缺省（叶子节点在 markmap 里可能没有这个字段）
  const s4 = stats({ content: "孤立" });
  assert(s4.nodes === 1 && s4.depth === 1, "没有 children 字段也当叶子");
}

// ---------------------------------------------------------------------------
console.log("\n=== T14: 编辑框清空 = 放弃修改，节点保留 ===");
{
  // 结论变过两次，现在是最终版：**编辑框永远不产出结构变化**。
  // 「清空即删节点」看着像 XMind，实际是把「改字」和「删结构」混在一起 ——
  // 全选想重打一行，回车那一刻整棵子树没了。删除只从画布选中态走。
  const content = ["# 根", "- A", "  - A1", "- B"].join("\n");
  const { nodes, step, unit } = parse(content);
  const snap = { content, nodes, step, unit };
  const svc = new EditService();
  const src = nodes.find((n) => n.line === 1)!;
  assert(!!src, "找到 A 的源坐标");

  for (const action of ["commit", "sibling", "outdent"] as const) {
    const out = svc.commit({ snap, src, action, value: "   " });
    assert(out.kind === "none", `${action} + 空文本 → 不写文件（节点保留）`);
  }

  // 非空文本照旧只改这一行
  const keep = svc.commit({ snap, src, action: "commit", value: "A 改名" });
  assert(keep.kind === "write", "非空文本仍然只改这一行");
  if (keep.kind === "write" && keep.op.kind === "span") {
    assert(
      keep.op.span.start === 1 && keep.op.span.end === 2 && keep.op.span.lines.length === 1,
      "只替换 A 这一行，不碰子树",
    );
  }
}

console.log("\n=== T15: 方向键导航（末端序列 / 上下 / 左右） ===");
{
  const content = ["# 根", "- A", "  - A1", "  - A2", "- B", "  - B1", "- C"].join("\n");
  const tree = buildTree(content, "test.md", { render: (s) => s });
  const { nodes, step, unit } = parse(content);

  const navNodeAt = (n: NavNode, line: number): NavNode | null => {
    if (n.payload?.src?.line === line) return n;
    for (const c of n.children ?? []) {
      const hit = navNodeAt(c, line);
      if (hit) return hit;
    }
    return null;
  };

  const all = visibleRefs(tree as unknown as NavNode);
  assert(
    all.map((r) => r.line).join(",") === "0,1,2,3,4,5,6",
    "可见序列（含分支）就是文档顺序（根没有 src，不参与）",
  );

  // 上下只认末端：A / B 是有孩子的分支，不进这条序列
  const leaves = visibleLeafRefs(tree as unknown as NavNode);
  assert(
    leaves.map((r) => r.line).join(",") === "2,3,5,6",
    "上下序列只含末端节点：A、B 这两个分支不进",
  );
  assert(stepVisible(leaves, 2, 1)?.line === 3, "A1 按 ↓ 到 A2");
  assert(stepVisible(leaves, 3, 1)?.line === 5, "A2 按 ↓ 落到 B1（跳过还有子级的 B）");
  assert(stepVisible(leaves, 5, 1)?.line === 6, "B1 按 ↓ 到 C");
  assert(stepVisible(leaves, 6, 1) === null, "最后一个再按 ↓ 不动");
  assert(stepVisible(leaves, 2, -1) === null, "第一个再按 ↑ 不动");
  assert(stepVisible(leaves, 6, -1)?.line === 5, "C 按 ↑ 到 B1");

  // 起点本身不是末端（点中分支标题，或按 ← 从子级退回来）
  assert(stepVisible(leaves, 1, 1)?.line === 2, "从分支 A 按 ↓ 落到 A1");
  assert(stepVisible(leaves, 4, 1)?.line === 5, "从分支 B 按 ↓ 落到 B1");
  assert(stepVisible(leaves, 1, -1) === null, "A 之前没有末端，↑ 不动");

  // 折叠 A → A 自己变成末端（屏幕上它就是一根末梢），A1 / A2 退出序列
  const aNode = navNodeAt(tree as unknown as NavNode, 1)!;
  aNode.payload = { ...aNode.payload, fold: 1 };
  const folded = visibleLeafRefs(tree as unknown as NavNode);
  assert(
    folded.map((r) => r.line).join(",") === "1,5,6",
    "折叠 A：A 自己进入末端序列，A1 / A2 退出",
  );
  assert(stepVisible(folded, 1, 1)?.line === 5, "折叠时 A 按 ↓ 到 B1");
  assert(stepVisible(folded, -1, 1)?.line === 1, "没有选中时 ↓ 取第一个末端");
  assert(stepVisible(folded, -1, -1)?.line === 6, "没有选中时 ↑ 取最后一个末端");

  // 左右：父 / 长子
  assert(firstChildRef(nodes, 1)?.line === 2, "A 的长子是 A1");
  assert(firstChildRef(nodes, 2) === null, "叶子没有孩子");
  assert(firstChildRef(nodes, 0)?.line === 1, "根的长子是 A");

  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  assert(svc.parentLineOf(snap, 2) === 1, "A1 的父节点是 A（← 的方向）");
  assert(svc.parentLineOf(snap, 1) === 0, "A 的父节点是「根」");
}

console.log("\n=== T16: 删除后选中落到父节点 ===");
{
  const content = ["# 根", "- A", "  - A1", "  - A2", "- B"].join("\n");
  const { nodes, step, unit } = parse(content);
  const snap = { content, nodes, step, unit };
  const svc = new EditService();

  // nodes: 0:根 d1 | 1:A d2 | 2:A1 d3 | 3:A2 d3 | 4:B d2
  const delLeaf = svc.removeGroup({ snap, lines: [2] });
  assert(delLeaf.kind === "write", "删 A1 → 产生写入");
  if (delLeaf.kind === "write") {
    assert(delLeaf.focusLine === 1, "删 A1 后选中回到父节点 A（行 1）");
  }

  const delTree = svc.removeGroup({ snap, lines: [1, 2] });
  if (delTree.kind === "write") {
    assert(delTree.focusLine === 0, "删 A 整棵子树后选中回到父节点「根」（行 0）");
  } else {
    assert(false, "删 A 整棵子树应当产生写入");
  }

  // 顶层节点：父节点是文件名（不可选），退一步落到删除位置上的下一个兄弟
  const flat = ["- A", "  - A1", "- B"].join("\n");
  const flatParsed = parse(flat);
  const flatSnap = { content: flat, ...flatParsed };
  const delTop = svc.removeGroup({ snap: flatSnap, lines: [0] });
  if (delTop.kind === "write") {
    assert(delTop.focusLine === 0, "删顶层 A → 选中落到补上来的 B（行 0）");
  } else {
    assert(false, "删顶层节点应当产生写入");
  }
}

console.log("\n=== T17: 节点 → 新笔记（命名 / 文件夹 / 模板） ===");
{
  // 取名字：行内标记要剥掉，非法字符要清掉。
  // 这几条都是「不处理就会真出错」的：文件名建不出来、或者双链指到别处。
  assert(noteTitleOf("**重点**") === "重点", "粗体标记不进文件名");
  assert(noteTitleOf("`code`") === "code", "行内代码只取内容");
  assert(noteTitleOf("[链接](https://x.com)") === "链接", "链接只取文字");
  assert(noteTitleOf("A/B 方案") === "A B 方案", "斜杠换成空格（否则会多一层目录）");
  assert(noteTitleOf("Q3 复盘 #会议") === "Q3 复盘 会议", "# 会让双链变成锚点，必须去掉");
  assert(noteTitleOf("[[已双链]]") === "已双链", "方括号会破坏双链语法，去掉");
  assert(noteTitleOf("   ") === "", "全是空白 → 取不出名字");
  assert(sanitizeFileName("结尾有点...") === "结尾有点", "结尾的点去掉（Windows 会静默吃掉）");
  assert(hasWikiLink("- 看看 [[读书笔记]]") === true, "有双链 → 不再提供建笔记入口");
  assert(hasWikiLink("很普通的文字") === false, "没有双链");

  // 落地文件夹：完全跟随 Obsidian 自己的设置，插件不另立一套
  assert(
    resolveNoteFolder({ location: "root", folder: "x", currentPath: "a/b.md" }) === "",
    "root → 库根",
  );
  assert(
    resolveNoteFolder({ location: "folder", folder: "/模板/", currentPath: "a/b.md" }) ===
      "模板",
    "folder → 设置里的文件夹（首尾斜杠去掉）",
  );
  assert(
    resolveNoteFolder({ location: "current", folder: "x", currentPath: "a/b/c.md" }) ===
      "a/b",
    "current → 当前笔记所在目录",
  );
  assert(
    resolveNoteFolder({ location: "", folder: "", currentPath: "a/b.md" }) === "",
    "没设置 / 不认识的取值 → 库根",
  );
  assert(notePathOf("", "标题") === "标题.md", "库根路径");
  assert(notePathOf("a/b", "标题") === "a/b/标题.md", "子目录路径");

  // 模板：变量与格式化
  const at = new Date(2026, 9, 23, 8, 5, 0); // 2026-10-23 08:05
  assert(formatDate(at, "YYYY-MM-DD") === "2026-10-23", "默认日期格式");
  assert(
    formatDate(at, "YYYY年MM月DD日 HH:mm") === "2026年10月23日 08:05",
    "带文字与时间的格式",
  );
  assert(formatDate(at, "YY/M/D") === "26/10/23", "不补零的 token 也要正确");
  const tpl: string = applyTemplate(
    "# {{title}}\n\n来源：{{from}}\n建{{date:YYYY.MM.DD}} {{time}}",
    { title: "读书笔记", from: "我的想法", now: at },
  );
  assert(
    tpl === "# 读书笔记\n\n来源：[[我的想法]]\n建2026.10.23 08:05",
    "模板变量全部展开",
  );
  assert(
    applyTemplate("{{title}}{{from}}", { title: "X", from: "", now: at }) === "X",
    "没给来源时不留空链接",
  );

  // 双链字面量
  assert(linkLiteral("标题") === "[[标题]]", "无别名");
  assert(
    linkLiteral("重点", "**重点**") === "[[重点|**重点**]]",
    "原文带样式 → 用别名保住卡片上的字",
  );
  assert(linkLiteral("重点", "重点") === "[[重点]]", "别名与标题相同则不写别名");
  assert(linkLiteral("重点", "a|b") === "[[重点|ab]]", "别名里的 | 会截断链接，去掉");
}


// ---------------------------------------------------------------------------
console.log("\n=== T18: 块是独立节点（裸块按缩进落位，不吞后面的行） ===");
{
  // 用户的真实写法：纯正文、块顶格。块自己是一张卡片，和「父节点」平级。
  const content = [
    "父节点",
    "  子节点",
    "```python",
    "print(1)",
    "```",
    "  下一个子节点",
  ].join("\n");
  const { nodes } = parse(content);
  const tree = buildTree(content, "test.md", { render: (s) => s });

  assert(nodes.length === 4, "块也是树节点（父 / 子 / 块 / 下一个）");
  const zi = nodes.find((n) => n.text === "子节点")!;
  assert(zi.blockStart === undefined, "宿主不再接管块的行区间（块是独立节点）");

  const bk = nodes.find((n) => n.blockNode !== undefined)!;
  assert(bk.blockNode === "bound", "裸块没有代理行，标记为 bound");
  assert(bk.line === 2 && bk.endLine === 4, "块节点的区间 = 围栏首行到末行");
  assert(bk.depth === 1, "裸块按围栏自己的缩进落位（顶格 = 第一层）");
  assert(
    nodes.find((n) => n.text === "下一个子节点")!.depth === 2,
    "后面紧跟的缩进节点没被块吞掉",
  );

  type N = { content: string; children?: N[] };
  const root = tree as unknown as N;
  assert(root.children?.length === 2, "块与父节点是兄弟，不在父节点卡片里");
  assert(root.children![0].content === "父节点", "文档顺序不变：父节点在前");
  const card = root.children![1].content;
  assert(card.includes("obmind-block-pill"), "块卡片此刻是占位，等视图层渲染");
  assert(!card.includes("<pre"), "解析层不再自己拼代码块");
  assert(!root.children![0].content.includes("obmind-block"), "宿主卡片里不再挂块");

  // 引用 / 表格同样是独立节点
  const q = parse(["父", "  子", "> 第一行", "> 第二行", "  下一个"].join("\n"));
  const qb = q.nodes.find((n) => n.blockNode !== undefined)!;
  assert(qb.endLine - qb.line === 1, "连续引用合成一个块（两行）");
  assert(q.nodes.find((n) => n.text === "下一个")!.depth === 2, "引用没把后一个节点吞掉");
  assert(!q.nodes.some((n) => n.text === "第一行"), "引用内部不再一行一个节点");

  const t = parse(["父", "  子", "| a | b |", "|---|---|", "| 1 | 2 |", "  下一个"].join("\n"));
  const tb = t.nodes.find((n) => n.blockNode !== undefined)!;
  assert(tb.line === 2 && tb.endLine === 4, "表格整块成一个节点");
  assert(t.nodes.find((n) => n.text === "下一个")!.depth === 2, "表格没把后一个节点吞掉");

  // 文首块：前面没有节点 → 根的第一个子节点
  const top = buildTree("```txt\n图\n```\n说明", "测试.md", { render: (s) => s }) as unknown as N;
  assert(
    (top.children?.[0]?.content ?? "").includes("obmind-block-pill"),
    "文首块是根的第一个子节点",
  );
  assert(top.children?.[1]?.content === "说明", "说明排在块后面");
}

console.log("\n=== T19: 自由块（代理行承载缩进） ===");
{
  // 块自己不能缩进（围栏到 4 格就变字面量），所以它上面那行注释替它缩。
  const content = [
    "父",
    "  <!-- obmind:block -->",
    "  ```js",
    "  run()",
    "  ```",
    "  兄弟",
  ].join("\n");
  const { nodes } = parse(content);

  const bk = nodes.find((n) => n.blockNode !== undefined)!;
  assert(bk.blockNode === "free", "有代理行 = 自由块");
  assert(bk.proxyLine === 1, "代理行行号记在 src 上");
  assert(bk.line === 1 && bk.endLine === 4, "节点的区间从代理行开始、到块末行结束");
  assert(bk.depth === 2, "层级由代理行的缩进决定（父 → 块）");
  assert(
    nodes.find((n) => n.text === "兄弟")!.depth === 2,
    "代理行没有把后面的同行节点吞掉",
  );

  // 拖动自由块：只改代理行的缩进，块本体一行都不动
  const drag = moveNode({
    lines: content.split("\n"),
    nodes,
    step: 2,
    unit: "",
    srcLine: bk.line,
    targetLine: nodes.find((n) => n.text === "父")!.line,
    mode: "before",
  });
  assert(drag.ok, "自由块可以拖动");
  if (drag.ok) {
    const out = drag.lines;
    assert(out[0].trim() === "<!-- obmind:block -->", "代理行跟着块一起搬");
    assert(out[1] === "  ```js", "块本体保持原样（缩进没被改）"); // 仍在 2 格
    assert(out[2] === "  run()", "代码内容原样保留");
  }

  // 裸块拖动：自动补一行代理行，块本体仍然不动
  const bare = ["父", "  子", "```js", "run()", "```"].join("\n");
  const bareNodes = parse(bare).nodes;
  const bareBlk = bareNodes.find((n) => n.blockNode !== undefined)!;
  const up = moveNode({
    lines: bare.split("\n"),
    nodes: bareNodes,
    step: 2,
    unit: "",
    srcLine: bareBlk.line,
    targetLine: bareNodes.find((n) => n.text === "子")!.line,
    mode: "child",
  });
  assert(up.ok, "裸块也能拖（拖的同时自动升级成自由块）");
  if (up.ok) {
    const idx = up.lines.findIndex((l) => l.includes("obmind:block"));
    assert(idx >= 0, "拖动时补上了代理行");
    assert(up.lines[idx + 1].trim() === "```js", "代理行后面紧跟围栏（块本体没被改）");
    assert(up.lines[idx + 2] === "run()", "代码行顶格保留");
  }
}

console.log("\n=== T19b: 删除 / 区间按整块算 ===");
{
  const content = ["父", "  A", "  B", "```js", "run()", "```"].join("\n");
  const { nodes, step, unit } = parse(content);
  const bi = nodes.findIndex((n) => n.text === "B");
  assert(blockRange(nodes, bi).end === 2, "B 的地盘不再延伸到块（块已独立）");

  const bkIdx = nodes.findIndex((n) => n.blockNode !== undefined);
  const r = blockRange(nodes, bkIdx);
  assert(r.start === 3 && r.end === 5, "块自己的地盘 = 围栏首行到末行");

  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  const del = svc.removeGroup({ snap, lines: [nodes[bkIdx].line] });
  assert(del.kind === "write", "单独删块产出写入计划");
  if (del.kind === "write") {
    const out = applySpan(content, del.op);
    assert(!out.includes("run()"), "整块代码被删掉");
    assert(out.includes("  A") && out.includes("  B"), "兄弟节点都在");
  }

  // 删宿主不再连带删块（块现在是独立节点）
  const delHost = svc.removeGroup({ snap, lines: [nodes[bi].line] });
  assert(delHost.kind === "write", "删宿主产出写入计划");
  if (delHost.kind === "write") {
    const out = applySpan(content, delHost.op);
    assert(out.includes("run()"), "块留在原地（它不再依附宿主）");
  }
}

console.log("\n=== T20: 操作栏插入块（自动带代理行 / 列表项 / callout） ===");
{
  const plain = parse(["父", "  子", "  兄弟"].join("\n"));
  const zi = plain.nodes.find((n) => n.text === "子")!;
  const plan = insertBlockPlan({ src: zi, step: 2 }, "code");
  assert(plan.insertAfterLine === 1, "插在节点自己那行之后、子节点之前");
  assert(plan.lines[0] === "    <!-- obmind:block -->", "代理行缩一层（成为选中节点的子节点）");
  assert(plan.lines[1] === "```", "块本体顶格：围栏最多能缩 3 格，缩到 4 格就成字面量");
  assert(plan.lines.length === 4, "代理行 + 代码块三行");

  const list = parse(["- 父", "  - 子"].join("\n"));
  const li = list.nodes.find((n) => n.text === "子")!;
  const lp = insertBlockPlan({ src: li, step: 2 }, "quote");
  assert(lp.lines[0] === "    <!-- obmind:block -->", "列表项里的块缩进到标记之后");
  assert(lp.lines[1] === "    > ", "引用同样缩到标记之后（否则跳出列表项）");

  const table = insertBlockPlan({ src: zi, step: 2 }, "table");
  assert(table.lines[1].startsWith("| ") && table.lines[2].includes("---"), "表格给了表头与分隔行");

  // 软换行节点：插在续行之后，别把节点自己的几行劈开
  const multi = parse(["父", "  子", "    续行", "  兄弟"].join("\n"));
  const mi = multi.nodes.find((n) => n.text.startsWith("子"))!;
  const mp = insertBlockPlan({ src: mi, step: 2 }, "code");
  assert(mp.insertAfterLine === mi.endLine, "插在软换行末尾之后");
  // callout 里的节点：块必须带 `>` 前缀，否则会掉到引用外面
  const callout = parse(["> [!tip] 示例", "> 先看这段", "> 后面还有"].join("\n"));
  const cl = callout.nodes.find((n) => n.text === "先看这段")!;
  const cp = insertBlockPlan({ src: cl, step: 2 }, "code");
  assert(cp.lines[0] === ">   <!-- obmind:block -->", "callout 里的代理行保留 `>` 前缀");
  assert(cp.lines[1] === "> ```", "callout 里块本体顶格（`>` 之后不留缩进）");
  assert(cp.lines[2] === ">", "块内空行也要写成 `>`（否则 callout 被截断）");
  assert(cp.insertAfterLine === cl.line, "插在宿主行之后");

  // 插进去的块能被解析成 free 块（闭环）
  const composed = ["父", "  子", ...insertBlockPlan({ src: zi, step: 2 }, "code").lines].join("\n");
  const round = parse(composed).nodes.find((n) => n.blockNode !== undefined)!;
  assert(round.blockNode === "free", "插件插出来的块可以直接拖");
  assert(round.depth === 3, "层级正确：块的父节点就是「子」（子节点再深一层）");
}

console.log("\n=== T20b: 深列表里的代码块必须顶格（围栏不能跟列表内容列走） ===");
{
  // 实测坏过的形状：笔记里 11 层 tab 的提纲，围栏若对齐列表内容列会到 46 列，
  // 而 blockIndent 算出来只有 42 列 —— 既不在列表项里、又超过 3 格，
  // Obsidian 当成缩进代码块，用户看到的就是 ```python 原样露出来。
  const deep = ["\t\t- 父", "\t\t\t- 子"].join("\n");
  const d = parse(deep);
  const di = d.nodes.find((n) => n.text === "子")!;
  const dp = insertBlockPlan({ src: di, step: 4, unit: "\t", lang: "python" }, "code");
  assert(dp.lines[1] === "```python", "深列表里围栏照样顶格（42 列就会变字面量）");
  assert(dp.lines[1].startsWith("```"), "围栏前面一个空白都没有");
  assert(dp.lines[0].trim() === "<!-- obmind:block -->", "层级由代理行承担");
  assert(dp.lines[0].startsWith("\t\t\t"), "代理行比宿主还深一层");
  assert(dp.lines[3] === "```", "收尾围栏同样顶格");

  // 语言标识：合法字符原样写进 info string，非法字符丢掉
  const py = insertBlockPlan({ src: zi2(), step: 2, lang: "python" }, "code");
  assert(py.lines[1] === "```python", "选了语言就直接写进围栏");
  const bad = insertBlockPlan({ src: zi2(), step: 2, lang: "py thon`" }, "code");
  assert(bad.lines[1] === "```python", "语言里的空白与反引号被清掉");
  const empty = insertBlockPlan({ src: zi2(), step: 2, lang: "" }, "code");
  assert(empty.lines[1] === "```", "不选语言就是裸围栏");

  // 引用 / 表格不是围栏，留在列表项里更整齐（不受第 4 格限制）
  const lq = insertBlockPlan({ src: li2(), step: 2 }, "quote");
  assert(lq.lines[1] === "    > ", "引用仍对齐列表内容列");

  function zi2() {
    return parse(["父", "  子"].join("\n")).nodes.find((n) => n.text === "子")!;
  }
  function li2() {
    return parse(["- 父", "  - 子"].join("\n")).nodes.find((n) => n.text === "子")!;
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== T21: callout 是容器（标题成节点，正文按内部缩进变成子节点） ===");
{
  const content = [
    "> [!NOTE] 工作情况介绍",
    "> 面试官你好",
    "> \t1. 子项",
    "> 顺带一句",
    "",
    "后面的正文",
  ].join("\n");
  const { nodes } = parse(content);

  const title = nodes.find((n) => n.text === "工作情况介绍");
  assert(!!title, "callout 有标题时，标题就是节点文字");
  assert(title!.depth === 1, "标题落在外层缩进算出的深度上");
  assert(nodes.find((n) => n.text === "面试官你好")!.depth === 2, "正文是标题的子节点");
  assert(nodes.find((n) => n.text === "子项")!.depth === 3, "callout 内部的缩进继续分层");
  assert(nodes.find((n) => n.text === "顺带一句")!.depth === 2, "内部缩进退回 0 后回到标题的下一层");
  assert(nodes.find((n) => n.text === "后面的正文")!.depth === 1, "callout 结束后的正文回到同一层，没被吞");

  // 回写坐标必须指回原行里的正文（`> ` 前缀不能被算进 bodyStart）
  const body = nodes.find((n) => n.text === "面试官你好")!;
  assert(body.full.startsWith("> "), "src.full 保留原文的引用前缀");
  assert(body.full.slice(body.bodyStart, body.bodyEnd) === "面试官你好", "bodyStart/bodyEnd 定位到原文正文");
  const svc = new EditService();
  const snap = { content, nodes, step: 2, unit: "" };
  const op = svc.commit({ snap, src: body, action: "commit", value: "改好了" });
  assert(op.kind === "write", "callout 里的节点可以正常回写");
  if (op.kind === "write") {
    const out = applySpan(content, op.op);
    assert(out.split("\n")[1] === "> 改好了", "只改正文，`> ` 前缀保留");
  }

  // 没写标题的 callout：正文第一行顶上，并且不会重复出现在子节点里
  const noTitle = parse(["> [!abstract]", "> 1. 先滚动", "> \t1. 后摘要", "> 2. 可观测"].join("\n"));
  const first = noTitle.nodes[0];
  assert(first.text === "先滚动", "无标题时取正文第一行当标题（列表标记照常剥掉）");
  assert(noTitle.nodes.filter((n) => n.text === "先滚动").length === 1, "被顶上来的那行不再重复成子节点");
  assert(noTitle.nodes.find((n) => n.text === "后摘要")!.depth === first.depth + 1, "内部缩进仍然生效");
  assert(noTitle.nodes.find((n) => n.text === "可观测")!.depth === first.depth, "同级项与顶上来的标题并列，不多套一层");
}

console.log("\n=== T22: callout 里的代码块照常识别（独立节点，层级在区域里） ===");
{
  const content = [
    "> [!tip] 示例",
    "> 先看代码",
    "> ```python",
    "> print(1)",
    "> ```",
    "> 再看结论",
  ].join("\n");
  const { nodes } = parse(content);
  assert(nodes.length === 4, "callout 里块是独立节点（标题 / 正文 / 块 / 结论）");
  const bk = nodes.find((n) => n.blockNode !== undefined)!;
  assert(bk.line === 2 && bk.endLine === 4, "块覆盖引用里的围栏三行");
  assert(bk.depth === 2, "块与 callout 正文同层（代理行缩进 0）");
  assert(
    nodes.find((n) => n.text === "再看结论")!.depth === 2,
    "块没把后面的正文吞成孩子",
  );
}

console.log("\n=== T23: callout 里的新建 / 拖动不会破坏引用结构 ===");
{
  const content = ["> [!NOTE] 标题", "> 一", "> 二", "", "外面"].join("\n");
  const { nodes, step, unit } = parse(content);
  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  const head = nodes.find((n) => n.text === "标题")!;
  const second = nodes.find((n) => n.text === "二")!;

  // 同级：留在 callout 里，必须带 `>` 前缀
  const sib = svc.commit({ snap, src: second, action: "sibling", value: "X" });
  assert(sib.kind === "write", "callout 里能新建同级");
  if (sib.kind === "write") {
    const out = applySpan(content, sib.op).split("\n");
    // commit 会先把当前行改成新值，再插入一行占位节点
    assert(out[2] === "> X" && out[3] === "> 新节点", "新同级带 `>` 前缀，没掉到引用外面");
  }

  // 标题的子级：直接在引用第一层，不再缩进
  const kid = svc.commit({ snap, src: head, action: "child", value: "X" });
  assert(kid.kind === "write", "callout 标题能新建子级");
  if (kid.kind === "write") {
    const out = applySpan(content, kid.op).split("\n");
    assert(out[3] === "> 新节点", "子级落在引用第一层（不多缩一层）");
  }

  // 标题的同级：callout 里面所有行都是它的后代，所以必须到引用外面
  const top = svc.commit({ snap, src: head, action: "sibling", value: "X" });
  assert(top.kind === "write", "callout 标题能新建同级");
  if (top.kind === "write") {
    const out = applySpan(content, top.op).split("\n");
    assert(out[3] === "新节点", "同级落到引用外面（不带 `>`）");
  }

  // 拖动：从引用外拖进 callout，行要补上 `>`
  const outside = nodes.find((n) => n.text === "外面")!;
  const into = moveNode({ lines: content.split("\n"), nodes, step, unit, srcLine: outside.line, targetLine: second.line, mode: "before" });
  assert(into.ok, "外面的节点可以拖进 callout");
  if (into.ok) {
    assert(into.lines.includes("> 外面"), "拖进去的那行补上了 `>` 前缀");
  }

  // 拖动：从 callout 里拖出去，行要去掉 `>`
  const one = nodes.find((n) => n.text === "一")!;
  const outMove = moveNode({ lines: content.split("\n"), nodes, step, unit, srcLine: one.line, targetLine: outside.line, mode: "after" });
  assert(outMove.ok, "callout 里的节点可以拖到外面");
  if (outMove.ok) {
    assert(outMove.lines.includes("一"), "拖出去的行走出了引用（不再带 `>`）");
    assert(!outMove.lines.includes("> 一"), "引用前缀已清掉");
  }
}

console.log("\n=== T24: 原地改字（patch）必须带出新的源坐标 ===");
{
  // 回归：applyPatch 只换 DOM、不动 markmap 的数据。若判定结果里不带新 src，
  // 视图就没法把 payload.src 换掉 —— 节点显示新文字、点开编辑却是旧的。
  // 新建节点后第一次改字必然踩到（那时旧 src 是占位文案「新节点」）。
  const prevTree = buildTree("a\n- b", "t.md", { render: (s) => s });
  const nextTree = buildTree("a\n- b 改", "t.md", { render: (s) => s });
  const plan = planProjection({
    prev: prevTree,
    next: nextTree,
    forceStructure: false,
    sourceSame: false,
  });
  assert(plan.kind === "patch", "只改一处文字走 patch");
  if (plan.kind === "patch") {
    assert(plan.line === 1, "patch 的行号指向被改的那一行");
    assert(plan.src.text === "b 改", "patch 带的是**新**文字（旧的是 b）");
    assert(plan.src.depth === 1, "带出的 src 层级正确（顶格列表项与正文行同为 1）");
  }

  // 没变化就是 none，别退化成 patch
  const same = planProjection({
    prev: prevTree,
    next: buildTree("a\n- b", "t.md", { render: (s) => s }),
    forceStructure: false,
    sourceSame: true,
  });
  assert(same.kind === "none", "原文一样 → none");
}

console.log("\n=== T25: 行号漂移不算结构变化（patch + relabel） ===");
{
  const opts = { render: (s: string) => s };
  // 在 b 上面插一个空行：树形一模一样，只有行号 +1。
  // 以前这条被判成 why=line → 全量 setData（250 节点 400~550ms + 整图重排）。
  const prevTree = buildTree("a\n- b", "t.md", opts);
  const nextTree = buildTree("a\n\n- b 改", "t.md", opts);
  const plan = planProjection({
    prev: prevTree,
    next: nextTree,
    forceStructure: false,
    sourceSame: false,
  });
  assert(plan.kind === "patch", "行号漂移 + 改一个字仍然是 patch");
  if (plan.kind === "patch") {
    assert(plan.relabel, "带出 relabel 标记（调用方必须把新行号写回 DOM）");
    assert(plan.line === 2, "patch 用的是**新**行号（上面多了一行空行）");
    assert(plan.src.line === 2, "带出的 src 也是新行号");
  }

  // 行号要真正写回旧树：编辑框初始文本、拖动落点、写盘锚点全按它定位
  const moved = relabelTree(prevTree, nextTree);
  assert(moved !== null, "结构一致 → 写回成功");
  if (moved) {
    assert(moved.get(1) === 2, "旧行 1 → 新行 2");
    // 树是 root → [a(行0), b(行1)]，b 是第二个孩子
    const b = prevTree.children?.[1];
    assert(b?.payload?.src?.line === 2, "旧树上的 src 已经是新行号");
    assert(b?.payload?.src?.text === "b 改", "连文字一起换成了新的");
  }

  // 结构对不上必须拒绝：行号写错 = 内容被写到别的节点上（比慢 400ms 严重得多）
  const broken = buildTree("a\n- b\n- c", "t.md", opts);
  assert(relabelTree(prevTree, broken) === null, "孩子数量不一致 → null，让调用方退回重建");

  // 行号没漂时不该白写一遍（relabel=false 让调用方跳过这一步）
  const plain = planProjection({
    prev: buildTree("a\n- b", "t.md", opts),
    next: buildTree("a\n- b 改", "t.md", opts),
    forceStructure: false,
    sourceSame: false,
  });
  assert(plain.kind === "patch" && plain.relabel === false, "行号没动 → relabel=false");
}

console.log("\n=== T26: 块节点只交占位，内容由视图层的 MarkdownRenderer 出 ===");
{
  type N = { content: string; children?: N[]; payload?: { block?: { raw: string; kind: string; lines: number } } };
  const codes = Array.from({ length: 10 }, (_v, i) => `line${i + 1}`);
  const src = ["宿主", "```js", ...codes, "```"].join("\n");
  const tree = buildTree(src, "t.md", { render: (s) => s });
  const jobs = collectBlockNodes(tree);
  assert(jobs.length === 1, "整棵树里只有一个块节点");

  const block = jobs[0].block;
  assert(block.kind === "code" && block.lang === "js", "认出了语言");
  assert(block.raw.startsWith("```js"), "raw 带围栏，原样交给渲染器");
  assert(block.raw.includes("line10"), "十行代码一行不少（不再有行数上限）");
  assert(block.lines === 10, "行数统计正确");
  const card = jobs[0].node.content;
  assert(card.startsWith("<span"), "解析层只放占位，不自己拼 <pre>");
  assert(!card.includes("line1"), "占位里不含代码内容");

  // 表格 / 引用 / 公式 都走同一条路
  const t = tree as unknown as N;
  const cases: Array<[string, string]> = [
    ["| a | b |\n|---|---|\n| 1 | 2 |", "table"],
    ["> 一段引用", "quote"],
    ["$$ x = 1 $$", "math"],
  ];
  for (const [body, kind] of cases) {
    const one = buildTree(`宿主\n${body}`, "t.md", { render: (s) => s });
    const got = collectBlockNodes(one);
    assert(got.length === 1 && got[0].block.kind === kind, `${kind} 也是一个块节点`);
  }

  // 缩进原样保留（交给渲染器之后由它自己排版）
  const ind = buildTree("宿主\n```js\nif (a) {\n  run();\n}\n```", "t.md", { render: (s) => s });
  const rawInd = collectBlockNodes(ind)[0].block.raw;
  assert(rawInd.includes("\n  run();"), "块内缩进原样保留");
}

console.log("\n=== T27: 块的只读语义（plan / 编辑 / 统计都不能把它当普通节点） ===");
{
  const mk = (text: string) => buildTree(text, "t.md", { render: (s) => s });

  // 1. 块内容变了 → 必须重建（补 HTML 不会重跑渲染器）
  const pa = planProjection({
    prev: mk("父\n```js\nrun()\n```"),
    next: mk("父\n```js\nrun(1)\n```"),
    forceStructure: false,
    sourceSame: false,
  });
  assert(pa.kind === "structure", "块里改一个字要重建（mermaid / 高亮都得重跑）");

  // 2. 只改宿主文字：块没动，不该被"HTML vs 占位"骗成重建
  const pb = planProjection({
    prev: mk("甲\n乙\n```js\nrun()\n```"),
    next: mk("甲\n乙改\n```js\nrun()\n```"),
    forceStructure: false,
    sourceSame: false,
  });
  assert(pb.kind === "patch", "块没动时仍然走 patch（不能每次打字都全量重建）");

  // 3. 块的 raw 相同、渲染结果不同（换主题等）→ 不因内容判结构
  const pc = planProjection({
    prev: mk("父\n```js\nrun()\n```"),
    next: mk("父\n```js\nrun()\n```"),
    forceStructure: false,
    sourceSame: true,
  });
  assert(pc.kind === "none", "什么都没变 → none");

  // 4. 纯函数层拒绝编辑块
  const content = "父\n```js\nrun()\n```";
  const { nodes, step, unit } = parse(content);
  const bk = nodes.find((n) => n.blockNode !== undefined)!;
  const svc = new EditService();
  const snap = { content, nodes, step, unit };
  assert(svc.commit({ snap, src: bk, action: "commit", value: "x" }).kind === "error", "块不能改文字");
  assert(svc.create({ snap, line: bk.line, mode: "child" }).kind === "error", "块下面不能建节点");
  assert(svc.insertBlock({ snap, line: bk.line, kind: "code" }).kind === "error", "块里不能再插块");

  // 5. 统计不把块算成节点（用户数的是一张张文字卡）
  assert(treeStats(mk("父\n```js\nrun()\n```")).nodes === 2, "统计里不含块");
}

console.log("\n=== T28: 粘贴 = 把剪贴板文本变成一组子节点 ===");
{
  const content = "父\n  子";
  const { nodes, step, unit } = parse(content);
  const snap = { content, nodes, step, unit };
  const svc = new EditService();
  const linesOf = (op: WriteOp): string[] => (op.kind === "span" ? op.span.lines : []);

  // 1. 单行 → 一个子节点，缩进比父深一层
  const one = svc.paste({ snap, line: 0, text: "新内容" });
  assert(one.kind === "write", "单行粘贴要产生写入");
  if (one.kind === "write") {
    assert(one.op.kind === "span" && one.op.span.start === one.op.span.end, "粘贴是纯插入，不替换任何行");
    assert(linesOf(one.op).join("|") === "  新内容", `子节点缩进一层：${JSON.stringify(linesOf(one.op))}`);
    // 父节点整棵子树到第 1 行（「子」），所以插在 1 之后、选中第 2 行
    assert(one.focusLine === 2, "粘完选中第一个新节点");

    // 闭环：把写入结果拼回去重新解析 —— 缩进算错会在这里露出来
    if (one.op.kind === "span") {
      const arr: string[] = content.split("\n");
      arr.splice(one.op.span.start, one.op.span.end - one.op.span.start, ...one.op.span.lines);
      const added = parse(arr.join("\n")).nodes.find((n) => n.line === 2)!;
      assert(added.depth === 2 && added.text === "新内容", `解析回来是「父」的子节点：depth=${added.depth}`);
    }
  }

  // 2. 多行 → 多个同级子节点；空行跳过；列表标记剥掉（目标位置会补自己的）
  const many = svc.paste({ snap, line: 0, text: "- 甲\n- 乙\n\n- 丙" });
  assert(many.kind === "write", "多行粘贴要产生写入");
  if (many.kind === "write") {
    assert(linesOf(many.op).join("|") === "  甲|  乙|  丙", `多行 = 多个同级：${JSON.stringify(linesOf(many.op))}`);
  }

  // 3. 有序标记 / 标题 / 引用前缀都要剥掉：它们属于「源文档的结构」
  const dirty = svc.paste({ snap, line: 0, text: "## 标题\n1. 第一步\n> 引用来的话" });
  assert(dirty.kind === "write", "带结构标记的文本也能粘");
  if (dirty.kind === "write") {
    assert(linesOf(dirty.op).join("|") === "  标题|  第一步|  引用来的话", `结构标记被剥掉：${JSON.stringify(linesOf(dirty.op))}`);
  }

  // 4. 粘到更深的节点下面，缩进跟着那一层走
  const deep = svc.paste({ snap, line: 1, text: "孙" });
  assert(deep.kind === "write", "可以粘到任意节点下面");
  if (deep.kind === "write") {
    assert(linesOf(deep.op)[0] === "    孙", `缩进按目标节点算：${JSON.stringify(linesOf(deep.op))}`);
  }

  // 5. callout 里粘贴：每一行都要带 `> `，否则会跳出容器
  const co = "> [!note] 标题\n> 正文";
  const coParsed = parse(co);
  const coSvc = new EditService();
  const coOut = coSvc.paste({ snap: { content: co, ...coParsed }, line: 0, text: "甲\n乙" });
  assert(coOut.kind === "write", "callout 里能粘贴");
  if (coOut.kind === "write") {
    assert(linesOf(coOut.op).join("|") === "> 甲|> 乙", `callout 内保留引用前缀：${JSON.stringify(linesOf(coOut.op))}`);
  }

  // 6. 上限与空内容
  const bulk = Array.from({ length: PASTE_MAX_NODES + 5 }, (_v, i) => `第 ${i + 1} 行`).join("\n");
  const big = svc.paste({ snap, line: 0, text: bulk });
  assert(big.kind === "write" && big.notice !== undefined, "超长粘贴会提示只粘了多少");
  if (big.kind === "write") assert(linesOf(big.op).length === PASTE_MAX_NODES, `最多 ${PASTE_MAX_NODES} 行`);
  assert(svc.paste({ snap, line: 0, text: "   \n\n  " }).kind === "error", "空剪贴板是 error");
  assert(svc.paste({ snap, line: 0, text: "x" }).kind === "write", "正常文本不受影响");

  // 7. 块是只读叶子
  const blockContent = "父\n```js\nrun()\n```";
  const bp = parse(blockContent);
  const bk = bp.nodes.find((n) => n.blockNode !== undefined)!;
  assert(
    svc.paste({ snap: { content: blockContent, ...bp }, line: bk.line, text: "x" }).kind === "error",
    "块里不能粘节点",
  );
}

console.log("\n=== T29: 动作表（键位 / 相位 / 块 的判定都在纯函数里） ===");
{
  const base: ActionState = { phase: "idle", primary: 3, selectionSize: 1, onBlock: false, hasFile: true };
  const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  assert(matchAction(k("v", { ctrlKey: true }), "canvas", base) === "paste", "Ctrl+V → 粘贴");
  assert(matchAction(k("v", { metaKey: true }), "view", base) === "paste", "⌘+V 也认（归一化）");
  assert(matchAction(k("v", { ctrlKey: true }), "canvas", { ...base, phase: "editing" }) === null, "编辑中不接管粘贴");
  assert(
    matchAction(k("v", { ctrlKey: true }), "canvas", { ...base, onBlock: true }) === null,
    "块上不粘贴（只读叶子）",
  );
  assert(matchAction(k("v", { ctrlKey: true }), "canvas", { ...base, primary: -1 }) === null, "没选中不粘贴");
  assert(matchAction(k("v", { ctrlKey: true }), "canvas", { ...base, phase: "dragging" }) === null, "拖动中不粘贴");

  assert(matchAction(k("Tab"), "canvas", base) === "newChild", "Tab 建子级");
  assert(matchAction(k("Tab", { shiftKey: true }), "canvas", base) === "outdent", "Shift+Tab 提升（不和 Tab 撞）");
  assert(matchAction(k(" ", { code: "Space" }), "view", base) === "edit", "空格在视图层兜底");
  assert(matchAction(k("F2"), "canvas", base) === "edit", "F2 在画布层");
  assert(matchAction(k("Z", { ctrlKey: true, shiftKey: true }), "canvas", base) === "redo", "Ctrl+Shift+Z 重做");
  assert(matchAction(k("y", { ctrlKey: true }), "canvas", base) === "redo", "Ctrl+Y 也能重做");
  assert(matchAction(k("n", { ctrlKey: true }), "canvas", base) === null, "画布层不抢 Ctrl+N");
  assert(matchAction(k("n", { ctrlKey: true }), "view", base) === "newNote", "视图层接 Ctrl+N");

  // keyOf 的归一化边界
  assert(keyOf(k(" ")) === "space", "空格归一化");
  assert(keyOf(k("Escape")) === "esc", "Escape 归一化");
  assert(keyOf(k("ArrowUp")) === "up", "方向键归一化");
  assert(keyOf(k("v", { ctrlKey: true, metaKey: true })) === "mod+v", "Ctrl 与 ⌘ 都归成 mod");

  // 同一层不能有两条动作抢同一个键（以后加操作时最容易被破坏的约束）
  const dup: string[] = [];
  for (const scope of ["canvas", "view"] as const) {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      if (!a.scopes.includes(scope)) continue;
      for (const key of a.keys) {
        const prev: string | undefined = seen.get(key);
        if (prev !== undefined) dup.push(`${scope}:${key}(${prev}/${a.id})`);
        else seen.set(key, a.id);
      }
    }
  }
  assert(dup.length === 0, `同一层的键位不重复${dup.length ? "：" + dup.join(", ") : ""}`);

  // 缩放键：按物理键位归一（Shift+= 送来的是 "+"，小键盘是 Add）
  const eq = (key: string, mods: Partial<KeyLike> = {}): KeyLike => k(key, { code: "Equal", ...mods });
  const minus = (key: string, mods: Partial<KeyLike> = {}): KeyLike => k(key, { code: "Minus", ...mods });
  assert(matchAction(eq("=", { ctrlKey: true }), "canvas", base) === "zoomIn", "Ctrl+= 放大");
  assert(matchAction(eq("+", { ctrlKey: true, shiftKey: true }), "canvas", base) === "zoomIn", "Ctrl+Shift+= 也放大（键位相同）");
  assert(matchAction(minus("-", { ctrlKey: true }), "canvas", base) === "zoomOut", "Ctrl+- 缩小");
  assert(matchAction(k("0", { ctrlKey: true, code: "Digit0" }), "canvas", base) === "zoomFit", "Ctrl+0 归位");
  assert(
    matchAction(eq("=", { ctrlKey: true }), "canvas", { ...base, primary: -1 }) === "zoomIn",
    "没选中节点也能缩放（纯视口操作）",
  );
  assert(
    matchAction(eq("=", { ctrlKey: true }), "canvas", { ...base, phase: "editing" }) === null,
    "编辑中不抢 Ctrl+=（那是输入框 / Obsidian 的缩放）",
  );
}

console.log("\n=== T30: 滚轮 / 触摸板的语义判定（render/wheel.ts） ===");
{
  const wheel = (
    dx: number,
    dy: number,
    extra: Partial<WheelEventLike> = {},
  ): WheelEventLike => ({
    deltaX: dx,
    deltaY: dy,
    deltaMode: 0,
    ctrlKey: false,
    shiftKey: false,
    timeStamp: 1000,
    ...extra,
  });

  // 1. 鼠标一格一格：缩放（方向和 d3 一致，向下滚 = 缩小）
  const mouse = new WheelGesture();
  const inA = mouse.classify(wheel(0, -100), 800);
  assert(inA?.kind === "zoom" && inA.factor > 1, `鼠标上滚 = 放大：${JSON.stringify(inA)}`);
  assert(Math.abs((inA as { factor: number }).factor - Math.pow(2, 0.2)) < 1e-9, "一格 = 1.149 倍（2^0.2）");
  const outA = mouse.classify(wheel(0, 100, { timeStamp: 1040 }), 800);
  assert(outA?.kind === "zoom" && outA.factor < 1, `鼠标下滚 = 缩小：${JSON.stringify(outA)}`);
  assert(mouse.current === "zoom", "手势结论被记住");

  // 2. 回归 1.18.16 的 bug：Windows 的「每次滚动行数」可调，Chromium 按 行数×40 换算。
  //    早先只有 100 / 120 被判成鼠标，于是滚 1 行(40) / 4 行(160) 的机器上滚轮变平移。
  for (const px of [40, 53, 80, 120, 160, 200, 240]) {
    const g = new WheelGesture();
    const r = g.classify(wheel(0, -px), 800);
    assert(r?.kind === "zoom", `鼠标一格 ${px}px 必须缩放（不是平移）：${JSON.stringify(r)}`);
    // 倍率按格算，不按像素：不管一格多少像素，都是一格 1.149
    assert(
      Math.abs((r as { factor: number }).factor - Math.pow(2, 0.2)) < 1e-9,
      `${px}px/格 的倍率也要等于 1.149：${JSON.stringify(r)}`,
    );
  }
  // 「一格」是本次手势观测到的首个 |dy|，所以一次事件永远按一格算 —— 不管这个
  // 系统把一格定义成 40 还是 200。滚得快只会多发几个事件，倍率在调用方累乘。
  const big = new WheelGesture().classify(wheel(0, -200), 800);
  assert(
    big?.kind === "zoom" && Math.abs((big as { factor: number }).factor - Math.pow(2, 0.2)) < 1e-9,
    `200px/格 也只是一格：${JSON.stringify(big)}`,
  );

  // 3. 触摸板：小位移 → 平移，位移和 delta 反号（内容跟着手指走）
  for (const px of [1, 3, 7, 11, 13]) {
    const pad = new WheelGesture();
    const p1 = pad.classify(wheel(0, px), 800);
    assert(p1?.kind === "pan" && p1.dy === -px, `触摸板 ${px}px 下划 = 内容上移：${JSON.stringify(p1)}`);
    assert(pad.current === "pan", "判成触摸板");
  }

  // 3b. 快滑的第一格会够大（21px），先按鼠标缩放；第二格值一变就改判平移。
  //     这是刻意的取舍：宁可偶发一格缩放，也不让滚轮整体失效。
  const flick = new WheelGesture();
  flick.classify(wheel(0, 21), 800);
  assert(
    flick.classify(wheel(0, 18, { timeStamp: 1016 }), 800)?.kind === "pan",
    "快滑第二格不是整数倍 → 改判平移",
  );

  // 4. 横向分量是触摸板的强信号（哪怕纵向值够大）
  const pad2 = new WheelGesture();
  const p2 = pad2.classify(wheel(3, -60, { timeStamp: 1020 }), 800);
  assert(p2?.kind === "pan" && p2.dx === -3 && p2.dy === 60, `横向也平移：${JSON.stringify(p2)}`);

  // 5. 回归 1.18.17 的 bug：150% 显示缩放下鼠标一格 = 100 / 1.5 = 66.666…
  //    早先「整数」被当成鼠标的判据，于是这台机器的滚轮又被判成触摸板。
  // 单独的第一次事件永远只能算「一格」—— 没有历史就不知道基准是多少。
  // 「一次事件滚了两格」只能按手势内的第二格识别（见下面的 smooth）。
  for (const px of [66.66666666666667, 50, 33.333333333333336, 26.666666666666668]) {
    const g = new WheelGesture();
    const r = g.classify(wheel(0, -px), 800);
    assert(r?.kind === "zoom", `150% 缩放的一格 ${px}px 必须缩放：${JSON.stringify(r)}`);
    assert(
      Math.abs((r as { factor: number }).factor - Math.pow(2, 0.2)) < 1e-9,
      `${px}px = 一格 = 1.149：${JSON.stringify(r)}`,
    );
  }
  // 连续两格 66.666 和 133.333 都在同一手势里，不能被判成「不是整数倍」
  const smooth = new WheelGesture();
  assert(smooth.classify(wheel(0, 66.66666666666667), 800)?.kind === "zoom", "第一格缩放");
  assert(
    smooth.classify(wheel(0, 66.66666666666667, { timeStamp: 1060 }), 800)?.kind === "zoom",
    "第二格同值 → 仍是缩放",
  );
  const twoNotch = smooth.classify(wheel(0, 133.33333333333334, { timeStamp: 1120 }), 800);
  assert(twoNotch?.kind === "zoom", "滚了两格（2 倍 delta）→ 仍是缩放");
  assert(
    // 向下滚 = 缩小，所以是 2^-0.4
    Math.abs((twoNotch as { factor: number }).factor - Math.pow(2, -0.4)) < 1e-9,
    `两格 = 2^-0.4：${JSON.stringify(twoNotch)}`,
  );

  // 6. 手势内「zoom → pan」单向改判：触摸板的第一格可能又大又整
  const mixed = new WheelGesture();
  assert(mixed.classify(wheel(0, 100), 800)?.kind === "zoom", "第一格像鼠标 → 先按缩放");
  assert(mixed.classify(wheel(0, 9, { timeStamp: 1030 }), 800)?.kind === "pan", "第二格不像鼠标 → 整个手势改判平移");
  assert(mixed.current === "pan", "改判是单向的");
  assert(mixed.classify(wheel(0, 100, { timeStamp: 1060 }), 800)?.kind === "pan", "改判后不再反悔");

  // 7. 捏合 / Ctrl+滚轮：哪怕 delta 很小也要缩放
  const pinch = new WheelGesture();
  const z = pinch.classify(wheel(0, 4, { ctrlKey: true }), 800);
  assert(z?.kind === "zoom" && z.factor < 1, `捏合缩放：${JSON.stringify(z)}`);
  assert(pinch.classify(wheel(0, 4, { ctrlKey: true, timeStamp: 1016 }), 800)?.kind === "zoom", "捏合整段都要缩放");

  // 8. Shift+滚轮 = 横向平移（浏览器的通用语义）
  const shift = new WheelGesture();
  const s1 = shift.classify(wheel(0, 100, { shiftKey: true }), 800);
  assert(s1?.kind === "pan" && s1.dx === -100 && s1.dy === 0, `Shift+滚轮横移：${JSON.stringify(s1)}`);

  // 9. deltaMode 换算：行模式 ×16，页模式按视口高度
  assert(toPixels(3, 1, 800) === 48, "3 行 = 48px");
  assert(toPixels(1, 2, 800) === 720, "1 页 = 视口 90%");
  assert(toPixels(42, 0, 800) === 42, "像素模式原样");
  const lines = new WheelGesture();
  assert(lines.classify(wheel(0, 3, { deltaMode: 1 }), 800)?.kind === "zoom", "行模式是老式滚轮 → 缩放");

  // 10. 单次事件的倍率夹紧
  const clamp = new WheelGesture();
  const huge = clamp.classify(wheel(0, 100000), 800);
  assert(huge?.kind === "zoom" && huge.factor === 0.5, `巨大的 delta 不能把图甩飞：${JSON.stringify(huge)}`);

  // 11. 空位移不拦（有些设备会发 delta 全 0 的占位事件）
  assert(new WheelGesture().classify(wheel(0, 0), 800) === null, "没有位移就不接");

  // 12. 新手势重新判定：隔久了再来一格鼠标滚轮要恢复缩放
  const again = new WheelGesture();
  again.classify(wheel(0, 7), 800);
  assert(again.classify(wheel(0, -100, { timeStamp: 1600 }), 800)?.kind === "zoom", "隔了 600ms 算新手势");

  // 13. reset 清掉结论
  const rs = new WheelGesture();
  rs.classify(wheel(0, 7), 800);
  rs.reset();
  assert(rs.current === null, "reset 后没有结论");

  // 14. 形状判定本身
  for (const px of [40, 53, 80, 100, 120, 160, 200, 400]) {
    assert(looksLikeWheel(0, px, 0), `${px}px 是鼠标一格`);
    assert(looksLikeWheel(0, -px, 0), `${-px}px 也是（符号不影响）`);
  }
  for (const px of [1, 3, 7, 11, 13]) assert(!looksLikeWheel(0, px, 0), `${px}px 更像触摸板`);
  assert(looksLikeWheel(0, 37.5, 0), "小数不算触摸板（150% 缩放的鼠标就是小数）");
  assert(!looksLikeWheel(3, 100, 0), "带横向分量 → 触摸板");
  assert(looksLikeWheel(0, 1, 1), "行模式一定是鼠标");
  assert(looksLikeWheel(0, 1, 2), "页模式一定是鼠标");

  // 15. 设置里钉死语义：不再猜设备。形状判据永远只能覆盖大多数机器，
  //     这一档是「猜错了用户自己按一下」的出口。
  const pz = new WheelGesture();
  pz.setPin("zoom");
  assert(pz.classify(wheel(0, 7), 800)?.kind === "zoom", "强制缩放：触摸板的小值也缩放");
  assert(pz.classify(wheel(0, 3, { timeStamp: 1020 }), 800)?.kind === "zoom", "强制缩放不看形状");
  const pz2 = new WheelGesture();
  pz2.setPin("zoom");
  const pzr = pz2.classify(wheel(0, -66.66666666666667), 800);
  assert(
    pzr?.kind === "zoom" &&
      Math.abs((pzr as { factor: number }).factor - Math.pow(2, 0.2)) < 1e-9,
    `强制缩放仍按格算（150% 缩放也是一格 1.149）：${JSON.stringify(pzr)}`,
  );

  const pp = new WheelGesture();
  pp.setPin("pan");
  const ppr = pp.classify(wheel(0, -100), 800);
  assert(ppr?.kind === "pan" && ppr.dy === 100, `强制平移：鼠标一格也平移：${JSON.stringify(ppr)}`);
  assert(new WheelGesture().classify(wheel(0, -100), 800)?.kind === "zoom", "auto 档不受影响");

  // Ctrl / Shift 的优先级高于 pin：它们本身就是明确的意图
  const pp2 = new WheelGesture();
  pp2.setPin("pan");
  assert(
    pp2.classify(wheel(0, -4, { ctrlKey: true }), 800)?.kind === "zoom",
    "强制平移下 Ctrl+滚轮仍然缩放",
  );
  const pp3 = new WheelGesture();
  pp3.setPin("zoom");
  const sh = pp3.classify(wheel(0, -100, { shiftKey: true }), 800);
  assert(sh?.kind === "pan" && sh.dx === 100, `强制缩放下 Shift 仍然横移：${JSON.stringify(sh)}`);

  // 设置里读回来的是任意字符串，必须收敛
  assert(normalizeWheelPin("zoom") === "zoom", "认得 zoom");
  assert(normalizeWheelPin("pan") === "pan", "认得 pan");
  assert(normalizeWheelPin("auto") === "auto", "认得 auto");
  assert(normalizeWheelPin(undefined) === "auto", "旧的设置文件（没有这个字段）→ auto");
  assert(normalizeWheelPin("ZOOM") === "auto", "写错了就回 auto");

  // 16. 首格边沿：只有 auto 档**猜**出来的缩放才需要「先挂一帧」等第二格确认。
  //     边沿必须被取走，否则整段手势都白白延后一帧。
  const edge = new WheelGesture();
  assert(edge.takeFirstNotch() === false, "还没滚过，没有边沿");
  edge.classify(wheel(0, -100), 800);
  assert(edge.takeFirstNotch() === true, "首格像鼠标 → 有边沿（要先挂一帧）");
  assert(edge.takeFirstNotch() === false, "取走即清");
  edge.classify(wheel(0, -100, { timeStamp: 1060 }), 800);
  assert(edge.takeFirstNotch() === false, "同一手势的第二格不再有边沿");
  const edgePad = new WheelGesture();
  edgePad.classify(wheel(0, 3), 800);
  assert(edgePad.takeFirstNotch() === false, "判成平移没有可推翻的缩放，不需要挂起");
  const edgePin = new WheelGesture();
  edgePin.setPin("zoom");
  edgePin.classify(wheel(0, 3), 800);
  assert(edgePin.takeFirstNotch() === false, "钉死缩放时不用猜，不用挂起");

  // 17. 零位移事件（Windows 触摸板会把不足 1px 的位移 floor 成 0）必须**续上手势**。
  //     不续的话 GESTURE_GAP 一到就重新猜设备 —— 同一手势从中途从平移跳回缩放
  //     （轴锁下 deltaX 恒 0，快滑首格几乎必被猜成鼠标），用户看到的就是「一顿一跳」。
  const zeros = new WheelGesture();
  assert(zeros.classify(wheel(0, 3), 800)?.kind === "pan", "先判平移");
  for (let i = 1; i <= 30; i++) {
    assert(zeros.classify(wheel(0, 0, { timeStamp: 1000 + i * 10 }), 800) === null, "零位移不产生位移");
  }
  const afterZeros = zeros.classify(wheel(0, -40, { timeStamp: 1320 }), 800);
  assert(
    afterZeros?.kind === "pan",
    `30 个零事件之后仍是同一个手势，不能重新猜设备：${JSON.stringify(afterZeros)}`,
  );

  // 18. 反过来：空闲时收到零事件不能把 last 拉近，否则后面第一格会变成
  //     「非 fresh 但没有结论」，一路走到函数末尾被当成平移 —— 鼠标滚轮就不能缩放了。
  const idleZero = new WheelGesture();
  idleZero.classify(wheel(0, 0), 800);
  assert(idleZero.current === null, "空闲零事件不产生结论");
  assert(
    idleZero.classify(wheel(0, -100), 800)?.kind === "zoom",
    "空闲零事件之后的第一格仍然是新手势（缩放）",
  );
}

console.log(`\n========== ${failed === 0 ? "ALL PASS" : failed + " FAILED"} ==========`);if (failed > 0) process.exit(1);