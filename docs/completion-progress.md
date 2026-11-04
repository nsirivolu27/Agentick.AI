# Workspace completion progress

Continue the full development handoff, keeping the Federal Spaces-style compact
header, searchable Services menu, green/black palette, shared panels and keyboard
controls. Do not replace the application or add an oversized persistent sidebar.

Feature 01 is verified in the preceding checkpoint. This continuation covers
features 02–12 without requiring a new user approval between implementation
slices. Main merges, production deployment, paid resources and live external
writes still require the corresponding authorization.

| Feature | Current checkpoint |
| --- | --- |
| 02 MCP tool access | Shared immutable read-session guard and stage-grant display implemented; first 35 targeted tests passed |
| 03 Evidence and ontology | Execution-mode/source hashes and cancellation propagation verified: 780 tests passed, 2 skipped; builds and analyst browser journey passed |
| 04 Agent Studio | Named required sources and two presets added; 35 focused tests, save/test/independent-approval and responsive browser journeys, and type checking passed |
| 05 Workflow canvas | Explicit output bindings/contracts passed 30 focused tests, type checking and save/reload/responsive browser journey |
| 06 Chat and connections | Cached personal models recheck revocation; 42 focused tests and type checking passed; combined checkpoint: 785 passed, 2 skipped |
| 07 Test portal | Frozen source snapshots, current-source gating and same-input baseline comparisons passed 20 tests, type checking and the responsive/accessibility browser journey |
| 08 Company workspaces | Existing Clerk boundary passed 17 tests covering membership refresh, tenant isolation, provisioning and origin protections; live organization setup remains deployment-specific |
| 09 Review and handoff | Combined checkpoint: 791 passed, 2 skipped; type checking/build passed. Browser correction/approval/export and test-portal journeys passed, including actual worker-file source snapshots |
| 10 Company marketplace | Reviewed model releases separated from draft templates; release eligibility rechecked at approval/install; catalogue verification running |
| 11 External actions | Existing adapters retained; idempotency and authorization verification pending |
| 12 Service operations | Recovery, backup/restore and deployment readiness work pending |

External live services must remain explicitly unconfigured or blocked until
real settings, permissions and checks exist. A mocked model, replayed ontology
or local synthetic reviewer is never described as a live production capability.

Review evidence now preserves before/after text, reasons, invalidated approvals
and frozen source snapshots. New approvals bind the output version and source
hash. Worker logs are explicitly bounded to their latest 50 events; exports
must not describe them as complete provider transcripts. Package checksums
prove internal consistency, not independent signer authenticity.

Operational sizing must account for up to 12 project-file snapshots per
execution (30,000 characters each), retained test/run history and atomic JSON
rewrites. This local persistence design is not a multi-instance database.

Browser resource notes: automatic Playwright trace capture caused memory
pressure in this workspace. The revision journey passed with trace capture off
and PLAYWRIGHT_SINGLE_PROCESS=1; the accessibility/test-portal journey passed
with trace capture off and bounded isolated renderers (PLAYWRIGHT_LOW_MEMORY=1).
All functional assertions and explicit screenshots remained enabled.

## Remaining implementation checkpoints

- Workflow canvas currently represents a bounded sequence. Add explicit upstream
  output bindings and an output contract, preserve them on save/reload, reject
  unknown or forward/self references, and make both worker and scheduler consume
  only the selected outputs. Keep keyboard editing and existing review gates.
- Agent tests currently separate execution from human review, but expectations
  are descriptive. Add version-bound automatic assertions and candidate/baseline
  comparisons before claiming the full test-portal requirement.
  The assignment guard now requires a passing quality review, passing assertions,
  current source hashes and matching agent/case/suite versions. Expected answers
  are no longer passed into the model. Baseline comparisons require identical
  case/suite and frozen source bindings. Do not label substring checks as semantic
  proof of a claim. Expanded browser verification is still in progress.
- Audit exports currently contain outputs, materials and pipeline events.
  Complete revision/request-changes handling and included execution evidence
  before claiming the review/handoff checkpoint.
- Verify company revocation, marketplace eligibility, action idempotency and
  backup/restore against their existing implementations; do not infer readiness
  from the presence of source files.

## Verification environment

The first full checkpoint passed type checking, 780 unit tests (2 skipped),
both builds and the analyst browser journey. The test script now limits file
concurrency to two. A 384 MB compiler heap was insufficient; use the previously
successful 512 MB limit and avoid simultaneous compiler/browser processes.
Chromium's single-process mode crashed between two browser contexts; run the
Studio journeys in separate browser invocations in this constrained environment.
These environment failures are not recorded as passing application checks.
