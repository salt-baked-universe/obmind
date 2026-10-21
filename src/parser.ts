/**
 * 将 Obsidian 笔记正文转换为 markmap 可用的 Markdown 字符串。
 *
 * 规则：根节点为笔记文件名（去掉结尾的 .md）；正文逐行作为节点，
 * 层级由行首 Tab / 空格缩进决定（缩进越深层级越深）。
 *
 * @param content  笔记正文内容
 * @param fileName 笔记文件名（可能带或不带 .md 后缀）
 * @returns markmap 可用的 Markdown 字符串
 */
export function noteToMarkdown(content: string, fileName: string): string {
  // 1. 处理根标题：去掉结尾的 ".md"（如果有）
  const rootName: string = fileName.endsWith('.md')
    ? fileName.slice(0, -3)
    : fileName;

  const rawLines: string[] = content.split('\n');

  // 2. 逐行过滤：跳过空行、标题行与围栏代码块内部的行
  const keptLines: string[] = [];
  let inCodeBlock = false;

  for (const raw of rawLines) {
    const trimmed: string = raw.trim();
    if (trimmed === '') {
      continue; // 跳过纯空白行
    }
    // 跳过以任意数量 # 开头（后接空格或行尾）的 Markdown 标题行
    if (/^#+(?:\s|$)/.test(raw)) {
      continue;
    }
    // 遇到 ``` 切换“在代码块内”状态，该分隔行本身也跳过
    if (/^\s*```/.test(raw)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue; // 代码块内部的行整体忽略
    }
    keptLines.push(raw);
  }

  // 3. 计算步长 step：所有保留行中出现的最小正“连续空格数”
  let step = 2;
  let minSpaces = Infinity;
  for (const line of keptLines) {
    const wsMatch: RegExpMatchArray | null = line.match(/^[ \t]+/);
    if (wsMatch) {
      let spaces = 0;
      for (const ch of wsMatch[0]) {
        if (ch === ' ') {
          spaces++;
        }
      }
      if (spaces > 0 && spaces < minSpaces) {
        minSpaces = spaces;
      }
    }
  }
  if (minSpaces !== Infinity) {
    step = minSpaces;
  }

  // 4. 计算每条保留行的层级并生成列表项
  const items: string[] = [];
  for (const line of keptLines) {
    const wsMatch: RegExpMatchArray | null = line.match(/^[ \t]+/);
    const ws: string = wsMatch ? wsMatch[0] : '';
    let tabCount = 0;
    let spaceCount = 0;
    for (const ch of ws) {
      if (ch === '\t') {
        tabCount++;
      } else if (ch === ' ') {
        spaceCount++;
      }
    }
    const level: number = tabCount + Math.floor(spaceCount / step);
    const text: string = ws ? line.slice(ws.length) : line;

    const prefix: string = level === 0 ? '- ' : `${'  '.repeat(level)}- `;
    items.push(prefix + text);
  }

  // 5. 拼接：根标题 + 列表项，用 \n 连接，标题与首个列表项间无空行
  return ['# ' + rootName, ...items].join('\n');
}
