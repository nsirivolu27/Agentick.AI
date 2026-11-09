import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { createChatAccess, type ChatAccessSummary } from "../workbench/chat-access.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import type { ChatConfiguration } from "../workbench/chat.js";
import { buildConnectionsDirectory, createOperationLog, type ConnectionEntry } from "../workbench/connections-directory.js";
import { createWorkbenchServer } from "../workbench/server.js";

/**
 * Workspace model connections: an administrator connects a provider for the
 * workspace's agents through the same vault and the same harmless model list
 * read. A saved key is Connected; a repeated read makes it Verified or Failed.
 * Agents resolve the connection through a catalog bound to their workspace,
 * so another workspace cannot load it, and no response ever carries the key.
 */

const SECRET = "sk-ant-test-only-secret-0000";
const anthropicRequest = (behaviour: () => "ok" | "down" | "forbidden") => async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  if (target.includes("/v1/models")) {
    const mode = behaviour();
    if (mode === "down") throw new Error("ECONNREFUSED");
    if (mode === "forbidden") return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], SECRET);
    return Response.json({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }], has_more: false });
  }
  assert.ok(target.includes("/v1/messages"));
  return Response.json({ content: [{ type: "text", text: JSON.stringify({ type: "answer", content: "Grounded answer." }) }], usage: { input_tokens: 10, output_tokens: 4 } });
};
const base: ChatConfiguration = { provider: "ollama", model: "local-fixture", modelOptions: async () => [{ id: "local-fixture", label: "local-fixture", provider: "Ollama", available: true, local: true, detail: "" }],
  loadModel: async () => ({ invoke: async () => ({ content: "Local fixture" }) }) };

test("a workspace connection is verified on save, re-tested on demand, bound to its workspace, and never echoed", async () => {
  let mode: "ok" | "down" | "forbidden" = "forbidden";
  const access = createChatAccess({ vault: memoryChatVault(), base, managedLogin: false, entitled: async () => "free", request: anthropicRequest(() => mode) });
  // Wrong key: nothing is saved and the message names no secret.
  await assert.rejects(access.connect("acme", "admin", { action: "connect", scope: "workspace", provider: "anthropic", apiKey: "sk-ant-wrong-key-000000", models: ["claude-sonnet-4-5"] }),
    error => error instanceof Error && /Check the API key/.test(error.message) && !/wrong-key/.test(error.message));
  assert.deepEqual((await access.summary("acme", "admin")).workspaceConnections, []);
  mode = "ok";
  await access.connect("acme", "admin", { action: "connect", scope: "workspace", provider: "anthropic", apiKey: SECRET, models: ["claude-sonnet-4-5"] });
  const summary = await access.summary("acme", "member");
  assert.equal(summary.workspaceConnections?.[0]?.provider, "anthropic"); assert.equal(summary.workspaceConnections?.[0]?.state, "verified");
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(SECRET.slice(0, 12)));

  // Agents see the connection through the workspace bound catalog; a member's chat catalog sees it too; another workspace does not.
  const agentCatalog = await access.agentConfiguration().forWorkspace!("acme");
  const ids = (await agentCatalog.modelOptions!()).map(option => option.id);
  assert.ok(ids.includes("workspace/anthropic/claude-sonnet-4-5")); assert.ok(!ids.some(id => id.startsWith("personal/")));
  const chatIds = (await (await access.configuration("acme", "member")).modelOptions!()).map(option => option.id);
  assert.ok(chatIds.includes("workspace/anthropic/claude-sonnet-4-5"));
  const other = await access.agentConfiguration().forWorkspace!("globex");
  assert.ok(!(await other.modelOptions!()).some(option => option.id.startsWith("workspace/")));
  await assert.rejects(other.loadModel("workspace/anthropic/claude-sonnet-4-5"), /not available/);
  const model = await agentCatalog.loadModel("workspace/anthropic/claude-sonnet-4-5");
  assert.equal(JSON.parse(String((await model.invoke("hello")).content)).content, "Grounded answer.");

  // Provider down: Test connection records Failed, keeps the key, and stops new loads until it passes again.
  mode = "down";
  await assert.rejects(access.connect("acme", "admin", { action: "verify", scope: "workspace", provider: "anthropic" }), /Check the API key and account access/);
  assert.equal((await access.summary("acme", "admin")).workspaceConnections?.[0]?.state, "failed");
  await assert.rejects(model.invoke("again"), /removed or changed/);
  await assert.rejects((await access.agentConfiguration().forWorkspace!("acme")).loadModel("workspace/anthropic/claude-sonnet-4-5"), /not available/);
  mode = "ok";
  await access.connect("acme", "admin", { action: "verify", scope: "workspace", provider: "anthropic" });
  assert.equal((await access.summary("acme", "admin")).workspaceConnections?.[0]?.state, "verified");
  // Disconnect revokes an already loaded model.
  const loaded = await (await access.agentConfiguration().forWorkspace!("acme")).loadModel("workspace/anthropic/claude-sonnet-4-5");
  await access.connect("acme", "admin", { action: "disconnect", scope: "workspace", provider: "anthropic" });
  await assert.rejects(loaded.invoke("hello"), /removed or changed/);
  assert.deepEqual((await access.summary("acme", "admin")).workspaceConnections, []);
  await assert.rejects(access.connect("acme", "admin", { action: "verify", scope: "workspace", provider: "anthropic" }), /not connected/);
});

