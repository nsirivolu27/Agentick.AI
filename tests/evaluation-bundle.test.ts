import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical } from "../workbench/audit-package.js";
import { testRunSchema } from "../workbench/agent-tests-model.js";
import { buildEvaluationBundle, evaluateBundle, verifyEvaluationBundle, verifyEvaluationReport, type EvaluationBundle } from "../workbench/evaluation-bundle.js";
import { runEvaluationProcessing } from "../workbench/evaluation-processing.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function run() {
  return testRunSchema.parse({
    id: randomUUID(), workspaceId: "company-one", agentId: randomUUID(), caseId: randomUUID(),
    agentHash: "a".repeat(12), caseHash: "b".repeat(12), suiteHash: "c".repeat(12),
    agentName: "Documentation", model: "fixture-model", prompt: "Explain repository access.", source: "SOP.md",
    summary: "Ask the team owner. [SOP.md]", status: "succeeded",
    evidence: [{ path: "SOP.md", content: "Ask the team owner.", sha256: hash("Ask the team owner."), readAt: "2026-11-04T12:00:00.000Z" }],
    assertions: [{ kind: "contains", value: "SOP.md" }, { kind: "max_tokens", value: 100 }],
    assertionResults: [{ label: "Stored result is not trusted", passed: false, detail: "Old result" }],
    qualityPolicy: { minSupportedRate: 1, minCitationRate: 1, expectedTools: ["read_project_file"] },
    toolCalls: [{ name: "read_project_file", path: "SOP.md", outcome: "read" }],
    calls: 1, tokenUsage: { promptTokens: 20, completionTokens: 8 },
    startedAt: "2026-11-04T12:00:00.000Z", finishedAt: "2026-11-04T12:00:02.000Z",
    expected: "PRIVATE EVALUATOR ANSWER", projectRoot: "C:/private/repository",
    startedBy: "author", sourceRead: true, events: ["PRIVATE EVENT"], error: "",
  });
}
function rehash(bundle: EvaluationBundle) {
  const { manifestSha256: _old, ...body } = bundle;
  bundle.manifestSha256 = hash(canonical(body));
  return bundle;
}

test("frozen evaluation exports omit local metadata and recompute checks without inventing semantic support", () => {
  const record = run();
  const bundle = buildEvaluationBundle("company-one", record);
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE|C:\/private|Stored result/);
  const report = evaluateBundle(bundle, "company-one", bundle.manifestSha256);
  assert.equal(report.assertionsPassed, 2);
  assert.equal(report.durationMs, 2000);
  assert.deepEqual(report.tokenUsage, { promptTokens: 20, completionTokens: 8 });
  assert.equal(report.quality.supportedRate, null);
  assert.equal(report.quality.citationRate, null);
  assert.equal(report.quality.meetsPolicy, false);
  assert.equal(report.requiresHumanReview, true);
  assert.equal(report.execution, "recorded");
  assert.doesNotMatch(JSON.stringify(report), /Ask the team owner/);
  assert.deepEqual(verifyEvaluationReport(report, bundle, "company-one"), report);
  assert.throws(() => verifyEvaluationReport({ ...report, requiresHumanReview: false }, bundle, "company-one"), /does not match/);
  record.summary = "Changed after export";
  assert.equal(bundle.run.summary, "Ask the team owner. [SOP.md]");
});

