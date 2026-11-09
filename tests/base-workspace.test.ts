import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { baseWorkspacePage } from "../workbench/base-workspace-view.js";
import { filterQueue, operationsQueue } from "../workbench/operations-model.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function fixture() {
  const engine = memoryPipelines();
  engine.execute("team", "owner", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0]!, approval: true }] } }, 2);
  engine.execute("team", "owner", ["author"], { action: "start", requestId: randomUUID(),
    title: "Service documentation", brief: "Prepare a source-based procedure for review." }, 2);
  const snapshot = (): WorkbenchSnapshot => ({ workspaceId: "team", actor: "owner", roles: ["author"],
    canAuthor: true, workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: true,
    mcp: { agents: [], withheld: [] }, chat: { configured: false }, pipelines: engine.snapshot("team") });
  return { engine, snapshot };
}

test("a draft in the base queue asks its owner to review output rather than claiming active execution", () => {
  const f = fixture(); const snapshot = f.snapshot();
  const run = snapshot.pipelines!.runs[0]!;
  run.stages[0]!.draft = { text: "Source-backed draft", hash: "draft", by: "assistant", jobId: randomUUID(), at: new Date().toISOString() };
  assert.equal(operationsQueue(snapshot)[0]!.state, "ready");
  assert.equal(operationsQueue(snapshot)[0]!.action, "Review output");
  snapshot.actor = "colleague";
  assert.equal(operationsQueue(snapshot)[0]!.state, "waiting");
  run.status = "paused";
  snapshot.actor = "owner";
  assert.equal(operationsQueue(snapshot)[0]!.state, "waiting");
});

test("queue owner filtering and workspace boundaries never show another workspace's run", () => {
  const f = fixture(); const snapshot = f.snapshot();
  snapshot.pipelines!.runs.push({ ...structuredClone(snapshot.pipelines!.runs[0]!), id: randomUUID(), workspaceId: "other", title: "Private other work" });
  const items = operationsQueue(snapshot);
  assert.equal(items.length, 1);
  assert.equal(filterQueue(items, "all", "", "owner").length, 1);
  assert.equal(filterQueue(items, "all", "", "colleague").length, 0);
});

test("specialized data does not replace the base workspace and setup does not imply readiness", () => {
  const snapshot = fixture().snapshot();
  snapshot.analyst = { jobs: [], controller: "rule-based", foundry: "offline-replay" };
  const page = baseWorkspacePage(snapshot);
  assert.equal(page.title, "Work queue");
  assert.match(page.body, /id="operations-queue"/);
  assert.match(page.body, /href="#\/fema"/);
  const readiness = baseWorkspacePage(snapshot, "readiness");
  assert.doesNotMatch(readiness.body, /id="operations-queue"/);
  assert.match(readiness.body, /Not configured/);
  assert.match(readiness.body, /Directory unavailable/);
  assert.match(readiness.body, /Demo identities/);
  assert.match(readiness.body, /not establish an ATO/);
  snapshot.pipelines!.runs[0]!.sourceHistory = { saved: [{ id: randomUUID(), title: "Captured SOP", content: "Read this procedure." }] };
  assert.match(baseWorkspacePage(snapshot, "readiness").body, /1 work items contain attached or captured source text/);
});

test("handoffs appear only after the real review gate finishes", () => {
  const f = fixture(); let run = f.snapshot().pipelines!.runs[0]!;
  f.engine.execute("team", "owner", ["author"], { action: "complete", runId: run.id, expectedRevision: run.revision, note: "Reviewed source draft." }, 2);
  assert.match(baseWorkspacePage(f.snapshot(), "handoffs").body, /No completed handoffs yet/);
  for (const actor of ["reviewer-one", "reviewer-two"]) {
    run = f.snapshot().pipelines!.runs[0]!;
    f.engine.execute("team", actor, ["approver"], { action: "approve", runId: run.id, expectedRevision: run.revision }, 2);
  }
  const handoffs = baseWorkspacePage(f.snapshot(), "handoffs").body;
  assert.match(handoffs, /Service documentation/);
  assert.match(handoffs, new RegExp(`#/desk/${run.id}`));
  assert.deepEqual(operationsQueue(f.snapshot()), []);
});
