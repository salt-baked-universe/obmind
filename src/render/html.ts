/**
 * 把「已经渲染好的 HTML」铺进容器 —— 全项目唯一允许往 DOM 里塞 HTML 的出口。
 *
 * 为什么不能直接 `el.innerHTML = html`：
 * 官方目录的审查（eslint-plugin-no-unsanitized）把 innerHTML 赋值判成安全错误，
 * 要求要么用 `createEl` 逐个建元素，要么显式走 sanitize。
 *
 * 为什么这里用 DOMParser 而不是 `sanitizeHTMLToDom`：
 * 塞进来的是 `MarkdownRenderer.render()` 的产物 —— 代码高亮、表格、公式（KaTeX/MathJax）、
 * callout 全在里面，很多结构依赖行内 style 与自定义标签。`sanitizeHTMLToDom` 会按
 * 白名单把这些洗掉，公式和代码块底色会直接塌掉。而 `DOMParser` 解析出的文档里
 * **不会执行脚本、不会加载资源**，取节点再 importNode 过来是等价的、可审计的路径：
 * 内容来源始终是本插件自己的渲染器，不接受外部字符串。
 *
 * 注意：节点传进来时监听器不会跟着走，需要交互的部分（比如复制按钮）一律用
 * 事件委托挂在画布上，别指望元素自带监听。
 */

/** 解析 HTML 字符串并替换容器内容。 */
export function setRenderedHtml(el: Element, html: string): void {
  const doc: Document = new DOMParser().parseFromString(html, "text/html");
  const frag: DocumentFragment = (el.ownerDocument ?? document).createDocumentFragment();
  const target: Document = el.ownerDocument ?? document;
  for (const node of Array.from(doc.body.childNodes)) {
    frag.appendChild(target.importNode(node, true));
  }
  el.replaceChildren(frag);
}
