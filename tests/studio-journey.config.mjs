import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  testDir: ".", testMatch: "studio-journey.spec.mjs", fullyParallel: false,
  workers: 1, reporter: "list", timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:4184",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      // Keep process isolation: single-process Chromium is unstable during accessibility scans.
      ...(process.env.PLAYWRIGHT_LOW_MEMORY === "1" ? { args: ["--renderer-process-limit=1", "--disable-gpu", "--js-flags=--max-old-space-size=192"] } : {}),
      ...(process.env.PLAYWRIGHT_SINGLE_PROCESS === "1" ? { args: ["--single-process", "--no-zygote", "--disable-gpu", "--js-flags=--max-old-space-size=192"] } : {}),
    },
  },
  webServer: {
    command: "node dist/workbench/agent-demo.mjs",
    cwd,
    url: "http://127.0.0.1:4184",
    env: { MAGENTIC_AGENT_DEMO_PORT: "4184" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
