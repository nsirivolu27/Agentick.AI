import assert from "node:assert/strict";
import test from "node:test";
import { createZenfluenceDirectory, resolveZenfluenceSource } from "../workbench/zenfluence.js";
import { zenfluencePage } from "../workbench/zenfluence-view.js";
import { zenfluenceCommand } from "../workbench/zenfluence-api.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { randomUUID } from "node:crypto";

const site = "https://example.atlassian.net";
const connection = { workspaceId: "workspace", site, project: "KAN", spaceId: "123",
  emailSetting: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", tokenSetting: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY" };
const page = { id: "456", spaceId: "123", status: "current", title: "Runbook", version: { number: 1 },
  body: { atlas_doc_format: { value: JSON.stringify({ type: "doc", content: [{ type: "text", text: "Review before granting access." }] }) } } };

test("pasted links resolve canonical resource ids without retaining tracking parameters", () => {
  for (const path of ["/browse/KAN-12", "/browse/KAN-12?tracking=test#comment"]) {
    assert.deepEqual(resolveZenfluenceSource({ kind: "link", id: site + path }, site), { kind: "jira", id: "KAN-12" });
  }
  for (const path of ["/wiki/spaces/TEAM/pages/456/Runbook", "/wiki/pages/viewpage.action?pageId=456"]) {
    assert.deepEqual(resolveZenfluenceSource({ kind: "link", id: site + path }, site), { kind: "confluence", id: "456" });
  }
});

test("foreign hosts, credentials and unsupported links never reach Atlassian", async () => {
  let calls = 0;
  const reader = createZenfluenceDirectory({ connections: [connection] }, () => "fixture", async () => { calls++; return Response.json(page); })("workspace")!;
  for (const id of ["https://example.atlassian.net.evil.test/browse/KAN-12", "http://example.atlassian.net/browse/KAN-12",
    "https://user:password@example.atlassian.net/browse/KAN-12", "https://127.0.0.1/browse/KAN-12",
    site + "/browse/OTHER-12", site + "/jira/software/projects/KAN/boards/2", site + "/wiki/x/short"]) {
    await assert.rejects(reader.read({ kind: "link", id }));
  }
  assert.equal(calls, 0);
});

test("linked sources retain returned-space checks and attach through the existing approval-preserving path", async () => {
  let foreign = false;
  const directory = createZenfluenceDirectory({ connections: [connection] }, () => "fixture", async (url, options) => {
    assert.equal(String(url), site + "/wiki/api/v2/pages/456?body-format=atlas_doc_format");
    assert.equal(options?.redirect, "error");
    return Response.json({ ...page, spaceId: foreign ? "999" : "123" });
  });
  const identity = { workspaceId: "workspace", actor: "writer", roles: ["author"] as const };
  const pipelines = memoryPipelines();
  const run = pipelines.execute("workspace", "writer", ["author"], { action: "start", requestId: randomUUID(), title: "Access request", brief: "Use the runbook." }, 2).runs[0]!;
  const source = { kind: "link", id: site + "/wiki/spaces/TEAM/pages/456/Runbook" };
  const read = await directory("workspace")!.read(source);
  await zenfluenceCommand(directory, pipelines, identity, { action: "attach", source, runId: run.id,
    expectedRevision: run.revision, expectedSourceHash: read.contentHash });
  const saved = pipelines.snapshot("workspace").runs[0]!;
  assert.equal(saved.materials?.length, 1);
  assert.equal(saved.current, 0);
  assert.equal(saved.requiredApprovals, 2);
  foreign = true;
  await assert.rejects(directory("workspace")!.read(source), /outside/);
});

test("the workspace explains outbound limits and keeps the read form available after a failed read", () => {
  const html = zenfluencePage({ configured: true, ready: true, project: "KAN", site }, undefined, "Source unavailable", [], false).body;
  assert.match(html, /id="zenfluence-read"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Configured/);
  assert.match(html, /Paste a link/);
  assert.match(html, /REST API guide/);
  assert.match(html, /Confluence page publishing is not implemented/);
  assert.match(html, /shared access, not personal/);
  assert.doesNotMatch(html, /<details open/);
});
