/**
 * 节点绘制器：给 markmap 渲染出的每个节点补上卡片 / 阴影 / 自绘连线 / 折叠圆点定位。
 *
 * 为什么不用 CSS 而是插入 SVG 元素：
 * markmap 每次重排都会重建 foreignObject 内部结构，写在那层 div 上的背景、
 * 内边距会被冲掉（卡片会塌成一条线）。只有原生 <rect>/<path> 才稳。
 *
 * 性能设计（关键）：
 * 1. 两条绘制路径——
 *    paintAll()  结构变化（重建导图 / 节点增删 / 切主题）时全量画一遍；
 *    paintLinks() 只有节点位移（折叠展开动画）时只更新连线。
 *    卡片画在节点局部坐标里，跟节点位移无关，所以动画期间完全不用碰它。
 * 2. 读写分离——先一次性读完所有节点几何，再统一写属性，避免读写交错引发
 *    浏览器的强制同步布局（layout thrashing）。
 * 3. 分组签名——尺寸没变不重写宽高、配色没变不重写颜色、路径没变不重写 d。
 * 4. 零滤镜——阴影用一个偏移的深色 <rect> 模拟，不用 filter: drop-shadow。
 *    每个节点挂滤镜等于给每个节点建一张离屏图，缩放时必掉帧。
 */

import { nodeStyleAt } from "../theme";
import type { ThemeSpec } from "../theme";
import {
  SVG_NS,
  cardRect,
  circleOffset,
  linkPath,
  nodePathOf,
  parentPathOf,
  readNodeBox,
} from "./geometry";
import type { NodeBox } from "./geometry";
import { branchPathOf, hash32 } from "./colors";
import { isTracing, traceLog, traceLogEvery } from "./trace";

/**
 * 分支 → 色板槽位。
 *
 * 由调用方注入（见 MindmapView.syncBranchSlots），因为只有它手里有「整棵树」
 * 和那份跨重建保留的粘性分配表；painter 只负责按 path 问一句该用第几个颜色。
 * 缺省实现按 path 哈希：即便没注入也不会画出全同色的图。
 */
export type SlotResolver = (path: string, size: number) => number;

/** 读 foreignObject 的内联透明度；没设过就是 1 */
function readOpacity(fo: SVGForeignObjectElement): number {
  const raw: string = fo.style.opacity;
  if (raw === "") return 1;
  const v: number = Number(raw);
  if (!Number.isFinite(v)) return 1;
  return v > 1 ? 1 : v < 0 ? 0 : v;
}

const CLS_SHADOW = "obmind-node-shadow";
const CLS_LINK = "obmind-node-link";
const CLS_CARD = "obmind-node-card";

/**
 * 收放点的缩放系数。
 *
 * markmap 原生 r=6、描边 1.5，视觉直径约 13px —— 比卡片里的文字还抢眼。
 * 缩到 0.7（直径约 9px）既点得中，又不压住内容。
 *
 * 用 scale 而不是改 `r` 属性：r 由 markmap 的 transition 一路写（0→6），
 * 两边抢写同一个属性正是之前「收放点抖动」的根源；transform 与属性是叠加关系，
 * 各写各的，互不覆盖。
 */
const FOLD_SCALE = 0.7;

/** 每个节点的绘制缓存：元素引用 + 各维度上次写入的值 */
interface Entry {
  g: SVGGElement;
  /** 节点自己的 foreignObject：它的内联 opacity 是 markmap 的淡入淡出状态 */
  fo: SVGForeignObjectElement;
  shadow: SVGRectElement | null;
  link: SVGPathElement | null;
  card: SVGRectElement | null;
  circle: SVGCircleElement | null;
  /**
   * 上次写入的值。刻意存**原始数值**而不是拼接后的签名字符串：
   * 折叠动画期间每帧都要过一遍全部节点，若每次都拼字符串，
   * 上千节点就是每秒几万次临时字符串分配，GC 抖动会直接反映成掉帧。
   */
  w: number;
  h: number;
  themeKey: string;
  depth: number;
  branch: number;
  linkD: string;
  linkBranch: string;
  linkWidth: number;
  circleX: number;
  circleY: number;
  /** 上一次同步的节点透明度（markmap 淡入淡出时用），-1 表示还没写过 */
  fade: number;
}

export class NodePainter {
  private entries = new Map<string, Entry>();

  /**
   * path → 节点 g。
   *
   * 折叠/展开动画里每帧都要「从子节点的 path 找到父节点的 g」，原来每次都
   * `svg.querySelectorAll("g.markmap-node")` 全量扫一遍再逐条读属性 ——
   * 上千节点的图，每帧几万次属性读，卡顿主要来自这里。
   * 索引在 paintAll 时重建（结构变化本来就要重扫一次），动画期间只查表。
   */
  private index = new Map<string, SVGGElement>();
  private indexReady = false;

