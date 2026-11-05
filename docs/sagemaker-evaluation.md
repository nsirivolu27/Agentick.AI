# SageMaker evaluation preparation

Status: local evidence export, offline evaluation and MCP inspection are implemented. AWS submission is not connected or deployed. Model inference remains separate; this evaluator rechecks recorded answers and does not train or host a model.

## Intended workflow

Agent Studio → saved test run → frozen evidence bundle → SageMaker Processing → evaluation report → independent review → existing release approvals.

The company configures evaluation once. An analyst selects a saved test suite and sees the model, dataset revision, runtime limit and estimated cost before submitting. Results show claim support, citation validity, tool selection, latency and reported token use separately. Missing metrics remain unknown. No score bypasses approval.

## Prepared in this checkout

- `workbench/evaluation-job.ts`: strict request builder for SageMaker Processing. One CPU instance, at most 30 minutes, network isolation, encrypted volumes and outputs, digest-pinned image, workspace/run-specific S3 prefixes. It performs no network calls.
- `deploy/aws-evaluation-foundation.json`: unprovisioned CloudFormation template for a private versioned S3 bucket, retained rotating KMS key and a SageMaker execution role. Artifact permissions are limited to one workspace; image reads to one repository. No compute or endpoint is created.
- `tests/evaluation-job.test.ts`: rejects path overrides, unknown credential fields, mutable image references and excessive compute requests.
- `workbench/evaluation-bundle.ts`: versioned evidence bundle, source and answer SHA-256 checks, offline assertions, recorded review metrics and report comparison. Local repository roots, event logs and expected answers are excluded. Suspected credentials block export rather than changing the tested evidence; pattern scanning is not a complete data-loss prevention system.
- `workbench/evaluation-processing.ts`: a bounded offline runner using the SageMaker input/output directories. It refuses a different workspace, run or manifest, files over 2 MB, and an existing output file.
- `deploy/build-evaluator.mjs` and `deploy/evaluator.Dockerfile`: bundle the runner with the existing dependencies, then package it using an explicitly supplied Node 22 image. No image has been published or run in AWS.

## Use the current implementation

1. Run an Agent Studio test to completion. It must have saved case/suite versions and captured evidence. Failed, cancelled, running and older unversioned runs cannot be exported.
2. While signed into that workspace as an author or admin, open `/api/agent-evaluation-export?runId=<test-run-id>` on the application origin. Save the download as `evaluation.json`. This route exists only where the agent-test runtime is configured. It exports recorded evidence, including source text; follow the company's data-handling policy before transferring it.
3. An authenticated MCP client on `/api/pipeline-mcp` can call `get_agent_evaluation_report` with `{ "runId": "<test-run-id>" }`. Any current workspace member may inspect this report. It returns source hashes, assertion results, reported usage, elapsed time and recorded reviewer metrics, without source bodies. Membership is checked on each HTTP request. The tool does not invoke models or submit cloud jobs.
4. Build the evaluator from the repository root with the pinned toolchain:

   ```powershell
   node deploy/build-evaluator.mjs
   docker build -f deploy/evaluator.Dockerfile --build-arg NODE_IMAGE=<approved-node22-image-at-sha256-digest> -t agentick-evaluator .testbuild/evaluator
   ```

   The base image must be approved, scanned and pinned by the deploying company. The build context is the generated evaluator directory, not the working checkout. Keep private data out of that directory.

