import { setting } from "../env.js";
import { runEvaluationProcessing } from "./evaluation-processing.js";

try {
  await runEvaluationProcessing("/opt/ml/processing/input", "/opt/ml/processing/output", {
    workspaceId: setting("EVALUATION_WORKSPACE_ID") ?? "",
    runId: setting("EVALUATION_RUN_ID") ?? "",
    manifestSha256: setting("EVALUATION_MANIFEST_SHA256") ?? "",
  });
  process.stdout.write("Evaluation report written. Human review is still required.\n");
} catch {
  // Input data and schema errors may contain confidential text.
  process.stderr.write("Evaluation refused: check the input bundle, job identity and empty output directory.\n");
  process.exitCode = 1;
}