  /**
   * 正在被**整块平移**的节点根（拖动中，见 edit/drag.ts）。
   *
   * 拖动时块里每个 g 都被写了一份 CSS `translate`，而 `linkPath` 只读
   * `transform` 属性（不读 CSS translate，见 geometry.ts）—— 所以块根那根
   * 「父 → 根」的线一旦被画出来，就仍然是按**旧位置**算的坐标，再跟着 g 一起
   * 平移，屏幕上成了一根两端都不挨着的浮线（用户说的「有线」/「飘线」）。
   *
   * 早期版本靠「拖动时把线 `display:none`，重建时 paintAll 顺手还原」来藏，
   * 但 `applyLink` 里有一句「凡我画过的线都保证可见」的兜底（防 d3 复用元素后
   * 线永久消失），于是**任何一次重绘都会把线接回去**：拖动的提层动作会产生
   * childList → 观察器判成结构变化 → 全图重绘 → 线回来了，整段拖动都带着一根线
   * （现场日志 `drag.links n=1` 之后 170ms 就是 `paint.all boxes=257`）。
   *
   * 所以「该不该画」必须是个**谓词**，而不是一次性的「摘掉 / 还回去」动作：
   * 条件在就在，条件没了下一次绘制自然恢复。失败方向是 fail-open（最坏早一帧
   * 露线），而不是「忘了还 → 线永久消失」。
   */
  private shiftedRoots = new Set<SVGGElement>();

  /**
   * 本次 paintAll 真正落到 DOM 上的属性写次数。
   *
   * 这是「重绘到底贵不贵」唯一可靠的指标：一次 `paintAll` 在 250 节点的图上
   * 最多能写 ~5 500 个属性（每节点 24 个），而**值没变的重写一样会让浏览器的
   * style / layout 全部作废**。日志里 `paint.all writes=` 从 5 500 掉到几十，
   * 才说明「只画该画的」真的做到了；只看 `boxes=` 是看不出来的。
   */
  private writes = 0;

  constructor(
    private readonly slotOf: SlotResolver = (path: string, size: number) =>
      hash32(branchPathOf(path)) % Math.max(1, size),
  ) {}

  /**
   * 视图重建导图时调用。
   *
   * 只丢「按位置索引」的东西（`index` / `shiftedRoots`），**`entries` 保留**。
   *
   * 旧版在这里无条件 `entries.clear()`，理由是「元素引用全部作废」。但 markmap 的
   * key 是 `父序号.自身序号 + 内容hash`，改一个字只会换掉那一条链上的几个 g，
   * 其余两百多个 `<g>` 是**同一个元素原样复用**的（d3 按 key join 的结果）。
   * 缓存一清，紧随其后的那次全量绘制就得对每个节点重写 24 个属性 ——
   * 250 节点约 5 500 次写，把整张图的 style/layout 全部作废一遍，
   * 而其中九成以上的值一个都没变。这就是「改个字，整图闪一下」的机械原因。
   *
   * 保留是安全的：`entryOf()` 本来就拿 `cached.g === box.g && card.isConnected`
   * 核对过身份，元素被换掉、或者这个 path 换给了别的 g，都会原地重建一条新 Entry。
   * 换句话说「失效」这件事已经由身份核对按节点做了，不需要在这里一刀切。
   */
  reset(): void {
    this.index.clear();
    this.indexReady = false;
    // 重建之后 DOM 全换了，旧元素引用留着只会泄漏（而且 d3 复用元素时
    // 会让「上一轮的块根」错误地继续藏掉某个正常节点的线）。
    // 正在拖动的那一块由调用方在 reset 之后重新登记（见 MindmapView.applyTree）。
    this.shiftedRoots.clear();
  }

  /** 上一次 `paintAll` 的属性写次数（诊断用：探针/回归测试据此判断缓存有没有命中） */
  get lastWrites(): number {
    return this.writes;
  }

  /** 登记 / 注销「整块平移中」的块根（见字段注释） */
  markShifted(els: Iterable<SVGGElement>, on: boolean): void {
    for (const g of els) {
      if (on) this.shiftedRoots.add(g);
      else this.shiftedRoots.delete(g);
    }
  }

  /**
   * 只同步透明度：给「markmap 改了 foreignObject 的 style.opacity」这条事件用。
   *
   * 为什么不能只在全量/增量绘制里读一次透明度：
   * `renderData` 对 enter 节点是先写 `opacity: 0`、再起过渡到 1 的。我们正好在
   * 中间那一瞬全量绘制，读完就把它写进卡片 → 一张「透明度 0」的卡片。
   * 之后能不能恢复，全看这个节点还有没有 transform 写入恰好触发另一次绘制 ——
   * 没有就永远不恢复（那一块图连卡片带底都没了，就是「只渲染了一半」）。
   *
   * 现在把「透明度变化」本身当成事件源：markmap 每帧写一次 opacity，我们每帧跟一次，
   * 不依赖 transform、也不受重建期 blocked 的影响（这一步不读布局，随时都安全）。
   */
  syncFadeFor(els: Iterable<SVGGElement>): void {
    for (const g of els) {
      if (!g.isConnected) continue;
      const path = nodePathOf(g);
      if (!path) continue;
      const entry = this.entries.get(path);
      if (!entry || entry.g !== g) continue;
      const fo = entry.fo.isConnected
        ? entry.fo
        : g.querySelector<SVGForeignObjectElement>(":scope > foreignObject");
      if (!fo) continue;
      entry.fo = fo;
      this.writeFade(entry, readOpacity(fo));
    }
  }

