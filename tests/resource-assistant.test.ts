import assert from "node:assert/strict";
import test from "node:test";
import { resourceContext, resourcePrompt, resourceDialog, resourceBanner, resourceDocument } from "../workbench/resource-assistant.js";
import { chatView, emptyChat, resetChat } from "../workbench/chat-view.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createDocuments, memoryDocumentStore } from "../workbench/documents.js";
import { runWorkspaceAgent, type ChatEvent } from "../workbench/chat.js";
import { scriptedDemoChat } from "../workbench/agent-demo-fixture.js";
import { createZenfluenceDirectory } from "../workbench/zenfluence.js";

function context() {
  return { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW,
    members: memoryMembers([{ workspaceId: "one", actor: "author", roles: ["author"] }]) };
}

test("resource prompts use locators rather than hidden form data and keep approval actions out", () => {
  for (const page of ["workspace", "desk", "agent-studio", "marketplace", "canvas", "documents", "zenfluence", "evaluations", "connections", "mcp"]) {
    const resource = resourceContext(page, "Selected resource", "item")!;
    for (const task of ["explain", "gaps", "document"] as const) {
      const prompt = resourcePrompt(resource, task);
      assert.match(prompt, /read-only workspace tools/);
      assert.match(prompt, /do not invent/i);
      assert.match(prompt, /Do not change configuration, approve/);
      assert.ok(prompt.length < 4000);
    }
  }
  assert.equal(resourceContext("chat", "Chat"), undefined);
  assert.equal(resourceContext("unknown", "Unknown"), undefined);
  assert.equal(resourceContext("agent-studio", "Create", "new")!.id, undefined);
});

test("resource labels are escaped and reset removes resource context", () => {
  const resource = resourceContext("desk", "<script>bad</script>", 'x" onclick="bad')!;
  assert.doesNotMatch(resourceDialog(resource), /<script>/);
  assert.doesNotMatch(resourceBanner(resource, true), /onclick="bad/);
  assert.match(resourceBanner(resource, true), /Return to previous chat/);
  assert.equal(resetChat({ ...emptyChat(), resource }).resource, undefined);
});

test("generated documentation remains an unreviewed draft and needs an author-capable document portal", () => {
  const resource = resourceContext("zenfluence", "Zenfluence")!;
  assert.match(resourceDocument(resource, "Evidence here").text, /^UNREVIEWED DRAFT/);
  const state = { ...emptyChat(), resource, messages: [{ role: "assistant" as const, content: "Evidence here" }] };
  assert.doesNotMatch(chatView({ configured: true }, state), /data-document-answer/);
  assert.match(chatView({ configured: true }, state, [], { canDocument: true }), /Review as document/);
});

test("resource chat reads a bounded selected document through MCP", async () => {
  const documents = createDocuments({ store: memoryDocumentStore() });
  const doc = documents.execute("one", "author", ["author"], { action: "add_document", title: "Runbook", text: "a".repeat(5000) }).documents[0]!;
  let turn = 0;
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "author", [{ role: "user", content: "Explain this document" }], {
    async invoke(prompt) {
      if (!turn++) return { content: JSON.stringify({ type: "tool", name: "read_document", arguments: { documentId: doc.id } }) };
      assert.match(prompt, /truncated/); assert.ok(!prompt.includes("a".repeat(4501)));
      assert.ok(prompt.includes(doc.contentHash));
      return { content: JSON.stringify({ type: "answer", content: "This is a truncated excerpt from Runbook." }) };
    },
  }, new AbortController().signal, event => events.push(event), undefined, undefined, { documents });
  assert.ok(events.some(event => event.type === "tool" && event.name === "read_document" && event.state === "done"));
});

test("resource document reads refuse foreign workspace ids and credential-bearing content", async () => {
  const documents = createDocuments({ store: memoryDocumentStore() });
  const foreign = documents.execute("two", "author", ["author"], { action: "add_document", title: "Foreign", text: "Private other-workspace text." }).documents[0]!;
  const secret = documents.execute("one", "author", ["author"], { action: "add_document", title: "Unsafe", text: "OPENAI_API_KEY=sk-" + "a".repeat(48) }).documents[0]!;
  assert.ok(secret.secretFindings > 0);
  for (const doc of [foreign, secret]) {
    let turn = 0;
    await runWorkspaceAgent(context(), "one", "author", [{ role: "user", content: "Read selected document" }], {
      async invoke(prompt) {
        if (!turn++) return { content: JSON.stringify({ type: "tool", name: "read_document", arguments: { documentId: doc.id } }) };
        assert.doesNotMatch(prompt, /Private other-workspace text|sk-a{48}/);
        assert.match(prompt, /not found|possible credentials/);
        return { content: JSON.stringify({ type: "answer", content: "The document could not be read." }) };
      },
    }, new AbortController().signal, () => {}, undefined, undefined, { documents });
  }
});

test("resource chat can read a scoped Zenfluence link without gaining write tools", async () => {
  let calls = 0; let turn = 0;
  const zenfluence = createZenfluenceDirectory({ connections: [{ workspaceId: "one", site: "https://example.atlassian.net", project: "KAN", spaceId: "123",
    emailSetting: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", tokenSetting: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY" }] }, () => "fixture", async () => {
    calls++; return Response.json({ key: "KAN-12", fields: { summary: "Request", status: { name: "Open" }, project: { key: "KAN" }, updated: "today", description: null } });
  });
  await runWorkspaceAgent(context(), "one", "author", [{ role: "user", content: "Read KAN-12" }], {
    async invoke(prompt) {
      const available = prompt.split("AVAILABLE TOOLS: ")[1]!.split("\n\n")[0]!;
      assert.doesNotMatch(available, /connect_document|add_document|update_pipeline_run/);
      if (!turn++) return { content: JSON.stringify({ type: "tool", name: "get_zenfluence_source", arguments: { source: { kind: "link", id: "https://example.atlassian.net/browse/KAN-12" } } }) };
      assert.match(prompt, /Status: Open/);
      return { content: JSON.stringify({ type: "answer", content: "KAN-12 is open." }) };
    },
  }, new AbortController().signal, () => {}, undefined, undefined, { zenfluence });
  assert.equal(calls, 1);
});

test("scripted resource demo exercises a real policy read and labels its limitations", async () => {
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "author", [{ role: "user", content: "Explain review policy" }],
    await scriptedDemoChat().loadModel(), new AbortController().signal, event => events.push(event));
  assert.ok(events.some(event => event.type === "tool" && event.name === "get_workspace_policy" && event.state === "done"));
  assert.ok(events.some(event => event.type === "answer" && /scripted demo, not live inference/.test(event.content)));
});

test("scripted documentation demo quotes the selected document rather than unrelated policy", async () => {
  const documents = createDocuments({ store: memoryDocumentStore() });
  const doc = documents.execute("one", "author", ["author"], { action: "add_document", title: "SOP", text: "A reviewer must check the source before handoff." }).documents[0]!;
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "author", [{ role: "user", content: resourcePrompt(resourceContext("documents", doc.title, doc.id)!, "document") }],
    await scriptedDemoChat().loadModel(), new AbortController().signal, event => events.push(event), undefined, undefined, { documents });
  assert.ok(events.some(event => event.type === "tool" && event.name === "read_document" && event.state === "done"));
  assert.ok(events.some(event => event.type === "answer" && event.content.includes(doc.contentHash) && event.content.includes("A reviewer must check the source")));
});
