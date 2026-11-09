import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { agentConfigurableSchema, saveConfigurable } from "../workbench/agent-configurables.js";
import { agentLifecycle, executionMode } from "../workbench/agent-lifecycle.js";
import { agentPackagesPage } from "../workbench/agent-packages-view.js";
import { agentStudioPage, lifecycleStrip } from "../workbench/agent-studio-view.js";
import { agentHash, testCaseHash, testRunSchema, testSuiteHash, type AgentTestsSnapshot } from "../workbench/agent-tests-model.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { emptyStudioUi } from "../workbench/studio-view.js";

/**
 * The agent journey as the interface tells it: create, ground, test, review,
 * approve, install, assign. Every state shown here is read from recorded
 * facts; nothing is promoted to "ready" by a failed or stale check.
 */

const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Docs helper", purpose: "Answer from the SOP.", model: "workspace/anthropic/claude-sonnet-4-5", instructions: "Read SOP.md and cite it.",
  bot: { kind: "planner", maxSteps: 4, timeoutSeconds: 60, allowedTools: ["read_project_file"], maxToolCalls: 2, requireSourceRead: true } });
const models = [{ id: agent.model, label: "Claude Sonnet · workspace connection", provider: "Workspace", available: true, local: false, detail: "Workspace connection." }];
const HASH = "a".repeat(64);

function fixture(roles: ("author" | "approver" | "admin")[] = ["admin", "author"], catalogue?: WorkbenchSnapshot["agentPackages"]) {
  const pipelines = memoryPipelines().execute("one", "operator", ["admin"], { action: "configure", expectedVersion: 1, config: saveConfigurable(DEFAULT_PIPELINE, agent) }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "one", actor: "operator", roles, canAuthor: true, demo: true,
    workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, records: [], audit: [], mcp: { agents: [], withheld: [] }, chat: { configured: true }, pipelines,
    bots: { project: { root: "/repo", checks: [] }, attempts: [], busy: false }, ...(catalogue ? { agentPackages: catalogue } : {}) };
  return snapshot;
}
function passedTests(): AgentTestsSnapshot {
  const caseId = randomUUID();
  const cases = [{ id: caseId, workspaceId: "one", agentId: agent.id, title: "Access process", prompt: "Explain the access process.", expected: "Cites SOP.md.", source: "SOP.md", createdBy: "operator", createdAt: "2026-10-12T09:00:00.000Z", updatedAt: "2026-10-12T09:00:00.000Z" }];
  const run = testRunSchema.parse({ id: randomUUID(), workspaceId: "one", caseId, agentId: agent.id, agentHash: agentHash(agent), agentName: agent.name, model: agent.model,
    prompt: "Explain the access process.", expected: "Cites SOP.md.", source: "SOP.md", startedBy: "operator", startedAt: "2026-10-12T10:00:00.000Z", finishedAt: "2026-10-12T10:00:04.000Z",
    status: "succeeded", summary: "The team owner approves.", error: "", toolCalls: [{ name: "read_project_file", path: "SOP.md", outcome: "read" }], sourceRead: true, calls: 2, tokenUsage: null,
    events: ["MCP tool: read_project_file", "Source read: SOP.md (90 characters)"], review: { verdict: "pass", note: "Matches the SOP.", by: "reviewer", at: "2026-10-12T10:05:00.000Z" },
    evidence: [{ path: "SOP.md", content: "A routine request needs the team owner's approval.", sha256: HASH, readAt: "2026-10-12T10:00:01.000Z" }],
    caseHash: testCaseHash(cases[0]!), suiteHash: testSuiteHash(cases, agent.id), evidenceCurrent: true });
  return { cases, runs: [run], busy: false };
}
function catalogue(options: { ready?: boolean; approvals?: number; installed?: boolean; olderInstalled?: boolean; stale?: boolean } = {}): NonNullable<WorkbenchSnapshot["agentPackages"]> {
  const base = { workspaceId: "one", agent, cases: [], runIds: [randomUUID()], runHashes: {}, requestedBy: "operator", createdAt: "2026-10-12T11:00:00.000Z", requiredApprovals: 2, retired: false };
  const current = { ...base, id: randomUUID(), version: 2, contentHash: HASH, approvals: Array.from({ length: options.approvals ?? 0 }, (_, index) => ({ by: `reviewer-${index + 1}`, hash: HASH, at: "2026-10-12T12:00:00.000Z" })),
    ready: options.ready ?? false, evidenceCurrent: !options.stale, effectiveApprovals: 2 };
  const older = { ...base, id: randomUUID(), version: 1, contentHash: "b".repeat(64), agent: { ...agent, instructions: "Older instructions." }, approvals: [], ready: false, evidenceCurrent: false, effectiveApprovals: 2 };
  const installations = [];
  if (options.olderInstalled) installations.push({ id: randomUUID(), packageId: older.id, by: "operator", at: "2026-10-12T13:00:00.000Z" });
  if (options.installed) installations.push({ id: randomUUID(), packageId: current.id, by: "operator", at: "2026-10-13T09:00:00.000Z" });
  return { workspaceId: "one", packages: [older, current], installations } as unknown as NonNullable<WorkbenchSnapshot["agentPackages"]>;
}

