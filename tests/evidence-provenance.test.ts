import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOntologyDirectory, ontologyMaterial } from "../workbench/ontology.js";
import { createDeclarationDemo } from "../workbench/openfema-demo.js";
import { verifiedDeclarationSample } from "../workbench/declaration-sample.js";
import { DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";

test("source hashes bind the projected evidence and execution mode, not retrieval time", async () => {
  const config = { version: 1, workspaces: [{ workspaceId: "one", mode: "foundry",
    baseUrl: "https://source.example.invalid", ontology: "test",
    tokenSetting: "MAGENTIC_FOUNDRY_TOKEN_TEST", objectTypes: [{ apiName: "Thing", properties: ["name"] }] }] };
  let name = "Recorded evidence";
  const request: typeof fetch = async () => Response.json({ __apiName: "Thing", __primaryKey: "1", name, excluded: "not projected" });
  const live = createOntologyDirectory(config, () => "fixture", request)("one")!;
  const replay = createOntologyDirectory(config, () => "fixture", request, process.cwd(), "offline-replay")("one")!;
  const read = { objectType: "Thing", primaryKey: "1" };
  const first = await live.get(read); const again = await live.get(read); const saved = await replay.get(read);
  assert.deepEqual(first.properties, { name });
  assert.equal(first.source.execution, "live");
  assert.equal(saved.source.execution, "offline-replay");
  assert.equal(first.source.contentSha256, again.source.contentSha256);
  assert.notEqual(first.source.contentSha256, saved.source.contentSha256);
  assert.match(first.source.contentSha256!, /^[a-f0-9]{64}$/);
  name = "Changed evidence";
  assert.notEqual((await live.get(read)).source.contentSha256, first.source.contentSha256);
  assert.equal(replay.catalog().execution, "offline-replay");
  const material = ontologyMaterial(saved);
  assert.match(material.title, /replay/); assert.match(material.content, /offline-replay/);
  assert.doesNotMatch(JSON.stringify(first), /fixture|not projected/);
});

test("saved analyst evidence explicitly records replay throughout the ontology binding", async () => {
  const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
  const demo = await createDeclarationDemo(content);
  const reader = demo.ontology(DEMO_WORKSPACE)!;
  assert.equal(reader.catalog().execution, "offline-replay");
  const run = demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!;
  assert.match(run.workflowSource!.content, /offline-replay/);
  const sample = await verifiedDeclarationSample(run.materials![0]!, reader);
  assert.equal(sample.foundrySources.length, 5);
  assert.ok(sample.foundrySources.every(source => source.execution === "offline-replay" && source.contentSha256));
});

test("declaration verification propagates cancellation to every source read and refuses late evidence", async () => {
  const content = readFileSync("examples/ontology/openfema/data/virginia-snapshot.json", "utf8");
  const demo = await createDeclarationDemo(content);
  const base = demo.ontology(DEMO_WORKSPACE)!;
  const controller = new AbortController(); const signals: AbortSignal[] = [];
  const reader = { ...base, get: async (_input: unknown, signal?: AbortSignal): Promise<never> => {
    signals.push(signal!);
    return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  } };
  const operation = verifiedDeclarationSample(demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!.materials![0]!, reader, controller.signal);
  controller.abort();
  await assert.rejects(operation, /abort/i);
  assert.equal(signals.length, 5); assert.ok(signals.every(signal => signal === controller.signal));
});
