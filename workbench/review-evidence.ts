import { createHash } from "node:crypto";
import type { ReviewSource } from "./review-evidence-schema.js";
export * from "./review-evidence-schema.js";
export const outputDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export function reviewSourceHash(sources: readonly ReviewSource[]): string {
  return outputDigest(JSON.stringify(sources.map(source => ({
    id: source.id, title: source.title, url: "url" in source ? source.url ?? null : null, content: source.content,
    ...("kind" in source ? { kind: source.kind, path: source.path, sha256: source.sha256, readAt: source.readAt, executionId: source.executionId } : {}),
  }))));
}
