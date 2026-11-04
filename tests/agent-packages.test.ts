import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPackages } from "../workbench/agent-packages.js";
import { agentConfigurableSchema, saveConfigurable } from "../workbench/agent-configurables.js";
import { agentHash, testCaseHash, testCaseSchema, testRunSchema, testSuiteHash } from "../workbench/agent-tests-model.js";
import { memoryPipelines } from "../workbench/pipeline.js";

function fixture(directory?: string) {
  const pipelines = memoryPipelines();
  const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Evidence guide", purpose: "Read the SOP",
    model: "scripted", instructions: "Read SOP.md and cite it.", bot: { kind: "planner", maxSteps: 4, timeoutSeconds: 30, allowedTools: ["read_project_file"], requireSourceRead: true } });
  pipelines.execute("team", "owner", ["admin"], { action: "configure", expectedVersion: 1,
    config: saveConfigurable(pipelines.snapshot("team").config, agent) }, 2);
  const at = new Date().toISOString();
  const saved = testCaseSchema.parse({ id: randomUUID(), workspaceId: "team", agentId: agent.id,
    title: "Source", prompt: "Read", expected: "Cite", source: "SOP.md", createdBy: "owner", createdAt: at, updatedAt: at });
  const run = testRunSchema.parse({ id: randomUUID(), workspaceId: "team", caseId: saved.id, agentId: agent.id,
    agentHash: agentHash(agent), agentName: agent.name, model: agent.model, caseHash: testCaseHash(saved), suiteHash: testSuiteHash([saved], agent.id),
    prompt: "Read", expected: "Cite", source: "SOP.md", status: "succeeded", summary: "Approval required [SOP.md]", error: "",
    startedBy: "owner", startedAt: at, finishedAt: at, toolCalls: [], sourceRead: true, calls: 2, tokenUsage: null, events: [],
    evidenceCurrent: true, assertions: [], assertionResults: [], review: { verdict: "pass", note: "Checked", by: "reviewer", at } });
  const tests = { cases: [saved], runs: [run], busy: false };
  const options = { directory, pipelines, tests: (workspace: string) => workspace === "team" ? tests : { cases: [], runs: [], busy: false } };
  const packages = createAgentPackages(options);
  const command = (raw: unknown, actor = "owner", roles: ("admin" | "approver")[] = ["admin"], workspace = "team") =>
    packages.execute(workspace, actor, roles, raw, 2);
  const publish = () => command({ action: "publish", agentId: agent.id, expectedVersion: pipelines.snapshot("team").version }).packages.at(-1)!;
  const approve = (item: ReturnType<typeof publish>) => {
    command({ action: "approve", packageId: item.id, expectedHash: item.contentHash }, "first", ["approver"]);
    return command({ action: "approve", packageId: item.id, expectedHash: item.contentHash }, "second", ["approver"]);
  };
  return { packages, command, publish, approve, pipelines, tests, agent, options };
}

test("packages require independent signatures and current evidence at install, with strict tenancy", () => {
  const d = fixture(), pkg = d.publish();
  const install = { action: "install", packageId: pkg.id, expectedHash: pkg.contentHash };
  assert.throws(() => d.command(install), /not ready/);
  assert.throws(() => d.command({ ...install, action: "approve" }), /own package/);
  d.command({ ...install, action: "approve" }, "first", ["approver"]);
  assert.throws(() => d.command(install), /not ready/);
  assert.throws(() => d.command({ ...install, action: "approve" }, "first", ["approver"]), /already/);
  d.command({ ...install, action: "approve" }, "second", ["approver"]);
  assert.throws(() => d.command(install, "owner", ["admin"], "other"), /not found/);
  d.tests.runs[0]!.evidenceCurrent = false;
  assert.throws(() => d.command(install), /not ready/);
  d.tests.runs[0]!.evidenceCurrent = true;
  const result = d.command(install);
  assert.equal(result.installations.length, 1);
  assert.equal(d.command(install).installations.length, 1);
  assert.equal(d.pipelines.snapshot("team").config.stages[0]!.agent.includes("Evidence guide"), false);
});

