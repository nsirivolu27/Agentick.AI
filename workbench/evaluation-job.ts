import { z } from "zod";

const identifier = z.string().uuid();
const account = z.string().regex(/^\d{12}$/, "Use a 12-digit AWS account ID.");
const digest = z.string().regex(/^[a-f0-9]{64}$/, "Use a SHA-256 digest.");

export const evaluationJobSchema = z.object({
  workspaceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Use a workspace ID without path separators."),
  runId: identifier,
  manifestSha256: digest,
  accountId: account,
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, "Use a commercial AWS region."),
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Use a bucket name without dots."),
  roleName: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_+=,.@-]+$/),
  kmsKeyId: identifier,
  imageRepository: z.string().min(2).max(128).regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/),
  imageSha256: digest,
  instanceType: z.enum(["ml.m5.large", "ml.m5.xlarge"]),
  maxRuntimeSeconds: z.number().int().min(60).max(1800),
}).strict();

export type EvaluationJobPlan = z.infer<typeof evaluationJobSchema>;

/**
 * Preparation only: the caller must authorize the workspace and budget before
 * submitting. Frozen answers let evaluation run without provider keys or egress.
 */
export function prepareEvaluationJob(raw: unknown) {
  const plan = evaluationJobSchema.parse(raw);
  const prefix = `workspaces/${plan.workspaceId}/evaluations/${plan.runId}`;
  const kms = `arn:aws:kms:${plan.region}:${plan.accountId}:key/${plan.kmsKeyId}`;
  return {
    ProcessingJobName: `agentick-eval-${plan.runId}`,
    RoleArn: `arn:aws:iam::${plan.accountId}:role/${plan.roleName}`,
    AppSpecification: {
      ImageUri: `${plan.accountId}.dkr.ecr.${plan.region}.amazonaws.com/${plan.imageRepository}@sha256:${plan.imageSha256}`,
    },
    Environment: {
      EVALUATION_MANIFEST_SHA256: plan.manifestSha256,
      EVALUATION_WORKSPACE_ID: plan.workspaceId,
      EVALUATION_RUN_ID: plan.runId,
    },
    NetworkConfig: { EnableNetworkIsolation: true, EnableInterContainerTrafficEncryption: true },
    ProcessingResources: {
      ClusterConfig: { InstanceCount: 1, InstanceType: plan.instanceType, VolumeSizeInGB: 10, VolumeKmsKeyId: kms },
    },
    StoppingCondition: { MaxRuntimeInSeconds: plan.maxRuntimeSeconds },
    ProcessingInputs: [{
      InputName: "evidence",
      S3Input: {
        S3Uri: `s3://${plan.bucket}/${prefix}/input/`,
        LocalPath: "/opt/ml/processing/input",
        S3DataType: "S3Prefix",
        S3InputMode: "File",
        S3DataDistributionType: "FullyReplicated",
      },
    }],
    ProcessingOutputConfig: {
      KmsKeyId: kms,
      Outputs: [{
        OutputName: "evaluation",
        S3Output: {
          S3Uri: `s3://${plan.bucket}/${prefix}/output/`,
          LocalPath: "/opt/ml/processing/output",
          S3UploadMode: "EndOfJob",
        },
      }],
    },
    Tags: [
      { Key: "Application", Value: "Agentick" },
      { Key: "Workspace", Value: plan.workspaceId },
      { Key: "Evaluation", Value: plan.runId },
    ],
  };
}
