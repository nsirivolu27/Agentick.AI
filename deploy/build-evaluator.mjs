import { build } from "esbuild";

await build({
  entryPoints: ["workbench/evaluation-processing-main.ts"],
  bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: ".testbuild/evaluator/runner.mjs", logLevel: "info",
});
