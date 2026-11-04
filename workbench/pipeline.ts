import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { isDeclarationMaterial, materialsSchema, type Material } from "./materials.js";
import { agentConfigurableSchema, configurableStages } from "./agent-configurables.js";
import { botPolicySchema } from "./bot-schema.js";
import type { Role } from "../registry/roles.js";
import { outputDigest, reviewSourceHash, fileSourceSchema, type ReviewSource, type ApprovalRecord, type OutputRevision } from "./review-evidence.js";

const text = z.string().trim().min(1).max(4000);
const stageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), name: z.string().trim().min(1).max(80),
  agent: z.string().trim().min(1).max(80), instructions: text,
  model: z.string().trim().min(1).max(200), context: z.string().trim().max(2000),
  inputStages: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/)).max(11)
    .refine(ids => new Set(ids).size === ids.length, "Input bindings must be unique.").optional(),
  outputContract: z.string().trim().max(2000).optional(),
  bot: botPolicySchema.optional(),
  /** An approved Model Studio assistant that staffs this stage. Unset means the named agent works by hand. */
  assistantId: z.string().uuid().optional(),
  approval: z.boolean(), jiraStatus: z.string().trim().min(1).max(80),
}).strict();
export const pipelineSchema = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(500),
  jira: z.object({ enabled: z.boolean(), project: z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/), issueType: z.string().trim().min(1).max(80) }).strict(),
  stages: z.array(stageSchema).min(1).max(12),
  configurables: z.array(agentConfigurableSchema).max(30).optional(),
}).strict().superRefine((value, context) => {
  const agentIds = new Set<string>();
  value.configurables?.forEach((agent, index) => {
    if (agentIds.has(agent.id)) context.addIssue({ code: "custom", path: ["configurables", index, "id"], message: "Agent IDs must be unique." });
    agentIds.add(agent.id);
  });
  const ids = new Set<string>();
  value.stages.forEach((stage, index) => {
    if (ids.has(stage.id)) context.addIssue({ code: "custom", path: ["stages", index, "id"], message: "Stage IDs must be unique." });
    stage.inputStages?.forEach((source, binding) => {
      if (!ids.has(source)) context.addIssue({ code: "custom", path: ["stages", index, "inputStages", binding],
        message: "Bind only an earlier stage in this workflow. Missing, self and forward bindings are not executable." });
    });
    ids.add(stage.id);
  });
});
export type PipelineConfig = z.infer<typeof pipelineSchema>;
/** The starting workflow. Defined with the other templates so the browser can read it without Node modules. */
import { DEVELOPMENT_WORKFLOW } from "./workflow-templates.js";
export const DEFAULT_PIPELINE: PipelineConfig = DEVELOPMENT_WORKFLOW;
export const pipelineCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), expectedVersion: z.number().int().min(1), config: pipelineSchema }).strict(),
  z.object({ action: z.literal("start"), requestId: z.string().uuid(), title: z.string().trim().min(3).max(160), brief: text,
    expectedVersion: z.number().int().min(1).optional(), configurableId: z.string().uuid().optional(),
    materials: materialsSchema.optional(), issueKey: z.string().regex(/^[A-Z][A-Z0-9]{1,19}-[1-9][0-9]*$/).optional() }).strict(),
  z.object({ action: z.enum(["complete", "approve", "pause", "resume", "block", "retry", "cancel"]),
    runId: z.string().uuid(), expectedRevision: z.number().int().min(1), note: text.optional() }).strict(),
  /** Replace the reference material a running workflow carries. The owner or an admin; the run keeps its own frozen copy. */
  z.object({ action: z.literal("materials"), runId: z.string().uuid(), expectedRevision: z.number().int().min(1), materials: materialsSchema }).strict(),
  z.object({ action: z.literal("request_changes"), runId: z.string().uuid(), expectedRevision: z.number().int().min(1), note: text }).strict(),
  z.object({ action: z.literal("revise"), runId: z.string().uuid(), expectedRevision: z.number().int().min(1), note: text, reason: text }).strict(),
]);
export type PipelineCommand = z.infer<typeof pipelineCommandSchema>;
export interface PipelineEvent { id: string; at: string; actor: string; stage: string; action: string; detail: string }
export interface JiraPreview { id: string; eventId: string; action: "create_issue" | "update_issue"; project: string; issueType: string;
  issueKey: string | null; summary: string; status: string; comment: string; delivery: "preview" }
