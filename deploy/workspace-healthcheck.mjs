import { request } from "node:http";
import { setting } from "../env.ts";

try {
  const origin = new URL(setting("MAGENTIC_PUBLIC_ORIGIN"));
  const probe = request({ host: "127.0.0.1", port: setting("MAGENTIC_WORKBENCH_PORT") || 8080,
    path: "/login", headers: { host: origin.host }, timeout: 3000 }, response => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  });
  probe.on("timeout", () => probe.destroy(new Error("timeout")));
  probe.on("error", () => { process.exitCode = 1; });
  probe.end();
} catch { process.exitCode = 1; }
