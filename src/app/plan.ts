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
  /** 只改这一个节点的 DOM，布局交给 markmap 自己重排 */
  | { kind: "patch"; line: number; content: string }
  /** 必须 setData 重建整棵树 */
  | { kind: "structure" };

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
  if (input.forceStructure || input.prev === null) return { kind: "structure" };

  let changed = 0;
  let line = -1;
  let content = "";
  let structural = false;

  const walk = (a: IPureNode, b: IPureNode): void => {
    if (structural) return;

    if (a.content !== b.content) {
      const src = srcOf(b);
      // 根节点（文件名）与块节点（代码 / 公式）不参与原地改字
      if (!src || src.depth === 0) {
        structural = true;
        return;
      }
      changed++;
      if (changed > 1) {
        structural = true;
        return;
      }
      line = src.line;
      content = b.content;
    }

    const ac = a.children ?? [];
    const bc = b.children ?? [];
    if (ac.length !== bc.length) {
      structural = true;
      return;
    }

    for (let i = 0; i < ac.length; i++) {
      const sa = srcOf(ac[i]);
      const sb = srcOf(bc[i]);
      // 同一位置上必须还是同一行、同一层级。行号变了说明中间插删过行，
      // 深度变了说明缩进/标题级别动过——两者都是结构变化。
      if ((sa?.line ?? -1) !== (sb?.line ?? -1)) {
        structural = true;
        return;
      }
      if ((sa?.depth ?? -1) !== (sb?.depth ?? -1)) {
        structural = true;
        return;
      }
      walk(ac[i], bc[i]);
    }
  };

  walk(input.prev, input.next);

  if (structural) return { kind: "structure" };
  if (changed === 0) {
    // 树一样但原文不一样：块内容/空行变了，树上看不出来，只能重建
    return input.sourceSame ? { kind: "none" } : { kind: "structure" };
  }
  return { kind: "patch", line, content };
}
