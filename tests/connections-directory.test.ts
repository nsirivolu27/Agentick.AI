import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";
import { buildConnectionsDirectory, createOperationLog, STATE_LABELS, type ConnectionEntry } from "../workbench/connections-directory.js";
import { createDocuments, memoryDocumentStore } from "../workbench/documents.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { createZenfluenceDirectory } from "../workbench/zenfluence.js";

/**
 * The Connections directory: one state per connector, from the runtimes' own
 * summaries and the last real operation, never from a saved key alone.
 */

const byId = (entries: ConnectionEntry[], id: string) => entries.find(entry => entry.id === id)!;

test("states follow the evidence: nothing, settings, a verified list, a succeeded or failed operation", () => {
  const log = createOperationLog();
  const empty = buildConnectionsDirectory({ workspaceId: "one", log });
  assert.equal(byId(empty, "models:local").state, "not_configured");
  assert.equal(byId(empty, "sources:zenfluence").state, "not_configured");
  assert.equal(byId(empty, "delivery:confluence").state, "not_configured"); assert.match(byId(empty, "delivery:confluence").detail, /Not implemented/);
  assert.equal(byId(empty, "identity:billing").state, "not_configured");

  const configured = buildConnectionsDirectory({ workspaceId: "one", log,
    models: { options: [{ id: "qwen", label: "qwen", provider: "Ollama", available: true, local: true, detail: "" }, { id: "gpt", label: "gpt", provider: "Azure", available: false, local: false, detail: "" }] },
    personal: [{ provider: "openai", models: ["gpt-4o-mini"] }],
    zenfluence: { configured: true, ready: false, site: "https://x.atlassian.net", project: "KAN", spaceId: "1", settings: { email: { name: "MAGENTIC_ATLASSIAN_EMAIL_X", configured: true }, token: { name: "MAGENTIC_ATLASSIAN_TOKEN_X", configured: false } } },
    documents: { count: 0 }, ontology: { mode: "foundry", ontology: "ops", objectTypes: 3 }, repository: null,
    jira: { mode: "preview", siteOrigin: "https://preview.invalid", total: 2, open: 1 }, automations: { units: 2, enabled: 0, actions: 0 },
    identity: { managed: true, actor: "user_1", roles: ["admin"] }, billing: { tier: "free" } });
  assert.equal(byId(configured, "models:local").state, "verified");
  assert.equal(byId(configured, "models:server").state, "unavailable");
  assert.equal(byId(configured, "models:openai").state, "verified"); assert.match(byId(configured, "models:openai").detail, /agents do not use it/);
  assert.equal(byId(configured, "models:anthropic").state, "not_configured");
  assert.equal(byId(configured, "sources:zenfluence").state, "unavailable"); assert.match(byId(configured, "sources:zenfluence").detail, /MAGENTIC_ATLASSIAN_TOKEN_X/);
  assert.equal(byId(configured, "sources:documents").state, "unverified");
  assert.equal(byId(configured, "sources:ontology").state, "unverified"); assert.match(byId(configured, "sources:ontology").detail, /waitlisted, so no live access is claimed/);
  assert.equal(byId(configured, "sources:repository").state, "not_configured");
  assert.equal(byId(configured, "delivery:jira").state, "unverified"); assert.match(byId(configured, "delivery:jira").detail, /Preview mode: 2 actions/);
  assert.equal(byId(configured, "delivery:automation").state, "unavailable");
  assert.equal(byId(configured, "identity:membership").state, "verified"); assert.match(byId(configured, "identity:membership").detail, /never from email domain or billing/);
  assert.equal(byId(configured, "identity:billing").state, "unverified");
  assert.doesNotMatch(JSON.stringify(configured), /sk-|token=|apiKey/);

  log.record("one", "sources:zenfluence", true, "read succeeded.");
  log.record("one", "models:local", false, "The model could not complete this request.");
  const operated = buildConnectionsDirectory({ workspaceId: "one", log, models: { options: [{ id: "qwen", label: "qwen", provider: "Ollama", available: true, local: true, detail: "" }] },
    zenfluence: { configured: true, ready: true, site: "https://x.atlassian.net", project: "KAN", spaceId: "1" } });
  assert.equal(byId(operated, "sources:zenfluence").state, "succeeded"); assert.equal(byId(operated, "sources:zenfluence").last?.ok, true);
  assert.equal(byId(operated, "models:local").state, "unavailable"); assert.match(byId(operated, "models:local").detail, /Last attempt failed/);
  assert.equal(byId(buildConnectionsDirectory({ workspaceId: "two", log }), "sources:zenfluence").state, "not_configured", "another workspace sees nothing of it");
  assert.equal(Object.keys(STATE_LABELS).length, 5);
});

test("the server builds the directory from its runtimes and records real operations", async t => {
  const workspaceId = "one";
  const zenfluence = createZenfluenceDirectory({ connections: [{ workspaceId, site: "https://example.atlassian.net", project: "KAN", spaceId: "123", emailSetting: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", tokenSetting: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY" }] },
    name => name.includes("EMAIL") ? "service@example.invalid" : "token",
    async () => Response.json({ key: "KAN-12", fields: { summary: "Build report", status: { name: "To Do" }, project: { key: "KAN" }, updated: "2026-11-01T00:00:00.000Z", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Spec." }] }] } } }));
  const documents = createDocuments({ store: memoryDocumentStore() });
  const context = { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId, actor: "owner", roles: ["admin", "author"] }]) };
  const server = createWorkbenchServer({ context, assets: new Map(), pipelines: memoryPipelines(), zenfluence, documents,
    chat: { provider: "ollama", model: "qwen", listModels: async () => ["qwen"], loadModel: async () => ({ async invoke() { return { content: "{}" }; } }) },
    authenticate: async request => request.headers.authorization === "owner" ? { workspaceId, actor: "owner" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const directory = async () => (await (await fetch(`${base}/api/connections`, { headers: { Authorization: "owner" } })).json() as { entries: ConnectionEntry[] }).entries;
  assert.equal((await fetch(`${base}/api/connections`)).status, 401);
  let entries = await directory();
  assert.equal(byId(entries, "models:local").state, "verified");
  assert.equal(byId(entries, "sources:zenfluence").state, "unverified");
  assert.equal(byId(entries, "sources:documents").state, "unverified");
  assert.equal(byId(entries, "identity:membership").state, "not_configured", "a local session is not company membership");
  assert.match(byId(entries, "sources:mcp").detail, /8 read tools/);

  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { Authorization: "owner", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/zenfluence", { action: "read", source: { kind: "jira", id: "KAN-12" } })).status, 200);
  assert.equal((await post("/api/documents", { action: "add_document", title: "Runbook", text: "Check the source before handoff." })).status, 200);
  entries = await directory();
  assert.equal(byId(entries, "sources:zenfluence").state, "succeeded"); assert.match(byId(entries, "sources:zenfluence").last!.detail, /read succeeded/);
  assert.equal(byId(entries, "sources:documents").state, "succeeded"); assert.match(byId(entries, "sources:documents").detail, /1 documents saved/);

  const page = chatConnectionsPage(undefined, undefined, undefined, { models: [], loading: false, demo: true }, { entries }).body;
  assert.match(page, /Connections directory/); assert.match(page, /Jira and Confluence \(Zenfluence\)/); assert.match(page, /Last operation succeeded/);
  assert.match(page, /data-connections-refresh/);
  assert.match(chatConnectionsPage(undefined, undefined, undefined, { models: [], loading: false, demo: true }, { error: "The connections directory could not be loaded. Refresh to retry." }).body, /role="alert"/);
});
