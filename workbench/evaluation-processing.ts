import { open, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { evaluateBundle } from "./evaluation-bundle.js";

const identitySchema = z.object({
  workspaceId: z.string().min(1).max(128),
  runId: z.string().uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function runEvaluationProcessing(inputDirectory: string, outputDirectory: string, identity: z.infer<typeof identitySchema>) {
  const binding = identitySchema.parse(identity);
  const file = await open(join(inputDirectory, "evaluation.json"), "r");
  let bytes: Buffer;
  try {
    // A fixed read bound also handles a file that grows after stat.
    bytes = Buffer.alloc(2_000_001);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 2_000_000) throw new Error("Evaluation input exceeds the size limit.");
    bytes = bytes.subarray(0, length);
  } finally { await file.close(); }
  const report = evaluateBundle(JSON.parse(bytes.toString("utf8")), binding.workspaceId, binding.manifestSha256);
  if (report.runId !== binding.runId) throw new Error("Evaluation run does not match the job.");
  await mkdir(outputDirectory, { recursive: true });
  // Refuse an old output rather than leaving a prior success looking like this attempt's result.
  await writeFile(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  return report;
}
