/**
 * The Connections directory: every integration the workspace can use, in one
 * list, each with a state that means one thing.
 *
 *   not_configured  nothing is set up for it
 *   unverified      settings exist, but nothing has proved they work yet
 *   verified        a bounded check succeeded (a model list, a source read)
 *   succeeded       the last real operation through it succeeded
 *   unavailable     configured, but the last check or operation failed
 *
 * The directory reads the runtimes' own summaries and an in memory log of
 * the last operation per connector. It owns no credentials and no second
 * copy of any configuration; the setup forms stay on their own pages.
 */

export type ConnectionState = "not_configured" | "unverified" | "verified" | "succeeded" | "unavailable";
export type ConnectionGroup = "models" | "sources" | "delivery" | "identity";
export interface ConnectionEntry {
  id: string; group: ConnectionGroup; name: string; state: ConnectionState;
  /** One sentence a person can act on. Never a secret, a setting value or a token. */
  detail: string;
  href: string;
  read: boolean; write: boolean;
  /** When the last real operation through this connector happened and whether it succeeded. */
  last?: { at: string; ok: boolean; detail: string };
}

export interface OperationRecord { at: string; ok: boolean; detail: string }
/** The last operation through each connector in each workspace, kept in memory for this process. */
export function createOperationLog() {
  const records = new Map<string, OperationRecord>();
  return {
    record(workspaceId: string, connector: string, ok: boolean, detail: string, actor?: string) {
      records.set(JSON.stringify([workspaceId, connector, actor ?? null]), { at: new Date().toISOString(), ok, detail: detail.slice(0, 200) });
    },
    last(workspaceId: string, connector: string, actor?: string): OperationRecord | undefined { return records.get(JSON.stringify([workspaceId, connector, actor ?? null])); },
  };
}
export type OperationLog = ReturnType<typeof createOperationLog>;

export interface DirectoryInput {
  workspaceId: string;
  actor?: string;
  log: OperationLog;
  models?: { options: { id: string; label: string; provider: string; available: boolean; local: boolean; detail: string }[]; error?: string } | undefined;
  personal?: { provider: string; models: string[] }[] | undefined;
  /** Administrator connected providers for the whole workspace: what agents may use. */
  workspaceConnections?: { provider: string; models: string[]; verifiedAt?: string; lastError?: string; state?: "connected" | "verified" | "failed" }[] | undefined;
  zenfluence?: { configured: boolean; ready?: boolean; site?: string; project?: string; spaceId?: string; settings?: { email: { name: string; configured: boolean }; token: { name: string; configured: boolean } } } | undefined;
  documents?: { count: number } | undefined;
  ontology?: { mode: "sample" | "dataset" | "foundry"; ontology: string; objectTypes: number } | undefined;
  repository?: { root: string; checks: number } | null | undefined;
  mcpTools?: { count: number } | undefined;
  jira?: { mode: "preview" | "live"; siteOrigin: string; total: number; open: number; lastSent?: { at: string; issueKey: string } } | undefined;
  automations?: { units: number; enabled: number; actions: number; lastFinished?: { at: string; status: string } } | undefined;
  slack?: { configured: boolean; ready: boolean } | undefined;
  identity?: { managed: boolean; actor: string; roles: readonly string[] } | undefined;
  billing?: { tier: string; plan?: string; managedReady?: boolean } | undefined;
}

/** Folds the last operation into a state: a success is "succeeded", a failure "unavailable", nothing keeps the given state. */
function withLast(entry: Omit<ConnectionEntry, "last">, last: OperationRecord | undefined): ConnectionEntry {
  if (!last || entry.state === "not_configured") return entry;
  return { ...entry, last, state: last.ok ? "succeeded" : "unavailable", detail: last.ok ? entry.detail : `${last.detail} Last attempt failed; check the setup on its page.` };
}

