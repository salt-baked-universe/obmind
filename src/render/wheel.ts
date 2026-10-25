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
 * **这里踩过两个坑，都是同一个教训：设备参数不能当公理。**
 *
 * 坑一（1.18.16）：把「鼠标一格」写成 `|deltaY| === 100 或 120` —— 那是 Chromium
 * 在 Windows 默认「一次滚 3 行」下的换算结果。而「每次滚动的行数」是用户可调的，
 * Chromium 的公式是 `行数 × 40`：滚 1 行 = 40、4 行 = 160。于是设置不是 3 行的机器上，
 * 鼠标滚轮全被判成触摸板，**滚轮变成了上下平移**。
 *
 * 坑二（1.18.17）：改成「整数 = 鼠标」之后，150% 显示缩放的机器报 `66.666…`
 * （= 100 ÷ 1.5，Chromium 把 CSS 像素按 deviceScaleFactor 除了一遍），
 * 小数判据又把它判成触摸板，**滚轮还是平移**。
 *
 * 于是不再猜「一格是多少像素」，改用**手势内自证**：
 * 鼠标的 delta 一定是首格的整数倍（一格 66.67 → 两格 133.33），
 * 触摸板是连续变化的值（40 → 43 → 47），比值落不到整数上。
 * 首格只判「有没有横向分量 / 是不是连续微动」，宁可先按鼠标处理（后面能自愈），
 * 因为把鼠标判成触摸板的代价（滚轮彻底不能缩放）比反过来大得多。
 *
 * 三个可用信号：
 * 1. `deltaMode`：行 / 页模式只有传统鼠标驱动才会给；
 * 2. 量级：触摸板的单次位移通常只有个位数（鼠标最小也有 16 以上）；
 * 3. 横向分量：触摸板双指不可能完全垂直，几乎总有 deltaX。
 *
 * 判定仍然是**按手势**做的：手势内的结论粘住。第一格像鼠标就先缩放，
 * 后面任何一格不像（变小、出现横向分量、不是首格的整数倍）就把整个手势改判成平移。
 * 反方向（pan → zoom）不做：一旦判成平移，说明已经观测到连续位移，鼠标不会中途出现。
 *
 * 捏合（pinch）在 Chromium 里被合成成 `ctrlKey === true` 的 wheel —— 这也是
 * d3-zoom 的判定方式，两边一致。
 */

export type WheelMode = "zoom" | "pan";

/**
 * 用户在设置里钉死的滚轮语义。
 *
 * `"auto"` 才是靠事件形状猜；另两档是「别猜了，就按我说的做」。
 * 为什么需要它：**形状判据永远只能覆盖大多数设备**。`deltaY` 由三件事共同决定 ——
 * 系统滚动行数、显示缩放（`100 ÷ dsf`）、驱动；再加上触摸板的连续位移，
 * 全世界的组合不可能穷举。猜准了是运气，用户按一下开关才是确定。
 */
export type WheelPinMode = "auto" | WheelMode;

export const WHEEL_PIN_OPTIONS: Array<{ value: WheelPinMode; label: string; desc: string }> = [
  {
    value: "auto",
    label: "自动（按设备判断）",
    desc: "鼠标滚轮缩放、触摸板双指平移。按事件形状猜，覆盖绝大多数设备；判错就选下面两档。",
  },
  {
    value: "zoom",
    label: "始终缩放",
    desc: "滚轮永远缩放，不判断设备。只用鼠标时最省心。",
  },
  {
    value: "pan",
    label: "始终平移",
    desc: "滚轮永远平移，不判断设备。只用触摸板、又习惯 Ctrl+滚轮缩放时选这个。",
  },
];

/** 设置里存的是任意字符串，读回来必须收敛 */
export function normalizeWheelPin(v: unknown): WheelPinMode {
  return v === "zoom" || v === "pan" ? v : "auto";
}

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
 * 触摸板的单次位移是个位数（1~13）；鼠标最小的一档是「滚 1 行」，
 * 200% 缩放下约 20、300% 下约 13 —— 取 16 卡在常见触摸板值与极端 DPI 之间。
 * 宁可偶尔把触摸板的大位移当成鼠标（第二格会因为「不是整数倍」自愈），
 * 也不要把鼠标判成触摸板（那等于滚轮彻底失效）。
 */
