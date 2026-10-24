/**
 * 节点拖拽：把节点拖到别处改变父子关系（XMind 式）。
 *
 * 交互约定（对齐 XMind 的手感）：
 * - **左键按住节点拖动** → 改变父子关系；按下不动就是「选中」，位移超过阈值才算拖
 * - **右键留给菜单**，这里不碰 contextmenu
 * - 拖到目标卡片**中部** → 成为目标的子节点
 * - 拖到目标卡片**上沿** → 排在目标前面（兄弟）
 * - 拖到目标卡片**下沿** → 排在目标后面（兄弟）
 *
 * 四个必须处理的坑：
 * 1. **d3-zoom 会抢走 mousedown**。markmap 用 d3-zoom 绑了画布平移，
 *    在节点上按下会变成拖画布。所以命中节点时要拦掉 mousedown 的冒泡。
 * 2. **不能拖进自己的子树**。用 markmap 自带的孩子索引路径（"0.2.1"）判断，
 *    后代路径一定以 `源路径 + "."` 开头，比算几何范围可靠。
 * 3. **拖拽结束不能触发 click / dblclick**，否则松手会顺带选中
 *    （行号已经变了，选中的是错的节点）或直接进了编辑态。
 * 4. **子树要整块跟着走**（1.18.4）。markmap 的节点 g 是**扁平**的 —— 全部由
 *    `this.g.selectAll().data()` 挂在同一个 g 下，父子关系只体现在 `data-path`
 *    和 transform 上。所以只改拖动根的位置，整棵子树的卡片会留在原地，自绘连线
 *    被拉成一片长条，看上去就是「飘线」。
 *
 *    做法：给整棵子树的每个 g 写一份 CSS `translate`（独立属性，和 markmap 写的
 *    `transform` 属性叠加、互不覆盖），于是整块按同一个位移平移；块内的自绘连线
 *    画在**子节点自己的 g** 里、坐标相对子节点，跟着同量平移，形状正好还是对的。
 *    唯一会歪的是「块根 → 它的父」那几根（父节点在块外、不会动，而且 linkPath
 *    读的是 `transform` 属性、**不含** CSS translate），必须一直藏到重建为止 ——
 *    视觉上就是「这一整块只接一根线过去」。多选拖动有多个块根，每个都要藏。
 *
 *    藏线不是「摘一次」而是一个**条件**：`applyLink` 里有一句「凡我画过的线都
 *    保证可见」的兜底（防 d3 复用元素后线永久消失），谁重绘谁就会把线接回来。
 *    所以这里同时调 `onShift(roots, true)` 让绘制层记住「这几块在平移中」，
 *    平移结束（重建收尾 / 取消 / 超时）才注销。只写 `display:none` 的版本实测
 *    是这样坏掉的：拖动开始提层 → childList → 观察器判成结构变化 → 全图重绘 →
 *    线回来了，之后近 2 秒的拖动全程带着一根线。
 *
 *    松手后那份 `translate` 要**等重建收尾才清**：清早了块弹回原位再跳过去，
 *    清晚了（或 d3 复用了同一个 g）卡片就停在鼠标处、线从旧父节点斜着拉过来 ——
 *    后者就是现场日志里 `drag.shift.gone ms=672` 那段，也是「飘线」的来源之一。
 *
 *    用 CSS `translate` 而不是改 transform 属性还有两个额外好处：
 *    ① MutationObserver 的 transform 分支不会因此被唤醒（我们只听 transform/class/style，
 *       g 的 style 变化在观察器里被显式忽略，见 MindmapView）；
 *    ② markmap 完全不知道这回事，不会在下一帧把位移抹掉。
 */

import type { SrcRef } from "../types";
import type { DropMode } from "./move";
import { traceLog } from "../render/trace";

/** 超过这个位移才算拖拽，否则当成普通点击 */
const DRAG_THRESHOLD = 5;

