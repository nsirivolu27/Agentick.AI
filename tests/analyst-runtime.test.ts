import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createDeclarationDemo } from "../workbench/openfema-demo.js";
import { createAnalystRuntime, boundedDeclarations, type AnalystRuntime, type AnalystJob } from "../workbench/analyst-runtime.js";
import { analystPersistence } from "../workbench/analyst-persistence.js";
import { filePipelines } from "../workbench/pipeline.js";
import { DEMO_WORKSPACE, DEMO_MEMBERS } from "../workbench/agent-demo-fixture.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { verifyAuditPackage } from "../workbench/audit-package.js";
import { analystPage } from "../workbench/analyst-view.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
const owner = DEMO_MEMBERS[0]!.actor;
const start = (county = "Montgomery", scope = "snapshot") => ({
  action: "start", requestId: randomUUID(), area: "VA", county, scope, question: "Which declaration appears for this county, and what are the limits?",
});
async function fixture(request?: typeof fetch) {
  const demo = await createDeclarationDemo(content);
  const runtime = createAnalystRuntime({ ...demo,
    material: demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!,
    authorize: (workspace, actor) => demo.context.members.rolesFor(workspace, actor),
    ...(request ? { request } : {}),
  });
  return { ...demo, runtime };
}
async function finished(runtime: AnalystRuntime, id: string): Promise<AnalystJob> {
  for (let i = 0; i < 200; i++) {
    const job = runtime.snapshot(DEMO_WORKSPACE).jobs.find(job => job.id === id)!;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Analyst did not finish");
}

test("matching county executes the expected MCP reads, cites saved evidence, and stays at the real gate", async t => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const input = start();
  const job = await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], input, 2);
  const done = await finished(f.runtime, job.id);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.trace.map(entry => entry.tool), ["get_pipeline_run", "summarize_declaration_sample", "get_ontology_object"]);
  assert.ok(done.trace.every(entry => entry.outcome === "succeeded" && entry.durationMs >= 0 && entry.reason));
  assert.equal(done.sources[0]!.rows, 5); assert.equal(done.sources[0]!.declarations, 1);
  assert.equal(done.sources[0]!.hash, createHash("sha256").update(content).digest("hex"));
  assert.equal(done.sources[0]!.content, content);
  const run = () => f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!;
  assert.equal(run().stages[0]!.status, "active", "execution is not submission or approval");
  const draft = run().stages[0]!.draft!.text;
  assert.match(draft, /Montgomery \(County\).*#3631/);
  assert.match(draft, /offline Foundry replay/);
  assert.match(draft, /no model inference/);
  assert.match(draft, /Source \[1\]/);
  assert.equal((await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], input, 2)).id, job.id);
  assert.equal(f.runtime.snapshot("different").jobs.length, 0);
  f.pipelines.execute(DEMO_WORKSPACE, owner, ["author"], { action: "complete", runId: job.runId, expectedRevision: run().revision, note: draft }, 2);
  assert.throws(() => f.pipelines.execute(DEMO_WORKSPACE, owner, ["approver"], {
    action: "approve", runId: job.runId, expectedRevision: run().revision,
  }, 2), /own/);
  const first = DEMO_MEMBERS[1]!.actor;
  f.pipelines.execute(DEMO_WORKSPACE, first, ["approver"], { action: "approve", runId: job.runId, expectedRevision: run().revision }, 2);
  assert.equal(run().stages[0]!.status, "awaiting_review");
  assert.throws(() => f.pipelines.execute(DEMO_WORKSPACE, first, ["approver"], {
    action: "approve", runId: job.runId, expectedRevision: run().revision,
  }, 2));
});

test("missing county narrows the claim and does not invent an object lookup or unaffected county", async t => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const job = await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], start("Fairfax"), 2);
  const done = await finished(f.runtime, job.id);
  assert.equal(done.result, "limited");
  assert.equal(done.trace.length, 2);
  const run = f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!;
  assert.match(run.stages[0]!.draft!.text, /does not establish that the county was unaffected/);
});

test("bounded lookup deduplicates returned rows, caps pages and records, and preserves query provenance", async () => {
  const urls: string[] = [];
  const material = await boundedDeclarations("VA", "", new AbortController().signal, async input => {
    urls.push(String(input));
    return Response.json(JSON.parse(content));
  });
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!).searchParams.get("$skip"), "5");
  assert.ok(urls.every(url => new URL(url).origin === "https://www.fema.gov" && new URL(url).searchParams.get("$top") === "5"));
  assert.equal(JSON.parse(material.content).DisasterDeclarationsSummaries.length, 5);
  assert.deepEqual(JSON.parse(material.content).metadata.queries, urls);
  assert.equal(JSON.parse(material.content).metadata.returnedRows, 10);
  assert.equal(material.url, new URL(JSON.parse(material.content).metadata.url, "https://www.fema.gov").href);
});