/** What an assistant prepared for a stage. A person turns it into the stage's output, or ignores it. */
export interface StageDraft { text: string; hash: string; by: string; jobId: string; at: string }
export interface StageRun { status: "pending" | "active" | "awaiting_review" | "complete"; output: string; outputHash: string;
  outputBy: string; approvals: string[]; completedAt?: string; draft?: StageDraft;
  outputVersion?: number; sourceHash?: string; approvalRecords?: ApprovalRecord[]; revisions?: OutputRevision[];
  executionSources?: ReviewSource[] }
export interface PipelineRun {
  id: string; requestId: string; workspaceId: string; owner: string; title: string; brief: string; issueKey: string | null;
  config: PipelineConfig; version: number; revision: number; requiredApprovals: number; createdAt: string; updatedAt: string;
  status: "running" | "paused" | "blocked" | "complete" | "cancelled"; current: number; stages: StageRun[];
  events: PipelineEvent[]; jira: JiraPreview[]; materials?: Material[]; workflowSource?: Material;
  sourceHistory?: Record<string, ReviewSource[]>;
}

function currentSources(run: PipelineRun): ReviewSource[] {
  return [...(run.workflowSource ? [run.workflowSource] : []), ...(run.materials ?? []), ...(run.stages[run.current]?.executionSources ?? [])];
}
function recordOutputRevision(run: PipelineRun, actor: string, after: string, reason: string, kind: OutputRevision["kind"]): void {
  const stage = run.stages[run.current]!;
  if ((stage.revisions?.length ?? 0) >= 100) throw new PipelineError(409, "This stage reached its revision limit. Export its history and start a new work item.");
  const sources = currentSources(run); const sourceHash = reviewSourceHash(sources);
  (run.sourceHistory ??= {})[sourceHash] ??= structuredClone(sources);
  const version = (stage.outputVersion ?? 0) + 1;
  (stage.revisions ??= []).push({ version, kind, by: actor, at: new Date().toISOString(), reason,
    before: stage.output, after, beforeHash: outputDigest(stage.output), afterHash: outputDigest(after), sourceHash,
    priorApprovers: [...stage.approvals], priorApprovals: structuredClone(stage.approvalRecords ?? []) });
  stage.outputVersion = version; stage.sourceHash = sourceHash;
  stage.output = after; stage.outputHash = outputDigest(after);
  stage.approvals = []; stage.approvalRecords = [];
}
/** Where this workspace's state lives. "file" means it survives a restart. */
export type StorageMode = "memory" | "file";
export interface PipelineSnapshot { config: PipelineConfig; version: number; runs: PipelineRun[]; storage: StorageMode; jiraDelivery: "preview" }
export class PipelineError extends Error { constructor(readonly status: number, message: string) { super(message); } }
/**
 * Checks the engine cannot make on its own. The assistant guard answers
 * "can this assistant work right now?" with a reason when it cannot, so a
 * stage is never bound to, or started with, a disabled assistant or a
 * retired release. The Model Studio owns that answer; the engine only asks.
 */
