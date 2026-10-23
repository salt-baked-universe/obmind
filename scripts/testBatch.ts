/**
 * 批量操作纯函数验证（moveNodes / removeGroup）。
 * 用真实解析器 buildTree 造节点坐标，断言整篇重写结果正确，不走 Obsidian。
 */
import { buildTree } from "../src/domain/syntax";
import { collectSrc } from "../src/edit/move";
import { moveNode, moveNodes } from "../src/edit/move";
import { blockRange } from "../src/edit/move";
import { EditService } from "../src/app/EditService";
import { nodeBarPosition } from "../src/ui/nodeBarPosition";
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

console.log(`\n========== ${failed === 0 ? "ALL PASS" : failed + " FAILED"} ==========`);if (failed > 0) process.exit(1);