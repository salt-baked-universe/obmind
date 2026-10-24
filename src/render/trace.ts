/**
 * 现场探针：把「谁在这一帧动了什么」记录下来。
 *
 * 为什么需要它：闪烁这类问题的证据只在**时序**里 —— 同一帧里被写了两次
 * opacity、重建结束后又跑了一遍带过渡的重排、视角被 fit 了两次……
 * 这些都不是看代码能看出来的，必须拿到运行时的帧号与先后顺序。
 *
 * 三条设计约束：
 *
 * 1. **默认全关，关时零成本**。所有埋点都是 `traceLog(...)` 一行，函数体第一句
 *    就是 `if (!level) return;`。浏览器里跑的是生产构建，不能因为埋点把
 *    折叠动画的帧率吃掉。
 * 2. **日志要能直接拖进 issue**。单行、带帧号、带相对毫秒、字段用 `k=v`，
 *    用 grep 就能把「某类事件」整条拉出来；`traceText()` 一次性吐全部行，
 *    再包一层环境信息头。
 * 3. **不猜，只记**。埋点不改变任何行为（除了 `frames` 模式的采样会读一次 DOM），
 *    所以看到什么就是真发生了什么。反过来，`frames` 模式本身可能让问题变形，
 *    所以它单独一档，默认不开。
 *
 * 开关（开发者工具控制台，或命令面板「obmind: 开始/停止闪烁日志」）：
 *
 *     obmindTrace.on()       只记事件（推荐，开销极低）
 *     obmindTrace.frames()   事件 + 每帧视觉快照（用来抓「不知道哪来的」闪烁）
 *     obmindTrace.off()
 *     copy(obmindTrace.text())   复制到剪贴板
 *     obmindTrace.save()         存成库根目录下的日志文件
 */

/** 记录档位：off 不记；events 只记关键事件；frames 额外逐帧采样视觉状态 */
export type TraceLevel = "off" | "events" | "frames";

const STORAGE_KEY = "obmind:trace";
/** 环形缓冲上限：一次复现几十秒足够，再多只是让复制变慢 */
const MAX_LINES = 4000;

let level: TraceLevel = readStoredLevel();
/**
 * 开始记录那一刻的档位。
 *
 * 头部不能直接写 `level`：用户的顺序是「开日志 → 复现 → 关日志 → 保存」，
 * 保存时 level 已经是 off，于是每份日志头部都写着 `level off`，
 * 拿回来第一眼就是「这堆事件是哪档采的？」（1.18.2 那份现场日志就是这样）。
 */
let recordLevel: TraceLevel = level;
let origin = performance.now();
let lineNo = 0;
/** 当前帧号（由 rAF 递增）：判断「同一帧里发生了几件事」全靠它 */
let frameNo = 0;
let rafId = 0;
let lines: string[] = [];
let counts: Map<string, number> = new Map();
/** 因为缓冲满被丢掉的行数（丢掉最早的，保留最近的现场） */
let dropped = 0;

/** 采样器绑定的 svg：由视图在 onOpen 时登记，视图关闭时置 null */
let samplingSvg: SVGSVGElement | null = null;
let samplerRaf = 0;
let lastSample = "";

/** 环境信息（版本 / 笔记名等），由 installTraceConsole 注入，写进日志头 */
let metaOf: () => Record<string, string> = () => ({});

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

function readStoredLevel(): TraceLevel {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "events" || raw === "frames") return raw;
    if (raw === "1") return "events";
  } catch {
    // 隐私模式 / 沙箱里 localStorage 可能抛异常：当成关闭
  }
  return "off";
}

function storeLevel(v: TraceLevel): void {
  try {
    if (v === "off") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, v);
  } catch {
    // 存不下就只在本次会话有效，不影响记录本身
  }
}

export function traceLevel(): TraceLevel {
  return level;
}

export function isTracing(): boolean {
  return level !== "off";
}

/**
 * 切档。
 *
 * 从 off → 任意档时重置时间原点与帧号：日志里的 `+123.4` 必须是「本次复现开始后
 * 多久」，跨会话累加就完全没法对照了。
 */
export function setTraceLevel(next: TraceLevel): void {
  const wasOff: boolean = level === "off";
  level = next;
  storeLevel(next);

  if (next === "off") {
    stopClock();
    stopSampler();
    return;
  }
  if (wasOff) {
    origin = performance.now();
    frameNo = 0;
    lineNo = 0;
    lines = [];
    counts = new Map();
    dropped = 0;
    recordLevel = next;
  }
  startClock();
  if (next === "frames") startSampler();
  else stopSampler();
}

// ---------------------------------------------------------------------------
// 帧钟与采样器
// ---------------------------------------------------------------------------

