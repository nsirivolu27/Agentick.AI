import type { AgentConfigurable } from "./agent-configurables.js";
import type { AgentPackageSnapshot } from "./agent-packages.js";
import { agentHash, passedCurrentTest, type AgentTestsSnapshot } from "./agent-tests-model.js";

/**
 * Where one saved agent stands, read from what is already recorded. Nothing
 * here is a verdict: a step is reached only when the saved facts say so, and
 * a stale or failed check leaves the step unreached. The browser bundle
 * imports this file, so it uses no Node modules.
 */

export type LifecycleStep = "draft" | "tested" | "approved" | "installed";
export interface LifecycleState {
  step: LifecycleStep;
  label: string;
  reached: boolean;
  /** One short line a person can act on: what is recorded, or what is still needed. */
  detail: string;
  href?: string;
}
export interface AgentLifecycle {
  /** The furthest step reached. */
  current: LifecycleStep;
  steps: LifecycleState[];
  /** The package that freezes this exact saved version, when one exists. */
  package?: AgentPackageSnapshot["packages"][number];
  installation?: AgentPackageSnapshot["installations"][number];
  /** A newer ready package of this agent than the installed one, if any. */
  upgrade?: AgentPackageSnapshot["packages"][number];
}

export function agentLifecycle(agent: AgentConfigurable, tests: AgentTestsSnapshot | undefined, catalogue: AgentPackageSnapshot | undefined): AgentLifecycle {
  const id = agent.id;
  const current = agentHash(agent);
  const packages = (catalogue?.packages ?? []).filter(item => item.agent.id === id);
  const pkg = packages.find(item => agentHash(item.agent) === current && !item.retired);
  const installations = (catalogue?.installations ?? []).filter(entry => packages.some(item => item.id === entry.packageId));
  const latestInstall = installations.slice().sort((a, b) => b.at.localeCompare(a.at))[0];
  const installedPackage = latestInstall ? packages.find(item => item.id === latestInstall.packageId) : undefined;
  const installation = pkg && latestInstall?.packageId === pkg.id ? latestInstall : undefined;
  const upgrade = installedPackage ? packages.filter(item => item.ready && !item.retired && item.version > installedPackage.version).sort((a, b) => b.version - a.version)[0] : undefined;
  const tested = passedCurrentTest(agent, tests);
  const steps: LifecycleState[] = [
    { step: "draft", label: "Draft", reached: true, detail: `Saved version v${current}.`, href: `#/agent-studio/${id}` },
    { step: "tested", label: "Tested candidate", reached: tested,
      detail: tested ? "The full saved suite passed on this version." : "Run every saved test on this version with a passing review.", href: `#/agent-studio/${id}/test` },
    { step: "approved", label: "Approved release", reached: !!pkg?.ready,
      detail: pkg ? pkg.ready ? `Package v${pkg.version} · ${pkg.approvals.length} of ${pkg.effectiveApprovals} independent approvals.` : pkg.evidenceCurrent ? `Package v${pkg.version} awaits ${pkg.effectiveApprovals - pkg.approvals.length} more independent approval${pkg.effectiveApprovals - pkg.approvals.length === 1 ? "" : "s"}.` : `Package v${pkg.version} evidence needs retesting.` : tested ? "Request package review to freeze this version for approval." : "A package is requested after the suite passes.", href: "#/agent-packages" },
    { step: "installed", label: "Installed version", reached: !!installation,
      detail: installation ? `Installed ${installation.at.slice(0, 10)} by ${installation.by}${upgrade ? ` · upgrade to v${upgrade.version} available` : ""}.` : installedPackage ? `v${installedPackage.version} is installed; this saved version is not.` : "Install the approved package to use it in this workspace.", href: "#/agent-packages" },
  ];
  const reached = steps.filter(step => step.reached);
  return { current: reached[reached.length - 1]!.step, steps, ...(pkg ? { package: pkg } : {}), ...(installation ? { installation } : {}), ...(upgrade ? { upgrade } : {}) };
}

/** How a recorded run was executed, read from the model identifier the run saved. Never a claim about accuracy. */
export function executionMode(model: string): { label: string; detail: string } {
  if (model === "demo-scripted" || model.startsWith("demo")) return { label: "Scripted demo", detail: "Synthetic responses; real tool reads, no inference." };
  if (model.startsWith("workspace/")) return { label: "Live · workspace connection", detail: "Billed to the workspace's provider account." };
  if (model.startsWith("personal/")) return { label: "Live · personal connection", detail: "Billed to the person who connected it." };
  if (model.startsWith("replay")) return { label: "Replay", detail: "Recorded responses replayed; no new inference." };
  return { label: "Live · server model", detail: "The model configured on this server." };
}
