import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { filePipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { backupWorkspace, restoreWorkspace } from "../workbench/workspace-backup.js";
import { buildAuditPackage, verifyAuditPackage } from "../workbench/audit-package.js";

test("backup restores approved evidence after restart without overwriting or crossing workspace boundaries", () => {
  const source = mkdtempSync(join(tmpdir(), "workflow-source-"));
  const target = mkdtempSync(join(tmpdir(), "workflow-restore-"));
  const original = fileWorkspaceStore(source);
  let restored = fileWorkspaceStore(target);
  try {
    const engine = filePipelines(original);
    engine.execute("team", "admin", ["admin"], { action: "configure", expectedVersion: 1,
      config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: true }] } }, 1);
    let run = engine.execute("team", "owner", ["author"], { action: "start", requestId: randomUUID(),
      title: "Restore proof", brief: "Preserve the reviewed result." }, 1).runs[0]!;
    run = engine.execute("team", "owner", ["author"], { action: "complete", runId: run.id,
      expectedRevision: run.revision, note: "Reviewed output." }, 1).runs[0]!;
    engine.execute("team", "reviewer", ["approver"], { action: "approve", runId: run.id, expectedRevision: run.revision }, 1);
    const backup = backupWorkspace(original, "team");
    const changed = structuredClone(backup); changed.state.runs[0]!.title = "Tampered";
    assert.throws(() => restoreWorkspace(restored, "team", changed), /checksum/);
    assert.throws(() => restoreWorkspace(restored, "other", backup), /different workspace/);
    restoreWorkspace(restored, "team", backup);
    assert.throws(() => restoreWorkspace(restored, "team", backup), /not be overwritten/);
    restored.close(); restored = fileWorkspaceStore(target);
    const recovered = filePipelines(restored).snapshot("team").runs[0]!;
    assert.equal(recovered.status, "complete");
    assert.deepEqual(recovered.stages[0]!.approvals, ["reviewer"]);
    assert.equal(verifyAuditPackage(buildAuditPackage(recovered, { workspaceId: "team", actor: "reader" })).ok, true);
  } finally {
    original.close(); restored.close();
    rmSync(source, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
  }
});
