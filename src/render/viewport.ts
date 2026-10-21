/**
 * 视口适配的时序工具（L2，不依赖 markmap、不依赖 obsidian）。
 *
 * 为什么单独拆出来：**「打开偶现空白」本质上是个时序 bug，不是渲染 bug。**
 * markmap 的 `fit()` 直接读 `svg.getBoundingClientRect()` 来算缩放比例：
 *
 *     scale = min(width / 内容宽, height / 内容高) * fitRatio
 *
 * 视图刚创建时右侧栏还在滑出，这个尺寸会经历 `0 → 60 → 200 → 400` 的过程。
 * 在 0 上 fit 得到 scale = 0（整张图缩成一个点），在 60 上 fit 得到 0.1 左右
 * （图缩在角落里，和空白没区别），而 fit 之后再没有任何人去重算 —— 于是
 * 用户看到的是空白，点一下「适配」才出现。
 *
 * 所以适配前必须先确认：尺寸**够大**，而且**已经稳定**（连续两帧不变）。
 * 这段判定只跟「读到的数字序列」有关，与浏览器、与 markmap 都无关，
 * 抽成纯逻辑就能在 Node 里穷举时序，不用起浏览器。
 */

export interface Size {
  w: number;
  h: number;
}

export interface StableSizeOptions {
  /** 读当前视口尺寸。必须与 fit 内部用的度量一致（svg 的 rect，不是容器的 clientWidth） */
  read: () => Size;
  /** 等一帧（浏览器里是 rAF，用例里是立即 resolve） */
  nextFrame: () => Promise<void>;
  /** 期间是否已经过期（视图重建、有更新的适配请求） */
  stale: () => boolean;
  /** 认定「已就绪」的最小边长 */
  min: number;
  /** 最多等多少帧，默认 8（约 130ms，覆盖侧栏滑出的一半动画） */
  frames?: number;
}

/**
 * 等到视口尺寸「够大且连续两帧不变」再返回。
 *
 * @returns 稳定后的尺寸；等到超时仍不达标（一直是 0，或者一直在抖）返回 null，
 *          调用方据此把请求挂起，交给尺寸监听器补做。
 */
export async function waitStableSize(opts: StableSizeOptions): Promise<Size | null> {
  const { read, nextFrame, stale, min } = opts;
  const limit: number = opts.frames ?? 8;
  const big = (s: Size): boolean => s.w >= min && s.h >= min;

  let last: Size = read();

  for (let i = 0; i < limit; i++) {
    if (stale()) return null;

    if (big(last)) {
      // 够大了，再等一帧确认它不再变 —— 侧栏过渡期间每帧都是新值，
      // 在中间值上 fit 出来的比例是错的，而且不会有人纠正它
      await nextFrame();
      if (stale()) return null;
      const now: Size = read();
      if (now.w === last.w && now.h === last.h && big(now)) return now;
      last = now;
      continue;
    }

    await nextFrame();
    if (stale()) return null;
    last = read();
  }

  // 超时：只有「一直在抖但始终够大」这一种情况可以接受，其余交给上层挂起重试
  return big(last) ? last : null;
}
