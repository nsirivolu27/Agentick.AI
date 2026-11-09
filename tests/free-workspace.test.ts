import assert from "node:assert/strict";
import test from "node:test";
import { createChatAccess } from "../workbench/chat-access.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";
import type { ChatConfiguration } from "../workbench/chat.js";

test("Free works without Stripe or a managed plan and disconnect revokes a prepared personal model", async () => {
  let billingCalls = 0;
  let inferenceCalls = 0;
  const base: ChatConfiguration = {
    provider: "ollama", model: "local-fixture",
    loadModel: async () => ({ invoke: async () => ({ content: "Local fixture" }) }),
  };
  const access = createChatAccess({
    vault: memoryChatVault(), base, managedLogin: true,
    entitled: async () => { billingCalls++; throw new Error("Billing must not be needed"); },
    request: async url => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "text-fixture" }] });
      inferenceCalls++;
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "API fixture" }] }],
        usage: { input_tokens: 8, output_tokens: 3 } });
    },
  });
  await access.connect("workspace-a", "author", { action: "connect", provider: "openai",
    apiKey: "test-only-connection", models: ["text-fixture"] });
  const config = await access.configuration("workspace-a", "author");
  assert.equal((await (await config.loadModel("local-fixture")).invoke("hello")).content, "Local fixture");
  const personal = await config.loadModel("personal/openai/text-fixture");
  await personal.invoke("hello");
  assert.equal(inferenceCalls, 1);
  const summary = await access.summary("workspace-a", "author");
  assert.equal(summary.plan, "free");
  assert.equal(summary.auto, false);
  assert.equal(summary.dailyTokens, undefined);
  assert.equal(summary.accountedTokens, 0);
  assert.equal(billingCalls, 0);
  const other = await access.configuration("workspace-b", "author");
  await assert.rejects(other.loadModel("personal/openai/text-fixture"), /not available/);
  await assert.rejects(access.prepare("workspace-a", "author", {
    messages: [{ role: "user", content: "hello" }], routing: "auto",
  }), /paid access/);
  await access.connect("workspace-a", "author", { action: "disconnect", provider: "openai" });
  await assert.rejects(personal.invoke("hello"), /removed or changed/);
  assert.equal(inferenceCalls, 1);
  assert.equal(billingCalls, 0);
});

test("connection setup failures retain a usable integration guide without claiming an account is connected", () => {
  const body = chatConnectionsPage(undefined, "Connection setup is unavailable").body;
  assert.match(body, /Connection setup is unavailable/);
  assert.match(body, /Workspace integrations/);
  assert.match(body, /href="#\/zenfluence"/);
  assert.match(body, /href="#\/documents"/);
  assert.match(body, /not connection health checks/);
  assert.doesNotMatch(body, /CURRENT PLAN|href="#\/ontology"|data-provider-connect/);
  const demo = chatConnectionsPage(undefined, "Unavailable", undefined, { models: [], loading: false, demo: true }).body;
  assert.match(demo, /does not store provider credentials/);
  assert.doesNotMatch(demo, /Retry|Unavailable|server model below/);
});