5. For a local container test, mount a directory containing `evaluation.json` at `/opt/ml/processing/input` read-only and an empty output directory at `/opt/ml/processing/output`. Set `EVALUATION_WORKSPACE_ID`, `EVALUATION_RUN_ID` and `EVALUATION_MANIFEST_SHA256` from the export. Run without network access. A successful run writes `report.json`; failures exit nonzero with a generic message.

   The image now runs as the Node image's non-root user (UID 1000). On Linux,
   give that UID read permission on the input and write permission on the output
   mount; do not make the evidence or output world-writable. Image directory
   ownership does not override host bind-mount permissions. Confirm the target
   SageMaker volume permissions in an authorized cloud smoke test before using
   this image there; only local Docker execution has been verified.

   ```powershell
   $inputDirectory = (Resolve-Path '<export-directory>').Path
   $outputDirectory = (Resolve-Path '<empty-output-directory>').Path
   $bundle = Get-Content (Join-Path $inputDirectory 'evaluation.json') -Raw | ConvertFrom-Json
   docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --cpus 1 --pids-limit 64 `
     --mount "type=bind,source=$inputDirectory,target=/opt/ml/processing/input,readonly" `
     --mount "type=bind,source=$outputDirectory,target=/opt/ml/processing/output" `
     -e "EVALUATION_WORKSPACE_ID=$($bundle.run.workspaceId)" `
     -e "EVALUATION_RUN_ID=$($bundle.run.id)" `
     -e "EVALUATION_MANIFEST_SHA256=$($bundle.manifestSha256)" agentick-evaluator
   ```

   A local rerun of the saved documentation-agent evidence produced a byte-for-byte
   match with its previously verified report. Tampered evidence exited 1 without
   writing a report. This is recorded-answer evaluation, not another live model
   run, accuracy measurement or cloud deployment.

The manifest hash is SHA-256 of the canonical bundle body, excluding its `manifestSha256` field; it is not a hash of pretty-printed file bytes. Store the original export and hash on the trusted server before submission. `verifyEvaluationReport` recomputes the expected report against that original bundle. A hash establishes integrity relative to the trusted original, not authorship or factual correctness. No report import updates release eligibility yet.

## UI contract for the next pass

- Offer “Export evaluation evidence” on a completed, versioned test for authors/admins. Use the GET route above; surface its failure without displaying source content in a toast.
- Show “Offline evaluation” separately from live inference. Unknown usage or claim support stays unknown.
- MCP inspection is available through the existing tool discovery. Do not add a separate tool registry.
- Keep “Run on SageMaker” unavailable until server-side submission, spending authorization and result reconciliation exist.

The request builder currently targets commercial AWS regions. This is not an AWS GovCloud or federal authorization claim. A runtime bound limits duration, not total cost; the submitting service still needs budget reservation and reconciliation.

## Integration work still required

1. Approve an AWS account, region, data classification, retention policy and spending limit. Validate the template with CloudFormation before deploying. Confirm service quotas and instance availability.
2. Build and scan the prepared evaluator image, push it to the private ECR repository and pin its digest. The local runner verifies the manifest, answer and source digests; verify the image itself in the target AWS environment.
3. Connect the existing evidence export to an authorized upload step. Store the original manifest digest in durable job state. Do not upload credentials, unrelated conversations or evaluator answers to an inference provider.
4. Add a company-admin configuration through `setting()`. Resolve the authorized workspace server-side; never trust a browser-supplied role, bucket, image or workspace ID. Check membership again on submit, status, cancel and report reads.
5. Add idempotent job submission and durable reconciliation. The app role needs narrowly scoped processing-job APIs, artifact access, and `iam:PassRole` restricted to this execution role and `sagemaker.amazonaws.com`. The execution role itself cannot approve releases or invoke model providers.
6. Evaluate frozen answers offline. Citation matching and expected-tool checks are mechanical evidence. Claim support needs human judgment or a separately evaluated semantic method. SageMaker Clarify/FMEval can be added in the evaluator image; it is not installed in this application.
7. Wire the report verifier into durable result import. Compare with the stored original bundle, then recheck current agent, case, suite and source versions. Reject stale or mismatched results. Preserve existing independent reviewers and content-bound approval rules.
8. Add UI states for queued, running, failed, cancelled and completed jobs, with report download and failure details. Test recovery, access revocation, retries and cost exhaustion before a live pilot.

Do not enable a “Run on SageMaker” button until submission and result import are implemented and tested. Current Agent Studio tests continue to use the existing execution path.

## AWS references

- [SageMaker Processing and custom containers](https://docs.aws.amazon.com/sagemaker/latest/dg/processing-job.html)
- [Foundation model evaluation options](https://docs.aws.amazon.com/sagemaker/latest/dg/clarify-foundation-model-evaluate.html)
- [Bedrock and SageMaker service selection](https://docs.aws.amazon.com/decision-guides/latest/bedrock-or-sagemaker/bedrock-or-sagemaker.html)
