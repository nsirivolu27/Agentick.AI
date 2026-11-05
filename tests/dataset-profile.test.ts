import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveConfigurable } from "../workbench/agent-configurables.js";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE } from "../workbench/agent-demo-fixture.js";
import { toolCallsFrom } from "../workbench/agent-tests.js";
import { botPolicySchema } from "../workbench/bot-schema.js";
import type { ChatConfiguration } from "../workbench/chat.js";
import { parseDelimited, profileDataset, profileProjectFile } from "../workbench/dataset-profile.js";

/**
 * Dataset profiles are computed by the application, never by a model. An
 * agent that may profile a dataset gets row counts, column types, ranges and
 * missing values with the file hash, and that profile is the evidence a
 * reviewer sees. The scripted model below makes a real profile call through
 * the worker; it presents no canned numbers as inference.
 */

const operator = DEMO_MEMBERS[0]!.actor;
const roles = DEMO_MEMBERS[0]!.roles;
const CSV = "county,declarations,incident,note\nMontgomery,3,Flood,\"Rain, then wind\"\nGiles,1,Flood,\"He said \"\"stay\"\"\"\nFloyd,,Fire,\nPulaski,2,Flood\n";

test("a CSV profile counts rows, types columns and reports missing cells without inventing values", () => {
  assert.deepEqual(parseDelimited("a,b\n\"x,y\",\"q\"\"q\"\r\n1,2\n", ","), [["a", "b"], ["x,y", "q\"q"], ["1", "2"]]);
  const profile = profileDataset(CSV, "data/declarations.csv", "csv");
  assert.equal(profile.rows, 4); assert.equal(profile.fileSha256, createHash("sha256").update(CSV).digest("hex"));
  assert.deepEqual(profile.columns.map(column => [column.name, column.type, column.present, column.missing, column.distinct]),
    [["county", "text", 4, 0, 4], ["declarations", "number", 3, 1, 3], ["incident", "text", 4, 0, 2], ["note", "text", 2, 2, 2]]);
  const declarations = profile.columns[1]!;
  assert.equal(declarations.min, 1); assert.equal(declarations.max, 3); assert.equal(declarations.mean, 2);
  assert.deepEqual(profile.columns[3]!.examples, ["Rain, then wind", "He said \"stay\""]);
  assert.match(profile.warnings[0]!, /1 rows do not have 4 cells/);
  assert.equal(profileDataset("a\tb\n1\t2\n", "x.tsv", "tsv").columns[1]!.type, "number");
});

test("JSON datasets accept an array, one wrapped array or JSON lines, and refuse other shapes", () => {
  const wrapped = profileDataset(JSON.stringify({ metadata: { count: 2 }, DisasterDeclarationsSummaries: [{ disasterNumber: 4820, state: "VA" }, { disasterNumber: 4821, state: "VA", extra: null }] }), "snapshot.json", "json");
  assert.equal(wrapped.rows, 2); assert.match(wrapped.warnings[0]!, /"DisasterDeclarationsSummaries" array/);
  assert.deepEqual(wrapped.columns.map(column => `${column.name}:${column.type}`), ["disasterNumber:number", "state:text", "extra:empty"]);
  const lines = profileDataset("{\"n\":1}\n{\"n\":\"two\"}\n\n", "rows.jsonl", "jsonl");
  assert.equal(lines.rows, 2); assert.equal(lines.columns[0]!.type, "text", "a column with one non numeric value is text");
  assert.throws(() => profileDataset("{\"a\":1,\"b\":2}", "x.json", "json"), /array of objects/);
  assert.throws(() => profileDataset("not json", "x.json", "json"), /not valid JSON/);
  assert.throws(() => profileDataset("{\"n\":1}\nnope\n", "x.jsonl", "jsonl"), /Line 2/);
  assert.throws(() => profileDataset("", "x.csv", "csv"), /no header row/);
});

