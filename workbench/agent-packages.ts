import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../registry/roles.js";
import { PermissionError } from "../registry/roles.js";
import { agentConfigurableSchema, applyConfigurable, saveConfigurable } from "./agent-configurables.js";
import { agentHash, passedCurrentTest, testCaseSchema, testSuiteHash, type AgentTestsSnapshot } from "./agent-tests-model.js";
import { atomicJson, digest } from "./bot-project.js";
import { canonical } from "./audit-package.js";
import { PipelineError, type PipelineEngine } from "./pipeline.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const packageSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), version: z.number().int().positive(),
  agent: agentConfigurableSchema, cases: z.array(testCaseSchema).min(1).max(200),
  runIds: z.array(z.string().uuid()).min(1).max(200), runHashes: z.record(z.string().uuid(), hash), contentHash: hash,
  requestedBy: z.string().min(1), createdAt: z.string().datetime(),
  requiredApprovals: z.number().int().min(1).max(10),
  approvals: z.array(z.object({ by: z.string().min(1), hash, at: z.string().datetime() }).strict()).max(10),
  retired: z.boolean(),
  retirement: z.object({ by: z.string().min(1), at: z.string().datetime() }).strict().optional(),
}).strict();
const installationSchema = z.object({
  id: z.string().uuid(), packageId: z.string().uuid(), by: z.string().min(1),
  at: z.string().datetime(), upgradedFrom: z.string().uuid().optional(),
}).strict();
const stateSchema = z.object({
  workspaceId: z.string().min(1), packages: z.array(packageSchema).max(100),
  installations: z.array(installationSchema).max(100),
}).strict();
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), agentId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("approve"), packageId: z.string().uuid(), expectedHash: hash }).strict(),
  z.object({ action: z.literal("retire"), packageId: z.string().uuid(), expectedHash: hash }).strict(),
  z.object({ action: z.literal("install"), packageId: z.string().uuid(), expectedHash: hash, upgradedFrom: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("assign"), installationId: z.string().uuid(), stageId: z.string().min(1), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("import"), expectedVersion: z.number().int().positive(), template: z.object({
    kind: z.literal("agentick-agent-template"), version: z.literal(1), agent: agentConfigurableSchema,
  }).strict() }).strict(),
]);
type State = z.infer<typeof stateSchema>;
type Package = z.infer<typeof packageSchema>;
function contentHash(item: Omit<Package, "contentHash"> | Package) {
  return digest(canonical({ workspaceId: item.workspaceId, version: item.version, agent: item.agent,
    cases: item.cases, runIds: item.runIds, runHashes: item.runHashes, requestedBy: item.requestedBy, createdAt: item.createdAt,
    requiredApprovals: item.requiredApprovals }));
}

/** Packages preserve a tested definition. Installation and upgrades are explicit
 * records; neither operation edits a workflow or grants a new tool. */