test("the lifecycle reads draft, tested, approved and installed from recorded facts and never from a failed check", () => {
  const draft = agentLifecycle(agent, undefined, undefined);
  assert.equal(draft.current, "draft"); assert.deepEqual(draft.steps.map(step => step.reached), [true, false, false, false]);
  const tested = agentLifecycle(agent, passedTests(), undefined);
  assert.equal(tested.current, "tested"); assert.match(tested.steps[2]!.detail, /Request package review/);
  const awaiting = agentLifecycle(agent, passedTests(), catalogue({ approvals: 1 }));
  assert.equal(awaiting.current, "tested", "one of two approvals is not an approved release"); assert.match(awaiting.steps[2]!.detail, /awaits 1 more independent approval\./);
  const stale = agentLifecycle(agent, passedTests(), catalogue({ approvals: 2, stale: true }));
  assert.equal(stale.current, "tested"); assert.match(stale.steps[2]!.detail, /evidence needs retesting/);
  const approved = agentLifecycle(agent, passedTests(), catalogue({ ready: true, approvals: 2 }));
  assert.equal(approved.current, "approved"); assert.equal(approved.installation, undefined);
  const installed = agentLifecycle(agent, passedTests(), catalogue({ ready: true, approvals: 2, installed: true }));
  assert.equal(installed.current, "installed"); assert.match(installed.steps[3]!.detail, /Installed 2026-10-13 by operator\./);
  const upgrade = agentLifecycle(agent, passedTests(), catalogue({ ready: true, approvals: 2, olderInstalled: true }));
  assert.equal(upgrade.current, "approved"); assert.match(upgrade.steps[3]!.detail, /v1 is installed; this saved version is not/);
  // The edited draft is not the package's version, so nothing after "draft" carries over.
  const edited = agentLifecycle({ ...agent, instructions: "Changed." }, passedTests(), catalogue({ ready: true, approvals: 2, installed: true }));
  assert.equal(edited.current, "draft"); assert.equal(edited.package, undefined);
});

test("execution mode is read from the recorded model identifier and says nothing about accuracy", () => {
  assert.equal(executionMode("demo-scripted").label, "Scripted demo");
  assert.equal(executionMode("workspace/anthropic/claude-sonnet-4-5").label, "Live · workspace connection");
  assert.equal(executionMode("personal/openai/gpt-4o-mini").label, "Live · personal connection");
  assert.equal(executionMode("qwen2.5:7b").label, "Live · server model");
  for (const id of ["demo-scripted", "workspace/x/y", "local"]) assert.doesNotMatch(executionMode(id).detail, /accura|correct|verified/i);
});

test("the setup page is five numbered sections with a rail, and the header shows the lifecycle strip", () => {
  const snapshot = fixture(["admin", "author"], catalogue({ ready: true, approvals: 2, installed: true }));
  const html = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "setup", passedTests()).body;
  for (const id of ["studio-purpose", "studio-sources", "studio-tools", "studio-tests", "studio-review"]) assert.match(html, new RegExp(`<fieldset class="studio-section" id="${id}">`));
  assert.match(html, /<ol class="studio-rail" aria-label="Setup sections">/);
  assert.match(html, /<legend>Knowledge<\/legend>/); assert.match(html, /<legend>Permitted tools<\/legend>/);
  assert.match(html, /<ol class="agent-lifecycle" aria-label="Agent lifecycle">/);
  assert.match(html, /<li class="reached" aria-current="step"><span class="lifecycle-mark" aria-hidden="true">✓<\/span><span class="lifecycle-label"><a href="#\/agent-packages">Installed version<\/a>/);
  assert.equal(html.match(/aria-current="step"/g)?.length, 1, "exactly one lifecycle step is current");
  assert.match(html, /Suite passed/); assert.match(html, /name="model" required><option value="workspace\/anthropic\/claude-sonnet-4-5" selected>/);
  // Inputs keep their names so the existing save handler reads them unchanged.
  for (const name of ["name", "purpose", "instructions", "kind", "requiredSourcePaths", "tools", "model", "maxSteps", "timeoutSeconds", "maxToolCalls", "requireSourceRead"]) assert.match(html, new RegExp(`name="${name}"`), name);
  // A saved model that is not connected is called out without changing the selection.
  const offline = agentStudioPage(snapshot, agent.id, null, [], emptyStudioUi(), "setup", passedTests()).body;
  assert.match(offline, /<strong>Not connected\.<\/strong>Connection not verified\./); assert.match(offline, /selected>workspace\/anthropic\/claude-sonnet-4-5 · not connected/);
  const draftOnly = lifecycleStrip(agent, undefined, undefined);
  assert.match(draftOnly, /<li class="reached" aria-current="step">.*Draft/); assert.match(draftOnly, /<li class="pending"><span class="lifecycle-mark" aria-hidden="true">○<\/span><span class="lifecycle-label"><a href="#\/agent-studio\/[^"]+\/test">Tested candidate<\/a>/);
});

