import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { buildAuditPackage, renderAuditPackage, verifyAuditPackage } from "../workbench/audit-package.js";
import { outputReview, runNow } from "../workbench/output-review.js";
import { DEFAULT_PIPELINE, memoryPipelines, pendingReviewers, type PipelineRun } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { workList } from "../workbench/workspace-view.js";

/**
 * A handoff is proposed to named people, not dropped into an anonymous
 * approval pool. The required approval count stays as the floor; every
 * named reviewer must also sign. Reviewers can bring in more of the team
 * and the discussion stays on the stage and in the audit package.
 */

function fixture(requiredApprovals = 1) {
  const engine = memoryPipelines();
  engine.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: true }, { ...DEFAULT_PIPELINE.stages[1], approval: false }] } }, requiredApprovals);
  engine.execute("one", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Quarterly dataset brief", brief: "Profile the dataset and brief the team." }, requiredApprovals);
  const current = () => engine.snapshot("one").runs[0]!;
  const rolesOf = (actor: string) => actor === "owner" ? ["author" as const] : actor === "admin" ? ["admin" as const] : ["approver" as const];
  const act = (action: string, actor: string, fields = {}) => engine.execute("one", actor, rolesOf(actor), { action, runId: current().id, expectedRevision: current().revision, ...fields }, requiredApprovals);
  return { engine, current, act };
}

test("a proposed handoff completes only when the count is met and every named reviewer has signed", () => {
  const { current, act } = fixture(1);
  assert.throws(() => act("complete", "owner", { note: "Brief v1.", reviewers: ["owner"] }), /cannot be named as reviewers/);
  assert.throws(() => act("complete", "owner", { note: "Brief v1.", reviewers: ["manager", "manager"] }), /named once/);
  act("complete", "owner", { note: "Brief v1.", reviewers: ["manager", "lead"] });
  let stage = current().stages[0]!;
  assert.equal(stage.status, "awaiting_review");
  assert.deepEqual(stage.proposal?.reviewers, ["manager", "lead"]); assert.equal(stage.proposal?.by, "owner"); assert.equal(stage.proposal?.outputHash, stage.outputHash);
  assert.deepEqual(current().events.map(event => event.action).slice(-2), ["review_requested", "proposed"]);
  assert.match(current().events.at(-1)!.detail, /Proposed to manager, lead/);
  // Someone outside the proposal signs: the count of one is met, but the named reviewers have not signed, so the stage waits.
  act("approve", "colleague");
  stage = current().stages[0]!;
  assert.equal(stage.status, "awaiting_review"); assert.deepEqual(pendingReviewers(stage), ["manager", "lead"]);
  act("approve", "manager");
  assert.equal(current().stages[0]!.status, "awaiting_review"); assert.deepEqual(pendingReviewers(current().stages[0]!), ["lead"]);
  act("approve", "lead");
  assert.equal(current().stages[0]!.status, "complete"); assert.equal(current().current, 1);
  act("cancel", "owner");
  assert.throws(() => act("comment", "manager", { note: "Late." }), /closed/);
  // Reviewers are a complete-time field only.
  const { act: again } = fixture(1);
  assert.throws(() => again("pause", "owner", { reviewers: ["manager"] }), /named when submitting/);
});

test("without reviewers the old count gate is unchanged, and a stage without a gate cannot be proposed", () => {
  const { current, act } = fixture(1);
  act("complete", "owner", { note: "Brief v1." });
  assert.equal(current().stages[0]!.proposal, undefined);
  act("approve", "anyone");
  assert.equal(current().stages[0]!.status, "complete");
  assert.throws(() => act("complete", "owner", { note: "Stage two.", reviewers: ["manager"] }), /no review gate/);
});

