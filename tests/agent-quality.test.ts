import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { qualityMetrics } from "../workbench/agent-quality.js";
import { testRunSchema, testCaseHash } from "../workbench/agent-tests-model.js";

function run() {
  return testRunSchema.parse({ id: randomUUID(), workspaceId: "team", caseId: randomUUID(), agentId: randomUUID(),
    agentHash: "123456789012", agentName: "Reader", model: "scripted", prompt: "Read policy", expected: "", source: "SOP.md",
    startedBy: "author", startedAt: new Date().toISOString(), status: "succeeded", summary: "Approval required [SOP.md]",
    error: "", toolCalls: [{ name: "read_project_file", path: "SOP.md", outcome: "read" }], sourceRead: true,
    calls: 2, tokenUsage: null, events: [], evidence: [{ path: "SOP.md", content: "Approval is required.",
      sha256: "a".repeat(64), readAt: new Date().toISOString() }],
    qualityPolicy: { minSupportedRate: 1, minCitationRate: 1, expectedTools: ["read_project_file"] },
    review: { by: "reviewer", at: new Date().toISOString(), verdict: "pass", note: "", quality: { complete: true,
      claims: [{ claim: "Approval required [SOP.md]", verdict: "supported", source: "SOP.md", quote: "Approval is required." }] } } });
}
test("source-bound rates distinguish human support, citation presence and tool selection", () => {
  const item = run();
  assert.equal(qualityMetrics(item).meetsPolicy, true);
  item.review!.quality!.claims[0]!.verdict = "unsupported";
  assert.equal(qualityMetrics(item).citationRate, 1);
  assert.equal(qualityMetrics(item).supportedRate, 0);
  assert.equal(qualityMetrics(item).meetsPolicy, false);
});
test("missing, forged and incomplete citations cannot satisfy quality thresholds", () => {
  const item = run();
  item.review!.quality!.claims[0]!.quote = "Invented source text";
  assert.equal(qualityMetrics(item).citationRate, 0);
  assert.equal(qualityMetrics(item).meetsPolicy, false);
  item.summary += "\nAn unsupported second claim";
  assert.equal(qualityMetrics(item).covered, false);
  assert.equal(qualityMetrics(item).supportedRate, null);
});
test("unexpected tools and absent review remain distinct failures", () => {
  const item = run();
  item.toolCalls.push({ name: "list_project_files", outcome: "called" });
  assert.equal(qualityMetrics(item).correctTools, false);
  assert.equal(qualityMetrics(item).meetsPolicy, false);
  delete item.review;
  assert.equal(qualityMetrics(item).citationRate, null);
});
test("changed quality thresholds invalidate the saved case version", () => {
  const item = run();
  const before = testCaseHash({ prompt: item.prompt, expected: "", source: "", qualityPolicy: item.qualityPolicy });
  const after = testCaseHash({ prompt: item.prompt, expected: "", source: "", qualityPolicy: { ...item.qualityPolicy!, minSupportedRate: 0.5 } });
  assert.notEqual(before, after);
});