  /**
   * 全量绘制：结构发生变化时调用。
   * 只在「重建导图 / 节点增删 / 主题切换」这类低频事件里跑。
   *
   * @returns 这一遍**没画成**的节点数（几何还读不到：markmap 刚 append、
   *          内容尺寸还是 0）。>0 说明 DOM 还没长全，调用方应隔一帧再画一遍 ——
   *          否则这些节点会永远没有卡片，看起来就是「只渲染了半张图」。
   */
  paintAll(svg: SVGSVGElement, spec: ThemeSpec): number {
    const { boxes, byPath, skipped } = this.collect(svg);
    // 每次全量绘制一行：boxes 是「画成了几个」，skipped 是「读不到几何的几个」。
    // skipped>0 时调用方会隔帧重试，日志里应该看到紧跟着的第二条 pending 变小。
    if (boxes.length === 0) return skipped || svg.querySelectorAll("g.markmap-node").length;

    // 主题键提到循环外：折叠动画每帧都会走到这里，按节点拼一次字符串
    // 在两千节点的笔记上就是每秒几万次临时分配
    const themeKey = `${spec.id}|${spec.dark ? 1 : 0}`;
    this.writes = 0;
    /** 这一遍真正「从头建」的节点数（其余都是命中缓存、一个属性都没写） */
    let fresh = 0;
    for (const box of boxes) {
      const entry = this.entryOf(box);
      // themeKey 为空只可能是刚 new 出来的 Entry（applyStyle 一进来就写它）
      if (entry.themeKey === "") fresh++;
      this.ensureLayers(box.g, entry);

      this.applyStyle(box, entry, spec, themeKey);
      this.applySize(box, entry);
      this.applyCircle(box, entry);
      this.syncFade(box, entry);

      if (box.depth === 0) continue;
      const parent = byPath.get(parentPathOf(box.path));
      if (parent) this.applyLink(box, parent, entry, spec);
    }

    this.prune(boxes);
    // total 要多扫一遍 DOM，只在记日志时算 —— 这段是折叠动画的每帧路径。
    // writes 是这套渲染唯一的成本指标：它直接等于「这一帧把多少节点的排版作废了」。
    traceLog("paint.all", {
      boxes: boxes.length,
      skipped,
      fresh,
      writes: this.writes,
      total: isTracing() ? svg.querySelectorAll("g.markmap-node").length : undefined,
    });
    return skipped;
  }

