/**
 * 键盘拦截前的「这是不是输入控件」判定。
 *
 * 抽成独立函数是为了能单独验证：这类判定的错误方式都很隐蔽 ——
 * 少放行一个 `[role="button"]`，焦在操作栏按钮上按空格就会变成「开始编辑」，
 * 而按钮本身的无障碍语义（空格 = 按下）被吃掉；多放行一个 `<svg>`，
 * 画布上的空格就永远没用。用真实 DOM 跑用例比在代码里数标签可靠。
 *
 * 判据是「离 target 最近的语义」，不是 target 自己的 tagName：
 * 编辑框里真正接事件的是里面的文本节点 → target 往往是 `<div>` 或 `<span>`，
 * 只看 tagName 会漏掉 contenteditable 子树。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target.closest(
      "textarea, input, select, button, [contenteditable='true'], [role='button']",
    ) !== null
  );
}
