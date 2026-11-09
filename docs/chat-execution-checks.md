# Chat execution checks

Workspace chat and General chat have different contracts. Workspace chat can
read authorized workspace tools; General chat and Chat MCP only call a model.
Neither surface approves a release or performs external delivery.

## Required reads

Workspace questions select required reads before inference. Zero-argument
reads can be performed by the server. Reads requiring arguments must be
requested by the model. An explicitly named, unavailable read is refused
before inference. A missing required read gets one correction before refusal.

Answer evidence records the tool, arguments, result hash, size and whether
the server or model initiated the call. Successful reads establish access to
evidence, not the correctness of the generated answer. Server-prefetched
evidence is not a measurement of model tool selection.

## Timeouts and recovery

`MAGENTIC_CHAT_TIMEOUT_SECONDS` controls the browser chat and Chat MCP budget.
The local default is 600 seconds; the company default is 120 seconds. Tool
calls are capped at 30 seconds and the remaining workspace-chat budget.
Cancellation releases the chat slot. A new request can run after a timeout.

Connection reporting reuses the validated model choice rather than repeating
provider discovery after acquiring the chat slot. Personal-provider outcomes
and model-read measurements are isolated by workspace and member. Membership
is checked again before a workspace answer is delivered.

## Regression coverage

`tests/chat-execution-regressions.test.ts` covers evidence origin, unavailable
reads, membership revocation during inference, personal connection isolation,
provider discovery count, and Chat MCP timeout recovery.

The existing grounding, connection-directory and documentation-journey tests
remain unchanged. Their scripted model results must not be described as
live provider accuracy or successful external delivery.

## Verified on Windows

On 2026-11-04, typecheck, build and workbench build passed. The final full
suite reported 839 tests: 838 passed, 1 skipped, 0 failed, 0 cancelled.
An earlier run hit a Git failure in an unchanged editor test; its isolated
rerun and the complete final rerun passed without changing that test.

The installed Ollama model `qwen2.5-coder:1.5b` answered the original
approval-count question in a fresh local workspace. The server read
`get_workspace_policy`; the answer correctly reported one required approval.
Reported usage was 1,173 input and 20 output tokens, taking 95.6 seconds.
Evidence identified one server read and zero model-requested reads.
This verifies this example only, not general answer accuracy.

Cloud providers, live Foundry and external delivery were not exercised.
