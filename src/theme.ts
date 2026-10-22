/**
 * 思维导图视觉主题（参考 XMind 的主题体系）。
 *
 * 一套主题 = 画布背景 + 分支色板 + 各级节点样式（是否有卡片/圆角/填充浓淡）
 * + 连线粗细 + 折叠圆点底色。
 *
 * 节点颜色按「一级分支」分配：根节点一套色，一级分支各自一色，
 * 更深的节点用同色系浅色调（与底色混合），保证分支一眼可辨。
 *
 * 色板刻意给到 8 色而不是 6：分支数的常态是 5～10，6 色一过就会撞色，
 * 而「两根分支同色」比「颜色不完美」难看得多。具体哪根分支拿哪个槽位
 * 由 `render/colors.ts` 的粘性分配器决定（保证增删不跳色）。
 */

export type MindmapTheme =
  | "follow"
  | "classic"
  | "business"
  | "dark"
  | "candy"
  | "minimal";

export interface ThemeSpec {
  id: MindmapTheme;
  label: string;
  /** 是否为深色系（决定 markmap-dark 类与默认文字色） */
  dark: boolean;
  /** 画布背景 */
  bg: string;
  /** 一级分支色板（同时用于连线与折叠圆点） */
  colors: string[];
  /** 根节点填充 / 文字 */
  rootBg: string;
  rootFg: string;
  /** 一级节点是否用实色填充 */
  level1Solid: boolean;
  /** 一级节点文字色（实色填充时通常为白） */
  level1Fg: string;
  /** 二级及更深节点的文字色 */
  nodeText: string;
  /** 深层节点填充浓度：分支色与 mixBase 的混合比例（0 = 不填充） */
  tint: number;
  /** 混合基色（浅色主题用白，深色主题用深灰） */
  mixBase: string;
  /** 折叠状态圆点的底色 */
  circle: string;
  /** 是否把节点渲染成卡片（背景块 + 圆角 + 阴影） */
  card: boolean;
  /** 卡片圆角 */
  radius: string;
  /** 连线基础粗细 */
  linkWidth: number;
}

const CLASSIC: ThemeSpec = {
  id: "classic",
  label: "经典",
  dark: false,
  bg: "#f6f7f9",
  colors: ["#4a7dff", "#ff8a3d", "#2fb37c", "#9b56e0", "#e5484d", "#0ea5c6", "#d9a300", "#e0559b"],
  rootBg: "#8492ae",
  rootFg: "#1c2433",
  // 一级节点不再用色板原色实底（#4a7dff/#9b56e0 这类饱和深块太重，
  // 且金色系白字对比度只有 2.3），改用 0.45 浓度的浅色调 + 深色字，
  // 仍比二级（0.3）深一档，层级感靠浓度差维持。
  level1Solid: false,
  level1Fg: "#33415c",
  nodeText: "#33415c",
  tint: 0.3,
  mixBase: "#ffffff",
  circle: "#ffffff",
  card: true,
  radius: "8px",
  linkWidth: 2,
};

const BUSINESS: ThemeSpec = {
  id: "business",
  label: "商务",
  dark: false,
  bg: "#eef2f7",
  colors: ["#1d4ed8", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0369a1", "#4d7c0f", "#57534e"],
  rootBg: "#5b90cc",
  rootFg: "#16223d",
  level1Solid: false,
  level1Fg: "#0f2d5c",
  nodeText: "#33415c",
  tint: 0.24,
  mixBase: "#ffffff",
  circle: "#ffffff",
  card: true,
  radius: "4px",
  linkWidth: 2,
};

const DARK: ThemeSpec = {
  id: "dark",
  label: "深色",
  dark: true,
  bg: "#1b1d24",
  colors: ["#7aa2f7", "#f6a45c", "#6ed3a5", "#c08cf0", "#f07d8a", "#4fc3d9", "#e8c46a", "#f59ecb"],
  rootBg: "#7aa2f7",
  rootFg: "#12151c",
  level1Solid: false,
  // 下面三处是「深色包裹深色」的根因修复：原来 mixBase 用深色画布、字用浅色，
  // 导致卡片 = mix(浅分支, 深画布) 仍是暗块，既和黑底糊在一起、浅字对比度还掉到 4.0。
  // 改成「浅色调卡 + 深色字」，卡片从黑画布里跳出来、文字永远深字可读。
  level1Fg: "#1f2a38",
  nodeText: "#26303d",
  tint: 0.34,
  mixBase: "#ffffff",
  circle: "#5b6b82",
  card: true,
  radius: "8px",
  linkWidth: 2,
};

const CANDY: ThemeSpec = {
  id: "candy",
  label: "糖果",
  dark: false,
  bg: "#fffaf3",
  colors: ["#ff7aa2", "#ffb03a", "#3ecf8e", "#5aa9ff", "#b07cff", "#ff8a65", "#2ec4b6", "#e37cc9"],
  rootBg: "#ff7aa2",
  rootFg: "#5a1f3a",
  level1Solid: false,
  level1Fg: "#6b3f4c",
  nodeText: "#5a3b46",
  tint: 0.3,
  mixBase: "#ffffff",
  circle: "#ffffff",
  card: true,
  radius: "14px",
  linkWidth: 2.4,
};

const MINIMAL: ThemeSpec = {
  id: "minimal",
  label: "极简",
  dark: false,
  bg: "#ffffff",
  colors: ["#3d6fd1", "#b45309", "#2f8f5b", "#8b5cc7", "#c2454b", "#0e7490", "#a16207", "#9d3b6d"],
  rootBg: "#828a98",
  rootFg: "#15191f",
  level1Solid: false,
  level1Fg: "#1f2430",
  nodeText: "#3a4252",
  tint: 0,
  mixBase: "#ffffff",
  circle: "#ffffff",
  card: false,
  radius: "0px",
  linkWidth: 1.6,
};

export const THEMES: ThemeSpec[] = [CLASSIC, BUSINESS, DARK, CANDY, MINIMAL];

/** 工具条下拉的选项（含“跟随外观”） */
export const THEME_OPTIONS: { value: MindmapTheme; label: string }[] = [
  { value: "follow", label: "跟随外观" },
  ...THEMES.map((t) => ({ value: t.id, label: t.label })),
];

/**
 * 解析成具体主题：`follow` 跟随 Obsidian 亮暗自动落到「经典 / 深色」。
 * 找不到（例如老配置里存了已删除的主题）时回退到经典。
 */
export function resolveTheme(theme: MindmapTheme, isDark: boolean): ThemeSpec {
  if (theme === "follow") return isDark ? DARK : CLASSIC;
  const found = THEMES.find((t) => t.id === theme);
  if (found) return found;
  return isDark ? DARK : CLASSIC;
}

function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    ];
  }
  if (hex.length === 6) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  return null;
}

