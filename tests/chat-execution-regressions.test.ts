import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { runWorkspaceAgent, describeToolUse, type ChatEvent, type ChatConfiguration } from "../workbench/chat.js";
import { createChatMcpServer } from "../workbench/chat-mcp.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { createOperationLog, buildConnectionsDirectory } from "../workbench/connections-directory.js";

const context = () => ({ store: memoryStore(), audit: memoryAudit(),
  members: memoryMembers(["alice", "bob"].map(actor => ({ workspaceId: "one", actor, roles: ["author"] }))) });
const messages = (content: string) => [{ role: "user" as const, content }];
const model = { async invoke() { return { content: JSON.stringify({ type: "answer", content: "See the policy read." }) }; } };

test("server evidence does not claim the model chose a tool", async () => {
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "alice", messages("Use get_workspace_policy"), model,
    new AbortController().signal, event => events.push(event));
  const answer = events.find(event => event.type === "answer");
  assert.ok(answer?.type === "answer" && answer.evidence);
  assert.equal(answer.evidence.calls[0]!.initiatedBy, "server");
  assert.match(describeToolUse({ at: new Date().toISOString(), grounded: true, required: answer.evidence.required,
    calls: 1, modelCalls: 0 }), /Server supplied required reads.*model tool use not measured/);
});

test("explicit unavailable reads refuse before inference", async () => {
  let invoked = false;
  await assert.rejects(runWorkspaceAgent(context(), "one", "alice", messages("Use read_document"),
    { async invoke() { invoked = true; return { content: "" }; } }, new AbortController().signal, () => {}),
  /requested read tool is unavailable/);
  assert.equal(invoked, false);
});

test("membership revoked during inference withholds the answer", async () => {
  const ctx = context(); let member = true;
  ctx.members = { async rolesFor() { return member ? ["author"] : []; } };
  const events: ChatEvent[] = [];
  await assert.rejects(runWorkspaceAgent(ctx, "one", "alice", messages("Hello"),
    { async invoke() { member = false; return model.invoke(); } }, new AbortController().signal, event => events.push(event)),
  /Workspace membership is required/);
  assert.equal(events.some(event => event.type === "answer"), false);
});

test("personal connection operations stay private to their member", () => {
  const log = createOperationLog();
  log.record("one", "models:openai", false, "Alice's model failed", "alice");
  const directory = (actor: string) => buildConnectionsDirectory({ workspaceId: "one", actor, log,
    personal: [{ provider: "openai", models: ["example"] }] }).find(entry => entry.id === "models:openai")!;
  assert.equal(directory("alice").state, "unavailable");
  assert.equal(directory("bob").state, "verified");
  assert.equal(directory("bob").last, undefined);
});

test("chat uses its validated model choice without a second status lookup and isolates measurements", async t => {
  let listings = 0;
  const config: ChatConfiguration = { provider: "ollama", model: "tiny", loadModel: async () => model,
    modelOptions: async () => {
      listings++;
      return [{ id: "tiny", label: "tiny", provider: "ollama", local: true, available: true, detail: "" }];
    } };
  const server = createWorkbenchServer({ context: context(), assets: new Map(), chat: config,
    authenticate: async request => ["alice", "bob"].includes(request.headers.authorization ?? "")
      ? { workspaceId: "one", actor: request.headers.authorization! } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + "/api/chat", { method: "POST",
      headers: { Authorization: "alice", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages("Use get_workspace_policy") }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"type":"answer"/);
  }
  assert.equal(listings, 2, "connection logging must not repeat provider discovery");
  const alice = await (await fetch(base + "/api/chat/models", { headers: { Authorization: "alice" } })).text();
  const bob = await (await fetch(base + "/api/chat/models", { headers: { Authorization: "bob" } })).text();
  assert.match(alice, /Server supplied required reads/);
  assert.doesNotMatch(bob, /"measured":/);
});

test("MCP uses the configured budget, cancels inference, and releases its chat slot", async t => {
  let hang = true; let cancelled = false;
  const access = createChatAccess({ vault: memoryChatVault(), managedLogin: false, entitled: async () => false,
    base: { provider: "ollama", model: "tiny", loadModel: async () => ({
      async invoke(_prompt, options) {
        if (!hang) return { content: JSON.stringify({ type: "answer", content: "Hello" }) };
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("stopped")); }, { once: true });
        });
      },
    }) } });
  const server = createChatMcpServer(access, "one", "alice", async () => true, 100);
  const client = new Client({ name: "execution-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const first = await client.callTool({ name: "chat", arguments: { messages: messages("Hello") } });
  assert.equal(first.isError, true);
  assert.match(JSON.stringify(first), /0.1 second budget/);
  assert.equal(cancelled, true);
  hang = false;
  const second = await client.callTool({ name: "chat", arguments: { messages: messages("Hello") } });
  assert.notEqual(second.isError, true, JSON.stringify(second));
  assert.match(JSON.stringify(second), /Hello/);
});
