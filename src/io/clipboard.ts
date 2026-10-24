/**
 * 剪贴板端口。
 *
 * 为什么要单独抽一个接口，而不是在动作里直接调 `navigator.clipboard`：
 *
 * 1. 它是唯一一个**可能被宿主拒绝**的 IO（Electron 里要用户手势、还要权限），
 *    也是唯一一个**天然异步**的输入。放在动作体里，「按一下 Ctrl+V」就变成
 *    async 分支：读失败要提示、读到一半用户又切走了要作废。这些不该混在
 *    「把剪贴板文本变成几行 Markdown」的纯逻辑里。
 * 2. 纯逻辑（`edit/paste.ts`）只接受 `string`，用例直接喂字符串，不用碰 DOM；
 *    行为测试要模拟「剪贴板是空的」「读被拒绝」，注入这个接口即可。
 *
 * 写入方向现在只有「复制节点文字」会用，先一起放好 —— 端口的意义就是
 * 两个方向共用一份实现，不要等真需要时再补一个半成品。
 */

export interface ClipboardPort {
  /** 读纯文本。读不到（没权限 / 非安全上下文）返回空串，调用方按「空剪贴板」处理 */
  readText(): Promise<string>;
  /** 写纯文本。失败静默 —— 复制不到不该打断任何操作 */
  writeText(text: string): Promise<void>;
}

/**
 * 宿主真实实现。
 *
 * 读失败一律退回空串而不是抛异常：`navigator.clipboard.readText()` 在
 * 「焦点不在页面里」「没给权限」时都会 reject，而这两件事对用户来说
 * 就是「剪贴板里没东西」。抛出去只会让 Ctrl+V 变成一次未捕获的 Promise。
 */
export const systemClipboard: ClipboardPort = {
  async readText(): Promise<string> {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  },
  async writeText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 写失败不提示：复制是辅助动作，失败时用户再点一次就行 */
    }
  },
};

/**
 * 内存实现：用例 / 没有剪贴板的环境（比如 headless 探针）用。
 *
 * 暴露 `text` 是为了断言「复制动作到底写了什么」——只给 read/write 两个方法的话，
 * 测「复制节点文字」还得先把写进去的内容读出来，绕一圈。
 */
export interface MemoryClipboard extends ClipboardPort {
  text: string;
  /** 写入次数。用来断言「没有多余的 IO」 */
  writes: number;
}

export function memoryClipboard(initial = ""): MemoryClipboard {
  const port: MemoryClipboard = {
    text: initial,
    writes: 0,
    async readText(): Promise<string> {
      return port.text;
    },
    async writeText(text: string): Promise<void> {
      port.text = text;
      port.writes++;
    },
  };
  return port;
}
