import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentDemo, DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";
import { createWorkbenchServer } from "../workbench/server.js";

test("package API enforces schema, current membership, independent identity and fresh approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-package-api-"));
  const demo = await createAgentDemo(directory);
  let revoke = false;
  let lookups = 0;
  const server = createWorkbenchServer({ ...demo, assets: new Map(),
    context: { ...demo.context, members: { async rolesFor(workspace, actor) {
      if (revoke && ++lookups > 1) return [];
      return actor === "demo.operator" ? ["admin"] : ["approver"];
    } } },
    authenticate: async request => request.headers.authorization ? {
      actor: String(request.headers.authorization), workspaceId: String(request.headers["x-workspace"] ?? DEMO_WORKSPACE),
      recentSignIn: request.headers["x-fresh"] !== "false",
    } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port + "/api/agent-packages";
  const post = (input: unknown, actor = "demo.operator", extra: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: actor, ...extra }, body: JSON.stringify(input),
  });
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const saved = demo.agentTests.snapshot(DEMO_WORKSPACE).cases[0]!;
    const version = demo.pipelines.snapshot(DEMO_WORKSPACE).version;
    await demo.agentTests.execute(DEMO_WORKSPACE, "demo.operator", ["admin"], { action: "run", caseId: saved.id, expectedVersion: version });
    await demo.agentTests.settled(DEMO_WORKSPACE);
    const run = demo.agentTests.snapshot(DEMO_WORKSPACE).runs[0]!;
    await demo.agentTests.execute(DEMO_WORKSPACE, "demo.reviewer-one", ["approver"], { action: "review", runId: run.id, verdict: "pass" });
    const publish = { action: "publish", agentId: saved.agentId, expectedVersion: version };
    assert.equal((await post({ ...publish, approvals: ["forged"] })).status, 400);
    const response = await post(publish); assert.equal(response.status, 200);
    const catalogue = await response.json() as { packages: { id: string; contentHash: string }[] };
    const pkg = catalogue.packages[0]!;
    const exportUrl = url.replace("/api/agent-packages", "/api/agent-package-export?id=" + pkg.id);
    assert.equal((await fetch(exportUrl)).status, 401);
    assert.equal((await fetch(exportUrl, { headers: { authorization: "demo.operator", "x-workspace": "other" } })).status, 404);
    const exported = await fetch(exportUrl, { headers: { authorization: "demo.operator" } });
    assert.equal(exported.status, 200);
    const artifact = await exported.json() as { evaluations: unknown[]; draftTemplate: { kind: string } };
    assert.equal(artifact.evaluations.length, 1);
    assert.equal(artifact.draftTemplate.kind, "agentick-agent-template");
    const approve = { action: "approve", packageId: pkg.id, expectedHash: pkg.contentHash };
    assert.equal((await post(approve)).status, 403);
    assert.equal((await post(approve, "demo.reviewer-one", { "x-fresh": "false" })).status, 403);
    assert.equal((await post(approve, "demo.reviewer-one", { "x-workspace": "other" })).status, 404);
    revoke = true; lookups = 0;
    assert.equal((await post(approve, "demo.reviewer-one")).status, 403);
    assert.equal(demo.agentTests.packages.snapshot(DEMO_WORKSPACE).packages[0]!.approvals.length, 0);
    revoke = false;
    assert.equal((await post(approve, "demo.reviewer-one")).status, 200);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await demo.agentTests.close(); await demo.bots.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
