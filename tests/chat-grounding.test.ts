import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { chatTimeoutMs, describeToolUse, runWorkspaceAgent, type AgentModel, type ChatEvent } from "../workbench/chat.js";
import { evidenceOf, outstandingReads, requiredReads, unreadMessage } from "../workbench/chat-grounding.js";
import { chatView, emptyChat, type ChatTurn } from "../workbench/chat-view.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";

/**
 * Grounded execution: the reads a question requires are decided from the
 * request, made before the model answers, and an answer that skips them is a
 * refusal with the reason. Every accepted answer carries its evidence, and
 * the request budget is one number shared by browser, server and tools.
 */

function context() {
  return { store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([{ workspaceId: "one", actor: "writer", roles: ["author"] }]) };
}
const tools = [
  { name: "get_workspace_policy", inputSchema: { type: "object", properties: {} } },
  { name: "get_approved_agent", inputSchema: { type: "object", properties: { name: {} }, required: ["name"] } },
  { name: "get_pipeline", inputSchema: {} },
  { name: "list_approved_agents", inputSchema: {} },
];
function scripted(steps: unknown[]): AgentModel & { prompts: string[] } {
  const model = { prompts: [] as string[], async invoke(prompt: string) { model.prompts.push(prompt); const step = steps.shift(); assert.ok(step, "No model step remains."); return { content: JSON.stringify(step) }; } };
  return model;
}
const ask = (content: string) => [{ role: "user" as const, content }];

test("required reads come from the request: named tools, workspace topics, offered tools only, at most three", () => {
  assert.deepEqual(requiredReads("Use get_workspace_policy to tell me the required approval count. Do not change anything.", tools),
    [{ name: "get_workspace_policy", arguments: {}, reason: "named" }]);
  assert.deepEqual(requiredReads("What does get_approved_agent say about reader?", tools), [{ name: "get_approved_agent", reason: "named" }]);
  assert.deepEqual(requiredReads("How many approvals does a handoff need?", tools).map(item => item.name), ["get_pipeline", "get_workspace_policy"]);
  assert.deepEqual(requiredReads("Which agents are approved here?", tools).map(item => item.name), ["list_approved_agents"]);
  assert.deepEqual(requiredReads("Help me write an email.", tools), []);
  assert.deepEqual(requiredReads("Explain our workflow.", [tools[0]!]), [], "a topic without its tool requires nothing");
  const calls = [evidenceOf("get_workspace_policy", {}, { content: [] }), evidenceOf("get_pipeline", {}, { isError: true, content: [] })];
  assert.deepEqual(outstandingReads(requiredReads("approvals and pipeline", tools), calls).map(item => item.name), ["get_pipeline"]);
  assert.match(unreadMessage([{ name: "get_pipeline", reason: "topic" }, { name: "list_approved_agents", reason: "topic" }], calls), /get_pipeline failed; the model answered without reading list_approved_agents/);
  assert.equal(calls[0]!.resultHash.length, 64); assert.equal(calls[1]!.isError, true);
});

test("a named zero argument tool is read before the model speaks, and the answer carries the evidence", async () => {
  const model = scripted([{ type: "answer", content: "Two approvals are required (get_workspace_policy)." }]);
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "writer", ask("Use get_workspace_policy to tell me the required approval count. Do not change anything."), model, new AbortController().signal, event => events.push(event));
  assert.deepEqual(events.filter(event => event.type === "tool").map(event => `${event.name}:${event.state}`), ["get_workspace_policy:running", "get_workspace_policy:done"]);
  assert.equal(model.prompts.length, 1);
  assert.match(model.prompts[0]!, /requiredApprovals/); assert.match(model.prompts[0]!, /Every fact about this workspace in your answer must come from OBSERVATIONS/);
  const answer = events.at(-1); assert.ok(answer && answer.type === "answer" && answer.evidence);
  assert.deepEqual(answer.evidence.required, ["get_workspace_policy"]); assert.equal(answer.evidence.grounded, true);
  assert.equal(answer.evidence.calls.length, 1); assert.equal(answer.evidence.calls[0]!.tool, "get_workspace_policy"); assert.equal(answer.evidence.calls[0]!.isError, false);
});

