# Agentick | Federal Spaces demo

An analyst on one team prepares a disaster briefing. Before another team uses it, they want to know **which records support the finding, what those records cover, and who approved the wording**. Federal Spaces keeps the brief, its sources, and the review decisions together in one work item.

**The Virginia example.** The saved OpenFEMA response contains five county records for declaration **3631**. Goochland, Caroline, Montgomery, York, and Bedford each have a row. All five rows carry the same declaration number. The brief can say those counties appear in this sample. Establishing the full extent of the disaster would require checking the full declaration and current designations.

[View the presentation](https://agentick-presentation.vercel.app) · [Inspect the five source records](examples/ontology/openfema/data/virginia-snapshot.json)

![Virginia briefing during review. One reviewer has signed the submitted wording. A second approval is required before handoff.](docs/images/virginia-work-item.svg)

## Walk through the handoff

1. **Prepare the brief.** As **Operator**, open the work item and select **Prepare analyst brief**. Compare the county names and declaration number with the attached snapshot, then select **Submit for review**.
2. **Review the wording.** Under **Account → Acting as**, choose **Reviewer 1** and select **Approve this handoff**. The work item stays pending at **1 of 2**. Switch to **Reviewer 2**, check that the wording stays within the sample, and approve to complete the handoff.
3. **Check what the receiving team gets.** Download **Approval → Audit package → JSON**. The file contains the source references, original draft, submitted wording, and both reviewers’ decisions. The verification command below checks that the text matches the recorded hashes.

## Run it locally

With Node 22 and Corepack:

```powershell
git clone https://github.com/nsirivolu27/Agentick.AI.git
cd Agentick.AI
corepack pnpm install --frozen-lockfile
corepack pnpm build:workbench
corepack pnpm demo:openfema
```

Open the **work-item URL** printed in the terminal. You can play all three roles without an account or API key. The demo uses a real OpenFEMA snapshot, a rule-based analyst, and an offline replay of Foundry reads.

After downloading the audit package, open another terminal in the repository and substitute the path to your file:

```powershell
corepack pnpm audit:verify "C:\path\to\downloaded-audit.json"
```
