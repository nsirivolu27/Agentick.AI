import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { buildAuditPackage, canonical, verifyAuditPackage } from "../workbench/audit-package.js";

function fixture() {
  const engine = memoryPipelines();
  engine.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: true }] } }, 2);
  engine.execute("one", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Review evidence",
    brief: "Check the handoff.", materials: [{ id: randomUUID(), title: "Procedure", content: "Original procedure." }] }, 2);
  const current = () => engine.snapshot("one").runs[0]!;
  const act = (action: string, actor: string, fields = {}) => engine.execute("one", actor,
    actor === "owner" ? ["author"] : ["approver"], { action, runId: current().id, expectedRevision: current().revision, ...fields }, 2);
  return { engine, current, act };
}

test("requested changes preserve original output, invalidate approvals and bind new approvals to revised sources", () => {
  const { engine, current, act } = fixture();
  act("complete", "owner", { note: "Original handoff." });
  act("approve", "reviewer-one");
  const old = current(); const oldHash = old.stages[0]!.sourceHash;
  assert.throws(() => act("request_changes", "owner", { note: "Self review." }), /independent reviewer/);
  act("request_changes", "reviewer-two", { note: "Resolve the contradictory source." });
  assert.equal(current().stages[0]!.status, "active");
  assert.deepEqual(current().stages[0]!.approvals, []);
  assert.equal(current().stages[0]!.output, "Original handoff.");
  assert.throws(() => act("approve", "reviewer-one"), /not awaiting review/);
  act("materials", "owner", { materials: [{ id: randomUUID(), title: "Corrected procedure", content: "Corrected source." }] });
  act("complete", "owner", { note: "Corrected handoff." });
  assert.notEqual(current().stages[0]!.sourceHash, oldHash);
  assert.throws(() => engine.execute("one", "reviewer-two", ["approver"], {
    action: "approve", runId: current().id, expectedRevision: old.revision,
  }, 2), /changed/);
  act("approve", "reviewer-one"); act("approve", "reviewer-two");
  const run = current();
  assert.equal(run.status, "complete");
  assert.equal(Object.keys(run.sourceHistory!).length, 2);
  assert.equal(run.stages[0]!.revisions![1]!.priorApprovals[0]!.actor, "reviewer-one");
  assert.ok(run.stages[0]!.approvalRecords!.every(record => record.version === 3 && record.sourceHash === run.stages[0]!.sourceHash));
  const pkg = buildAuditPackage(run, { workspaceId: "one", actor: "reader" });
  assert.equal(verifyAuditPackage(pkg).ok, true);
  const changed = structuredClone(pkg);
  changed.stages[0]!.approvalRecords![0]!.version = 1;
  const { packageHash: _, ...body } = changed;
  changed.packageHash = createHash("sha256").update(canonical(body)).digest("hex");
  assert.equal(verifyAuditPackage(changed).ok, false, "rehashing cannot make a stale approval internally consistent");
});

test("author revisions reopen review and require a reason; foreign workspaces cannot revise", () => {
  const { engine, current, act } = fixture();
  act("complete", "owner", { note: "Original." }); act("approve", "reviewer-one");
  assert.throws(() => act("revise", "owner", { note: "Changed.", reason: "" }));
  assert.throws(() => act("revise", "reviewer-two", { note: "Changed.", reason: "Reviewer's edit." }), /owner or an admin/);
  assert.throws(() => engine.execute("other", "owner", ["author"], {
    action: "revise", runId: current().id, expectedRevision: current().revision, note: "Changed.", reason: "Update.",
  }, 2), /not found/);
  act("revise", "owner", { note: "Changed.", reason: "Clarified the uncertainty." });
  assert.equal(current().stages[0]!.status, "active");
  assert.deepEqual(current().stages[0]!.approvals, []);
  assert.equal(current().stages[0]!.revisions![1]!.before, "Original.");
  act("complete", "owner", { note: "Changed." });
  assert.equal(verifyAuditPackage(buildAuditPackage(current(), { workspaceId: "one", actor: "reader" })).ok, true);
});
