import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createChatAccess } from "../workbench/chat-access.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { chatModelLoader, createScheduler } from "../workbench/scheduler.js";

const modelId = "workspace/anthropic/test-model";

function fixture() {
  const calls: string[] = [];
  let baseLoads = 0;
  const access = createChatAccess({
    base: { provider: "test", model: "server-model", modelOptions: async () => [],
      loadModel: async () => { baseLoads++; throw new Error("Unexpected base model fallback."); } },
    vault: memoryChatVault(), managedLogin: false, entitled: async () => "free",
    request: async (url, init) => {
      if (String(url).includes("/v1/models")) return Response.json({ data: [{ id: "test-model" }], has_more: false });
      assert.equal(String(url), "https://api.anthropic.com/v1/messages");
      const key = new Headers(init?.headers).get("x-api-key");
      assert.ok(key === "fixture-alpha" || key === "fixture-beta");
      calls.push(key);
      return Response.json({ content: [{ type: "text", text: JSON.stringify({ type: "draft", text: `Draft for ${key}.` }) }],
        usage: { input_tokens: 8, output_tokens: 5 } });
    },
  });
  const pipelines = memoryPipelines({ assistant: () => undefined });
  const assistantId = randomUUID();
  const scheduler = createScheduler({ pipelines,
    assistants: (_workspace, id) => ({ id, name: "Documentation assistant", model: modelId, instructions: "Use the supplied evidence.", release: "test release" }),
    loadModel: chatModelLoader(access.agentConfiguration()),
  });
  const connect = (workspace: string, key: string) => access.connect(workspace, "administrator", {
    action: "connect", scope: "workspace", provider: "anthropic", apiKey: key, models: ["test-model"],
  });
  function start(workspace: string) {
    const initial = pipelines.snapshot(workspace);
    const config = structuredClone(initial.config);
    config.stages[0]!.assistantId = assistantId;
    config.stages[0]!.approval = true;
    pipelines.execute(workspace, "administrator", ["admin"], { action: "configure", expectedVersion: initial.version, config }, 2);
    return pipelines.execute(workspace, "author", ["author"], {
      action: "start", requestId: randomUUID(), title: "Document recovery", brief: "Prepare a recovery procedure for review.",
    }, 2).runs[0]!;
  }
  return { access, pipelines, scheduler, calls, connect, start, baseLoads: () => baseLoads };
}

test("scheduled agents resolve the same model ID through each workspace's own connection and leave approval intact", async t => {
  const f = fixture();
  t.after(() => f.scheduler.close());
  await f.connect("alpha", "fixture-alpha");
  await f.connect("beta", "fixture-beta");
  f.start("alpha"); f.start("beta");
  await Promise.all([f.scheduler.tick("alpha"), f.scheduler.tick("beta")]);
  assert.deepEqual([...f.calls].sort(), ["fixture-alpha", "fixture-beta"]);
  for (const workspace of ["alpha", "beta"]) {
    const job = f.scheduler.snapshot(workspace).jobs[0]!;
    assert.equal(job.status, "ready");
    assert.equal(job.model, modelId);
    const run = f.pipelines.snapshot(workspace).runs[0]!;
    assert.equal(run.current, 0);
    assert.equal(run.status, "running");
    assert.equal(run.stages[0]!.status, "active");
    assert.equal(run.stages[0]!.draft!.text, `Draft for fixture-${workspace}.`);
    assert.deepEqual(run.stages[0]!.approvals, []);
  }
  assert.equal(f.baseLoads(), 0);
});

test("a disconnected or absent workspace connection fails queued jobs without falling back or advancing the workflow", async t => {
  const f = fixture();
  t.after(() => f.scheduler.close());
  await f.connect("alpha", "fixture-alpha");
  f.start("alpha"); f.start("beta");
  f.scheduler.enqueue("alpha");
  await f.access.connect("alpha", "administrator", { action: "disconnect", scope: "workspace", provider: "anthropic" });
  for (const workspace of ["alpha", "beta"]) {
    await f.scheduler.tick(workspace);
    assert.equal(f.scheduler.snapshot(workspace).jobs[0]!.status, "failed");
    assert.match(f.scheduler.snapshot(workspace).jobs[0]!.error, /not available/);
    assert.equal(f.pipelines.snapshot(workspace).runs[0]!.stages[0]!.draft, undefined);
    assert.equal(f.pipelines.snapshot(workspace).runs[0]!.current, 0);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.baseLoads(), 0);
});

test("server-only model loaders remain supported and workspace-aware loaders reject missing context", async () => {
  const loaded: (string | undefined)[] = [];
  const loader = chatModelLoader({ loadModel: async model => {
    loaded.push(model);
    return { invoke: async () => ({ content: "Server draft." }) };
  } });
  assert.equal((await (await loader("server-model", "alpha")).invoke("Request")).content, "Server draft.");
  assert.deepEqual(loaded, ["server-model"]);
  const f = fixture();
  await assert.rejects(chatModelLoader(f.access.agentConfiguration())(modelId, ""), /workspace is required/);
  await assert.rejects(chatModelLoader(undefined)("server-model", "alpha"), /No model is configured/);
});
