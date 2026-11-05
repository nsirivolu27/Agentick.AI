# Workspace API integration completion plan

Agentick connects company evidence, models and reviewed actions in one workflow:
**connect → read → attach → run → test → approve → deliver → inspect receipt**.
Complete the integrations below in order. A setup screen or a passing fixture
test is not proof that a real company account is connected.

## Free tier

The first release uses the existing local and bring-your-own-key model.

| Capability | Free contract |
|---|---|
| Local chat | Installed Ollama models reachable from the application server. Hardware and hosting are supplied by the operator. |
| Personal model connections | OpenAI, Anthropic and Google API keys, scoped to member and workspace. Provider charges remain the user's responsibility. |
| Model choice | Manual selection. Managed Auto routing and platform-funded tokens require a verified Pro or Max plan. |
| Workspace chat | Authorized read tools and available reference documents; existing membership, grants and approval rules remain enforced. |
| Chat MCP | Revocable seven-day credential for a compatible client when chat access is configured. |
| Agent workflows | Use operator-configured models. Personal chat keys are not inherited by scheduled agents. |
| Company data | Each connector needs its own administrator configuration and upstream permission. Free does not bypass Foundry company bindings. |
| Billing | No Agentick subscription required for local or personal-key chat. No included hosted infrastructure, managed credits or unlimited-use promise. |

Do not invent seat counts, storage quotas or paid prices. Current concurrency,
storage and tool limits are operational safeguards, not advertised plan quotas.
Sign-in is not model authorization. Pro and Max prices and allowances come from
verified server configuration, not browser claims. Billing does not grant a role.

### First usable journey

1. Open **Connections**. Choose an installed local model or verify a personal API
   key and text model IDs. Verification lists models; it does not perform inference.
2. Open **Chat**, manually select that model and send a small request. Record
   reported input/output tokens and elapsed time. Unknown usage stays unknown.
3. Add a synthetic runbook under **Reference documents**. Choose **Ask Agent**,
   then **Draft documentation**, review the prepared prompt and send it.
4. Check the source, tool result and citations. Choose **Review as document**,
   then explicitly save. This does not approve or publish the output.
5. Configure a workflow agent with an operator model, bounded read grants and
   tests. Review output under a different authorized identity. Company mode
   additionally requires a real Foundry Workflow mapping.

Local/demo mode can exercise this journey without paid billing. Scripted demo
responses must stay labelled; demo reviewers are not production identities.

## Integration inventory and completion order

Statuses below describe source implementation, not the current user's live accounts.

| Order | Integration and workspace use | Current implementation | Remaining acceptance work |
|---|---|---|---|
| 01 | Local and personal model APIs | Ollama; personal OpenAI, Anthropic, Google; operator Azure/gateway adapters. Free onboarding and API guide in Connections. | Live inference per configured provider, revoked-key behavior, reported usage. No new account or paid call without authorization. |
| 02 | Jira and Confluence evidence | Zenfluence reads configured Cloud tickets/pages, accepts canonical links, attaches hash-bound snapshots and exposes read MCP. | Configure a restricted company service account; read one real ticket and page, attach both, test changed-source refusal and cross-workspace denial. OAuth/scoped-token gateway and Data Center adapters remain separate work. |
| 03 | Jira delivery | Separate preview, authorization, delivery and receipt layer. | Verify configured issue creation/comment/transition against a test project with explicit write authorization; inspect duplicate, failed and uncertain outcomes. |
| 04 | Documentation and Confluence publication | Local reference documents and explicit draft saving work. Confluence import works. | Implement a separate publish adapter: preview exact space/page/body, bind approval to content and page version, refuse conflicts, retain receipt. No direct model write tool. |
| 05 | External MCP servers | Existing bounded sessions and read grants; chat and pipeline MCP endpoints. | Run a real allowed server, verify advertised input schemas, timeout/cancellation, denied tool and tenant isolation. Confirm each entry point loads the configured server. |
| 06 | Repository and CI/CD | Repository tools, worker records, frozen file evidence and review paths exist. | Exercise an isolated repository; validate checkout ownership, test evidence, approved patch application and CI result import. Do not infer a complete GitHub app/OAuth integration from local tools. |
| 07 | OpenFEMA and Palantir Foundry | Ingest/mapping code, ontology read adapter and company Workflow ownership checks exist. | Real Foundry environment remains blocked by waitlist. Load data, verify ontology/object IDs and company binding, run analyst with live provenance. Replay is not live Foundry. |
| 08 | Clerk company identity | Verified sessions, organization membership and role mapping. | Real invite, removal and stale-session checks. No membership from email domain; keep independent-review requirements. |
| 09 | AWS automation | Pinned Lambda invocation, reviewed payload, durable attempt receipts and restart handling. | Approved AWS role/function, explicit live invocation, failure/uncertainty drill. Canvas dispatch UI and additional cloud adapters remain unfinished. |
| 10 | Stripe managed plans | Pro/Max checkout, portal and server-rechecked managed-chat entitlements. | Provider test-account lifecycle and deployment reconciliation assessment. No production charge during this completion work. Free chat stays independent of checkout. |
| 11 | Slack, Teams and email | Do not assume a production connector from a label or preview. Email previews exist. | Inspect each transport before implementing. Add reviewed destinations, credential storage, redaction, delivery receipts and opt-out; no autonomous messaging. |
| 12 | SharePoint, Drive and other company knowledge | Not established by this inventory. | Select one provider, implement scoped read/import with provenance, revocation and source-version checks before advertising it. |

