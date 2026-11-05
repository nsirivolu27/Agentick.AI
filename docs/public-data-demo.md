# Public data analyst demo

For emergency-management analysts preparing a disaster-declaration briefing
for a team lead or program manager. FEMA is the public data source, not a
customer or endorsement.

## Start locally

With repository dependencies already installed:

```powershell
corepack pnpm start:analyst
```

This builds the current workbench and starts the dedicated demo on port 4183.
Open the printed URL. If that port is occupied, set
`$env:MAGENTIC_AGENT_DEMO_PORT='4190'` before running the command. Do not
stop another server to make room.

The demo stores work in `.magentic-dev/openfema/`. Set
`AGENTICK_ANALYST_DIRECTORY` to a separate private folder when running another
instance. Never share a writable data directory between running instances.
The regular local workspace does not gain demo identities or a replay adapter.

## Five-minute walkthrough

1. Open **Public data analyst** and select **County briefing**.
2. Inspect the county, question and saved-source scope; select **Run agent**.
3. Show the result: five county rows, one declaration, three successful MCP
   reads. Montgomery appears under declaration 3631 in the saved sample.
4. Expand the source query and hash. Open **Download briefing** for a
   portable evidence report. It is not an approved handoff.
5. Open **Review output**, inspect the draft, then **Submit for review**.
   The owner cannot approve their own work. A demo reviewer can supply one
   signature; the handoff remains pending at one of two.
6. Use **Missing county** to show that absence from this small sample does
   not establish absence of disaster impact.

## Live source boundary

**Fresh evidence** explicitly requests a bounded OpenFEMA query. It returns
at most ten rows from two pages. A successful read produces a saved analysis
report and tool trace. An outage produces a visible failure, never a substituted
snapshot.

Fresh results cannot become a handoff in the replay-bound workflow. The page
keeps submission blocked until authorized Foundry grounding is configured.
Foundry enrollment remains waitlisted; no live Foundry connection is claimed.

The controller chooses tools through rules, not LLM inference. The free-form
question records intent; county and source scope determine the actual lookup.
This demo does not determine eligibility, award assistance, or deploy services.
