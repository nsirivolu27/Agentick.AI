import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDeclarationDemo } from "../workbench/openfema-demo.js";
import { createAnalystRuntime, type AnalystRuntime } from "../workbench/analyst-runtime.js";
import { DEMO_MEMBERS, DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";
import { analystBrief, ANALYST_EXAMPLES } from "../workbench/analyst-brief.js";
import { analystPage } from "../workbench/analyst-view.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
async function finished(runtime: AnalystRuntime, id: string) {
  for (let tries = 0; tries < 200; tries++) {
    const job = runtime.snapshot(DEMO_WORKSPACE).jobs.find(item => item.id === id)!;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Analyst did not finish");
}

test("snapshot briefing exports actual evidence without approving or submitting the run", async t => {
  const demo = await createDeclarationDemo(content);
  const runtime = createAnalystRuntime({ ...demo,
    material: demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!,
    authorize: (workspace, actor) => demo.context.members.rolesFor(workspace, actor) });
  t.after(() => runtime.close());
  const job = await runtime.command(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, ["author"],
    { action: "start", requestId: randomUUID(), area: "VA", county: "Montgomery",
      scope: "snapshot", question: ANALYST_EXAMPLES[0].question }, 2);
  const done = await finished(runtime, job.id);
  const text = analystBrief(done)!;
  assert.match(text, /Montgomery \(County\).*#3631/);
  assert.match(text, /not an approved handoff/);
  assert.match(text, /offline replay/);
  assert.ok(text.includes(done.sources[0]!.hash));
  assert.match(text, /get_ontology_object: succeeded/);
  const run = demo.pipelines.snapshot(DEMO_WORKSPACE).runs.find(item => item.id === job.runId)!;
  assert.equal(run.stages[0]!.status, "active");
  assert.deepEqual(run.stages[0]!.approvals, []);
  assert.equal(analystBrief({ ...done, status: "failed" }), undefined);
  assert.equal(analystBrief({ ...done, report: undefined } as unknown as typeof done), undefined);
});

test("fresh public evidence yields a downloadable report but no Foundry-bound draft", async t => {
  const demo = await createDeclarationDemo(content);
  const runtime = createAnalystRuntime({ ...demo,
    material: demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!,
    authorize: (workspace, actor) => demo.context.members.rolesFor(workspace, actor),
    request: async () => Response.json({ DisasterDeclarationsSummaries: [] }) });
  t.after(() => runtime.close());
  const job = await runtime.command(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, ["author"],
    { action: "start", requestId: randomUUID(), area: "VA", county: "Fairfax",
      scope: "bounded_live", question: "What does this query establish?" }, 2);
  const done = await finished(runtime, job.id);
  assert.equal(done.status, "blocked");
  assert.match(analystBrief(done)!, /live-openfema/);
  assert.match(analystBrief(done)!, /does not establish that the county was unaffected/);
  const run = demo.pipelines.snapshot(DEMO_WORKSPACE).runs.find(item => item.id === job.runId)!;
  assert.equal(run.stages[0]!.draft, undefined);
  const page = analystPage({ analyst: runtime.snapshot(DEMO_WORKSPACE),
    pipelines: demo.pipelines.snapshot(DEMO_WORKSPACE), actor: DEMO_MEMBERS[0]!.actor,
    roles: ["author"], canAuthor: true } as WorkbenchSnapshot, job.id, emptyStudioUi());
  assert.match(page.actions!, /Download briefing/);
  assert.match(page.body, /Evidence-only report/);
  assert.match(page.body, /submission is blocked/);
  assert.doesNotMatch(page.body, /Submit for review/);
});

test("unconfigured local workspace explains the dedicated launcher and examples are explicit", () => {
  const page = analystPage({} as WorkbenchSnapshot, undefined, emptyStudioUi());
  assert.match(page.body, /corepack pnpm start:analyst/);
  assert.match(page.body, /separately from this workspace/);
  assert.match(page.body, /synthetic reviewers/);
  assert.equal(ANALYST_EXAMPLES.length, 3);
  assert.equal(ANALYST_EXAMPLES[2].scope, "bounded_live");
});