function startClock(): void {
  if (rafId !== 0) return;
  const tick = (): void => {
    frameNo++;
    rafId = window.requestAnimationFrame(tick);
  };
  rafId = window.requestAnimationFrame(tick);
}

function stopClock(): void {
  if (rafId !== 0) {
    window.cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

/** 视图把当前 svg 交给探针；关视图时传 null */
export function traceBindSvg(el: SVGSVGElement | null): void {
  samplingSvg = el;
}

function startSampler(): void {
  if (samplerRaf !== 0) return;
  const loop = (): void => {
    sample();
    samplerRaf = window.requestAnimationFrame(loop);
  };
  samplerRaf = window.requestAnimationFrame(loop);
}

function stopSampler(): void {
  if (samplerRaf !== 0) {
    window.cancelAnimationFrame(samplerRaf);
    samplerRaf = 0;
  }
  lastSample = "";
}

/** 读一个节点 fo 的内联透明度；没设过按 1 算 */
function foOpacity(fo: Element): number {
  const raw: string = (fo as SVGForeignObjectElement).style.opacity;
  if (raw === "") return 1;
  const v: number = Number(raw);
  return Number.isFinite(v) ? v : 1;
}

/**
 * 每帧一次的视觉快照。
 *
 * 四个数就是「闪烁」的全部可能形态：
 * - `n`     节点数变了 → 结构重建（整图重来）
 * - `fo`    文字层里有多少个节点正被写成半透明 → markmap 的淡入淡出
 * - `cd`    我们的卡片/阴影/连线里有多少个正被写成半透明 → painter 抄了透明度
 * - `k`     视口缩放 → fit 被反复调用（画面整体缩放）
 *
 * **只在快照变化时输出一行**：静止时零日志，一有变化就是逐帧连打，
 * 肉眼看到的闪烁会在日志里留下一条连续的斜坡（0.42 → 0.58 → 0.73 …）。
 */
function sample(): void {
  const svg: SVGSVGElement | null = samplingSvg;
  if (!svg || !svg.isConnected) return;

  const nodes = svg.querySelectorAll<SVGGElement>("g.markmap-node");
  let foFade = 0;
  let foMin = 1;
  for (const g of Array.from(nodes)) {
    const fo = g.firstElementChild;
    if (!(fo instanceof SVGForeignObjectElement)) continue;
    const v = foOpacity(fo);
    if (v < 1) {
      foFade++;
      if (v < foMin) foMin = v;
    }
  }

  let cardFade = 0;
  for (const el of Array.from(svg.querySelectorAll<SVGElement>(".obmind-node-card, .obmind-node-link"))) {
    if (el.style.opacity !== "") cardFade++;
  }

  // 缩放层是 svg 的第一个 <g>，markmap 的 zoom 写在它的 transform 上
  const zoomG = svg.querySelector<SVGGElement>(":scope > g");
  const k: number = zoomG ? readScale(zoomG.style.transform) : 0;

  const sig = `${nodes.length}|${foFade}|${foMin.toFixed(2)}|${cardFade}|${k.toFixed(3)}`;
  if (sig === lastSample) return;
  lastSample = sig;

  traceLog("frame", {
    n: nodes.length,
    fo: foFade,
    foMin: foMin < 1 ? foMin.toFixed(2) : "",
    card: cardFade,
    k: k.toFixed(3),
  });
}

/** 从 `translate(x,y) scale(k)` 里取 k */
function readScale(transform: string): number {
  const m = /scale\(([-\d.]+)/.exec(transform);
  if (!m) return 1;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : 1;
}

// ---------------------------------------------------------------------------
// 写日志
// ---------------------------------------------------------------------------

export type TraceData = Record<string, string | number | boolean | undefined | null>;

function fmtValue(v: TraceData[string]): string {
  if (v === undefined) return "?";
  if (v === null) return "-";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(1);
  const s = String(v);
  // 带空格的用双引号包起来，保证「按空格切字段」的 grep 不会错位
  return /[\s=]/.test(s) ? JSON.stringify(s) : s;
}

/**
 * 记一行。
 *
 * 第一句就是短路的 `if`，所以关着的时候调用方可以放心地在热路径里埋点。
 */
export function traceLog(tag: string, data?: TraceData): void {
  if (level === "off") return;

  const ms: number = performance.now() - origin;
  let body = "";
  if (data) {
    const parts: string[] = [];
    for (const key of Object.keys(data)) {
      const v = data[key];
      if (v === undefined) continue;
      parts.push(`${key}=${fmtValue(v)}`);
    }
    if (parts.length > 0) body = " " + parts.join(" ");
  }

  lineNo++;
  const line = `+${ms.toFixed(1).padStart(8)} f${String(frameNo).padStart(4, "0")} ${tag}${body}`;
  push(line);
  counts.set(tag, (counts.get(tag) ?? 0) + 1);
}

function push(line: string): void {
  lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
    dropped++;
  }
}

/**
 * 限流记录：同一个 key 每 ms 最多一行，期间被压掉的次数攒到下一次的 `skipped` 字段。
 *
 * 给「每帧都会发生」的热路径用（折叠动画里每次 paintMoved、观察器每个 transform 批）。
 * 这类事件不记的话看不出「一帧到底改了几次」，全记又会把有用的那几行冲掉。
 */
const everyAt: Map<string, number> = new Map();
const everySkipped: Map<string, number> = new Map();

export function traceLogEvery(key: string, ms: number, tag: string, data?: TraceData): void {
  if (level === "off") return;
  const now: number = performance.now();
  const prev: number = everyAt.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - prev < ms) {
    everySkipped.set(key, (everySkipped.get(key) ?? 0) + 1);
    return;
  }
  everyAt.set(key, now);
  const skipped: number = everySkipped.get(key) ?? 0;
  everySkipped.set(key, 0);
  traceLog(tag, skipped > 0 && data ? { ...data, skipped } : skipped > 0 ? { skipped } : data);
}

/** 记录一条「分组开始/结束」，pair 用 traceSince 算耗时 */
export function traceSince(): number {
  return performance.now();
}

/** 距 since 的毫秒数，用于 dt 字段 */
export function traceElapsed(since: number): string {
  return (performance.now() - since).toFixed(1);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function traceClear(): void {
  lines = [];
  counts = new Map();
  dropped = 0;
  lineNo = 0;
  origin = performance.now();
  frameNo = 0;
}

/** 环境信息头：没有它，日志离开现场就没法解读 */
function header(): string {
  let meta: Record<string, string> = {};
  try {
    meta = metaOf();
  } catch {
    // 插件正在卸载 / workspace 已经不可用时读不到当前笔记：日志本身还是要能导出来
  }
  const rows: string[] = [
    "# obmind trace",
    `# time     ${new Date().toISOString()}`,
    `# level    ${recordLevel}`,
  ];
  for (const key of Object.keys(meta)) rows.push(`# ${key.padEnd(8)} ${meta[key]}`);
  rows.push(`# lines    ${lines.length}${dropped > 0 ? ` (+${dropped} dropped)` : ""}`);
  rows.push("#");
  rows.push("# 字段速查：");
  rows.push("#   refresh.plan   这次刷新走哪条通道（none/patch/结构重建）");
  rows.push("#   patch.src      patch 通道把新文字写回节点数据（不写回去 = 编辑框显示旧内容）");
  rows.push("#   edit.value     打开编辑框时自检：val=初始值 stale=true 表示与卡片上的字不符");
  rows.push("#   edit.commit*   提交结果：ok / none（判成没变、没写盘）/ error / throw");
  rows.push("#   link.drift     漂线自检：n=核对线条数 max=最大偏差(用户单位) hidden=摘掉没还原的线");
  rows.push("#                  shifted=正在拖动、刻意藏起来的块根数（不是问题）");
  rows.push("#   drag.*         拖动：pick=成员数 links=藏掉的对外线 drop=松手结果 shift.*=位移清理");
  rows.push("#   drag.raise     把拖动块提到最上层（这批 childList 记录会被吞掉，不算结构变化）");
  rows.push("#   rebuild.*      结构重建的各阶段；dt 是距上一阶段的毫秒");
  rows.push("#   reflow.*       改字后的主动重排（duration 临时置 0）");
  rows.push("#   settle.catch   markmap 自己那次收尾重排被压成 duration 0（否则整图重播动画）");
  rows.push("#   settle.pass    没被压住的一次整树重排：dur=当时 duration from=调用来源");
  rows.push("#   render.enter   **每一次** markmap 重排的入口：dur=当时 duration arg=折叠的节点 from=来源");
  rows.push("#                  「有一批 transform 写入，却找不到对应的 render.enter」→ 写入来自更早创建的过渡");
  rows.push("#   tr.create      创建了一条过渡（markmap 所有位置/尺寸写入都走它）：dur n=元素数 from");
  rows.push("#                  dur=180 且 n≈节点数 → 有人在播整树动画；dur=0 → 只是延后一帧的瞬间到位");
  rows.push("#   paint.lag      重建画完后立刻自检：lag=位置与布局真值(state.rect)不符的节点数 max=最大偏差");
  rows.push("#                  lag>0 = 这一帧画下去的卡片是错的（transform 还停在 enter 起点）");
  rows.push("#   f.traj         重建后逐帧采样上面的 lag：t=距重建结束(ms) fresh=布局还没算进去的节点数");
  rows.push("#                  lag 一口气归零 → 一次瞬移；连续十几帧且 max 单调变小 → 真是一条动画在飞");
  rows.push("#   obs.structural 结构变化那批：child=增删记录 jump=单点最大位移(px) dt=距重建结束(ms)");
  rows.push("#   obs.transform  节点位移批次；n=本批节点数 jump=单点最大位移(px)");
  rows.push("#   obs.resize     文字层宽高真的变了的节点数（只变宽不变位置时，只有这条通道能发现）");
  rows.push("#                  若出现「改了字却没有 obs.resize」→ 卡片会停在旧宽度、文字顶出边框");
  rows.push("#   obs.fade       某节点文字层透明度被改：old → new（闪的直接证据）");
  rows.push("#   guard.strip    fadeGuard 把 <1 的透明度当场抹掉的次数");
  rows.push("#   drag.shift.sweep 重建收尾清掉的残留位移（>0 = 卡片曾被画到鼠标处的证据）");
  rows.push("#   fade.write     我们把透明度抄给卡片/阴影/连线/收放点（v<1 就是卡片变透明）");
  rows.push("#   paint.all     全量绘制：boxes=画了几个 fresh=其中新建的 writes=真写进 DOM 的属性数");
  rows.push("#                 skipped>0 表示有节点几何还读不到，会隔帧重试");
  rows.push("#                 **writes 才是成本**：250 节点全重写约 5500，命中缓存应只剩几十");
  rows.push("#   paint.moved   增量绘制：n=本批动的节点 links=真重画的线");
  rows.push("#   frame          逐帧快照：n=节点数 fo=文字层淡出数 card=卡片淡出数 k=缩放");
  rows.push("#");
  rows.push("# 事件里看不出问题时，改用 obmindTrace.frames() 再复现一次：");
  rows.push("# 它会每帧采一次视觉快照，闪烁会在 frame 行里留下一段连续变化的斜坡。");
  rows.push("");
  return rows.join("\n");
}

export function traceText(): string {
  return header() + lines.join("\n") + "\n";
}

/** 各事件计数：先看这个，哪类事件异常地多就去捞它的明细 */
export function traceStats(): string {
  const rows: string[] = [];
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [tag, n] of sorted) rows.push(`${String(n).padStart(6)}  ${tag}`);
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// 控制台入口
// ---------------------------------------------------------------------------

export interface TraceConsole {
  on(): void;
  frames(): void;
  off(): void;
  clear(): void;
  text(): string;
  stats(): string;
  save(): Promise<string>;
  state(): string;
}

declare global {
  interface Window {
    obmindTrace?: TraceConsole;
  }
}

/**
 * 挂 `window.obmindTrace`。
 *
 * 幂等：视图可能开好几个（分屏），插件重载时也不能重复定义。
 * `metaOf` 做成回调而不是快照，这样「当前是哪篇笔记」总是最新的。
 */
export function installTraceConsole(metaOfFn: () => Record<string, string>): void {
  metaOf = metaOfFn;
  // **不幂等**：插件重载会重新执行整个 bundle，此时 window 上留着的是**旧模块**
  // 的闭包 —— 它写进旧模块的缓冲数组，而 view 里的埋点调用的是新模块，
  // 两边不是同一个数组，日志永远是空的。所以每次都要接管。
  const api: TraceConsole = {
    on: () => {
      setTraceLevel("events");
      console.info("[obmind] 开始记录事件日志。复现一次闪烁，然后 obmindTrace.text() 或 .save()");
    },
    frames: () => {
      setTraceLevel("frames");
      console.info("[obmind] 开始记录事件 + 逐帧快照。注意：逐帧采样本身会让动画略慢");
    },
    off: () => {
      setTraceLevel("off");
      console.info("[obmind] 已停止记录");
    },
    clear: () => {
      traceClear();
      console.info("[obmind] 日志已清空");
    },
    text: () => traceText(),
    stats: () => traceStats(),
    save: async () => {
      const path: string = await saveTraceToVault();
      console.info(`[obmind] 日志已保存：${path}`);
      return path;
    },
    state: () => `level=${level} lines=${lines.length} frame=${frameNo}`,
  };
  window.obmindTrace = api;
}

/** 由插件在 onload 时注入「往库里写文件」的能力（避免探针自己依赖 obsidian） */
let saveHook: (() => Promise<string>) | null = null;

export function setTraceSaveHook(fn: () => Promise<string>): void {
  saveHook = fn;
}

async function saveTraceToVault(): Promise<string> {
  if (!saveHook) throw new Error("obmind: 日志保存未初始化");
  return saveHook();
}

// 模块加载时把开关接上：用户上次开着日志（正在复现），重载插件后不该悄悄变回「关」，
// 也不该所有日志都停在 f0000（帧钟只在 setTraceLevel 里启动过）。
if (level !== "off") {
  startClock();
  if (level === "frames") startSampler();
}
