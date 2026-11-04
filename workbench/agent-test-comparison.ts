import type { AgentTestRun } from "./agent-tests-model.js";

const sourceSet = (run: AgentTestRun) => JSON.stringify(run.evidence?.map(item => [item.path, item.sha256]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
export function compareTestRuns(baseline: AgentTestRun, candidate: AgentTestRun) {
  if (baseline.id === candidate.id || baseline.workspaceId !== candidate.workspaceId || baseline.agentId !== candidate.agentId ||
    baseline.caseId !== candidate.caseId || !baseline.caseHash || baseline.caseHash !== candidate.caseHash ||
    !baseline.suiteHash || baseline.suiteHash !== candidate.suiteHash) {
    return { comparable: false as const, reason: "Choose different runs of the same saved case and suite version." };
  }
  if (baseline.status === "running" || candidate.status === "running") return { comparable: false as const, reason: "Wait for both runs to finish." };
  if (!baseline.evidence || !candidate.evidence || baseline.projectRoot !== candidate.projectRoot || sourceSet(baseline) !== sourceSet(candidate)) {
    return { comparable: false as const, reason: "Frozen source evidence differs or was not recorded. Run both versions against the same sources." };
  }
  const metrics = (run: AgentTestRun) => ({
    execution: run.status, review: run.review?.verdict ?? "pending",
    passed: (run.assertionResults ?? []).filter(item => item.passed).length,
    total: (run.assertions ?? []).length, calls: run.calls,
    tokens: run.tokenUsage ? run.tokenUsage.promptTokens + run.tokenUsage.completionTokens : null,
    elapsedMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
  });
  return { comparable: true as const, baseline: metrics(baseline), candidate: metrics(candidate) };
}
