import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { escape, empty, more, status } from "./ui.js";

export function agentPackagesPage(snapshot: WorkbenchSnapshot, search = ""): Page {
  const title = "Reviewed agent packages";
  const catalogue = snapshot.agentPackages;
  if (!catalogue) return { title, body: empty("This deployment has not enabled the agent test and repository runtime. Package publication and installation are unavailable.") };
  const pipeline = snapshot.pipelines;
  const admin = snapshot.roles.includes("admin");
  const reviewer = admin || snapshot.roles.includes("approver");
  const query = search.trim().toLowerCase();
  const packages = catalogue.packages.filter(item => `${item.agent.name} ${item.agent.purpose} ${item.requestedBy}`.toLowerCase().includes(query));
  const button = (action: string, label: string, id: string, hash: string, enabled = true) =>
    `<button class="secondary small" type="button" data-package-action="${action}" data-package="${id}" data-hash="${hash}" ${enabled ? "" : "disabled"}>${label}</button>`;
  const cards = packages.map(item => {
    const installed = catalogue.installations.filter(entry => entry.packageId === item.id);
    const prior = catalogue.installations.filter(entry => catalogue.packages.some(pkg => pkg.id === entry.packageId && pkg.agent.id === item.agent.id && pkg.version < item.version));
    const label = item.retired ? "Retired" : item.ready ? "Ready to install" : item.evidenceCurrent ? "Awaiting review" : "Evidence needs retesting";
    return `<article class="panel"><div class="panel-head"><h2>${escape(item.agent.name)} <small>v${item.version}</small></h2>${status(item.ready ? "ok" : "neutral", label)}</div><div class="panel-body"><p>${escape(item.agent.purpose)}</p>
      <p class="text-3">Publisher ${escape(item.requestedBy)} · ${item.approvals.length}/${item.effectiveApprovals} approvals · ${item.cases.length} tested cases</p>
      ${more("Definition and evaluation", `<p>Model: ${escape(item.agent.model)}</p><p>Tools: ${item.agent.bot.allowedTools?.map(escape).join(", ") || "None"}</p><p>Required files: ${item.agent.bot.requiredSourcePaths?.map(escape).join(", ") || "None"}</p><pre class="pre">${escape(item.agent.instructions)}</pre><ul>${item.cases.map(test => `<li>${escape(test.title)} · ${escape(test.source || "No named source")}</li>`).join("")}</ul><p><a href="#/agent-studio/${item.agent.id}/test">Inspect test evidence</a></p><p>Signature content hash</p><code>${escape(item.contentHash)}</code><ul>${item.approvals.map(approval => `<li>${escape(approval.by)} · ${escape(approval.at)}</li>`).join("")}</ul>`)}
      <p class="audit-links"><a download href="/api/agent-package-export?id=${item.id}">Export private package evidence</a></p>
      <div class="actions">${reviewer && item.requestedBy !== snapshot.actor && !item.approvals.some(entry => entry.by === snapshot.actor) ? button("approve", "Approve version", item.id, item.contentHash, item.evidenceCurrent && !item.retired) : ""}
      ${admin ? button("install", installed.length ? "Installed" : "Install version", item.id, item.contentHash, item.ready && !installed.length) + button("retire", "Retire version", item.id, item.contentHash, !item.retired) : ""}</div>
      ${admin && prior.length && item.ready ? `<form data-package-form="install" data-package="${item.id}" data-hash="${item.contentHash}"><label>Upgrade from<select name="upgradedFrom">${prior.map(entry => `<option value="${entry.id}">v${catalogue.packages.find(pkg => pkg.id === entry.packageId)!.version} · ${escape(entry.at)}</option>`).join("")}</select></label><button class="secondary">Install explicit upgrade</button><small>Existing stages and runs retain their previous binding.</small></form>` : ""}
      ${installed.map(entry => `<p class="text-3">Installed ${escape(entry.at)} by ${escape(entry.by)}${entry.upgradedFrom ? " · explicit upgrade" : ""}</p>${admin && pipeline ? `<form data-package-form="assign" data-installation="${entry.id}" data-version="${pipeline.version}"><label>Assign this version to stage<select name="stageId">${pipeline.config.stages.filter(stage => !stage.assistantId).map(stage => `<option value="${escape(stage.id)}">${escape(stage.name)}</option>`).join("")}</select></label><button class="secondary" ${item.ready ? "" : "disabled"}>Assign installed version</button><small>Only the selected stage in future runs changes.</small></form>` : ""}`).join("")}</div></article>`;
  }).join("");
  const publish = pipeline && snapshot.canAuthor ? `<form data-package-form="publish" data-version="${pipeline.version}"><label>Tested agent<select name="agentId">${(pipeline.config.configurables ?? []).map(agent => `<option value="${agent.id}">${escape(agent.name)}</option>`).join("")}</select></label><button class="primary" ${(pipeline.config.configurables?.length ?? 0) ? "" : "disabled"}>Request package review</button><small>The server rechecks the full test suite. Publication requires independent signatures.</small></form>` : "";
  const importForm = admin && pipeline ? more("Import a draft template", `<form data-package-form="import" data-version="${pipeline.version}"><label>Template JSON<textarea name="template" rows="5" maxlength="20000" required placeholder='{"kind":"agentick-agent-template","version":1,"agent":{...}}'></textarea></label><button class="secondary">Import draft</button><small>Only the strict template schema is accepted. Imported content has no approvals and must be tested here.</small></form>`) : "";
  return { title, context: "Versioned definitions, local test evidence and independent review.", actions: '<a class="secondary" href="#/marketplace">Draft templates</a>',
    body: `<div class="employee-focus agent-packages"><form id="package-search" role="search"><label>Search packages<input name="q" type="search" value="${escape(search)}"></label><button class="secondary">Search</button></form>${publish}${cards || empty("No reviewed agent packages yet. Test an agent, then request package review.")}${importForm}</div>` };
}
