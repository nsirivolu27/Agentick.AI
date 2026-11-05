import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { escape } from "./ui.js";

/** Each step links to its actual record; opening the guide performs no mutation. */
export function systemDemoPage(snapshot: WorkbenchSnapshot): Page {
  const unavailable = { title: "Demo walkthrough", body: '<section class="panel"><p>Run <code>corepack pnpm start:demo</code> to open the isolated full demo. Company data and roles are not changed.</p></section>' };
  if (!snapshot.demo) return unavailable;
  const agent = snapshot.pipelines?.config.configurables?.find(item => item.name === "Public data analyst");
  const run = snapshot.pipelines?.runs.find(item => item.title === "Virginia disaster-declaration briefing");
  if (!agent || !run) return unavailable;
  const packages = snapshot.agentPackages?.packages ?? [];
  const installations = snapshot.agentPackages?.installations ?? [];
  const attempts = snapshot.bots?.attempts.filter(item => item.runId === run.id) ?? [];
  const review = run.stages.at(-1)!;
  const steps = [
    { title: "1. Team and source", detail: "Emergency-management analyst, evidence reviewer, and two independent demo signers.", href: "#/documents", action: "Inspect source", state: `${snapshot.documents?.documents.length ?? 0} saved document(s)` },
    { title: "2. Configure the agent", detail: "Instructions, a selected model, and a bounded read-only file tool.", href: `#/agent-studio/${agent.id}`, action: "Open Agent Studio", state: agent.name },
    { title: "3. Test against evidence", detail: "The worker reads the saved source. Inspect its tool trace and the synthetic review.", href: `#/agent-studio/${agent.id}/test`, action: "Inspect test", state: `${packages.reduce((count, pkg) => count + pkg.runIds.length, 0)} packaged test run(s)` },
    { title: "4. Approve and install", detail: "Each package requires two signatures before workspace installation.", href: "#/marketplace?collection=packages", action: "Open marketplace", state: `${packages.filter(pkg => pkg.ready).length} ready · ${installations.length} installed` },
    { title: "5. Assemble the workflow", detail: "Public-data analyst → evidence reviewer → independent approval.", href: "#/canvas", action: "Open canvas", state: `${run.config.stages.length} saved stages` },
    { title: "6. Execute and review", detail: "Source reads produce proposals. The operator accepts them; reviewers sign the handoff.", href: `#/desk/${run.id}`, action: "Inspect work item", state: `${attempts.filter(item => item.status === "accepted").length} accepted outputs · ${review.approvals.length}/${run.requiredApprovals} approvals` },
    { title: "7. Handoff and audit", detail: "Inspect the final output and signatures; download the JSON audit package from the work item.", href: `#/desk/${run.id}`, action: "View handoff & export", state: `Work item: ${run.status}` },
  ];
  return { title: "A briefing from request to handoff", context: "Emergency management · Full system walkthrough",
    actions: '<a class="secondary" href="#/workspace">Open work queue</a>',
    body: `<section class="panel system-demo-summary"><h2>One briefing. A complete workflow.</h2><p>Saved OpenFEMA data → tested agents → approved handoff.</p><p class="text-2">Responses and reviewer decisions are scripted demo fixtures. Tool reads, tests, installations and approval records run locally.</p></section>
    <ol class="system-demo-steps">${steps.map(step => `<li class="panel"><h2>${escape(step.title)}</h2><p>${escape(step.detail)}</p><p class="text-2">${escape(step.state)}</p><a class="secondary" href="${step.href}">${escape(step.action)}</a></li>`).join("")}</ol>
    <section class="panel system-demo-summary"><h2>Try it yourself</h2><p>Start another briefing. Run each stage, inspect its reads, then switch demo reviewers in Account.</p><a class="primary" href="#/workspace">Start another work item</a></section>
    <details class="panel system-demo-summary"><summary>Connected tools and demo boundaries</summary><p><a href="#/chat">Workspace MCP chat</a> · <a href="#/connections">Connections</a> · <a href="#/mcp">MCP inspector</a> · <a href="#/ontology">Ontology mapping</a></p><p>Public snapshot, not a current disaster assessment. Foundry uses offline replay. No live cloud deployment, billing, Jira delivery, company sign-in, or model inference is demonstrated. Hashes establish integrity, not accuracy or certification. Each launch creates an isolated disposable demo; export evidence before stopping it.</p></details>` };
}