test("bundle validation rejects altered sources, answers, identity, unknown fields and missing frozen data", () => {
  const original = buildEvaluationBundle("company-one", run());
  const source = structuredClone(original);
  source.run.evidence[0]!.content = "Altered";
  assert.throws(() => verifyEvaluationBundle(source, "company-one"), /manifest digest/);
  assert.throws(() => verifyEvaluationBundle(rehash(source), "company-one"), /source evidence/);
  const answer = structuredClone(original); answer.run.summary = "Altered";
  assert.throws(() => verifyEvaluationBundle(rehash(answer), "company-one"), /answer digest/);
  const duplicate = structuredClone(original); duplicate.run.evidence.push(duplicate.run.evidence[0]!);
  assert.throws(() => verifyEvaluationBundle(rehash(duplicate), "company-one"), /ambiguous/);
  assert.throws(() => verifyEvaluationBundle(original, "company-two"), /workspace/);
  assert.throws(() => verifyEvaluationBundle(original, "company-one", "f".repeat(64)), /manifest digest/);
  assert.throws(() => verifyEvaluationBundle({ ...original, credentials: {} }, "company-one"));
  const unfinished = run(); unfinished.status = "running";
  assert.throws(() => buildEvaluationBundle("company-one", unfinished), /completed/);
  const old = run(); delete old.caseHash;
  assert.throws(() => buildEvaluationBundle("company-one", old), /version bindings/);
  const earlier = run(); earlier.finishedAt = "2026-11-03T12:00:00.000Z";
  assert.throws(() => buildEvaluationBundle("company-one", earlier), /precedes/);
});

test("possible credentials block export without echoing the source; missing usage stays unknown", () => {
  const record = run();
  const secret = "ghp_" + "x".repeat(36);
  record.evidence![0]!.content = secret; record.evidence![0]!.sha256 = hash(secret);
  assert.throws(() => buildEvaluationBundle("company-one", record),
    error => error instanceof Error && /credential/.test(error.message) && !error.message.includes(secret));
  record.evidence![0]!.content = 'api_key = "abcdefghijklmnopqrstuv"';
  record.evidence![0]!.sha256 = hash(record.evidence![0]!.content);
  assert.throws(() => buildEvaluationBundle("company-one", record), /credential/);
  const unknown = run(); unknown.tokenUsage = null;
  const report = evaluateBundle(buildEvaluationBundle("company-one", unknown), "company-one");
  assert.equal(report.tokenUsage, null);
  assert.equal(report.assertions[1]!.passed, false);
});

test("reviewed support is bound to the recorded claims and sources but never grants approval", () => {
  const record = run();
  record.review = { by: "independent-reviewer", at: "2026-11-04T13:00:00.000Z", verdict: "pass", note: "",
    quality: { complete: true, claims: [{ claim: record.summary, verdict: "supported", source: "SOP.md", quote: "Ask the team owner." }] } };
  const report = evaluateBundle(buildEvaluationBundle("company-one", record), "company-one");
  assert.equal(report.quality.supportedRate, 1);
  assert.equal(report.quality.citationRate, 1);
  assert.equal(report.quality.meetsPolicy, true);
  assert.equal(report.requiresHumanReview, true);
  record.review.quality!.claims[0]!.quote = "Not in the source";
  assert.equal(evaluateBundle(buildEvaluationBundle("company-one", record), "company-one").quality.supportedRate, 0);
});

test("processing runner writes a bound report and refuses wrong identities, oversized files and overwrites", async t => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input"), output = join(directory, "output");
  await mkdir(input);
  const bundle = buildEvaluationBundle("company-one", run());
  const identity = { workspaceId: "company-one", runId: bundle.run.id, manifestSha256: bundle.manifestSha256 };
  await writeFile(join(input, "evaluation.json"), JSON.stringify(bundle));
  await assert.rejects(runEvaluationProcessing(input, output, { ...identity, runId: randomUUID() }), /run does not match/);
  await assert.rejects(readFile(join(output, "report.json")), /ENOENT/);
  await assert.rejects(runEvaluationProcessing(input, output, { ...identity, workspaceId: "company-two" }), /workspace/);
  await assert.rejects(runEvaluationProcessing(input, output, { ...identity, manifestSha256: "f".repeat(64) }), /manifest/);
  const report = await runEvaluationProcessing(input, output, identity);
  assert.deepEqual(JSON.parse(await readFile(join(output, "report.json"), "utf8")), report);
  await assert.rejects(runEvaluationProcessing(input, output, identity), /EEXIST/);
  await writeFile(join(input, "evaluation.json"), " ".repeat(2_000_001));
  await assert.rejects(runEvaluationProcessing(input, join(directory, "oversized"), identity), /size limit/);
});
