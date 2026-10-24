/**
 * 编辑用例层（L4 app）。
 *
 * 这一层的唯一职责是**把意图翻译成写入计划**：
 *
 *     编辑框提交 / 按 Tab 新建 / 拖动落位
 *              ↓
 *          EditOutcome { op: WriteOp, focusLine }
 *              ↓
 *     （视图层交给 writer 执行）
 *
 * 它刻意不做三件事：
 * - 不读文件：快照由调用方准备好传进来；
 * - 不写文件：只产出 WriteOp，写失败的提示归 writer/视图；
 * - 不碰 DOM：不 import obsidian，也不认识 markmap。
 *
 * 于是「改一个字到底该改哪几行」这件事可以在 Node 里直接断言，
 * 不用启动 Obsidian、不用点开编辑框。
 */

import type { DropMode, EditorAction, SrcRef, Span, WriteOp } from "../types";
import { planCreate, subtreeEndOf, type CreateMode } from "../edit/create";
import { insertBlockPlan, type BlockKind } from "../edit/block";
import { indentBy, parseEditorValue, rewriteNode } from "../edit/text";
import { moveNode, moveNodes, blockRange } from "../edit/move";

/** 一次操作的输入快照：只读，由读路径产出 */
export interface EditSnapshot {
  /** 整篇原文 */
  content: string;
  /** 全部节点的源坐标，按行升序 */
  nodes: readonly SrcRef[];
  /** 缩进步长（列数） */
  step: number;
  /** 缩进单位原文（可能是制表符） */
  unit: string;
}

/** 用例的输出：写什么、写完之后把光标落到哪 */
export type EditOutcome =
  /** 需要写入 */
  | { kind: "write"; op: WriteOp; focusLine?: number }
  /** 无需写入，且不是错误（内容没变、空文本、主动取消） */
  | { kind: "none"; reason: string }
  /** 做不了，要提示用户（层级到顶、找不到节点、移动不合法） */
  | { kind: "error"; reason: string };

const none = (reason: string): EditOutcome => ({ kind: "none", reason });
const error = (reason: string): EditOutcome => ({ kind: "error", reason });

/** 单行改写：最常见的一种写入；跨多行时用 end 指定替换范围 */
function lineOp(
  src: SrcRef,
  lines: string[],
  opts: { end?: number; checkEnd?: Span["checkEnd"] } = {},
): WriteOp {
  return {
    kind: "span",
    span: {
      start: src.line,
      end: opts.end ?? src.line + 1,
      lines,
      checkLine: src.line,
      checkText: src.full,
      checkEnd: opts.checkEnd,
    },
  };
}

export interface CommitInput {
  snap: EditSnapshot;
  /** 编辑的是哪一行（编辑框打开时记下的坐标，可能就是旧的） */
  src: SrcRef;
  action: EditorAction;
  /** 编辑框里的文本 */
  value: string;
}

export interface CreateInput {
  snap: EditSnapshot;
  /** 以哪一行节点为基准 */
  line: number;
  mode: CreateMode;
}

export interface MoveInput {
  snap: EditSnapshot;
  srcLine: number;
  targetLine: number;
  mode: DropMode;
}

export interface MoveGroupInput {
  snap: EditSnapshot;
  /** 要整体移动的源节点行号（多个） */
  srcLines: number[];
  targetLine: number;
  mode: DropMode;
}

export interface RemoveGroupInput {
  snap: EditSnapshot;
  /** 要删除的节点行号（多个，可含嵌套）；重叠范围会自动合并 */
  lines: number[];
}

export interface InsertBlockInput {
  snap: EditSnapshot;
  /** 把块挂到哪个节点上（宿主行号） */
  line: number;
  kind: BlockKind;
}

export class EditService {
  /** 找一个节点的源坐标（新节点插入位置要用全部节点才能算子树范围） */
  nodeAt(snap: EditSnapshot, line: number): SrcRef | null {
    return snap.nodes.find((n) => n.line === line) ?? null;
  }

