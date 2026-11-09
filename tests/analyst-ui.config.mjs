import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".", testMatch: "analyst-ui.spec.mjs", workers: 1, fullyParallel: false, timeout: 120_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4187", viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000,
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/repl/tools/bin/chromium",
      args: ["--disable-gpu", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=192"] } },
  webServer: { command: "node dist/workbench/agent-demo.mjs --openfema",
    cwd: fileURLToPath(new URL("../", import.meta.url)), url: "http://127.0.0.1:4187", reuseExistingServer: false,
    env: { MAGENTIC_AGENT_DEMO_PORT: "4187", AGENTICK_ANALYST_DIRECTORY: mkdtempSync(join(tmpdir(), "analyst-ui-")) } },
});