test("upstream outage is an explicit failure; a bounded retry uses the same execution and work item", async t => {
  let outage = true; let calls = 0;
  const f = await fixture(async () => {
    calls++; return outage ? new Response(null, { status: 503 }) : Response.json({ DisasterDeclarationsSummaries: [] });
  }); t.after(() => f.runtime.close());
  const job = await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], start("Fairfax", "bounded_live"), 2);
  const failed = await finished(f.runtime, job.id);
  assert.equal(calls, 2); assert.equal(failed.status, "failed");
  assert.equal(failed.trace.at(-1)!.outcome, "failed");
  assert.equal(f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!.stages[0]!.draft, undefined);
  outage = false;
  await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], { action: "retry", id: job.id }, 2);
  const retried = await finished(f.runtime, job.id);
  assert.equal(retried.id, job.id); assert.equal(retried.runId, job.runId);
  assert.equal(retried.attempt, 2); assert.equal(retried.status, "blocked"); assert.equal(retried.result, "limited");
  assert.match(retried.error!, /not bound/);
  assert.equal(retried.sources.at(-1)!.mode, "live-openfema");
  assert.equal(retried.sources.at(-1)!.hash, createHash("sha256").update(retried.sources.at(-1)!.content).digest("hex"));
  assert.ok(retried.trace.some(entry => entry.outcome === "failed"), "retain prior failure evidence");
});

test("cancellation aborts an in-flight source read, closes clients, and prevents a draft or further calls", async t => {
  let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
  let calls = 0;
  const f = await fixture(async (_input, init) => {
    calls++; reached();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  }); t.after(() => f.runtime.close());
  const job = await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], start("Fairfax", "bounded_live"), 2);
  await entered;
  await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], { action: "cancel", id: job.id }, 2);
  await f.runtime.close();
  assert.equal(calls, 1);
  assert.equal(f.runtime.snapshot(DEMO_WORKSPACE).jobs[0]!.status, "cancelled");
  assert.equal(f.runtime.snapshot(DEMO_WORKSPACE).jobs[0]!.trace.at(-1)!.outcome, "cancelled");
  assert.equal(f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!.stages[0]!.draft, undefined);
});

test("cancellation while authorization is pending cannot dispatch another MCP call", async t => {
  const demo = await createDeclarationDemo(content);
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const permission = new Promise<void>(resolve => { release = resolve; });
  const runtime = createAnalystRuntime({ ...demo,
    material: demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!,
    authorize: async () => { entered(); await permission; return ["author"]; },
  }); t.after(() => runtime.close());
  const job = await runtime.command(DEMO_WORKSPACE, owner, ["author"], start(), 2);
  await reached;
  await runtime.command(DEMO_WORKSPACE, owner, ["author"], { action: "cancel", id: job.id }, 2);
  release(); await runtime.close();
  const saved = runtime.snapshot(DEMO_WORKSPACE).jobs[0]!;
  assert.equal(saved.status, "cancelled");
  assert.deepEqual(saved.trace, [], "no tool may start after cancellation");
  assert.equal(demo.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!.stages[0]!.draft, undefined);
});

test("work item changes during a live read reject the stale result rather than advancing the gate", async t => {
  let release!: (response: Response) => void; let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const f = await fixture(async () => { reached(); return new Promise<Response>(resolve => { release = resolve; }); });
  t.after(() => f.runtime.close());
  const job = await f.runtime.command(DEMO_WORKSPACE, owner, ["author"], start("Fairfax", "bounded_live"), 2);
  await entered;
  const run = f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!;
  assert.throws(() => f.pipelines.execute(DEMO_WORKSPACE, owner, ["author"], { action: "materials", runId: run.id,
    expectedRevision: run.revision, materials: [] }, 2), /verify a different declaration sample/);
  f.pipelines.execute(DEMO_WORKSPACE, owner, ["author"], { action: "pause", runId: run.id, expectedRevision: run.revision }, 2);
  release(Response.json({ DisasterDeclarationsSummaries: [] }));
  assert.equal((await finished(f.runtime, job.id)).status, "failed");
  assert.equal(f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!.stages[0]!.draft, undefined);
});

