/**
 * 浮动条的位置规则（纯函数，能在 Node 里穷举边界）。
 *
 * 单独成文件的原因：`nodeBar.ts` 要 import obsidian 的 `setIcon`，一进 Node 就没法
 * 打包；而「浮条该摆哪儿」最容易算错（窄侧栏、画布比条子还矮）。
 * 这里只留数字，不放任何 DOM。
 */

export interface BarAnchor {
  /** 容器可用区域（画布） */
  host: { width: number; height: number };
  /** 浮动条自身尺寸 */
  bar: { width: number; height: number };
  /** 距容器边缘的留白（右边、上边、下边共用） */
  margin?: number;
}

export interface BarBox {
  left: number;
  top: number;
}

/**
 * 算浮动条位置：**贴画布右边缘、垂直居中**。
 *
 * 为什么从「跟着卡片跑」改成固定右侧：
 * 浮条原本挂在选中卡片旁边（先后在下方、后改上方），结果是它总在跟内容抢地方 ——
 * 挂在下方会压住子树，挂在上方会压住父级和兄弟，而用户还得先找到它。
 * 固定到右侧之后它变成一块**稳定的操作区**：位置永远一样，肌肉记忆能建立，
 * 也不会随着折叠动画飞来飞去。
 *
 * 两条兜底：
 * 1. 条子比画布还高（窄侧栏 + 5 个按钮）→ 贴顶边，至少第一个按钮可见；
 * 2. 画布比条子窄 → 贴左边，不留负偏移。
 */
export function nodeBarPosition(a: BarAnchor): BarBox {
  const margin: number = a.margin ?? 8;
  const { host, bar } = a;

  const left: number = Math.max(margin, host.width - bar.width - margin);
  const centered: number = Math.round((host.height - bar.height) / 2);
  const maxTop: number = Math.max(margin, host.height - bar.height - margin);
  const top: number = Math.min(Math.max(centered, margin), maxTop);

  return { left: Math.round(left), top };
}
