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
import { indentBy, parseEditorValue, rewriteNode } from "../edit/text";
import { moveNode } from "../edit/move";

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

export interface RemoveInput {
  snap: EditSnapshot;
  /** 要删的节点所在行 */
  line: number;
}

export class EditService {
  /** 找一个节点的源坐标（新节点插入位置要用全部节点才能算子树范围） */
  nodeAt(snap: EditSnapshot, line: number): SrcRef | null {
    return snap.nodes.find((n) => n.line === line) ?? null;
  }

  /**
   * 编辑框结束：改字 / 缩进 / 新建同级 / 删除。
   *
   * 其中「新建同级」是最容易写错的一条：新行不能插在下一行，而要插在
   * **整棵子树之后**。父节点有孩子时，下一行是它的第一个孩子 ——
   * 插在那里会被缩进规则判成孩子，越加越深。
   */
  commit(input: CommitInput): EditOutcome {
    const { snap, src, action, value } = input;
    if (action === "cancel") return none("已取消");

    const parsed = parseEditorValue(src, value);
    // 只有「退格清空」才删行；否则空文本一律视为放弃修改。
    // 笔记里一行就是一条内容，误删比改不动代价大得多。
    if (parsed.text === "" && action !== "delete") return none("空文本不写入");

    if (action === "delete") {
      // 编辑框被清空后按退格 = 删掉这个节点。
      // 有子节点时一并删掉整棵子树：孩子失去父节点后层级会塌，留着只会变成
      // 一堆挂到上一层的孤儿，用户还得手工收拾。
      return { kind: "write", op: this.removeOp(snap, src) };
    }

    if (action === "sibling") {
      // 注意不要用 parsed.text 当新节点的文本：编辑框里敲的是**当前节点**的新名字，
      // 新节点是另一条内容，用占位文本，写完立刻进编辑框让用户输入。
      const plan = planCreate({
        src,
        nodes: snap.nodes,
        step: snap.step,
        unit: snap.unit,
        mode: "sibling",
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
   * 删除节点（画布上按 Delete/Backspace）。
   *
   * 删的是**整棵子树**：一行 + 它下面所有更深缩进的行。只删一行的话，
   * 子节点会失去父节点、被缩进规则挂到更上层，导图结构在用户眼里就乱了。
   */
  remove(input: RemoveInput): EditOutcome {
    const src = this.nodeAt(input.snap, input.line);
    if (!src) return error("找不到要删除的节点");
    if (src.depth === 0) return error("根节点是笔记本身，删不了");
    return { kind: "write", op: this.removeOp(input.snap, src) };
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

  /**
   * 删除用的行区间：从该行到子树最后一行。
   *
   * 首尾都要锚定：跨越多行时，中间任何一行被外部改过，写入都必须放弃，
   * 否则会拿旧内容覆盖用户刚敲的字。
   */
  private removeOp(snap: EditSnapshot, src: SrcRef): WriteOp {
    const end: number = subtreeEndOf(src, snap.nodes);
    const lines: string[] = snap.content.split("\n");
    const span: Span = {
      start: src.line,
      end: end + 1,
      lines: [],
      checkLine: src.line,
      checkText: src.full,
      checkEnd:
        end > src.line ? { line: end, text: lines[end] ?? "" } : undefined,
    };
    return { kind: "span", span };
  }
}