const WHEEL_MIN_PX = 16;
/** 一格对应的「2 的多少次方」。0.2 → 每格 1.149 倍，与 d3-zoom 默认手感一致 */
const NOTCH_STEP = 0.2;
/**
 * 手势内「这一格是首格的整数倍」的容差。
 *
 * 鼠标是同一步长重复（66.666 → 133.333，比值精确到 1e-13）；
 * 触摸板是连续值（40 → 43，比值 1.075）。0.03 只允许浮点误差级别的偏差。
 */
const MULTIPLE_TOL = 0.03;
/** 一格像素数的合理区间；超出就说明这个事件不是「一格」的语义，退回默认 */
const NOTCH_PX_MIN = WHEEL_MIN_PX;
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
 * 这次滚轮像不像「鼠标一格一格」。
 *
 * **不判整数**：150% 显示缩放下鼠标一格是 `66.666…`（Chromium 按
 * deviceScaleFactor 除过一遍），小数在鼠标这边完全正常 —— 这条当初把
 * 用户 150% 屏的滚轮判成了触摸板。只判量级和横向分量。
 */
export function looksLikeWheel(dx: number, dy: number, mode: number): boolean {
  // 行 / 页模式是传统滚轮驱动才有的表达方式
  if (mode !== 0) return true;

  const ax: number = Math.abs(dx);
  const ay: number = Math.abs(dy);
  if (!Number.isFinite(ay)) return false;
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
  /** 用户在设置里钉死的语义；`"auto"` = 靠形状猜 */
  private pin: WheelPinMode = "auto";

  /** 设置面板改动后调一次。不重置手势：用户改完设置会立刻滚，不该丢掉当前这一格 */
  setPin(pin: WheelPinMode): void {
    this.pin = pin;
  }

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
    const ay: number = Math.abs(dy);

    // 用户钉死了语义：不再看形状，直接按他说的做。
    // 倍率仍然按「格」算，notchPx 取手势的第一个事件 —— 这样不同 DPI 下
    // 一格还是 1.149，不会因为 deltaY 是 66.67 就缩得特别慢。
    if (this.pin !== "auto") {
      this.mode = this.pin;
      this.last = e.timeStamp;
      if (this.pin === "pan") return { kind: "pan", dx: -dx, dy: -dy };
      if (fresh || this.notchPx <= 0) this.notchPx = clampNotchPx(ay);
      return {
        kind: "zoom",
        factor: clampFactor(Math.pow(2, (-dy / this.notchPx) * NOTCH_STEP)),
      };
    }

    const wheel: boolean = looksLikeWheel(dx, dy, e.deltaMode);
    // 手势内自证：鼠标这一格必须是首格的整数倍（一格 66.67 → 两格 133.33）；
    // 触摸板是连续值（40 → 43），比值落不到整数上。
    let steady = false;
    if (!fresh && this.mode === "zoom" && this.notchPx > 0) {
      const ratio: number = ay / this.notchPx;
      const n: number = Math.round(ratio);
      steady = n >= 1 && Math.abs(ratio - n) <= MULTIPLE_TOL;
    }
    // 手势内只允许「zoom → pan」单向改判：鼠标不会中途变成触摸板，
    // 但触摸板的第一格可能够大够整，紧跟的一格就会把它揪出来。
    if (fresh) {
      this.mode = wheel ? "zoom" : "pan";
      this.notchPx = wheel ? clampNotchPx(ay) : 0;
    } else if (this.mode === "zoom" && !steady) {
      // 这一格不是首格的整数倍 → 整个手势其实是连续设备。
      // 注意这里必须**直接判 pan**，不能再问一次 `wheel`：
      // 触摸板快滑时单格也能超过阈值，问了就又回到 zoom。
      this.mode = "pan";
      this.notchPx = 0;
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
