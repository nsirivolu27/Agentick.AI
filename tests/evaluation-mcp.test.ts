import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { memoryMembers } from "../registry/roles.js";
import { createAgentTests } from "../workbench/agent-tests.js";
import { testRunSchema } from "../workbench/agent-tests-model.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { verifyEvaluationBundle } from "../workbench/evaluation-bundle.js";

test("HTTP evidence export and MCP inspection enforce workspace membership without mutating runs", async t => {
  const pipelines = memoryPipelines();
  const engine = createAgentTests({ pipelines, bots: { snapshot() { throw new Error("No worker should execute."); } } });
  t.after(() => engine.close());
  const content = "Private source text for evaluation.";
  const run = testRunSchema.parse({
    id: randomUUID(), workspaceId: "one", agentId: randomUUID(), caseId: randomUUID(),
    agentHash: "a".repeat(12), caseHash: "b".repeat(12), suiteHash: "c".repeat(12),
    agentName: "Documentation", model: "scripted-fixture", prompt: "Summarize the source.", source: "SOP.md",
    summary: "Recorded response.", status: "succeeded", evidence: [{ path: "SOP.md", content,
      sha256: createHash("sha256").update(content).digest("hex"), readAt: "2026-11-04T12:00:00.000Z" }],
    assertions: [], toolCalls: [], calls: 1, tokenUsage: null,
    startedAt: "2026-11-04T12:00:00.000Z", finishedAt: "2026-11-04T12:00:01.000Z",
    expected: "Hidden evaluator answer", projectRoot: "C:/private/root",
    startedBy: "writer", sourceRead: false, events: [], error: "",
  });
  const before = JSON.stringify(run);
  const members = memoryMembers([
    { workspaceId: "one", actor: "writer", roles: ["author"] },
    { workspaceId: "one", actor: "reader", roles: ["approver"] },
    { workspaceId: "two", actor: "outsider", roles: ["author"] },
  ]);
  let revoked = false;
  const server = createWorkbenchServer({
    assets: new Map(), pipelines,
    agentTests: { ...engine, snapshot: workspace => ({ cases: [], runs: workspace === "one" ? [structuredClone(run)] : [], busy: false }) },
    context: { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW,
      members: { rolesFor: (workspace, actor) => revoked ? Promise.resolve([]) : members.rolesFor(workspace, actor) } },
    authenticate: async request => {
      const actor = request.headers.authorization?.replace(/^Bearer /, "");
      return actor ? { workspaceId: actor === "outsider" ? "two" : "one", actor } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const path = `/api/agent-evaluation-export?runId=${run.id}`;
  const get = (actor: string, query = path) => fetch(base + query, { headers: { Authorization: `Bearer ${actor}` } });
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await get("reader")).status, 403);
  assert.equal((await get("outsider")).status, 404);
  assert.equal((await get("writer", path + "&workspaceId=two")).status, 400);
  const response = await get("writer");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bundle = verifyEvaluationBundle(await response.json(), "one");
  assert.equal(bundle.run.evidence[0]!.content, content);
  assert.doesNotMatch(JSON.stringify(bundle), /Hidden evaluator|C:\/private/);

  async function connect(actor: string) {
    const client = new Client({ name: "evaluation-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/api/pipeline-mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${actor}` } },
    }) as unknown as Parameters<typeof client.connect>[0]);
    t.after(() => client.close());
    return client;
  }
  const reader = await connect("reader");
  const tool = (await reader.listTools()).tools.find(item => item.name === "get_agent_evaluation_report");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const result = await reader.callTool({ name: "get_agent_evaluation_report", arguments: { runId: run.id } });
  assert.ok(!result.isError);
  assert.doesNotMatch(JSON.stringify(result), /Private source text|Hidden evaluator|C:\/private/);
  const outside = await connect("outsider");
  assert.equal((await outside.callTool({ name: "get_agent_evaluation_report", arguments: { runId: run.id } })).isError, true);
  assert.equal((await reader.callTool({ name: "get_agent_evaluation_report", arguments: { runId: run.id, workspaceId: "two" } })).isError, true);
  assert.equal(JSON.stringify(run), before);
  revoked = true;
  assert.equal((await get("writer")).status, 403);
  await assert.rejects(reader.callTool({ name: "get_agent_evaluation_report", arguments: { runId: run.id } }));
});
