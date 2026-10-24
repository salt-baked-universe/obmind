/**
 * 节点原地编辑框。
 *
 * 为什么是浮层而不是直接给节点内容加 contenteditable：
 * markmap 用 `foreignObject.firstChild.scrollWidth/scrollHeight` 测量节点尺寸，
 * 往里塞任何输入元素都会把布局撑歪；而且它每次 render 都会重建 foreignObject
 * 的内部 DOM，contenteditable 会连同光标一起被冲掉。
 *
 * 所以编辑框挂在画布 div 上（absolute 定位），位置与大小从**卡片外框**的屏幕矩形换算
 * （卡片左右内边距大，只盖文字盒会露出两层边），再用 transform: scale(k) 抵消画布缩放——
 * 字号、行高、换行位置都和卡片里完全一致。
 */

import type { EditorAction } from "../types";
import type { ThemeSpec } from "../theme";
import { isTracing, traceLogEvery } from "../render/trace";

export type { EditorAction } from "../types";

export interface InlineEditorOptions {
  container: HTMLElement;
  target: SVGGElement;
  value: string;
  spec: ThemeSpec;
  /**
   * 打开时全选。
   *
   * 现在所有入口都传 true（双击 / Enter / F2 / 空格 / 新建节点）：节点的「改字」
   * 基本是整句重写，带选区进来第一个字符就能覆盖全部；想插字按一下 ←/→ 即可。
   */
  selectAll?: boolean;
  onFinish: (action: EditorAction, value: string) => void;
}

export interface InlineEditorHandle {
  /** 关闭并清理（不触发 onFinish） */
  close: () => void;
  /** 画布缩放/尺寸变化后重新对齐 */
  reposition: () => void;
}

/**
 * 编辑框的最小宽度（按汉字格数算）。
 *
 * 7 格是实测出来的：短到「新节点」这种占位文案时，编辑框仍然能横着放下
 * 「新建一个子节点」这样的半句话，不会刚敲四个字就折行、把卡片顶高。
 */
const MIN_EDIT_COLS = 7;

/**
 * 卡片在文字盒四周的内边距（节点局部单位）。
 * 卡片以文字盒为中心对称外扩，所以直接用宽高差的一半，不必去读 x/y 属性。
 * 属性缺失（例如卡片还没画出来）时退回 0，编辑框就只盖文字，行为与旧版一致。
 */
function cardPad(
  fo: SVGForeignObjectElement,
  card: SVGRectElement | null,
): { x: number; y: number } {
  const fw: number = Number.parseFloat(fo.getAttribute("width") ?? "0");
  const fh: number = Number.parseFloat(fo.getAttribute("height") ?? "0");
  const cw: number = Number.parseFloat(card?.getAttribute("width") ?? "0");
  const ch: number = Number.parseFloat(card?.getAttribute("height") ?? "0");
  if (!(cw > fw) || !(ch > fh)) return { x: 0, y: 0 };
  return { x: (cw - fw) / 2, y: (ch - fh) / 2 };
}

