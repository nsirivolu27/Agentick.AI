import { z } from "zod";

/** This list is application policy, never inferred from model text or MCP hints. */
export const READ_TOOLS = [
  "list_approved_agents", "get_approved_agent", "get_workspace_policy",
  "get_pipeline", "get_pipeline_run", "summarize_declaration_sample", "list_documents",
  "get_ontology_catalog", "list_ontology_objects", "get_ontology_object", "list_ontology_links",
  "lookup_openfema_declarations", "list_project_files", "read_project_file", "project_diff",
  "read_document", "get_zenfluence_source", "profile_project_file",
] as const;
const policySchema = z.object({
  scope: z.string().min(1).max(300), actor: z.string().min(1).max(300),
  tools: z.array(z.enum(READ_TOOLS)).max(READ_TOOLS.length),
  maxCalls: z.number().int().min(0).max(64),
  timeoutMs: z.number().int().min(1).max(120_000),
}).strict().refine(value => new Set(value.tools).size === value.tools.length, "Duplicate grants");
export class ToolSessionError extends Error {}

/**
 * One immutable, read-only dispatch boundary shared by execution surfaces.
 * Identity and authorization are supplied by the server, not call arguments.
 * Schema validation remains in the registered MCP handlers.
 */
export function readToolSession(
  input: z.input<typeof policySchema>,
  authorize: () => Promise<boolean>,
) {
  const policy = policySchema.parse(input);
  const grants = new Set<string>(policy.tools);
  const active = new Set<AbortController>();
  let calls = 0; let closed = false;
  return {
    describe: () => ({ ...policy, tools: [...grants], calls, closed }),
    async call<T>(name: string, signal: AbortSignal, invoke: (bounded: AbortSignal) => Promise<T>): Promise<T> {
      if (closed) throw new ToolSessionError("Tool session is closed.");
      if (!grants.has(name)) throw new ToolSessionError("This read tool is not granted to the execution.");
      signal.throwIfAborted();
      const controller = new AbortController();
      active.add(controller);
      const bounded = AbortSignal.any([signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      let onAbort = () => {};
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ToolSessionError("Tool call stopped or timed out."));
        bounded.addEventListener("abort", onAbort, { once: true });
        if (bounded.aborted) onAbort();
      });
      try {
        const allowed = await Promise.race([authorize(), stopped]);
        bounded.throwIfAborted();
        if (!allowed) throw new ToolSessionError("Execution membership is no longer authorized.");
        if (closed) throw new ToolSessionError("Tool session is closed.");
        // Increment after async authorization, without an intervening await:
        // concurrent callers cannot both spend the final grant.
        if (calls >= policy.maxCalls) throw new ToolSessionError("MCP tool-call limit reached.");
        calls++;
        const result = await Promise.race([invoke(bounded), stopped]);
        bounded.throwIfAborted();
        return result;
      } catch (error) {
        if (error instanceof ToolSessionError) throw error;
        throw new ToolSessionError(bounded.aborted
          ? "Tool call stopped or timed out."
          : "Tool call failed. Check the connection; no fallback was performed.");
      } finally {
        clearTimeout(timer); bounded.removeEventListener("abort", onAbort); active.delete(controller);
      }
    },
    close() { closed = true; for (const controller of active) controller.abort(); },
  };
}
