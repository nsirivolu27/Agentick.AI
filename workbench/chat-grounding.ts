import { createHash } from "node:crypto";

/**
 * Grounding rules for workspace chat. A question about workspace facts must
 * be answered from a tool read, and which reads are required is decided here,
 * from the request, before the model sees anything. The model cannot opt out
 * by answering early: an answer that arrives before a required read is not an
 * answer, it is a refusal with the reason.
 *
 * Two kinds of requirement:
 *   named   the person named a tool ("use get_workspace_policy"). If the tool
 *           takes no arguments the server reads it up front; otherwise the
 *           model must call it with arguments before it may answer.
 *   topic   the question is about something only a read can establish: the
 *           workflow, the approval policy, or the approved agents.
 *
 * Tool results remain untrusted data. Nothing here grants a tool.
 */

export interface ToolShape { name: string; inputSchema?: { required?: unknown } | undefined }
export interface RequiredRead {
  name: string;
  /** Present when the server can make the read itself; absent when the model must supply arguments. */
  arguments?: Record<string, never>;
  reason: "named" | "topic";
}

const TOPICS: { pattern: RegExp; tool: string }[] = [
  { pattern: /\b(workflow|pipeline|stages?|work items?|handoffs?)\b/i, tool: "get_pipeline" },
  { pattern: /\b(polic(?:y|ies)|approvals?|approvers?|required approval|sign[- ]?offs?|reviewers? (?:needed|required))\b/i, tool: "get_workspace_policy" },
  { pattern: /\b(approved agents?|agent definitions?|which agents|agent catalog(?:ue)?)\b/i, tool: "list_approved_agents" },
];

/** The reads this request must make, in order, limited to tools the session actually offers. Never more than three. */
export function requiredReads(message: string, tools: readonly ToolShape[]): RequiredRead[] {
  const offered = new Map(tools.map(tool => [tool.name, tool]));
  const found: RequiredRead[] = [];
  const add = (name: string, reason: RequiredRead["reason"]) => {
    const tool = offered.get(name);
    if (!tool || found.some(item => item.name === name) || found.length >= 3) return;
    const needsArguments = Array.isArray(tool.inputSchema?.required) && tool.inputSchema.required.length > 0;
    found.push(needsArguments ? { name, reason } : { name, arguments: {}, reason });
  };
  for (const tool of tools) if (new RegExp(`\\b${tool.name}\\b`, "i").test(message)) add(tool.name, "named");
  for (const topic of TOPICS) if (topic.pattern.test(message)) add(topic.tool, "topic");
  return found;
}

export interface EvidenceCall { tool: string; arguments: Record<string, unknown>; resultHash: string; bytes: number; isError: boolean; initiatedBy?: "server" | "model" }

/** A compact, hashable record of one tool call for the answer's evidence panel. */
export function evidenceOf(tool: string, args: Record<string, unknown>, result: unknown): EvidenceCall {
  const serialized = JSON.stringify(result ?? null);
  const isError = !!(result && typeof result === "object" && (result as { isError?: unknown }).isError);
  return { tool, arguments: args, resultHash: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized), isError };
}

/** Which required reads have not yet produced a successful observation. */
export function outstandingReads(required: readonly RequiredRead[], calls: readonly EvidenceCall[]): RequiredRead[] {
  return required.filter(read => !calls.some(call => call.tool === read.name && !call.isError));
}

/** The model answered before reading, or a required read failed. The person gets the reason, not a guess. */
export class GroundingError extends Error {}

export function unreadMessage(outstanding: readonly RequiredRead[], calls: readonly EvidenceCall[]): string {
  const failed = outstanding.filter(read => calls.some(call => call.tool === read.name && call.isError)).map(read => read.name);
  const skipped = outstanding.filter(read => !failed.includes(read.name)).map(read => read.name);
  const parts: string[] = [];
  if (failed.length) parts.push(`the required read ${failed.join(", ")} failed`);
  if (skipped.length) parts.push(`the model answered without reading ${skipped.join(", ")}, which this question requires`);
  return `No answer was accepted: ${parts.join("; ")}. Check the tool activity below and try again, or choose a model that follows tool instructions.`;
}
