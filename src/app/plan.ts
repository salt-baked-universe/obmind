/**
 * 投影判定：一次内容变化该走哪条绘制通道。
 *
 * 这件事以前是人在 MindmapView 里随口判断的（「内容没变就 return，否则全部重建」），
 * 结果就是每敲一个字都要 setData 重建整棵树。而 markmap 的节点 key 是
 *
 *     state.key = 父id.子id + hash(content)
 *
 * 内容一变，key 就全变，d3 会把整棵树当成新节点重新 enter —— 节点的
 * foreignObject、内容 DOM、代码高亮、公式全部重来一遍。这才是打字发滞的根本原因。
 *
 * 所以真正的判据不是「内容变了没有」，而是「**结构**变了没有」：
 * - 结构没变、只改了一处文字 → 直接改那个节点的 DOM，让 markmap 自己的
 *   ResizeObserver（100ms 防抖）去重排。不用 setData，key 保持稳定，不重建 DOM。
 * - 结构变了（增删、拖动、层级变化、换笔记、换主题）→ 只能 setData 全量重建。
 *
 * 这个判定是纯函数，不碰 DOM，可以单独跑用例。
 */

import type { IPureNode } from "markmap-common";
import type { SrcRef } from "../types";

export type Projection =
  /** 什么都不用画 */
  | { kind: "none" }
  /**
   * 只改这一个节点的 DOM，布局交给 markmap 自己重排。
   *
   * `src` 是**新树**里那个节点的源坐标，必须一起带出去：
   * patch 通道不动 markmap 的数据，DOM 里 `__data__.payload.src` 还停在旧文字上，
   * 而编辑框的初始内容、右键菜单、拖动落点用的都是它。不写回去，症状就是
   * 「节点上明明是刚输入的内容，点开编辑却显示上一次的旧文本」。
   */
  | { kind: "patch"; line: number; content: string; src: SrcRef }
  /** 必须 setData 重建整棵树 */
  | { kind: "structure"; reason: StructureReason; at?: number };

/**
 * 「为什么必须重建」。
 *
 * 这不是给用户看的，是给日志看的：只要有一条日志写着
 * `refresh.plan kind=structure why=depth`，就知道「明明只改了一个字」为什么
 * 变成了一次 setData（250 节点要 400–550ms，就是那一下卡顿/闪烁）。
 * 没有它，只能靠猜 —— 而猜错过。
 */
export type StructureReason =
  /** 换笔记 / 换主题 / 首次渲染 */
  | "force"
  /** 变化的节点是根（文件名）或块节点（没有源坐标） */
  | "noSrc"
  /** 一次变了好几个节点 */
  | "multi"
  /** 孩子数量变了 */
  | "children"
  /** 行号位移（中间插删过行） */
  | "line"
  /** 深度变了（缩进 / 标题级别动过） */
  | "depth"
  /** 树一样但原文不一样：块内容或空行变了 */
  | "blockOnly";

export interface PlanInput {
  /** 上一次投影用的树；null 表示首次渲染 */
  prev: IPureNode | null;
  next: IPureNode;
  /** 换笔记 / 换主题 —— 与内容无关，一律重建 */
  forceStructure: boolean;
  /**
   * 原文是否与上次逐字符相同。
   *
   * 树只承载「渲染后的 content」，而代码块 / 公式块节点存的是占位文案
   * （`代码块 · js · 3 行`），不含块里的代码。所以块里改一个字，
   * 两棵树会完全一样 —— 只看树会把这种情况漏判成「没变化」，视图就不刷新了。
   */
  sourceSame: boolean;
}

function srcOf(node: IPureNode | undefined): SrcRef | null {
  if (!node) return null;
  const payload = node.payload as { src?: SrcRef } | undefined;
  const src = payload?.src;
  return src && typeof src.line === "number" ? src : null;
}

/**
 * 比较两棵树，判断能否走原地改字。
 *
 * 只有同时满足这些条件才算「纯文字变化」：
 * 1. 树形完全一致（每个位置的节点对应同一源行、同一深度）；
 * 2. 恰好一个节点的 content 变了；
 * 3. 该节点有源坐标（块节点、根节点都没有，必须重建）。
 *
 * 宁可判定得保守一点——多重建一次只是慢，错判会画出与内容不符的图。
 */
