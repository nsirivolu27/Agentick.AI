# Resource assistant

Each workspace resource exposes **Ask Agent** in its header. Choose Explain,
Check gaps or Draft documentation. The action opens a separate workspace chat
with an editable prompt; it does not send automatically. The previous chat is
kept in memory and can be restored. Reloading the page clears unsaved chats.

Only the page label and routing identifier are carried automatically. Unsaved
fields, credential inputs and hidden page content are not collected. The person
reviews the prompt and selected model before sending. Hosted models may receive
included messages and authorized tool results under the existing chat policy.

The assistant uses the existing authenticated, read-only MCP chat path. It can
read workspace configuration, work items, registered definitions, document
metadata, bounded document text, and configured Zenfluence / Ontology sources.
A visible Ask Agent button does not imply every resource has a dedicated read
tool. The prompt requires the assistant to identify unavailable evidence rather
than invent it. It cannot approve, install, execute, publish or alter permissions.

`read_document` checks workspace membership through the chat/tool session,
looks up the id in that workspace, refuses flagged credentials, rescans the
stored content and returns at most 4,500 characters with a hash and truncation
flag. Pattern detection is not comprehensive DLP. `get_zenfluence_source` retains
the connector's configured site, project and space restrictions.

**Review as document** is available to authors/admins when the document portal
is enabled. It opens an unsaved, labelled draft. Existing document drafts are
not overwritten. The person edits and explicitly saves; attaching, review and
publishing remain separate actions. Workspace/identity changes clear pending
context and drafts.

The scripted local demo quotes actual MCP results and identifies itself as a
fixture. It is not evidence of live-model accuracy or federal authorization.
