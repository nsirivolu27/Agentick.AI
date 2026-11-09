import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { homeView } from "./home-view.js";
import { escape } from "./ui.js";

export function baseWorkspacePage(snapshot: WorkbenchSnapshot, requestedTab?: string | null): Page {
  const tab = requestedTab === "readiness" || requestedTab === "handoffs" ? requestedTab : "work";
  const runs = (snapshot.pipelines?.runs ?? []).filter(run => run.workspaceId === snapshot.workspaceId);
  const navigation = `<nav class="workspace-sections" aria-label="Workspace sections">${[
    ["work", "Work"], ["readiness", "Readiness"], ["handoffs", "Handoffs"],
  ].map(([key, label]) => `<a href="#/workspace?tab=${key}" ${tab === key ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  let body = "";
  if (tab === "work") {
    body = homeView(snapshot);
  } else if (tab === "readiness") {
    const stages = snapshot.pipelines?.config.stages ?? [];
    const reviewers = snapshot.approvers;
    const checks = [
      { title: "Workflow", state: stages.length ? `${stages.length} stages configured` : "Not configured",
        detail: `${stages.filter(stage => stage.approval).length} stages require human review. Existing runs keep their original configuration.`, href: "#/workflows", action: "Inspect workflow" },
      { title: "Model access", state: snapshot.chat.configured ? "Provider configured" : "Not configured",
        detail: snapshot.chat.configured ? `${snapshot.chat.provider ?? "Provider"} · ${snapshot.chat.model ?? "Model not reported"}. Configuration is not a successful execution check.` : "Connect a model when the workflow requires inference. Manual and rule-based work can run without one.", href: "#/connections", action: "Check connections" },
      { title: "Source material", state: `${snapshot.documents?.documents.length ?? 0} portal document(s)`,
        detail: `${runs.filter(run => run.materials?.some(material => material.content.trim()) || run.stages.some(stage => stage.executionSources?.some(source => source.content.trim())) || Object.values(run.sourceHistory ?? {}).some(sources => sources.some(source => source.content.trim()))).length} work items contain attached or captured source text. A count is not proof of grounding; inspect each item's evidence.`, href: "#/documents", action: "Manage evidence" },
      { title: "Reviewers", state: reviewers ? `${reviewers.length} reviewer role holders` : "Directory unavailable",
        detail: "Eligibility is checked per record. Owners and output authors cannot sign their own workflow handoffs; named reviewers may also be required.", href: "#/workflow", action: "Inspect policy" },
      { title: "Agent execution", state: snapshot.bots?.project ? "Repository attached" : snapshot.analyst ? "Rule-based analyst configured" : "No worker repository reported",
        detail: "Review tool grants and run a source-based test before assigning an agent. A saved configuration is not a passed test.", href: "#/agent-studio", action: "Test agents" },
    ];
    body = `<section class="workspace-readiness" aria-label="Workspace configuration">${checks.map(check => `<article class="panel workspace-check"><div><h2>${check.title}</h2><strong>${escape(check.state)}</strong><p>${escape(check.detail)}</p></div><a class="secondary" href="${check.href}">${check.action}</a></article>`).join("")}</section>
      <section class="panel workspace-check"><div><h2>Access and environment</h2><p>Current actor: <strong>${escape(snapshot.actor)}</strong> · ${snapshot.roles.map(escape).join(", ")}</p><p>${snapshot.demo ? "Demo identities. This is not company sign-in or a production authorization boundary." : "Workspace identity is supplied by the server. This screen does not verify the deployment's identity-provider configuration."}</p></div><a class="secondary" href="#/account">Account & workspace</a></section>
      <details class="panel workspace-checklist"><summary>Agency deployment requirements · not assessed by this screen</summary><p>Identity and membership revocation; approved data handling and model destinations; encryption and secret management; audit retention; tested recovery; accessibility; monitoring and incident response.</p><p>These configuration facts do not establish an ATO, FedRAMP authorization, or permission to process sensitive agency data.</p></details>`;
  } else {
    const completed = runs.filter(run => run.status === "complete").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    body = `<section class="panel workspace-handoffs"><h2>Completed workflow records</h2><p>Inspect the final output, captured evidence and signatures before reusing a handoff.</p>${completed.length ? `<ul>${completed.map(run => `<li><div><a href="#/desk/${escape(run.id)}">${escape(run.title)}</a><p>Owner: ${escape(run.owner)} · ${run.stages.length} completed stages · ${escape(run.updatedAt)}</p></div><a class="secondary" href="#/desk/${escape(run.id)}">Inspect & export</a></li>`).join("")}</ul>` : '<p>No completed handoffs yet. Submitted drafts stay in Work until the workflow finishes.</p>'}<a href="#/activity">Open audit trail</a></section>`;
  }
  return {
    title: tab === "work" ? "Work queue" : tab === "readiness" ? "Workspace readiness" : "Workspace handoffs",
    context: "Team work, evidence and accountable handoffs.",
    actions: tab === "work" && snapshot.canAuthor ? '<button class="primary" data-work-new>+ New work item</button>' : "",
    body: `${navigation}${snapshot.analyst ? '<p class="workspace-specialization">Specialized workspace: <a href="#/fema">OpenFEMA disaster operations →</a></p>' : ""}${body}`,
  };
}
