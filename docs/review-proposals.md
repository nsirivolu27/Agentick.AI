# Review proposals and dataset profiles

Two additions to the workflow engine. Both keep every existing gate; neither
changes an existing API action's shape beyond optional fields.

## Proposing a handoff to named reviewers

A handoff used to go into an anonymous pool: any eligible approver could sign
and the stage completed once the required count was met. It still can. On top
of that, the author can now propose the handoff to named people.

* `complete` accepts an optional `reviewers` list (at most 8 member IDs). The
  run owner and the output author cannot be named. The server checks every
  name against the member directory and refuses anyone who is not an approver
  or admin, so a proposal can always be completed.
* The stage records `proposal: { by, at, reviewers, outputHash }` and the run
  gets a `proposed` event after `review_requested`.
* The gate is the count floor plus the names: the stage completes when
  `approvals.length >= requiredApprovals` **and** every named reviewer has
  signed. A signature from someone outside the proposal still counts toward
  the floor.
* `request_changes` and `revise` keep the proposal; a resubmission without a
  new list goes back to the same people. Approvals are cleared as before.
* `add_reviewers` lets a named reviewer, the owner or an admin bring more of
  the team in while the handoff awaits review. Names fold into the existing
  list; the same checks apply.
* `comment` adds a note to the open stage from any member. Each comment
  records the output hash it was written against, so a comment about an
  earlier revision is marked as such.
* The audit package carries the proposal and the comments, and its verifier
  refuses a completed gated stage whose named reviewers did not all sign.

On the work item the Approval block shows who the handoff was proposed to,
who has signed, who is still needed, an **Ask more of the team** form for
those allowed to widen the review, and the discussion thread. A reviewer whose
signature is still needed sees **Proposed to you** on the stage and in the
work list. When the member directory can list approvers, the proposal field
offers them; otherwise it is a plain comma separated list of IDs.

## Dataset profiles for agents

Workflow agents and agent tests can be granted `profile_project_file` next to
the three repository tools. It returns a profile computed by the application
for a `.csv`, `.tsv`, `.json` or `.jsonl` file in the attached repository, up
to 4 MB: row count, each column's type (number, text or empty), present and
missing counts, distinct values, numeric minimum, maximum and mean, a few
example values, and the SHA-256 of the file it was computed from. No code is
executed and no model counts anything.

The profile satisfies a required source read and is recorded as evidence
under the dataset path with the file hash inside, so reviewers see the numbers
the agent was given. The **Public data analyst** starter now profiles first
and reads second. The agent test log records a profile as a read of the file.

Agent tests also check readiness against the workspace catalog, so an agent
on a workspace connection (`workspace/anthropic/...`) is accepted the same way
a stage run already accepted it.