/** 把 color 按 ratio 的比例与 base 混合，用于生成同色系的浅底/暗底 */
export function mixColor(color: string, base: string, ratio: number): string {
  const a = parseHex(color);
  const b = parseHex(base);
  if (!a || !b) return color;
  const r = Math.round(a[0] * ratio + b[0] * (1 - ratio));
  const g = Math.round(a[1] * ratio + b[1] * (1 - ratio));
  const bl = Math.round(a[2] * ratio + b[2] * (1 - ratio));
  return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * 相对亮度（WCAG 公式）。用来决定实色卡片上该配白字还是深字。
 *
 * 需要它的原因：色板扩到 8 色之后必然有橙、黄这类高明度色。
 * 原来「一级分支一律白字」在 #ff8a3d 上的对比度只有 2.4，字是糊的。
 */
export function luminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两个颜色的对比度（WCAG 公式，1～21） */
export function contrastRatio(a: string, b: string): number {
  const la: number = luminance(a);
  const lb: number = luminance(b);
  const hi: number = Math.max(la, lb);
  const lo: number = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 在这个底色上可读的文字色：白或深墨，取对比度更高的那个。
 *
 * 为什么不用「亮度 > 阈值就配深字」：色板扩到 8 色之后必然有橙、黄这类
 * 中间明度色，阈值一刀切会在 #ff8a3d 上选中白色（对比度只有 2.35，字是糊的）。
 * 直接比两边谁更清楚，就不会挑错。
 */
export function readableOn(color: string): string {
  const ink = "#12151c";
  return contrastRatio(color, "#ffffff") >= contrastRatio(color, ink) ? "#ffffff" : ink;
}

/**
 * 一级节点（非实色主题）的填充浓度。
 *
 * 必须明显浓于深层：原来固定 0.18，而深层是 0.13～0.2 —— 一级和二级
 * 看起来是同一个色块，层级感全靠字号撑着。这里按「深层的 1.6 倍、下限 0.3」算。
 */
export function level1Tint(spec: ThemeSpec): number {
  return Math.min(0.5, Math.max(spec.tint * 1.5, 0.34));
}

/**
 * 深层节点的填充浓度。
 *
 * 层级越深越淡（XMind 的做法）：同一分支里 5 层节点全用一个浓度，
 * 满屏同一块颜色的卡片会让人分不清哪层是哪层。
 */
export function tintAt(spec: ThemeSpec, depth: number): number {
  if (depth <= 2) return spec.tint;
  // 每深一层淡一点，但留个地板（35%），避免第 6 层忽然掉成透明
  return Math.max(spec.tint * 0.35, spec.tint * (1 - (depth - 2) * 0.22));
}

export interface NodeStyle {
  bg: string;
  fg: string;
  bold: boolean;
}

/**
 * 计算某个节点的最终配色。
 * - 根节点：主题的强调色实底
 * - 一级节点：分支色（实色或浅色，取决于主题）
 * - 更深层：同色系更淡的底
 * - 非卡片主题（极简）：透明底 + 分支色文字
 */
export function nodeStyleAt(spec: ThemeSpec, depth: number, branch: string): NodeStyle {
  if (depth === 0) {
    return { bg: spec.rootBg, fg: spec.rootFg, bold: true };
  }
  if (!spec.card) {
    // 无卡片主题（极简）：一级文字用分支色，但直接用原色在白画布上对比度只有 ~4。
    // 往墨色压 55% 既保留分支身份又保证可读。
    return {
      bg: "transparent",
      fg: depth === 1 ? mixColor(branch, "#12151c", 0.55) : spec.nodeText,
      bold: depth === 1,
    };
  }
  if (depth === 1 && spec.level1Solid) {
    // 文字色跟着底色亮度走，而不是写死白色 —— 见 readableOn
    return { bg: branch, fg: readableOn(branch), bold: true };
  }
  if (depth === 1) {
    return {
      bg: mixColor(branch, spec.mixBase, level1Tint(spec)),
      fg: spec.level1Fg,
      bold: true,
    };
  }
  return { bg: mixColor(branch, spec.mixBase, tintAt(spec, depth)), fg: spec.nodeText, bold: false };
}
