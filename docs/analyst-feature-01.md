# Analyst run completion checkpoint

## Scope

This is feature 01 of the development handoff, not a claim that features 02–12
or external services are complete. It preserves the application and presentation
design, and keeps the existing independent-review policy.

Done:

- A member with author/admin authority creates a Virginia declaration request
  with a county, question and explicit source scope.
- A saved execution ID links to the work item. Queued, running, completed,
  failed, cancelled and blocked states come from the server.
- The rule-based controller records actual scoped MCP reads, safe inputs,
  decision reasons, outcomes and measured durations. No model tokens or
  provider access are invented.
- Evidence shows its query, retrieval time, content hash, excerpt, county-row
  count and distinct declaration count. The saved five-row sample represents
  one declaration, not five disasters.
- Missing counties produce an explicitly limited draft, not a claim that
  the county was unaffected.
- A member can explicitly request a fresh bounded public-source read: at most
  two pages, five records per page, one retry per page, a twelve-second total
  deadline and a 128 KB response limit per page. Duplicate identical row IDs
  are deduplicated; conflicting versions fail.
- Failed reads can retry up to three execution attempts without creating a
  second work item. The earlier failed trace remains visible. Cancellation
  aborts the read and prevents additional calls or draft acceptance.
- Local pipeline and job records use atomic file replacement. Page refresh and a
  normal process restart recover execution IDs, traces and pipeline state.
  Interrupted executions are not silently resumed or reported successful.
- The snapshot draft is submitted through the existing work-item controls.
  Its owner cannot self-approve; one of two reviewers leaves it pending.
  Existing audit exports can be checked with the offline verifier.

Blocked:

- The company layer freezes declaration samples verified against its Foundry
  binding. Fresh OpenFEMA results are saved as analyst evidence but cannot
  become a new handoff draft until authorized grounding is configured. No
  source is disguised as already verified, and this guard is not weakened.
- Foundry calls in this demo are offline replay. A live Foundry URL, ontology,
  credentials and read-only permission check have not been verified.
- A provider-backed model is not used in this rule-based analyst path.
- The new workspace route is local, not a hosted production application.
  The existing public presentation and its public analyst remain separate.
- Analyst execution traces are saved in the local job store. The existing
  audit package covers the workflow draft, handoff, saved source and approvals;
  extending that package with the new job trace belongs in the evidence/export
  work, not an unverified claim in this slice.

## Reproduce

From a clean repository checkout, use the pinned manager:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm build:workbench
corepack pnpm demo:openfema
```

Open **http://127.0.0.1:4183/#/analyst**. This is a loopback-only development
preview, not a durable public URL. The workspace must be running.

The local demo uses synthetic member identities and real local approval
enforcement. These are not production sign-ins. The public presentation's
review simulations do not authorize company work.

State defaults to `.magentic-dev/openfema/`. To use a different private local
directory, set `AGENTICK_ANALYST_DIRECTORY` on the server. It is read through
`setting()` and is never sent as a provider credential. The store assumes a
single process; it is not a multi-instance database, distributed queue, backup
service or production storage certification.

1. In Services → Work → Public data analyst, enter county **Montgomery**,
   question **Which declaration covers the county in the saved sample?**,
   and keep **Saved five-row snapshot** selected.
2. Run the agent. Inspect the actual `get_pipeline_run`,
   `summarize_declaration_sample` and `get_ontology_object` calls. Read the
   offline replay labels, source hash and five-row/one-declaration count.
3. Refresh the page. The URL, execution ID, trace and work item remain the same.
4. Choose **Review output**, inspect the saved draft and source, then
   **Submit for review**. The owner has no approval action.
5. In the demo Account menu, independently act as Reviewer 1 and approve.
   Confirm **1 of 2** and that the handoff remains pending.
6. Only if demonstrating two distinct eligible synthetic reviewers, use
   Reviewer 2 for the second signature. Never describe these as actual company
   teammates approving production work.
7. Download the work item's JSON audit package and run:

```sh
corepack pnpm audit:verify /path/to/audit-package.json
```

Integrity verification does not certify completeness, compliance or factual
accuracy. Editing a covered field must fail verification.

8. Start a second saved-snapshot request for **Fairfax**. Inspect the missing
   county limitation. It must not claim that the county was unaffected.
9. A live-source lookup is an explicit choice. Its network failure is visible;
   a successful read still stops at the source-grounding boundary above.

## Verification entry points

```sh
corepack pnpm exec playwright test --config tests/analyst-ui.config.mjs
node workbench/build-public-analyst.mjs
```

The browser regression uses an isolated temporary local state directory. It
checks a recoverable request failure without losing entered text, saved-run
refresh, the expected tool sequence, source limits, keyboard Services behavior,
WCAG-tagged axe assertions, the real pending gate, audit tamper detection and
layout at 1440, 1024, 768 and 390 px.

The source fixture is shared with the public API bundle. When it or the public
handler's dependencies change, regenerate `docs/site/api/analyst.mjs`; do not
edit the original presentation layout as part of this application work.

## Next checkpoint

Resolve the authorized fresh-source grounding boundary before claiming the
whole feature-01 live-source handoff path complete. Then implement feature 02,
the shared MCP connection/grant foundation. Do not skip ahead to provider,
payment or cloud activation with unverified settings.

## Verified results for this checkpoint

Local verification used Node 24.21.0 and the pinned pnpm 10.26.1.

| Check | Result |
| --- | --- |
| `corepack pnpm typecheck` | Passed |
| `corepack pnpm test` | 773 tests: 771 passed, 2 skipped, 0 failed |
| `corepack pnpm build` | Passed |
| `corepack pnpm build:workbench` | Passed |
| Focused browser journey | Passed at all four requested widths |
| WCAG-tagged axe assertions | Zero violations in the tested analyst page |
| Independent gate and export | Owner denied; one eligible reviewer remains 1 of 2; downloaded package verifies; tampering fails |
| Actual local process restart | Same saved IDs, three-call trace, fresh evidence and 1-of-2 pending gate recovered |
| Regenerated public API bundle | Matching GET: 3 tools; limited GET: 2 tools; POST: 405 |
| Existing published analyst endpoint | HTTP 200; no production update made |
| Real bounded OpenFEMA read | 10 rows / 10 distinct declarations within the bounded result; not a full-dataset total |
| Authenticated live-source execution | Actual fresh evidence saved; explicitly blocked at the verified-source grounding boundary; no draft accepted |

The browser report covers synthetic local identities, not real company
authentication. GitHub CI is separate from these local results and must be
checked on the pull request before any authorized merge.