test("explicit upgrades preserve old stages and run bindings; retirement prevents new assignments", () => {
  const d = fixture(), first = d.publish(); d.approve(first);
  const install = d.command({ action: "install", packageId: first.id, expectedHash: first.contentHash }).installations[0]!;
  const stageId = d.pipelines.snapshot("team").config.stages[0]!.id;
  d.command({ action: "assign", installationId: install.id, stageId, expectedVersion: d.pipelines.snapshot("team").version });
  const oldStage = structuredClone(d.pipelines.snapshot("team").config.stages[0]);
  const run = d.pipelines.execute("team", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Old run", brief: "Keep its definition" }, 2).runs[0]!;
  d.agent.instructions += " Name missing evidence.";
  const current = d.pipelines.snapshot("team");
  d.pipelines.execute("team", "owner", ["admin"], { action: "configure", expectedVersion: current.version, config: saveConfigurable(current.config, d.agent) }, 2);
  d.tests.runs[0] = { ...d.tests.runs[0]!, id: randomUUID(), agentHash: agentHash(d.agent) };
  const second = d.publish(); d.approve(second);
  d.command({ action: "install", packageId: second.id, expectedHash: second.contentHash, upgradedFrom: install.id });
  assert.deepEqual(d.pipelines.snapshot("team").config.stages[0], oldStage);
  assert.deepEqual(d.pipelines.snapshot("team").runs[0]!.config, run.config);
  d.command({ action: "retire", packageId: second.id, expectedHash: second.contentHash });
  const newInstall = d.packages.snapshot("team").installations.at(-1)!;
  assert.throws(() => d.command({ action: "assign", installationId: newInstall.id, stageId, expectedVersion: d.pipelines.snapshot("team").version }), /retired/);
  assert.deepEqual(d.pipelines.snapshot("team").runs[0]!.config, run.config);
});

test("packages survive restart and reject imported signatures or unknown fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-packages-"));
  try {
    const d = fixture(directory), pkg = d.publish(); d.approve(pkg);
    d.command({ action: "install", packageId: pkg.id, expectedHash: pkg.contentHash });
    const reopened = createAgentPackages(d.options);
    assert.equal(reopened.snapshot("team").installations.length, 1);
    assert.equal(reopened.snapshot("team").packages[0]!.ready, true);
    const template = { kind: "agentick-agent-template", version: 1, agent: d.agent };
    assert.throws(() => d.command({ action: "import", expectedVersion: d.pipelines.snapshot("team").version,
      template: { ...template, approvals: ["forged"] } }), /Unrecognized/);
    d.command({ action: "import", expectedVersion: d.pipelines.snapshot("team").version, template });
    assert.equal(d.pipelines.snapshot("team").config.configurables!.length, 2);
    assert.equal(d.packages.snapshot("team").packages.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("stronger workspace policy and changed test results invalidate package readiness", () => {
  const d = fixture(), pkg = d.publish(); d.approve(pkg);
  const install = { action: "install", packageId: pkg.id, expectedHash: pkg.contentHash };
  assert.equal(d.packages.snapshot("team", 3).packages[0]!.ready, false);
  assert.throws(() => d.packages.execute("team", "owner", ["admin"], install, 3), /not ready/);
  d.packages.execute("team", "third", ["approver"], { ...install, action: "approve" }, 3);
  assert.equal(d.packages.snapshot("team", 3).packages[0]!.ready, true);
  // Persisted parsers can reorder object fields without changing their meaning.
  d.tests.runs[0] = testRunSchema.parse(d.tests.runs[0]);
  assert.equal(d.packages.snapshot("team", 3).packages[0]!.ready, true);
  d.tests.runs[0]!.summary = "Changed after review";
  assert.throws(() => d.command(install), /not ready/);
});