test("only an administrator manages workspace connections over HTTP, the directory reflects the state, and a revoked admin is refused", async t => {
  let adminRole = ["admin", "author"];
  const access = createChatAccess({ vault: memoryChatVault(), base, managedLogin: false, entitled: async () => "free", request: anthropicRequest(() => "ok") });
  const context = { store: memoryStore(), audit: memoryAudit(), members: { async rolesFor(workspace: string, actor: string) { return workspace === "acme" ? (actor === "admin" ? adminRole : actor === "member" ? ["author"] : []) as ("admin" | "author")[] : []; } } };
  const server = createWorkbenchServer({ context, assets: new Map(), chat: base, chatAccess: access,
    authenticate: async request => request.headers.authorization ? { workspaceId: "acme", actor: String(request.headers.authorization) } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base_ = `http://127.0.0.1:${address.port}`;
  const post = (actor: string, body: unknown) => fetch(`${base_}/api/chat/connections`, { method: "POST", headers: { Authorization: actor, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const connect = { action: "connect", scope: "workspace", provider: "anthropic", apiKey: SECRET, models: ["claude-haiku-4-5"] };
  assert.equal((await post("member", connect)).status, 403, "a member cannot connect for the workspace");
  const saved = await post("admin", connect);
  assert.equal(saved.status, 200);
  const body = await saved.text();
  assert.doesNotMatch(body, new RegExp(SECRET.slice(0, 12))); assert.match(body, /"workspaceConnections":\[\{"provider":"anthropic"/);
  const directory = await (await fetch(`${base_}/api/connections`, { headers: { Authorization: "member" } })).json() as { entries: ConnectionEntry[] };
  const entry = directory.entries.find(item => item.id === "models:workspace:anthropic")!;
  assert.equal(entry.state, "succeeded"); assert.match(entry.detail, /claude-haiku-4-5 available to agents/);
  assert.doesNotMatch(JSON.stringify(directory), new RegExp(SECRET.slice(0, 12)));
  const studio = await (await fetch(`${base_}/api/agent-studio/models`, { headers: { Authorization: "member" } })).json() as { models: string[] };
  assert.ok(studio.models.includes("workspace/anthropic/claude-haiku-4-5"), "Agent Studio offers the workspace model");
  adminRole = ["author"];
  assert.equal((await post("admin", { action: "verify", scope: "workspace", provider: "anthropic" })).status, 403, "a revoked admin cannot test or change it");
  assert.equal((await post("admin", { action: "connect", provider: "openai", apiKey: "sk-personal-test-0000", models: ["x"] })).status, 400, "personal connections stay open to members and still verify");
  const page = chatConnectionsPage(await access.summary("acme", "member"), undefined, undefined, { models: [], loading: false }, undefined, { admin: false }).body;
  assert.match(page, /Workspace connections/); assert.match(page, /Verified · /); assert.doesNotMatch(page, /data-provider-connect="anthropic" data-scope="workspace"/);
  const adminPage = chatConnectionsPage(await access.summary("acme", "admin"), undefined, undefined, { models: [], loading: false }, undefined, { admin: true }).body;
  assert.match(adminPage, /data-provider-verify="anthropic" data-scope="workspace"/); assert.match(adminPage, /data-provider-connect="anthropic" data-scope="workspace"/);
  assert.doesNotMatch(adminPage, new RegExp(SECRET.slice(0, 12)));
  const states = buildConnectionsDirectory({ workspaceId: "acme", log: createOperationLog(), workspaceConnections: [{ provider: "openai", models: ["gpt-4o-mini"], state: "connected" }] });
  assert.equal(states.find(item => item.id === "models:workspace:openai")!.state, "unverified");
  const summary: ChatAccessSummary = await access.summary("acme", "admin");
  assert.equal(summary.connections.length, 0);
});