  /**
   * 编辑框结束：改字 / 缩进 / 新建同级 / 新建子级 / 删除。
   *
   * 其中「新建同级 / 子级」最容易写错的一条：新行不能插在下一行，而要插在
   * **整棵子树之后**。父节点有孩子时，下一行是它的第一个孩子 ——
   * 插在那里会被缩进规则判成孩子，越加越深。
   */
  commit(input: CommitInput): EditOutcome {
    const { snap, src, action, value } = input;
    if (action === "cancel") return none("已取消");

    const parsed = parseEditorValue(src, value);

    // 文本被清空 = 放弃这次修改，节点原样留着。
    //
    // 这里踩过两次坑，结论是**编辑框永远不产出结构变化**：
    // 先是「空文本一律放弃」被当成 bug（字删完了节点还在）；改成「清空即删节点」，
    // 又把「改字」和「删结构」混在了一起 —— 全选想重打一行，回车的那一刻节点
    // 连整棵子树一起没了。删除只属于「没在编辑、画布上选中」的状态
    // （画布 Delete / Backspace → removeGroup），编辑框里退格就只是退格。
    if (parsed.text === "") return none("文本为空，保持原样");

    if (action === "sibling" || action === "child") {
      // 注意不要用 parsed.text 当新节点的文本：编辑框里敲的是**当前节点**的新名字，
      // 新节点是另一条内容，用占位文本，写完立刻进编辑框让用户输入。
      //
      // 同级与子级走同一条拼装路径，只有「新行插在哪、缩进几层」不同（planCreate 决定）：
      // 两者都是「改当前行 + 在某个位置插一行」，区别只是插入点。
      const plan = planCreate({
        src,
        nodes: snap.nodes,
        step: snap.step,
        unit: snap.unit,
        mode: action,
      });
      if (!plan.ok) return error(plan.reason);

      const at: number = plan.plan.insertAfterLine;
      const newLine: string = plan.plan.line;
      const rewritten: string = rewriteNode(src, parsed.text, parsed.checked);

      // 没有子节点：一行换两行，最省事
      if (at === src.line) {
        return {
          kind: "write",
          op: lineOp(src, [rewritten, newLine]),
          focusLine: src.line + 1,
        };
      }

      // 有子节点：一次跨整棵子树的替换。中间行原样带过去，
      // 并用尾锚点确保它们没被改过（否则会把用户的新改动覆盖回去）。
      const lines: string[] = snap.content.split("\n");
      const middle: string[] = lines.slice(src.line + 1, at + 1);
      return {
        kind: "write",
        op: lineOp(src, [rewritten, ...middle, newLine], {
          end: at + 1,
          checkEnd: { line: at, text: lines[at] ?? "" },
        }),
        focusLine: at + 1,
      };
    }

    if (action === "indent" || action === "outdent") {
      const nextIndent: string | null = indentBy(
        src,
        action === "indent" ? 1 : -1,
        snap.step,
      );
      if (nextIndent === null) return none("已经在最外层，无法再减少缩进");
      return {
        kind: "write",
        op: lineOp(src, [rewriteNode(src, parsed.text, parsed.checked, nextIndent)]),
      };
    }

    // 普通提交：内容没变就别写文件，省掉一次无谓的重建
    if (parsed.text === src.text && parsed.checked === src.checked) {
      return none("内容没有变化");
    }
    return {
      kind: "write",
      op: lineOp(src, [rewriteNode(src, parsed.text, parsed.checked)]),
    };
  }

  /**
   * 新建节点（Tab 建子级 / Enter 建同级）。
   *
   * 层级规则交给 create.ts：标题体系降一级标题，正文体系多缩进一个步长。
   */
  create(input: CreateInput): EditOutcome {
    const src = this.nodeAt(input.snap, input.line);
    if (!src) return error("找不到要新建的节点");

    const plan = planCreate({
      src,
      nodes: input.snap.nodes,
      step: input.snap.step,
      unit: input.snap.unit,
      mode: input.mode,
    });
    if (!plan.ok) return error(plan.reason);

    const at: number = plan.plan.insertAfterLine;
    const lines: string[] = input.snap.content.split("\n");
    const span: Span = {
      // start === end 表示「插在这一行之前」，所以 at + 1 才是「at 之后」
      start: at + 1,
      end: at + 1,
      lines: [plan.plan.line],
      checkLine: at,
      checkText: lines[at] ?? "",
    };
    return { kind: "write", op: { kind: "span", span }, focusLine: plan.plan.focusLine };
  }

  /**
   * 拖动改层级。
   *
   * 必须整篇重写：一行会被搬到很远的位置，中间所有行号都会变，
   * 用行区间替换表达不了。拆成「先删后插」两次写入也不行 ——
   * 中间那一瞬间笔记是坏的（节点丢一半）。
   */
  move(input: MoveInput): EditOutcome {
    const res = moveNode({
      lines: input.snap.content.split("\n"),
      nodes: [...input.snap.nodes],
      step: input.snap.step,
      unit: input.snap.unit,
      srcLine: input.srcLine,
      targetLine: input.targetLine,
      mode: input.mode,
    });
    if (!res.ok) return error(res.reason);

    return {
      kind: "write",
      op: {
        kind: "whole",
        content: res.lines.join("\n"),
        expect: input.snap.content,
      },
    };
  }

  /**
   * 整体移动一组节点（框选后整体拖动）。
   *
   * 与单节点 move 一样整篇重写：一次移动多块，中间任何瞬间都不该出现「半截笔记」。
   */
  moveGroup(input: MoveGroupInput): EditOutcome {
    const res = moveNodes({
      lines: input.snap.content.split("\n"),
      nodes: [...input.snap.nodes],
      step: input.snap.step,
      unit: input.snap.unit,
      srcLines: input.srcLines,
      targetLine: input.targetLine,
      mode: input.mode,
    });
    if (!res.ok) return error(res.reason);

    return {
      kind: "write",
      op: {
        kind: "whole",
        content: res.lines.join("\n"),
        expect: input.snap.content,
      },
    };
  }

