/**
 * 解析入口（组装层）。
 *
 * 实际实现已经拆开：
 * - 结构解析 → `domain/syntax.ts`（纯函数，不认识 HTML）
 * - 行内渲染 → `render/inlineHtml.ts`（字符串到字符串）
 *
 * 这里只剩两件事：
 * 1. 把 renderInline 注入给 buildTree —— domain 层不认识表现层，靠注入接线；
 * 2. 重新导出，让调用方不必关心内部拆成了几个文件。
 *
 * 依赖方向：parser → domain + render，反过来不行。
 */

import type { IPureNode } from "markmap-common";
import { buildTree as buildTreeCore } from "./domain/syntax";
import { renderInline } from "./render/inlineHtml";
import type { ParseOptions } from "./types";

export type { SrcRef, BlockInfo, ParseOptions } from "./types";
export type { BuildTreeOptions } from "./domain/syntax";
export { colsOfIndent, indentOfCols, detectIndent, collectBlocks } from "./domain/syntax";
export { renderInline } from "./render/inlineHtml";

/**
 * 构建节点树：结构解析 + 行内 HTML 渲染。
 *
 * 只在这个组装层把两者接起来，domain 内部拿到的 render 是参数而非 import，
 * 所以 domain 可以在 Node 里独立跑用例。
 */
export function buildTree(
  content: string,
  fileName: string,
  options: ParseOptions = {},
): IPureNode {
  return buildTreeCore(content, fileName, { ...options, render: renderInline });
}
