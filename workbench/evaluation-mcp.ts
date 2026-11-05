import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentTestsEngine } from "./agent-tests.js";
import { buildEvaluationBundle, evaluateBundle } from "./evaluation-bundle.js";

export function registerEvaluationInspection(server: McpServer, workspace: string, tests: Pick<AgentTestsEngine, "snapshot">): void {
  server.registerTool("get_agent_evaluation_report", {
    description: "Inspect offline checks for a completed agent test in this workspace. Returns evidence hashes and recorded usage, not source text. Never runs a model, submits an AWS job or approves a release.",
    inputSchema: z.object({ runId: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ runId }) => {
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    const run = tests.snapshot(workspace).runs.find(item => item.id === runId && item.workspaceId === workspace);
    if (!run) return { ...result({ error: "This evaluation is not in this workspace." }), isError: true };
    try { return result(evaluateBundle(buildEvaluationBundle(workspace, run), workspace)); }
    catch { return { ...result({ error: "Evaluation unavailable. A completed, versioned test with valid frozen evidence is required." }), isError: true }; }
  });
}
