import type { ChatAccessSummary } from "./chat-access.js";
import type { ChatModelOption } from "./chat.js";
import type { Page } from "./studio-view.js";
import { status, type Tone } from "./ui.js";
import { integrationGuide } from "./integration-guide.js";
import { STATE_LABELS, type ConnectionEntry, type ConnectionGroup, type ConnectionState } from "./connections-directory.js";

/** The directory: four groups, one card per connector, one state each. Setup forms live on the connector's own page. */
export function connectionsDirectory(entries: ConnectionEntry[] | undefined, error?: string, loading?: boolean): string {
  const groups: { id: ConnectionGroup; title: string; blurb: string }[] = [
    { id: "models", title: "Models", blurb: "Model access and recent requests." },
    { id: "sources", title: "Company sources", blurb: "Documents and tools agents may read." },
    { id: "delivery", title: "Approved delivery", blurb: "Reviewed actions and delivery receipts." },
    { id: "identity", title: "Identity and billing", blurb: "Sign-in, membership and plans." },
  ];
  const tone: Record<ConnectionState, Tone> = { not_configured: "neutral", unverified: "warn", verified: "ok", succeeded: "ok", unavailable: "bad" };
  const head = `<div class="provider-head"><h2 id="connections-directory">Connections directory</h2><button class="secondary" data-connections-refresh ${loading ? "disabled" : ""}>${loading ? "Checking…" : "Refresh status"}</button></div>`;
  if (error) return `<section class="panel account-panel" aria-labelledby="connections-directory">${head}<p role="alert">${escape(error)}</p></section>`;
  if (!entries) return `<section class="panel account-panel" aria-labelledby="connections-directory">${head}<p role="status">Checking each connection…</p></section>`;
  return `<section class="panel account-panel connections-directory" aria-labelledby="connections-directory">${head}
    <p class="text-3">Expand a group to inspect access and recent activity. Verified access is not a successful model run.</p>
    <div class="connection-groups">${groups.map(group => {
      const rows = entries.filter(entry => entry.group === group.id);
      if (!rows.length) return "";
      const issues = rows.filter(entry => entry.state === "unavailable").length;
      const verified = rows.filter(entry => entry.state === "verified" || entry.state === "succeeded").length;
      return `<details class="connection-group">
        <summary><span><strong>${group.title}</strong><small>${group.blurb}</small></span><span class="connection-group-count">${issues ? status("bad", `${issues} need attention`) : `${verified} / ${rows.length} verified`}</span></summary>
        <ul class="agent-readiness">${rows.map(entry => `<li class="connection-row" data-connection="${escape(entry.id)}"><div><div class="connection-row-title"><strong>${escape(entry.name)}</strong>${status(tone[entry.state], STATE_LABELS[entry.state])}</div><span class="connection-caps">${entry.read ? "Read" : ""}${entry.read && entry.write ? " · " : ""}${entry.write ? "Reviewed write" : ""}</span><small>${escape(entry.detail)}</small>${entry.last ? `<small class="text-3">Last operation ${escape(entry.last.at.slice(0, 16).replace("T", " "))}: ${entry.last.ok ? "succeeded" : "failed"} · ${escape(entry.last.detail)}</small>` : ""}</div><a class="secondary small" aria-label="Open ${escape(entry.name)}" href="${escape(entry.href)}">Open</a></li>`).join("")}</ul>
      </details>`;
    }).join("")}</div>
  </section>`;
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export interface ConnectionFeedback {
  provider: string;
  /** Which connection the feedback is about; personal when absent. */
  scope?: "personal" | "workspace";
  state: "verifying" | "error";
  message?: string;
  models: string[];
}
type Saved = NonNullable<ChatAccessSummary["workspaceConnections"]>[number];
const WORKSPACE_PROVIDERS = [{ id: "anthropic", name: "Claude", url: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", url: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Gemini", url: "https://aistudio.google.com/apikey" }];

/** A workspace connection card. Four states: Not configured, Connected (saved, not re-tested), Verified (the harmless model list read succeeded) and Failed. */
function workspaceCard(provider: typeof WORKSPACE_PROVIDERS[number], connected: Saved | undefined, update: ConnectionFeedback | undefined, canEdit: boolean): string {
  const state = update?.state ?? (connected ? connected.state ?? "connected" : "disconnected");
  const models = update?.models ?? connected?.models ?? [];
  const labels: Record<typeof state, string> = { verifying: "Verifying", error: "Update failed", disconnected: "Not configured", connected: "Connected, not verified", verified: "Verified", failed: "Failed" };
  const tones: Record<typeof state, Tone> = { verifying: "progress", error: "bad", disconnected: "neutral", connected: "warn", verified: "ok", failed: "bad" };
  const busy = update?.state === "verifying";
  const when = connected?.verifiedAt ? ` · ${escape(connected.verifiedAt.slice(0, 16).replace("T", " "))}` : "";
  return `<article class="workspace-card ${state}" aria-labelledby="provider-workspace-${provider.id}" aria-busy="${busy}">
    <div class="provider-head"><h3 id="provider-workspace-${provider.id}">${provider.name}</h3>${status(tones[state], labels[state] + (state === "verified" ? when : ""))}</div>
    ${connected ? `<p class="provider-models">${connected.models.map(model => `<span>${escape(model)}</span>`).join("")}</p><p class="provider-note">Agents, stages and members in this workspace use it as <code>workspace/${escape(provider.id)}/&lt;model&gt;</code>; the provider bills the workspace account.${provider.id === "anthropic" ? " Claude calls the workspace read tools natively; every call still runs through the read only session and its limits." : ""}</p>` : `<p>${canEdit ? "Add an API key and text model IDs for the workspace." : "Not connected. An administrator can connect this provider for the workspace."}</p>`}
    ${connected?.lastError ? `<p class="provider-error" role="alert">Last verification failed: ${escape(connected.lastError)}</p>` : ""}
    ${update?.state === "error" ? `<p class="provider-error" role="alert">${escape(update.message ?? "Could not update this connection. Try again.")}${connected ? " Previously saved models are shown. Test the connection to confirm access." : ""}</p>` : ""}
    ${busy ? '<p role="status">Checking API access…</p>' : ""}
    <div class="provider-actions">${connected ? `<a class="secondary" href="#/agent-studio">Assign in Agent Studio</a>${canEdit ? `<button class="secondary" data-provider-verify="${provider.id}" data-scope="workspace" ${busy ? "disabled" : ""}>Test connection</button>` : ""}` : canEdit ? `<a href="${provider.url}" target="_blank" rel="noreferrer">Get API key ↗</a>` : ""}</div>
    ${canEdit ? `<details name="workspace-setup" ${update ? "open" : ""}><summary>${connected ? "Replace or remove" : "Connect"}</summary>
      <form data-provider-connect="${provider.id}" data-scope="workspace"><label>API key<input type="password" name="apiKey" autocomplete="off" required maxlength="4096" ${busy ? "disabled" : ""}></label><label>Model IDs<input name="models" required maxlength="3000" placeholder="Model IDs, separated by commas" value="${escape(models.join(", "))}" ${busy ? "disabled" : ""}></label><small>Text models only. Saving verifies the key against the provider's model list; it does not run inference.</small><button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Verifying…" : "Verify & save"}</button></form>
      ${connected ? `<div class="provider-actions"><a href="${provider.url}" target="_blank" rel="noreferrer">Provider console ↗</a><button class="secondary" data-provider-disconnect="${provider.id}" data-scope="workspace" ${busy ? "disabled" : ""}>Disconnect</button></div>` : ""}
    </details>` : ""}</article>`;
}

export function chatConnectionsPage(access?: ChatAccessSummary, error?: string, feedback?: ConnectionFeedback, server?: { models: ChatModelOption[]; loading: boolean; error?: string; demo?: boolean },
  directory?: { entries?: ConnectionEntry[]; error?: string; loading?: boolean }, viewer?: { admin: boolean; origin?: string }): Page {
  const admin = viewer?.admin ?? false;
  const origin = viewer?.origin ?? "https://<this server>";
  const workspaceFeedback = feedback?.scope === "workspace" ? feedback : undefined;
  const directoryHtml = directory ? connectionsDirectory(directory.entries, directory.error, directory.loading) : "";
  const help = `<details class="connection-help"><summary>Setup guide &amp; API reference</summary>${integrationGuide(access)}</details>`;
  if (!access && server?.demo) return { title: "Connections", body: '<section class="panel account-panel"><h2>Demo connections</h2><p>This demo does not store provider credentials. Use the local or company server to connect real API accounts.</p><a href="#/base-chat">Open demo chat</a></section>' + directoryHtml + help };
  if (!access) return { title: "Connections", body: `<section class="panel account-panel"><p role="status">${escape(error ?? "Loading your connections…")}</p><button class="secondary" data-chat-access-refresh>Retry</button></section>` + directoryHtml + help };
  const providers = [{ id: "openai", name: "OpenAI", url: "https://platform.openai.com/api-keys" },
    { id: "anthropic", name: "Claude", url: "https://console.anthropic.com/settings/keys" },
    { id: "google", name: "Gemini", url: "https://aistudio.google.com/apikey" }];
  // At a glance: the two scopes side by side, counted from saved state only. Verified means the model list read passed, nothing more.
  const workspaceSaved = access.workspaceConnections ?? [];
  const workspaceVerified = workspaceSaved.filter(item => item.state === "verified").length;
  const workspaceFailed = workspaceSaved.filter(item => item.state === "failed").length;
  const serverAvailable = (server?.models ?? []).filter(model => model.available && !model.id.startsWith("personal/") && !model.id.startsWith("workspace/")).length;
  const glance = `<section class="panel account-panel connection-glance" aria-label="Connections at a glance"><div class="scope-workspace"><span class="scope-kicker">Workspace · used by agents</span><strong>${workspaceSaved.length} of ${WORKSPACE_PROVIDERS.length} providers connected</strong><small>${workspaceVerified} verified${workspaceFailed ? ` · ${status("bad", `${workspaceFailed} failed`)}` : ""} · ${server?.loading ? "server models being checked" : `${serverAvailable} server model${serverAvailable === 1 ? "" : "s"} available`}</small><small>${admin ? "You administer these." : "An administrator manages these."} Verified means the model list read passed; it is not a successful run.</small></div><div class="scope-personal"><span class="scope-kicker">Personal · your chat only</span><strong>${access.connections.length} of ${providers.length} providers connected</strong><small>Never used by agents or other members. Charges are yours.</small><small>Signing in with an email, or a consumer chatbot subscription, does not supply API access; an API key does.</small></div></section>`;
  return { title: "Connections", context: "Status first, then setup. Workspace connections serve agents; personal accounts serve only your chat.", actions: '<a class="primary" href="#/base-chat">Back to chat</a>', body: `
    ${error ? `<p role="alert">${escape(error)}</p>` : ""}
    ${glance}
    ${directoryHtml}
    <section class="panel account-panel scope-panel scope-workspace" aria-labelledby="server-models-title"><div class="provider-head"><div><span class="scope-kicker">Workspace · shared with agents, stages and members</span><h2 id="server-models-title">Server models</h2></div><button class="secondary" data-refresh-models ${server?.loading ? "disabled" : ""}>${server?.loading ? "Checking models…" : "Refresh models"}</button></div>
      <p>Agents use server models, not your personal keys. Listed means reachable; a grounded run is the only proof of tool use.</p>
      ${server?.error ? `<p role="status">${escape(server.error)}</p>` : ""}
      ${server?.loading ? '<p role="status">Checking model service availability…</p>' : server?.models.length ? `<ul class="agent-readiness">${server.models.filter(model => !model.id.startsWith("personal/")).map(model => `<li><div><strong>${escape(model.label)}</strong> · ${escape(model.provider)} ${status(model.available ? "ok" : "warn", model.available ? "Configured" : "Unavailable")}<small>${escape(model.detail)}</small></div></li>`).join("")}</ul>` : '<p class="text-2">No server models have been listed yet. Refresh to check the connection.</p>'}
      <details><summary>Ollama and API setup</summary><p>Run <code>corepack pnpm start:local</code> after installing dependencies. Local startup detects an installed Ollama chat model and remembers it. Install Ollama and a model once; this app never downloads one automatically.</p><p>The normal local launcher keeps connections outside the checkout, so restarts and another clone on the same machine reuse them. Development mode uses its own data directory. Another machine needs its own setup.</p><p>To override automatic selection, set <code>MAGENTIC_LLM_PROVIDER</code>, <code>MAGENTIC_LLM_BASE_URL</code> and <code>MAGENTIC_LLM_CHAT_MODEL</code>. Ollama must be reachable from the application server; loopback refers to that server, not to your laptop.</p><p>API-only setups do not need Ollama. Store provider keys as server secrets and set the corresponding <code>MAGENTIC_OPENAI_MODELS</code>, <code>MAGENTIC_ANTHROPIC_MODELS</code> or <code>MAGENTIC_GOOGLE_MODELS</code> to model IDs your account supports. Azure and compatible gateways use their existing server settings.</p><p>Configured access is not an inference health check. A provider may still reject a model request.</p></details>
    </section>
    <section class="panel account-panel connection-accounts workspace-connections scope-panel scope-workspace" aria-labelledby="workspace-connections-title"><div class="provider-head"><div><span class="scope-kicker">Workspace · shared with agents, stages and members</span><h2 id="workspace-connections-title">Workspace connections</h2></div></div>
      <p>${admin ? "One key per provider for the whole workspace. Choose its model in Agent Studio to assign it to an agent; members may pick it in Chat. The provider bills the workspace account." : "Models an administrator connected for this workspace. Choose one in Agent Studio or Chat."}</p>
      <div class="provider-cards">${WORKSPACE_PROVIDERS.map(provider => workspaceCard(provider, access.workspaceConnections?.find(item => item.provider === provider.id), workspaceFeedback?.provider === provider.id ? workspaceFeedback : undefined, admin)).join("")}</div>
      <details><summary>How agents use a workspace connection</summary><p>Open <a href="#/agent-studio">Agent Studio</a> and choose a model labelled "workspace connection" for the agent, then assign the agent to a stage as usual. The agent keeps its own tool grants; the connection only supplies the model. Disconnecting stops new agent runs on it at once. Test connection repeats the harmless model list read with the saved key; a saved key alone shows as Connected, not Verified.</p></details>
    </section>
    <section class="panel account-panel connection-accounts scope-panel scope-personal" aria-labelledby="personal-accounts-title"><div class="provider-head"><div><span class="scope-kicker">Personal · your chat only, never agents</span><h2 id="personal-accounts-title">Your chat accounts</h2></div><button class="secondary" data-chat-access-refresh>Refresh connections</button></div><p>Your own key, private to you in this workspace. Choose its model in Chat. Provider charges are yours.</p>
      <div class="provider-cards">${providers.map(provider => {
        const connected = access.connections.find(item => item.provider === provider.id);
        const update = feedback?.provider === provider.id && (feedback.scope ?? "personal") === "personal" ? feedback : undefined;
        const state = update?.state ?? (connected ? "connected" : "disconnected");
        const models = update?.models ?? connected?.models ?? [];
        const label = state === "verifying" ? "Verifying" : state === "error" ? "Update failed" : connected ? "Connected" : "Not connected";
        const tone = state === "verifying" ? "progress" : state === "error" ? "bad" : connected ? "ok" : "neutral";
        // A saved key is not a health check; keep the last saved models visible after a failed replacement.
        return `<article class="provider-card ${state}" aria-labelledby="provider-${provider.id}" aria-busy="${state === "verifying"}">
          <div class="provider-head"><h3 id="provider-${provider.id}">${provider.name}</h3>${status(tone, label)}</div>
          ${connected ? `<p class="provider-models">${connected.models.map(model => `<span>${escape(model)}</span>`).join("")}</p><p class="provider-note">Saved API access · model availability may change.</p>` : '<p>Add your API key and text model IDs.</p>'}
          ${update?.state === "error" ? `<p class="provider-error" role="alert">${escape(update.message ?? "Could not update this connection. Try again.")}${connected ? " Previously saved models are shown. Refresh to confirm access." : ""}</p>` : ""}
          ${state === "verifying" ? '<p role="status">Checking API access…</p>' : ""}
          <div class="provider-actions">${connected ? '<a class="secondary" href="#/base-chat">Open chat</a>' : `<a href="${provider.url}" target="_blank" rel="noreferrer">Get API key ↗</a>`}</div>
          <details name="provider-setup" ${update ? "open" : ""}><summary>${connected ? "Manage connection" : "Connect"}</summary>
            <form data-provider-connect="${provider.id}"><label>API key<input type="password" name="apiKey" autocomplete="off" required maxlength="4096" ${feedback?.state === "verifying" ? "disabled" : ""}></label><label>Model IDs<input name="models" required maxlength="3000" placeholder="Model IDs, separated by commas" value="${escape(models.join(", "))}" ${feedback?.state === "verifying" ? "disabled" : ""}></label><small>Text models only. Verification checks access, not inference.</small><button class="primary" type="submit" ${feedback?.state === "verifying" ? "disabled" : ""}>${state === "verifying" ? "Verifying…" : "Verify & save"}</button></form>
            ${connected ? `<div class="provider-actions"><a href="${provider.url}" target="_blank" rel="noreferrer">Provider console ↗</a><button class="secondary" data-provider-disconnect="${provider.id}" ${feedback?.state === "verifying" ? "disabled" : ""}>Disconnect</button></div>` : ""}
          </details></article>`;
      }).join("")}</div>
      <details><summary>Connection details</summary><p>Keys stay encrypted on this server and private to your workspace account. Provider sign-in requires separate authorization.</p><p>An administrator can configure Azure or a compatible gateway.</p></details>
    </section>
    <section class="panel account-panel scope-panel scope-personal" aria-labelledby="mcp-access-title"><div class="provider-head"><div><span class="scope-kicker">Personal · a credential for an MCP app</span><h2 id="mcp-access-title">MCP access</h2></div></div><p>${access.mcp.active ? `Credential active until ${escape(access.mcp.expiresAt ?? "")}.` : "No active chat credential."}</p>
      <details><summary>Connect an app</summary><p>A trusted app can use your models and allowance for seven days. Requests may send conversations to providers and incur charges. A new credential replaces the previous one.</p><button class="secondary" data-chat-token="issue">Create 7-day credential</button>${access.mcp.active ? '<button class="secondary" data-chat-token="revoke">Revoke access</button>' : ""}<div id="chat-token-result"></div></details>
      <details><summary>Connect Claude Code or another MCP client</summary><p>After creating a credential, register this server as an HTTP MCP server. Claude Code (terminal):</p><pre class="pre">claude mcp add --transport http agentick ${escape(origin)}/api/chat-mcp --header "Authorization: Bearer &lt;credential&gt;"</pre><p>Clients that take a JSON configuration use the same address and header. Paste the credential into the client only, never into a conversation. The server offers <code>list_chat_models</code> and <code>chat</code>; the chat tool sends your conversation to the chosen provider and can incur charges.</p><p>Claude Desktop connectors require a reachable HTTPS address with OAuth sign-in, which this server does not provide; use Claude Code or a client that accepts a bearer header.</p></details>
      <details><summary>Technical details</summary><p>Streamable HTTP: <code>/api/chat-mcp</code>. Tools: <code>list_chat_models</code>, <code>chat</code>.</p><p>Local clients only unless you deploy a reachable server. Client support varies.</p></details>
    </section>
    ${help}
    <details class="panel account-panel connection-plans"><summary>Plans &amp; company access</summary>
    <div class="chat-plan-grid">
      <section class="panel account-panel"><span class="chat-plan-status">${access.tier === "free" ? "CURRENT PLAN" : "ALWAYS AVAILABLE"}</span><h2>Free · Your connections</h2><p>Your models. Provider charges apply.</p></section>
      <section class="panel account-panel"><span class="chat-plan-status">${access.tier === "paid" && access.plan !== "max" ? "CURRENT PLAN" : access.managedReady ? "PAID PLAN" : "SETUP NEEDED"}</span><h2>Pro</h2><p>Managed models. Auto routing.</p><a href="#/account">${access.tier === "paid" ? "Manage plan" : "View plan"}</a>${access.dailyTokens && access.plan !== "max" ? `<p>${access.accountedTokens.toLocaleString("en-US")} / ${access.dailyTokens.toLocaleString("en-US")} workspace tokens today.</p><details><summary>Usage details</summary><p>Failed or unmetered calls retain a reservation. This allowance is not an invoice.</p></details>` : ""}</section>
      <section class="panel account-panel"><span class="chat-plan-status">${access.plan === "max" ? "CURRENT PLAN" : access.managedReady ? "PLAN OPTION" : "SETUP NEEDED"}</span><h2>Max</h2><p>Custom model pool and allowance.</p><a href="#/account">View plans</a>${access.plan === "max" && access.dailyTokens ? `<p>${access.accountedTokens.toLocaleString("en-US")} / ${access.dailyTokens.toLocaleString("en-US")} tokens accounted today.</p>` : ""}</section>
    </div>
    <section class="panel account-panel"><details><summary>Company access</summary><p>Company SSO and model routing need administrator setup. Email alone does not grant access.</p><a href="/login?next=chat">Workspace sign-in</a></details></section>
    </details>
` };
}
