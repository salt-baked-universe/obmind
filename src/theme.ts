/**
 * 思维导图视觉主题（参考 XMind 的主题体系）。
 *
 * 一套主题 = 画布背景 + 分支色板 + 各级节点样式（是否有卡片/圆角/填充浓淡）
 * + 连线粗细 + 折叠圆点底色。
 *
 * 节点颜色按「一级分支」分配：根节点一套色，一级分支各自一色，
 * 更深的节点用同色系浅色调（与底色混合），保证分支一眼可辨。
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
  colors: ["#4a7dff", "#ff8a3d", "#2fb37c", "#9b56e0", "#e5484d", "#0ea5c6"],
  rootBg: "#2b3445",
  rootFg: "#ffffff",
  level1Solid: true,
  level1Fg: "#ffffff",
  nodeText: "#33415c",
  tint: 0.13,
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
  colors: ["#1d4ed8", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0369a1"],
  rootBg: "#0f2d5c",
  rootFg: "#ffffff",
  level1Solid: false,
  level1Fg: "#0f2d5c",
  nodeText: "#33415c",
  tint: 0.1,
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
  colors: ["#7aa2f7", "#f6a45c", "#6ed3a5", "#c08cf0", "#f07d8a", "#4fc3d9"],
  rootBg: "#7aa2f7",
  rootFg: "#12151c",
  level1Solid: false,
  level1Fg: "#e6ecf7",
  nodeText: "#c9d2e3",
  tint: 0.2,
  mixBase: "#1b1d24",
  circle: "#2a2f3c",
  card: true,
  radius: "8px",
  linkWidth: 2,
};

const CANDY: ThemeSpec = {
  id: "candy",
  label: "糖果",
  dark: false,
  bg: "#fffaf3",
  colors: ["#ff7aa2", "#ffb03a", "#3ecf8e", "#5aa9ff", "#b07cff", "#ff8a65"],
  rootBg: "#ff7aa2",
  rootFg: "#ffffff",
  level1Solid: false,
  level1Fg: "#6b3f4c",
  nodeText: "#5a3b46",
  tint: 0.2,
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
  colors: ["#3d6fd1", "#d1743d", "#3d9c74", "#8b5cc7", "#c2454b", "#2a9bb0"],
  rootBg: "#1f2430",
  rootFg: "#ffffff",
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
 * 从节点 path 取一级分支索引。path 形如 "0"（根）、"0.2"（第 3 个一级分支）、
 * "0.2.1"（其下第一个子节点）。
 */
export function branchIndex(path: string): number {
  const parts = path.split(".");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1], 10);
  return Number.isFinite(n) ? n : 0;
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
    return { bg: "transparent", fg: depth === 1 ? branch : spec.nodeText, bold: depth === 1 };
  }
  if (depth === 1 && spec.level1Solid) {
    return { bg: branch, fg: spec.level1Fg, bold: true };
  }
  if (depth === 1) {
    return {
      bg: mixColor(branch, spec.mixBase, Math.max(spec.tint, 0.18)),
      fg: spec.level1Fg,
      bold: true,
    };
  }
  return { bg: mixColor(branch, spec.mixBase, spec.tint), fg: spec.nodeText, bold: false };
}