test("comments, change requests and resubmission keep the proposal; reviewers and the owner can add team members", () => {
  const { current, act } = fixture(2);
  act("comment", "manager", { note: "Reading the profile first." });
  act("complete", "owner", { note: "Brief v1.", reviewers: ["manager"] });
  act("comment", "manager", { note: "Which dataset version was profiled?" });
  act("comment", "owner", { note: "The October export, hash in the evidence block." });
  assert.throws(() => act("add_reviewers", "stranger", { reviewers: ["lead"] }), /named reviewer, the run owner or an admin/);
  assert.throws(() => act("add_reviewers", "manager", { reviewers: ["owner"] }), /cannot be named/);
  act("add_reviewers", "manager", { reviewers: ["lead"], note: "Lead owns the numbers." });
  assert.deepEqual(current().stages[0]!.proposal?.reviewers, ["manager", "lead"]);
  assert.match(current().events.at(-1)!.detail, /lead asked to review\. Lead owns the numbers\./);
  act("add_reviewers", "owner", { reviewers: ["lead", "analyst"] });
  assert.deepEqual(current().stages[0]!.proposal?.reviewers, ["manager", "lead", "analyst"], "duplicates fold into the list");
  const firstHash = current().stages[0]!.outputHash;
  act("request_changes", "lead", { note: "Add the missing counties." });
  assert.equal(current().stages[0]!.status, "active");
  assert.deepEqual(current().stages[0]!.proposal?.reviewers, ["manager", "lead", "analyst"], "the proposal survives a change request");
  assert.throws(() => act("add_reviewers", "manager", { reviewers: ["x"] }), /awaits review/);
  act("comment", "owner", { note: "Counties added." });
  act("complete", "owner", { note: "Brief v2 with all counties." });
  const stage = current().stages[0]!;
  assert.deepEqual(stage.proposal?.reviewers, ["manager", "lead", "analyst"], "a resubmission goes back to the same people");
  assert.equal(stage.proposal?.outputHash, stage.outputHash);
  assert.equal(stage.comments?.length, 4);
  assert.equal(stage.comments![0]!.outputHash, "", "a comment before any output names none");
  assert.equal(stage.comments![1]!.outputHash, firstHash, "a comment names the output it was about");
  assert.throws(() => act("complete", "owner", { note: "Brief v3.", reviewers: ["manager"] }), /cannot be completed now/, "a handoff under review is revised, not resubmitted over");
  assert.equal(current().stages[0]!.status, "awaiting_review");
});

test("the review screen shows the proposal, flags the named reviewer, and offers comments and team review", () => {
  const { current, act } = fixture(2);
  act("complete", "owner", { note: "Brief v1.", reviewers: ["manager", "lead"] });
  act("comment", "manager", { note: "Looks complete; lead to confirm the ranges." });
  act("approve", "manager");
  const run = current();
  const page = (actor: string, roles: ("author" | "approver" | "admin")[]) => outputReview({ run, phase: 0, actor, roles, where: "desk", approvers: ["manager", "lead", "colleague"] });
  const lead = page("lead", ["approver"]);
  assert.match(lead, /Proposed to you/); assert.match(lead, /class="review-named signed">manager ✓/); assert.match(lead, /still needed from lead/);
  assert.match(lead, /data-pipeline-action="approve"/); assert.match(lead, /Discussion · 1/); assert.match(lead, /Looks complete; lead to confirm the ranges\./);
  assert.match(lead, /data-review-command="comment"/); assert.match(lead, /data-review-command="add_reviewers"/); assert.match(lead, /<datalist id="workspace-approvers">/);
  const colleague = page("colleague", ["approver"]);
  assert.match(colleague, /Awaiting approval/); assert.doesNotMatch(colleague, /Proposed to you/); assert.doesNotMatch(colleague, /data-review-command="add_reviewers"/, "only named reviewers, the owner or an admin widen the review");
  const owner = page("owner", ["author"]);
  assert.match(owner, /data-review-command="add_reviewers"/); assert.match(owner, /The owner and the author of the output cannot approve it/);
  const now = runNow(run, { actor: "lead", roles: ["approver"] });
  assert.equal(now.state.label, "Proposed to you"); assert.equal(now.action, "Your review was requested"); assert.match(now.who, /Proposed to manager, lead · 1 of 2/);
  assert.equal(runNow(run, { actor: "colleague", roles: ["approver"] }).state.label, "Awaiting approval");
  const snapshot = { config: run.config, runs: [run], version: 1, storage: "memory" as const, jiraDelivery: "preview" as const };
  assert.match(workList(snapshot, undefined, "", "lead"), /proposed to you/);
  assert.doesNotMatch(workList(snapshot, undefined, "", "manager"), /proposed to you/, "a reviewer who signed is not asked again");
  // A fresh handoff form offers the reviewer field only on a gated stage.
  const fresh = fixture(1).current();
  assert.match(outputReview({ run: fresh, phase: 0, actor: "owner", roles: ["author"], where: "desk" }), /name="reviewers"/);
  assert.doesNotMatch(outputReview({ run: fresh, phase: 0, actor: "owner", roles: ["author"], where: "desk" }), /<datalist/, "no directory listing means no suggestions, never invented names");
});

