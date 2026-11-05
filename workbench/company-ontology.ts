import { PermissionError } from "../registry/roles.js";
import { setting } from "../env.js";
import { createOntologyDirectory, ontologyConfigSchema, ontologyMaterial, OntologyError, readOntologyConfig, type OntologyDirectory } from "./ontology.js";
import { pipelineCommandSchema, PipelineError, type PipelineEngine } from "./pipeline.js";
import { declarationEvidence } from "./declaration-sample.js";
import { materialSchema, type Material } from "./materials.js";

export interface CompanyOntology {
  directory: OntologyDirectory;
  verify(): Promise<void>;
  readWorkflow(workspace: string): Promise<Material>;
}

export function companyOntology(raw: unknown, readSetting = setting, request: typeof fetch = fetch, execution: "live" | "offline-replay" = "live"): CompanyOntology {
  const config = ontologyConfigSchema.parse(raw);
  if (!config.workspaces.length) throw new Error("MAGENTIC_ONTOLOGY_FILE requires a company workspace mapping.");
  const bindings = new Map<string, { companyKey: string; workflowKey: string }>();
  for (const item of config.workspaces) {
    if (item.mode !== "foundry" || !item.companyKey || !item.workflowKey) {
      throw new Error("Each company workspace requires mode=foundry, companyKey and workflowKey.");
    }
    const workflow = item.objectTypes.find(type => type.apiName === "Workflow");
    if (!workflow?.properties.includes("companyId")) throw new Error("Allow Workflow.companyId to verify the tenant binding.");
    bindings.set(item.workspaceId, { companyKey: item.companyKey, workflowKey: item.workflowKey });
  }
  const directory = createOntologyDirectory(config, readSetting, request, process.cwd(), execution);
  async function readWorkflow(workspace: string) {
    const binding = bindings.get(workspace);
    const reader = directory(workspace);
    if (!binding || !reader) throw new PipelineError(503, "Configure a Foundry Workflow mapping for this company workspace.");
    const workflow = await reader.get({ objectType: "Workflow", primaryKey: binding.workflowKey });
    if (workflow.properties.companyId !== binding.companyKey) throw new OntologyError("The Foundry Workflow does not belong to the configured company.");
    return ontologyMaterial(workflow);
  }
  return { directory, readWorkflow, async verify() {
    // The pilot must establish tenant ownership before it opens its listening port.
    for (const workspace of bindings.keys()) await readWorkflow(workspace);
  } };
}

export function loadCompanyOntology(): CompanyOntology {
  const path = setting("MAGENTIC_ONTOLOGY_FILE")?.trim();
  if (!path) throw new Error("MAGENTIC_ONTOLOGY_FILE is required for company workflows.");
  return companyOntology(readOntologyConfig(path));
}

export function companyPipelines(engine: PipelineEngine, ontology: CompanyOntology): PipelineEngine {
  function checkRun(workspace: string, runId: string) {
    const run = engine.snapshot(workspace).runs.find(item => item.id === runId);
    if (run && !run.workflowSource) throw new PipelineError(409, "This run predates Foundry grounding. Start a new company run.");
  }
  return {
    snapshot: engine.snapshot,
    async start(workspace, actor, roles, raw, approvals) {
      if (!roles.includes("author") && !roles.includes("admin")) throw new PermissionError("An author or admin must start a run.");
      const input = pipelineCommandSchema.parse(raw);
      if (input.action !== "start") throw new PipelineError(400, "Expected a start command.");
      const existing = engine.snapshot(workspace).runs.find(run => run.requestId === input.requestId);
      if (existing) {
        checkRun(workspace, existing.id);
        return engine.execute(workspace, actor, roles, input, approvals);
      }
      const source = await ontology.readWorkflow(workspace);
      const declarations = await declarationEvidence(input.materials ?? [], ontology.directory(workspace));
      if (declarations) {
        source.content += "\nVerified Foundry declarations:\n" + declarations.content;
        if (!materialSchema.safeParse(source).success) throw new PipelineError(400, "Reduce the sample size to fit the workflow evidence limit.");
      }
      return engine.execute(workspace, actor, roles, input, approvals, source);
    },
    execute(workspace, actor, roles, raw, approvals) {
      const input = pipelineCommandSchema.parse(raw);
      if (input.action === "start") throw new PipelineError(409, "Company runs require a server-resolved Foundry Workflow.");
      if ("runId" in input && input.action !== "cancel") checkRun(workspace, input.runId);
      return engine.execute(workspace, actor, roles, input, approvals);
    },
    draft(workspace, input) {
      checkRun(workspace, input.runId);
      return engine.draft(workspace, input);
    },
  };
}
