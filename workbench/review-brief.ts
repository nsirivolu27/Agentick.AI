import type { PipelineRun } from "./pipeline.js";
import type { ReviewSource } from "./review-evidence-schema.js";
import { detail, escape, more, panel, status } from "./ui.js";

export function reviewSources(run: PipelineRun, phase: number): { sources: ReviewSource[]; recorded: boolean; missing: boolean } {
  const stage = run.stages[phase];
  if (!stage) return { sources: [], recorded: false, missing: true };
  // A later source edit must never replace the evidence behind a submitted answer.
  if (stage.output) {
    const sources = stage.sourceHash ? run.sourceHistory?.[stage.sourceHash] : undefined;
    return { sources: sources ?? [], recorded: true, missing: !sources };
  }
  if (phase !== run.current) return { sources: [], recorded: false, missing: false };
  return { sources: [...(run.workflowSource ? [run.workflowSource] : []), ...(run.materials ?? []), ...(stage.executionSources ?? [])], recorded: false, missing: false };
}

export function sourceSnapshots(run: PipelineRun, phase: number): string {
  const evidence = reviewSources(run, phase);
  if (evidence.missing) return '<p class="callout warn">The submitted source snapshot is unavailable. Request evidence before deciding.</p>';
  return evidence.sources.map(source => more(`${source.title} · ${source.content ? "View source text" : "Link only"}`,
    `<p class="fine">${evidence.recorded ? "Captured with this handoff." : "Current workspace material; not proof the agent read it."}</p>
    ${source.content ? `<pre class="pre">${escape(source.content)}</pre>` : '<p class="text-3">No source text captured. A link alone does not establish support.</p>'}
    ${"kind" in source ? detail([["File", escape(source.path)], ["Read at", escape(source.readAt)], ["Source hash", `<code class="hash wrap">${escape(source.sha256)}</code>`]]) : ""}`)).join("");
}

export function reviewBrief(run: PipelineRun, phase: number): string {
  const stage = run.stages[phase];
  const config = run.config.stages[phase];
  if (!stage || !config || !stage.output) return "";
  const evidence = reviewSources(run, phase);
  const texts = evidence.sources.filter(source => source.content.trim()).length;
  const links = evidence.sources.length - texts;
  const reviewState = stage.status === "complete" ? "Stage complete" : stage.status === "awaiting_review" ? "Decision required" : "Revision in progress";
  const decision = config.approval
    ? `${stage.approvals.length} of ${run.requiredApprovals} required approvals`
    : "No approval gate configured";
  return panel("Review brief", `<div class="panel-body">
    ${detail([["Decision", status(stage.status === "awaiting_review" ? "warn" : "neutral", reviewState)],
      ["Handoff", `${escape(config.name)} · ${stage.outputVersion ? `revision ${stage.outputVersion}` : "version not recorded"}`],
      ["Evidence", evidence.missing ? status("warn", "Snapshot unavailable") : `${texts} captured source${texts === 1 ? "" : "s"} · ${links} link-only reference${links === 1 ? "" : "s"}`],
      ["Approval policy", escape(decision)]])}
    <p class="text-2">Compare the handoff with its captured sources. Record unsupported claims or missing evidence in Discussion; request changes when needed.</p>
    ${more("What approval means", '<p>Approval signs this output and its source snapshot. An edit requires fresh approvals. Named reviewers must all sign, in addition to the required count.</p><p>Tool execution and automated checks do not prove factual accuracy. This workflow approval is not an agency authorization, a compliance certification, or permission to grant access in another system.</p>')}
    ${more("Decision identifiers", detail([["Workspace", escape(run.workspaceId)], ["Output hash", `<code class="hash wrap">${escape(stage.outputHash)}</code>`], ["Source snapshot hash", `<code class="hash wrap">${escape(stage.sourceHash ?? "Not recorded")}</code>`]]))}
  </div>`);
}
