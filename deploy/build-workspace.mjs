import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";

const root = new URL("../", import.meta.url);
const context = new URL(".testbuild/workspace-image/", root);
const files = ["company-main.mjs", "audit-verify-main.mjs", "workspace-backup-main.mjs", "app.js",
  "index.html", "styles.css", "agency.css", "email.css", "mcp.css", "theme.css", "chat.css", "pipeline.css",
  "manifest.webmanifest", "icon.svg", "SourceSansPro-Regular.woff2", "SourceSansPro-Semibold.woff2",
  "SourceSansPro-Bold.woff2", "SourceSansPro-LICENSE.txt"];
await mkdir(new URL("app/", context), { recursive: true });
// Reject unexpected files instead of sending old private artifacts to the Docker daemon.
for (const entry of await readdir(context)) {
  if (entry !== "app") throw new Error("Unexpected file in workspace image context. Use a clean generated directory.");
}
for (const entry of await readdir(new URL("app/", context))) {
  if (![...files, "healthcheck.mjs"].includes(entry)) throw new Error("Unexpected file in workspace image app directory.");
}
const build = spawnSync(process.execPath, ["workbench/build.mjs"], { cwd: fileURLToPath(root), stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
for (const file of files) await copyFile(new URL(`dist/workbench/${file}`, root), new URL(`app/${file}`, context));
await bundle({ entryPoints: [fileURLToPath(new URL("workspace-healthcheck.mjs", import.meta.url))],
  bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: fileURLToPath(new URL("app/healthcheck.mjs", context)) });
console.log("Workspace image context ready: .testbuild/workspace-image (company server; no demo entries).");
