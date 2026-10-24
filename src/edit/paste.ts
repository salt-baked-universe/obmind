/**
 * 「粘贴成子节点」的规划（纯函数，属于编辑层）。
 *
 * XMind 里 Ctrl+V 的手感：选中一个主题，粘上来的内容直接成为它的**子主题**，
 * 不弹输入框、不需要再确认。这里复刻的就是这条，但有一个必须自己决定的问题：
 * 一段多行文本到底算几个节点？
 *
 * 选择：**一行一个，全部同级**。
 * 不按源文本的缩进还原层级 —— 源文本的缩进体系和目标笔记不一定是一套
 * （tabs vs 空格、列表 vs 正文、甚至从网页复制来的是 4 空格伪缩进），
 * 猜错就会写出「层级结构是错的」笔记，而那种错比「层级平了」难发现得多。
 * 需要层级时先在源笔记整理好，或者粘完再拖 —— 拖是可视的、可撤销的。
 *
 * 第二个决定：剥掉行首的 Markdown 结构标记（`- ` / `1. ` / `# ` / `> `）。
 * 这些标记属于**源文档的结构**，不是节点的文字。带过来会出真实故障：
 * - `- abc` 叠在目标位置的 `- ` 后面 → 卡片文字变成「- abc」；
 * - `## abc` 落在一个 `###` 下面 → 层级和位置对不上，导图结构是错的；
 * - `> abc` 会被解析成「普通引用块」→ 直接变成一个块节点，粘进来的是图不是字。
 */

import type { SrcRef } from "../types";
import { planCreate, type CreateMode } from "./create";

/**
 * 一次粘贴最多建多少个节点。
 *
 * 不是性能限制（200 行的 span 写入一样是一瞬间），是**误操作上限**：
 * 剪贴板里躺着整篇文档时，Ctrl+V 会瞬间多出几百个子节点，撤销一次能回来，
 * 但那一下的心跳不值得。超出部分丢掉并在提示里说清楚。
 */
export const PASTE_MAX_NODES = 200;

export interface PasteInput {
  /** 剪贴板纯文本（可能是多行） */
  text: string;
  /** 粘到哪个节点下面 */
  src: SrcRef;
  nodes: readonly SrcRef[];
  step: number;
  unit: string;
  /** 默认 child —— Ctrl+V 的语义就是「成为子节点」 */
  mode?: CreateMode;
}

export interface PastePlan {
  /** 插在这一行之后（0 基），与 create 同一个坐标系 */
  insertAfterLine: number;
  /** 要插入的整行（已带缩进 / 列表标记 / 引用前缀） */
  lines: string[];
  /** 粘完选中哪一行：第一个新节点 */
  focusLine: number;
  /** 被跳过的空行数 */
  skipped: number;
  /** 因为超过上限而丢掉的行数 */
  dropped: number;
}

export type PasteResult = { ok: true; plan: PastePlan } | { ok: false; reason: string };

/**
 * 把一行剪贴板文本变成「节点的文字」。
 *
 * 只剥**一层**结构标记：`- [ ] 任务` → `[ ] 任务`（复选框是内容，留着），
 * `> - 内容` → `内容`。保留更多层会把本来就想显示的字也吃掉。
 */
function cleanLine(line: string): string {
  let s: string = line.trim();
  // 引用前缀先剥：`> - abc` 的 `- ` 在 `>` 里面
  s = s.replace(/^>\s?/, "");
  s = s.replace(/^(?:[-*+•]|\d{1,9}[.)])\s+/, "");
  s = s.replace(/^#{1,6}\s+/, "");
  return s.trim();
}

export function planPaste(input: PasteInput): PasteResult {
  const { src, nodes, step, unit } = input;
  const mode: CreateMode = input.mode ?? "child";

  // 块是只读叶子：它自己那几行是代码 / 引用原文，往里塞子节点等于破坏块内容
  if (src.blockNode) return { ok: false, reason: "块是只读叶子，不能往里粘节点" };

  const cleaned: string[] = input.text.split(/\r\n|\r|\n/).map(cleanLine);
  const texts: string[] = cleaned.filter((t: string) => t !== "");
  const skipped: number = cleaned.length - texts.length;
  if (texts.length === 0) {
    return { ok: false, reason: "剪贴板里没有可以当节点内容的文字" };
  }

  const dropped: number = Math.max(0, texts.length - PASTE_MAX_NODES);
  const use: string[] = texts.slice(0, PASTE_MAX_NODES);

  /**
   * 第一行交给 `planCreate`：缩进怎么加、列表标记怎么继承、标题怎么降级、
   * callout 里子级为什么不能再缩进 —— 这些规则只该有一份实现。
   * 这里贴完直接从结果里**切出前缀**复用给后续行，于是「新建」和「粘贴」
   * 永远不会写出两种不同风格的缩进。
   */
  const first = planCreate({ src, nodes, step, unit, mode, placeholder: use[0] });
  if (!first.ok) return { ok: false, reason: first.reason };

  const head: string = first.plan.line;
  const prefix: string = head.slice(0, head.length - use[0].length);
  const lines: string[] = [head];
  for (const text of use.slice(1)) lines.push(prefix + text);

  return {
    ok: true,
    plan: {
      insertAfterLine: first.plan.insertAfterLine,
      lines,
      // 第一行落在 insertAfterLine + 1（planCreate 就是这么算的）
      focusLine: first.plan.focusLine,
      skipped,
      dropped,
    },
  };
}
