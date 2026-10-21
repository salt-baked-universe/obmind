/**
 * 导图内跳转栈（L4 app 的纯状态）。
 *
 * 场景：在导图里点一个 `[[双链]]`，导图原地换成那篇笔记。连点几次之后，
 * 用户需要知道「我是从哪来的」，并且能一级一级退回去 —— 这就是面包屑。
 *
 * 三个必须处理好的边界：
 * 1. **循环**：A → B → A 不能变成 A › B › A › B…。做法是「跳去已存在的条目时，
 *    先截断再压栈」，栈里永远不会有重复 path。
 * 2. **上限**：连点几十次不该把 DOM 撑爆，超出就丢最老的。
 * 3. **不重复压同一篇**：当前已经是这篇时不产生新条目（否则每刷新一次栈就长一节）。
 *
 * 纯函数，不碰 DOM、不认识 Obsidian。
 */

export interface NavEntry {
  path: string;
  title: string;
  /**
   * 「新标签打开」模式下，为这条跳转新开的标签编号。
   *
   * 存编号而不是标签引用：这个文件是纯状态，不认识 Obsidian；
   * 编号由视图层映射回 WorkspaceLeaf，返回上级时才知道该关哪一个。
   */
  leafId?: number;
}

/** 栈深上限：面包屑本来就放不下太多，超出丢最老的 */
export const NAV_LIMIT = 24;

/** 从路径取显示名（去掉 .md） */
export function titleOfPath(path: string): string {
  const base: string = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export function topOf(stack: readonly NavEntry[]): NavEntry | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

export interface PushResult {
  /** 压栈后的栈 */
  stack: NavEntry[];
  /** 被丢弃的条目：走到已存在的一项时它后面的部分，以及超出上限的最老部分 */
  dropped: NavEntry[];
}

/**
 * 压入一个新条目，并把「被丢弃的条目」一并返回。
 *
 * 为什么要返回 dropped：某些模式下前进时新开了标签，后退（或重走旧路径）时
 * 需要把对应标签关掉，而 pushEntry 内部截断时调用方看不到丢了什么。
 */
export function pushEntryDetailed(
  stack: readonly NavEntry[],
  entry: NavEntry,
  limit: number = NAV_LIMIT,
): PushResult {
  const cur = topOf(stack);
  if (cur && cur.path === entry.path) {
    // 已经在这一篇上：leafId 没变就什么都不做；
    // 变了说明又被另一个窗口打开了一次，旧条目进 dropped 让调用方关掉旧窗口。
    if (cur.leafId === entry.leafId) return { stack: [...stack], dropped: [] };
    return { stack: [...stack.slice(0, stack.length - 1), entry], dropped: [cur] };
  }

  const hit: number = stack.findIndex((e: NavEntry) => e.path === entry.path);
  const base: NavEntry[] = hit >= 0 ? stack.slice(0, hit) : [...stack];
  const dropped: NavEntry[] = hit >= 0 ? stack.slice(hit + 1) : [];

  let next: NavEntry[] = [...base, entry];
  if (next.length > limit) {
    const cut: number = next.length - limit;
    dropped.push(...next.slice(0, cut));
    next = next.slice(cut);
  }
  return { stack: next, dropped };
}

/**
 * 压入一个新条目。
 *
 * 已经存在于栈里时先截断到它的位置 —— 这同时解决了循环和「后退」：
 * A › B › C 里再点 A，结果就是 A，而不是 A › B › C › A。
 */
export function pushEntry(
  stack: readonly NavEntry[],
  entry: NavEntry,
  limit: number = NAV_LIMIT,
): NavEntry[] {
  return pushEntryDetailed(stack, entry, limit).stack;
}

/** 点面包屑第 index 项：保留到它为止 */
export function truncateTo(stack: readonly NavEntry[], index: number): NavEntry[] {
  if (index < 0 || index >= stack.length) return [...stack];
  return stack.slice(0, index + 1);
}

/** 栈是否等同于从 root 出发的一条路径（调试 / 用例用） */
export function stackPaths(stack: readonly NavEntry[]): string[] {
  return stack.map((e: NavEntry) => e.path);
}