export interface PipelineGuards { assistant?(workspace: string, assistantId: string): string | undefined }
/** A draft arriving from the scheduler. Not a command: it is never accepted over HTTP. */
export interface DraftInput { runId: string; stageId: string; expectedRevision: number; text: string; by: string; jobId: string }
export interface PipelineEngine {
  snapshot(workspace: string): PipelineSnapshot;
  start?(workspace: string, actor: string, roles: readonly Role[], raw: unknown, requiredApprovals: number): Promise<PipelineSnapshot>;
  execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, requiredApprovals: number, workflowSource?: Material, executionSources?: ReviewSource[]): PipelineSnapshot;
  /** Attach an assistant's draft to the active stage of a running workflow. The stage stays active; only a person completes it. */
  draft(workspace: string, input: DraftInput): PipelineSnapshot;
}

/**
 * What a persistent engine needs from storage. Kept to two methods so the
 * engine cannot grow a dependency on how storage works.
 */
export interface PipelinePersistence {
  read(workspace: string): { config: PipelineConfig; version: number; runs: PipelineRun[] } | undefined;
  commit(workspace: string, state: { config: PipelineConfig; version: number; runs: PipelineRun[] }): void;
}

// Runs own their configuration so a later edit cannot silently change a gate
// or redirect a Jira action that someone has already reviewed.
export function memoryPipelines(guards: PipelineGuards = {}): PipelineEngine {
  return createEngine(undefined, guards);
}

/**
 * The same engine, writing through to durable storage.
 *
 * Deliberately not a second implementation: every transition rule below is
 * shared, so a gate cannot be enforced in one engine and missed in the other.
 * The only difference is where state comes from and that a command is
 * persisted before its result is visible.
 */
export function filePipelines(store: PipelinePersistence, guards: PipelineGuards = {}): PipelineEngine {
  return createEngine(store, guards);
}

