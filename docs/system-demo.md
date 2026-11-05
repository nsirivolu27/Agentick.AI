# Full workflow demo

From the repository root with Node 22 and the existing dependencies:

```powershell
corepack pnpm start:demo
```

Open the printed `/#/demo` link. The default port is 4183. If it is occupied,
set `$env:MAGENTIC_AGENT_DEMO_PORT='4193'` before starting. Existing servers are
not stopped. This is a loopback-only, disposable workspace.

The launcher runs a real local lifecycle before opening the walkthrough:

1. Load the saved OpenFEMA Virginia sample into a reference document and repository file.
2. Configure a public-data analyst and an evidence reviewer with a bounded file-read tool.
3. Execute one source-reading test per agent and record synthetic evaluator reviews.
4. Publish both packages, collect two independent demo signatures, install them, and assign stages.
5. Start a briefing, run each worker, and accept each proposed output.
6. Collect two independent demo approvals for the final handoff.
7. Open the work item and download its audit package.

Each walkthrough card opens the corresponding application record. The banner
links back to the walkthrough. To demonstrate the controls manually, start another
work item, run and accept each stage, then use the Account menu to switch between
Operator, Reviewer 1 and Reviewer 2. The operator cannot approve their own output.

## What to say during a five-minute walkthrough

- **Problem:** An emergency-management team needs a traceable briefing from public data.
- **Source:** Five county rows describe one declaration; they are not five separate disasters.
- **Agent:** Explicit instructions and a read-only grant constrain the worker.
- **Test and install:** Inspect the actual read trace, evaluation, version and package signatures.
- **Workflow:** Show the two stages, accepted proposals and independent handoff approvals.
- **Evidence:** Export the audit package. Hashes prove integrity, not factual accuracy.

## Demo boundaries

The model responses and reviewer decisions are scripted fixtures. MCP file reads,
test execution, package validation, installation, workflow transitions and approval
records actually run. This demonstrates orchestration, not model quality.

The OpenFEMA data is a saved public snapshot, not a current disaster assessment or
eligibility determination. Foundry is offline replay while enrollment is pending.
No cloud deployment, billing, live company login, Jira delivery or paid inference
occurs. Company state and permissions are unchanged. Export evidence before stopping;
each launch creates a new demonstration.

For the dedicated county-query analyst, including the missing-county and fresh-source
cases, use [Public Data Analyst demo](public-data-demo.md).