test("profiling a project file keeps the checkout path rules and the format allow list", () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-dataset-profile-"));
  try {
    mkdirSync(join(directory, "data"));
    writeFileSync(join(directory, "data", "sample.csv"), "﻿id,value\n1,10\n2,20\n");
    writeFileSync(join(directory, "notes.txt"), "id,value\n");
    const profile = profileProjectFile(directory, "data/sample.csv")!;
    assert.equal(profile.rows, 2); assert.equal(profile.columns[0]!.name, "id", "a byte order mark does not become part of the first column name");
    assert.equal(profileProjectFile(directory, "data/missing.csv"), null);
    assert.throws(() => profileProjectFile(directory, "notes.txt"), /\.csv, \.tsv, \.json or \.jsonl/);
    assert.throws(() => profileProjectFile(directory, "../outside.csv"), /outside|leaves/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the bot policy accepts the profile tool as a source read and the test log records the profile as a read", () => {
  const policy = botPolicySchema.parse({ kind: "planner", maxSteps: 4, timeoutSeconds: 60, allowedTools: ["profile_project_file"], maxToolCalls: 2, requireSourceRead: true });
  assert.deepEqual(policy.allowedTools, ["profile_project_file"]);
  assert.deepEqual(toolCallsFrom(["MCP tool: profile_project_file", "Dataset profiled: data/sample.csv (2 rows, 2 columns, sha256 0123abcd)", "MCP tool: profile_project_file", "Dataset missing: data/none.csv"]),
    [{ name: "profile_project_file", path: "data/sample.csv", outcome: "read" }, { name: "profile_project_file", path: "data/none.csv", outcome: "missing" }]);
});

/** A model offered only through the workspace catalog, scripted to profile the dataset and then answer from the computed numbers. */
function workspaceScriptedChat(): ChatConfiguration {
  const id = "workspace/anthropic/scripted-fixture";
  const option = { id, label: "Scripted workspace model", provider: "Workspace", available: true, local: true, detail: "Synthetic responses, no API calls." };
  const loadModel: ChatConfiguration["loadModel"] = async () => ({ async invoke(prompt) {
    const observation = prompt.split("OBSERVATIONS: ")[1]?.split("\n\n")[0];
    const calls = JSON.parse(observation ?? "[]") as { tool: string; result?: { profile?: { rows: number; columns: { name: string; type: string; min?: number; max?: number }[]; fileSha256: string } } }[];
    const profile = calls.find(call => call.tool === "profile_project_file")?.result?.profile;
    if (!profile) return { content: JSON.stringify({ type: "tool", name: "profile_project_file", arguments: { path: "data/declarations.csv" } }) };
    const declarations = profile.columns.find(column => column.name === "declarations")!;
    return { content: JSON.stringify({ type: "result", changes: [], summary: `Computed profile of data/declarations.csv (SHA-256 ${profile.fileSha256}): ${profile.rows} rows; declarations ${declarations.type} from ${declarations.min} to ${declarations.max}. A person must review this answer.` }) };
  } });
  return { provider: "Scripted", model: id, modelOptions: async () => [], loadModel: async () => { throw new Error("Workspace models load through the workspace catalog."); },
    forWorkspace: async () => ({ provider: "Scripted", model: id, modelOptions: async () => [option], loadModel }) };
}

test("an agent on a workspace connection is ready for a test, and its profile call becomes recorded evidence", { timeout: 90_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-dataset-agent-"));
  const chat = workspaceScriptedChat();
  const fixture = await createAgentDemo(directory, chat);
  mkdirSync(join(directory, "sample-repository", "data"), { recursive: true });
  writeFileSync(join(directory, "sample-repository", "data", "declarations.csv"), CSV);
  try {
    const tests = fixture.agentTests;
    const pipeline = fixture.pipelines.snapshot(DEMO_WORKSPACE);
    const analyst = { ...fixture.agents[0]!, bot: { ...fixture.agents[0]!.bot, allowedTools: ["profile_project_file"] as ("profile_project_file")[] } };
    const configured = fixture.pipelines.execute(DEMO_WORKSPACE, operator, roles, { action: "configure", expectedVersion: pipeline.version, config: saveConfigurable(pipeline.config, analyst) }, 2);
    const testCase = tests.snapshot(DEMO_WORKSPACE).cases[0]!;
    await tests.execute(DEMO_WORKSPACE, operator, roles, { action: "save_case", id: testCase.id, agentId: testCase.agentId, title: "Profile the declarations", prompt: "Profile data/declarations.csv and report the row count and the declarations range.", expected: "", source: "" });
    await tests.execute(DEMO_WORKSPACE, operator, roles, { action: "run", caseId: testCase.id, expectedVersion: configured.version });
    await tests.settled(DEMO_WORKSPACE);
    const run = tests.snapshot(DEMO_WORKSPACE).runs.at(-1)!;
    assert.equal(run.status, "succeeded", run.error);
    assert.equal(run.model, "workspace/anthropic/scripted-fixture", "the base catalog lists nothing; readiness used the workspace catalog");
    assert.deepEqual(run.toolCalls, [{ name: "profile_project_file", path: "data/declarations.csv", outcome: "read" }]);
    assert.equal(run.sourceRead, true, "a profile satisfies the required source read");
    assert.match(run.summary, /4 rows; declarations number from 1 to 3/);
    const hash = createHash("sha256").update(CSV).digest("hex");
    assert.match(run.summary, new RegExp(hash));
    const evidence = run.evidence!.find(item => item.path === "data/declarations.csv")!;
    assert.ok(evidence, "the profile is recorded as evidence under the dataset path");
    assert.equal((JSON.parse(evidence.content) as { fileSha256: string }).fileSha256, hash, "the evidence names the file hash it was computed from");
  } finally { await fixture.agentTests.close(); await fixture.bots.close(); rmSync(directory, { recursive: true, force: true }); }
});