export function buildConnectionsDirectory(input: DirectoryInput): ConnectionEntry[] {
  const { log, workspaceId } = input;
  const entries: ConnectionEntry[] = [];

  // Models. A listed model is verified access, not measured inference; a grounded chat answer is a succeeded operation.
  const serverModels = input.models?.options.filter(option => !option.id.startsWith("personal/")) ?? [];
  const local = serverModels.filter(option => option.local);
  const hosted = serverModels.filter(option => !option.local);
  const describe = (group: typeof serverModels) => group.map(option => option.label).slice(0, 3).join(", ") + (group.length > 3 ? ` and ${group.length - 3} more` : "");
  entries.push(withLast({ id: "models:local", group: "models", name: "Local Ollama", read: true, write: false, href: "#/connections",
    state: input.models?.error ? "unavailable" : local.length ? (local.some(option => option.available) ? "verified" : "unavailable") : "not_configured",
    detail: input.models?.error ? input.models.error : local.length ? `${local.filter(option => option.available).length} of ${local.length} installed models available: ${describe(local)}.` : "No local model listed. Start Ollama with a chat model installed, then refresh models." }, log.last(workspaceId, "models:local")));
  entries.push(withLast({ id: "models:server", group: "models", name: "Administrator configured APIs", read: true, write: false, href: "#/connections",
    state: hosted.length ? (hosted.some(option => option.available) ? "verified" : "unavailable") : "not_configured",
    detail: hosted.length ? `${hosted.length} configured: ${describe(hosted)}. Listing is not an inference test.` : "No Azure, gateway or server API models configured. Server secrets and MAGENTIC_*_MODELS settings add them." }, log.last(workspaceId, "models:server")));
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const saved = input.personal?.find(item => item.provider === provider);
    const name = { openai: "OpenAI (personal)", anthropic: "Claude (personal)", google: "Gemini (personal)" }[provider];
    entries.push(withLast({ id: `models:${provider}`, group: "models", name, read: true, write: false, href: "#/connections",
      state: input.personal === undefined ? "not_configured" : saved ? "verified" : "not_configured",
      detail: saved ? `Key verified against the provider's model list for ${saved.models.join(", ")}. Private to you in this workspace; agents do not use it.` : "Not connected. Add an API key and text model IDs on this page; provider charges are yours." }, log.last(workspaceId, `models:${provider}`, input.actor)));
  }

  for (const provider of ["anthropic", "openai", "google"] as const) {
    const saved = input.workspaceConnections?.find(item => item.provider === provider);
    const name = { anthropic: "Claude (workspace, for agents)", openai: "OpenAI (workspace, for agents)", google: "Gemini (workspace, for agents)" }[provider];
    entries.push(withLast({ id: `models:workspace:${provider}`, group: "models", name, read: true, write: false, href: "#/connections",
      state: !saved ? "not_configured" : saved.state === "failed" ? "unavailable" : saved.state === "verified" ? "verified" : "unverified",
      detail: !saved ? "Not connected. An administrator can connect this provider for the workspace's agents on the Connections page." : saved.state === "failed" ? `Saved, but the last verification failed: ${saved.lastError ?? "unknown error"}.` : `${saved.models.join(", ")} available to agents and stages as workspace/${provider}/<model>${saved.verifiedAt ? `; verified ${saved.verifiedAt.slice(0, 16).replace("T", " ")}` : "; saved, not re-tested"}.` }, log.last(workspaceId, `models:workspace:${provider}`)));
  }

  // Company sources.
  const zen = input.zenfluence;
  const missing = zen?.settings ? [zen.settings.email, zen.settings.token].filter(item => !item.configured).map(item => item.name) : [];
  entries.push(withLast({ id: "sources:zenfluence", group: "sources", name: "Jira and Confluence (Zenfluence)", read: true, write: false, href: "#/zenfluence",
    state: !zen?.configured ? "not_configured" : zen.ready ? "unverified" : "unavailable",
    detail: !zen?.configured ? "No connection file for this workspace. Set MAGENTIC_ZENFLUENCE_FILE with the site, project and space." : zen.ready ? `${zen.site}, project ${zen.project}, space ${zen.spaceId}. Read a ticket or page to verify access.` : `Connection file loaded; the server still needs ${missing.join(" and ") || "its credential settings"}.` }, log.last(workspaceId, "sources:zenfluence")));
  entries.push(withLast({ id: "sources:documents", group: "sources", name: "Reference documents", read: true, write: true, href: "#/documents",
    state: input.documents === undefined ? "not_configured" : input.documents.count ? "verified" : "unverified",
    detail: input.documents === undefined ? "The documentation portal is not enabled on this server." : input.documents.count ? `${input.documents.count} documents saved in this workspace, readable by agents through read_document.` : "Enabled, no documents yet. Add a synthetic runbook to give agents something to cite." }, log.last(workspaceId, "sources:documents")));
  entries.push(withLast({ id: "sources:ontology", group: "sources", name: "Ontology and public data", read: true, write: false, href: "#/ontology",
    state: !input.ontology ? "not_configured" : input.ontology.mode === "foundry" ? "unverified" : "verified",
    detail: !input.ontology ? "No ontology configured for this workspace." : { sample: `Synthetic sample data, ${input.ontology.objectTypes} object types. Labelled synthetic everywhere it appears.`, dataset: `Ingested dataset "${input.ontology.ontology}", ${input.ontology.objectTypes} object types with lineage.`, foundry: `Foundry "${input.ontology.ontology}" configured; read an object to verify access. Enrollment is waitlisted, so no live access is claimed.` }[input.ontology.mode] }, log.last(workspaceId, "sources:ontology")));
  entries.push(withLast({ id: "sources:repository", group: "sources", name: "Repository", read: true, write: false, href: "#/desk",
    state: input.repository === undefined ? "not_configured" : input.repository ? "verified" : "not_configured",
    detail: input.repository === undefined ? "Repository tools are not available on this server." : input.repository ? `${input.repository.root} with ${input.repository.checks} validation commands. Agents read an isolated checkout of committed HEAD.` : "No repository connected. Connect one from the work desk." }, log.last(workspaceId, "sources:repository")));
  entries.push(withLast({ id: "sources:mcp", group: "sources", name: "MCP tools and grants", read: true, write: false, href: "#/mcp",
    state: input.mcpTools ? "verified" : "not_configured",
    detail: input.mcpTools ? `${input.mcpTools.count} read tools offered to this workspace's chat and agents. External servers need administrator setup.` : "No tools offered." }, log.last(workspaceId, "sources:mcp")));

  // Approved delivery. Writes happen only after an admin reviews a preview; the state reports the adapter and its receipts.
  entries.push(withLast({ id: "delivery:jira", group: "delivery", name: "Jira actions", read: true, write: true, href: "#/desk",
    state: !input.jira ? "not_configured" : input.jira.mode === "live" ? (input.jira.lastSent ? "succeeded" : "unverified") : "unverified",
    detail: !input.jira ? "Jira delivery is not configured on this server." : input.jira.mode === "live" ? `Live delivery to ${input.jira.siteOrigin}. ${input.jira.total} authorized actions, ${input.jira.open} open.${input.jira.lastSent ? ` Last sent ${input.jira.lastSent.issueKey} at ${input.jira.lastSent.at.slice(0, 16).replace("T", " ")}.` : ""}` : `Preview mode: ${input.jira.total} actions recorded locally, nothing sent. Configure a live Jira adapter to deliver.` }, log.last(workspaceId, "delivery:jira")));
  entries.push({ id: "delivery:confluence", group: "delivery", name: "Confluence publishing", read: false, write: false, href: "#/zenfluence", state: "not_configured",
    detail: "Not implemented. Confluence is read only; drafts are reviewed and saved as reference documents." });
  entries.push(withLast({ id: "delivery:automation", group: "delivery", name: "AWS automation units", read: true, write: true, href: "#/pipelines",
    state: !input.automations ? "not_configured" : input.automations.enabled ? (input.automations.lastFinished?.status === "succeeded" ? "succeeded" : "unverified") : "unavailable",
    detail: !input.automations ? "No automation units configured." : `${input.automations.enabled} of ${input.automations.units} units enabled, ${input.automations.actions} receipts.${input.automations.lastFinished ? ` Last outcome ${input.automations.lastFinished.status}.` : " Preview and invoke one as admin to verify."}` }, log.last(workspaceId, "delivery:automation")));
  entries.push({ id: "delivery:messaging", group: "delivery", name: "Slack and email", read: false, write: input.slack?.ready ?? false, href: "#/workspace?tab=tools&controls=slack",
    state: !input.slack?.configured ? "not_configured" : input.slack.ready ? "unverified" : "unavailable",
    detail: !input.slack?.configured ? "No messaging transport configured. Email previews are drafts, never sent." : input.slack.ready ? "Slack transport configured; audit updates are previewed before an admin sends one." : "Slack transport configured but not ready; check its settings." });

  // Identity and billing live in Account; the directory only points there.
  entries.push({ id: "identity:membership", group: "identity", name: "Company membership and roles", read: true, write: false, href: "#/account",
    state: input.identity?.managed ? "verified" : "not_configured",
    detail: input.identity ? `${input.identity.managed ? "Company sign in" : "Local session"}: ${input.identity.actor} with roles ${input.identity.roles.join(", ") || "none"}. Roles come from membership, never from email domain or billing.` : "Signed in identity unavailable." });
  entries.push({ id: "identity:billing", group: "identity", name: "Subscription", read: true, write: false, href: "#/account",
    state: !input.billing ? "not_configured" : input.billing.tier === "paid" ? "verified" : "unverified",
    detail: !input.billing ? "Billing is not configured. Local and personal key chat need no subscription." : input.billing.tier === "paid" ? `${input.billing.plan ?? "paid"} plan verified with the billing provider. A subscription grants chat allowance only, never membership or approval authority.` : "Free: your models and keys. Managed routing needs a verified Pro or Max plan." });
  return entries;
}

export const STATE_LABELS: Record<ConnectionState, string> = {
  not_configured: "Not configured", unverified: "Configured, unverified", verified: "Access verified", succeeded: "Last operation succeeded", unavailable: "Unavailable",
};
