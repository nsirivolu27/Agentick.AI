import { z } from "zod";
import type { AgentTestRun } from "./agent-tests-model.js";

export const qualityPolicySchema = z.object({
  minSupportedRate: z.number().min(0).max(1),
  minCitationRate: z.number().min(0).max(1),
  expectedTools: z.array(z.string().trim().min(1).max(100)).max(12)
    .refine(items => new Set(items).size === items.length, "Expected tools must be unique."),
}).strict();
export const claimReviewSchema = z.object({
  claim: z.string().trim().min(1).max(4000),
  verdict: z.enum(["supported", "unsupported", "uncertain"]),
  source: z.string().trim().max(250),
  quote: z.string().trim().max(4000),
}).strict();
export const qualityReviewSchema = z.object({
  complete: z.literal(true),
  claims: z.array(claimReviewSchema).min(1).max(40),
}).strict();
export type QualityReview = z.infer<typeof qualityReviewSchema>;

/** Units make the denominator inspectable. A person judges every nonempty
 * output line and confirms coverage; a literal source match never proves meaning. */
export function claimUnits(summary: string): string[] {
  return summary.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function qualityMetrics(run: AgentTestRun) {
  const policy = run.qualityPolicy;
  const review = run.review?.quality;
  const units = claimUnits(run.summary);
  const covered = !!review && units.length > 0 && review.claims.length === units.length &&
    review.claims.every((item, index) => item.claim === units[index]);
  const claims = covered ? review!.claims : [];
  const citations = claims.filter(item => item.source && item.quote &&
    item.claim.includes(item.source) &&
    run.evidence?.some(source => source.path === item.source && source.content.includes(item.quote)));
  // Support needs both the person's judgement and a citation into captured data.
  const supported = citations.filter(item => item.verdict === "supported").length;
  const supportedRate = covered ? supported / claims.length : null;
  const citationRate = covered ? citations.length / claims.length : null;
  const actual = run.toolCalls.map(call => call.name);
  const correctTools = policy ? actual.every(name => policy.expectedTools.includes(name)) &&
    policy.expectedTools.every(name => actual.includes(name)) : null;
  return { covered, claims: units.length, supported, citations: citations.length, supportedRate, citationRate,
    correctTools, meetsPolicy: !policy || (covered && supportedRate! >= policy.minSupportedRate &&
      citationRate! >= policy.minCitationRate && correctTools === true) };
}
