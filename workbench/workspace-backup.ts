import { createHash } from "node:crypto";
import { z } from "zod";
import { buildAuditPackage, canonical, verifyAuditPackage } from "./audit-package.js";
import type { WorkspaceState, WorkspaceStore } from "./storage.js";

const schema = z.object({
  kind: z.literal("agentick-workflow-backup"), version: z.literal(1),
  workspaceId: z.string().min(1), createdAt: z.string().datetime(),
  state: z.unknown(), checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Private workflow state only; not a backup of credentials or separate service stores. */
export function backupWorkspace(store: WorkspaceStore, workspaceId: string) {
  const state = store.read(workspaceId);
  if (!state) throw new Error("Workspace not found.");
  const body = { kind: "agentick-workflow-backup" as const, version: 1 as const,
    workspaceId, createdAt: new Date().toISOString(), state };
  return { ...body, checksum: digest(body) };
}

/** Restore into a fresh, exclusively locked store. Never overwrite existing state. */
export function restoreWorkspace(store: WorkspaceStore, workspaceId: string, input: unknown): void {
  const parsed = schema.parse(input);
  const { checksum, ...body } = parsed;
  if (body.workspaceId !== workspaceId) throw new Error("Backup belongs to a different workspace.");
  if (digest(body) !== checksum) throw new Error("Backup checksum does not match.");
  if (store.read(workspaceId)) throw new Error("Restore requires an empty workspace; existing state will not be overwritten.");
  // commit performs the storage module's full schema and coherence validation.
  // Audit verification additionally validates revision and frozen-source bindings.
  const state = body.state as WorkspaceState;
  try {
    if (!Array.isArray(state?.runs)) throw new Error();
    for (const run of state.runs) {
      const result = verifyAuditPackage(buildAuditPackage(run, { workspaceId, actor: "restore-verifier" }));
      if (!result.ok) throw new Error();
    }
  } catch { throw new Error("Backup contains invalid workflow evidence."); }
  store.commit(workspaceId, state);
}
