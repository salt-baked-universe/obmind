/**
 * 视图运行时：阶段闸门 + 重建串行化 + 版本号。
 *
 * 这里替掉的是原先散在 MindmapView 里的 refreshing / pending / rebuilding /
 * pendingRefresh 四个布尔——它们靠手工组合维护不变式，任何一种组合漏判都会出事：
 * - 重建期间重入 → 同一张 svg 上建出两个 Markmap 实例；
 * - 编辑期间重建 → 输入框连同光标一起被冲掉；
 * - 并发请求被直接丢掉 → 切主题没反应 / 双击被吞。
 *
 * 现在只保留一个显式 phase，加一条规则：
 *   **只有 idle 阶段才允许跑重建任务，其余阶段来的请求一律挂着，回到 idle 自动补跑。**
 *
 * 版本号（rev）解决另一类问题：一次重建里有多次 await（读文件、渲染代码块），
 * 期间用户可能已经又改了一版。任务在关键点用 stale(rev) 自查，发现自己过期就
 * 安静退出，不要再用旧数据去画图。
 */

/** 视图阶段。任意时刻只有一个，彼此互斥。 */
export type Phase = "idle" | "editing" | "dragging" | "rebuilding";

export type ProjectTask = (rev: number) => Promise<void>;

export class ViewRuntime {
  private _phase: Phase = "idle";
  private _rev = 0;
  private _task: ProjectTask | null = null;
  private _running = false;
  private _disposed = false;
  private readonly onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void) {
    this.onError = onError;
  }

  get phase(): Phase {
    return this._phase;
  }

  /** 是否有重建正在执行（代替原来的 refreshing 标志） */
  get busy(): boolean {
    return this._running;
  }

  /** 是否还有未消化的请求（调试 / 测试用） */
  get pending(): boolean {
    return this._task !== null || this._running;
  }

  /**
   * 切换阶段。离开占用态（editing / dragging / rebuilding）回到 idle 时，
   * 挂起的请求会立刻补跑 —— 原来那套 pendingRefresh 手写补跑的就是这件事。
   */
  setPhase(phase: Phase): void {
    if (this._phase === phase) return;
    this._phase = phase;
    void this.pump();
  }

  /**
   * 请求一次重建。
   *
   * 新的请求会覆盖还没开始跑的旧请求（都是「把最新状态画出来」，没必要排队），
   * 同时把正在跑的那一轮标记为过期 —— 它手里的数据已经不是最新的了。
   */
  request(task: ProjectTask): void {
    this._task = task;
    this._rev++;
    void this.pump();
  }

  /** 任务在 await 之后自查：返回 true 表示自己已经过期，应当放弃投影 */
  stale(rev: number): boolean {
    return rev !== this._rev || this._disposed;
  }

  dispose(): void {
    this._disposed = true;
    this._rev++;
    this._task = null;
  }

  private async pump(): Promise<void> {
    if (this._running || this._disposed) return;
    if (this._phase !== "idle") return;

    this._running = true;
    try {
      // while 而不是 if：任务里可能把 phase 切走又切回来（重建前后的 rebuilding），
      // 回来之后如果还有挂起请求，必须接着跑。
      while (!this._disposed && this._task !== null && this._phase === "idle") {
        const task: ProjectTask = this._task;
        this._task = null;
        const rev: number = this._rev;
        try {
          await task(rev);
        } catch (err) {
          // 一次重建失败不该让视图卡死在 running：交给调用方记日志 + 提示，
          // 循环继续，下一次请求照常能跑。
          this.onError(err);
        }
      }
    } finally {
      this._running = false;
    }
  }
}
