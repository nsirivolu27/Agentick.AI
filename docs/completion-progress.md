# Workspace completion checkpoint

This branch continues the handoff in the compact Federal Spaces shell. It is a
review candidate, not a production-readiness claim. No merge, deployment,
cloud provisioning or live external write was performed.

| Feature | Implemented and checked |
| --- | --- |
| 02 MCP tools | Bounded read sessions, explicit grants, cancellation, timeouts and write-tool refusal. |
| 03 Evidence and ontology | Frozen sources and hashes, live/replay labels and source-bound review. Live Foundry access remains unverified. |
| 04 Agent Studio | Saved definitions, required sources, templates, version-bound tests and explicit assignment. |
| 05 Workflow canvas | Sequential stages, upstream input bindings and output contracts; save/reload and keyboard journeys preserve review gates. Not an arbitrary parallel DAG executor. |
| 06 Chat and connections | Provider revalidation and server-side usage/budget checks. No inference charges or new credentials in this checkpoint. |
| 07 Test portal | Assertions, frozen evidence, baseline comparison, source-bound quality thresholds and expected-tool checks with independent human review. |
| 08 Company access | Membership checks, revalidation before package mutations and clearing revoked company views on failed snapshot refresh. Email domains never establish membership. |
| 09 Review and handoff | Requested changes, revision history, invalidated approvals, frozen worker evidence and offline audit verification. |
| 10 Agent packages | Frozen definitions/cases/evaluation hashes, independent review, private export, workspace installation, explicit upgrades, stage assignment and retirement. |
| 11 External actions | Existing Jira/automation approval-before-write, duplicate reservations, concurrent changes, uncertain outcomes and restart recovery tested. Confluence remains read-only. |
| 12 Operations | Authenticated tenant-scoped health, workflow backup/restore CLI, writer-lock checks and unprovisioned AWS backup template. Single-writer limits remain. |

## Quality measures

Enable **Source-bound quality thresholds** on a case and set minimum supported/
cited percentages and expected tool names. These settings join the case/suite
hashes; changes require a new execution and review.

Every nonempty output line is a visible review unit. An independent reviewer
checks all substantive claims within each unit and marks supported, unsupported
or uncertain, with a path and quote from frozen evidence. A mechanically valid
citation requires that path in the output and the exact quote in the captured
source. Support also requires the person's judgement. Tool selection compares
actual and expected sets; it does not judge model reasoning.

The synthetic regression fixture produced **1/1 human-labelled supported unit,
1/1 valid citation and the expected read tool**. Fabricated quotes and self-review
were refused. The browser's weak scripted answer received **0 valid citations**
and could not pass a 100% threshold. These are regression results, not model
accuracy measurements. Lines are not automatic atomic-claim segmentation.
Review input is bounded to 40 units; longer answers must be shortened and retested.

## Reviewed packages

Open **Agent marketplace → Reviewed packages**. Test all current cases and record
their reviews before requesting package review. Distinct reviewers sign the
frozen content hash; the publisher cannot sign. Installation and assignment
recheck evaluations and current source evidence. The effective approval count
is the greater of the published and current workspace requirements.

An admin explicitly installs/upgrades a version, then selects a stage. Existing
stage bindings and run snapshots remain unchanged until explicit reassignment.
Retirement records its actor/time and prevents new installation or assignment.
The private export contains definitions, cases, evaluations, signature records
and a draft template. It can contain internal source content. Import only the
strict draft template: imported approvals are never trusted.

Referenced test runs must remain available and source-current. The catalogue
holds at most 100 versions and 100 installations per workspace. Pruned or changed
evidence fails closed. Hashes establish consistency, not independent digital
signer authenticity.

## Deployment work still required

- Company execution needs isolated workers, repository mounts and credentials.
  The company server intentionally does not expose host repository access;
  package execution is unavailable there. Local/demo deployments exercise it.
- Real Clerk organization membership/revocation needs target-environment
  verification. Automated identity checks use controlled fixtures.
- Live Foundry enrollment, ontology mapping and credentials remain unavailable.
  The analyst labels saved OpenFEMA data and offline Foundry replay.
- AWS resources, identities, monitoring and restoration access remain
  deployment-specific. No paid resources were provisioned.
- Confluence publishing is not implemented. Jira/Lambda delivery tests use
  fake transports; no real external write was attempted.
- Multi-instance operation requires transactional shared state and a durable
  queue. The backup excludes other stores and secrets; see
  [service recovery](service-recovery.md).

## Verification environment

Node 22.23.2; pinned pnpm 10.26.1. Checks: typecheck, test, build,
build:workbench, public analyst bundle, unchanged Studio/analyst browser
journeys, package browser journey, CLI restore and generated-endpoint smoke.
Measured results on Windows: **807 tests, 806 pass, 0 fail, 0 cancelled,
1 skipped** (the absent-package test skips because the optional provider is
installed). Typecheck, both builds and public bundle generation passed.
Studio **4/4**, analyst **1/1**, package lifecycle/quality **2/2** browser tests
passed, with responsive and WCAG checks retained. The package page was checked
at 1440, 1024, 768 and 390 pixels.

The built backup/restore CLI preserved an approved run and both reviewer records
after reopening; overwrite and wrong-workspace restores were refused. The audit
CLI verified the restored evidence. The generated public endpoint was served
locally over HTTP: a matching county made three MCP reads, a missing county made
two, and unsupported method/oversized input were refused. No live Foundry calls
or external writes were involved.

The Windows Studio journey initially failed because nested demo checkouts made
Git report '$GIT_DIR' too big. Disposable demo repositories now use the OS temp
directory. No functional or accessibility assertion was removed. Company state
retains its configured durable path.
