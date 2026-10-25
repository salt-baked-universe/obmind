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
 * 触摸板是混着用的），只能看事件本身的形状。
 *
 * **这里踩过一个大坑（1.18.16 → 1.18.17）**：一开始把「鼠标一格」写成了
 * `|deltaY| === 100 或 120` —— 那是 Chromium 在 Windows 默认「一次滚 3 行」
 * 下的换算结果。可 Windows 的「每次滚动的行数」是用户可调的，Chromium 的公式是
 * `行数 × 40`：滚 1 行 = 40、滚 2 行 = 80、滚 4 行 = 160、滚 5 行 = 200。
 * 于是只要系统设置不是 3 行，鼠标滚轮就全被判成触摸板，**滚轮变成了上下平移**。
 * 结论：不能拿「格 = 100px」当公理，只能用量级 + 离散性判形状。
 *
 * 三个可用信号：
 * 1. `deltaMode`：行 / 页模式只有传统鼠标驱动才会给；
 * 2. 量级与整数性：鼠标每格是几十到几百的整数，触摸板是 3、7、13 这种小值，
 *    而且常常带小数；
 * 3. 横向分量：触摸板双指不可能完全垂直，几乎总有 deltaX。
 *
 * 判定仍然是**按手势**做的：手势内的结论粘住。第一格像鼠标就先缩放，
 * 后面任何一格不像（变小、变小数、出现横向分量）就把整个手势改判成平移 ——
 * 鼠标不会产生「小半格」，所以这个单向改判不会误反。反方向（pan → zoom）不做：
 * 一旦判成平移，说明已经观测到连续位移，鼠标不会中途出现。
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

/**
 * 鼠标一格的最小量级。
 *
 * Windows 上「一次滚 1 行」= 40px（Chromium: 行数 × 40），这是合法配置的下限；
 * 触摸板的单次位移通常是个位数到二十几。28 落在两者之间的空隙里。
 */
const WHEEL_MIN_PX = 28;
/** 一格对应的「2 的多少次方」。0.2 → 每格 1.149 倍，与 d3-zoom 默认手感一致 */
const NOTCH_STEP = 0.2;
/** 一格像素数的合理区间；超出就说明这个事件不是「一格」的语义，退回默认 */
const NOTCH_PX_MIN = 28;
const NOTCH_PX_MAX = 400;
const NOTCH_PX_FALLBACK = 100;
/** `deltaMode === 1`（行）的换算：按浏览器默认行高 */
const LINE_PX = 16;
/** `deltaMode === 2`（页）的换算比例 */
const PAGE_RATIO = 0.9;
/** 两次事件间隔超过它就算「新手势」，结论不再粘住 */
const GESTURE_GAP = 260;
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
 * 不判「等于某个魔数」，只判三件事：整数、量级够大、没有横向分量。
 * 判「像鼠标」而不是判「像触摸板」，是因为漏判的代价不对称：
 * 把触摸板误判成鼠标 → 一划就缩放，非常难受；把鼠标误判成触摸板 →
 * 滚轮完全变成平移（用户原话：「鼠标滚轮怎么变上下滑动了」），更难受。
 * 前者还有第二格纠正的机会，后者一旦判错整个手势都没救。
 */
export function looksLikeWheel(dx: number, dy: number, mode: number): boolean {
  // 行 / 页模式是传统滚轮驱动才有的表达方式
  if (mode !== 0) return true;

  const ax: number = Math.abs(dx);
  const ay: number = Math.abs(dy);
  if (!Number.isFinite(ay)) return false;
  // 小数 = 连续设备。Chromium 给鼠标的永远是整数，容差只为吃掉浮点误差
  if (Math.abs(ay - Math.round(ay)) > 0.05) return false;
  // 量级太小 = 触摸板的连续微动
  if (ay < WHEEL_MIN_PX) return false;
  // 双指几乎总有横向分量；鼠标滚轮除了按住 Shift（已提前分支）不会有
  if (ax > 0.51) return false;
  return true;
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
  /** 本次手势观测到的「一格」像素；缩放倍率按它折算，所以 40px/格 和 120px/格 手感一致 */
  private notchPx = 0;

  reset(): void {
    this.mode = null;
    this.last = -Infinity;
    this.notchPx = 0;
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
    const wheel: boolean = looksLikeWheel(dx, dy, e.deltaMode);
    // 手势内只允许「zoom → pan」单向改判：鼠标不会中途变成触摸板，
    // 但触摸板的第一格完全可能够大够整，紧跟的一格就会把它揪出来。
    if (fresh || (this.mode === "zoom" && !wheel)) {
      this.mode = wheel ? "zoom" : "pan";
      this.notchPx = wheel ? clampNotchPx(Math.abs(dy)) : 0;
    }
    this.last = e.timeStamp;

    if (this.mode === "zoom") {
      // 按**格**算倍率，不按像素线性累加：一格永远是 1.149 倍，
      // 不管这个系统把一格定义成 40 还是 200 像素。
      const step: number = this.notchPx > 0 ? this.notchPx : NOTCH_PX_FALLBACK;
      return { kind: "zoom", factor: clampFactor(Math.pow(2, (-dy / step) * NOTCH_STEP)) };
    }
    // 平移是「内容跟着手指走」：和浏览器滚动同号（delta 为正 = 内容往后走），
    // 所以是负的 delta。调用方再按当前缩放比例换成内容坐标。
    return { kind: "pan", dx: -dx, dy: -dy };
  }
}

function clampNotchPx(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return NOTCH_PX_FALLBACK;
  return Math.min(NOTCH_PX_MAX, Math.max(NOTCH_PX_MIN, v));
}

function clampFactor(f: number): number {
  if (!Number.isFinite(f)) return 1;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f));
}
