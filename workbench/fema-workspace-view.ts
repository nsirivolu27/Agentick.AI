import type { WorkbenchSnapshot } from "./snapshot.js";
import type { AnalystJob } from "./analyst-runtime.js";
import type { Page } from "./studio-view.js";
import { escape } from "./ui.js";

export function briefingState(snapshot: WorkbenchSnapshot, job: AnalystJob): string {
  const run = snapshot.pipelines?.runs.find(item => item.id === job.runId && item.workspaceId === snapshot.workspaceId);
  if (!run) return "Work item unavailable";
  if (run.status === "cancelled") return "Cancelled";
  if (run.status === "blocked") return "Workflow blocked";
  if (job.status === "blocked") return "Grounding required";
  if (job.status === "failed" || job.status === "cancelled") return "Execution stopped";
  if (job.status === "queued" || job.status === "running") return "Reading evidence";
  // An execution's completed flag is not the workflow's approval decision.
  if (run.status === "paused") return "Paused";
  if (run.status === "complete") return "Handoff complete";
  if (run.stages[run.current]?.status === "awaiting_review") return "Awaiting approval";
  if (run.stages.some(stage => stage.draft?.jobId === job.id)) return "Ready to submit";
  return "Open current work item";
}

export function femaWorkspacePage(snapshot: WorkbenchSnapshot, section = "briefings"): Page {
  const tab = ["briefings", "data", "team"].includes(section) ? section : "briefings";
  const jobs = (snapshot.analyst?.jobs ?? []).filter(job => job.workspaceId === snapshot.workspaceId)
    .slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tabs = `<nav class="fema-tabs" aria-label="Disaster operations">${[
    ["briefings", "Briefings"], ["data", "Data & evidence"], ["team", "Team & controls"],
  ].map(([key, label]) => `<a href="#/fema/${key}" ${tab === key ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  const note = `<p class="fema-boundary">${snapshot.demo ? "FEMA use-case demo · public data" : "OpenFEMA analysis workspace"} · Independent prototype; not an official FEMA service.</p>`;
  const setup = !snapshot.analyst ? `<section class="panel fema-panel"><h2>Connect the analyst runtime</h2><p>This workspace does not have the OpenFEMA analyst configured.</p><a class="secondary" href="#/analyst">Open setup instructions</a></section>` : "";
  let body: string;
  if (tab === "data") {
    body = `<section class="panel fema-panel"><h2>Disaster Declarations Summaries · v2</h2><p>Compare declaration records for a selected area. Count distinct disaster numbers separately from designated-area rows.</p>
      <div class="fema-grid"><article><h3>Saved evidence</h3><p>The configured demo uses five Virginia county rows from one declaration. It is a historical sample, not statewide coverage.</p></article>
      <article><h3>Fresh lookup</h3><p>Explicit OpenFEMA query: at most ten records. Live results remain evidence-only until the required Foundry grounding is available.</p></article>
      <article><h3>Ontology</h3><p>${snapshot.analyst ? "Offline Foundry replay. A real Foundry environment is not connected in this analyst runtime." : "Analyst runtime not configured. Check connections before running."}</p><a href="#/connections">Check connections</a></article></div>
      <details><summary>Interpretation rules</summary><ul><li>A missing area does not establish no disaster impact.</li><li>Declaration records do not determine an individual's assistance eligibility.</li><li>Use the saved query, retrieval date and content hash when reviewing a brief.</li><li>A valid hash establishes integrity, not factual accuracy.</li></ul>
      <a href="https://www.fema.gov/openfema-data-page/disaster-declarations-summaries-v2" target="_blank" rel="noopener noreferrer">Official dataset documentation</a></details></section>
      <section class="panel fema-panel"><h2>Evidence captured by this workspace</h2>${jobs.some(job => job.sources.length) ? `<ul class="fema-records">${jobs.filter(job => job.sources.length).map(job => {
        const source = job.sources.at(-1)!;
        return `<li><div><a href="#/analyst/${escape(job.id)}">${escape(job.request.county || job.request.area)} · ${escape(source.title)}</a><p>${escape(source.mode)} · Retrieved ${escape(source.retrievedAt)}</p></div><span>${source.rows} area rows · ${source.declarations} declaration(s)</span></li>`;
      }).join("")}</ul>` : "<p>No analyst reads recorded yet. Run a briefing to capture its source evidence.</p>"}</section>`;
  } else if (tab === "team") {
    body = `<section class="panel fema-panel"><h2>One team, separate responsibilities</h2><div class="fema-grid">
      <article><h3>Request owner</h3><p>Choose an area and source scope. Check the draft before submitting it.</p><a href="#/analyst">Prepare a briefing</a></article>
      <article><h3>Public-data analyst</h3><p>Read permitted sources and compute bounded counts. The current controller is rule-based; it does not make model calls.</p><a href="#/workflows">Inspect workflow</a></article>
      <article><h3>Independent reviewers</h3><p>Compare claims with captured evidence. Sign the current handoff; the owner and output author cannot sign their own work.</p><a href="#/desk">Open review desk</a></article></div></section>
      <section class="panel fema-panel"><h2>Controls before handoff</h2><dl class="fema-facts"><dt>Workspace policy</dt><dd>${snapshot.workflow.requiredApprovals} distinct approvals; each existing run keeps its recorded policy.</dd><dt>Reviewer role holders</dt><dd>${snapshot.approvers?.length ? snapshot.approvers.map(escape).join(", ") : "No reviewer directory available in this view."}</dd><dt>External actions</dt><dd>This analyst reads data. It does not award aid, dispatch resources, or send a public notice.</dd><dt>Evidence</dt><dd>Source reads, content hashes, revisions and signatures stay with the work item.</dd></dl></section>
      <section class="panel fema-panel"><h2>Configure the next capability</h2><div class="fema-links"><a href="#/agent-studio/new?preset=public-analyst">Create a source-grounded agent</a><a href="#/canvas">Assemble workflow</a><a href="#/marketplace?collection=packages">Review agent packages</a><a href="#/activity">Inspect audit trail</a></div><p class="text-2">New agents must be tested and reviewed before assignment. Creating an agent does not connect it to this rule-based analyst.</p></section>`;
  } else {
    const states = jobs.map(job => briefingState(snapshot, job));
    body = `<section class="panel fema-panel"><div class="fema-heading"><div><h2>Declaration briefing desk</h2><p>Turn public records into a source-backed briefing for human review.</p></div>${snapshot.analyst && snapshot.canAuthor ? '<a class="primary" href="#/analyst">New briefing</a>' : ""}</div>
      <ol class="fema-flow" aria-label="Briefing workflow"><li><strong>1 · Scope</strong><span>Area and source</span></li><li><strong>2 · Analyze</strong><span>Bounded MCP reads</span></li><li><strong>3 · Review</strong><span>Independent signatures</span></li><li><strong>4 · Handoff</strong><span>Brief and audit evidence</span></li></ol>
      <dl class="fema-metrics"><div><dt>Briefing executions</dt><dd>${jobs.length}</dd></div><div><dt>Ready to submit</dt><dd>${states.filter(state => state === "Ready to submit").length}</dd></div><div><dt>Awaiting approval</dt><dd>${new Set(jobs.filter((_, index) => states[index] === "Awaiting approval").map(job => job.runId)).size}</dd></div><div><dt>Needs attention</dt><dd>${states.filter(state => ["Grounding required", "Execution stopped", "Work item unavailable", "Paused", "Workflow blocked"].includes(state)).length}</dd></div></dl></section>
      <section class="panel fema-panel"><h2>Briefing queue</h2>${jobs.length ? `<ul class="fema-records">${jobs.map((job, index) => {
        const run = snapshot.pipelines?.runs.find(item => item.id === job.runId && item.workspaceId === snapshot.workspaceId);
        return `<li><div><a href="#/analyst/${escape(job.id)}">${escape(job.request.county || job.request.area)} · Declaration briefing</a><p>${escape(job.request.question)}</p><small>${job.request.scope === "snapshot" ? "Saved snapshot" : "Bounded live lookup"} · ${escape(states[index]!)}</small></div><div class="fema-links"><a href="#/analyst/${escape(job.id)}">Inspect analysis</a>${run ? `<a href="#/desk/${escape(run.id)}">${states[index] === "Handoff complete" ? "View handoff" : "Open work item"}</a>` : ""}</div></li>`;
      }).join("")}</ul>` : '<p>No briefing executions yet. Start with a county in the saved Virginia sample.</p>'}</section>
      <section class="panel fema-panel"><h2>Work supported today</h2><div class="fema-grid"><article><h3>County declaration brief</h3><p>Identify records for a named county and cite their source.</p></article><article><h3>Coverage check</h3><p>Show when a county is absent from the bounded sample without inferring no impact.</p></article><article><h3>Fresh evidence review</h3><p>Read recent records and expose grounding gaps before handoff.</p></article></div><p class="text-2">Current configured area: Virginia. Foundry replay and demo identities are not production agency integrations.</p></section>`;
  }
  return { title: "Disaster operations", context: "OpenFEMA · Declaration analysis and reviewed briefings", body: `<div class="fema-workspace">${note}${tabs}${setup}${body}</div>` };
}