export interface DragCallbacks {
  /** 取节点的源坐标；根节点返回 null（文件名节点不可拖） */
  srcOf: (g: SVGGElement) => SrcRef | null;
  /**
   * 这次拖动要一起搬走哪些行。
   *
   * 单选就是它自己；如果它在多选集里，View 会返回整组的「顶层成员」
   * （被别的选中节点子树覆盖的那些已经剔掉了）。拖动时整组一起平移，
   * 才对得上松手后 groupOf 一次性搬走的那一批。
   */
  groupLines: (line: number) => number[];
  /**
   * 松手提交。
   *
   * 返回 true 表示「已经发出写入、接下来会发生一次重建」—— 那种情况下块要
   * **保持**在鼠标位置，等重建把旧 DOM 换掉，否则会先弹回原位再跳到新位置。
   * 返回 false（落在空白、多行节点被拦、内容没变化）就得当场弹回去。
   */
  onDrop: (srcLine: number, targetLine: number, mode: DropMode) => boolean;
  /**
   * 把这一块提到父容器末尾（SVG 没有 z-index，谁在后面谁盖住谁）。
   *
   * 交给 View 做，因为**这批 childList 记录必须被吞掉**：观察器会把
   * 「`<g>` 从同一个父里挪到末尾」当成结构变化 → 全图重绘，而重绘会把刚刚
   * 摘掉的对外连线接回去（见下面 `onShift`）。现场日志：
   * `drag.links n=1` → 170ms 后 `paint.all boxes=257` → 之后近 2 秒的拖动全程带线。
   *
   * 早期版本在这里直接 `parent.appendChild(g)`，并在注释里写「只在开始拖动时
   * 发生一次，代价可以忽略」—— 代价不是性能，是它把自己的线弄回来了。
   */
  raiseNodes: (els: SVGGElement[]) => void;
  /**
   * 登记 / 注销「整块平移中」的块根。
   *
   * 只在 DOM 上摘 `display` 不够：`NodePainter.applyLink` 有一句兜底
   * 「凡我画过的线都保证可见」（防 d3 复用元素后线永久消失），任何一次重绘都会
   * 把线接回去 —— 包括拖动途中由别的路径触发的重绘（改完字马上拖、markmap 的
   * 收尾重排、切主题）。所以状态得让绘制层知道，由它按条件跳过。
   */
  onShift: (roots: SVGGElement[], on: boolean) => void;
}

interface Target {
  g: SVGGElement;
  mode: DropMode;
}

export class DragController {
  private readonly svg: SVGSVGElement;
  private readonly container: HTMLElement;
  private readonly cb: DragCallbacks;

  private layer: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;
  private line: HTMLDivElement | null = null;

  private origin: SVGGElement | null = null;
  private originSrc: SrcRef | null = null;
  /** 被拖动的那一整块（根 + 全部后代）：整块平移 */
  private members: SVGGElement[] = [];
  /**
   * 「块根」原来那几根「父 → 根」的连线，拖动期间全部摘掉。
   *
   * 必须是**数组**：多选拖动时 `roots` 可能有好几个，每个根各有一根对外连线。
   * 早期版本只摘 `origin` 那一根 —— 多选拖动时其余几根从原父节点一直拉到鼠标处，
   * 屏幕上就是好几根没有起点的斜线（「有时候会飘线」）。
   */
  private outerLinks: SVGPathElement[] = [];

  private startX = 0;
  private startY = 0;
  private active = false;
  private target: Target | null = null;
  /** 块根（多选时多个），拖动开始时摘掉它们各自的对外连线 */
  private rootEls: SVGGElement[] = [];
  /** 本次拖拽的候选目标，按下时算一次，避免每帧 querySelectorAll */
  private candidates: SVGGElement[] = [];
  /** 松手后的「等重建」轮询代次：settleNow / 下一次拖动都会让它作废 */
  private shiftToken = 0;

  constructor(svg: SVGSVGElement, container: HTMLElement, cb: DragCallbacks) {
    this.svg = svg;
    this.container = container;
    this.cb = cb;

    svg.addEventListener("mousedown", this.blockOnNode, true);
    svg.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    // 兜底收尾：窗口失焦、指针被系统打断（拖到窗口外松手）时收不到 pointerup，
    // 而按下时锁了选区 —— 不收拾的话整页文字会一直不可选。
    window.addEventListener("blur", this.onAbort);
    window.addEventListener("pointercancel", this.onAbort);
  }

  destroy(): void {
    this.svg.removeEventListener("mousedown", this.blockOnNode, true);
    this.svg.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("blur", this.onAbort);
    window.removeEventListener("pointercancel", this.onAbort);
    this.reset(false);
    this.layer?.remove();
    this.layer = null;
    this.box = null;
    this.line = null;
  }

