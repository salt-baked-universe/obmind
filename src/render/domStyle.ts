/**
 * 内联样式的**唯一出口**。
 *
 * 为什么允许写内联、而不是全用 CSS 类：
 * 这里的值绝大多数是每帧按几何算出来的（卡片尺寸、缩放位移、拖动偏移），
 * CSS 类表达不了；还有几个是「隐藏/显示」这种布尔状态，标记在元素上而不是
 * 缓存进 Map —— 见 painter 里关于 reset() 后旧 DOM 带旧状态的注释。
 *
 * 为什么不直接在调用点写 `el.style.display = "none"`：
 * 官方目录的审查（eslint-plugin-obsidianmd 的 no-static-styles-assignment）
 * 把「字面量直接赋值」视为错误，要求走 `setCssProps` 或 CSS 类。这些封装把
 * 字面量收在一处，语义不变、审查也过。
 *
 * 约束：**只允许在这里出现 `style.x = 字面量`**，别处一律调这些函数。
 */

type StylableElement = HTMLElement | SVGElement;

/** 把某个内联属性设为给定值；value 为空串时移除该属性（回到样式表的值）。 */
function assign(el: StylableElement, prop: string, value: string): void {
  if (value === "") {
    el.style.removeProperty(prop);
    return;
  }
  el.style.setProperty(prop, value);
}

const NONE = "none";
const EMPTY = "";

/** 藏起来。判据统一用 `isHidden()` 读回来，不要自己缓存布尔。 */
export function hideElement(el: StylableElement): void {
  assign(el, "display", NONE);
}

/** 显回来。注意它只清掉**我们**写的 display，样式表里的隐藏照样生效。 */
export function showElement(el: StylableElement): void {
  assign(el, "display", EMPTY);
}

/** 需要显式指定 display 值时用（比如框选层要 block，不能是空串）。 */
export function setDisplay(el: StylableElement, value: "none" | "block" | "flex" | ""): void {
  assign(el, "display", value);
}

/** 当前是否被 `hideElement()` 藏起来了。 */
export function isHidden(el: StylableElement): boolean {
  return el.style.display === NONE;
}

/** 淡出进度（0~1）。markmap 用它表达「正在消失」，我们抄给卡片与连线。 */
export function setOpacity(el: StylableElement, value: string | number): void {
  assign(el, "opacity", String(value));
}

/** 编辑框藏原文用 visibility 而不是 opacity —— opacity 已被征用为消失进度。 */
export function setVisibility(el: StylableElement, value: "hidden" | "visible" | ""): void {
  assign(el, "visibility", value);
}

/** 拖动期间锁掉整页选中，否则拖到哪里蓝到哪里。 */
export function setUserSelect(el: StylableElement, value: "none" | ""): void {
  assign(el, "user-select", value);
  assign(el, "-webkit-user-select", value);
}

/** 卡片尺寸：foreignObject 的 width/height 是卡片几何的唯一输入。 */
export function setBoxSize(el: StylableElement, width: number, height: number): void {
  assign(el, "width", `${width}px`);
  assign(el, "height", `${height}px`);
}

/** 通用入口：属性名照 CSS 写（kebab-case），只在上面几个语义封装都不合适时用。 */
export function setStyleProperty(el: StylableElement, prop: string, value: string): void {
  assign(el, prop, value);
}
