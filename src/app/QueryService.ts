/**
 * 读路径（L4 app / 查询侧）。
 *
 * 「读」和「写」在这里被彻底分开：
 * - 读：内容 → 节点树 → 只读快照（本文件）
 * - 写：意图 → 写入计划（EditService）
 *
 * 分开的好处很实际：读路径的每一步都是无副作用的，所以可以反复跑、
 * 可以拿旧快照和新快照比对（planProjection 就是干这个的）；
 * 而写路径永远只有「产出一个 op」这一个出口，不存在半个写入状态。
 *
 * 文件读取本身仍是 IO，通过构造参数注入 —— 这一层不认识 vault，也不认识编辑器。
 */

import type { IPureNode } from "markmap-common";
import { buildTree } from "../parser";
import type { ParseOptions, SrcRef } from "../types";

/** 读文件的方式，由视图层注入（vault.read / 编辑器缓冲） */
export type ContentReader = (path: string) => Promise<string>;

/** 一次读取 + 解析的结果。只读，可以在多次投影之间留存比对 */
export interface LoadedDoc {
  content: string;
  tree: IPureNode;
  /** 全部节点源坐标，按行升序 —— 新建节点算子树范围要用 */
  nodes: SrcRef[];
  /** 检测到的缩进步长（列数） */
  step: number;
  /** 缩进单位原文（可能是制表符） */
  unit: string;
  /** 这篇笔记是否用标题表达层级 */
  hasHeadings: boolean;
}

/** 收集全部带源坐标的节点，按行升序 */
function collectSrcRefs(root: IPureNode): SrcRef[] {
  const out: SrcRef[] = [];
  const walk = (n: IPureNode): void => {
    const src = n.payload?.src as SrcRef | undefined;
    if (src && typeof src.line === "number") out.push(src);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out.sort((a: SrcRef, b: SrcRef) => a.line - b.line);
}

function payloadOf(tree: IPureNode): { step: number; unit: string; hasHeadings: boolean } {
  const p = tree.payload as
    | { step?: unknown; indentUnit?: unknown; hasHeadings?: unknown }
    | undefined;
  return {
    step: typeof p?.step === "number" && p.step > 0 ? p.step : 2,
    unit: typeof p?.indentUnit === "string" && p.indentUnit !== "" ? p.indentUnit : "  ",
    hasHeadings: p?.hasHeadings === true,
  };
}

export class QueryService {
  constructor(private readonly read: ContentReader) {}

  /** 只解析，不读文件（内容已经在手上时用，比如刚写完的 buffer） */
  parse(content: string, basename: string, options: ParseOptions = {}): LoadedDoc {
    const tree = buildTree(content, basename, options);
    const meta = payloadOf(tree);
    return {
      content,
      tree,
      nodes: collectSrcRefs(tree),
      step: meta.step,
      unit: meta.unit,
      hasHeadings: meta.hasHeadings,
    };
  }

  /** 读文件再解析 */
  async load(
    path: string,
    basename: string,
    options: ParseOptions = {},
  ): Promise<LoadedDoc> {
    const content: string = await this.read(path);
    return this.parse(content, basename, options);
  }
}
