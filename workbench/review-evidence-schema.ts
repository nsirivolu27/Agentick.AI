import { z } from "zod";
import { materialSchema } from "./materials.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const fileSourceSchema = z.object({
  kind: z.literal("project-file"), id: z.string().uuid(), executionId: z.string().uuid(),
  title: z.string().max(120), path: z.string().max(250), content: z.string().max(30_000),
  sha256: hash, readAt: z.string().datetime(),
}).strict();
export const reviewSourceSchema = z.union([materialSchema, fileSourceSchema]);
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
export const approvalRecordSchema = z.object({
  actor: z.string(), at: z.string().datetime(), version: z.number().int().min(1), outputHash: hash, sourceHash: hash,
}).strict();
export const outputRevisionSchema = z.object({
  version: z.number().int().min(1), kind: z.enum(["submitted", "revised", "changes_requested"]),
  by: z.string(), at: z.string().datetime(), reason: z.string().max(4000),
  before: z.string().max(4000), after: z.string().max(4000), beforeHash: hash, afterHash: hash, sourceHash: hash,
  priorApprovers: z.array(z.string()), priorApprovals: z.array(approvalRecordSchema),
}).strict();
export const sourceHistorySchema = z.record(hash, z.array(reviewSourceSchema).max(21));
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type OutputRevision = z.infer<typeof outputRevisionSchema>;
