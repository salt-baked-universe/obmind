/**
 * 滚轮 / 触摸板手势的语义判定（L2，纯逻辑：不碰 DOM、不 import obsidian）。
 *
 * 为什么必须自己判：**同一个 `wheel` 事件在两种设备上的意思完全不同。**
 * - 鼠标滚轮：一格 = 一个明确的指令，用户预期「缩放」（和 XMind 一致；
 *   也因为滚轮没法做连续平移，用它平移手感极差）；
 * - 触摸板双指滑动：几十赫兹、每次几像素的连续位移，用户预期「图跟着手指走」。
 *   把它当缩放，就是「轻轻一划整张图放大到看不见」—— 这是 markmap 在 Windows
 *   上默认手感很差的根因（它只在 Mac 上默认 `scrollForPan`）。
 *
 * 判据没法问系统（Web 没有「当前输入设备」的 API，而且同一台机器上鼠标和
 * 触摸板是混着用的），只能看事件本身的形状。三个可用信号：
 * 1. `deltaMode`：行 / 页模式只有传统鼠标驱动才会给；
 * 2. 数值是否「整格」：Chromium 在 Windows 上把一格固定成 100px（规范是
 *    3 行 × 40px 取整），触摸板给的是 3、7、13 这种零碎值；
 * 3. 横向分量与频率：触摸板几乎总有 deltaX（双指不可能完全垂直），
 *    而且一次手势内会出现非整格的值。
 *
 * 所以判定是**按手势**做的，不是按事件：手势内的结论粘住，后面任何一格
 * 不像鼠标就把整个手势改判成触摸板（鼠标永远不会产生「半格」，所以不会误反）。
 *
 * 捏合（pinch）在 Chromium 里被合成成 `ctrlKey === true` 的 wheel —— 这也是
 * d3-zoom 的判定方式，两边一致。
 */

export type WheelMode = "zoom" | "pan";

/** 只用到这几个字段，用例可以直接构造对象 */
export interface WheelEventLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  timeStamp: number;
}

export type WheelIntent =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; dx: number; dy: number };

/** 鼠标滚轮一格。Chromium/Windows 固定给 100，部分驱动给 120（3 行 × 40px） */
const NOTCH_PX = 100;
/** `deltaMode === 1`（行）的换算：按浏览器默认行高 */
const LINE_PX = 16;
/** `deltaMode === 2`（页）的换算比例 */
const PAGE_RATIO = 0.9;
/** 两次事件间隔超过它就算「新手势」，结论不再粘住 */
const GESTURE_GAP = 260;
/** 一个像素的 deltaY 换算成「2 的多少次方」倍。0.002 与 d3-zoom 默认一致 */
const NOTCH_GAIN = 0.002;
/** 捏合的 delta 很小（常常是个位数），增益要放大一个数量级，同样对齐 d3 */
const PINCH_GAIN = 0.02;
/** 单次事件放大/缩小的上下限：一次巨大的 delta 不该把图甩飞 */
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2;

/** 三种 deltaMode 统一换算成像素 */
export function toPixels(delta: number, mode: number, viewport: number): number {
  if (mode === 1) return delta * LINE_PX;
  if (mode === 2) return delta * viewport * PAGE_RATIO;
  return delta;
}

/**
 * 这次滚轮是不是「鼠标一格一格」的形状。
 *
 * 判「像鼠标」而不是判「像触摸板」，是因为漏判的代价不对称：
 * 把触摸板误判成鼠标 → 一划就缩放，非常难受；把鼠标误判成触摸板 →
 * 滚轮变成平移，用户按一下 Ctrl 就能缩放，而且很容易通过数值纠正过来。
 */
export function looksLikeNotch(dx: number, dy: number, mode: number): boolean {
  // 行 / 页模式是传统滚轮驱动才有的表达方式
  if (mode !== 0) return true;

  const onGrid = (v: number): boolean => {
    const a: number = Math.abs(v);
    if (a === 0) return true;
    if (a < 50) return false;
    if (Math.round(a) !== a) return false;
    return a % NOTCH_PX === 0 || a % 120 === 0;
  };
  return onGrid(dx) && onGrid(dy);
}

/**
 * 一个手势内的判定状态。
 *
 * 视图里每个画布一个实例，`reset()` 用在换笔记 / 重新适配之后 ——
 * 否则上一个手势的结论会跟着带到下一次。
 */
export class WheelGesture {
  private mode: WheelMode | null = null;
  private last = -Infinity;

  reset(): void {
    this.mode = null;
    this.last = -Infinity;
  }

  /** 当前手势被判成了什么（null = 还没有手势） */
  get current(): WheelMode | null {
    return this.mode;
  }

  /**
   * 这一帧该干什么。返回 null 表示这个事件没有位移（纯占位事件），别拦它。
   *
   * @param viewport 视口高度，只用于把「页」换算成像素
   */
  classify(e: WheelEventLike, viewport: number): WheelIntent | null {
    const dx: number = toPixels(e.deltaX, e.deltaMode, viewport);
    const dy: number = toPixels(e.deltaY, e.deltaMode, viewport);
    if (dx === 0 && dy === 0) return null;

    // 捏合 = ctrlKey 的 wheel（Windows 精密触摸板与 macOS 触摸板都是这么合成的）。
    // 「Ctrl + 滚轮」也归到这里：两件事的意图都是缩放，没必要分开。
    if (e.ctrlKey) {
      this.mode = "zoom";
      this.last = e.timeStamp;
      return { kind: "zoom", factor: clampFactor(Math.pow(2, -dy * PINCH_GAIN)) };
    }

    // Shift + 滚轮 = 横向平移。这是浏览器的通用语义（Shift 把纵向滚轮转成横向），
    // 抢过来当缩放反而和肌肉记忆打架。
    if (e.shiftKey) {
      this.mode = "pan";
      this.last = e.timeStamp;
      const d: number = dx !== 0 ? dx : dy;
      return { kind: "pan", dx: -d, dy: 0 };
    }

    const fresh: boolean = this.mode === null || e.timeStamp - this.last > GESTURE_GAP;
    const notch: boolean = looksLikeNotch(dx, dy, e.deltaMode);
    // 手势内只允许「zoom → pan」单向改判：鼠标不会中途变成触摸板，
    // 但触摸板的第一格完全可能正好是 100，紧跟的一格就会把它揪出来。
    if (fresh || (this.mode === "zoom" && !notch)) this.mode = notch ? "zoom" : "pan";
    this.last = e.timeStamp;

    if (this.mode === "zoom") {
      return { kind: "zoom", factor: clampFactor(Math.pow(2, -dy * NOTCH_GAIN)) };
    }
    // 平移是「内容跟着手指走」：和浏览器滚动同号（delta 为正 = 内容往后走），
    // 所以是负的 delta。调用方再按当前缩放比例换成内容坐标。
    return { kind: "pan", dx: -dx, dy: -dy };
  }
}

function clampFactor(f: number): number {
  if (!Number.isFinite(f)) return 1;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f));
}
