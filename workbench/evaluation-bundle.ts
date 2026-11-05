import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "./audit-package.js";
import { testRunSchema, type AgentTestRun } from "./agent-tests-model.js";
import { evaluateTestAssertions } from "./agent-test-assertions.js";
import { qualityMetrics } from "./agent-quality.js";
import { findSecretKinds } from "./studio/dataset.js";
import { PipelineError } from "./pipeline.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const frozenRunSchema = testRunSchema.pick({
  id: true, workspaceId: true, agentId: true, agentHash: true, caseId: true,
  caseHash: true, suiteHash: true, model: true, prompt: true, source: true,
  summary: true, status: true, evidence: true, assertions: true, qualityPolicy: true,
  toolCalls: true, calls: true, tokenUsage: true, startedAt: true, finishedAt: true, review: true,
}).extend({
  status: z.literal("succeeded"),
  caseHash: z.string().length(12), suiteHash: z.string().length(12),
  evidence: testRunSchema.shape.evidence.unwrap(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
}).strict();

export const evaluationBundleSchema = z.object({
  kind: z.literal("agentick-evaluation"), version: z.literal(1),
  run: frozenRunSchema, answerSha256: hashSchema, manifestSha256: hashSchema,
}).strict();
export type EvaluationBundle = z.infer<typeof evaluationBundleSchema>;

function manifestHash(bundle: Omit<EvaluationBundle, "manifestSha256">): string {
  return sha256(canonical(bundle));
}

function containsCredential(value: unknown): boolean {
  if (typeof value === "string") return findSecretKinds(value).length > 0;
  if (Array.isArray(value)) return value.some(containsCredential);
  return !!value && typeof value === "object" && Object.values(value).some(containsCredential);
}

/** Hashes bind recorded evidence, not the truth of an answer or a person's identity. */
export function verifyEvaluationBundle(raw: unknown, workspace: string, expectedHash?: string): EvaluationBundle {
  const bundle = evaluationBundleSchema.parse(raw);
  if (bundle.run.workspaceId !== workspace) throw new PipelineError(404, "This evaluation is not in this workspace.");
  const { manifestSha256, ...body } = bundle;
  if (manifestHash(body) !== manifestSha256 || (expectedHash !== undefined && expectedHash !== manifestSha256)) {
    throw new PipelineError(409, "Evaluation manifest digest does not match.");
  }
  if (sha256(bundle.run.summary) !== bundle.answerSha256) throw new PipelineError(409, "Evaluation answer digest does not match.");
  const paths = new Set<string>();
  for (const source of bundle.run.evidence) {
    if (paths.has(source.path) || sha256(source.content) !== source.sha256) {
      throw new PipelineError(409, "Evaluation source evidence is ambiguous or has a mismatched digest.");
    }
    paths.add(source.path);
  }
  if (Date.parse(bundle.run.finishedAt) < Date.parse(bundle.run.startedAt)) {
    throw new PipelineError(409, "Evaluation finish time precedes its start.");
  }
  // Refuse the export instead of redacting it: redaction would change the tested evidence.
  if (containsCredential(body)) throw new PipelineError(409, "Evaluation contains a possible credential. Remove it and run a new test.");
  return bundle;
}

export function buildEvaluationBundle(workspace: string, run: AgentTestRun): EvaluationBundle {
  if (run.workspaceId !== workspace) throw new PipelineError(404, "This evaluation is not in this workspace.");
  if (run.status !== "succeeded") throw new PipelineError(409, "Only completed successful executions can be evaluated offline.");
  if (!run.caseHash || !run.suiteHash || !run.evidence || !run.finishedAt) {
    throw new PipelineError(409, "This test lacks frozen evidence or version bindings. Run it again.");
  }
  // An explicit projection keeps local paths, event logs and expected answers out of the artifact.
  const frozen = frozenRunSchema.parse({
    id: run.id, workspaceId: run.workspaceId, agentId: run.agentId, agentHash: run.agentHash,
    caseId: run.caseId, caseHash: run.caseHash, suiteHash: run.suiteHash, model: run.model,
    prompt: run.prompt, source: run.source, summary: run.summary, status: run.status,
    evidence: run.evidence, assertions: run.assertions, qualityPolicy: run.qualityPolicy,
    toolCalls: run.toolCalls, calls: run.calls, tokenUsage: run.tokenUsage,
    startedAt: run.startedAt, finishedAt: run.finishedAt, review: run.review,
  });
  const body = { kind: "agentick-evaluation" as const, version: 1 as const, run: frozen, answerSha256: sha256(run.summary) };
  return verifyEvaluationBundle({ ...body, manifestSha256: manifestHash(body) }, workspace);
}

export function evaluateBundle(raw: unknown, workspace: string, expectedHash?: string) {
  const bundle = verifyEvaluationBundle(raw, workspace, expectedHash);
  const run = testRunSchema.parse({ ...bundle.run, agentName: "", expected: "", startedBy: "offline-evaluation",
    error: "", sourceRead: false, events: [] });
  const assertions = evaluateTestAssertions(run);
  return {
    kind: "agentick-evaluation-report" as const, version: 1 as const,
    workspaceId: workspace, runId: run.id, agentId: run.agentId, caseId: run.caseId,
    agentHash: run.agentHash, caseHash: run.caseHash, suiteHash: run.suiteHash,
    manifestSha256: bundle.manifestSha256, answerSha256: bundle.answerSha256, model: run.model,
    execution: "recorded" as const,
    sources: bundle.run.evidence.map(source => ({ path: source.path, sha256: source.sha256 })),
    assertions, assertionsPassed: assertions.filter(item => item.passed).length,
    quality: qualityMetrics(run), tokenUsage: run.tokenUsage,
    durationMs: Date.parse(bundle.run.finishedAt) - Date.parse(bundle.run.startedAt),
    requiresHumanReview: true as const,
    note: "Mechanical checks and recorded reviewer judgments only. No live model call, source freshness check or release approval.",
  };
}

/** A report is accepted only if it reproduces the checks for the trusted original bundle. */
export function verifyEvaluationReport(raw: unknown, bundle: EvaluationBundle, workspace: string) {
  const expected = evaluateBundle(bundle, workspace);
  if (canonical(raw) !== canonical(expected)) throw new PipelineError(409, "Evaluation report does not match the frozen run.");
  return expected;
}
