import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { DEMO_MEMBERS, DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";
import { createDeclarationDemo } from "../workbench/openfema-demo.js";
import { createAnalystRuntime, type AnalystJob } from "../workbench/analyst-runtime.js";
import { briefingState, femaWorkspacePage } from "../workbench/fema-workspace-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
async function fixture() {
  const demo = await createDeclarationDemo(content);
  const owner = DEMO_MEMBERS[0]!;
  const runtime = createAnalystRuntime({ ...demo,
    material: demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!,
    authorize: (workspace, actor) => demo.context.members.rolesFor(workspace, actor),
  });
  const job = await runtime.command(DEMO_WORKSPACE, owner.actor, owner.roles, {
    action: "start", requestId: randomUUID(), area: "VA", county: "Montgomery", scope: "snapshot",
    question: "Which declaration appears in the saved county sample?",
  }, 2);
  for (let i = 0; i < 200 && ["queued", "running"].includes(runtime.snapshot(DEMO_WORKSPACE).jobs[0]!.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const snapshot = (): WorkbenchSnapshot => ({ workspaceId: DEMO_WORKSPACE, actor: owner.actor,
    roles: [...owner.roles], canAuthor: true, workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: false },
    pipelines: demo.pipelines.snapshot(DEMO_WORKSPACE), analyst: runtime.snapshot(DEMO_WORKSPACE),
  });
  return { demo, runtime, owner, job, snapshot };
}

test("FEMA operations follows a real saved-source execution through submission without implying approval", async t => {
  const f = await fixture(); t.after(() => f.runtime.close());
  let snapshot = f.snapshot();
  const job = snapshot.analyst!.jobs[0]!;
  assert.equal(job.status, "completed");
  assert.equal(job.sources[0]!.rows, 5);
  assert.equal(job.sources[0]!.declarations, 1);
  assert.equal(briefingState(snapshot, job), "Ready to submit");
  const run = snapshot.pipelines!.runs.find(item => item.id === job.runId)!;
  f.demo.pipelines.execute(DEMO_WORKSPACE, f.owner.actor, f.owner.roles, {
    action: "complete", runId: run.id, expectedRevision: run.revision, note: run.stages[0]!.draft!.text,
  }, 2);
  snapshot = f.snapshot();
  assert.equal(briefingState(snapshot, job), "Awaiting approval");
  assert.equal(snapshot.pipelines!.runs.find(item => item.id === job.runId)!.stages[0]!.approvals.length, 0);
  const page = femaWorkspacePage(snapshot);
  assert.match(page.body, /Awaiting approval/);
  assert.match(page.body, new RegExp(`#/desk/${job.runId}`));
  assert.doesNotMatch(page.body, /Handoff complete/);
});

test("FEMA views keep source limits and workspace isolation visible", async t => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const snapshot = f.snapshot();
  const foreign: AnalystJob = { ...structuredClone(snapshot.analyst!.jobs[0]!), id: randomUUID(),
    workspaceId: "other-company", request: { ...snapshot.analyst!.jobs[0]!.request, question: "PRIVATE OTHER WORKSPACE" } };
  snapshot.analyst!.jobs.push(foreign);
  const own = snapshot.analyst!.jobs[0]!;
  own.request.question = "<script>unsafe</script>";
  const page = femaWorkspacePage(snapshot);
  assert.doesNotMatch(page.body, /PRIVATE OTHER WORKSPACE|<script>/);
  assert.match(page.body, /&lt;script&gt;unsafe/);
  const data = femaWorkspacePage(snapshot, "data").body;
  assert.match(data, /Offline Foundry replay/);
  assert.match(data, /5 area rows · 1 declaration/);
  assert.match(data, /does not establish no disaster impact/);
  assert.match(data, /not an official FEMA service/);
  own.status = "blocked";
  assert.equal(briefingState(snapshot, own), "Grounding required");
  own.status = "completed";
  snapshot.pipelines!.runs.find(item => item.id === own.runId)!.status = "cancelled";
  assert.equal(briefingState(snapshot, own), "Cancelled");
});

test("an unconfigured workspace offers setup without claiming a ready analyst", async t => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const snapshot = f.snapshot(); delete snapshot.analyst;
  const page = femaWorkspacePage(snapshot);
  assert.match(page.body, /Connect the analyst runtime/);
  assert.doesNotMatch(page.body, />New briefing</);
  assert.match(femaWorkspacePage(snapshot, "team").body, /Creating an agent does not connect it/);
});
