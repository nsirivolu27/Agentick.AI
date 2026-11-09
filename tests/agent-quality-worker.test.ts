import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "../workbench/agent-demo-fixture.js";

test("real worker evidence gates independent quality review and assignment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-quality-worker-"));
  const base = scriptedDemoChat();
  const claim = "A routine request needs the team owner's approval. [SOP.md]";
  const d = await createAgentDemo(directory, { ...base, loadModel: async () => ({
    async invoke(prompt: string) {
      const reads = JSON.parse(prompt.split("OBSERVATIONS: ")[1]?.split("\n\n")[0] ?? "[]");
      return { content: JSON.stringify(reads.length ? { type: "result", changes: [], summary: claim } :
        { type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } }) };
    },
  }) });
  const actor = DEMO_MEMBERS[0]!.actor;
  try {
    const saved = d.agentTests.snapshot(DEMO_WORKSPACE).cases[0]!;
    await d.agentTests.execute(DEMO_WORKSPACE, actor, ["admin"], { action: "save_case", id: saved.id,
      agentId: saved.agentId, title: saved.title, prompt: saved.prompt, source: saved.source,
      qualityPolicy: { minSupportedRate: 1, minCitationRate: 1, expectedTools: ["read_project_file"] } });
    await d.agentTests.execute(DEMO_WORKSPACE, actor, ["admin"], { action: "run", caseId: saved.id,
      expectedVersion: d.pipelines.snapshot(DEMO_WORKSPACE).version });
    await d.agentTests.settled(DEMO_WORKSPACE);
    const run = d.agentTests.snapshot(DEMO_WORKSPACE).runs[0]!;
    assert.equal(run.status, "succeeded");
    const quality = { complete: true, claims: [{ claim, verdict: "supported", source: "SOP.md",
      quote: "A routine request needs the team owner's approval." }] };
    await assert.rejects(d.agentTests.execute(DEMO_WORKSPACE, actor, ["admin"],
      { action: "review", runId: run.id, verdict: "pass", quality }), /independent/);
    await assert.rejects(d.agentTests.execute(DEMO_WORKSPACE, "reviewer", ["approver"],
      { action: "review", runId: run.id, verdict: "pass", quality: { ...quality,
        claims: [{ ...quality.claims[0], quote: "Invented quote" }] } }), /thresholds/);
    const accepted = await d.agentTests.execute(DEMO_WORKSPACE, "reviewer", ["approver"],
      { action: "review", runId: run.id, verdict: "pass", quality });
    assert.equal(accepted.runs[0]!.review!.quality!.claims[0]!.verdict, "supported");
    assert.equal(accepted.runs[0]!.toolCalls[0]!.name, "read_project_file");
  } finally { await d.agentTests.close(); await d.bots.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("simultaneous test preparation reserves at most one worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-test-reservation-"));
  const chat = scriptedDemoChat();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const d = await createAgentDemo(directory, { ...chat, modelOptions: async () => { await gate; return chat.modelOptions!(); } });
  try {
    const input = { action: "run", caseId: d.agentTests.snapshot(DEMO_WORKSPACE).cases[0]!.id,
      expectedVersion: d.pipelines.snapshot(DEMO_WORKSPACE).version };
    const first = d.agentTests.execute(DEMO_WORKSPACE, "author", ["admin"], input);
    const second = d.agentTests.execute(DEMO_WORKSPACE, "author", ["admin"], input);
    release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    await d.agentTests.settled(DEMO_WORKSPACE);
    assert.equal(d.agentTests.snapshot(DEMO_WORKSPACE).runs.length, 1);
  } finally { release(); await d.agentTests.close(); await d.bots.close(); rmSync(directory, { recursive: true, force: true }); }
});