export function openInlineEditor(options: InlineEditorOptions): InlineEditorHandle | null {
  const { container, target, spec } = options;
  const fo = target.querySelector<SVGForeignObjectElement>(":scope > foreignObject");
  if (!fo) return null;

  const card = target.querySelector<SVGRectElement>(":scope > rect.obmind-node-card");
  const ta = document.createElement("textarea");
  ta.className = "obmind-inline-editor";
  ta.value = options.value;
  ta.spellcheck = false;
  ta.setAttribute("rows", "1");
  // 字体必须逐个从节点自身取：markmap 的 --markmap-font 是 CSS 变量，
  // 直接写 var(--font-interface) 在宿主环境没定义时会回退成别的字体，
  // 字宽一变换行位置就错，编辑框会比卡片宽/高一截。
  const cs: CSSStyleDeclaration = getComputedStyle(fo);
  ta.style.fontFamily = cs.fontFamily;
  ta.style.fontSize = cs.fontSize;
  ta.style.fontWeight = cs.fontWeight;
  ta.style.fontStyle = cs.fontStyle;
  ta.style.lineHeight = cs.lineHeight;
  ta.style.letterSpacing = cs.letterSpacing;
  ta.style.boxSizing = "border-box";
  ta.style.padding = "0";
  ta.style.border = "none";
  ta.style.outline = "none";
  ta.style.overflow = "hidden";
  ta.style.resize = "none";
  ta.style.color = fo.style.color || spec.nodeText;
  ta.style.position = "absolute";
  ta.style.transformOrigin = "0 0";
  ta.style.zIndex = "20";

  // 底色取卡片填充，视觉上就是「直接在卡片里改字」；
  // 极简主题卡片是透明的，退回画布底色，否则会和背后的原文重影。
  const fill: string = card?.getAttribute("fill") ?? "";
  ta.style.background = fill && fill !== "transparent" ? fill : spec.bg;
  const rx: string = card?.getAttribute("rx") ?? "0";
  ta.style.borderRadius = `${Math.max(0, Number.parseFloat(rx) || 0)}px`;

  container.appendChild(ta);
  const svg: SVGSVGElement | null = container.querySelector("svg");

  let done = false;
  // 原文用 visibility 藏，**不能**用 opacity。
  //
  // 曾经写的是 `fo.style.opacity = "0"`，症状是「一进编辑态，这个节点的卡片和连线
  // 整块消失，屏幕上只剩一个孤零零的输入框」：painter 把 foreignObject 的 opacity
  // 当作「markmap 正在淡入淡出」的信号（render/painter.ts 的 syncFadeFor），
  // 一看到 < 1 就同步给自绘的阴影/卡片/连线/收放点。编辑框的隐藏被它当成淡出，
  // 整块装饰跟着透明 —— 而那正是我们想让人看见的东西（线是结构的一部分）。
  // visibility 不走那条通道：它表达的是「暂时看不见」，不是「正在消失」。
  const prevVisibility: string = fo.style.visibility;
  /** 上一次落位的输入签名：位置与文本都没变就不写样式（见 place） */
  let lastKey = "";

  const place = (): boolean => {
    const rect: DOMRect = fo.getBoundingClientRect();
    const base: DOMRect = container.getBoundingClientRect();
    const rawW: number = Number.parseFloat(fo.getAttribute("width") ?? "") || rect.width;
    const rawH: number = Number.parseFloat(fo.getAttribute("height") ?? "") || rect.height;
    const scale: number = rawW > 0 ? rect.width / rawW : 1;

    // 位置、缩放、文本都没变就别再写一遍。
    // 打开后的 420ms 里这里每帧都会跑（见 followLoop），每帧写 width/height 再读
    // scrollHeight 是一次强制同步布局 —— 用户往往这时候已经开始打字了，
    // 每帧重排 + 每帧写样式叠在一起就是「输入时画面发虚/闪」。
    // 文本进签名（不是长度）：等长替换时字宽可能不同、折行会变，高度得跟着重算。
    const key: string = `${rect.left},${rect.top},${rawW},${rawH},${scale}|${ta.value}`;
    if (key === lastKey) return false;
    lastKey = key;

    // 编辑框要盖住**整张卡片**，而不只是文字盒——卡片左右各有十几像素内边距，
    // 只盖文字的话，一进编辑态卡片左右两侧会露出原色，像「框套框」。
    // 内边距按卡片与文字盒的差值算，文字位置与卡片里逐像素对齐。
    const pad = cardPad(fo, card);

    ta.style.left = `${rect.left - base.left - pad.x * scale}px`;
    ta.style.top = `${rect.top - base.top - pad.y * scale}px`;
    // +2 的容差：markmap 的节点宽是 scrollWidth 取整后的值，
    // 真实文字宽度可能多零点几像素。宽度卡得太死，textarea 会多折一行，
    // 编辑框就比卡片高一截。（加在内边距之外，不影响换行位置）
    // 至少 7 个汉字宽：新节点的占位文案是「新节点」（3 个字），卡片也就 3 格宽，
    // 编辑框要是死跟着卡片宽度走，打到第 4 个字就开始折行 —— 视觉上像「一打字就换行」。
    // 中文一格 ≈ 1em，所以直接按字号算；编辑框比卡片宽没关系，它只是个临时浮层。
    const minWidth: number = (Number.parseFloat(cs.fontSize) || 16) * MIN_EDIT_COLS;
    ta.style.width = `${Math.max(rawW + pad.x * 2 + 2, minWidth)}px`;
    ta.style.padding = `${pad.y}px ${pad.x}px`;
    ta.style.transform = `scale(${scale})`;

    // 高度按内容自适应，但不小于原来的卡片高度，避免一打开就矮一截
    ta.style.height = "1px";
    const needed: number = Math.max(rawH + pad.y * 2, ta.scrollHeight);
    ta.style.height = `${needed}px`;

    // 落位真的变了才记：短时间内多条说明编辑框在跳（背后节点还在被 markmap 挪），
    // 那在屏幕上就是「输入框飘在半空闪一下」
    if (isTracing()) {
      traceLogEvery("edit.place", 100, "edit.place", {
        x: Math.round(rect.left - base.left),
        y: Math.round(rect.top - base.top),
        w: Math.round(rawW),
      });
    }
    return true;
  };

  let frame = 0;
  const reposition = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!done) place();
    });
  };

  /**
   * 打开后的一小段时间里，节点位置可能还在变：markmap 对每个节点的内容挂了
   * ResizeObserver（100ms 防抖后才 renderData），刚重建完的节点会晚一步挪到位。
   * 这期间每帧贴一次，否则编辑框停在旧坐标上，身后卡片文字又是透明的 ——
   * 看起来就是「输入框飘在半空闪一下」。超过窗口期就停，不做常驻监听。
   */
  let follow = 0;
  let lastMoveAt: number = performance.now();
  const followUntil: number = performance.now() + 420;
  const followLoop = (): void => {
    if (done) {
      follow = 0;
      return;
    }
    // 位置稳定下来就提前收工（阈值 240ms > markmap 那个 100ms 防抖重排）：
    // 窗口期是给「刚重建完、节点晚一步挪到位」留的余量，节点已经不动了
    // 就没必要继续每帧量一遍。
    if (place()) lastMoveAt = performance.now();
    const now: number = performance.now();
    if (now - lastMoveAt > 240 || now >= followUntil) {
      follow = 0;
      return;
    }
    follow = window.requestAnimationFrame(followLoop);
  };
  follow = window.requestAnimationFrame(followLoop);

  const cleanup = (): void => {
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    if (follow) {
      window.cancelAnimationFrame(follow);
      follow = 0;
    }
    ta.removeEventListener("keydown", onKeyDown);
    ta.removeEventListener("blur", onBlur);
    ta.removeEventListener("input", reposition);
    ta.removeEventListener("mousedown", stop);
    ta.removeEventListener("wheel", stop);
    svg?.removeEventListener("wheel", reposition, true);
    window.removeEventListener("resize", reposition);
    fo.style.visibility = prevVisibility;
    ta.remove();
  };

  const finish = (action: EditorAction): void => {
    if (done) return;
    done = true;
    const value: string = ta.value;
    cleanup();
    options.onFinish(action, value);
  };

  function stop(e: Event): void {
    e.stopPropagation();
  }

  function onBlur(): void {
    finish("commit");
  }

  function onKeyDown(e: KeyboardEvent): void {
    // 中文/日文输入法正在组词时，回车是「上屏候选词」，不是提交。
    // 不放过这一下的话，用拼音打完字按回车选词，编辑框会当场退出、词也丢了，
    // 表现就是「根本没法连续输入」。keyCode 229 是部分输入法的老写法。
    if (e.isComposing || e.keyCode === 229) return;

    // 节点 = 笔记里的一行，多行文本没有意义，一律吞掉换行。
    // 软换行（Shift+Enter）同样无意义：吞掉，不插入换行、也不提交。
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) return;
      if (e.ctrlKey || e.metaKey) finish("sibling");
      else finish("commit");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish("cancel");
      return;
    }
    if (e.key === "Tab") {
      // Tab 和 Enter 一样只做一件事：**提交并退出编辑**。
      //
      // 曾经 Tab 在这里是「提交 + 建子级」（按 XMind 手感「顺手往下一层写」），
      // 但实际用起来是反的：改完一个字按 Tab，屏幕上会立刻多出一个空节点、
      // 焦点也跑到它身上，用户以为自己在「结束输入」，结果是「又开了一个」。
      // 现在统一成两步：先结束输入，再在画布上按 Tab 建子级 —— 和「先 Enter
      // 结束、再 Enter 建同级」完全对称，两种键的手感一致。
      //
      // 带修饰键的仍然直接做结构操作（Shift+Tab 提升一级），因为它不是
      // 「结束输入」的手势，而是明确要求改结构。
      e.preventDefault();
      e.stopPropagation();
      finish(e.shiftKey ? "outdent" : "commit");
      return;
    }
    // 退格 / 删除键在这里**只删文字**。
    //
    // 曾经做成「清空后再按一次 = 删掉整个节点」，理由是 XMind 的手感。但那是
    // 结构操作混进了文字编辑：用户想删一行字、或者全选清空重打，节点会连同
    // 整棵子树一起消失，而且没有确认。删除只属于「没在编辑、画布上选中」这个
    // 状态（Delete / Backspace），编辑框里永远不产出结构变化。
  }

  ta.addEventListener("keydown", onKeyDown);
  ta.addEventListener("blur", onBlur);
  ta.addEventListener("input", reposition);
  ta.addEventListener("mousedown", stop);
  ta.addEventListener("wheel", stop);
  // 编辑时缩放画布要跟着走，否则输入框会飘在别处
  svg?.addEventListener("wheel", reposition, true);
  window.addEventListener("resize", reposition);

  fo.style.visibility = "hidden";
  place();
  // preventScroll：编辑框就在视口里，focus 时再滚一下会把画布带偏一格
  ta.focus({ preventScroll: true });
  // 全选必须在 focus **之后**：某些浏览器 focus 会把选区折回末尾。
  if (options.selectAll === false) ta.setSelectionRange(ta.value.length, ta.value.length);
  else ta.select();

  return {
    close: (): void => {
      if (done) return;
      done = true;
      cleanup();
    },
    reposition,
  };
}
