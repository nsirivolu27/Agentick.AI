import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localChatConfiguration } from "../workbench/local-chat.js";
import { fileChatVault } from "../workbench/chat-vault.js";
import { createChatConnections } from "../workbench/chat-connections.js";

const scratch = () => mkdtempSync(join(tmpdir(), "agentick-local-model-"));
function ollama() {
  const state = { models: [
    { name: "embed:latest", size: 10 }, { name: "small:latest", size: 100 },
    { name: "large:latest", size: 200 }, { name: "paid:cloud", size: 1 },
    { name: "openai/paid-model", size: 1 },
    { name: "remote-alias", size: 1, remote_model: "remote", remote_host: "https://example.com" },
  ] };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const request: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    assert.equal(init?.redirect, "error");
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:11434\/api\//);
    if (String(url).endsWith("/tags")) return Response.json(state);
    if (String(url).endsWith("/show")) return Response.json({ capabilities: body.model === "embed:latest" ? ["embedding"] : ["completion"] });
    assert.ok(String(url).endsWith("/chat"));
    return Response.json({ done: true, message: { content: "Local fixture" }, prompt_eval_count: 4, eval_count: 2 });
  };
  return { state, calls, request };
}

test("a fresh local start selects a small installed chat model and remembers it across restarts", async () => {
  const directory = scratch();
  const fixture = ollama();
  const first = await localChatConfiguration(directory, { env: {}, request: fixture.request });
  assert.equal(first.model, "small:latest");
  assert.ok(!fixture.calls.some(call => call.url.endsWith("/chat")));
  assert.ok(!fixture.calls.some(call => ["paid:cloud", "remote-alias", "openai/paid-model"].includes(String(call.body.model))));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "local-model.json"), "utf8")), { version: 1, model: "small:latest" });
  fixture.state.models.push({ name: "new-smaller:latest", size: 50 });
  const restarted = await localChatConfiguration(directory, { env: {}, request: fixture.request });
  assert.equal(restarted.model, "small:latest");
  const choices = await restarted.modelOptions!();
  assert.ok(!choices.some(model => ["paid:cloud", "remote-alias", "openai/paid-model"].includes(model.id)));
  await (await restarted.loadModel()).invoke("test");
  assert.equal(fixture.calls.at(-1)?.body.model, "small:latest");
  fixture.state.models = fixture.state.models.filter(model => model.name !== "small:latest");
  await assert.rejects(restarted.loadModel("small:latest"), /no longer available/);
  const nextStart = await localChatConfiguration(directory, { env: {}, request: fixture.request });
  assert.equal(nextStart.model, "new-smaller:latest");
});

test("a stopped Ollama service keeps the workspace usable without silently selecting a paid provider", async () => {
  const directory = scratch();
  const config = await localChatConfiguration(directory, {
    env: { OPENAI_API_KEY: "test-only-placeholder", MAGENTIC_OPENAI_MODELS: "paid-model" },
    request: async () => { throw new Error("offline"); },
  });
  assert.equal(config.provider, "ollama");
  assert.equal(config.model, "qwen2.5-coder:7b");
  assert.equal(existsSync(join(directory, "local-model.json")), false);
  await assert.rejects(config.loadModel(), /unavailable/);
  const choices = await config.modelOptions!();
  assert.equal(choices.find(choice => choice.id === config.model)?.available, false);
});

test("explicit provider settings take precedence and invalid saved preferences are not silently overwritten", async () => {
  const directory = scratch();
  const path = join(directory, "local-model.json");
  writeFileSync(path, '{"unexpected":true}');
  const request: typeof fetch = async () => { throw new Error("No discovery should be performed"); };
  const explicit = await localChatConfiguration(directory, { env: {
    MAGENTIC_LLM_PROVIDER: "openai", MAGENTIC_LLM_CHAT_MODEL: "explicit-model",
  }, request });
  assert.equal(explicit.model, "openai/explicit-model");
  assert.equal(readFileSync(path, "utf8"), '{"unexpected":true}');
  await assert.rejects(localChatConfiguration(directory, { env: {}, request }), /local-model.json is invalid/);
  writeFileSync(path, JSON.stringify({ version: 1, model: "openai/paid-model" }));
  await assert.rejects(localChatConfiguration(directory, { env: {}, request }), /local-model.json is invalid/);
});

test("the same persistent directory reopens a personal connection without verifying or storing its key again", async () => {
  const directory = scratch();
  let checks = 0;
  const request: typeof fetch = async () => { checks++; return Response.json({ data: [{ id: "text-fixture" }] }); };
  const first = createChatConnections(fileChatVault(join(directory, "chat-connections")), request);
  await first.execute("workspace", "local-owner", { action: "connect", provider: "openai",
    apiKey: "test-only-persistent-key", models: ["text-fixture"] });
  const restarted = createChatConnections(fileChatVault(join(directory, "chat-connections")), request);
  assert.equal(restarted.read("workspace", "local-owner")[0]?.apiKey, "test-only-persistent-key");
  assert.equal(restarted.list("workspace", "local-owner").length, 1);
  assert.equal(checks, 1);
  assert.equal(restarted.list("other-workspace", "local-owner").length, 0);
  assert.doesNotMatch(JSON.stringify(restarted.list("workspace", "local-owner")), /test-only-persistent-key/);
});
