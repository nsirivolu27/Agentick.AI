import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PermissionError, type Role } from "../registry/roles.js";
import { declarationSample } from "./declaration-sample.js";
import { PipelineError, type PipelineEngine } from "./pipeline.js";
import type { Material } from "./materials.js";
import type { OntologyDirectory } from "./ontology.js";
import { registerWorkspaceReads } from "./workspace-read-tools.js";
import { registerOntologyTools } from "./ontology-mcp.js";
import { readToolSession } from "./tool-session.js";

const startSchema = z.object({
  action: z.literal("start"), requestId: z.string().uuid(), area: z.literal("VA"),
  county: z.string().trim().max(80).regex(/^[\p{L}\s.'()-]*$/u),
  question: z.string().trim().min(3).max(2000), scope: z.enum(["snapshot", "bounded_live"]),
}).strict();
const commandSchema = z.union([startSchema, z.object({
  action: z.enum(["cancel", "retry"]), id: z.string().uuid(),
}).strict()]);
type Request = z.infer<typeof startSchema>;
type Sample = ReturnType<typeof declarationSample>;
export interface AnalystTrace {
  tool: string; inputs: Record<string, string>; reason: string; startedAt: string;
  durationMs: number; outcome: "running" | "succeeded" | "failed" | "cancelled"; summary: string;
}
export interface AnalystJob {
  id: string; runId: string; workspaceId: string; owner: string; request: Request;
  status: "queued" | "running" | "failed" | "cancelled" | "blocked" | "completed";
  attempt: number; createdAt: string; updatedAt: string; error: string | null;
  /** Evidence-only report; submission and approval still belong to the pipeline. */
  report?: string;
  result: "matched" | "limited" | null; trace: AnalystTrace[];
  sources: { title: string; url: string; retrievedAt: string; hash: string; rows: number;
    declarations: number; mode: "saved-snapshot" | "live-openfema"; excerpt: string; content: string }[];
}
export interface AnalystPersistence { read(): AnalystJob[]; write(jobs: AnalystJob[]): void }
export interface AnalystSnapshot { jobs: AnalystJob[]; controller: "rule-based"; foundry: "offline-replay" }
const normalize = (value: string) => value.replace(/\s*(?:\(county\)| county)$/i, "").trim().toLowerCase();

/** Fixed public endpoint; no caller-controlled URL, headers, credentials or executable tools. */
export async function boundedDeclarations(area: string, county: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<Material> {
  const rows = new Map<string, Sample["records"][number]>();
  const queries: string[] = []; let returnedRows = 0;
  const name = county.replace(/\s*(?:\(county\)| county)$/i, "").trim().replace(/\b\p{L}/gu, char => char.toUpperCase()).replaceAll("'", "''");
  const first = new URL("https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries");
  first.searchParams.set("$filter", `state eq '${area}'${name ? ` and (designatedArea eq '${name} (County)' or designatedArea eq '${name}')` : ""}`);
  first.searchParams.set("$select", "id,disasterNumber,state,declarationDate,incidentType,designatedArea");
  first.searchParams.set("$orderby", "declarationDate desc");
  first.searchParams.set("$top", "5");
  // Two pages, five rows each, one retry per page, a 12-second total deadline.
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  for (let page = 0; page < 2; page++) {
    bounded.throwIfAborted();
    const url = new URL(first); url.searchParams.set("$skip", String(page * 5));
    let payload: unknown;
    for (let retry = 0; retry < 2; retry++) {
      try {
        queries.push(url.href);
        const response = await request(url, { signal: AbortSignal.any([bounded, AbortSignal.timeout(5000)]), redirect: "error" });
        if (!response.ok || !response.body) throw new Error("Public source unavailable");
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 128_000) throw new Error("Source response exceeds limit");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); break;
      } catch {
        bounded.throwIfAborted();
        if (retry === 1) throw new PipelineError(503, "OpenFEMA lookup failed within its bounds. No live result was substituted.");
      }
    }
    const pageRows = z.object({ DisasterDeclarationsSummaries: z.array(z.object({
      id: z.string().min(1).max(120), disasterNumber: z.number().int().positive().safe(),
      state: z.literal(area), declarationDate: z.string().datetime(),
      incidentType: z.string().min(1).max(120), designatedArea: z.string().min(1).max(200),
    })).max(5) }).parse(payload).DisasterDeclarationsSummaries;
    returnedRows += pageRows.length;
    for (const row of pageRows) {
      const old = rows.get(row.id);
      if (old && JSON.stringify(old) !== JSON.stringify(row)) throw new PipelineError(503, "Conflicting source rows; no draft was produced.");
      rows.set(row.id, row);
    }
    if (pageRows.length < 5) break;
  }
  bounded.throwIfAborted();
  return { id: randomUUID(), title: "OpenFEMA bounded live lookup", url: first.href,
    content: JSON.stringify({ metadata: { version: "v2", entityname: "DisasterDeclarationsSummaries",
      rundate: new Date().toISOString(), url: first.pathname + first.search,
      queries, returnedRows, maxPages: 2, maxRecords: 10 },
    DisasterDeclarationsSummaries: [...rows.values()] }) };
}

export function createAnalystRuntime(options: {
  pipelines: PipelineEngine; ontology: OntologyDirectory; material: Material; persistence?: AnalystPersistence; request?: typeof fetch;
  authorize: (workspace: string, actor: string) => Promise<readonly Role[]>;
}) {
  const jobs = options.persistence?.read() ?? [];
  const controllers = new Map<string, AbortController>();
  const tasks = new Map<string, Promise<void>>();
  const save = () => options.persistence?.write(jobs);
  for (const job of jobs) {
    if (!["queued", "running"].includes(job.status)) continue;
    const run = options.pipelines.snapshot(job.workspaceId).runs.find(run => run.id === job.runId);
    job.status = run?.stages[run.current]?.draft?.jobId === job.id ? "completed" : "failed";
    job.error = job.status === "failed" ? "Execution interrupted by restart. Review the saved trace before retrying." : null;
    for (const entry of job.trace) if (entry.outcome === "running") { entry.outcome = "failed"; entry.summary = "Interrupted by restart; result unknown."; }
  }
  save();
  function find(workspace: string, id: string) {
    const job = jobs.find(job => job.workspaceId === workspace && job.id === id);
    if (!job) throw new PipelineError(404, "Analyst run not found in this workspace.");
    return job;
  }
  function snapshot(workspace: string): AnalystSnapshot {
    return { jobs: structuredClone(jobs.filter(job => job.workspaceId === workspace)), controller: "rule-based", foundry: "offline-replay" };
  }
  function enqueue(job: AnalystJob) {
    const controller = new AbortController(); controllers.set(job.id, controller);
    const task = Promise.resolve().then(() => execute(job, controller.signal));
    tasks.set(job.id, task);
    void task.finally(() => { controllers.delete(job.id); tasks.delete(job.id); }).catch(() => undefined);
  }
  async function execute(job: AnalystJob, signal: AbortSignal) {
    const client = new Client({ name: "workspace-public-data-analyst", version: "1" });
    const server = new McpServer({ name: "scoped-analyst-reads", version: "1" });
    const reader = options.ontology(job.workspaceId);
    const session = readToolSession({ scope: job.workspaceId, actor: job.owner,
      tools: ["get_pipeline_run", "summarize_declaration_sample", "get_ontology_object",
        ...(job.request.scope === "bounded_live" ? ["lookup_openfema_declarations" as const] : [])],
      maxCalls: 3, timeoutMs: 15_000 },
      async () => (await options.authorize(job.workspaceId, job.owner)).some(role => role === "author" || role === "admin"));
    try {
      signal.throwIfAborted();
      job.status = "running"; job.updatedAt = new Date().toISOString(); save();
      if (!reader) throw new Error("No scoped ontology");
      registerWorkspaceReads(server, job.workspaceId, options.pipelines, undefined, reader);
      registerOntologyTools(server, reader);
      server.registerTool("lookup_openfema_declarations", {
        description: "Explicit bounded read of OpenFEMA: at most ten rows, two pages, one retry per page, twelve seconds.",
        inputSchema: z.object({ area: z.literal("VA"), county: z.string().max(80) }).strict(),
        annotations: { readOnlyHint: true },
      }, async ({ area, county }, extra) => ({ content: [{ type: "text", text: JSON.stringify(await boundedDeclarations(area, county, AbortSignal.any([signal, extra.signal]), options.request)) }] }));
      const [caller, receiver] = InMemoryTransport.createLinkedPair();
      await server.connect(receiver); await client.connect(caller);
      async function read<T>(tool: string, inputs: Record<string, string>, reason: string, summarize: (result: T) => string): Promise<T> {
        signal.throwIfAborted();
        if (!(await options.authorize(job.workspaceId, job.owner)).some(role => role === "author" || role === "admin")) throw new PermissionError("Execution membership revoked.");
        signal.throwIfAborted();
        const entry: AnalystTrace = { tool, inputs, reason, startedAt: new Date().toISOString(), durationMs: 0, outcome: "running", summary: "Waiting for the actual tool response." };
        job.trace.push(entry); save(); const start = performance.now();
        try {
          const result = await session.call(tool, signal, bounded =>
            client.callTool({ name: tool, arguments: inputs }, undefined, { signal: bounded }));
          signal.throwIfAborted();
          if (result.isError || !Array.isArray(result.content) || result.content[0]?.type !== "text") throw new Error("Tool failed");
          const value = JSON.parse(result.content[0].text as string) as T;
          entry.outcome = "succeeded"; entry.summary = summarize(value); return value;
        } catch {
          entry.outcome = signal.aborted ? "cancelled" : "failed";
          entry.summary = signal.aborted ? "Cancelled; no result accepted." : "Source read failed. No fabricated result was substituted.";
          throw new Error(entry.summary);
        } finally { entry.durationMs = Math.round(performance.now() - start); save(); }
      }
      const run = await read<{ id: string; revision: number; materials: Material[]; requiredApprovals: number }>("get_pipeline_run", { runId: job.runId },
        "Read the saved request and the exact source reference in this workspace.", run => `Saved request ${run.id}; ${run.materials.length} reference(s).`);
      const material = run.materials.find(item => item.id === options.material.id);
      if (!material) throw new Error("Required source removed");
      let sample = await read<Sample>("summarize_declaration_sample", { runId: run.id, materialId: material.id },
        "Count county rows separately from unique declarations; verify snapshot rows through the offline Foundry replay.",
        result => `${result.areaRecords} county rows; ${result.distinctDeclarations} distinct declaration(s). Offline Foundry replay, not live Foundry.`);
      const addSource = (sample: Sample, mode: AnalystJob["sources"][number]["mode"], content: string) => {
        job.sources.push({ title: sample.source, url: sample.sourceUrl, retrievedAt: sample.retrievedAt,
          hash: sample.contentSha256, rows: sample.areaRecords, declarations: sample.distinctDeclarations, mode,
          excerpt: sample.records.map(row => `${row.designatedArea}: #${row.disasterNumber}`).join("; "), content }); save();
      };
      addSource(sample, "saved-snapshot", material.content);
      let matched = sample.records.find(row => normalize(row.designatedArea) === normalize(job.request.county));
      let live: Material | undefined;
      if (job.request.scope === "bounded_live") {
        live = await read<Material>("lookup_openfema_declarations", { area: job.request.area, county: job.request.county },
          "The member explicitly opted into a fresh bounded public-source query. The saved sample is not a full-source answer.",
          result => `${declarationSample(result).areaRecords} row(s) saved from OpenFEMA; at most two pages / ten rows.`);
        sample = declarationSample(live); addSource(sample, "live-openfema", live.content);
        matched = sample.records.find(row => normalize(row.designatedArea) === normalize(job.request.county));
      } else if (matched) {
        await read<{ primaryKey: string }>("get_ontology_object", { objectType: "Declaration", primaryKey: matched.id },
          "The requested county matches a saved row. Inspect that row's mapped object; this adapter is offline replay.",
          object => `Read Declaration ${object.primaryKey} from offline replay.`);
      }
      signal.throwIfAborted();
      const summary = !job.request.county
        ? `${sample.areaRecords} county rows represent ${sample.distinctDeclarations} distinct declaration(s) in this bounded source.`
        : matched ? `${matched.designatedArea} appears under declaration #${matched.disasterNumber} (${matched.incidentType}). Source row: ${matched.id}.`
        : `${job.request.county} has no matching row in this bounded ${live ? "lookup" : "saved sample"}. This does not establish that the county was unaffected.`;
      const text = [
        "Rule-based public-data draft — no model inference.", `Question: ${job.request.question}`, summary,
        `Source [1]: ${sample.sourceUrl}`, `Retrieved: ${sample.retrievedAt}`, `Snapshot SHA-256: ${sample.contentSha256}`,
        live ? "Live OpenFEMA read; at most two pages / ten rows, one retry per page, 12-second deadline. Counts are not full-dataset totals."
          : "Saved OpenFEMA snapshot; offline Foundry replay, not a live Foundry connection.",
        "The saved five-row fixture represents one declaration, not five disasters. Missing counties are not evidence of no impact.",
        "Scope: declaration records only. Eligibility and assistance decisions are outside this draft.",
        "A person must inspect the cited evidence and submit this draft. Independent reviewers must still approve the handoff.",
      ].join("\n");
      // A cancellation or changed source/run cannot turn into a successful draft.
      const currentRun = options.pipelines.snapshot(job.workspaceId).runs.find(item => item.id === run.id);
      if (!currentRun || currentRun.revision !== run.revision || currentRun.status !== "running") throw new Error("Work item changed during execution");
      const currentRoles = await options.authorize(job.workspaceId, job.owner);
      if (!currentRoles.some(role => role === "author" || role === "admin")) throw new PermissionError("Execution membership revoked.");
      signal.throwIfAborted();
      job.report = text;
      if (live) {
        // The existing company layer freezes the Foundry-verified declaration
        // sample. Do not disguise fresh records as already-verified material,
        // or sign a handoff against evidence that is absent from that binding.
        job.result = job.request.county && !matched ? "limited" : "matched";
        job.status = "blocked";
        job.error = "Live OpenFEMA evidence was saved, but it is not bound to this run's verified Foundry source. Draft submission is unavailable until authorized source grounding is configured. The saved-snapshot workflow remains available.";
        return;
      }
      signal.throwIfAborted();
      options.pipelines.draft(job.workspaceId, { runId: run.id,
        stageId: options.pipelines.snapshot(job.workspaceId).runs.find(item => item.id === run.id)!.config.stages[0]!.id,
        expectedRevision: run.revision, text, by: "Rule-based OpenFEMA analyst", jobId: job.id });
      job.result = job.request.county && !matched ? "limited" : "matched";
      job.status = "completed"; job.error = null;
    } catch {
      if (job.status !== "cancelled") {
        job.status = signal.aborted ? "cancelled" : "failed";
        job.error = signal.aborted ? "Cancelled. No new draft was accepted."
          : "The analyst could not verify the source or the work item changed. Review the trace and retry; no result was fabricated.";
      }
    } finally {
      session.close();
      await Promise.allSettled([client.close(), server.close()]);
      job.updatedAt = new Date().toISOString(); save();
    }
  }
  return {
    snapshot,
    async command(workspace: string, actor: string, roles: readonly Role[], raw: unknown, approvals: number) {
      const input = commandSchema.parse(raw);
      if (!roles.includes("author") && !roles.includes("admin")) throw new PermissionError("An author or admin must run the analyst.");
      if (input.action === "start") {
        const existing = jobs.find(job => job.workspaceId === workspace && job.request.requestId === input.requestId);
        if (existing) {
          if (existing.owner !== actor || JSON.stringify(existing.request) !== JSON.stringify(input)) throw new PipelineError(409, "Request ID already used for different work.");
          return structuredClone(existing);
        }
        if (jobs.length >= 100 || jobs.filter(job => ["queued", "running"].includes(job.status)).length >= 2) throw new PipelineError(409, "Analyst capacity reached. Finish or cancel active work.");
        const pipeline = options.pipelines.snapshot(workspace);
        if (pipeline.config.stages.length !== 1 || !pipeline.config.stages[0]?.approval || pipeline.config.stages[0]?.bot || pipeline.config.stages[0]?.assistantId) throw new PipelineError(409, "This analyst requires the configured single-stage declaration review workflow.");
        const command = { action: "start", requestId: input.requestId, expectedVersion: pipeline.version,
          title: input.county ? `${input.county} · public data request` : "Virginia public data request", brief: input.question, materials: [options.material] };
        const result = options.pipelines.start ? await options.pipelines.start(workspace, actor, roles, command, approvals)
          : options.pipelines.execute(workspace, actor, roles, command, approvals);
        const run = result.runs.find(run => run.requestId === input.requestId)!;
        const job: AnalystJob = { id: randomUUID(), runId: run.id, workspaceId: workspace, owner: actor, request: input,
          status: "queued", attempt: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          trace: [], sources: [], error: null, result: null };
        jobs.push(job); save(); enqueue(job); return structuredClone(job);
      }
      const job = find(workspace, input.id);
      if (job.owner !== actor && !roles.includes("admin")) throw new PermissionError("Only the owner or admin can change this execution.");
      if (input.action === "cancel") {
        if (!["queued", "running"].includes(job.status)) throw new PipelineError(409, "Execution is no longer active.");
        job.status = "cancelled"; job.error = "Cancelled. No new draft was accepted.";
        controllers.get(job.id)?.abort(); save();
      } else {
        if (job.status !== "failed" || job.attempt >= 3) throw new PipelineError(409, "Only a failed run with fewer than three attempts can retry.");
        const run = options.pipelines.snapshot(workspace).runs.find(run => run.id === job.runId);
        if (!run || run.status !== "running" || run.stages[0]?.status !== "active") throw new PipelineError(409, "This handoff is no longer editable.");
        await tasks.get(job.id);
        job.status = "queued"; job.attempt++; job.error = null; delete job.report; save(); enqueue(job);
      }
      return structuredClone(job);
    },
    async close() { for (const controller of controllers.values()) controller.abort(); await Promise.allSettled(tasks.values()); },
  };
}
export type AnalystRuntime = ReturnType<typeof createAnalystRuntime>;