test("an answer given before a required read with arguments is corrected once, then refused with the reason", async () => {
  const corrected = scripted([{ type: "answer", content: "reader does X" }, { type: "tool", name: "get_approved_agent", arguments: { name: "reader" } }, { type: "answer", content: "reader is not available." }]);
  const events: ChatEvent[] = [];
  // The read fails (no such approved agent), so even the corrected answer is refused: a failed required read is not evidence.
  await assert.rejects(runWorkspaceAgent(context(), "one", "writer", ask("Use get_approved_agent for reader and summarize it."), corrected, new AbortController().signal, event => events.push(event)),
    /No answer was accepted: the required read get_approved_agent failed/);
  assert.ok(events.some(event => event.type === "thinking" && /answered before reading get_approved_agent/.test(event.message)));
  assert.match(corrected.prompts[1]!, /REQUIRED READS BEFORE ANSWERING: get_approved_agent/);
  assert.ok(events.some(event => event.type === "tool" && event.name === "get_approved_agent" && event.state === "failed"));

  const stubborn = scripted([{ type: "answer", content: "3" }, { type: "answer", content: "3" }]);
  const refused: ChatEvent[] = [];
  await assert.rejects(runWorkspaceAgent(context(), "one", "writer", ask("What does get_approved_agent say about reader?"), stubborn, new AbortController().signal, event => refused.push(event)),
    /No answer was accepted: the model answered without reading get_approved_agent/);
  assert.ok(!refused.some(event => event.type === "answer"), "a guess never reaches the person as an answer");
});

test("the server passes the refusal through, records measured tool use per model, and shares one budget", async t => {
  const steps = [{ type: "answer", content: "3" }, { type: "answer", content: "3" }, { type: "answer", content: "Two, per get_workspace_policy." }];
  const model: AgentModel = { async invoke() { return { content: JSON.stringify(steps.shift()) }; } };
  const server = createWorkbenchServer({ context: context(), assets: new Map(), chatTimeoutMs: 180_000,
    chat: { provider: "ollama", model: "tiny", listModels: async () => ["tiny"], loadModel: async () => model },
    authenticate: async request => request.headers.authorization === "writer" ? { workspaceId: "one", actor: "writer" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const chat = async (content: string) => (await (await fetch(`${base}/api/chat`, { method: "POST", headers: { Authorization: "writer", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tiny", messages: ask(content) }) })).text()).trim().split("\n").map(line => JSON.parse(line) as ChatEvent);
  const first = await chat("What does get_approved_agent say about reader?");
  assert.deepEqual(first[0], { type: "budget", ms: 180_000 });
  const error = first.at(-1); assert.ok(error && error.type === "error"); assert.match(error.message, /No answer was accepted/);
  const models = await (await fetch(`${base}/api/chat/models`, { headers: { Authorization: "writer" } })).json() as { models: string[]; options?: { id: string; detail: string }[] };
  assert.deepEqual(models.models, ["tiny"]);
  const second = await chat("How many approvals does the policy require?");
  const answer = second.at(-1); assert.ok(answer && answer.type === "answer" && answer.evidence?.grounded === true);
  assert.deepEqual(answer.evidence.required, ["get_workspace_policy"]);

  assert.equal(chatTimeoutMs(() => undefined, 600), 600_000);
  assert.equal(chatTimeoutMs(() => "90", 600), 90_000);
  assert.throws(() => chatTimeoutMs(() => "5", 600), /MAGENTIC_CHAT_TIMEOUT_SECONDS/);
  assert.equal(describeToolUse(undefined), "Tool use not measured");
  assert.match(describeToolUse({ at: "2026-11-04T10:15:00.000Z", grounded: true, required: ["get_workspace_policy"], calls: 1 }), /^Tool use verified at 10:15 \(get_workspace_policy\)$/);
  assert.match(describeToolUse({ at: "2026-11-04T10:15:00.000Z", grounded: false, required: [], calls: 0 }), /^Answered without a required read/);
});

test("the chat view shows what an answer rests on", () => {
  const turn: ChatTurn = { role: "assistant", content: "Two approvals.", model: "tiny", tools: [{ name: "get_workspace_policy", state: "done" }],
    evidence: { required: ["get_workspace_policy"], grounded: true, calls: [{ tool: "get_workspace_policy", arguments: {}, resultHash: "a".repeat(64), bytes: 120, isError: false }] } };
  const page = chatView({ configured: true, model: "tiny" }, { ...emptyChat(), channel: "workspace", messages: [{ role: "user", content: "Policy?" }, turn] }, [], {});
  assert.match(page, /Grounded · 1 required read · 1 call/); assert.match(page, /Required: <code>get_workspace_policy<\/code>/);
  assert.match(page, /<code>get_workspace_policy<\/code> <span class="chat-call-args">\{\}<\/span><small>ok · 120 bytes · sha256 aaaaaaaaaaaa…/);
  const plain = chatView({ configured: true, model: "tiny" }, { ...emptyChat(), channel: "workspace", messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello", tools: [{ name: "get_pipeline", state: "done" }] }] }, [], {});
  assert.match(plain, /Used 1 MCP tool/);
});