  /**
   * 删除节点（画布上按 Delete/Backspace）。
   *
   * 删的是**整棵子树**：一行 + 它下面所有更深缩进的行。只删一行的话，
   * 子节点会失去父节点、被缩进规则挂到更上层，导图结构在用户眼里就乱了。
   *
   * 这是**唯一的删除入口**：编辑框不产出删除（见 commit 里的说明）。
   *
   * @returns focusLine 删完之后该选中的行 —— 父节点。父节点在删除区间之前，
   *          行号不受这次写入影响，可以原样用来恢复选中框。
   */
  removeGroup(input: RemoveGroupInput): EditOutcome {
    const nodes = [...input.snap.nodes];
    const lines: string[] = input.snap.content.split("\n");

    // 收集每棵子树的范围（含自身到末代）
    const ranges: Array<[number, number]> = [];
    for (const ln of input.lines) {
      const idx = nodes.findIndex((n) => n.line === ln);
      if (idx < 0) continue;
      const src = nodes[idx];
      if (src.depth === 0) continue; // 根节点不可删
      const r = blockRange(nodes, idx);
      ranges.push([r.start, r.end]);
    }
    if (ranges.length === 0) return error("没有可删除的节点");

    // 按起点升序合并重叠/相邻区间
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], r[1]);
      } else {
        merged.push([r[0], r[1]]);
      }
    }

    const removeSet = new Set<number>();
    for (const [s, e] of merged) {
      for (let i = s; i <= e; i++) removeSet.add(i);
    }
    const newLines: string[] = lines.filter((_, i) => !removeSet.has(i));
    if (newLines.join("\n") === lines.join("\n")) return none("内容没有变化");

    // 删完把选中交给父节点：最早的被删节点往上找一层。它一定在删除区间之前
    // （若它也被选中，区间会从它开始，它就不会是「最早的那个」），
    // 所以行号不受影响，删完直接用它恢复选中框，用户能接着按 Delete 连删。
    //
    // 顶层节点没有可选中的父节点（根是文件名，不能选也不能删），退一步选
    // 「落在删除位置上」的那个节点 —— 效果是选中下一个兄弟。不这么做的话，
    // 删掉顶层节点后选中框会直接消失，用户以为是「删完就断了」。
    const firstRemoved: number = merged[0][0];
    const parentLine: number = this.parentLineOf(input.snap, firstRemoved);
    const nextLine: number = newLines.length > firstRemoved ? firstRemoved : -1;
    const focusLine: number = parentLine >= 0 ? parentLine : nextLine;

    return {
      kind: "write",
      op: {
        kind: "whole",
        content: newLines.join("\n"),
        expect: input.snap.content,
      },
      focusLine: focusLine >= 0 ? focusLine : undefined,
    };
  }

  /**
   * 在选中节点下面插入一个块（代码 / 引用 / 表格）。
   *
   * 插入位置在「节点自己那几行之后、子节点之前」，不是子树末尾 ——
   * 块归「前一个节点」，插到末尾就归给了最后一个后代。
   *
   * 写完之后选中框仍留在原节点上（不是新块）：块不是节点，没有行可以选；
   * 而且用户接下来多半还想接着操作这个节点。
   */
  insertBlock(input: InsertBlockInput): EditOutcome {
    const src = this.nodeAt(input.snap, input.line);
    if (!src) return error("找不到要插入块的节点");

    const plan = insertBlockPlan({ src }, input.kind);
    const lines: string[] = input.snap.content.split("\n");
    const at: number = plan.insertAfterLine;
    const span: Span = {
      // start === end 表示「插在这一行之前」，所以 at + 1 才是「at 之后」
      start: at + 1,
      end: at + 1,
      lines: plan.lines,
      checkLine: at,
      checkText: lines[at] ?? "",
    };
    return { kind: "write", op: { kind: "span", span }, focusLine: src.line };
  }

  /** 某个节点在树里的父节点行号；根节点返回 -1（删完用它把选中挪过去） */
  parentLineOf(snap: EditSnapshot, line: number): number {
    const src = this.nodeAt(snap, line);
    if (!src || src.depth === 0) return -1;
    let best = -1;
    // nodes 按行升序，最后一个「在它之前且更浅」的就是父节点
    for (const n of snap.nodes) {
      if (n.line >= src.line) break;
      if (n.depth < src.depth) best = n.line;
    }
    return best;
  }

  /** 要删掉这个节点一共占几行（含自己） */
  subtreeSize(snap: EditSnapshot, line: number): number {
    const src = this.nodeAt(snap, line);
    if (!src) return 0;
    return subtreeEndOf(src, snap.nodes) - src.line + 1;
  }
}
