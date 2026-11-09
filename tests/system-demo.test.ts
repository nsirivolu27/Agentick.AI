import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSystemDemo } from "../workbench/system-demo.js";
import { DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { systemDemoPage } from "../workbench/system-demo-view.js";
import { verifyAny } from "../workbench/audit-package.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

test("the full demo executes tested packages through independent approval and exports verifiable evidence", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "system-demo-test-"));
  const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
  const demo = await createSystemDemo(directory, content);
  const server = createWorkbenchServer({ ...demo, assets: new Map(), demo: true,
    authenticate: async () => ({ workspaceId: DEMO_WORKSPACE, actor: "demo.operator" }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const tests = demo.agentTests.snapshot(DEMO_WORKSPACE).runs;
    assert.equal(tests.length, 2);
    for (const run of tests) {
      assert.equal(run.status, "succeeded");
      assert.equal(run.sourceRead, true);
      assert.deepEqual(run.toolCalls.map(call => [call.name, call.path, call.outcome]),
        [["read_project_file", "OpenFEMA.md", "read"]]);
      assert.match(run.summary, /5 county rows represent 1 distinct declaration/);
      assert.match(run.summary, /not a live Foundry connection/);
    }
    const packages = demo.agentTests.packages.snapshot(DEMO_WORKSPACE, 2);
    assert.equal(packages.installations.length, 2);
    assert.equal(packages.packages.length, 2);
    for (const pkg of packages.packages) {
      assert.equal(pkg.ready, true);
      assert.equal(new Set(pkg.approvals.map(item => item.by)).size, 2);
      assert.ok(pkg.approvals.every(item => item.by !== pkg.requestedBy && item.hash === pkg.contentHash));
    }
    const run = demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!;
    assert.equal(run.status, "complete");
    assert.deepEqual(demo.documents.snapshot(DEMO_WORKSPACE).documents[0]!.runs, [run.id]);
    assert.equal(run.stages.length, 2);
    assert.deepEqual(run.stages[1]!.approvals, ["demo.reviewer-one", "demo.reviewer-two"]);
    const attempts = demo.bots.snapshot(DEMO_WORKSPACE).attempts.filter(item => item.runId === run.id);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(item => item.status === "accepted" && item.sourceEvidence?.length));
    assert.equal(demo.pipelines.snapshot("unrelated-company").runs.length, 0);
    assert.equal(demo.agentTests.packages.snapshot("unrelated-company", 2).installations.length, 0);

    const workspace = await fetch(origin + "/api/workspace");
    assert.equal(workspace.status, 200);
    const snapshot = await workspace.json() as WorkbenchSnapshot;
    const page = systemDemoPage(snapshot);
    assert.match(page.body, /2 ready · 2 installed/);
    assert.match(page.body, /2 accepted outputs · 2\/2 approvals/);
    assert.ok(page.body.includes(`#/desk/${run.id}`));
    assert.match(page.body, /Responses and reviewer decisions are scripted demo fixtures/);
    const audit = await fetch(origin + `/api/audit-package?run=${run.id}`);
    assert.equal(audit.status, 200);
    const verification = verifyAny(await audit.json());
    assert.equal(verification.ok, true, JSON.stringify(verification.problems));
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await demo.agentTests.close();
    await demo.bots.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the walkthrough does not claim a company workspace ran the demo", () => {
  const page = systemDemoPage({ demo: false } as WorkbenchSnapshot);
  assert.match(page.body, /start:demo/);
  assert.doesNotMatch(page.body, /2 ready|This launch executed/);
});
