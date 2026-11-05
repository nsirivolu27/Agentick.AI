import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { memoryPipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { reviewBrief, reviewSources, sourceSnapshots } from "../workbench/review-brief.js";
import { outputReview } from "../workbench/output-review.js";

function fixture() {
  const engine = memoryPipelines();
  const config = structuredClone(DEFAULT_PIPELINE);
  config.stages[0]!.approval = true;
  engine.execute("team", "admin", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const initial = engine.execute("team", "author", ["author"], { action: "start", requestId: randomUUID(),
    title: "Review a documentation answer", brief: "Explain the approval process.",
    materials: [{ id: randomUUID(), title: "Policy", content: "Original policy." },
      { id: randomUUID(), title: "External reference", content: "", url: "https://example.invalid/policy" }] }, 2).runs[0]!;
  const run = engine.execute("team", "author", ["author"], { action: "complete", runId: initial.id,
    expectedRevision: initial.revision, note: "A human approves the request." }, 2).runs[0]!;
  return { engine, run };
}

test("reviewers see the submitted sources, never later workspace material", () => {
  const { run } = fixture();
  run.materials![0]!.content = "Changed policy.";
  assert.equal(reviewSources(run, 0).sources[0]!.content, "Original policy.");
  assert.match(sourceSnapshots(run, 0), /Original policy/);
  assert.doesNotMatch(sourceSnapshots(run, 0), /Changed policy/);
  assert.match(reviewBrief(run, 0), /1 captured source · 1 link-only reference/);
});

test("missing submitted evidence is explicit and does not fall back to current sources", () => {
  const { run } = fixture();
  delete run.sourceHistory;
  assert.deepEqual(reviewSources(run, 0), { sources: [], recorded: true, missing: true });
  assert.match(sourceSnapshots(run, 0), /snapshot is unavailable/);
  assert.doesNotMatch(sourceSnapshots(run, 0), /Original policy/);
  assert.match(reviewBrief(run, 0), /Snapshot unavailable/);
});

test("captured source content is escaped and link-only references are not evidence of support", () => {
  const { run } = fixture();
  run.sourceHistory![run.stages[0]!.sourceHash!]![0]!.content = '<script>alert("bad")</script>';
  const html = sourceSnapshots(run, 0);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /A link alone does not establish support/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("review brief preserves owner exclusion, approval counts and the request-changes action", () => {
  const { engine, run } = fixture();
  const before = structuredClone(run);
  const owner = outputReview({ run, phase: 0, actor: "author", roles: ["admin"], where: "desk" });
  const reviewer = outputReview({ run, phase: 0, actor: "reviewer", roles: ["approver"], where: "desk" });
  assert.match(owner, /0 of 2 required approvals/);
  assert.doesNotMatch(owner, /data-pipeline-action="approve"/);
  assert.match(reviewer, /data-review-command="request_changes"/);
  assert.match(reviewer, /do not prove factual accuracy/);
  assert.deepEqual(run, before);
  const signed = engine.execute("team", "reviewer", ["approver"], { action: "approve",
    runId: run.id, expectedRevision: run.revision }, 2).runs[0]!;
  assert.equal(signed.stages[0]!.status, "awaiting_review");
  assert.match(reviewBrief(signed, 0), /1 of 2 required approvals/);
});

test("future stages do not inherit current-stage sources or claim a completed review", () => {
  const { run } = fixture();
  assert.deepEqual(reviewSources(run, 1), { sources: [], recorded: false, missing: false });
  assert.equal(reviewBrief(run, 1), "");
  assert.equal(sourceSnapshots(run, 1), "");
});
