import assert from "node:assert/strict";
import test from "node:test";
import { prepareEvaluationJob } from "../workbench/evaluation-job.js";

const plan = {
  workspaceId: "20b7da43-72f4-4bc5-947a-148f97187f1e",
  runId: "9603a1bb-9057-4c09-b9c1-a0b85beef4aa",
  manifestSha256: "a".repeat(64),
  accountId: "123456789012", region: "us-east-1", bucket: "agentick-evaluation-example",
  roleName: "AgentickEvaluation", kmsKeyId: "78fafc90-92fb-429d-b2c2-36251ab65fe4",
  imageRepository: "agentick/evaluator", imageSha256: "b".repeat(64),
  instanceType: "ml.m5.large", maxRuntimeSeconds: 600,
};

test("evaluation preparation confines input and output to a workspace run", () => {
  const request = prepareEvaluationJob(plan);
  const prefix = `s3://${plan.bucket}/workspaces/${plan.workspaceId}/evaluations/${plan.runId}`;
  assert.equal(request.ProcessingInputs[0]!.S3Input.S3Uri, `${prefix}/input/`);
  assert.equal(request.ProcessingOutputConfig.Outputs[0]!.S3Output.S3Uri, `${prefix}/output/`);
  const other = prepareEvaluationJob({ ...plan, workspaceId: plan.runId });
  assert.notEqual(other.ProcessingInputs[0]!.S3Input.S3Uri, request.ProcessingInputs[0]!.S3Input.S3Uri);
  assert.throws(() => prepareEvaluationJob({ ...plan, workspaceId: "../other" }));
  assert.match(prepareEvaluationJob({ ...plan, workspaceId: "org_example" }).ProcessingInputs[0]!.S3Input.S3Uri, /workspaces\/org_example\/evaluations\//);
  assert.throws(() => prepareEvaluationJob({ ...plan, inputUri: "s3://another-workspace/" }));
});

test("evaluation plans use immutable images, isolated networking and encrypted storage", () => {
  const request = prepareEvaluationJob(plan);
  assert.equal(request.NetworkConfig.EnableNetworkIsolation, true);
  assert.equal(request.NetworkConfig.EnableInterContainerTrafficEncryption, true);
  assert.equal(request.AppSpecification.ImageUri, `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentick/evaluator@sha256:${"b".repeat(64)}`);
  assert.equal(request.ProcessingResources.ClusterConfig.VolumeKmsKeyId, request.ProcessingOutputConfig.KmsKeyId);
  assert.equal(request.Environment.EVALUATION_MANIFEST_SHA256, plan.manifestSha256);
  assert.throws(() => prepareEvaluationJob({ ...plan, imageSha256: "latest" }));
  assert.throws(() => prepareEvaluationJob({ ...plan, apiKey: "must-not-be-accepted" }));
});

test("evaluation preparation bounds compute and does not allow endpoint overrides", () => {
  assert.equal(prepareEvaluationJob(plan).ProcessingResources.ClusterConfig.InstanceCount, 1);
  for (const maxRuntimeSeconds of [0, 1801, 3.5]) {
    assert.throws(() => prepareEvaluationJob({ ...plan, maxRuntimeSeconds }));
  }
  assert.throws(() => prepareEvaluationJob({ ...plan, instanceType: "ml.p4d.24xlarge" }));
  assert.throws(() => prepareEvaluationJob({ ...plan, region: "us-east-1/override" }));
  assert.throws(() => prepareEvaluationJob({ ...plan, imageRepository: "../other" }));
  assert.throws(() => prepareEvaluationJob({ ...plan, accountId: "not-an-account" }));
});