  // -------------------------------------------------------------------------

  private onAbort = (): void => {
    if (this.origin) this.reset(false);
  };

  /** 命中节点时掐断 mousedown，否则 d3-zoom 会把它当成「拖画布」 */
  private blockOnNode = (e: MouseEvent): void => {
    const g = this.nodeAt(e.target as Element);
    if (g) e.stopPropagation();
  };

  private onPointerDown = (e: PointerEvent): void => {
    // 0 = 左键。右键留给菜单（不拦 contextmenu），中键留给画布自己的行为。
    if (e.button !== 0) return;
    const el = e.target as Element;
    // 链接、折叠圆点、代码复制按钮各有自己的用途
    if (el.closest("a") || el.closest("circle") || el.closest(".copy-code-button")) return;

    const g = this.nodeAt(el);
    if (!g) return;
    const src = this.cb.srcOf(g);
    if (!src) return; // 根节点不可拖
    // 裸块没有代理行，层级只能靠围栏自己的缩进（0～3 格）—— 拖动必然把它缩到 4 格，
    // 那一段代码就退化成「缩进代码块」，``` 变成字面量。所以裸块按不动。
    // 自由块（上面有 `<!-- obmind:block -->`）可以拖：缩进改的是代理行，块本体不动。
    if (src.blockNode === "bound") return;

    // 掐断 pointerdown 的传播，免得某些版本的 d3-zoom 拿它来起手拖画布
    e.stopPropagation();

    this.origin = g;
    this.originSrc = src;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.active = false;
    this.target = null;

    // 按下就锁选区：否则拖出 5px 阈值之前，浏览器已经开始选文字了，
    // 松手时页面上留着一片蓝色高亮。单击（没拖动）也会在 reset 里立刻恢复。
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";

    // 整棵子树 = 根 + 所有 path 以「根路径.」开头的节点。
    // 用 path 而不是几何范围：markmap 的 g 是扁平的，path 是唯一可靠的父子依据，
    // 而且路径是层级编号（"1.2.3"），不会出现 "1.2" 误吞 "1.20" 的情况。
    const all = Array.from(this.svg.querySelectorAll<SVGGElement>("g.markmap-node"));
    const roots = new Set<string>();
    const rootPath = pathOf(g);
    if (rootPath !== "") roots.add(rootPath);
    // 多选组：View 给的「顶层成员」也要一起走，否则松手时整组跳走、拖动时只飞了一块
    for (const line of this.cb.groupLines(src.line)) {
      if (line === src.line) continue;
      const el = all.find((n) => this.cb.srcOf(n)?.line === line);
      const p = el ? pathOf(el) : "";
      if (p !== "") roots.add(p);
    }

    const members = new Set<SVGGElement>();
    /** 本次拖动的各个块根（多选时不止一个） */
    const memberRoots: SVGGElement[] = [];
    for (const n of all) {
      const p = pathOf(n);
      if (p === "") continue;
      for (const r of roots) {
        if (p === r || p.startsWith(r + ".")) {
          members.add(n);
          if (p === r) memberRoots.push(n);
          break;
        }
      }
    }
    if (members.size === 0) members.add(g);
    if (memberRoots.length === 0) memberRoots.push(g);
    this.members = Array.from(members);
    this.rootEls = memberRoots;
    // 自己 + 自己的整棵子树都不能当目标
    this.candidates = all.filter((n) => !members.has(n));
    // 「拖动时飘线」的诊断入口：members 应该正好是「根 + 全部后代」。
    // 少了成员 = 块内有卡片没跟着走，屏幕上就是线被拉长；多了成员 = 误吞了别人的节点。
    // traceLog("drag.pick", {
    //   path: rootPath,
    //   members: this.members.length,
    //   roots: memberRoots.length,
    //   total: all.length,
    // });
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.origin) return;

    if (!this.active) {
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.active = true;
      this.beginDrag();
      // 拖拽期间别顺手选中卡片文字（pointerdown 不能 preventDefault，
      // 那会掐掉后续的 click/dblclick，双击编辑就废了）
      document.body.style.userSelect = "none";
    }

    e.preventDefault();
    this.pan(e.clientX - this.startX, e.clientY - this.startY);
    this.target = this.hitTest(e.clientX, e.clientY);
    this.renderHint();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const originSrc = this.originSrc;
    const target = this.target;
    const wasActive = this.active;
    const members = this.members;
    const roots = this.rootEls;
    const outerLinks = this.outerLinks;

