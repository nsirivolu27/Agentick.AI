import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page, StudioUi } from "./studio-view.js";
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function analystPage(snapshot: WorkbenchSnapshot, id: string | undefined, ui: StudioUi): Page {
  const state = snapshot.analyst;
  if (!state) return { title: "Public data analyst", context: "OpenFEMA declaration evidence.",
    body: '<section class="panel"><h2>Unavailable in this workspace</h2><p>The scoped analyst runtime and source mapping are not configured. No model, Foundry connection or execution is implied.</p></section>' };
  const job = state.jobs.find(job => job.id === id);
  const recent = state.jobs.slice().reverse();
  const history = `<section class="analyst-history"><h2>Saved analyst runs</h2>${recent.length ? `<ul>${recent.map(item => `<li><a href="#/analyst/${item.id}">${escape(item.request.county || "Virginia")} · ${escape(item.request.question)}</a><span>${escape(item.status)}${item.result === "limited" ? " · limited source" : ""}</span></li>`).join("")}</ul>` : '<p>No analyst requests yet. Create one to record the source reads and their results.</p>'}</section>`;
  if (!job) {
    const draft = ui.drafts["analyst-request"];
    return { title: "Public data analyst", context: "Create a bounded, evidence-backed declaration request.",
      body: `<div class="analyst-page">${id ? '<p role="alert">This run is not available in the selected workspace. It may belong to another workspace.</p>' : ""}
      <section class="panel"><h2>New public-data request</h2><p>Rule-based controller, not model inference. The saved source contains five county rows representing one declaration. Foundry reads use offline replay.</p>
      <details><summary>Read tools and boundaries</summary><p>The controller has only local MCP reads: <code>get_pipeline_run</code>, <code>summarize_declaration_sample</code>, and <code>get_ontology_object</code>. The explicit live scope additionally permits <code>lookup_openfema_declarations</code> at the fixed public endpoint. No write tools, role changes, model calls or provider fallback are permitted. Foundry object reads use offline replay.</p></details>
      ${snapshot.canAuthor ? `<form id="analyst-request" data-draft="analyst-request"><label>Area<select name="area"><option value="VA">Virginia (VA) · configured source</option></select></label>
      <label>County (optional)<input name="county" maxlength="80" value="${escape(draft?.county ?? "")}" placeholder="Montgomery"></label>
      <label>Question<textarea name="question" required minlength="3" maxlength="2000" rows="3">${escape(draft?.question ?? "")}</textarea></label>
      <label>Source scope<select name="scope"><option value="snapshot" ${draft?.scope !== "bounded_live" ? "selected" : ""}>Saved five-row snapshot · offline replay</option><option value="bounded_live" ${draft?.scope === "bounded_live" ? "selected" : ""}>Live source lookup · handoff grounding unavailable</option></select></label>
      <p class="text-2">The question is recorded; county and scope determine the rule-based lookups. A live lookup saves evidence from at most two pages / ten rows, with one retry per page and a twelve-second deadline. Fresh evidence cannot enter this Foundry-bound handoff until authorized grounding is configured. Missing rows never prove that a county was unaffected.</p>
      <button class="primary">Run agent</button></form>` : '<p role="note">An author or administrator must create a request. Reviewers can inspect saved runs.</p>'}</section>${history}</div>` };
  }
  const run = snapshot.pipelines?.runs.find(run => run.id === job.runId);
  const stage = run?.stages[0];
  const canChange = snapshot.canAuthor && (job.owner === snapshot.actor || snapshot.roles.includes("admin"));
  const output = stage?.draft?.jobId === job.id ? stage.draft.text : undefined;
  return {
    title: job.request.county ? `${job.request.county} · analyst run` : "Virginia · analyst run",
    context: "Inspect source reads, then review the draft before submitting a handoff.",
    actions: snapshot.canAuthor ? '<a class="secondary" href="#/analyst">New request</a>' : "",
    body: `<div class="analyst-page" data-analyst-job="${job.id}">
    <section class="panel analyst-summary"><h2>Execution: ${escape(job.status)}${job.result === "limited" ? " · limited source" : ""}</h2>
    <p>${escape(job.request.question)}</p><dl><dt>Owner</dt><dd>${escape(job.owner)}</dd><dt>Area / county</dt><dd>${escape(job.request.area)} / ${escape(job.request.county || "All rows in scope")}</dd><dt>Controller</dt><dd>Rule-based · no model inference</dd><dt>Data mode</dt><dd>${job.request.scope === "snapshot" ? "Saved snapshot · offline Foundry replay" : "Explicit bounded live OpenFEMA query · Foundry mapping remains offline replay"}</dd><dt>Execution ID</dt><dd><code>${job.id}</code></dd><dt>Attempt</dt><dd>${job.attempt} of 3 maximum</dd></dl>
    ${job.error ? `<p class="inline-error" role="alert">${escape(job.error)}</p>` : ""}
    ${canChange && ["queued", "running"].includes(job.status) ? `<button class="secondary" data-analyst-action="cancel" data-analyst-id="${job.id}">Cancel run</button>` : ""}
    ${canChange && job.status === "failed" && job.attempt < 3 ? `<button class="primary" data-analyst-action="retry" data-analyst-id="${job.id}">Retry run</button>` : ""}</section>
     <ol class="analyst-stages" aria-label="Analyst stages"><li>Request saved</li><li>${["queued", "running"].includes(job.status) ? "Executing reads" : job.status === "completed" || job.status === "blocked" ? "Reads completed" : "Execution stopped"}</li><li>${job.status === "blocked" ? "Source grounding required" : stage?.status === "awaiting_review" ? "Waiting for independent review" : stage?.status === "complete" ? "Handoff approved" : "Human submission required"}</li></ol>
    <div class="analyst-columns"><section class="panel"><h2>Evidence</h2>${job.sources.length ? job.sources.map(source => `<article class="analyst-source"><h3>${escape(source.title)}</h3><p>${escape(source.mode)} · retrieved ${escape(source.retrievedAt)}</p><p>${source.rows} county rows · ${source.declarations} distinct declaration(s)</p><p>${escape(source.excerpt)}</p><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">Open source query</a><details><summary>Query and content hash</summary><p>${escape(source.url)}</p><code>${escape(source.hash)}</code></details><details><summary>Exact saved source</summary><pre>${escape(source.content ?? "Saved bytes unavailable for this older record.")}</pre></details></article>`).join("") : '<p>No successful source reads recorded yet.</p>'}</section>
     <section class="panel"><h2>Output</h2>${output ? `<div class="analyst-output">${escape(output)}</div>` : `<p>${["failed", "cancelled", "blocked"].includes(job.status) ? "No draft accepted for this execution." : job.status === "completed" ? "This execution's original draft is no longer current on the work item. Open the work item to inspect its latest state." : "The draft appears only after successful tool reads."}</p>`}</section></div>
    <section class="panel"><h2>Actual tool activity</h2><p>No animation or provider inference is used as evidence of execution.</p>
     ${job.trace.length ? `<ol class="analyst-trace">${job.trace.map(entry => `<li><h3>${escape(entry.tool)} · ${escape(entry.outcome)}</h3><p>${escape(entry.reason)}</p><p>${escape(entry.summary)}</p><small>${escape(entry.startedAt)} · ${entry.durationMs} ms</small><details><summary>Safe tool inputs</summary><pre>${escape(JSON.stringify(entry.inputs, null, 2))}</pre></details></li>`).join("")}</ol>` : `<p>${["queued", "running"].includes(job.status) ? "Queued. No tool has executed yet." : "No tool executed before this execution stopped."}</p>`}</section>
    <section class="panel"><h2>Review and handoff</h2><p>${stage?.approvals.length ?? 0} of ${run?.requiredApprovals ?? "?"} independent approvals · ${escape(stage?.status ?? "work item unavailable")}</p><p>Execution completion is not human approval. The owner and output author cannot approve their own handoff.</p>
    ${run ? `<a class="${job.status === "completed" && stage?.status === "active" ? "primary" : "secondary"}" href="#/desk/${run.id}">Review output</a>` : '<p>Unavailable: the saved work item could not be loaded.</p>'}</section>${history}</div>`,
  };
}
