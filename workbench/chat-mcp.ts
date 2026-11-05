import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { chatRequestSchema, runBaseChat, untilAborted, type ChatEvent } from "./chat.js";
import { contextMessages } from "./chat-settings.js";
import { ChatAccessError, type ChatAccess } from "./chat-access.js";

export function createChatMcpServer(access: ChatAccess, workspace: string, actor: string, member: () => Promise<boolean>, budgetMs = 120_000) {
  const server = new McpServer({ name: "magentic-chat", version: "0.1.0" });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  server.registerTool("list_chat_models", {
    description: "List models available to this credential's member and workspace. No credentials are returned.", inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    if (!(await member())) return { ...result({ error: "Workspace access is no longer available." }), isError: true };
    return result({ models: await (await access.configuration(workspace, actor)).modelOptions!() });
  });
  server.registerTool("chat", {
    description: "Send a text conversation to a connected model. This transmits the supplied conversation to its provider and can incur API charges. Auto may change providers only when routing is explicitly auto and the member has paid access. No workspace tools, files, web search, or approved profiles are used.",
    inputSchema: chatRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => {
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, extra.signal]);
    const timeout = setTimeout(() => controller.abort(), budgetMs);
    try {
      if (!(await untilAborted(member(), signal))) throw new ChatAccessError(403, "Workspace access is no longer available.");
      if (input.profile) throw new ChatAccessError(400, "The chat MCP tool does not accept assistant profiles.");
      release = access.acquire(workspace, actor);
      const prepared = await untilAborted(access.prepare(workspace, actor, input), signal);
      signal.throwIfAborted();
      const model = await untilAborted(prepared.config.loadModel(prepared.model, prepared.maxOutputTokens === undefined ? undefined : { maxOutputTokens: prepared.maxOutputTokens }), signal);
      let answer: ChatEvent | undefined;
      await runBaseChat(contextMessages(input.messages, input.history ?? "recent"), model, signal, event => { if (event.type === "answer") answer = event; });
      if (!(await untilAborted(member(), signal))) throw new ChatAccessError(403, "Workspace access is no longer available.");
      return result({ model: prepared.model, ...(prepared.route ? { route: prepared.route } : {}), answer });
    } catch (error) {
      return { ...result({ error: error instanceof ChatAccessError ? error.message : signal.aborted ? `The model request stopped or exceeded its ${budgetMs / 1000} second budget.` : "The model request failed. Check the connection and retry." }), isError: true };
    } finally { clearTimeout(timeout); release?.(); }
  });
  return server;
}

export async function handleChatMcp(access: ChatAccess, workspace: string, actor: string, member: () => Promise<boolean>, request: IncomingMessage, response: ServerResponse, raw: unknown, budgetMs?: number) {
  const server = createChatMcpServer(access, workspace, actor, member, budgetMs);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  response.once("close", () => { void server.close().catch(() => undefined); });
  try {
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response, raw);
  } catch (error) { await server.close(); throw error; }
}
