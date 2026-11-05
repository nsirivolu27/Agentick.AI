import { ZenfluenceError, type ZenfluenceDirectory } from "./zenfluence.js";
import { newlyAssigned } from "./agent-configurables.js";
import { passedCurrentTest } from "./agent-tests-model.js";
import { buildEvaluationBundle } from "./evaluation-bundle.js";
import { pipelineSchema, type PipelineConfig } from "./pipeline.js";
import { zenfluenceCommand } from "./zenfluence-api.js";
import { AutomationError, type AutomationRuntime } from "./automation-runtime.js";
import { ChatHistoryError } from "./chat-history.js";
import type { CompanyAccess } from "./company-access.js";
import { companyPage, companyClientScript } from "./company-page.js";
import { ChatAccessError, type ChatAccess } from "./chat-access.js";
import { handleChatMcp } from "./chat-mcp.js";
import { contextMessages } from "./chat-settings.js";
import { welcomePage } from "./welcome-view.js";
import type { AccountsConfig } from "./accounts.js";
import { accountPublicConfig, loginPage, accountClientScript } from "./account-portal.js";
import { BillingError, type Billing } from "./billing.js";
import { OntologyError, ontologyMaterial, type OntologyDirectory } from "./ontology.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { agentSchema } from "../catalog/schema.js";
import { hashDefinition, isServable, validApprovers } from "../registry/record.js";
import { PermissionError } from "../registry/roles.js";
import { approve, authorDraft, requestChanges, retire, submit, TransitionError, type TransitionContext } from "../registry/transition.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { handleWorkspaceMcp, workspaceMcpOverview } from "./mcp-portal.js";
import { chatRequestSchema, describeToolUse, runBaseChat, runWorkspaceAgent, untilAborted, type ChatConfiguration, type ChatEvent, type MeasuredToolUse } from "./chat.js";
import { GroundingError } from "./chat-grounding.js";
import { buildConnectionsDirectory, createOperationLog } from "./connections-directory.js";
import type { EmailPortal } from "./email.js";

import { PipelineError, type PipelineEngine } from "./pipeline.js";
import type { AgentTestsEngine } from "./agent-tests.js";
import { handlePipelineMcp } from "./pipeline-mcp.js";

import { JiraApiError, type JiraRuntime } from "./jira-runtime.js";
import { JiraError } from "./jira.js";
import { StudioError, type ModelStudio } from "./studio/engine.js";
import { assistantDirectory } from "./assistant-resolver.js";
import type { Scheduler } from "./scheduler.js";
import { CADENCES, type LearningEngine } from "./learning-schedule.js";
import { DocumentError, type DocumentsEngine } from "./documents.js";
import { StudioStorageError } from "./studio/store.js";

import { buildAuditPackage, buildWorkspaceAudit, renderAuditPackage, renderWorkspaceAudit, type AuditActivity } from "./audit-package.js";
import { randomUUID } from "node:crypto";
import { declarationBrief, verifiedDeclarationSample } from "./declaration-sample.js";
import { isDeclarationMaterial } from "./materials.js";

export interface WorkspaceIdentity {
  recentSignIn?: boolean;
  workspaceId: string; actor: string;
  // A standalone MCP credential must not inherit local delivery authority.
  canDeliverJira?: boolean;
  canRunAutomations?: boolean;
}
export interface WorkbenchOptions {
  analyst?: import("./analyst-runtime.js").AnalystRuntime;
  context: TransitionContext;
  // Identity comes from the deployment's authentication system. Accepting an
  // actor in a submitted form would let a writer impersonate an approver.
  authenticate: (request: IncomingMessage) => Promise<WorkspaceIdentity | undefined>;
  assets: ReadonlyMap<string, { type: string; body: string | Buffer }>;
  /**
   * Runs before routing, for checks that are not about identity: which Host
   * and Origin this deployment accepts, and any one-shot session handshake.
   * Returning an error stops the request there. Undefined for every
   * deployment that had none, which is all of them until local mode.
   */
  guard?: (request: IncomingMessage, response: ServerResponse) => { status: number; message: string } | undefined;
  accounts?: AccountsConfig;
  companies?: CompanyAccess;
  billing?: Billing;
  demo?: boolean;
  email?: EmailPortal;
  chat?: ChatConfiguration;
  /** The whole budget for one chat request, model turns and tool calls together. Default two minutes. */
  chatTimeoutMs?: number;
  chatAccess?: ChatAccess;
  ontology?: OntologyDirectory;
  pipelines?: PipelineEngine;
  jira?: JiraRuntime;
  automations?: AutomationRuntime;
  zenfluence?: ZenfluenceDirectory;
  bots?: import("./bot-runtime.js").BotRuntime;
  workspaces?: import("./workspace-directory.js").WorkspaceDirectory;
  mcpAccess?: (workspaceId: string) => { workspaceId: string; tokenFile: string };
  /** The Model Studio: projects, datasets, jobs, evaluations, releases and chatbot profiles. */
  studio?: ModelStudio;
  /** Assistants working their workflow stages on their own. Ticked after every pipeline or studio command. */
  scheduler?: Scheduler;
  /** Projects learning from new content on a rhythm. Ticked with the scheduler. */
  learning?: LearningEngine;
  /** The documentation portal: documents attached to runs or added to projects. */
  documents?: DocumentsEngine;
  /** Agent Studio tests: saved prompts run against a saved agent version, reviewed separately from execution. */
  agentTests?: AgentTestsEngine;
}

const draftSchema = z.object({ definition: agentSchema, expectedHash: z.string().optional() }).strict();
const actionSchema = z.object({
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().max(2_000).optional(),
}).strict();

const learningCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), projectId: z.string().uuid(), cadence: z.enum(CADENCES), pattern: z.string().max(200).optional(), paused: z.boolean().optional() }).strict(),
  z.object({ action: z.enum(["remove", "run"]), projectId: z.string().uuid() }).strict(),
]);
const scheduleCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tick") }).strict(),
  z.object({ action: z.enum(["retry", "cancel"]), jobId: z.string().uuid() }).strict(),
]);

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createWorkbenchServer(options: WorkbenchOptions) {
  // Jobs run in the background; a failure is recorded on the job, never thrown at a request.
  const tickScheduler = (workspaceId: string) => {
    try { options.learning?.tick(workspaceId); } catch { /* a cycle that throws is recorded on its run; the request already answered */ }
    void options.scheduler?.tick(workspaceId).catch(() => undefined);
  };
  if (!options.context.members) throw new Error("The workbench requires a member directory.");
  // Serial writes keep the content check and the following signature on the
  // same version. A database-backed deployment needs a transaction as well.
  let pending: Promise<void> = Promise.resolve();
  const activeChats = new Set<string>();
  // The last real operation through each connector, so the Connections directory can say what actually worked.
  const operations = createOperationLog();
  // What each model proved in this process, per workspace: it followed the required reads, or it did not.
  const measuredToolUse = new Map<string, MeasuredToolUse>();
  const measure = (workspaceId: string, actor: string, model: string, event: ChatEvent) => {
    const key = JSON.stringify([workspaceId, actor, model]);
    if (event.type === "answer" && event.evidence) measuredToolUse.set(key, { at: new Date().toISOString(), grounded: event.evidence.grounded, required: event.evidence.required, calls: event.evidence.calls.length, modelCalls: event.evidence.calls.filter(call => call.initiatedBy === "model" && !call.isError).length });
    if (event.type === "error" && /No answer was accepted/.test(event.message)) measuredToolUse.set(key, { at: new Date().toISOString(), grounded: false, required: [], calls: 0 });
  };
  const withMeasure = (workspaceId: string, actor: string, choices: { id: string; detail: string }[]) => choices.map(choice => {
    const measured = measuredToolUse.get(JSON.stringify([workspaceId, actor, choice.id]));
    return { ...choice, ...(measured ? { measured } : {}), detail: [choice.detail, describeToolUse(measured)].filter(Boolean).join(" · ") };
  });
  return createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const refusal = options.guard?.(request, response);
      if (refusal) throw new RequestError(refusal.status, refusal.message);
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (options.accounts) {
        const issuer = options.accounts.clerk.issuer;
        response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' ${issuer} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ${issuer} https://*.protect.clerk.com; img-src 'self' https://img.clerk.com data:; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      }
      if (options.companies && request.method === "GET" && (path === "/companies" || path === "/company-client.js")) {
        response.setHeader("Content-Type", path === "/companies" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
        response.end(path === "/companies" ? companyPage() : companyClientScript); return;
      }
      if (request.method === "GET" && path === "/welcome") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(welcomePage()); return;
      }
      if (request.method === "GET" && path === "/api/account/config") { send(response, 200, accountPublicConfig(options.accounts)); return; }
      if (request.method === "GET" && (path === "/login" || path === "/account-client.js")) {
        response.setHeader("Content-Type", path === "/login" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
        response.end(path === "/login" ? loginPage(options.accounts, new URL(request.url!, "http://localhost").searchParams.get("next")) : accountClientScript); return;
      }
      if (!path.startsWith("/api/")) {
        const asset = options.assets.get(path);
        if (request.method !== "GET" || !asset) throw new RequestError(404, "Not found.");
        response.setHeader("Content-Type", asset.type);
        response.end(asset.body);
        return;
      }
      if (options.companies && ["/api/companies", "/api/companies/open", "/api/workspaces"].includes(path)) {
        const actor = options.companies.actor(request);
        if (!actor) throw new RequestError(401, "Sign in to choose a company.");
        if (request.method === "GET" && path === "/api/companies") { send(response, 200, await options.companies.list(actor)); return; }
        if (request.method === "GET" && path === "/api/workspaces") { send(response, 200, await options.companies.listing(actor)); return; }
        if (request.method !== "POST" || path !== "/api/companies/open") throw new RequestError(405, "Use company setup to create a workspace.");
        if (!request.headers["content-type"]?.startsWith("application/json")) throw new RequestError(415, "Use application/json.");
        if (request.headers.origin && !options.accounts?.clerk.authorizedParties.includes(request.headers.origin)) throw new RequestError(403, "Use the company portal origin.");
        if (!request.headers.authorization?.startsWith("Bearer ") && !request.headers.origin) throw new RequestError(403, "Browser writes require the company portal origin.");
        send(response, 200, await options.companies.open(actor, await body(request))); return;
      }
      const identity = await options.authenticate(request);
      if (!identity) throw new RequestError(401, "Sign in with a workspace access token.");
      const { workspaceId, actor } = identity;
      const roles = await options.context.members!.rolesFor(workspaceId, actor);
      if (!roles.length) throw new PermissionError("You are not a member of this workspace.");
      if (request.method === "GET" && path === "/api/health") {
        const pipeline = options.pipelines?.snapshot(workspaceId);
        send(response, 200, { status: "ok", workspaceId,
          persistence: pipeline?.storage ?? "unconfigured", writerMode: "single-process",
          capabilities: { workflows: !!pipeline, agentTests: !!options.agentTests,
            agentPackages: !!options.agentTests, models: !!options.chat,
            ontology: !!options.ontology?.(workspaceId), externalActions: !!options.jira || !!options.automations },
          note: "Workflow state was readable. This does not verify upstream services, durable backups or multi-instance readiness." });
        return;
      }
      if (request.method === "GET" && path === "/api/connections") {
        // One directory, built from the runtimes' own summaries. It holds no credential and no second copy of any setting.
        let models: { options: Awaited<ReturnType<NonNullable<ChatConfiguration["modelOptions"]>>>; error?: string } | undefined;
        if (options.chat) {
          try {
            const config = options.chatAccess ? await options.chatAccess.configuration(workspaceId, actor) : options.chat;
            models = { options: config.modelOptions ? await config.modelOptions() : (await (config.listModels?.() ?? Promise.resolve([config.model]))).map(id => ({ id, label: id, provider: config.provider, available: true, local: config.provider === "ollama", detail: "" })) };
          } catch { models = { options: [], error: "Could not list models. Make sure the model service is running, then refresh." }; }
        }
        const access = options.chatAccess ? await options.chatAccess.summary(workspaceId, actor) : undefined;
        const ontology = options.ontology?.(workspaceId)?.catalog();
        const bots = options.bots?.snapshot(workspaceId);
        const automation = options.automations?.inspect(workspaceId);
        const finished = automation?.actions.filter(item => item.finishedAt).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))[0];
        const toolCount = 3 + (options.pipelines ? 2 : 0) + (options.documents ? 2 : 0) + (options.zenfluence?.(workspaceId) ? 1 : 0) + (ontology ? 4 : 0);
        send(response, 200, { workspaceId, generatedAt: new Date().toISOString(), entries: buildConnectionsDirectory({ workspaceId, actor, log: operations, models,
          personal: access?.connections.map(item => ({ provider: item.provider, models: item.models })),
          workspaceConnections: access?.workspaceConnections,
          zenfluence: options.zenfluence?.(workspaceId)?.summary() ?? { configured: false },
          documents: options.documents ? { count: options.documents.snapshot(workspaceId).documents.length } : undefined,
          ontology: ontology ? { mode: ontology.mode, ontology: ontology.ontology, objectTypes: ontology.objectTypes.length } : undefined,
          repository: options.bots ? (bots?.project ? { root: bots.project.root, checks: bots.project.checks.length } : null) : undefined,
          mcpTools: { count: toolCount },
          jira: options.jira?.summary(workspaceId),
          automations: automation ? { units: automation.units.length, enabled: automation.units.filter(unit => unit.enabled).length, actions: automation.actions.length, ...(finished ? { lastFinished: { at: finished.finishedAt!, status: finished.status } } : {}) } : undefined,
          identity: { managed: !!options.accounts, actor, roles },
          billing: access ? { tier: access.tier, ...(access.plan ? { plan: access.plan } : {}), managedReady: access.managedReady } : undefined,
        }) }); return;
      }
      if (request.method === "GET" && path === "/api/zenfluence") {
        // The workspace id is included so an unconfigured page can show exactly
        // what to put in the connection file.
        send(response, 200, { workspaceId, ...(options.zenfluence?.(workspaceId)?.summary() ?? { configured: false }) }); return;
      }
      if (request.method === "GET" && path === "/api/automation-units" && options.automations) {
        send(response, 200, options.automations.inspect(workspaceId, Object.fromEntries(new URL(request.url!, "http://localhost").searchParams))); return;
      }
      if (request.method === "GET" && path === "/api/chat/history" && options.chatAccess) {
        send(response, 200, options.chatAccess.history.list(workspaceId, actor)); return;
      }
      if (request.method === "GET" && path === "/api/chat/access" && options.chatAccess) {
        send(response, 200, await options.chatAccess.summary(workspaceId, actor)); return;
      }
      if (request.method === "GET" && path === "/api/account") {
        const account = { managed: !!options.accounts, actor, workspaceId, canManageBilling: roles.includes("admin") };
        try { send(response, 200, { ...account, ...(account.canManageBilling && options.billing ? { billing: await options.billing.inspect(workspaceId) } : {}) }); }
        catch { send(response, 200, { ...account, billingError: "Could not verify billing with Stripe. Refresh to retry." }); }
        return;
      }
      if (request.method === "GET" && path === "/api/workspaces" && options.workspaces) {
        const listing = options.workspaces.list();
        if (options.accounts) {
          listing.workspaces = listing.workspaces.filter(entry => options.accounts!.members.some(member => member.workspaceId === entry.id && member.actor === actor));
          listing.lastWorkspaceId = workspaceId;
          listing.directory = "Managed workspace";
        }
        send(response, 200, listing); return;
      }
      if (request.method === "GET" && path === "/api/workspace") {
        await pending;
        const workflow = options.context.workflow ?? DEFAULT_WORKFLOW;
        const records = await options.context.store.list(workspaceId);
        send(response, 200, {
          ...(options.pipelines ? { pipelines: options.pipelines.snapshot(workspaceId) } : {}),
          ...(options.agentTests ? { agentPackages: options.agentTests.packages.snapshot(workspaceId, (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals) } : {}),
          ...(options.analyst ? { analyst: options.analyst.snapshot(workspaceId) } : {}),
          ...(options.bots ? { bots: options.bots.snapshot(workspaceId) } : {}),
          ...(options.scheduler ? { schedule: options.scheduler.snapshot(workspaceId) } : {}),
          ...(options.learning ? { learning: options.learning.snapshot(workspaceId) } : {}),
          ...(options.documents ? { documents: options.documents.snapshot(workspaceId) } : {}),
          workspaceId, actor, roles, workflow, demo: options.demo ?? false,
          ...(options.jira ? { jira: { canReview: !!identity.canDeliverJira && roles.includes("admin") } } : {}),
          ...studioSnapshot(options.studio, workspaceId),
          canAuthor: roles.includes("admin") || roles.includes(workflow.roles.author),
          ...(options.context.members!.approvers ? { approvers: await options.context.members!.approvers(workspaceId) } : {}),
          records: records.map((record) => ({
            ...record, hash: hashDefinition(record.definition),
            eligible: isServable(record, workflow), validApprovers: validApprovers(record),
          })),
          chat: options.chat ? { configured: true, provider: options.chat.provider, model: options.chat.model } : { configured: false },
          ...(options.ontology?.(workspaceId) ? { ontology: options.ontology(workspaceId)!.catalog() } : {}),
          mcp: await workspaceMcpOverview(options.context, workspaceId),
          audit: await options.context.audit.list(workspaceId),
          ...(options.email ? { mail: options.email.mailbox(workspaceId, actor, roles.includes("admin")) } : {}),
        });
        return;
      }
      if (path === "/api/jira" && request.method === "GET" && options.jira) {
        const query = Object.fromEntries(new URL(request.url!, "http://localhost").searchParams);
        send(response, 200, options.jira.inspect(workspaceId, { ...query,
          ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }));
        return;
      }
      if (path === "/api/bots" && request.method === "GET" && options.bots) {
        send(response, 200, options.bots.snapshot(workspaceId)); return;
      }
      if (path === "/api/agent-tests" && request.method === "GET" && options.agentTests) {
        send(response, 200, options.agentTests.snapshot(workspaceId)); return;
      }
      if (path === "/api/agent-evaluation-export" && request.method === "GET" && options.agentTests) {
        if (!roles.includes("author") && !roles.includes("admin")) throw new PermissionError("An author or admin exports evaluation evidence.");
        const query = Object.fromEntries(new URL(request.url!, "http://localhost").searchParams);
        const { runId } = z.object({ runId: z.string().uuid() }).strict().parse(query);
        const run = options.agentTests.snapshot(workspaceId).runs.find(item => item.id === runId && item.workspaceId === workspaceId);
        if (!run) throw new RequestError(404, "This evaluation is not in this workspace.");
        const bundle = buildEvaluationBundle(workspaceId, run);
        response.setHeader("Content-Disposition", `attachment; filename="evaluation-${runId}.json"`);
        response.setHeader("Cache-Control", "no-store");
        send(response, 200, bundle); return;
      }
      if (path === "/api/agent-package-export" && request.method === "GET" && options.agentTests) {
        const id = z.string().uuid().parse(new URL(request.url!, "http://localhost").searchParams.get("id"));
        const exported = options.agentTests.packages.exportPackage(workspaceId, id,
          (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals);
        response.setHeader("Content-Disposition", `attachment; filename="agent-package-${id}.json"`);
        send(response, 200, exported); return;
      }
      if (path === "/api/audit-package" && request.method === "GET" && options.pipelines) {
        // One run's chain of custody as a file. Any member may read it; it only contains what the run page already shows.
        const query = new URL(request.url!, "http://localhost").searchParams;
        const markdown = query.get("format") === "markdown";
        const attempts = options.bots?.snapshot(workspaceId).attempts ?? [];
        const analystJobs = options.analyst?.snapshot(workspaceId).jobs ?? [];
        const activityForRun = (run: { id: string }): AuditActivity[] => [
          ...attempts.filter(attempt => attempt.runId === run.id).map(attempt => ({
            executionId: attempt.id, runId: run.id, kind: "worker" as const, status: attempt.status, model: attempt.model,
            events: attempt.events, note: "Recorded worker log, bounded to the latest 50 events; not a claim of a complete provider transcript.",
          })),
          ...analystJobs.filter(job => job.runId === run.id).map(job => ({
            executionId: job.id, runId: run.id, kind: "analyst" as const, status: job.status,
            events: job.trace.map(trace => ({ at: trace.startedAt, message: `${trace.tool}: ${trace.outcome}. ${trace.reason} ${trace.summary}` })),
            note: "Recorded source-tool trace; no language-model token usage is inferred.",
          })),
        ];
        const deliver = (name: string, text: string) => {
          response.writeHead(200, { "Content-Type": markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${name}.${markdown ? "md" : "json"}"` });
          response.end(text);
        };
        if (query.get("scope") === "workspace") {
          // The whole workspace: every run's package plus the definition audit log, under one bundle hash.
          const bundle = buildWorkspaceAudit(options.pipelines.snapshot(workspaceId).runs, await options.context.audit.list(workspaceId), { workspaceId, actor, activityForRun });
          deliver(`workspace-audit-${workspaceId}`, markdown ? renderWorkspaceAudit(bundle) : JSON.stringify(bundle, null, 2)); return;
        }
        const run = options.pipelines.snapshot(workspaceId).runs.find(item => item.id === query.get("run"));
        if (!run) throw new RequestError(404, "Run not found in this workspace.");
        const pkg = buildAuditPackage(run, { workspaceId, actor, activity: activityForRun(run) });
        deliver(`audit-package-${run.id}`, markdown ? renderAuditPackage(pkg) : JSON.stringify(pkg, null, 2)); return;
      }
      if ((path === "/api/chat/models" || path === "/api/agent-studio/models") && request.method === "GET") {
        // Personal chat connections do not grant credentials to workflow agents.
        if (path === "/api/chat/models" && options.chatAccess) {
          const config = await options.chatAccess.configuration(workspaceId, actor);
          const choices = await config.modelOptions!();
          send(response, 200, { models: choices.filter(model => model.available).map(model => model.id), options: withMeasure(workspaceId, actor, choices),
            access: await options.chatAccess.summary(workspaceId, actor) }); return;
        }
        if (!options.chat) { send(response, 200, { models: [] }); return; }
        try {
          // Agent Studio lists what agents in this workspace can actually load: the server catalog plus the workspace's own connections.
          // Never a member's personal credentials: the agent catalog is the server catalog plus the workspace's own connections.
          const studio = options.chatAccess?.agentConfiguration ? await options.chatAccess.agentConfiguration().forWorkspace!(workspaceId) : options.chat;
          if (studio.modelOptions) {
            const choices = await studio.modelOptions();
            send(response, 200, { models: choices.filter((model) => model.available).map((model) => model.id), options: withMeasure(workspaceId, actor, choices) });
            return;
          }
          const models = options.chat.listModels ? await options.chat.listModels() : [options.chat.model];
          send(response, 200, { models });
        } catch { throw new RequestError(503, "Could not list models. Make sure Ollama is running, then refresh models."); }
        return;
      }
      if ((path === "/api/mcp" || path === "/api/pipeline-mcp" || path === "/api/chat-mcp") && request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new RequestError(405, "This MCP endpoint accepts POST requests.");
      }
      if (request.method !== "POST") throw new RequestError(404, "Not found.");
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new RequestError(415, "Use application/json.");
      }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`
        && request.headers.origin !== `https://${request.headers.host}`) {
        throw new RequestError(403, "Cross-origin writes are not allowed.");
      }
      const raw = await body(request);
      if (path === "/api/zenfluence") {
        if (!options.zenfluence) throw new RequestError(404, "Zenfluence is not configured.");
        const action = (raw as { action?: unknown })?.action;
        try {
          const result = await zenfluenceCommand(options.zenfluence, options.pipelines, { workspaceId, actor, roles }, raw);
          operations.record(workspaceId, "sources:zenfluence", true, `${String(action)} succeeded.`);
          send(response, 200, result); return;
        } catch (error) {
          if (error instanceof ZenfluenceError && error.status >= 500) operations.record(workspaceId, "sources:zenfluence", false, error.message);
          throw error;
        }
      }
      if (path === "/api/automation-units" && options.automations) {
        if (!identity.canRunAutomations) throw new PermissionError("Automation commands require the company application session.");
        const outcome = await options.automations.execute({ workspaceId, actor, roles }, raw);
        if ("action" in outcome && outcome.dispatched) operations.record(workspaceId, "delivery:automation", outcome.action.status === "succeeded", `Unit ${outcome.action.unitId}: ${outcome.action.status}.`);
        send(response, 200, outcome); return;
      }
      if (path === "/api/chat/history" && options.chatAccess) {
        try { send(response, 200, options.chatAccess.history.execute(workspaceId, actor, raw)); }
        catch (error) { if (error instanceof ChatHistoryError) throw new RequestError(error.status, error.message); throw error; }
        return;
      }
      if (path === "/api/chat/connections" && options.chatAccess) {
        // A workspace connection is shared with every agent in the workspace, so only an administrator may add, test or remove one.
        const shared = (raw as { scope?: unknown })?.scope === "workspace";
        if (shared && !roles.includes("admin")) throw new PermissionError("A workspace administrator must manage workspace connections.");
        try {
          await options.chatAccess.connect(workspaceId, actor, raw);
          if (shared) operations.record(workspaceId, `models:workspace:${String((raw as { provider?: unknown })?.provider)}`, true, `${String((raw as { action?: unknown })?.action)} succeeded.`);
        } catch (error) {
          if (shared) operations.record(workspaceId, `models:workspace:${String((raw as { provider?: unknown })?.provider)}`, false, error instanceof Error ? error.message : "Connection update failed.");
          throw error;
        }
        send(response, 200, await options.chatAccess.summary(workspaceId, actor)); return;
      }
      if (path === "/api/chat/access" && options.chatAccess) {
        const input = z.object({ action: z.enum(["issue", "revoke"]) }).strict().parse(raw);
        if (input.action === "revoke") { options.chatAccess.revokeToken(workspaceId, actor); send(response, 200, { revoked: true }); }
        else send(response, 200, options.chatAccess.issueToken(workspaceId, actor));
        return;
      }
      if (path === "/api/chat-mcp" && options.chatAccess) {
        await handleChatMcp(options.chatAccess, workspaceId, actor, async () => (await options.context.members!.rolesFor(workspaceId, actor)).length > 0, request, response, raw, options.chatTimeoutMs);
        return;
      }
      if (path === "/api/account/billing") {
        if (!roles.includes("admin")) throw new PermissionError("Only a workspace administrator may manage billing.");
        if (!options.billing || !options.accounts) throw new RequestError(503, "Billing is not configured.");
        const origin = request.headers.origin;
        if (!origin || !options.accounts.clerk.authorizedParties.includes(origin)) throw new RequestError(403, "Use the configured application origin for billing.");
        send(response, 200, await options.billing.open(workspaceId, raw, origin)); return;
      }
      if (path === "/api/ontology/reference") {
        const ontology = options.ontology?.(workspaceId);
        if (!ontology) throw new RequestError(404, "Ontology is not configured for this workspace.");
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        try {
          const material = ontologyMaterial(await ontology.get(raw, controller.signal));
          operations.record(workspaceId, "sources:ontology", true, "Object read and attached.");
          send(response, 200, material);
        } catch (error) { operations.record(workspaceId, "sources:ontology", false, "The object read failed."); throw error; }
        return;
      }
      if (path === "/api/jira" && options.jira) {
        if (!identity.canDeliverJira) throw new PermissionError("Jira commands require the local application session.");
        const outcome = await options.jira.execute({ workspaceId, actor, roles }, raw);
        if ("action" in outcome && outcome.dispatched) operations.record(workspaceId, "delivery:jira", outcome.action.status === "sent", `${outcome.action.intent.operation}: ${outcome.action.status}.`);
        send(response, 200, outcome);
        return;
      }
      if (path === "/api/studio") {
        if (!options.studio) throw new RequestError(404, "The Model Studio is not configured.");
        await pending;
        const run = pending.then(() => options.studio!.execute(workspaceId, actor, roles, raw, (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals));
        pending = run.then(() => undefined, () => undefined);
        send(response, 200, await run);
        tickScheduler(workspaceId);
        return;
      }
      if (path === "/api/learning") {
        if (!options.learning) throw new RequestError(404, "Learning schedules are not configured.");
        const input = learningCommandSchema.parse(raw);
        await pending;
        if (input.action === "set") options.learning.set(workspaceId, actor, roles, { projectId: input.projectId, cadence: input.cadence, pattern: input.pattern, paused: input.paused });
        else if (input.action === "remove") options.learning.remove(workspaceId, actor, roles, input.projectId);
        else options.learning.runNow(workspaceId, actor, roles, input.projectId);
        tickScheduler(workspaceId);
        send(response, 200, options.learning.snapshot(workspaceId));
        return;
      }
      if (path === "/api/documents") {
        if (!options.documents) throw new RequestError(404, "The documentation portal is not configured.");
        await pending;
        // The engine validates the command and runs the pipeline or studio command as this person.
        const state = options.documents.execute(workspaceId, actor, roles, raw);
        if ((raw as { action?: unknown })?.action === "add_document") operations.record(workspaceId, "sources:documents", true, "Document saved.");
        tickScheduler(workspaceId);
        send(response, 200, state);
        return;
      }
      if (path === "/api/schedule") {
        if (!options.scheduler) throw new RequestError(404, "The scheduler is not configured.");
        if (!roles.includes("admin") && !roles.includes("author")) throw new PermissionError("An author or admin operates the scheduler.");
        const input = scheduleCommandSchema.parse(raw);
        if (input.action === "retry") options.scheduler.retry(workspaceId, input.jobId);
        else if (input.action === "cancel") options.scheduler.cancel(workspaceId, input.jobId);
        tickScheduler(workspaceId);
        send(response, 200, options.scheduler.snapshot(workspaceId));
        return;
      }
      if (path === "/api/bots" && options.bots) {
        send(response, 200, await options.bots.execute(workspaceId, actor, roles, raw, (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals));
        return;
      }
      if (path === "/api/agent-packages") {
        if (!options.agentTests) throw new RequestError(503, "Agent packages need the configured test and repository runtime. This deployment has not enabled it.");
        if (identity.recentSignIn === false && (raw as { action?: unknown })?.action === "approve") throw new PermissionError("Sign in again before approving a package.");
        const currentRoles = await options.context.members!.rolesFor(workspaceId, actor);
        send(response, 200, options.agentTests.packages.execute(workspaceId, actor, currentRoles, raw,
          (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals));
        return;
      }
      if (path === "/api/agent-tests" && options.agentTests) {
        send(response, 200, await options.agentTests.execute(workspaceId, actor, roles, raw));
        return;
      }
      if (options.workspaces && (path === "/api/workspaces" || path === "/api/workspaces/open" || path === "/api/workspaces/mcp-access")) {
        if (options.accounts) {
          if (path !== "/api/workspaces/open") throw new PermissionError("Managed workspace access is configured by the server administrator.");
          const selected = z.object({ workspaceId: z.string() }).strict().parse(raw);
          if (!(await options.context.members!.rolesFor(selected.workspaceId, actor)).length) throw new PermissionError("You are not a member of this workspace.");
          send(response, 200, { workspaceId: selected.workspaceId }); return;
        }
        if (!roles.includes("admin")) throw new PermissionError("Only the local owner may manage workspaces.");
        if (path === "/api/workspaces") send(response, 201, options.workspaces.create(raw));
        else if (path === "/api/workspaces/open") send(response, 200, options.workspaces.open(raw));
        else {
          z.object({}).strict().parse(raw);
          if (!options.mcpAccess) throw new RequestError(404, "MCP access is unavailable.");
          send(response, 200, options.mcpAccess(workspaceId));
        }
        return;
      }
      if (path === "/api/analyst") {
        if (!options.analyst) throw new RequestError(503, "Analyst execution is not configured for this workspace.");
        await pending;
        const task = pending.then(() => options.analyst!.command(workspaceId, actor, roles, raw, (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals));
        pending = task.then(() => undefined, () => undefined);
        send(response, 200, await task); return;
      }
      if (path === "/api/pipeline" || path === "/api/pipeline-mcp") {
        if (!options.pipelines) throw new RequestError(404, "Pipelines are not configured.");
        await pending;
        const approvals = (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals;
        if (path === "/api/pipeline-mcp") await handlePipelineMcp(options.pipelines, workspaceId, actor, roles, approvals, request, response, raw, options.bots, options.jira, options.studio ? assistantDirectory(options.studio) : undefined, options.learning, options.documents, options.automations, options.zenfluence, options.ontology?.(workspaceId), identity.recentSignIn === false ? "Sign in again before approving this handoff." : undefined, options.agentTests);
        else {
          if ((raw as { action?: unknown })?.action === "prepare_declaration_brief") {
            const input = z.object({ action: z.literal("prepare_declaration_brief"), runId: z.string().uuid(),
              expectedRevision: z.number().int().positive() }).strict().parse(raw);
            const run = options.pipelines.snapshot(workspaceId).runs.find(item => item.id === input.runId);
            if (!run) throw new RequestError(404, "Work item not found.");
            if (!roles.includes("admin") && !(roles.includes("author") && run.owner === actor)) throw new PermissionError("Only the owner or an admin can prepare a draft.");
            const stage = run.config.stages[run.current]!;
            const progress = run.stages[run.current]!;
            if (run.status !== "running" || progress.status !== "active" || progress.draft
              || !stage.approval || stage.assistantId || (stage.bot && stage.bot.kind !== "manual")) {
              throw new RequestError(409, "Choose an active, unstaffed review gate without an existing draft.");
            }
            const material = run.materials?.find(isDeclarationMaterial);
            const reader = options.ontology?.(workspaceId);
            if (!run.workflowSource || !material || reader?.catalog().mode !== "foundry") throw new RequestError(409, "Start a work item with a Foundry-verified declaration sample.");
            if (run.revision !== input.expectedRevision) throw new RequestError(409, "Work item changed. Refresh and try again.");
            const sample = await verifiedDeclarationSample(material, reader);
            // The revision check at write time also protects against changes during the remote reads.
            send(response, 200, options.pipelines.draft(workspaceId, { runId: run.id, stageId: stage.id,
              expectedRevision: input.expectedRevision, by: "Public data analyst (source tool)", jobId: randomUUID(), text: declarationBrief(sample) }));
            return;
          }
          // The studio shows "test before assigning"; the server holds the same line.
          if (options.agentTests && isConfigure(raw)) {
            const untested = newlyAssigned(options.pipelines.snapshot(workspaceId).config, raw.config).filter(agent => !passedCurrentTest(agent, options.agentTests!.snapshot(workspaceId)));
            if (untested.length) throw new RequestError(409, `Run a passing test on the current version of ${untested.map(agent => agent.name).join(", ")} before assigning it to a stage.`);
          }
          if (identity.recentSignIn === false && (raw as { action?: unknown })?.action === "approve") throw new PermissionError("Sign in again before approving this handoff.");
          // A handoff proposed to someone who cannot sign would never complete, so names are checked against the directory here.
          const named = (raw as { reviewers?: unknown })?.reviewers;
          if (Array.isArray(named)) {
            for (const reviewer of named) {
              const reviewerRoles = typeof reviewer === "string" ? await options.context.members!.rolesFor(workspaceId, reviewer) : [];
              if (!reviewerRoles.includes("approver") && !reviewerRoles.includes("admin")) throw new RequestError(400, `${String(reviewer).slice(0, 200)} cannot approve handoffs in this workspace. Name an approver or admin.`);
            }
          }
          const start = (raw as { action?: unknown })?.action === "start" && options.pipelines.start;
          send(response, 200, start ? await start(workspaceId, actor, roles, raw, approvals) : options.pipelines.execute(workspaceId, actor, roles, raw, approvals));
        }
        tickScheduler(workspaceId);
        return;
      }
      if (path === "/api/mcp") {
        await pending;
        await handleWorkspaceMcp(options.context, workspaceId, request, response, raw, options.ontology?.(workspaceId));
        return;
      }
      if (path === "/api/chat" || path === "/api/base-chat") {
        const input = chatRequestSchema.parse(raw);
        const baseChat = path === "/api/base-chat";
        if (baseChat && input.profile) throw new RequestError(400, "Base chat does not accept an assistant profile. Open the assistant to use its approved configuration.");
        if (!options.chat) throw new RequestError(503, "Configure MAGENTIC_LLM_PROVIDER and MAGENTIC_LLM_CHAT_MODEL on the server, then restart to enable chat.");
        // A profile is resolved before any model is loaded. An unapproved,
        // retired or tampered release stops here with a plain reason.
        let persona: import("./chat.js").ChatPersona | undefined;
        if (input.profile) {
          if (!options.studio) throw new RequestError(404, "The Model Studio is not configured.");
          await pending;
          const resolved = options.studio.resolveProfile(workspaceId, input.profile);
          persona = { name: resolved.profile.name, instructions: resolved.profile.instructions,
            release: `${resolved.project.name} v${resolved.release.version} (${resolved.job.artifact?.label ?? "unknown"} artifact)` };
        }
        if (input.routing === "auto" && !options.chatAccess) throw new RequestError(503, "Automatic routing is not configured.");
        const prepared = await options.chatAccess?.prepare(workspaceId, actor, input);
        const chat = prepared?.config ?? options.chat;
        const outputLimit = prepared ? prepared.maxOutputTokens : input.maxOutputTokens;
        const selectedModel = prepared?.model ?? input.model ?? chat.model;
        let connector = chat.provider === "ollama" ? "models:local" : "models:server";
        if (chat.modelOptions) {
          const choice = (await chat.modelOptions()).find((model) => model.id === selectedModel);
          if (!choice) throw new RequestError(400, "Choose a model from the model selector.");
          if (!choice.available) throw new RequestError(503, choice.detail);
          connector = choice.local ? "models:local" : "models:server";
          if (outputLimit !== undefined && !choice.outputLimit) throw new RequestError(400, "This model uses the provider default output cap.");
        } else {
          let models: string[];
          try { models = chat.listModels ? await chat.listModels() : [chat.model]; }
          catch { throw new RequestError(503, "Could not reach the model service. Check its connection and refresh models."); }
          if (outputLimit !== undefined && !chat.outputLimit) throw new RequestError(400, "This model uses the provider default output cap.");
          if (!models.includes(selectedModel)) throw new RequestError(400, "Choose a connected model from the model selector. Refresh the list if it changed.");
        }
        const personal = selectedModel.startsWith("personal/");
        if (personal) connector = `models:${selectedModel.split("/")[1]}`;
        if (selectedModel.startsWith("workspace/")) connector = `models:workspace:${selectedModel.split("/")[1]}`;
        const key = JSON.stringify([workspaceId, actor]);
        if (activeChats.has(key) || activeChats.size >= 4) throw new RequestError(429, "A chat is already running. Wait for it to finish or stop it before trying again.");
        const releaseAccess = options.chatAccess?.acquire(workspaceId, actor);
        activeChats.add(key);
        const controller = new AbortController();
        const budgetMs = options.chatTimeoutMs ?? 120_000;
        const endsAt = Date.now() + budgetMs;
        const timeout = setTimeout(() => controller.abort(), budgetMs);
        // Stop in the browser or a dropped connection aborts the model request and every tool call behind it.
        response.once("close", () => controller.abort());
        const started = performance.now();
        const messages = contextMessages(input.messages, input.history ?? "all");
        const emit = (event: ChatEvent) => {
          const result = event.type === "answer" && input.metrics ? { ...event, elapsedMs: Math.round(performance.now() - started) } : event;
          if (!baseChat) measure(workspaceId, actor, selectedModel, event);
          if (event.type === "answer") operations.record(workspaceId, connector, true, `${selectedModel} answered${event.usage ? ` (${event.usage.promptTokens} in, ${event.usage.completionTokens} out)` : ""}.`, personal ? actor : undefined);
          if (event.type === "error" && !/No answer was accepted/.test(event.message)) operations.record(workspaceId, connector, false, event.message, personal ? actor : undefined);
          if (!response.destroyed) response.write(JSON.stringify(result) + "\n");
        };
        // Long CPU inference can leave the stream idle. Opt-in clients receive
        // progress so an intermediary need not mistake a quiet model for a lost connection.
        const heartbeat = input.metrics ? setInterval(() => {
          if (response.headersSent && !controller.signal.aborted) emit({ type: "thinking", message: "Still working…" });
        }, 15_000) : undefined;
        try {
          await untilAborted(pending, controller.signal);
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
          emit({ type: "budget", ms: budgetMs });
          emit({ type: "thinking", message: "Connecting to the model…" });
          if (prepared?.route) emit({ type: "route", ...prepared.route });
          const model = await untilAborted(chat.loadModel(selectedModel, outputLimit === undefined ? undefined : { maxOutputTokens: outputLimit }), controller.signal);
          if (baseChat) await runBaseChat(messages, model, controller.signal, emit);
          else await runWorkspaceAgent(options.context, workspaceId, actor, messages, model, controller.signal, emit, options.ontology?.(workspaceId), persona, { pipelines: options.pipelines, documents: options.documents, zenfluence: options.zenfluence }, { endsAt });
        } catch (error) {
          // Provider errors can include endpoint details or credentials. The
          // browser receives a useful failure without echoing those internals.
          const seconds = budgetMs / 1000;
          emit({ type: "error", message: error instanceof ChatAccessError || error instanceof GroundingError ? error.message : controller.signal.aborted
            ? `The request stopped or exceeded its ${seconds} second budget. Try a shorter question, or raise MAGENTIC_CHAT_TIMEOUT_SECONDS on the server.`
            : "The model could not complete this request. Check its connection and model settings, then try again." });
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
          activeChats.delete(key);
          releaseAccess?.();
          response.end();
        }
        return;
      }
      const run = pending.then(async () => {
        if (path.startsWith("/api/email/")) {
          if (!options.email) throw new RequestError(404, "Email previews are not configured.");
          if (path === "/api/email/preferences") {
            options.email.setPreferences(workspaceId, actor, raw);
            return { saved: true };
          }
          if (path === "/api/email/invitations") {
            if (!roles.includes("admin")) throw new PermissionError("Only workspace admins may draft invitations.");
            try { return options.email.invite(workspaceId, actor, raw); }
            catch (error) {
              if (error instanceof z.ZodError) throw error;
              throw new RequestError(409, (error as Error).message);
            }
          }
          const message = /^\/api\/email\/([a-f0-9-]+)\/(viewed|cancel)$/.exec(path);
          if (!message) throw new RequestError(404, "Email action not found.");
          z.object({}).strict().parse(raw);
          if (message[2] === "cancel" && !roles.includes("admin")) throw new PermissionError("Only workspace admins may cancel invitations.");
          const changed = message[2] === "viewed"
            ? options.email.markViewed(workspaceId, actor, message[1]!)
            : options.email.cancelInvitation(workspaceId, message[1]!);
          if (!changed) throw new RequestError(404, "Message not found.");
          return { saved: true };
        }
        if (path === "/api/records") {
          const input = draftSchema.parse(raw);
          const existing = await options.context.store.get(workspaceId, input.definition.name);
          if (existing && input.expectedHash !== hashDefinition(existing.definition)) {
            throw new RequestError(409, "This definition changed. Refresh and review it again.");
          }
          return authorDraft(options.context, { workspaceId, actor, definition: input.definition });
        }
        const match = /^\/api\/records\/([a-z0-9-]+)\/(submit|approve|request-changes|retire)$/.exec(path);
        if (!match) throw new RequestError(404, "Not found.");
        const input = actionSchema.parse(raw);
        const name = match[1]!;
        const record = await options.context.store.get(workspaceId, name);
        if (!record) throw new RequestError(404, "Definition not found in this workspace.");
        if (input.expectedHash !== hashDefinition(record.definition)) {
          throw new RequestError(409, "This definition changed. Refresh and review it again.");
        }
        const actions = { submit, approve, "request-changes": requestChanges, retire };
        const action = match[2] as keyof typeof actions;
        const updated = await actions[action](options.context, {
          workspaceId, actor, name, ...(input.note ? { note: input.note } : {}),
        });
        if (options.email) {
          try {
            await options.email.capture({
              workspaceId, actor, agentName: name, at: updated.updatedAt,
              action: action === "submit" ? "submitted" : action === "approve" ? "approved"
                : action === "request-changes" ? "changes-requested" : "retired",
              definitionHash: hashDefinition(updated.definition), ...(input.note ? { note: input.note } : {}),
            }, updated, options.context.members!, options.context.workflow ?? DEFAULT_WORKFLOW);
          } catch {
            // The signature has already been saved. Calling it a failed
            // approval would invite a retry of an action that succeeded.
            return { ...updated, emailWarning: "The action was saved, but its email preview could not be created." };
          }
        }
        return updated;
      });
      pending = run.then(() => undefined, () => undefined);
      send(response, 200, await run);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof ZenfluenceError || error instanceof AutomationError || error instanceof ChatAccessError || error instanceof BillingError || error instanceof RequestError || error instanceof PipelineError || error instanceof JiraApiError || error instanceof StudioError || error instanceof DocumentError) send(response, error.status, { error: error.message });
      else if (error instanceof StudioStorageError) send(response, 409, { error: error.message });
      else if (error instanceof OntologyError) send(response, 502, { error: error.message });
      else if (error instanceof PermissionError) send(response, 403, { error: error.message });
      else if (error instanceof JiraError) send(response, 409, { error: error.message });
      else if (error instanceof TransitionError) send(response, 409, { error: error.message });
      else if (error instanceof z.ZodError) send(response, 400, { error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      else if (error instanceof SyntaxError) send(response, 400, { error: "Request body must be valid JSON." });
      else send(response, 500, { error: "The workspace could not complete this request." });
    }
  });
}

/**
 * The studio's part of the workspace snapshot. A studio file that fails its
 * integrity check must not take the rest of the workspace down with it, so
 * the failure travels as a message the page can show.
 */
function studioSnapshot(studio: ModelStudio | undefined, workspaceId: string): Record<string, unknown> {
  if (!studio) return {};
  try {
    return { studio: studio.snapshot(workspaceId) };
  } catch (error) {
    if (error instanceof StudioStorageError) return { studioError: error.message };
    throw error;
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new RequestError(413, "Definition is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

/** A configure command carries a full pipeline config; anything else is left to the engine to validate. */
function isConfigure(raw: unknown): raw is { action: "configure"; config: PipelineConfig } {
  if (!raw || typeof raw !== "object" || (raw as { action?: unknown }).action !== "configure") return false;
  return pipelineSchema.safeParse((raw as { config?: unknown }).config).success;
}