### Connection states

Connections is the directory; each connector's setup stays on its own page.
A state means one thing: **not configured** (nothing set), **configured but
unverified** (settings exist, nothing proved), **access verified** (a bounded
check such as a model list or a source read succeeded), **last operation
succeeded** (the last real read, draft or reviewed delivery through it
worked), **unavailable** (configured, but the last check or operation
failed, with the reason). A saved key is at most verified access; a grounded
chat answer, an attached snapshot or a sent Jira action is a succeeded
operation. Identity and billing are pointers to Account: a subscription never
grants membership or approval authority.

### Order 01 acceptance record

- [x] Free capabilities and costs documented without inventing plan quotas.
- [x] Connections offers the local/key → chat → evidence → agent journey.
- [x] Integration destinations and chat REST guide remain visible during setup errors.
- [x] Server regression coverage includes no-paid-access behavior and connection isolation.
- [ ] Real provider inference and upstream revocation measured with authorized credentials.

**Next: Order 02.** Finish one company evidence path before adding more vendors.
The same human should be able to connect, locate a ticket, understand the
permission scope, read a page, attach evidence and inspect the resulting draft.

## Existing API map

Use the authenticated workspace session and the existing request origin checks.
These are application endpoints, not substitutes for the providers' APIs. Optional
services may be unavailable; inspect configuration before calling them.

| Endpoint | Purpose and boundary |
|---|---|
| GET /api/connections | The Connections directory: every connector with one state (not configured, configured but unverified, access verified, last operation succeeded, unavailable), read/write capability and the last real operation. Built from the runtimes' own summaries; holds no credential. |
| GET /api/chat/access | Current plan, personal connection summaries and MCP expiry; no raw keys. |
| GET /api/chat/models | Member-visible models; availability is not measured inference quality. |
| POST /api/chat/connections | Strict connect/disconnect command; personal secret storage. |
| POST /api/base-chat | General model chat without workspace tools. |
| POST /api/chat | Workspace chat with authorized read tools. |
| POST /api/chat/access | Issue/revoke a chat MCP credential. |
| /api/chat-mcp | Streamable HTTP chat MCP; credential, membership and usage checks. |
| GET/POST /api/zenfluence | Connection summary; read or attach a source with version/hash checks. |
| GET/POST /api/jira | Configured Jira inspection and action commands. |
| POST /api/documents | Explicit document commands; author permissions apply. |
| POST /api/ontology/reference | Resolve and attach configured ontology evidence. |
| /api/pipeline-mcp | Pipeline tools; agents receive only their allowed read subset. |
| GET/POST /api/automation-units | Inspect, preview and explicitly invoke configured Lambda units as admin. |
| GET /api/account; POST /api/account/billing | Inspect account; authorized billing action. |

The request schemas in the implementation are authoritative. Start with the
[Zenfluence REST examples](zenfluence.md#contract),
[chat setup](universal-chat.md), [company setup](account-portal.md#company-workspaces)
and [Lambda delivery contract](automation-units.md).

## Completion evidence required for each connector

1. **Contract:** supported deployment/product, endpoint, schema, auth method and
   least-privilege scopes. Mark unsupported operations explicitly.
2. **Workspace:** resolve identity and membership on the server; reject foreign
   IDs and stale access. Keep secrets out of prompts, exports and logs.
3. **Read path:** bounded retrieval; source URL, revision, time and hash;
   truncation and missing-source states are visible.
4. **Write path:** separate preview and explicit authorization; recheck source
   and output hashes; durable receipt and safe handling of uncertain results.
5. **User journey:** connect, retry, disconnect, draft, test, review and inspect
   history through the actual workspace. No placeholder button counted as done.
6. **Tests:** happy path, denied access, changed source, duplicate request,
   cancellation, malformed provider response and restart where relevant.
7. **Live record:** environment, operation, real result, time, usage where
   provided, and remaining blocker. Never copy credentials into the record.

## Federal demo boundary

Use public OpenFEMA data and synthetic internal documents until an authorized
agency environment and data-handling policy exist. The current Atlassian adapter
is Cloud site-based; it does not imply government endpoint support. The company
server remains single-writer. A passing local demo is not a federal authorization,
production scaling guarantee or measured semantic-accuracy result.
