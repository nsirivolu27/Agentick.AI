# Claude and the workspace MCP tools

Two directions, both on existing routes.

## Claude as the model, calling Agentick's tools natively

A workspace Claude connection (Connections → Workspace connections → Claude)
is used by Ask Agent, workspace chat and the stage and agent runs that select
a `workspace/anthropic/<model>` id. When the model is Claude, the workspace
chat no longer asks for JSON decision text. Instead:

* The read only MCP tools the workspace offers (`list_approved_agents`,
  `get_approved_agent`, `get_workspace_policy`, `get_pipeline`,
  `get_pipeline_run`, `list_documents`, `read_document`, the ontology and
  Zenfluence reads when enabled) are sent to the Messages API as `tools`,
  with their MCP input schemas unchanged.
* Each `tool_use` block Claude returns is checked against that list and run
  through the same read only session as before: the same grants, the same
  call limit (4 plus the required reads), the same 30 second per call bound,
  the same membership check on every turn. The MCP result goes back as a
  `tool_result`; an MCP error goes back with `is_error`.
* Grounding is unchanged. The reads a question requires are decided from the
  request. Zero argument required reads are made by the server before Claude
  speaks and travel with the question as data. If Claude answers without a
  required read it is corrected once inside the conversation; a second
  skipped answer is refused with the reason, exactly as for other models.
* Token usage is summed across turns and shown with the answer. Evidence
  lists every call with `initiatedBy: "server" | "model"`.

Other providers keep the JSON decision protocol; nothing changed for them.
The adapter lives in `model-catalog.ts` (`converse` on the Claude model),
the loop in `chat.ts` (`nativeTurns`), and the connection wrappers in
`chat-access.ts` re-check the saved connection on every native turn, so a
disconnect stops the next call. Workflow agents (`bot-worker.ts`) still use
the JSON protocol; moving them to native tool use is a separate change.

The only outbound address is `https://api.anthropic.com/v1/messages`, with
redirects refused. No key is logged, echoed or stored outside the vault.

## Claude Code or another MCP client, calling Agentick

Connections → MCP access creates a seven day credential scoped to one member
and workspace. Register the server as an HTTP MCP server:

```
claude mcp add --transport http agentick http://127.0.0.1:4182/api/chat-mcp --header "Authorization: Bearer <credential>"
```

Replace the address with the one the Connections page shows. The server
offers `list_chat_models` and `chat`. The `chat` tool sends the conversation
to the chosen provider (including a workspace Claude connection) and can
incur charges; it uses no workspace tools or profiles. Claude Desktop custom
connectors need a reachable HTTPS address with OAuth discovery, which this
server does not implement; use Claude Code or any client that accepts a
bearer header. Do not paste the credential into a conversation or commit it.

The registry and pipeline MCP routes (`/api/mcp`, `/api/pipeline-mcp`) use
the per workspace token shown under Workspace MCP access and expose the read
tools described above to any MCP client the same way.
