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

import type { ThemeSpec } from "../theme";

export type EditorAction = "commit" | "sibling" | "indent" | "outdent" | "delete" | "cancel";

export interface InlineEditorOptions {
  container: HTMLElement;
  target: SVGGElement;
  value: string;
  spec: ThemeSpec;
  /** 打开时全选（新建节点用，用户直接打字覆盖占位文本） */
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
  const prevOpacity: string = fo.style.opacity;

  const place = (): void => {
    const rect: DOMRect = fo.getBoundingClientRect();
    const base: DOMRect = container.getBoundingClientRect();
    const rawW: number = Number.parseFloat(fo.getAttribute("width") ?? "") || rect.width;
    const rawH: number = Number.parseFloat(fo.getAttribute("height") ?? "") || rect.height;
    const scale: number = rawW > 0 ? rect.width / rawW : 1;

    // 编辑框要盖住**整张卡片**，而不只是文字盒——卡片左右各有十几像素内边距，
    // 只盖文字的话，一进编辑态卡片左右两侧会露出原色，像「框套框」。
    // 内边距按卡片与文字盒的差值算，文字位置与卡片里逐像素对齐。
    const pad = cardPad(fo, card);

    ta.style.left = `${rect.left - base.left - pad.x * scale}px`;
    ta.style.top = `${rect.top - base.top - pad.y * scale}px`;
    // +2 的容差：markmap 的节点宽是 scrollWidth 取整后的值，
    // 真实文字宽度可能多零点几像素。宽度卡得太死，textarea 会多折一行，
    // 编辑框就比卡片高一截。（加在内边距之外，不影响换行位置）
    ta.style.width = `${rawW + pad.x * 2 + 2}px`;
    ta.style.padding = `${pad.y}px ${pad.x}px`;
    ta.style.transform = `scale(${scale})`;

    // 高度按内容自适应，但不小于原来的卡片高度，避免一打开就矮一截
    ta.style.height = "1px";
    const needed: number = Math.max(rawH + pad.y * 2, ta.scrollHeight);
    ta.style.height = `${needed}px`;
  };

  let frame = 0;
  const reposition = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!done) place();
    });
  };

  const cleanup = (): void => {
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    ta.removeEventListener("keydown", onKeyDown);
    ta.removeEventListener("blur", onBlur);
    ta.removeEventListener("input", reposition);
    ta.removeEventListener("mousedown", stop);
    ta.removeEventListener("wheel", stop);
    svg?.removeEventListener("wheel", reposition, true);
    window.removeEventListener("resize", reposition);
    fo.style.opacity = prevOpacity;
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

    // 节点 = 笔记里的一行，多行文本没有意义，一律吞掉换行
    if (e.key === "Enter") {
      e.preventDefault();
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
      e.preventDefault();
      finish(e.shiftKey ? "outdent" : "indent");
      return;
    }
    if (e.key === "Backspace" && ta.value.trim() === "") {
      e.preventDefault();
      finish("delete");
    }
  }

  ta.addEventListener("keydown", onKeyDown);
  ta.addEventListener("blur", onBlur);
  ta.addEventListener("input", reposition);
  ta.addEventListener("mousedown", stop);
  ta.addEventListener("wheel", stop);
  // 编辑时缩放画布要跟着走，否则输入框会飘在别处
  svg?.addEventListener("wheel", reposition, true);
  window.addEventListener("resize", reposition);

  fo.style.opacity = "0";
  place();
  ta.focus();
  if (options.selectAll) ta.select();
  else ta.setSelectionRange(ta.value.length, ta.value.length);

  return {
    close: (): void => {
      if (done) return;
      done = true;
      cleanup();
    },
    reposition,
  };
}