    // 先收掉提示层与 class（视觉上不该留在屏幕上），块的位移留到 onDrop 之后决定
    this.reset(true);

    if (!wasActive || !originSrc || !target) {
      this.clearShift(members, roots, false, outerLinks);
      return;
    }

    // 拖拽结束后别让这次松手变成 click / dblclick
    e.preventDefault();
    e.stopPropagation();
    // pointerup 上的 preventDefault 拦不住 click（click 由 down+up 合成），
    // 而拖动之后触发的 click 会按**旧行号**去选中节点 —— 位置已经变了，
    // 选中的就是错的节点。这里显式吞掉紧跟其后的那一次 click。
    swallowNextClick();

    const tgtSrc = this.cb.srcOf(target.g);
    const willRebuild = tgtSrc ? this.cb.onDrop(originSrc.line, tgtSrc.line, target.mode) : false;
    // 会重建：块先留在鼠标处，等 setData 把这批 g 换掉（新 g 上没有任何位移）。
    // 不重建：当场弹回原位，否则卡片会停在鼠标底下不走了。
    // rebuild=false 但块确实换了位置 → 卡片会弹回旧位置，看起来就是「拖了没反应 + 线乱跳」。
    // traceLog("drag.drop", {
    //   line: originSrc.line,
    //   to: tgtSrc?.line,
    //   mode: target.mode,
    //   rebuild: willRebuild,
    //   members: members.length,
    // });
    this.clearShift(members, roots, willRebuild, outerLinks);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.origin) this.reset(false);
  };

  // -------------------------------------------------------------------------

  private nodeAt(el: Element): SVGGElement | null {
    return el.closest("g.markmap-node") as SVGGElement | null;
  }

  /** 进入拖动态：整块标记 + 摘掉各块根对外那几根旧线 + 提到最上层 */
  private beginDrag(): void {
    this.ensureLayer();
    for (const g of this.members) g.classList.add("obmind-dragging");
    // SVG 没有 z-index，谁在后面谁盖住谁。拖动块压在目标卡片上时会被目标盖掉大半，
    // 看上去就像「拖着拖着不见了」。markmap 的节点 g 是扁平的兄弟节点，
    // 依次挪到父容器末尾就等于「提到最上层」，相对顺序保持不变。
    this.cb.raiseNodes(this.members);

    // 每个块根各有一根「父 → 根」的线。块整块平移之后，这根线的两端对不上了
    // （父节点在块外没动；而且 linkPath 读的是 transform 属性、不含 CSS translate），
    // 先摘掉。摘掉之后**还要登记**：只写 display 的话，任何一次重绘都会把它接回来。
    const links: SVGPathElement[] = [];
    for (const root of this.rootEls) {
      const ext = root.querySelector<SVGPathElement>(":scope > path.obmind-node-link");
      // 没有线也要登记：这个节点可能是刚新建的（图层还没画出来），
      // 一旦有人在这期间绘制，就会给它补出一根按旧位置算的线。
      if (ext) {
        ext.style.display = "none";
        links.push(ext);
      }
    }
    this.outerLinks = links;
    this.cb.onShift(this.rootEls, true);
    // traceLog("drag.links", { n: links.length, roots: this.rootEls.length });
  }

  /**
   * 整块平移。
   *
   * CSS 的 px 在 SVG 元素上是**用户单位**，而画布被 d3-zoom 缩放过，
   * 所以要除以当前比例，否则 5 倍缩放下块会跑得比鼠标快 5 倍。
   */
  private pan(dx: number, dy: number): void {
    const k = zoomOf(this.svg);
    const shift = `${dx / k}px ${dy / k}px`;
    for (const g of this.members) g.style.setProperty("translate", shift);
  }

  /**
   * 收掉整块的位移，并按需把「平移中」的登记与对外线撤掉。
   *
   * @param roots 本次的块根（多选时不止一个）
   * @param keep 重建在路上：先别清。清掉会看到「块弹回原位」然后再跳到新位置，
   *             而 setData 会把这批 g 整个换掉，新元素天然没有位移。
   *             兜底：万一重建没发生（写盘失败、或落到同一位置被判 none），
   *             900ms 后还是要清 —— 现场日志里 rebuild 最慢一次 478ms。
   * @param links 拖动开始时摘掉的对外线。**重建成功时不用还**：`applyLink` 会在
   *             判据消失后自己把它接回来（见 painter 的 shiftedRoots）。
   *             但重建没来（超时兜底）时必须还 —— 块回到原位了，线也该在。
   */
  private clearShift(
    members: SVGGElement[],
    roots: SVGGElement[],
    keep: boolean,
    links: SVGPathElement[],
  ): void {
    const token = ++this.shiftToken;
    const wipe = (): void => {
      for (const g of members) g.style.removeProperty("translate");
      this.cb.onShift(roots, false);
    };
    if (!keep) {
      wipe();
      this.restoreOuterLinks(links);
      return;
    }
    const t0 = performance.now();
    const tick = (): void => {
      // 重建已经收尾（View 调了 settleNow）或又起了一次拖动：这一轮作废。
      // 登记与位移由 View 在重建收尾统一处理（它会保留「正在拖的那一块」）。
      if (token !== this.shiftToken) return;
      // 全部脱离文档 = 已经被 setData 换掉，什么都没必要做了
      if (members.every((g) => !g.isConnected)) {
        // traceLog("drag.shift.gone", { ms: Math.round(performance.now() - t0), n: members.length });
        return;
      }
      if (performance.now() - t0 > 900) {
        // 兜底清掉了：说明「说要重建」但重建没来（写盘失败 / 被判成 none）。
        // 这一刻卡片会从鼠标处弹回旧位置 —— 看着像「拖了没反应」。
        // traceLog("drag.shift.timeout", { n: members.length });
        wipe();
        this.restoreOuterLinks(links);
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }

  /**
   * 重建收尾了：块已经被重画过，别再等旧元素「消失」。
   *
   * 不能只靠 `isConnected` 判断 —— d3 重建时若 key 没变，会**复用同一个 g**，
   * 那个元素永远「连着」，于是轮询要空转到 900ms 超时（现场日志 `ms=672`），
   * 期间块上的 `translate` 还在，卡片停在鼠标处、线被拉斜。
   * 位移本身由 View 的 sweepDragShift 统一清（它扫全图，比这里按名单清更彻底）。
   */
  settleNow(): void {
    this.shiftToken++;
  }

  /**
   * 「正在拖」的那一批成员 / 块根；没在拖（松手了、取消了）就是空。
   *
   * 重建收尾的清扫（清 `translate`、清「平移中」登记）必须跳过它们：
   * 用户松手后立刻抓下一个节点时，上一次的重建正好在这时收尾 —— 无条件全清
   * 会把正在拖的那一块当场拽回原地，屏幕上就是「拖到一半跳回去」。
   */
  liveMembers(): SVGGElement[] {
    return this.origin && this.active ? this.members : [];
  }

  liveRoots(): SVGGElement[] {
    return this.origin && this.active ? this.rootEls : [];
  }

  /**
   * 把摘掉的线接回去。
   *
   * 只对**还在文档里**的元素生效：重建之后旧 g 通常已经被换掉，
   * 往一个死元素上写 style 毫无意义（真正那根线由 paintAll 重画）。
   */
  private restoreOuterLinks(links: SVGPathElement[]): void {
    for (const link of links) {
      if (!link.isConnected) continue;
      link.style.removeProperty("display");
    }
  }

  /**
   * 目标节点的**卡片外框**（屏幕坐标）。
   *
   * 判定必须用卡片而不是 foreignObject：foreignObject 只是文字盒，卡片左右还各有
   * 16px 内边距，按文字盒判定的话这些区域点上去毫无反应，「拖不准」就是这么来的。
   * 卡片是节点 g 内的自绘 rect，getBoundingClientRect 已经把画布缩放与平移算进去了
   * （也包括拖动时我们写在 g 上的 CSS translate）。
   */
  private cardBoxOf(g: SVGGElement): DOMRect | null {
    const card = g.querySelector<SVGRectElement>(":scope > rect.obmind-node-card");
    const el: Element = card ?? g.querySelector("foreignObject") ?? g;
    const r: DOMRect = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return r;
  }

  /** 找鼠标下方的目标节点，并按纵向位置决定「子节点 / 前面 / 后面」 */
  private hitTest(x: number, y: number): Target | null {
    let best: Target | null = null;
    let bestArea = Infinity;

    for (const g of this.candidates) {
      const r = this.cardBoxOf(g);
      if (!r) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;

      // 多个节点矩形重叠时取面积最小的（通常是真正压在鼠标下的那个）
      const area = r.width * r.height;
      if (area >= bestArea) continue;
      bestArea = area;

      const rel = (y - r.top) / r.height;
      const mode: DropMode = rel < 0.3 ? "before" : rel > 0.7 ? "after" : "child";
      best = { g, mode };
    }
    return best;
  }

  private ensureLayer(): void {
    if (this.layer) return;
    const layer = document.createElement("div");
    layer.className = "obmind-drop-layer";

    const box = document.createElement("div");
    box.className = "obmind-drop-box";
    const line = document.createElement("div");
    line.className = "obmind-drop-line";

    layer.append(box, line);
    this.container.appendChild(layer);
    this.layer = layer;
    this.box = box;
    this.line = line;
  }

  private renderHint(): void {
    const box = this.box;
    const line = this.line;
    if (!box || !line) return;

    if (!this.target) {
      box.style.display = "none";
      line.style.display = "none";
      return;
    }

    const r = this.cardBoxOf(this.target.g);
    if (!r) {
      box.style.display = "none";
      line.style.display = "none";
      return;
    }
    const base = this.container.getBoundingClientRect();
    const left = r.left - base.left;
    const top = r.top - base.top;

    if (this.target.mode === "child") {
      // 描边框正好压在卡片外沿：box 从外扩 2px 起算，与 2px 的 border 严丝合缝
      box.style.display = "block";
      box.style.left = `${left - 2}px`;
      box.style.top = `${top - 2}px`;
      box.style.width = `${r.width + 4}px`;
      box.style.height = `${r.height + 4}px`;
      line.style.display = "none";
    } else {
      // 前后插入：横线贴在卡片上下沿的外侧（落在兄弟间的空隙里，读起来就是"插在这"）
      box.style.display = "none";
      line.style.display = "block";
      line.style.left = `${left}px`;
      line.style.width = `${r.width}px`;
      line.style.top = `${this.target.mode === "before" ? top - 4 : top + r.height + 1}px`;
    }

  }

  /**
   * @param keepShift 见 clearShift
   */
  private reset(keepShift: boolean): void {
    const members = this.members;
    const roots = this.rootEls;
    if (members.length > 0) {
      for (const g of members) g.classList.remove("obmind-dragging");
      if (!keepShift) for (const g of members) g.style.removeProperty("translate");
    }
    // 「平移中」的登记要一起撤 —— 否则 Escape 取消一次之后，那个块根的线就
    // 再也不画了（applyLink 会一直按 shift 跳过）。
    // keepShift（松手、等重建）时交给 clearShift / 重建收尾处理。
    if (!keepShift) {
      this.cb.onShift(roots, false);
      this.restoreOuterLinks(this.outerLinks);
    }
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    this.origin = null;
    this.originSrc = null;
    this.active = false;
    this.target = null;
    this.members = [];
    this.rootEls = [];
    this.candidates = [];
    this.outerLinks = [];
    if (this.box) this.box.style.display = "none";
    if (this.line) this.line.style.display = "none";
  }
}

/**
 * 吞掉紧接着派发的那个 click。
 *
 * 用 capture 拦一次最省事；setTimeout(0) 兜底移除 ——
 * 万一浏览器这次没派发 click，也不会把用户的下一次点击一起吃掉。
 */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("click", swallow, true);
  window.setTimeout(() => document.removeEventListener("click", swallow, true), 0);
}

/** markmap 给每个节点挂的孩子索引路径，如 "0.2.1" */
function pathOf(g: SVGGElement): string {
  const data = (g as SVGGElement & { __data__?: { state?: { path?: string } } }).__data__;
  const path: string | undefined = data?.state?.path;
  return typeof path === "string" ? path : "";
}

/** 当前画布缩放；d3-zoom 把 transform 存在 svg 节点的 __zoom 上 */
function zoomOf(svg: SVGSVGElement): number {
  const z = (svg as SVGSVGElement & { __zoom?: { k?: number } }).__zoom;
  const k: number | undefined = z?.k;
  return typeof k === "number" && k > 0 ? k : 1;
}
