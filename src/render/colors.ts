/**
 * 分支配色分配。
 *
 * 为什么需要它：markmap 给节点的 path 是**位置**编码（"0.2.1" 里的 2 是兄弟序号），
 * 直接拿它取色板，会在文件里插一行 / 删一行之后把后面所有分支的颜色整体平移 ——
 * 表现就是「新加一个节点，满屏跳色」。XMind 不会这样：每根分支的颜色是跟着
 * 分支本身走的，不跟着它在兄底里的序号走。
 *
 * 这里用「分支名 → 槽位」的粘性映射模拟同一件事：
 * 1. 分支名归一化（去掉 **、``、链接地址），改名之外的编辑不会改 key；
 * 2. 已有的 key 永远保留原槽位 —— 增删分支只影响新出现的那个，老分支纹丝不动；
 * 3. 只变了一个分支（典型是改名）时把旧槽位直接过户，改名也不换色；
 * 4. 冷启动的槽位由内容哈希决定（不是文档顺序），所以重开视图后颜色基本不变；
 * 5. 撞槽时向后探测空位，尽量让每根分支颜色都不同（色板够用时不会重复）。
 *
 * 这个模块是纯逻辑（不碰 DOM、不碰 obsidian），可以在 Node 里穷举验证。
 */

/** 一级分支的 path：根节点是 "0"，其下依次是 "0.0" / "0.1" / … */
export function branchPathOf(path: string): string {
  const first = path.indexOf(".");
  if (first < 0) return path;
  const second = path.indexOf(".", first + 1);
  return second < 0 ? path : path.slice(0, second);
}

/** FNV-1a 32 位哈希。短文本上足够散，且完全确定（不依赖随机种子）。 */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 只有行内标记差异的写法应当算同一个分支（`**甲**` 与 `甲` 不该是两个颜色） */
export function branchKey(text: string): string {
  const plain: string = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain === "" ? text.trim() : plain;
}

/**
 * 粘性槽位分配器。每个视图持有一个实例（跨 setData 保留），
 * 这样「重建导图」不会把颜色重置成另一套。
 */
export class BranchColors {
  /** 分支 key → 槽位 */
  private slots = new Map<string, number>();
  /** 上次使用的色板长度：换主题（色板长度不同）时全部重排 */
  private size = 0;

  reset(): void {
    this.slots.clear();
    this.size = 0;
  }

  /**
   * 按「本轮出现的分支」刷新分配。
   *
   * @param keys 一级分支的 key（文档顺序；顺序本身不参与运算，只影响重复流程）
   * @param size 色板长度
   * @returns key → 槽位
   */
  sync(keys: readonly string[], size: number): Map<string, number> {
    const n: number = Math.max(1, Math.floor(size));
    if (n !== this.size) {
      this.slots.clear();
      this.size = n;
    }

    const present = new Set<string>(keys);
    const removed: string[] = [];
    for (const key of Array.from(this.slots.keys())) {
      if (!present.has(key)) removed.push(key);
    }
    const added: string[] = [];
    for (const key of present) {
      if (!this.slots.has(key)) added.push(key);
    }

    if (removed.length === 1 && added.length === 1) {
      // 只换了一个分支名（改名 / 删一个又加一个）：槽位过户。
      // 否则「双击改个标题」，这根分支的颜色就跟着变了一次。
      this.slots.set(added[0], this.slots.get(removed[0]) ?? 0);
      this.slots.delete(removed[0]);
    } else {
      for (const key of removed) this.slots.delete(key);
      // 按哈希排序后分配：结果只取决于「有哪些分支」，与它们在文档里的先后无关
      const order: string[] = added.sort(
        (a: string, b: string) => hash32(a) - hash32(b) || (a < b ? -1 : a > b ? 1 : 0),
      );
      for (const key of order) this.place(key, hash32(key) % this.size);
    }

    const out = new Map<string, number>();
    for (const key of present) {
      const slot = this.slots.get(key);
      if (slot !== undefined) out.set(key, slot);
    }
    return out;
  }

  /** 放某个 key：首选位置被占就向后找空位；实在占满（分支比颜色多）只能重复 */
  private place(key: string, preferred: number): void {
    const taken = new Set<number>(this.slots.values());
    for (let step = 0; step < this.size; step++) {
      const slot: number = (preferred + step) % this.size;
      if (!taken.has(slot)) {
        this.slots.set(key, slot);
        return;
      }
    }
    this.slots.set(key, preferred);
  }
}