export function createAgentPackages(options: {
  directory?: string | undefined;
  pipelines: Pick<PipelineEngine, "snapshot" | "execute">;
  tests: (workspace: string) => AgentTestsSnapshot;
}) {
  const states = new Map<string, State>();
  if (options.directory) mkdirSync(options.directory, { recursive: true });
  const path = (workspace: string) => join(options.directory!, digest(workspace) + ".json");
  function state(workspace: string): State {
    if (!states.has(workspace)) {
      let value: State = { workspaceId: workspace, packages: [], installations: [] };
      if (options.directory) {
        try { value = stateSchema.parse(JSON.parse(readFileSync(path(workspace), "utf8"))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (value.workspaceId !== workspace || value.packages.some(item => item.workspaceId !== workspace ||
        item.contentHash !== contentHash(item))) throw new Error("Invalid agent package storage.");
      if (new Set(value.packages.map(item => item.id)).size !== value.packages.length ||
        new Set(value.installations.map(item => item.id)).size !== value.installations.length ||
        value.installations.some(item => !value.packages.some(pkg => pkg.id === item.packageId))) throw new Error("Invalid installation storage.");
      states.set(workspace, value);
    }
    return states.get(workspace)!;
  }
  function evidenceCurrent(workspace: string, item: Package) {
    const tests = options.tests(workspace);
    const recorded = tests.runs.filter(run => item.runIds.includes(run.id));
    if (recorded.length !== item.runIds.length || recorded.some(run => {
      const { evidenceCurrent, ...frozen } = run;
      return digest(canonical(frozen)) !== item.runHashes[run.id];
    })) return false;
    return passedCurrentTest(item.agent, { cases: item.cases, runs: tests.runs.filter(run => item.runIds.includes(run.id)), busy: tests.busy });
  }
  function ready(workspace: string, item: Package, requiredApprovals = 1) {
    return !item.retired && item.contentHash === contentHash(item) && evidenceCurrent(workspace, item) &&
      new Set(item.approvals.filter(approval => approval.by !== item.requestedBy && approval.hash === item.contentHash).map(approval => approval.by)).size >= Math.max(item.requiredApprovals, requiredApprovals);
  }
  function snapshot(workspace: string, requiredApprovals = 1) {
    const value = state(workspace);
    return structuredClone({ ...value, packages: value.packages.map(item => ({
      ...item, effectiveApprovals: Math.max(item.requiredApprovals, requiredApprovals),
      ready: ready(workspace, item, requiredApprovals), evidenceCurrent: evidenceCurrent(workspace, item),
    })) });
  }
  function exportPackage(workspace: string, id: string, requiredApprovals: number) {
    const item = state(workspace).packages.find(pkg => pkg.id === id);
    if (!item) throw new PipelineError(404, "Package not found in this workspace.");
    const tests = options.tests(workspace);
    return structuredClone({
      kind: "agentick-agent-package", version: 1, package: item,
      evaluations: tests.runs.filter(run => item.runIds.includes(run.id)),
      ready: ready(workspace, item, requiredApprovals),
      draftTemplate: { kind: "agentick-agent-template", version: 1, agent: item.agent },
      note: "Private workspace evidence. Hashes prove consistency, not signer identity or factual accuracy. Import only draftTemplate into another workspace and test it there.",
    });
  }
  function execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, requiredApprovals: number) {
    if (!roles.length) throw new PermissionError("You are not a member of this workspace.");
    const input = commandSchema.parse(raw);
    const value = structuredClone(state(workspace));
    const admin = roles.includes("admin");
    const author = admin || roles.includes("author");
    const save = () => {
      stateSchema.parse(value);
      if (options.directory) atomicJson(path(workspace), value);
      states.set(workspace, value);
      return snapshot(workspace, requiredApprovals);
    };
    if (input.action === "import") {
      if (!admin) throw new PermissionError("An admin imports a draft template.");
      const pipeline = options.pipelines.snapshot(workspace);
      options.pipelines.execute(workspace, actor, roles, { action: "configure", expectedVersion: input.expectedVersion,
        config: saveConfigurable(pipeline.config, { ...input.template.agent, id: randomUUID() }) }, requiredApprovals);
      return snapshot(workspace, requiredApprovals);
    }
    if (input.action === "publish") {
      if (!author) throw new PermissionError("An author requests package review.");
      const pipeline = options.pipelines.snapshot(workspace);
      if (pipeline.version !== input.expectedVersion) throw new PipelineError(409, "Refresh the changed agent configuration.");
      const agent = pipeline.config.configurables?.find(item => item.id === input.agentId);
      const tests = options.tests(workspace);
      if (!agent || !passedCurrentTest(agent, tests)) throw new PipelineError(409, "Pass the current test suite and quality review before packaging.");
      const cases = tests.cases.filter(item => item.agentId === agent.id);
      const suite = testSuiteHash(cases, agent.id);
      const runIds = cases.map(item => tests.runs.slice().reverse().find(run => run.caseId === item.id &&
        run.agentHash === agentHash(agent) && run.suiteHash === suite)!.id);
      const runHashes = Object.fromEntries(runIds.map(id => {
        const { evidenceCurrent, ...frozen } = tests.runs.find(run => run.id === id)!;
        return [id, digest(canonical(frozen))];
      }));
      const previous = value.packages.filter(item => item.agent.id === agent.id);
      const item = { id: randomUUID(), workspaceId: workspace, version: Math.max(0, ...previous.map(item => item.version)) + 1,
        agent: structuredClone(agent), cases, runIds, runHashes, requestedBy: actor, createdAt: new Date().toISOString(),
        requiredApprovals, approvals: [], retired: false };
      value.packages.push(packageSchema.parse({ ...item, contentHash: contentHash(item) }));
      return save();
    }
    if (input.action === "assign") {
      if (!admin) throw new PermissionError("An admin assigns installed agents.");
      const installation = value.installations.find(item => item.id === input.installationId);
      const pkg = value.packages.find(item => item.id === installation?.packageId);
      if (!installation || !pkg) throw new PipelineError(404, "Installation not found in this workspace.");
      if (!ready(workspace, pkg, requiredApprovals)) throw new PipelineError(409, "Package is retired or its reviewed evidence is no longer ready.");
      const pipeline = options.pipelines.snapshot(workspace);
      const agent = { ...pkg.agent, id: installation.id };
      const config = applyConfigurable(saveConfigurable(pipeline.config, agent), agent.id, input.stageId);
      options.pipelines.execute(workspace, actor, roles, { action: "configure", config, expectedVersion: input.expectedVersion }, requiredApprovals);
      return snapshot(workspace, requiredApprovals);
    }
    const item = value.packages.find(item => item.id === input.packageId);
    if (!item) throw new PipelineError(404, "Package not found in this workspace.");
    if (item.contentHash !== input.expectedHash) throw new PipelineError(409, "Refresh the package before acting.");
    if (input.action === "retire") {
      if (!admin) throw new PermissionError("An admin retires a package.");
      item.retired = true;
      item.retirement ??= { by: actor, at: new Date().toISOString() };
      return save();
    }
    if (input.action === "approve") {
      if (!admin && !roles.includes("approver")) throw new PermissionError("A reviewer approves packages.");
      if (actor === item.requestedBy) throw new PermissionError("The publisher cannot approve their own package.");
      if (item.retired || !evidenceCurrent(workspace, item)) throw new PipelineError(409, "Package evidence is stale or the package is retired.");
      if (item.approvals.some(approval => approval.by === actor)) throw new PipelineError(409, "You already approved this version.");
      item.approvals.push({ by: actor, hash: item.contentHash, at: new Date().toISOString() });
      return save();
    }
    if (!admin) throw new PermissionError("An admin installs reviewed packages.");
    if (!ready(workspace, item, requiredApprovals)) throw new PipelineError(409, "Package is retired or not ready for installation.");
    if (input.upgradedFrom) {
      const previous = value.installations.find(entry => entry.id === input.upgradedFrom);
      const priorPackage = value.packages.find(entry => entry.id === previous?.packageId);
      if (!priorPackage || priorPackage.agent.id !== item.agent.id || priorPackage.version >= item.version) {
        throw new PipelineError(409, "An upgrade must select a newer version of the same agent in this workspace.");
      }
    }
    // Repeated clicks return the existing installation without adding copies.
    if (!value.installations.some(entry => entry.packageId === item.id && entry.upgradedFrom === input.upgradedFrom)) {
      value.installations.push({ id: randomUUID(), packageId: item.id, by: actor, at: new Date().toISOString(),
        ...(input.upgradedFrom ? { upgradedFrom: input.upgradedFrom } : {}) });
    }
    return save();
  }
  return { snapshot, execute, exportPackage };
}
export type AgentPackages = ReturnType<typeof createAgentPackages>;
export type AgentPackageSnapshot = ReturnType<AgentPackages["snapshot"]>;