export function planProjection(input: PlanInput): Projection {
  if (input.forceStructure || input.prev === null) {
    return { kind: "structure", reason: "force" };
  }

  let changed = 0;
  let line = -1;
  let content = "";
  let patchSrc: SrcRef | null = null;
  let why: StructureReason | null = null;
  let at: number | undefined;

  const walk = (a: IPureNode, b: IPureNode): void => {
    if (why !== null) return;

    if (a.content !== b.content) {
      const src = srcOf(b);
      // 根节点（文件名）与块节点（代码 / 公式）不参与原地改字
      if (!src || src.depth === 0) {
        why = "noSrc";
        at = src?.line ?? srcOf(a)?.line;
        return;
      }
      changed++;
      if (changed > 1) {
        why = "multi";
        at = src.line;
        return;
      }
      line = src.line;
      content = b.content;
      patchSrc = src;
    }

    const ac = a.children ?? [];
    const bc = b.children ?? [];
    if (ac.length !== bc.length) {
      why = "children";
      at = srcOf(b)?.line;
      return;
    }

    for (let i = 0; i < ac.length; i++) {
      const sa = srcOf(ac[i]);
      const sb = srcOf(bc[i]);
      // 同一位置上必须还是同一行、同一层级。行号变了说明中间插删过行，
      // 深度变了说明缩进/标题级别动过——两者都是结构变化。
      if ((sa?.line ?? -1) !== (sb?.line ?? -1)) {
        why = "line";
        at = sb?.line ?? sa?.line;
        return;
      }
      if ((sa?.depth ?? -1) !== (sb?.depth ?? -1)) {
        why = "depth";
        at = sb?.line ?? sa?.line;
        return;
      }
      walk(ac[i], bc[i]);
    }
  };

  walk(input.prev, input.next);

  if (why !== null) return { kind: "structure", reason: why, at };
  if (changed === 0) {
    // 树一样但原文不一样：块内容/空行变了，树上看不出来，只能重建
    return input.sourceSame
      ? { kind: "none" }
      : { kind: "structure", reason: "blockOnly" };
  }
  return patchSrc
    ? { kind: "patch", line, content, src: patchSrc }
    : { kind: "structure", reason: "noSrc", at: line };
}

/**
 * 说清楚两棵树差在哪 —— 只给日志用。
 *
 * `why` 只回答「哪一类原因」，但「改一个字为什么会被判成深度变了」还得看见
 * 具体的行号与文字。这条日志一次就能定位，省掉一轮「再复现一次、再看日志」。
 *
 * 只在 trace 开着时调用（它要遍历整棵树并剥 HTML 标签）。
 */
export function explainDiff(prev: IPureNode, next: IPureNode, limit = 6): string[] {
  const out: string[] = [];
  const text = (n: IPureNode): string => {
    const raw: string = String(n.content ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return raw.slice(0, 8) || "?";
  };

  const walk = (a: IPureNode, b: IPureNode, path: string): void => {
    if (out.length >= limit) return;
    const sa = srcOf(a);
    const sb = srcOf(b);

    if (a.content !== b.content) {
      out.push(`${path || "root"} content "${text(a)}"->"${text(b)}"`);
    }
    if ((sa?.line ?? -1) !== (sb?.line ?? -1)) {
      out.push(`${path || "root"} line ${sa?.line ?? -1}->${sb?.line ?? -1} "${text(b)}"`);
    }
    if ((sa?.depth ?? -1) !== (sb?.depth ?? -1)) {
      out.push(`${path || "root"} depth ${sa?.depth ?? -1}->${sb?.depth ?? -1} "${text(b)}"`);
    }

    const ac = a.children ?? [];
    const bc = b.children ?? [];
    if (ac.length !== bc.length) {
      out.push(`${path || "root"} children ${ac.length}->${bc.length} "${text(b)}"`);
      return;
    }
    for (let i = 0; i < ac.length && out.length < limit; i++) {
      walk(ac[i], bc[i], `${path}.${i}`);
    }
  };

  walk(prev, next, "");
  return out;
}
