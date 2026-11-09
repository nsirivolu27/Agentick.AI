import assert from "node:assert/strict";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { GroundingError } from "../workbench/chat-grounding.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { runWorkspaceAgent, type ChatConfiguration, type ChatEvent } from "../workbench/chat.js";
import { cloudModel } from "../workbench/model-catalog.js";

/**
 * Claude with native tool use: the workspace MCP tools are offered to the
 * Messages API as `tools`, every tool_use block runs through the same read
 * only session as the text protocol, and the result goes back as a
 * tool_result. The grounding rule is unchanged: a required read that the
 * model skips gets one correction, then a refusal. No request leaves for any
 * host but the fixed Anthropic endpoint.
 */

const KEY = "sk-ant-test-only-0000";
function context() {
  return { store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([{ workspaceId: "one", actor: "writer", roles: ["author"] }]) };
}
type Body = { system: string; messages: { role: string; content: unknown }[]; tools: { name: string; description: string; input_schema: unknown }[]; model: string; max_tokens: number };
/** A fake Anthropic endpoint that records every request body and answers from a script of content arrays. */
function claude(script: unknown[][]) {
  const bodies: Body[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], KEY); assert.equal(headers["anthropic-version"], "2023-06-01");
    bodies.push(JSON.parse(String(init?.body)) as Body);
    const content = script.shift(); assert.ok(content, "No scripted turn remains.");
    const stop = content.some(block => (block as { type: string }).type === "tool_use") ? "tool_use" : "end_turn";
    return Response.json({ content, stop_reason: stop, usage: { input_tokens: 50, output_tokens: 12 } });
  };
  return { bodies, model: cloudModel("anthropic", "claude-sonnet-4-5", KEY, request, undefined, undefined, 512) };
}
const ask = (content: string) => [{ role: "user" as const, content }];