test("the test result names the execution mode, the sources read with hashes, and what a person still judges", () => {
  const snapshot = fixture();
  const tests = passedTests();
  const html = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests).body;
  assert.match(html, /<dt>Execution<\/dt><dd><span class="status status-info">.*Live · workspace connection<\/span> <small class="text-3">Billed to the workspace&#39;s provider account\. Model <code>workspace\/anthropic\/claude-sonnet-4-5<\/code>\.<\/small>/);
  assert.match(html, /<dt>Sources read<\/dt><dd><ul class="plain sources-read"><li><code>SOP\.md<\/code><small class="text-3">sha256 aaaaaaaaaaaa… · 50 characters/);
  assert.match(html, /<dt>Human judgement<\/dt>/); assert.match(html, /Recorded: pass\./); assert.match(html, /Literal assertions and a successful read show what happened, not that the content is correct\./);
  const failed = { ...tests, runs: [{ ...tests.runs[0]!, status: "failed" as const, summary: "", error: "Required source read missing.", review: undefined, evidence: [] }] };
  const failedHtml = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", failed).body;
  assert.doesNotMatch(failedHtml, /<dt>Human judgement<\/dt>/, "nothing to judge when execution failed"); assert.match(failedHtml, /No source content captured/);
});

test("the assignment page and package cards show the installed version and a pending upgrade without changing bindings", () => {
  const snapshot = fixture(["admin", "author"], catalogue({ ready: true, approvals: 2, olderInstalled: true }));
  const assignment = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "workflow", passedTests()).body;
  assert.match(assignment, /<h2>Release and installation<\/h2>/); assert.match(assignment, /Approved release/); assert.match(assignment, /Not installed/);
  assert.match(assignment, /Upgrade to v2 available/); assert.match(assignment, /Installed stages keep their binding until an explicit upgrade\./);
  const packages = agentPackagesPage(snapshot).body;
  assert.match(packages, /Upgrade available · v1 installed/); assert.match(packages, /Installed in this workspace/);
  const superseded = agentPackagesPage(fixture(["admin", "author"], catalogue({ installed: true }))).body;
  assert.match(superseded, /Superseded · v2 installed/);
  assert.match(packages, /An admin installs it; nothing changes in workflows until it is assigned\./);
  assert.match(packages, /Install explicit upgrade/); assert.match(packages, /Existing stages and runs retain their previous binding\./);
  assert.match(packages, /Open in Agent Studio/);
  const installed = agentPackagesPage(fixture(["admin", "author"], catalogue({ ready: true, approvals: 2, installed: true }))).body;
  assert.match(installed, /Installed in this workspace/); assert.match(installed, /Assign the installed version to a stage below/);
  const waiting = agentPackagesPage(fixture(["approver"], catalogue({ approvals: 1 }))).body;
  assert.match(waiting, /1 more independent approval needed\. The publisher cannot sign\./); assert.match(waiting, /1\/2 approvals/);
  assert.doesNotMatch(waiting, /Ready to install/);
});

test("connections open with the two scopes at a glance and never equate a sign-in with API access", () => {
  const access = { tier: "free" as const, plan: "free", managedReady: false, accountedTokens: 0, dailyTokens: 0, connections: [{ provider: "openai", models: ["gpt-4o-mini"] }],
    workspaceConnections: [{ provider: "anthropic", models: ["claude-sonnet-4-5"], state: "verified" as const }, { provider: "google", models: ["gemini"], state: "failed" as const }], mcp: { active: false } };
  const page = chatConnectionsPage(access as never, undefined, undefined, { models: [{ id: "qwen", label: "qwen", provider: "Ollama", available: true, local: true, detail: "" }], loading: false }, undefined, { admin: true }).body;
  assert.match(page, /<section class="panel account-panel connection-glance" aria-label="Connections at a glance">/);
  assert.match(page, /Workspace · used by agents<\/span><strong>2 of 3 providers connected<\/strong><small>1 verified · <span class="status status-bad">.*1 failed<\/span> · 1 server model available<\/small>/);
  assert.match(page, /Personal · your chat only<\/span><strong>1 of 3 providers connected<\/strong>/);
  assert.match(page, /does not supply API access; an API key does/);
  assert.doesNotMatch(page, /sk-|apiKey=/);
  const member = chatConnectionsPage(access as never, undefined, undefined, { models: [], loading: true }, undefined, { admin: false }).body;
  assert.match(member, /An administrator manages these\./); assert.match(member, /server models being checked/);
});
