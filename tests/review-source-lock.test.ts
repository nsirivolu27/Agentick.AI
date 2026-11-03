import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filePipelines } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";

test("a restart between signatures preserves the source under review", t => {
  const directory = mkdtempSync(join(tmpdir(), "agentick-review-"));
  let store = fileWorkspaceStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let engine = filePipelines(store);
  const workspace = "review-demo";
  const config = engine.snapshot(workspace).config;
  config.stages[0]!.approval = true;
  engine.execute(workspace, "owner", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const source = { id: randomUUID(), title: "Service guide", content: "A second reviewer signs the handoff." };
  const run = engine.execute(workspace, "owner", ["author"], { action: "start", requestId: randomUUID(),
    title: "Prepare the service handoff", brief: "Document the review requirement.", materials: [source] }, 2).runs[0]!;
  const current = () => engine.snapshot(workspace).runs[0]!;
  const command = (action: string, extra = {}) => ({ action, runId: run.id, expectedRevision: current().revision, ...extra });
  engine.execute(workspace, "owner", ["author"], command("complete", { note: source.content }), 2);
  assert.equal(current().stages[0]!.status, "awaiting_review");
  assert.throws(() => engine.execute(workspace, "owner", ["admin"], command("approve"), 2), /cannot approve/);
  engine.execute(workspace, "reviewer-a", ["approver"], command("approve"), 2);
  store.close();
  store = fileWorkspaceStore(directory);
  engine = filePipelines(store);
  const pending = current();
  for (const replacement of [[], [{ ...source, content: "Skip the second reviewer." }]]) {
    assert.throws(() => engine.execute(workspace, "owner", ["admin"], command("materials", { materials: replacement }), 2), /under review/);
    assert.deepEqual(current(), pending);
  }
  assert.throws(() => engine.execute(workspace, "reviewer-a", ["approver"], command("approve"), 2), /already approved/);
  engine.execute(workspace, "reviewer-b", ["approver"], command("approve"), 2);
  assert.equal(current().current, 1);
  assert.deepEqual(current().stages[0]!.approvals, ["reviewer-a", "reviewer-b"]);
});
