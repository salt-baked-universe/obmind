/**
 * 绘制帧调度：全量绘制按 rAF 合并，增量绘制同步执行。
 *
 * 两条路径的区别是「为什么需要等」：
 *
 * - **全量**（结构变化）必须等一帧：markmap 的 `renderData` 会先 append 节点，
 *   再 `await requestAnimationFrame` 之后才 `_relayout`。刚 append 完的那一刻
 *   节点宽高还是 0，这时候量出来全是空盒子。合并到下一帧再画。
 * - **增量**（折叠动画里节点位移）**不能等**：d3 在 rAF 回调里写 transform，
 *   MutationObserver 回调紧跟着在微任务里执行 —— 此刻写连线还是同一帧，
 *   画面一致。若再排一次 rAF，线就比节点晚一帧，动画看起来是线在追节点。
 *
 * 还有一条硬规则：**重建导图期间不画**。那时候 DOM 是半成品，画出来必然是错的，
 * 重建结束后由 paintNow() 在同一帧内一次性补上。
 */

import type { ThemeSpec } from "../theme";
import type { NodePainter } from "./painter";
import { isTracing, traceLog, traceLogEvery } from "./trace";

export interface FrameSource {
  svg: () => SVGSVGElement | null;
  spec: () => ThemeSpec | null;
  /** 返回 true 表示当前 DOM 不可信（重建中），本帧跳过 */
  blocked: () => boolean;
}

export class FrameScheduler {
  private frame = 0;
  /** 全量绘制发现「还有节点没长全」时的重试计数，避免无限排帧 */
  private retries = 0;
  /** 漂移自检排的那一帧（合并，见 scheduleDrift） */
  private driftFrame = 0;

  constructor(
    private readonly painter: NodePainter,
    private readonly source: FrameSource,
  ) {}

  /** 请求一次全量绘制（本帧内多次请求合并成一次） */
  requestAll(): void {
    if (this.source.blocked()) {
      // 重建期间被挡掉是正常的（DOM 是半成品），重建结束的 paintNow 会补上。
      // 但若重建已经结束还一直出现这一句，说明 phase 卡在 rebuilding —— 图就不会再更新。
      traceLog("paint.request.blocked");
      return;
    }
    if (this.frame !== 0) {
      traceLog("paint.request.merged");
      return;
    }
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.paintNow();
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
    const pending: number = this.painter.paintAll(svg, spec);

    // 还有节点读不到几何（内容还没量出来、transform 还没写）：隔一帧再全量画一次。
    // 不补这一遍，这些节点就永远没有卡片 —— 用户看到的就是「只渲染了半张图」。
    // 最多补 3 次（一帧一次），之后放手：那些节点可能真的是空内容。
    if (pending > 0 && this.retries < 3 && !this.source.blocked()) {
      this.retries++;
      // 加上这一遍，屏幕上会连着两三帧「卡片还没包上」—— 若日志里 pending 一直不降，
      // 说明有节点永远量不出几何（空内容 / 尺寸为 0），那才是空白卡片的真凶
      traceLog("paint.retry", { pending, retries: this.retries });
      this.frame = window.requestAnimationFrame(() => {
        this.frame = 0;
        this.paintNow();
      });
      return;
    }
    this.retries = 0;
    this.scheduleDrift();
  }

  /**
   * 同步刷新「这一帧动了」的节点连线。
   *
   * 由 MutationObserver 直接调用，**刻意不合并到 rAF**（见文件头）。
   * 每次调用只处理传进来的元素，成本与「动了的节点数」成正比。
   */
  paintMoved(els: Iterable<SVGGElement>): void {
    if (this.source.blocked()) return;
    const spec = this.source.spec();
    if (!spec) return;
    this.painter.paintMoved(els, spec);
    this.scheduleDrift();
  }

  /**
   * 下一帧核对「线有没有跟上节点」。
   *
   * 为什么是「下一帧」而不是当场：`paintMoved` 是**同步**补画的（同一帧），
   * 当场比对必然全对，等于什么都没测。等一帧之后，浏览器已经把这一帧画出去了，
   * 此时 DOM 里的 `d` 就是用户看到的那根线 —— 它和按当前几何重算出来的
   * 差多少，就是屏幕上真实存在的偏差。
   *
   * 只在开日志时排：一次自检要对全部节点读属性，热路径上不能常开。
   */
  private scheduleDrift(): void {
    if (!isTracing()) return;
    if (this.driftFrame !== 0) return;
    this.driftFrame = window.requestAnimationFrame(() => {
      this.driftFrame = 0;
      const svg = this.source.svg();
      if (!svg || this.source.blocked()) return;
      const rep = this.painter.measureDrift(svg);
      // max>1 才出声：亚像素的舍入差是 round2 带来的，不算飘。
      // 200ms 限流：折叠动画里每帧都会有一条，全记会把有用的事件冲掉。
      // hidden>0 单独报：那是「线被摘掉没还回去」，偏差计算看不出来（d 可能还是对的）。
      if (rep.max > 1 || rep.hidden > 0) {
        traceLogEvery("drift", 200, "link.drift", {
          n: rep.checked,
          max: Math.round(rep.max),
          hidden: rep.hidden,
          shifted: rep.shifted,
          skip: rep.skipped,
          frozen: rep.frozen,
          worst: rep.worst.slice(0, 2).join("|"),
        });
      }
    });
  }

  cancel(): void {
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  /**
   * 同步透明度。
   *
   * 刻意**不看 blocked()**：这一步只把 foreignObject 的 opacity 抄到卡片/连线/收放点上，
   * 不读任何布局，重建期间照抄也是对的；反过来放行让它被跳过，就会留下
   * 「卡片停在 opacity: 0」的死局（见 NodePainter.syncFadeFor 的注释）。
   */
  syncFade(els: Iterable<SVGGElement>): void {
    this.painter.syncFadeFor(els);
  }

  /** 缓存全清（重建后元素引用全部作废） */
  reset(): void {
    this.cancel();
    if (this.driftFrame !== 0) {
      window.cancelAnimationFrame(this.driftFrame);
      this.driftFrame = 0;
    }
    this.retries = 0;
    this.painter.reset();
  }
}
