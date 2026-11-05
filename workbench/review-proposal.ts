/**
 * Shared between the engine and the browser views, so it imports nothing
 * from Node. A proposal names who a handoff was sent to; this answers who
 * still has to sign it.
 */
export interface ReviewProposalLike { reviewers: readonly string[] }
export interface ProposedStage { approvals: readonly string[]; proposal?: ReviewProposalLike | undefined }

/** Named reviewers who have not signed the current output yet. */
export function pendingReviewers(stage: ProposedStage): string[] {
  return (stage.proposal?.reviewers ?? []).filter(reviewer => !stage.approvals.includes(reviewer));
}
