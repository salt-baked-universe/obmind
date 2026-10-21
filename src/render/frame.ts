/**
 * 绘制帧调度：把同一帧内的多次重绘请求合并成一次。
 *
 * 从 MindmapView 搬出来的（原来叫 requestPaint / paintAllSync，外加三个字段
 * paintFrame / paintMode / paintPaths）。搬出来的理由很实在：每次折叠动画都会
 * 每帧触发一次 MutationObserver，这些请求必须按帧合并，否则 60fps 下每秒会
 * 重算几十次全部连线路径。
 *
 * 两种模式：
 * - all   全量（卡片 + 连线），结构变化、尺寸变化时用；
 * - links 只刷连线，节点位移时用（卡片画在节点局部坐标里，跟位移无关）。
 *
 * 还有一条硬规则：**重建导图期间不画**。那时候 DOM 是半成品，画出来必然是错的，
 * 重建结束后由 paintNow() 在同一帧内一次性补上。
 */

import type { ThemeSpec } from "../theme";
import type { NodePainter } from "./painter";

export interface FrameSource {
  svg: () => SVGSVGElement | null;
  spec: () => ThemeSpec | null;
  /** 返回 true 表示当前 DOM 不可信（重建中），本帧跳过 */
  blocked: () => boolean;
}

export class FrameScheduler {
  private frame = 0;
  private mode: "all" | "links" = "links";
  private paths = new Set<string>();

  constructor(
    private readonly painter: NodePainter,
    private readonly source: FrameSource,
  ) {}

  /**
   * 请求一次绘制。
   * @param paths 本帧发生位移的节点 path；只有 links 模式且非空时才做定向更新
   */
  request(mode: "all" | "links", paths?: Set<string>): void {
    if (this.source.blocked()) return;

    if (mode === "all") {
      this.mode = "all";
      this.paths.clear();
    } else if (this.mode !== "all" && paths !== undefined) {
      for (const path of paths) this.paths.add(path);
    }

    if (this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  /**
   * 立刻同步画一遍全量，不等 rAF。
   *
   * 重建之后必须抢在浏览器绘制这一帧之前把卡片和连线摆正，
   * 否则会先播出一帧「新位置的节点 + 旧父节点的连线」，看起来就是线闪一下。
   */
  paintNow(): void {
    this.cancel();
    const svg = this.source.svg();
    const spec = this.source.spec();
    if (!svg || !spec) return;
    this.painter.paintAll(svg, spec);
  }

  cancel(): void {
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.mode = "links";
    this.paths.clear();
  }

  /** 缓存全清（重建后元素引用全部作废） */
  reset(): void {
    this.cancel();
    this.painter.reset();
  }

  private flush(): void {
    const svg = this.source.svg();
    const spec = this.source.spec();
    if (!svg || !spec) return;

    if (this.mode === "all") {
      this.painter.paintAll(svg, spec);
    } else {
      this.painter.paintLinks(svg, spec, this.paths.size > 0 ? this.paths : null);
    }
    this.mode = "links";
    this.paths.clear();
  }
}
