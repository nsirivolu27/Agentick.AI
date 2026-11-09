import type { OntologyReader } from "./ontology.js";
import { declarationBrief, verifiedDeclarationSample } from "./declaration-sample.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configurableCatalog } from "./agent-configurables.js";
import type { PipelineEngine } from "./pipeline.js";
import type { DocumentsEngine } from "./documents.js";
import type { ZenfluenceDirectory } from "./zenfluence.js";
import { findSecretKinds } from "./studio/dataset.js";

export interface WorkspaceReads { pipelines?: PipelineEngine | undefined; documents?: DocumentsEngine | undefined; zenfluence?: ZenfluenceDirectory | undefined }
export function registerWorkspaceReads(server: McpServer, workspace: string, engine?: PipelineEngine, documents?: DocumentsEngine, ontology?: OntologyReader) {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  if (engine) server.registerTool("get_pipeline", { description: "Read the workspace pipeline configuration and compact run summaries.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, async () => {
    const snapshot = engine.snapshot(workspace);
    return result({ config: snapshot.config, agentConfigurations: configurableCatalog(snapshot.config), version: snapshot.version, storage: snapshot.storage, jiraDelivery: snapshot.jiraDelivery,
      runs: snapshot.runs.map(({ id, title, status, current, version, revision }) => ({ id, title, status, current, version, revision })) });
  });
  if (engine) server.registerTool("get_pipeline_run", { description: "Read one run, its stage outputs, review evidence, history, and Jira previews.",
    inputSchema: z.object({ runId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true } }, async ({ runId }) => {
    const run = engine.snapshot(workspace).runs.find(item => item.id === runId);
    return run ? result(run) : { ...result({ error: "Run not found in this workspace." }), isError: true };
  });
  if (engine && ontology?.catalog().mode === "foundry" && ontology.catalog().objectTypes.some(type => type.apiName === "Declaration")) server.registerTool("summarize_declaration_sample", {
    description: "Check an attached OpenFEMA sample against the mapped Foundry Declaration objects. Return verified rows, counts and source references.",
    inputSchema: z.object({ runId: z.string().uuid(), materialId: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: true },
  }, async ({ runId, materialId }, extra) => {
    const run = engine.snapshot(workspace).runs.find(item => item.id === runId);
    const material = run?.materials?.find(item => item.id === materialId);
    if (!material) return { ...result({ error: "Reference not found in this workspace run." }), isError: true };
    try {
      const sample = await verifiedDeclarationSample(material, ontology, extra.signal);
      return result({ ...sample, brief: declarationBrief(sample) });
    }
    catch { return { ...result({ error: "Declaration evidence could not be verified. Check the scoped mapping and saved source." }), isError: true }; }
  });
  if (documents) server.registerTool("list_documents", {
    description: "List the documents in this workspace's documentation portal: title, size, how many lines looked like a credential, an excerpt, and the runs and datasets each one is connected to. The content stays on the machine.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => result(documents.snapshot(workspace).documents));
  if (documents) server.registerTool("read_document", {
    description: "Read up to 4,500 characters of a selected workspace document, with its content hash. Refuses documents flagged for possible credentials. Truncated text is an excerpt, not the full document.",
    inputSchema: z.object({ documentId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ documentId }) => {
    const doc = documents.snapshot(workspace).documents.find(item => item.id === documentId);
    if (!doc) return { ...result({ error: "Document not found in this workspace." }), isError: true };
    if (doc.secretFindings) return { ...result({ error: "Document contains possible credentials and cannot be read by an agent." }), isError: true };
    try {
      const text = documents.content(workspace, documentId);
      if (findSecretKinds(text).length) return { ...result({ error: "Document contains possible credentials and cannot be read by an agent." }), isError: true };
      return result({ id: doc.id, title: doc.title, contentHash: doc.contentHash, text: text.slice(0, 4500), truncated: text.length > 4500 });
    } catch { return { ...result({ error: "Document content is unavailable." }), isError: true }; }
  });
}
