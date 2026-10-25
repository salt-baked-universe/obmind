// 本地复刻官方目录的自动审查（community.obsidian.md 用的就是这套规则）。
// 目的：提交前把 Error 清零，别再靠「提交 → 等报告 → 改」的往返。
//   npx eslint src           只看 Error
//   npx eslint src --quiet   同上，藏掉 warning
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "tmp/**", "scripts/**", "prototype/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
        },
      },
    },
    rules: {
      // 现场探针（trace.ts）是刻意保留的诊断入口，日志默认关闭；
      // 官方规则要求「避免无谓的 console 输出」，这里降级为 warning 而不是关掉。
      "no-console": "warn",
    },
  },
]);
