import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { agentConfigurableSchema } from "../workbench/agent-configurables.js";
import { agentHash, passedCurrentTest, testCaseHash, testCaseSchema, testRunSchema, testSuiteHash } from "../workbench/agent-tests-model.js";
import { evaluateTestAssertions } from "../workbench/agent-test-assertions.js";
import { compareTestRuns } from "../workbench/agent-test-comparison.js";

function fixture() {
  const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Evidence analyst", purpose: "Review source evidence.",
    instructions: "Read the source.", model: "fixture", bot: { kind: "planner", maxSteps: 3, timeoutSeconds: 30, allowedTools: ["read_project_file"] } });
  const testCase = testCaseSchema.parse({ id: randomUUID(), workspaceId: "one", agentId: agent.id, title: "Grounded answer",
    prompt: "Describe the procedure.", expected: "Read and cite SOP.md.", source: "SOP.md",
    assertions: [{ kind: "contains", value: "approved" }, { kind: "excludes", value: "deployed" }, { kind: "source_read", value: "SOP.md" },
      { kind: "max_calls", value: 2 }, { kind: "max_tokens", value: 200 }, { kind: "max_duration_ms", value: 5000 }],
    createdBy: "operator", createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
  const run = testRunSchema.parse({ id: randomUUID(), workspaceId: "one", agentId: agent.id, caseId: testCase.id,
    agentHash: agentHash(agent), caseHash: testCaseHash(testCase), suiteHash: testSuiteHash([testCase], agent.id),
    agentName: agent.name, model: agent.model, prompt: testCase.prompt, expected: testCase.expected, source: testCase.source,
    assertions: testCase.assertions, startedBy: "operator", startedAt: "2026-11-04T00:00:00Z", finishedAt: "2026-11-04T00:00:01Z",
    status: "succeeded", summary: "SOP.md describes the approved procedure.", error: "", sourceRead: true, calls: 2,
    toolCalls: [{ name: "read_project_file", path: "SOP.md", outcome: "read" }], tokenUsage: { promptTokens: 120, completionTokens: 40 },
    evidence: [], projectRoot: "/fixture", evidenceCurrent: true,
    events: [], review: { verdict: "pass", note: "Reviewed.", by: "reviewer", at: "2026-11-04T00:00:02Z" } });
  run.assertionResults = evaluateTestAssertions(run);
  return { agent, testCase, run };
}

test("mechanical assertions report each result and fail closed on unavailable evidence", () => {
  const { run } = fixture();
  assert.equal(run.assertionResults!.length, 6);
  assert.ok(run.assertionResults!.every(item => item.passed));
  run.tokenUsage = null; run.toolCalls[0]!.path = "unrelated.md"; run.summary += " The system deployed.";
  const results = evaluateTestAssertions(run);
  assert.equal(results.find(item => item.label.startsWith("max_tokens"))!.passed, false);
  assert.equal(results.find(item => item.label.startsWith("source_read"))!.passed, false);
  assert.equal(results.find(item => item.label.startsWith("excludes"))!.passed, false);
  run.status = "failed";
  assert.ok(evaluateTestAssertions(run).every(item => !item.passed));
});

test("assignment requires current suite, passing assertions and quality review; newer failures cannot hide behind an old pass", () => {
  const { agent, testCase, run } = fixture();
  const state = { cases: [testCase], runs: [run], busy: false };
  assert.equal(passedCurrentTest(agent, state), true);
  const missingReview = structuredClone(state); delete missingReview.runs[0]!.review;
  assert.equal(passedCurrentTest(agent, missingReview), false);
  const failedReview = structuredClone(state); failedReview.runs[0]!.review!.verdict = "fail";
  assert.equal(passedCurrentTest(agent, failedReview), false);
  const failedAssertion = structuredClone(state); failedAssertion.runs[0]!.assertionResults![0]!.passed = false;
  assert.equal(passedCurrentTest(agent, failedAssertion), false);
  const edited = structuredClone(state); edited.cases[0]!.expected = "A changed expectation";
  assert.equal(passedCurrentTest(agent, edited), false);
  const expanded = structuredClone(state); expanded.cases.push({ ...testCase, id: randomUUID() });
  assert.equal(passedCurrentTest(agent, expanded), false);
  const latestFailure = { ...state, runs: [run, { ...run, id: randomUUID(), status: "failed" as const }] };
  assert.equal(passedCurrentTest(agent, latestFailure), false);
  const legacy = structuredClone(state); delete legacy.runs[0]!.caseHash;
  assert.equal(passedCurrentTest(agent, legacy), false);
  const changedSource = structuredClone(state); changedSource.runs[0]!.evidenceCurrent = false;
  assert.equal(passedCurrentTest(agent, changedSource), false);
  assert.equal(passedCurrentTest(agent, { ...state, cases: [] }), false);
});

test("baseline comparison requires identical saved cases, suite and frozen source evidence", () => {
  const { run } = fixture();
  const candidate = { ...structuredClone(run), id: randomUUID(), agentHash: "b".repeat(12) };
  const comparison = compareTestRuns(run, candidate);
  assert.equal(comparison.comparable, true);
  if (comparison.comparable) assert.equal(comparison.candidate.tokens, 160);
  for (const changed of [
    { ...candidate, workspaceId: "another" }, { ...candidate, caseHash: "c".repeat(12) },
    { ...candidate, suiteHash: "d".repeat(12) }, { ...candidate, projectRoot: "/another" },
    { ...candidate, evidence: [{ path: "SOP.md", content: "changed", sha256: "e".repeat(64), readAt: "now" }] },
  ]) assert.equal(compareTestRuns(run, changed).comparable, false);
  const missing = structuredClone(candidate); delete missing.evidence;
  assert.equal(compareTestRuns(run, missing).comparable, false);
});
