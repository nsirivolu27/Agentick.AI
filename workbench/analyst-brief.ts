import type { AnalystJob } from "./analyst-runtime.js";

export const ANALYST_EXAMPLES = [
  { label: "County briefing", county: "Montgomery", scope: "snapshot",
    question: "Which declaration covers Montgomery County in the saved sample, and what are the limits?" },
  { label: "Missing county", county: "Fairfax", scope: "snapshot",
    question: "Does the saved sample establish that Fairfax County was unaffected?" },
  { label: "Fresh evidence", county: "Montgomery", scope: "bounded_live",
    question: "Which recent declaration records are returned for Montgomery County within the bounded live lookup?" },
] as const;

/** A download is evidence for a reviewer, never an approval receipt. */
export function analystBrief(job: AnalystJob): string | undefined {
  if (!job.report || !["completed", "blocked"].includes(job.status)) return undefined;
  return [
    "# Public data analyst — source analysis",
    "Emergency management / disaster recovery",
    "Evidence only. This file is not an approved handoff or an approval receipt.",
    "Rule-based controller; no model inference. Foundry mapping uses offline replay.",
    `Execution: ${job.id}`,
    `Work item: ${job.runId}`,
    `Status: ${job.status}`,
    ...(job.error ? [`Boundary: ${job.error}`] : []),
    "", job.report, "", "## Source evidence",
    ...job.sources.map(source => [
      `- ${source.title} (${source.mode})`, `  Query: ${source.url}`,
      `  Retrieved: ${source.retrievedAt}`, `  SHA-256: ${source.hash}`,
      `  County rows: ${source.rows}; distinct declarations: ${source.declarations}`,
    ].join("\n")),
    "", "## Execution trace",
    ...job.trace.map(entry => `- ${entry.tool}: ${entry.outcome} · ${entry.durationMs} ms\n  ${entry.summary}`),
    "", "Review the current work item for source changes and independent approvals.",
  ].join("\n");
}