function createEngine(persistence: PipelinePersistence | undefined, guards: PipelineGuards): PipelineEngine {
  const mode: StorageMode = persistence ? "file" : "memory";
  const workspaces = new Map<string, { config: PipelineConfig; version: number; runs: PipelineRun[] }>();
  function state(workspace: string) {
    let value = workspaces.get(workspace);
    if (!value) {
      // A persistent engine asks storage first. A read that throws is a
      // corrupt or unreadable workspace and must reach the caller rather
      // than quietly becoming a new empty one.
      const stored = persistence?.read(workspace);
      value = stored ? { config: stored.config, version: stored.version, runs: stored.runs }
        : { config: structuredClone(DEFAULT_PIPELINE), version: 1, runs: [] };
      workspaces.set(workspace, value);
    }
    return value;
  }
  function snapshot(workspace: string): PipelineSnapshot {
    return structuredClone({ ...state(workspace), storage: mode, jiraDelivery: "preview" });
  }
  function event(run: PipelineRun, actor: string, action: string, detail: string): PipelineEvent {
    const item = { id: randomUUID(), at: new Date().toISOString(), actor, stage: run.config.stages[run.current]!.id, action, detail };
    run.events.push(item); run.updatedAt = item.at; return item;
  }
  function jira(run: PipelineRun, item: PipelineEvent, status: string) {
    if (!run.config.jira.enabled) return;
    run.jira.push({ id: randomUUID(), eventId: item.id, action: item.action === "started" && !run.issueKey ? "create_issue" : "update_issue",
      project: run.config.jira.project, issueType: run.config.jira.issueType, issueKey: run.issueKey,
      summary: run.title, status, comment: `${item.stage}: ${item.detail}`, delivery: "preview" });
  }
  /** Every bound assistant must be usable, or the stage that names it is refused. */
  function checkAssistants(workspace: string, config: PipelineConfig): void {
    for (const stage of config.stages) {
      if (!stage.assistantId) continue;
      if (!guards.assistant) throw new PipelineError(409, `Stage "${stage.name}" names an assistant, but Model Studio is not configured here.`);
      const reason = guards.assistant(workspace, stage.assistantId);
      if (reason) throw new PipelineError(409, `Stage "${stage.name}": ${reason}`);
    }
  }
  function advance(run: PipelineRun, actor: string) {
    const stage = run.stages[run.current]!;
    stage.status = "complete"; stage.completedAt = new Date().toISOString();
    const item = event(run, actor, "stage_completed", stage.output);
    jira(run, item, run.config.stages[run.current]!.jiraStatus);
    if (run.current === run.stages.length - 1) { run.status = "complete"; event(run, actor, "run_completed", "All stages completed."); }
    else { run.current++; run.stages[run.current]!.status = "active"; event(run, actor, "handoff", "Previous outputs are available to this stage."); }
  }
  return {
    snapshot,
    draft(workspace, input) {
      const live = state(workspace);
      const value = persistence ? structuredClone(live) : live;
      const run = value.runs.find(item => item.id === input.runId);
      if (!run) throw new PipelineError(404, "Run not found in this workspace.");
      if (run.revision !== input.expectedRevision) throw new PipelineError(409, "This run changed. Refresh before acting.");
      const index = run.config.stages.findIndex(stage => stage.id === input.stageId);
      if (run.status !== "running" || index !== run.current || run.stages[index]!.status !== "active") throw new PipelineError(409, "That stage is no longer active.");
      const text = input.text.trim();
      if (text.length > 4000) throw new PipelineError(400, "A draft must not exceed 4000 characters; it was not saved.");
      if (!text) throw new PipelineError(400, "A draft needs text.");
      run.stages[index]!.draft = { text, hash: createHash("sha256").update(text).digest("hex"), by: input.by, jobId: input.jobId, at: new Date().toISOString() };
      event(run, input.by, "draft_ready", `Draft prepared by ${input.by}. A person completes the stage with it or writes their own output.`);
      run.revision++;
      if (persistence) { persistence.commit(workspace, { ...persistence.read(workspace), ...value }); workspaces.set(workspace, value); }
      return snapshot(workspace);
    },
    execute(workspace, actor, roles, raw, requiredApprovals, workflowSource, executionSources) {
      if (!roles.length) throw new PipelineError(403, "Workspace membership is required.");
      const input = pipelineCommandSchema.parse(raw);
      // A working copy. Every mutation below lands here, and the live state
      // is replaced only once the command has succeeded and been persisted,
      // so a failed commit cannot leave a change visible in memory.
      const live = state(workspace);
      const value = persistence ? structuredClone(live) : live;
      const publish = (): PipelineSnapshot => {
        if (persistence) {
          // Jira can settle while this engine holds an older snapshot. Preserve
          // the other fields from disk while committing only pipeline changes.
          persistence.commit(workspace, { ...persistence.read(workspace), ...value });
          workspaces.set(workspace, value);
        }
        return snapshot(workspace);
      };
      const admin = roles.includes("admin");
      if (input.action === "configure") {
        if (!admin) throw new PipelineError(403, "An admin must change pipeline configuration.");
        if (input.expectedVersion !== value.version) throw new PipelineError(409, "Configuration changed. Refresh before saving.");
        checkAssistants(workspace, input.config);
        value.config = structuredClone(input.config); value.version++; return publish();
      }
      if (input.action === "start") {
        if (!admin && !roles.includes("author")) throw new PipelineError(403, "An author or admin must start a run.");
        const existing = value.runs.find(run => run.requestId === input.requestId);
        if (existing) {
          if (existing.owner !== actor || existing.title !== input.title || existing.brief !== input.brief || existing.issueKey !== (input.issueKey ?? null)
            || JSON.stringify(existing.materials ?? []) !== JSON.stringify(input.materials ?? [])) {
            throw new PipelineError(409, "This request ID was already used for different work.");
          }
          if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
            throw new PipelineError(409, "This request ID belongs to another workflow version.");
          }
          if (input.configurableId) {
            const agent = existing.config.configurables?.find(item => item.id === input.configurableId);
            if (!agent || !configurableStages(existing.config, agent).length) throw new PipelineError(409, "This run does not use the saved agent.");
          }
          return publish();
        }
        if (input.materials?.some(isDeclarationMaterial) && !workflowSource) throw new PipelineError(409, "OpenFEMA declaration runs require verified Foundry evidence.");
        if (input.expectedVersion !== undefined && input.expectedVersion !== value.version) throw new PipelineError(409, "Workflow changed. Refresh before starting.");
        if (input.configurableId) {
          if (input.expectedVersion === undefined) throw new PipelineError(400, "Agent runs require a workflow version.");
          const agent = value.config.configurables?.find(item => item.id === input.configurableId);
          if (!agent || !configurableStages(value.config, agent).length) throw new PipelineError(409, "Assign the saved agent to a stage before starting.");
        }
        if (value.runs.length >= 100) throw new PipelineError(409, "This in-memory workspace holds at most 100 runs.");
        if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 10) throw new PipelineError(400, "Invalid approval policy.");
        if (input.issueKey && !input.issueKey.startsWith(value.config.jira.project + "-")) throw new PipelineError(400, "The issue key must match the configured Jira project.");
        // A run freezes its configuration, so an assistant that cannot work
        // today must be fixed before the run exists rather than found later.
        checkAssistants(workspace, value.config);
        const at = new Date().toISOString();
        const run: PipelineRun = { id: randomUUID(), requestId: input.requestId, workspaceId: workspace, owner: actor,
          title: input.title, brief: input.brief, ...(workflowSource ? { workflowSource: structuredClone(workflowSource) } : {}), ...(input.materials ? { materials: structuredClone(input.materials) } : {}), issueKey: input.issueKey ?? null, config: structuredClone(value.config),
          version: value.version, revision: 1, requiredApprovals, createdAt: at, updatedAt: at, status: "running", current: 0,
          stages: value.config.stages.map((_, index) => ({ status: index ? "pending" : "active", output: "", outputHash: "", outputBy: "", approvals: [] })), events: [], jira: [] };
        const item = event(run, actor, "started", input.brief); jira(run, item, run.config.stages[0]!.jiraStatus);
        value.runs.unshift(run); return publish();
      }
      const run = value.runs.find(item => item.id === input.runId);
      if (!run) throw new PipelineError(404, "Run not found in this workspace.");
      if (run.revision !== input.expectedRevision) throw new PipelineError(409, "This run changed. Refresh before acting.");
      if (run.status === "complete" || run.status === "cancelled") throw new PipelineError(409, "This run is closed.");
      if (run.events.length >= 500) throw new PipelineError(409, "This run reached its event limit. Start a new run.");
      const stage = run.stages[run.current]!;
      if (input.action === "approve") {
        if (!admin && !roles.includes("approver")) throw new PipelineError(403, "A reviewer must approve this handoff.");
        if (actor === stage.outputBy || actor === run.owner) throw new PipelineError(403, "The run owner and output author cannot approve this handoff.");
        if (run.status !== "running" || stage.status !== "awaiting_review") throw new PipelineError(409, "This stage is not awaiting review.");
        if (stage.approvals.includes(actor)) throw new PipelineError(409, "You already approved this output.");
        if (createHash("sha256").update(stage.output).digest("hex") !== stage.outputHash) throw new PipelineError(409, "The reviewed output changed.");
        const sourceHash = reviewSourceHash(currentSources(run));
        if (stage.sourceHash && stage.sourceHash !== sourceHash) throw new PipelineError(409, "The reviewed source evidence changed. Reopen and resubmit the output.");
        if (!stage.sourceHash && stage.approvals.length) throw new PipelineError(409, "This historical review lacks source bindings. Reopen and resubmit before collecting new approvals.");
        stage.sourceHash = sourceHash; stage.outputVersion ??= 1;
        (run.sourceHistory ??= {})[sourceHash] ??= structuredClone(currentSources(run));
        (stage.approvalRecords ??= []).push({ actor, at: new Date().toISOString(), version: stage.outputVersion, outputHash: stage.outputHash, sourceHash });
        stage.approvals.push(actor); event(run, actor, "approved", `Approved output ${stage.outputHash}.`);
        if (stage.approvals.length >= run.requiredApprovals) advance(run, actor);
      } else if (input.action === "request_changes") {
        if ((!admin && !roles.includes("approver")) || actor === run.owner || actor === stage.outputBy) throw new PipelineError(403, "An independent reviewer must request changes.");
        if (run.status !== "running" || stage.status !== "awaiting_review") throw new PipelineError(409, "This stage is not awaiting review.");
        recordOutputRevision(run, actor, stage.output, input.note, "changes_requested");
        stage.status = "active";
        event(run, actor, "changes_requested", input.note);
      } else {
        if (!admin && (actor !== run.owner || !roles.includes("author"))) throw new PipelineError(403, "The run owner or an admin must perform this action.");
        if (input.action === "materials") {
          // Every reviewer must see the same sources while signatures are being collected.
          if (stage.status === "awaiting_review") throw new PipelineError(409, "The source material is under review. Finish this review or start a new run with the corrected evidence.");
          const priorSample = (run.materials ?? []).filter(isDeclarationMaterial);
          if (JSON.stringify(priorSample) !== JSON.stringify(input.materials.filter(isDeclarationMaterial))) {
            throw new PipelineError(409, "Start a new run to verify a different declaration sample against Foundry.");
          }
          run.materials = structuredClone(input.materials);
          event(run, actor, "materials", input.materials.length ? `Reference material: ${input.materials.map((item) => item.title).join(", ")}.` : "Reference material cleared.");
        } else if (input.action === "revise") {
          if (run.status !== "running" || (stage.status !== "active" && stage.status !== "awaiting_review") || !stage.output) throw new PipelineError(409, "Only an open recorded output can be revised.");
          recordOutputRevision(run, actor, input.note, input.reason, "revised");
          stage.outputBy = actor; stage.status = "active";
          event(run, actor, "output_revised", input.reason);
        } else if (input.action === "complete") {
          if (run.status !== "running" || stage.status !== "active") throw new PipelineError(409, "This stage cannot be completed now.");
          if (!input.note) throw new PipelineError(400, "Provide output or evidence for the handoff.");
          // Only a server-owned execution supplies this argument; it is not an HTTP command field.
          if ((stage.revisions?.length ?? 0) >= 100) throw new PipelineError(409, "This stage reached its revision limit. Export its history and start a new work item.");
          if (executionSources) {
            const sources = z.array(fileSourceSchema).max(12).parse(executionSources);
            if (sources.some(source => source.sha256 !== outputDigest(source.content))) throw new PipelineError(409, "Execution source content does not match its recorded hash.");
            stage.executionSources = sources;
          }
          recordOutputRevision(run, actor, input.note, stage.output ? "Resubmitted for review." : "Initial handoff.", "submitted");
          stage.outputBy = actor;
          if (run.config.stages[run.current]!.approval) { stage.status = "awaiting_review"; event(run, actor, "review_requested", input.note); }
          else advance(run, actor);
        } else if (input.action === "pause" && run.status === "running") { run.status = "paused"; event(run, actor, "paused", input.note ?? "Run paused."); }
        else if (input.action === "resume" && run.status === "paused") { run.status = "running"; event(run, actor, "resumed", "Run resumed."); }
        else if (input.action === "block" && run.status === "running" && stage.status === "active") {
          if (!input.note) throw new PipelineError(400, "Describe the blocker.");
          run.status = "blocked"; event(run, actor, "blocked", input.note);
        } else if (input.action === "retry" && run.status === "blocked") { run.status = "running"; event(run, actor, "retried", "Manual stage reopened; no external action repeated."); }
        else if (input.action === "cancel") { run.status = "cancelled"; event(run, actor, "cancelled", input.note ?? "Run cancelled."); }
        else throw new PipelineError(409, "This action is not available in the current state.");
      }
      run.revision++; return publish();
    },
  };
}