  /**
   * 只处理「这一帧真的动了」的节点：折叠/展开的 180ms 动画里每帧调用一次。
   *
   * 和旧版的关键差别是**同步调用 + 元素直给**：
   *
   * - 旧版走 `requestAnimationFrame` 合并，结果是连线比节点晚一帧 ——
   *   节点已经移到新位置，线还画在上一帧的位置，动画看起来就是线在抖/追不上。
   *   现在由 MutationObserver 回调直接调（回调紧跟在 d3 写 transform 之后、
   *   同一帧渲染之前），线与节点同帧落位。
   * - 旧版传的是 path 集合，进来还要全量 querySelectorAll 把 path 换回元素。
   *   现在直接把变了 transform 的 g 传进来，父节点走索引，全程不做 DOM 查询。
   *
   * @param els 本帧 transform 发生变化的节点 g
   */
  paintMoved(els: Iterable<SVGGElement>, spec: ThemeSpec): void {
    if (!this.indexReady) this.buildIndex(els);
    if (this.entries.size === 0 && !this.indexReady) return;

    // 一个节点的连线起点取自**父节点**的位置和卡片宽度：父节点动了、自己没动的那一帧，
    // 它也必须重画，否则线停在上一个位置 —— 就是「飘线」。
    // 以前没暴露是因为 markmap 每帧无条件重写全部节点的 transform，大家被顺带重画了
    // 一遍；现在同值重写被过滤掉（见 MindmapView 的 obs.transform），这条得自己补上。
    // 整片一起动时（折叠动画）子节点本来就在名单里，这个循环不会多出一个元素。
    const targets = new Set<SVGGElement>(els);
    /** 想补但索引里找不到的孩子数（>0 说明索引过期，那些线会停在旧位置） */
    let kidsMissed = 0;
    for (const g of Array.from(targets)) {
      const data = (g as SVGGElement & { __data__?: { children?: unknown[] } }).__data__;
      const kids = data?.children;
      if (!Array.isArray(kids)) continue;
      // 子节点的路径**不是** `父路径.下标`：markmap 的 path 由 `state.id` 拼成，
      // 而 id 是节点自己的编号（折叠/重排后跟下标不是一回事）。
      // 1.18.4 这里写成 `${path}.${i}`，结果一条都没命中 —— 等于什么都没补，
      // 「父动子未动」时线就停在上一帧（用户看到的就是飘线）。
      // 正确做法：问孩子自己的 state.path。
      for (const kid of kids) {
        const cp = (kid as { state?: { path?: unknown } } | null)?.state?.path;
        if (typeof cp !== "string" || cp === "") continue;
        const cg = this.index.get(cp);
        if (cg) targets.add(cg);
        else kidsMissed++;
      }
    }

    // 同一个 g 在一帧里既是子又是父，几何只读一次
    const seen = new Map<SVGGElement, NodeBox | null>();
    const boxOf = (g: SVGGElement): NodeBox | null => {
      const hit = seen.get(g);
      if (hit !== undefined) return hit;
      const box = readNodeBox(g);
      seen.set(g, box);
      if (box) this.index.set(box.path, g);
      return box;
    };

    let movedCount = 0;
    /** 真正重画的线条数：n 与它差得远，说明这一批里大半是「位置没变的下发」 */
    let relinked = 0;
    /** 读不到几何的节点数：这些节点的线只能停在旧位置（飘线的另一种来源） */
    let nogeo = 0;
    for (const g of targets) {
      movedCount++;
      // 快速路径：**正在淡出**的老节点（折叠出去的子树）只同步透明度就退出。
      // 它的 g 正被 markmap 拖向父节点，按 transform 反推出来的路径会被拉成
      // 又长又歪的曲线；保持最后一帧的形状、跟着卡片一起淡掉才自然。
      // 少一次 readNodeBox 也顺便省掉了几次属性读。
      //
      // 判据必须区分「淡出」和「淡入」（靠上次写过的值比）：展开时同一批节点
      // 是 0→1 往上爬，若也走这条冻结路径，线就停在折叠时的位置、卡片已经飞
      // 出去了 —— 这就是「展开时线飘在中间，过一会儿才啪一下归位」。
      const cached = this.entries.get(nodePathOf(g) ?? "");
      if (cached && cached.g === g && cached.linkD !== "") {
        const v: number = readOpacity(cached.fo);
        if (v < 1 && v <= cached.fade) {
          this.writeFade(cached, v);
          continue;
        }
      }

      const box = boxOf(g);
      if (!box) {
        nogeo++;
        continue;
      }

      const entry = this.entryOf(box);
      // 尺寸变了必须在这里补：改一个字走的是 `patch` 通道（只改卡片里那段 HTML，
      // 不重建树），markmap 随后整树 renderData 一遍，卡片会变宽/变窄 ——
      // 而**不会有任何一次全量绘制**。旧版只在「第一次在这个通道见到它」时补尺寸，
      // 于是「文字改长了、卡片还是旧宽度」只能靠一次全量绘制兜底，那一次就是
      // 「改个字整图闪一下」的另一半原因（另一半见 reset() 的注释）。
      //
      // 三个 apply* 各自带「值没变就直接 return」的快路径，所以这段常开是安全的：
      // 折叠动画里 250 个节点每帧走一遍也只有几十次数值比较。
      if (!entry.link || entry.w !== box.w || entry.h !== box.h) {
        // 第一次在这个通道见到它（全量绘制时它还没几何）：只建图层不写尺寸的话，
        // 会得到一堆宽高未设置的 <rect> —— 视觉上就是这张卡片消失了。
        this.ensureLayers(box.g, entry);
        this.applyStyle(box, entry, spec, `${spec.id}|${spec.dark ? 1 : 0}`);
        this.applySize(box, entry);
        // 收放点贴在卡片右沿，宽度一变它就得跟着挪
        this.applyCircle(box, entry);
      }
      this.syncFade(box, entry);

      if (box.depth === 0) continue;
      if (entry.linkD === "" && readOpacity(box.fo) < 1) {
        // 刚出现的节点（展开）还不能量：先让全量绘制把装饰建好
        continue;
      }

      const parentG = this.index.get(parentPathOf(box.path));
      if (!parentG) continue;
      const parent = boxOf(parentG);
      if (!parent) continue;
      if (this.applyLink(box, parent, entry, spec)) relinked++;
    }

    // 折叠动画里每帧都会走到这里，限流记「这一批动了几个节点」。
    // 数值持续接近节点总数就说明「只动了一两个节点」被放大成了全量重画。
    if (isTracing()) {
      traceLogEvery("moved", 500, "paint.moved", {
        n: movedCount,
        links: relinked,
        miss: kidsMissed,
        nogeo,
      });
    }
  }

