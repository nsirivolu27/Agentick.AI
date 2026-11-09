import { z } from "zod";
import type { AgentTestRun } from "./agent-tests-model.js";

export const testAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contains"), value: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("excludes"), value: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("source_read"), value: z.string().min(1).max(250) }).strict(),
  z.object({ kind: z.literal("max_calls"), value: z.number().int().min(1).max(12) }).strict(),
  z.object({ kind: z.literal("max_tokens"), value: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ kind: z.literal("max_duration_ms"), value: z.number().int().min(1).max(900_000) }).strict(),
]);
export const assertionResultSchema = z.object({
  label: z.string().max(600), passed: z.boolean(), detail: z.string().max(700),
}).strict();
export type AssertionResult = z.infer<typeof assertionResultSchema>;

/** Mechanical assertions are not a factuality judge. Unreported usage fails
 * a usage assertion rather than manufacturing a zero-cost result. */
export function evaluateTestAssertions(run: AgentTestRun): AssertionResult[] {
  return (run.assertions ?? []).map(assertion => {
    let passed = false; let detail = "";
    switch (assertion.kind) {
      case "contains": passed = run.summary.includes(assertion.value); detail = "Literal text presence; not semantic support."; break;
      case "excludes": passed = !run.summary.includes(assertion.value); detail = "Literal text absence; not a factuality verdict."; break;
      case "source_read": passed = run.toolCalls.some(call => call.name === "read_project_file" && call.path === assertion.value && call.outcome === "read"); detail = "A nonempty read of the named source is required."; break;
      case "max_calls": passed = run.calls <= assertion.value; detail = `${run.calls} recorded model calls.`; break;
      case "max_tokens": {
        const tokens = run.tokenUsage ? run.tokenUsage.promptTokens + run.tokenUsage.completionTokens : undefined;
        passed = tokens !== undefined && tokens <= assertion.value;
        detail = tokens === undefined ? "Provider usage not reported." : `${tokens} reported tokens.`; break;
      }
      case "max_duration_ms": {
        const elapsed = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : NaN;
        passed = Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= assertion.value;
        detail = Number.isFinite(elapsed) ? `${elapsed} milliseconds.` : "Duration unavailable."; break;
      }
    }
    return { label: `${assertion.kind}: ${assertion.value}`, passed: run.status === "succeeded" && passed, detail };
  });
}