test("the audit package records the proposal and discussion and refuses a completion that skipped a named reviewer", () => {
  const { current, act } = fixture(1);
  act("complete", "owner", { note: "Brief v1.", reviewers: ["manager"] });
  act("comment", "manager", { note: "Checked against the profile." });
  act("approve", "manager");
  const run = current();
  const pkg = buildAuditPackage(run, { workspaceId: "one", actor: "owner" });
  assert.deepEqual(pkg.stages[0]!.proposal?.reviewers, ["manager"]); assert.equal(pkg.stages[0]!.comments?.length, 1);
  assert.equal(verifyAuditPackage(pkg).ok, true);
  const markdown = renderAuditPackage(pkg);
  assert.match(markdown, /Proposed to manager by owner/); assert.match(markdown, /Comment by manager at .*: Checked against the profile\./);
  const tampered: PipelineRun = structuredClone(run);
  tampered.stages[0]!.approvals = ["colleague"]; tampered.stages[0]!.approvalRecords = [];
  tampered.events = tampered.events.map(event => event.action === "approved" ? { ...event, actor: "colleague" } : event);
  const broken = verifyAuditPackage(buildAuditPackage(tampered, { workspaceId: "one", actor: "owner" }));
  assert.equal(broken.ok, false); assert.ok(broken.problems.some(problem => /without the named reviewer manager/.test(problem)), broken.problems.join("\n"));
});

test("over HTTP a proposal to someone who cannot sign is refused and the workspace snapshot lists who can", async t => {
  const members = memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["author"] }, { workspaceId: "one", actor: "manager", roles: ["approver"] },
    { workspaceId: "one", actor: "boss", roles: ["admin", "approver"] }, { workspaceId: "one", actor: "writer", roles: ["author"] }]);
  const pipelines = memoryPipelines();
  pipelines.execute("one", "boss", ["admin"], { action: "configure", expectedVersion: 1, config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: true }] } }, 1);
  const server = createWorkbenchServer({ context: { store: memoryStore(), audit: memoryAudit(), members }, assets: new Map(), pipelines,
    authenticate: async request => request.headers.authorization ? { workspaceId: "one", actor: String(request.headers.authorization) } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (actor: string, body: unknown) => fetch(`${base}/api/pipeline`, { method: "POST", headers: { Authorization: actor, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const snapshot = await (await fetch(`${base}/api/workspace`, { headers: { Authorization: "owner" } })).json() as { approvers: string[] };
  assert.deepEqual(snapshot.approvers, ["manager", "boss"]);
  assert.equal((await post("owner", { action: "start", requestId: randomUUID(), title: "Dataset brief", brief: "Brief." })).status, 200);
  const run = pipelines.snapshot("one").runs[0]!;
  const refused = await post("owner", { action: "complete", runId: run.id, expectedRevision: run.revision, note: "Brief v1.", reviewers: ["writer"] });
  assert.equal(refused.status, 400); assert.match(await refused.text(), /writer cannot approve handoffs/);
  assert.equal(pipelines.snapshot("one").runs[0]!.stages[0]!.status, "active", "nothing was recorded");
  const accepted = await post("owner", { action: "complete", runId: run.id, expectedRevision: run.revision, note: "Brief v1.", reviewers: ["manager"] });
  assert.equal(accepted.status, 200);
  const proposed = pipelines.snapshot("one").runs[0]!;
  assert.equal((await post("manager", { action: "add_reviewers", runId: proposed.id, expectedRevision: proposed.revision, reviewers: ["nobody"] })).status, 400);
  assert.equal((await post("manager", { action: "add_reviewers", runId: proposed.id, expectedRevision: proposed.revision, reviewers: ["boss"] })).status, 200);
  assert.deepEqual(pipelines.snapshot("one").runs[0]!.stages[0]!.proposal?.reviewers, ["manager", "boss"]);
});