  /**
   * 兜底建索引：正常情况下 paintAll 已经建好了，走到这里说明动画先于全量绘制开始
   * （视图刚从隐藏状态恢复之类）。拿任何一个节点反查它的父图层，扫一次全量 ——
   * 这条路只会在异常时序上走一次，不进每帧的热路径。
   */
  private buildIndex(els: Iterable<SVGGElement>): void {
    let root: Element | null = null;
    for (const el of els) {
      root = el.parentElement;
      break;
    }
    if (!root) return;
    this.index.clear();
    for (const el of Array.from(root.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const path = nodePathOf(el);
      if (path) this.index.set(path, el);
    }
    this.indexReady = this.index.size > 0;
  }

  /** 一次性读完所有节点几何，供写阶段使用 */
  private collect(svg: SVGSVGElement): {
    boxes: NodeBox[];
    byPath: Map<string, NodeBox>;
    /** 读不到几何的节点数（还没布局 / 尺寸为 0） */
    skipped: number;
  } {
    const boxes: NodeBox[] = [];
    const byPath = new Map<string, NodeBox>();
    const index = new Map<string, SVGGElement>();
    let skipped = 0;
    for (const el of Array.from(svg.querySelectorAll<SVGGElement>("g.markmap-node"))) {
      const box = readNodeBox(el);
      if (!box) {
        skipped++;
        continue;
      }
      boxes.push(box);
      byPath.set(box.path, box);
      index.set(box.path, el);
    }
    // 全量绘制本来就要扫一遍，顺手把索引换成最新的
    this.index = index;
    this.indexReady = index.size > 0;
    return { boxes, byPath, skipped };
  }

  /** 取（或重建）节点缓存。g 被 markmap 重建、元素掉出 DOM 时都要重置。 */
  private entryOf(box: NodeBox): Entry {
    const cached = this.entries.get(box.path);
    if (cached && cached.g === box.g && cached.card?.isConnected) {
      // 同一个 g 里 markmap 仍可能把 foreignObject 换掉（改内容走的就是这条 join）。
      // 缓存里那份引用一旦失效，`syncFadeFor` / `paintMoved` 读透明度会读到
      // 一个脱离文档的元素（永远返回 1），淡出判据就失效了。顺手刷新，成本一次赋值。
      cached.fo = box.fo;
      return cached;
    }

    const g = box.g;
    const entry: Entry = {
      g,
      fo: box.fo,
      shadow: g.querySelector<SVGRectElement>(`:scope > rect.${CLS_SHADOW}`),
      link: g.querySelector<SVGPathElement>(`:scope > path.${CLS_LINK}`),
      card: g.querySelector<SVGRectElement>(`:scope > rect.${CLS_CARD}`),
      circle: g.querySelector<SVGCircleElement>(":scope > circle"),
      w: -1,
      h: -1,
      themeKey: "",
      depth: -1,
      branch: -1,
      linkD: "",
      linkBranch: "",
      linkWidth: -1,
      circleX: Number.NaN,
      circleY: Number.NaN,
      fade: -1,
    };
    this.entries.set(box.path, entry);
    return entry;
  }

  /** 节点被 markmap 移除后，缓存跟着清掉（path 可能被复用） */
  private prune(boxes: NodeBox[]): void {
    if (this.entries.size === 0) return;
    // 刻意不写「数量相同就 return」：删一个又加一个时数量不变、成员变了，
    // 死条目会留到下一次靠 entryOf 的身份检查兜底。250 次 Map.has 换一次确定性。
    const alive = new Set(boxes.map((b) => b.path));
    for (const key of Array.from(this.entries.keys())) {
      if (!alive.has(key)) this.entries.delete(key);
    }
  }

  /**
   * 保证三个自绘元素存在，且 z 序固定为 阴影 → 连线 → 卡片 → markmap 原有内容。
   * 已经有序时只做几次属性比较，不碰 DOM。
   */
  private ensureLayers(g: SVGGElement, entry: Entry): void {
    const shadow = entry.shadow;
    const link = entry.link;
    const card = entry.card;
    if (
      shadow && link && card &&
      shadow.isConnected && link.isConnected && card.isConnected &&
      shadow.nextElementSibling === link &&
      link.nextElementSibling === card
    ) {
      return;
    }

    const anchor = this.anchorOf(g);
    if (!entry.shadow) entry.shadow = this.createElement("rect", CLS_SHADOW) as SVGRectElement;
    if (!entry.link) entry.link = this.createElement("path", CLS_LINK) as SVGPathElement;
    if (!entry.card) entry.card = this.createElement("rect", CLS_CARD) as SVGRectElement;

    // insertBefore 对已存在元素等价于移动，重复插入也能纠正顺序
    g.insertBefore(entry.shadow, anchor);
    g.insertBefore(entry.link, anchor);
    g.insertBefore(entry.card, anchor);
    this.writes += 3;
    entry.circle = g.querySelector<SVGCircleElement>(":scope > circle");
  }

  /** markmap 自己的第一个子元素（连线/卡片都插在它前面） */
  private anchorOf(g: SVGGElement): Element | null {
    for (const child of Array.from(g.children)) {
      const cls = child.classList;
      if (cls.contains(CLS_SHADOW) || cls.contains(CLS_LINK) || cls.contains(CLS_CARD)) continue;
      return child;
    }
    return null;
  }

  private createElement(tag: "rect" | "path", cls: string): SVGElement {
    const el = document.createElementNS(SVG_NS, tag) as SVGElement;
    el.setAttribute("class", cls);
    return el;
  }

  /** 配色：只在主题 / 层级 / 分支变化时写 */
  private applyStyle(box: NodeBox, entry: Entry, spec: ThemeSpec, themeKey: string): void {
    const card = entry.card;
    const shadow = entry.shadow;
    if (!card || !shadow) return;

    const branch: number = this.slotOf(box.path, spec.colors.length);
    if (
      entry.themeKey === themeKey &&
      entry.depth === box.depth &&
      entry.branch === branch
    ) {
      return;
    }
    entry.themeKey = themeKey;
    entry.depth = box.depth;
    entry.branch = branch;

    const style = nodeStyleAt(spec, box.depth, spec.colors[branch % spec.colors.length]);
    const isRoot = box.depth === 0;
    const radius = Math.max(0, Number.parseFloat(spec.radius) || 0);
    const rx = String(isRoot ? radius + 2 : radius);

    card.setAttribute("fill", style.bg);
    card.setAttribute("rx", rx);

    shadow.setAttribute("fill", spec.dark ? "rgba(0,0,0,0.45)" : "rgba(15,23,42,0.10)");
    shadow.setAttribute("rx", rx);
    // 有没有阴影是主题决定的；用 display 开关，opacity 留给淡入淡出（syncFade）
    shadow.style.display = spec.card ? "" : "none";

    // 文字色写在 foreignObject 上，节点内容继承（这个不会被 markmap 冲掉）
    box.fo.style.color = style.fg;
    this.writes += 6;
  }

  /**
   * 让自绘装饰跟着 markmap 的淡入淡出一起变透明。
   *
   * markmap 折叠时把要消失的子树 `transform` 过渡到父节点位置，同时只把
   * **foreignObject**（文字）的 opacity 过渡到 0 —— 我们的卡片 rect、连线、
   * 收放点是自己插进 g 里的，它不知道。于是文字正常淡出，一堆彩色方块和曲线
   * 却继续往父节点"飞"，然后啪一下被删掉；展开时反过来，方块凭空出现再飞出去。
   * 这就是「收放动画看着奇怪」的主要来源。
   *
   * 判据用内联 style.opacity（markmap 就写在这里），读它不触发布局。
   */
  private syncFade(box: NodeBox, entry: Entry): number {
    return this.writeFade(entry, readOpacity(box.fo));
  }

  /** 把透明度写到当前值（同一个值不重复写 DOM） */
  private writeFade(entry: Entry, v: number): number {
    if (entry.fade === v) return v;
    entry.fade = v;

    const text: string = v >= 1 ? "" : String(v);
    let n = 0;
    if (entry.card) {
      entry.card.style.opacity = text;
      n++;
    }
    if (entry.shadow) {
      entry.shadow.style.opacity = text;
      n++;
    }
    if (entry.link) {
      entry.link.style.opacity = text;
      n++;
    }
    if (entry.circle) {
      entry.circle.style.opacity = text;
      n++;
    }
    this.writes += n;

    // v<1 意味着我们把「卡片/线」也写成半透明了 —— 屏幕上就是那一块变淡。
    // 折叠动画里这每帧都会发生几百次，所以限流：只留「最近 200ms 里发生过几次」。
    // 关着日志时 isTracing() 先短路，不进 traceLogEvery 的 Map 查找。
    if (v < 1 && isTracing()) traceLogEvery("fade", 200, "fade.write", { v });
    return v;
  }

  /** 卡片尺寸：只依赖内容宽高，与节点位移无关，所以动画期间零写入 */
  private applySize(box: NodeBox, entry: Entry): void {
    const card = entry.card;
    if (!card) return;
    if (entry.w === box.w && entry.h === box.h) return;
    entry.w = box.w;
    entry.h = box.h;

    const r = cardRect(box);
    card.setAttribute("x", String(r.x));
    card.setAttribute("y", String(r.y));
    card.setAttribute("width", String(r.w));
    card.setAttribute("height", String(r.h));

    if (entry.shadow) {
      const s = cardRect(box, 2);
      entry.shadow.setAttribute("x", String(s.x));
      entry.shadow.setAttribute("y", String(s.y));
      entry.shadow.setAttribute("width", String(s.w));
      entry.shadow.setAttribute("height", String(s.h));
      this.writes += 8;
    } else {
      this.writes += 4;
    }
  }

  /**
   * 折叠圆点：移到卡片右边缘中点，并按 FOLD_SCALE 缩小。
   *
   * 两件事都靠 CSS transform 完成，不改 cx/cy/r —— markmap 每次重渲染都会把
   * 这些属性重写一遍，两边抢写同一个属性就会互相打架。
   *
   * 另外这里顺手补上 markmap 的一个缺口：**节点失去全部孩子后，它既不删掉
   * 那个 `<circle>`，也不把 r 归零**（实测 r 仍然是 6）。于是叶子节点右侧会挂
   * 着一个永远点不出东西的收放点 —— 就是「刚操作过的卡片旁边多出一个小圆点」。
   * 判据必须用节点数据里的 children，不能看 DOM 上的 r。
   */
  private applyCircle(box: NodeBox, entry: Entry): void {
    let circle = entry.circle;
    if (!circle || !circle.isConnected) {
      circle = box.g.querySelector<SVGCircleElement>(":scope > circle");
      entry.circle = circle;
      entry.circleX = Number.NaN;
      entry.circleY = Number.NaN;
      if (circle) {
        // 缩放要绕圆点自身中心，否则会绕着 SVG 原点缩放、整个点飞出去。
        // 写内联样式而不是只靠 styles.css：SVG 元素的 transform-origin 默认是
        // 0 0（不是 CSS 那套 50% 50%），样式表一旦没匹配上，位置就会错得很离谱；
        // 内联样式优先级最高，主题改不动它。
        circle.style.setProperty("transform-box", "fill-box");
        circle.style.setProperty("transform-origin", "center");
      }
    }
    if (!circle) return;

    // 判据是节点数据里的 children，不是 DOM 上的 r：
    // markmap 在节点失去全部孩子后既不删 circle、也不把 r 归零（实测仍是 6），
    // 只按 r 判断会把它当成「还有孩子」，叶子卡片右侧就挂着一个点不动的残留点。
    //
    // 这里直接读 style.display 而不是缓存一个布尔：缓存会和 reset() 之后
    // 重新拿到的旧 DOM 对不上（实测过，隐藏了就再也不会显回来）。
    const hidden: boolean = circle.style.display === "none";
    if (!box.hasChildren) {
      if (!hidden) {
        circle.style.display = "none";
        this.writes++;
      }
      return;
    }
    if (hidden) {
      circle.style.display = "";
      this.writes++;
    }

    const nativeCx = Number.parseFloat(circle.getAttribute("cx") ?? "");
    const nativeCy = Number.parseFloat(circle.getAttribute("cy") ?? "");
    if (!Number.isFinite(nativeCx) || !Number.isFinite(nativeCy)) return;

    const offset = circleOffset(box, nativeCx, nativeCy);
    if (offset.x === entry.circleX && offset.y === entry.circleY) return;
    entry.circleX = offset.x;
    entry.circleY = offset.y;

    // 变换原点在圆点自身中心，所以 translate 之后再做 scale 只改大小、不改位置：
    // 直径 12 → 8.4，圆心仍精确落在卡片右沿（实测，见 .tmp 的 paint 用例）。
    circle.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${FOLD_SCALE})`;
    this.writes++;
  }

  /** 自绘连线：父卡片右边缘中点 → 子卡片左边缘中点 */
  private applyLink(
    box: NodeBox,
    parent: NodeBox,
    entry: Entry,
    spec: ThemeSpec,
  ): boolean {
    const link = entry.link;
    if (!link) return false;

    // 整块平移中的块根：这根线的坐标是拿 `transform` 属性算的，不含拖动写的
    // CSS `translate`，画出来必然是错的（见 shiftedRoots 的注释）。这里**只保证
    // 它是隐藏的**，既不写 d、也不更新缓存 —— 松手重建之后几何变了，d 自然会
    // 重算；判据消失后下面那句「保证可见」也会把它接回来，不需要谁记得还。
    if (this.shiftedRoots.has(box.g)) {
      if (link.style.display !== "none") {
        link.style.display = "none";
        this.writes++;
      }
      return false;
    }

    // 拖动时会把这根线 `display: none` 摘掉（见 edit/drag.ts）。而 markmap 重建
    // 之后 d3 很可能**复用同一个 g 与同一根 path**（key 没变）—— 那个 display 会留着，
    // 我们的绘制又只写 d / stroke、从不碰 display，于是这根线永久消失。
    // 所以凡是我们画过的线，都保证它是可见的（读一次 style.display 比写一次便宜）。
    if (link.style.display !== "") {
      link.style.removeProperty("display");
      this.writes++;
    }

    const branch: string = spec.colors[this.slotOf(box.path, spec.colors.length) % spec.colors.length];
    const d = linkPath(box, parent);
    if (entry.linkD === d && entry.linkBranch === branch && entry.linkWidth === spec.linkWidth) {
      return false;
    }
    entry.linkD = d;
    entry.linkBranch = branch;
    entry.linkWidth = spec.linkWidth;

    link.setAttribute("d", d);
    link.setAttribute("fill", "none");
    link.setAttribute("stroke", branch);
    link.setAttribute("stroke-width", String(spec.linkWidth));
    link.setAttribute("stroke-linecap", "round");
    this.writes += 5;
    return true;
  }

  /**
   * 核对「DOM 里那根线」和「按当前几何应该画的那根线」差多少 —— 只给日志用。
   *
   * 这是「飘线」唯一能自证的指标：连线是 `f(子卡片, 父卡片)` 的纯函数，
   * 只要拿当前的 `transform` / `width` / `height` 重算一遍，和 `d` 属性比数字，
   * 差值就是**屏幕上真实看到的那截偏差**（用户单位；乘画布 scale 就是像素）。
   *
   * 几个刻意的排除：
   * - 根节点没有线；
   * - 正在淡出（`fo.opacity < 1`）的节点：折叠时我们**故意**冻结形状让它跟着淡掉，
   *   不是 bug，算进去只会把真问题淹掉；
   * - 读不到几何的节点单独计数（`skip`）—— 这类节点画不出线，
   *   `skip` 长期不为 0 就说明有节点永远量不出宽高。
   *
   * 只在开日志时调用，成本 ≈ 一次全量属性读。
   */
  measureDrift(svg: SVGSVGElement): DriftReport {
    const nodes: SVGGElement[] = Array.from(
      svg.querySelectorAll<SVGGElement>("g.markmap-node"),
    );
    const boxes = new Map<string, NodeBox>();
    for (const g of nodes) {
      const box = readNodeBox(g);
      if (box) boxes.set(box.path, box);
    }

    const report: DriftReport = {
      checked: 0,
      skipped: nodes.length - boxes.size,
      frozen: 0,
      hidden: 0,
      shifted: 0,
      max: 0,
      worst: [],
    };

    for (const g of nodes) {
      const path = nodePathOf(g);
      if (!path) continue;
      const box = boxes.get(path);
      if (!box || box.depth === 0) continue;
      const link = g.querySelector<SVGPathElement>(`:scope > path.${CLS_LINK}`);
      if (!link) continue;
      // 正在整块拖动的块根：线是我们**故意**藏掉的（见 shiftedRoots），
      // 算进 hidden 会让这个唯一的「线不见了」告警在拖动时一直响。
      if (this.shiftedRoots.has(g)) {
        report.shifted++;
        continue;
      }
      // 被摘掉的线：只有拖动会写 display:none，正常应该在重建的 paintAll 里还原。
      // 偏差计算看不出它（d 可能还是对的），所以必须单独数 —— 「线不见了」
      // 和「线歪了」是两种完全不同的 bug。
      if (link.style.display === "none") {
        report.hidden++;
        continue;
      }
      if (readOpacity(box.fo) < 1) {
        report.frozen++;
        continue;
      }
      const parent = boxes.get(parentPathOf(path));
      if (!parent) continue;

      report.checked++;
      const want: string = linkPath(box, parent);
      const have: string = link.getAttribute("d") ?? "";
      if (want === have) continue;
      const d: number = pathDelta(want, have);
      if (d > report.max) report.max = d;
      if (d > 1) {
        const label: string = (g.textContent ?? "").trim().slice(0, 10) || path;
        report.worst.push(`${label} ${d.toFixed(1)}`);
      }
    }
    report.worst.sort((a, b) => Number(b.split(" ")[1]) - Number(a.split(" ")[1]));
    return report;
  }
}

export interface DriftReport {
  /** 真正核对过的线条数 */
  checked: number;
  /** 读不到几何的节点数 */
  skipped: number;
  /** 淡出中、刻意冻结的节点数 */
  frozen: number;
  /** 被 `display: none` 摘掉、还没还原的线条数（「线不见了」） */
  hidden: number;
  /** 正在整块拖动、线被刻意藏起来的块根数（不是问题，单独计数） */
  shifted: number;
  /** 最大偏差（用户单位，乘画布 scale 即像素） */
  max: number;
  /** 偏差 >1 的节点（`名字 12.3`），已按偏差降序 */
  worst: string[];
}

/** 两条路径字符串的数字差（逐参数取最大绝对差）；结构不一样就当成最大偏差 */
function pathDelta(a: string, b: string): number {
  if (b === "") return MAX_DELTA;
  const na: string[] = a.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const nb: string[] = b.match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (na.length === 0 || na.length !== nb.length) return MAX_DELTA;
  let max = 0;
  for (let i = 0; i < na.length; i++) {
    const d: number = Math.abs(Number(na[i]) - Number(nb[i]));
    if (!Number.isFinite(d)) return MAX_DELTA;
    if (d > max) max = d;
  }
  return max;
}

/** 「线没了」和「线歪了 400 像素」在日志里要能区分：前者给一个大到不可能是几何误差的值 */
const MAX_DELTA = 9999;
