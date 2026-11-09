import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { recordedHandoff } from "../workbench/handoff-view.js";
import { activityPage } from "../workbench/review-views.js";
import { stageNodes, runStatusLabel } from "../workbench/units.js";
import { workflowPage } from "../workbench/workflow-view.js";
import { workList } from "../workbench/workspace-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function fixture() {
  const engine = memoryPipelines();
  const config = structuredClone(DEFAULT_PIPELINE);
  config.stages[0]!.approval = true;
  config.stages[0]!.bot = { kind: "planner", maxSteps: 4, timeoutSeconds: 60 };
  engine.execute("team", "admin", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const run = engine.execute("team", "owner", ["author"], { action: "start", requestId: randomUUID(),
    title: "Documentation request", brief: "Check the source." }, 2).runs[0]!;
  const pipelines = engine.execute("team", "owner", ["author"], { action: "complete",
    runId: run.id, expectedRevision: run.revision, note: "Recorded output <script>unsafe</script>" }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "team", actor: "owner", roles: ["author", "admin"],
    canAuthor: true, workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: true,
    mcp: { agents: [], withheld: [] }, chat: { configured: false }, pipelines };
  return { snapshot, run: pipelines.runs[0]! };
}

test("workflow labels distinguish a supervised agent from manual work", () => {
  const { snapshot } = fixture();
  assert.match(stageNodes(snapshot)[0]!.note!, /Supervised agent/);
  const body = workflowPage(snapshot, undefined).body;
  assert.match(body, /supervised agent/);
  assert.doesNotMatch(body, /Done by hand/);
  delete snapshot.pipelines!.config.stages[0]!.bot;
  assert.match(stageNodes(snapshot)[0]!.note!, /By hand/);
});

test("a running work item waiting on signatures says awaiting approval", () => {
  const { snapshot, run } = fixture();
  assert.equal(runStatusLabel(run), "Awaiting approval");
  assert.match(workList(snapshot.pipelines!, run.id), /Awaiting approval/);
  run.status = "paused";
  assert.equal(runStatusLabel(run), "Paused");
});

test("workflow audit events appear without Model Studio and preserve workspace and project boundaries", () => {
  const { snapshot, run } = fixture();
  const other = structuredClone(run);
  other.id = randomUUID(); other.workspaceId = "other"; other.title = "Other workspace private work";
  snapshot.pipelines!.runs.push(other);
  const body = activityPage(snapshot).body;
  assert.match(body, /Documentation request/);
  assert.match(body, /review requested/);
  assert.match(body, /Event details/);
  assert.match(body, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>|Other workspace private work/);
  assert.doesNotMatch(activityPage(snapshot, randomUUID()).body, /Documentation request/);
});

test("only the exact recorded runtime footer is collapsed, with every signed byte still displayed", () => {
  const attempt = { id: randomUUID(), proposalHash: "abc", checkout: "local/path", checks: [] };
  const answer = "Ask the owner.\nNo access was granted.";
  const footer = `\n\nBot attempt: ${attempt.id}\nProposal: abc\nCheckout: local/path\nChecks: not run`;
  const output = answer + footer;
  const html = recordedHandoff(output, attempt);
  assert.match(html, /class="handoff-answer">Ask the owner/);
  assert.match(html, /Execution record · included in approval/);
  assert.match(html, /Checkout: local\/path/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.doesNotMatch(recordedHandoff(output + " Extra author note.", attempt), /Execution record/);
  assert.doesNotMatch(recordedHandoff(output, { ...attempt, id: randomUUID() }), /Execution record/);
  assert.equal(output, answer + footer);
});