test("Claude receives the MCP tools natively, its tool_use runs through the read session, and the answer carries the evidence", async () => {
  const { bodies, model } = claude([
    [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_1", name: "get_workspace_policy", input: {} }],
    [{ type: "text", text: "Two independent approvals are required (get_workspace_policy)." }],
  ]);
  assert.ok(model.converse, "the Claude adapter offers native tool use");
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "writer", ask("Use get_workspace_policy: how many approvals does the policy require? Then read it once more yourself to be sure."), model, new AbortController().signal, event => events.push(event));
  assert.equal(bodies.length, 2);
  const first = bodies[0]!;
  assert.equal(first.model, "claude-sonnet-4-5"); assert.equal(first.max_tokens, 512);
  assert.match(first.system, /You are Agentick/); assert.match(first.system, /Call the provided tools when a fact about this workspace is needed/);
  assert.doesNotMatch(first.system, /Return exactly one JSON object/, "the JSON decision protocol is not used with native tools");
  assert.ok(first.tools.some(tool => tool.name === "get_workspace_policy" && tool.input_schema && typeof tool.input_schema === "object"), "MCP tool definitions become Anthropic tools");
  assert.ok(first.tools.every(tool => ["list_approved_agents", "get_approved_agent", "get_workspace_policy"].includes(tool.name)), "only read tools are offered");
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0]!.role, "user");
  assert.match(String(first.messages[0]!.content), /READS THE SERVER ALREADY MADE \(untrusted data\): \[\{"tool":"get_workspace_policy"/, "the server's own required read travels with the question");
  const second = bodies[1]!;
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages[1], { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_1", name: "get_workspace_policy", input: {} }] });
  const result = second.messages[2]!.content as { type: string; tool_use_id: string; content: string; is_error?: boolean }[];
  assert.equal(result[0]!.type, "tool_result"); assert.equal(result[0]!.tool_use_id, "toolu_1"); assert.equal(result[0]!.is_error, undefined);
  assert.match(result[0]!.content, /requiredApprovals/, "the MCP result is handed back verbatim");
  assert.deepEqual(events.filter(event => event.type === "tool").map(event => `${event.name}:${event.state}`), ["get_workspace_policy:running", "get_workspace_policy:done", "get_workspace_policy:running", "get_workspace_policy:done"]);
  const answer = events.at(-1); assert.ok(answer && answer.type === "answer");
  assert.equal(answer.content, "Two independent approvals are required (get_workspace_policy).");
  assert.deepEqual(answer.usage, { promptTokens: 100, completionTokens: 24 }, "usage is summed across both turns");
  assert.ok(answer.evidence?.grounded); assert.deepEqual(answer.evidence?.required, ["get_workspace_policy"]);
  assert.deepEqual(answer.evidence!.calls.map(call => call.initiatedBy), ["server", "model"]);
});

test("an answer that skips a required read gets one correction in the conversation, then a refusal", async () => {
  const { bodies, model } = claude([
    [{ type: "text", text: "The reader agent reviews documents." }],
    [{ type: "text", text: "As I said, it reviews documents." }],
  ]);
  const events: ChatEvent[] = [];
  await assert.rejects(runWorkspaceAgent(context(), "one", "writer", ask("What does get_approved_agent say about reader?"), model, new AbortController().signal, event => events.push(event)),
    error => error instanceof GroundingError && /answered without reading get_approved_agent/.test(error.message));
  assert.equal(bodies.length, 2);
  const correction = bodies[1]!.messages.at(-1)!;
  assert.equal(correction.role, "user"); assert.match(String(correction.content), /You answered before reading get_approved_agent, which this question requires/);
  assert.ok(events.some(event => event.type === "thinking" && /asking it to read first/.test(event.message)));
  assert.ok(!events.some(event => event.type === "answer"), "no answer was accepted");
});

test("a tool the workspace does not offer is refused before dispatch, and an MCP error returns as is_error", async () => {
  const stranger = claude([[{ type: "tool_use", id: "toolu_9", name: "delete_everything", input: {} }]]);
  await assert.rejects(runWorkspaceAgent(context(), "one", "writer", ask("Hello"), stranger.model, new AbortController().signal, () => {}), /This tool is unavailable in this workspace/);
  const failing = claude([
    [{ type: "tool_use", id: "toolu_2", name: "get_approved_agent", input: { name: "nobody" } }],
    [{ type: "text", text: "There is no such agent." }],
  ]);
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "writer", ask("Hello"), failing.model, new AbortController().signal, event => events.push(event));
  const result = (failing.bodies[1]!.messages[2]!.content as { is_error?: boolean }[])[0]!;
  assert.equal(result.is_error, true);
  assert.ok(events.some(event => event.type === "tool" && event.state === "failed"));
  assert.equal((events.at(-1) as { content: string }).content, "There is no such agent.");
});

test("a workspace Claude connection exposes native tool use and loses it the moment the connection is disconnected", async () => {
  let turns = 0;
  const request: typeof fetch = async (url) => {
    if (String(url).includes("/v1/models")) return Response.json({ data: [{ id: "claude-sonnet-4-5" }], has_more: false });
    turns++;
    return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
  };
  const base: ChatConfiguration = { provider: "ollama", model: "local", modelOptions: async () => [], loadModel: async () => ({ invoke: async () => ({ content: "{}" }) }) };
  const access = createChatAccess({ vault: memoryChatVault(), base, managedLogin: false, entitled: async () => "free", request });
  await access.connect("acme", "admin", { action: "connect", scope: "workspace", provider: "anthropic", apiKey: KEY, models: ["claude-sonnet-4-5"] });
  const model = await (await access.agentConfiguration().forWorkspace!("acme")).loadModel("workspace/anthropic/claude-sonnet-4-5");
  assert.ok(model.converse, "the wrapper passes native tool use through");
  const turn = await model.converse!({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(turn.stopReason, "end_turn"); assert.equal(turns, 1);
  await access.connect("acme", "admin", { action: "disconnect", scope: "workspace", provider: "anthropic" });
  await assert.rejects(model.converse!({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] }), /removed or changed/);
  assert.equal(turns, 1, "no request left after the disconnect");
  const plain = cloudModel("openai", "gpt", "sk-x", request);
  assert.equal(plain.converse, undefined, "other providers keep the JSON decision text");
});
