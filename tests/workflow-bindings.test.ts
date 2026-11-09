import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_PIPELINE, memoryPipelines, pipelineSchema } from "../workbench/pipeline.js";
import { boundStageOutputs } from "../workbench/workflow-inputs.js";
import { stagePrompt } from "../workbench/scheduler.js";
import { runBotWorker } from "../workbench/bot-worker.js";
import { attemptSchema } from "../workbench/bot-schema.js";

function configuration() {
  return { ...structuredClone(DEFAULT_PIPELINE), stages: ["intake", "analysis", "handoff"].map((id, index) => ({
    ...structuredClone(DEFAULT_PIPELINE.stages[index]!), id, name: id, approval: false,
    inputStages: index ? ["intake"] : [],
    outputContract: "Cite only the selected source evidence.",
  })) };
}

test("input validation rejects cycles, forward references, dangling and duplicate bindings", () => {
  assert.equal(pipelineSchema.safeParse(configuration()).success, true);
  for (const references of [["missing"], ["handoff"], ["intake", "intake"]]) {
    const config = configuration(); config.stages[2]!.inputStages = references;
    assert.equal(pipelineSchema.safeParse(config).success, false);
  }
  const forward = configuration(); forward.stages[0]!.inputStages = ["analysis"];
  assert.equal(pipelineSchema.safeParse(forward).success, false);
  const dangling = configuration(); dangling.stages.splice(0, 1);
  assert.equal(pipelineSchema.safeParse(dangling).success, false);
});

test("worker and scheduler receive only selected completed outputs from the frozen run", async () => {
  const engine = memoryPipelines(); const config = configuration();
  const execute = (raw: unknown) => engine.execute("one", "operator", ["admin"], raw, 2);
  execute({ action: "configure", expectedVersion: 1, config });
  const request = { action: "start", requestId: randomUUID(), title: "Binding test", brief: "Use the selected input." };
  let run = execute(request).runs[0]!;
  run = execute({ action: "complete", runId: run.id, expectedRevision: run.revision, note: "SELECTED_SOURCE" }).runs[0]!;
  run = execute({ action: "complete", runId: run.id, expectedRevision: run.revision, note: "UNSELECTED_OUTPUT" }).runs[0]!;
  assert.deepEqual(boundStageOutputs(run).map(item => item.stageId), ["intake"]);
  assert.equal(boundStageOutputs(run)[0]!.outputHash, run.stages[0]!.outputHash);
  const prompt = stagePrompt({ id: randomUUID(), name: "Test", model: "fixture", instructions: "Summarize", release: "fixture" }, run);
  assert.match(prompt, /SELECTED_SOURCE/); assert.doesNotMatch(prompt, /UNSELECTED_OUTPUT/);
  assert.match(prompt, /Cite only the selected source evidence/);
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id, stageId: "handoff", revision: run.revision,
    actor: "operator", bot: { kind: "planner", maxSteps: 1, timeoutSeconds: 15, allowedTools: [], maxToolCalls: 0 },
    model: "fixture", checkout: "/unused", baseCommit: "fixture", startedAt: new Date().toISOString(), status: "running",
    summary: "", error: "", calls: 0, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" });
  await runBotWorker(attempt, run, { async invoke(workerPrompt) {
    assert.match(workerPrompt, /SELECTED_SOURCE/); assert.doesNotMatch(workerPrompt, /UNSELECTED_OUTPUT/);
    assert.match(workerPrompt, /Cite only the selected source evidence/);
    return { content: JSON.stringify({ type: "result", summary: "Bound source reviewed.", changes: [] }) };
  } }, new AbortController().signal, () => {});
  const next = configuration(); next.stages[2]!.inputStages = ["analysis"];
  execute({ action: "configure", expectedVersion: 2, config: next });
  const saved = engine.snapshot("one");
  assert.deepEqual(saved.config.stages[2]!.inputStages, ["analysis"]);
  assert.deepEqual(saved.runs[0]!.config.stages[2]!.inputStages, ["intake"]);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.config)), saved.config);
  assert.equal(execute(request).runs.length, 1);
  const none = structuredClone(run); none.config.stages[2]!.inputStages = [];
  assert.deepEqual(boundStageOutputs(none), []);
  delete none.config.stages[2]!.inputStages;
  assert.equal(boundStageOutputs(none).length, 2);
  none.stages[0]!.status = "awaiting_review";
  assert.deepEqual(boundStageOutputs(none).map(item => item.stageId), ["analysis"]);
});
