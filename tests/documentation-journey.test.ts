import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentConfigurableSchema, saveConfigurable } from "../workbench/agent-configurables.js";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "../workbench/agent-demo-fixture.js";
import { verifyAny } from "../workbench/audit-package.js";
import { command } from "../workbench/bot-project.js";
import type { ChatEvent } from "../workbench/chat.js";
import type { Role } from "../registry/roles.js";
import { resourceContext, resourcePrompt } from "../workbench/resource-assistant.js";
import { createWorkbenchServer } from "../workbench/server.js";

/**
 * The documentation agent journey, end to end over HTTP with the scripted
 * demo model: open, choose a model, add a reference, create an agent with
 * bounded read grants, test it, review, approve, install, assign, run, and
 * read the audit record. Then every negative path. Scripted means the tool
 * reads, gates and hashes are real and the model answers are fixtures; this
 * is a regression journey, not a model accuracy result.
 */

test("a documentation agent goes from reference to audited handoff, and every shortcut is refused", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "documentation-journey-"));
  const demo = await createAgentDemo(directory);
  const roles = new Map<string, Role[]>(DEMO_MEMBERS.map(member => [member.actor, [...member.roles]]));
  let providerDown = false;
  const chat = { ...demo.chat, loadModel: async (model?: string) => { if (providerDown) throw new Error("connection refused"); return demo.chat.loadModel(model); } };
  const server = createWorkbenchServer({ ...demo, chat, assets: new Map(),
    context: { ...demo.context, members: { async rolesFor(workspace, actor) { return workspace === DEMO_WORKSPACE ? roles.get(actor) ?? [] : []; } } },
    authenticate: async request => request.headers.authorization ? { actor: String(request.headers.authorization), workspaceId: DEMO_WORKSPACE, recentSignIn: request.headers["x-fresh"] !== "false" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const get = async <T>(path: string, actor = "demo.operator") => { const response = await fetch(base + path, { headers: { authorization: actor } }); return { status: response.status, body: await response.json() as T }; };
  const post = async <T = Record<string, unknown>>(path: string, input: unknown, actor = "demo.operator", extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: actor, ...extra }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as T };
  };
  const chatEvents = async (content: string, actor = "demo.operator", signal?: AbortSignal) => {
    const response = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: actor }, body: JSON.stringify({ model: "demo-scripted", messages: [{ role: "user", content }] }), ...(signal ? { signal } : {}) });
    return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as ChatEvent);
  };
  const settle = async () => { for (let i = 0; i < 600; i++) { if (!(await get<{ busy: boolean }>("/api/bots")).body.busy && !(await get<{ busy: boolean }>("/api/agent-tests")).body.busy) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("The worker did not settle."); };
  try {
    // 1. Open the workspace. 2. Choose a working model.
    const workspace = await get<{ workspaceId: string; pipelines: { version: number; config: { stages: { id: string }[] } }; documents: { documents: unknown[] } }>("/api/workspace");
    assert.equal(workspace.status, 200); assert.equal(workspace.body.workspaceId, DEMO_WORKSPACE);
    const models = await get<{ models: string[]; options: { id: string; local: boolean; detail: string }[] }>("/api/chat/models");
    assert.deepEqual(models.body.models, ["demo-scripted"]); assert.match(models.body.options[0]!.detail, /Tool use not measured/);

    // 3. Add a synthetic reference document.
    const added = await post<{ documents: { id: string; title: string; contentHash: string }[] }>("/api/documents", { action: "add_document", title: "Onboarding runbook (synthetic)", text: "New starters get read access on day one. Admin access needs the team owner's approval." });
    assert.equal(added.status, 200); const runbook = added.body.documents.find(item => item.title.startsWith("Onboarding"))!;

    // 4. Create a documentation agent with explicit instructions and one bounded read grant, and assign it to the first stage.
    const version = workspace.body.pipelines.version;
    const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Onboarding documentation agent", purpose: "Answer onboarding questions from SOP.md only.", model: "demo-scripted",
      instructions: "Read SOP.md with read_project_file. Answer only from it, cite it, and say what the source does not cover. Return no changes.",
      bot: { kind: "planner", requireSourceRead: true, maxSteps: 4, timeoutSeconds: 120, allowedTools: ["read_project_file"], maxToolCalls: 2 } });
    const configured = await post<{ version: number }>("/api/pipeline", { action: "configure", expectedVersion: version, config: saveConfigurable(demo.pipelines.snapshot(DEMO_WORKSPACE).config, agent) });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));

    // 5. Add and run a test case. 6. Inspect the source reads, answer and evidence.
    const saved = await post<{ cases: { id: string; agentId: string }[] }>("/api/agent-tests", { action: "save_case", agentId: agent.id, title: "Who approves admin access?", prompt: "Who approves admin access for a new starter? Cite SOP.md.", expected: "Names the team owner and cites SOP.md.", source: "SOP.md" });
    assert.equal(saved.status, 200); const testCase = saved.body.cases.find(item => item.agentId === agent.id)!;
    const started = await post("/api/agent-tests", { action: "run", caseId: testCase.id, expectedVersion: configured.body.version });
    assert.equal(started.status, 200); await settle();
    const tests = await get<{ runs: { id: string; caseId: string; status: string; sourceRead: boolean; toolCalls: { name: string; path?: string; outcome: string }[]; evidence?: { path: string; sha256: string }[]; summary: string; evidenceCurrent?: boolean }[] }>("/api/agent-tests");
    const run = tests.body.runs.find(item => item.caseId === testCase.id)!;
    assert.equal(run.status, "succeeded"); assert.equal(run.sourceRead, true);
    assert.deepEqual(run.toolCalls.map(call => `${call.name}:${call.path}:${call.outcome}`), ["read_project_file:SOP.md:read"]);
    assert.equal(run.evidence?.[0]?.path, "SOP.md"); assert.match(run.evidence![0]!.sha256, /^[a-f0-9]{64}$/); assert.equal(run.evidenceCurrent, true);
    assert.match(run.summary, /Source: SOP.md/);

    // 7. Request review (publish the package). 8 and 9. Distinct demo reviewers approve the exact content hash; the publisher and a stale sign in cannot.
    const review = await post("/api/agent-tests", { action: "review", runId: run.id, verdict: "pass", note: "Cites the SOP; no invented steps." }, "demo.reviewer-one");
    assert.equal(review.status, 200);
    const published = await post<{ packages: { id: string; agent: { id: string }; contentHash: string }[] }>("/api/agent-packages", { action: "publish", agentId: agent.id, expectedVersion: configured.body.version });
    assert.equal(published.status, 200, JSON.stringify(published.body)); const pkg = published.body.packages.find(item => item.agent.id === agent.id)!;
    const approve = { action: "approve", packageId: pkg.id, expectedHash: pkg.contentHash };
    assert.equal((await post("/api/agent-packages", approve)).status, 403, "no self approval");
    assert.equal((await post("/api/agent-packages", approve, "demo.reviewer-one", { "x-fresh": "false" })).status, 403, "a stale sign in cannot approve");
    const install = { action: "install", packageId: pkg.id, expectedHash: pkg.contentHash };
    assert.equal((await post("/api/agent-packages", install)).status, 409, "not ready before two approvals");
    assert.equal((await post("/api/agent-packages", approve, "demo.reviewer-one")).status, 200);
    assert.equal((await post("/api/agent-packages", approve, "demo.reviewer-one")).status, 409, "the same reviewer cannot sign twice");
    assert.equal((await post("/api/agent-packages", approve, "demo.reviewer-two")).status, 200);

    // 10 and 11. Install the reviewed package, assign it to the first stage, start a work item and run it.
    const installed = await post<{ installations: { id: string; packageId: string }[] }>("/api/agent-packages", install);
    assert.equal(installed.status, 200, JSON.stringify(installed.body)); const installation = installed.body.installations.find(item => item.packageId === pkg.id)!;
    const current = demo.pipelines.snapshot(DEMO_WORKSPACE).version;
    const assigned = await post<{ version: number }>("/api/agent-packages", { action: "assign", installationId: installation.id, stageId: "answer", expectedVersion: current });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const work = await post<{ runs: { id: string; revision: number; title: string }[] }>("/api/pipeline", { action: "start", requestId: randomUUID(), title: "Onboarding access question", brief: "Who approves admin access for a new starter? Cite SOP.md." });
    assert.equal(work.status, 200); const item = work.body.runs.find(run => run.title === "Onboarding access question")!;
    const bot = await post("/api/bots", { action: "start", runId: item.id, expectedRevision: item.revision, requestId: randomUUID() });
    assert.equal(bot.status, 200, JSON.stringify(bot.body)); await settle();
    const attempts = await get<{ attempts: { id: string; runId: string; status: string; proposalHash: string; sourceEvidence?: unknown[] }[] }>("/api/bots");
    const attempt = attempts.body.attempts.find(candidate => candidate.runId === item.id)!;
    assert.equal(attempt.status, "ready"); assert.ok(attempt.sourceEvidence?.length, "the handoff carries frozen source reads");
    const accepted = await post("/api/bots", { action: "accept", attemptId: attempt.id, expectedHash: attempt.proposalHash });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    // 12. Inspect the handoff and the audit record.
    const after = await get<{ pipelines: { runs: { id: string; current: number; stages: { output: string; outputHash: string }[]; events: { action: string }[] }[] } }>("/api/workspace");
    const handed = after.body.pipelines.runs.find(run => run.id === item.id)!;
    assert.equal(handed.current, 1); assert.match(handed.stages[0]!.output, /Source: SOP.md/); assert.match(handed.stages[0]!.output, /Bot attempt: /);
    const audit = await get<Record<string, unknown>>(`/api/audit-package?run=${item.id}`);
    assert.equal(audit.status, 200); assert.equal(verifyAny(audit.body).ok, true, JSON.stringify(verifyAny(audit.body).problems));

    // Negative paths. Source unavailable: a read of a document that does not exist is a failed required read, so no answer is accepted.
    const ask = (id: string) => `Use read_document to summarize this document. ${resourcePrompt(resourceContext("documents", "Onboarding runbook", id)!, "document")}`;
    const missing = await chatEvents(ask(randomUUID()));
    assert.ok(missing.some(event => event.type === "tool" && event.name === "read_document" && event.state === "failed"));
    assert.match((missing.at(-1) as { message: string }).message, /No answer was accepted: the required read read_document failed/);
    // Grounded read of the real document still works, and the answer carries the evidence hash.
    const grounded = await chatEvents(ask(runbook.id));
    const answer = grounded.at(-1); assert.ok(answer && answer.type === "answer" && answer.evidence?.grounded);
    assert.equal(answer.evidence.calls[0]!.tool, "read_document"); assert.match(answer.content, new RegExp(runbook.contentHash));
    // Tool denied: an agent definition cannot grant itself a write tool or a tool outside the catalog.
    assert.equal(agentConfigurableSchema.safeParse({ ...agent, bot: { ...agent.bot, allowedTools: ["write_project_file"] } }).success, false);
    // Provider unavailable: an honest error, nothing fabricated.
    providerDown = true;
    const down = await chatEvents("Explain the approval policy.");
    assert.ok(down.some(event => event.type === "error" && /could not complete this request/.test(event.message)) && !down.some(event => event.type === "answer"));
    providerDown = false;
    // Cancellation: the browser stops; the server reports no answer and the request slot is released for the next one.
    const stop = new AbortController(); const slow = chatEvents("Explain the approval policy.", "demo.operator", stop.signal); stop.abort();
    await assert.rejects(slow);
    const afterStop = await chatEvents("Explain the approval policy.");
    assert.ok(afterStop.some(event => event.type === "answer"), "a cancelled request does not block the next");
    // Source changed after testing: the committed source moves, the recorded evidence is no longer current, and installing fails closed.
    writeFileSync(join(demo.root, "SOP.md"), "# Access request SOP (synthetic)\n\nChanged after the test ran.\n");
    await command("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qam", "Change the SOP"], demo.root);
    const stale = (await get<{ runs: { id: string; evidenceCurrent?: boolean }[] }>("/api/agent-tests")).body.runs.find(candidate => candidate.id === run.id)!;
    assert.equal(stale.evidenceCurrent, false);
    const second = await post("/api/agent-packages", { action: "publish", agentId: agent.id, expectedVersion: demo.pipelines.snapshot(DEMO_WORKSPACE).version });
    assert.equal(second.status, 409, "a package cannot be published on evidence that is no longer current");
    // Output changed after approval: editing the agent changes its hash; the approved package no longer describes it and cannot be installed as that agent.
    const edited = saveConfigurable(demo.pipelines.snapshot(DEMO_WORKSPACE).config, { ...agent, instructions: agent.instructions + " Also list unrelated systems." });
    const reconfigured = await post<{ version: number }>("/api/pipeline", { action: "configure", expectedVersion: demo.pipelines.snapshot(DEMO_WORKSPACE).version, config: edited });
    assert.equal(reconfigured.status, 200);
    const reinstall = await post("/api/agent-packages", { action: "install", packageId: pkg.id, expectedHash: "0".repeat(64) });
    assert.equal(reinstall.status, 409, "an install bound to a different hash is refused");
    // Retired package: no further installation or assignment.
    assert.equal((await post("/api/agent-packages", { action: "retire", packageId: pkg.id, expectedHash: pkg.contentHash })).status, 200);
    assert.equal((await post("/api/agent-packages", { action: "assign", installationId: installation.id, stageId: "review", expectedVersion: demo.pipelines.snapshot(DEMO_WORKSPACE).version })).status, 409);
    // Membership revoked: the next request from that person is refused everywhere.
    roles.set("demo.reviewer-two", []);
    assert.equal((await get("/api/workspace", "demo.reviewer-two")).status, 403);
    assert.equal((await post("/api/agent-packages", approve, "demo.reviewer-two")).status, 403);
    // The directory recorded what actually happened.
    const connections = await get<{ entries: { id: string; state: string }[] }>("/api/connections");
    assert.equal(connections.body.entries.find(entry => entry.id === "sources:documents")!.state, "succeeded");
    assert.equal(connections.body.entries.find(entry => entry.id === "sources:repository")!.state, "verified");
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await demo.agentTests.close(); await demo.bots.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
