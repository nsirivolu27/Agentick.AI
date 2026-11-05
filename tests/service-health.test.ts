import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryPipelines } from "../workbench/pipeline.js";

test("service health is tenant-scoped, revocation-aware and does not claim upstream readiness", async () => {
  let member = true;
  const server = createWorkbenchServer({ context: { store: memoryStore(), audit: memoryAudit(),
    members: { rolesFor: async workspace => member && workspace === "team" ? ["admin"] : [] } },
    assets: new Map(), pipelines: memoryPipelines(),
    authenticate: async request => request.headers.authorization ? { workspaceId: String(request.headers["x-workspace"] ?? "team"), actor: "member" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port + "/api/health";
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: "session" } });
    assert.equal(response.status, 200);
    const health = await response.json() as Record<string, any>;
    assert.equal(health.writerMode, "single-process");
    assert.equal(health.capabilities.agentPackages, false);
    assert.equal(health.capabilities.models, false);
    assert.match(health.note, /does not verify upstream/);
    assert.equal((await fetch(url, { headers: { authorization: "session", "x-workspace": "other" } })).status, 403);
    member = false;
    assert.equal((await fetch(url, { headers: { authorization: "session" } })).status, 403);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
