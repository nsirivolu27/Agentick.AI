import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDeclarationDemo } from "../workbench/openfema-demo.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { DEMO_MEMBERS, DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";
import { verifyAuditPackage, canonical, type AuditPackage } from "../workbench/audit-package.js";
import type { PipelineSnapshot } from "../workbench/pipeline.js";

test("public records become a cited draft and two independent decisions on the same handoff", async t => {
  const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  assert.equal(hash, "f1fcb0d5ae14e20b9b82719f29d28c385e5eecf0fb3f1503ae9af487844ad782");
  const demo = await createDeclarationDemo(content);
  const server = createWorkbenchServer({ ...demo, assets: new Map(), authenticate: async req => {
    const actor = req.headers.authorization?.slice(7);
    return DEMO_MEMBERS.some(member => member.actor === actor)
      ? { workspaceId: DEMO_WORKSPACE, actor: actor!, recentSignIn: req.headers["x-demo-stale"] !== "1" } : undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const [owner, first, second] = DEMO_MEMBERS.map(member => member.actor) as [string, string, string];
  const run = () => demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!;
  const headers = (actor: string) => ({ Authorization: "Bearer " + actor, "Content-Type": "application/json" });
  const post = (actor: string, action: string, extra = {}) => fetch(base + "/api/pipeline", { method: "POST", headers: headers(actor),
    body: JSON.stringify({ action, runId: demo.runId, expectedRevision: run().revision, ...extra }) });
  assert.equal((await post(first, "prepare_declaration_brief")).status, 403);
  assert.equal((await post(owner, "prepare_declaration_brief", { note: "forged" })).status, 400);
  const before = run().revision;
  const response = await post(owner, "prepare_declaration_brief");
  assert.equal(response.status, 200);
  const result = await response.json() as PipelineSnapshot;
  const brief = result.runs[0]!.stages[0]!.draft!.text;
  for (const county of ["Bedford", "York", "Montgomery", "Goochland", "Caroline"]) assert.ok(brief.includes(county));
  assert.match(brief, /5 area records, 1 distinct declaration/);
  assert.ok(brief.includes(hash) && brief.includes("2026-01-23") && brief.includes("#3631") && brief.includes("https://www.fema.gov"));
  assert.match(brief, /eligibility is outside/);
  assert.equal((await post(owner, "prepare_declaration_brief", { expectedRevision: before })).status, 409);
  assert.equal((await post(owner, "complete", { note: brief })).status, 200);
  assert.equal((await post(owner, "approve")).status, 403);
  const client = new Client({ name: "demo-review", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/api/pipeline-mcp"), { requestInit: { headers: { ...headers(first), "x-demo-stale": "1" } } });
  await client.connect(transport as Parameters<typeof client.connect>[0]);
  try {
    assert.equal((await client.callTool({ name: "update_pipeline_run", arguments: { action: "approve", runId: demo.runId, expectedRevision: run().revision } })).isError, true);
  } finally { await client.close(); }
  assert.equal((await post(first, "approve")).status, 200);
  assert.equal(run().stages[0]!.status, "awaiting_review");
  assert.equal((await post(first, "approve")).status, 409);
  assert.equal((await post(second, "approve")).status, 200);
  assert.equal(run().status, "complete");
  const download = await fetch(base + "/api/audit-package?run=" + demo.runId, { headers: headers(owner) });
  assert.equal(download.status, 200);
  const pkg = await download.json() as AuditPackage;
  assert.equal(pkg.stages[0]!.output, brief);
  assert.deepEqual(pkg.stages[0]!.approvals, [first, second]);
  assert.ok(verifyAuditPackage(pkg).ok);
  // Recompute the envelope to check signer evidence independently of file corruption.
  const { packageHash: _original, ...body } = pkg;
  body.stages[0]!.approvals = [first, first];
  const forged = { ...body, packageHash: createHash("sha256").update(canonical(body)).digest("hex") };
  assert.equal(verifyAuditPackage(forged).ok, false);
});