test("saved pipeline, job ID, trace and pending gate survive a local restart; corrupt state fails closed", async t => {
  const directory = mkdtempSync(join(tmpdir(), "analyst-persistence-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const saved = analystPersistence(directory);
  const demo = await createDeclarationDemo(content, filePipelines(saved.pipelines));
  const make = (demo: Awaited<ReturnType<typeof createDeclarationDemo>>) => createAnalystRuntime({ ...demo, persistence: saved.jobs,
    material: demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!,
    authorize: (workspace, actor) => demo.context.members.rolesFor(workspace, actor) });
  const runtime = make(demo);
  const job = await runtime.command(DEMO_WORKSPACE, owner, ["author"], start(), 2);
  await finished(runtime, job.id); await runtime.close();
  const restarted = await createDeclarationDemo(content, filePipelines(saved.pipelines));
  const recovered = make(restarted); t.after(() => recovered.close());
  assert.equal(recovered.snapshot(DEMO_WORKSPACE).jobs[0]!.id, job.id);
  assert.equal(recovered.snapshot(DEMO_WORKSPACE).jobs[0]!.trace.length, 3);
  assert.equal(restarted.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!.stages[0]!.status, "active");
  writeFileSync(join(directory, "analyst-jobs.json"), "{invalid");
  assert.throws(() => analystPersistence(directory).jobs.read(), /unreadable/);
});

test("HTTP analyst commands enforce identity, workspace, role, strict inputs and the existing audit verifier", async t => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const server = createWorkbenchServer({ ...f, context: { ...f.context, members: {
    rolesFor: (workspace, actor) => actor === "foreign" && workspace === "foreign"
      ? Promise.resolve(["author"] as const) : f.context.members.rolesFor(workspace, actor),
  } }, analyst: f.runtime, assets: new Map(), authenticate: async req => {
    const actor = req.headers.authorization?.slice(7);
    return actor === "foreign" ? { actor, workspaceId: "foreign" } : DEMO_MEMBERS.some(member => member.actor === actor)
      ? { actor: actor!, workspaceId: DEMO_WORKSPACE } : undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (actor: string, raw: unknown) => fetch(base + "/api/analyst", {
    method: "POST", headers: { authorization: "Bearer " + actor, "content-type": "application/json" }, body: JSON.stringify(raw),
  });
  assert.equal((await post("stranger", start())).status, 401);
  assert.equal((await post(DEMO_MEMBERS[1]!.actor, start())).status, 403);
  assert.equal((await post(owner, { ...start(), tools: ["write_file"] })).status, 400);
  assert.equal((await post(owner, { ...start(), area: "NY" })).status, 400);
  const response = await post(owner, start()); assert.equal(response.status, 200);
  const job = await response.json() as AnalystJob;
  await finished(f.runtime, job.id);
  const foreignSnapshot = await (await fetch(base + "/api/workspace", { headers: { authorization: "Bearer foreign" } })).json();
  assert.deepEqual(foreignSnapshot.analyst.jobs, []);
  assert.equal((await post("foreign", { action: "cancel", id: job.id })).status, 404);
  const run = () => f.pipelines.snapshot(DEMO_WORKSPACE).runs.find(run => run.id === job.runId)!;
  assert.equal((await post(owner, { action: "cancel", id: randomUUID() })).status, 404);
  const output = run().stages[0]!.draft!.text;
  f.pipelines.execute(DEMO_WORKSPACE, owner, ["author"], { action: "complete", runId: job.runId, expectedRevision: run().revision, note: output }, 2);
  for (const member of DEMO_MEMBERS.slice(1)) f.pipelines.execute(DEMO_WORKSPACE, member.actor, ["approver"], {
    action: "approve", runId: job.runId, expectedRevision: run().revision,
  }, 2);
  const download = await fetch(base + "/api/audit-package?run=" + job.runId, { headers: { authorization: "Bearer " + owner } });
  assert.equal(download.status, 200);
  const pkg = await download.json();
  assert.equal(verifyAuditPackage(pkg).ok, true);
  pkg.stages[0].output += "tampered";
  assert.equal(verifyAuditPackage(pkg).ok, false);
  assert.match(analystPage({ analyst: f.runtime.snapshot(DEMO_WORKSPACE), pipelines: f.pipelines.snapshot(DEMO_WORKSPACE),
    actor: owner, roles: ["author"], canAuthor: true } as WorkbenchSnapshot, job.id, emptyStudioUi()).body, /2 of 2 independent approvals/);
});
