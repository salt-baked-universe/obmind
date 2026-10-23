import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["scripts/testBatch.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "scripts/testBatch.mjs",
  logLevel: "warning",
});

await import("./testBatch.mjs");
