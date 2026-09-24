import { Fn } from "cdktn";
import type { Construct } from "constructs";
import { DataAwsEcrRepository } from "@cdktn/provider-aws/lib/data-aws-ecr-repository";
import { DataAwsSsmParameter } from "@cdktn/provider-aws/lib/data-aws-ssm-parameter";
import { EcsCluster } from "@cdktn/provider-aws/lib/ecs-cluster";
import { EcsClusterCapacityProviders } from "@cdktn/provider-aws/lib/ecs-cluster-capacity-providers";
import { SsmParameter } from "@cdktn/provider-aws/lib/ssm-parameter";
import { TimeProvider } from "@cdktn/provider-time/lib/provider";

// Locally generated bindings — see temporal-namespace.ts's own note.
import { TemporalcloudProvider } from "../.gen/providers/temporalcloud/provider";

import { formatName, tfStateKeys } from "../common";
import type { ContainerSecret } from "../constructs/single-instance-service";
import { TemporalNamespace } from "../constructs/temporal-namespace";
import { TemporalPrivateLink } from "../constructs/temporal-privatelink";
import { TemporalWorkerService } from "../constructs/temporal-worker-service";
import { networkStackOutputFromRemoteState } from "../models/network-stack-output";
import { specialistSandboxStackOutputFromRemoteState } from "../models/specialist-sandbox-stack-output";
import type { TemporalStackOutput } from "../models/temporal-stack-output";
import { BaseStack } from "./base-stack";

const TASK_QUEUE_NAME = "dispatch-task-queue";

/**
 * Mirrors `dispatch-worker/.env.example`'s own secrets section exactly, same
 * as the listener's and specialist sandbox's own lists. Deliberately no
 * ANTHROPIC_API_KEY here — this worker never calls Anthropic itself; only the
 * specialist it dispatches does, so that key lives in specialist-sandbox's
 * own list instead.
 */
const SECRET_PARAMETER_NAMES: string[] = ["LINEAR_AGENT_API_KEY", "GITHUB_TOKEN"];

/**
 * Registers the Temporal Cloud namespace (reachable only via PrivateLink) and
 * an always-on ECS Fargate service for the worker that sequences
 * dispatch → wait-for-specialist → CI → human-review-gate. Reads `network`'s
 * existing public subnets — PrivateLink doesn't need a NAT gateway, so this
 * doesn't reopen the no-NAT decision made in that stack.
 *
 * One deliberate exception to this project's "no secret value reaches synth"
 * discipline: the `temporalcloud` provider authenticates with an admin API
 * key that has to be a real string at synth time — Terraform providers don't
 * support the ARN-indirection pattern the ECS container secrets elsewhere in
 * this project use. That value is read once, here, from its own out-of-band
 * SSM parameter (`${parameter-prefix}temporal-admin/API_KEY`, decrypted), and is
 * therefore the one secret in this project that reaches Terraform state
 * (S3-backend-encrypted, same as everything else, but no longer merely an arn
 * reference). See README's Known gaps.
 */
export class TemporalWorkersStack extends BaseStack {
  constructor(scope: Construct) {
    super(scope, tfStateKeys.temporalWorkers, "temporal-workers");

    const config = this.temporal;
    const tags = { ...this.globalTags, stack: `temporal-workers-${config.environmentName}` };
    const network = networkStackOutputFromRemoteState(this.remoteState(tfStateKeys.network));
    const specialistSandbox = specialistSandboxStackOutputFromRemoteState(
      this.remoteState(tfStateKeys.specialistSandbox),
    );

    const adminApiKeyParameter = new DataAwsSsmParameter(this, "ssm-temporal-admin-api-key", {
      name: `${this.parameterPrefix}temporal-admin/API_KEY`,
      withDecryption: true,
    });

    new TemporalcloudProvider(this, "temporalcloud", {
      apiKey: adminApiKeyParameter.value,
    });

    // Backs `temporal-namespace.ts`'s `Offset` resource — computes the API
    // key's expiry once, at creation, instead of recomputing `Date.now()`
    // on every synth.
    new TimeProvider(this, "time", {});

    // Read, not managed — same posture as the listener's and specialist
    // sandbox's own ECR repositories. `dispatch-worker/Dockerfile` and
    // `.github/workflows/build-and-push-dispatch-worker-ecr.yml` both exist
    // and push on merge to main; what hasn't happened yet is a real deploy —
    // `config.imageTag` is still the `REPLACE_ME` placeholder in cdktf.json
    // until a push actually lands.
    const repository = new DataAwsEcrRepository(this, "ecr-repository", {
      name: config.ecrRepositoryName,
    });
    const imageUri = `${repository.repositoryUrl}:${config.imageTag}`;

    const parameters = SECRET_PARAMETER_NAMES.map((name) => {
      return new DataAwsSsmParameter(this, `ssm-${name.toLowerCase().replace(/_/g, "-")}`, {
        name: `${this.parameterPrefix}${name}`,
        withDecryption: false,
      });
    });

    const secrets: ContainerSecret[] = SECRET_PARAMETER_NAMES.map((name, index) => {
      const parameter = parameters[index];
      if (parameter === undefined) throw new Error(`No SSM parameter resolved for ${name}`);
      return { name: name, valueFrom: parameter.arn };
    });

    const cluster = new EcsCluster(this, "ecs-cluster", {
      name: formatName(`${this.resourceNamePrefix}-temporal-${config.environmentName}`),
      tags: tags,
    });

    new EcsClusterCapacityProviders(this, "ecs-capacity-providers", {
      clusterName: cluster.name,
      capacityProviders: ["FARGATE"],
    });

    const privateLink = new TemporalPrivateLink(this, "privatelink", {
      environmentName: config.environmentName,
      vpcId: network.vpcId,
      subnetIds: network.publicSubnetIds,
      vpcCidrBlock: this.vpcCidrBlock,
      awsRegion: this.aws.region,
      globalTags: tags,
    });

    const namespace = new TemporalNamespace(this, "namespace", {
      environmentName: config.environmentName,
      namespaceName: config.namespaceName,
      awsRegion: this.aws.region,
      vpcEndpointId: privateLink.vpcEndpointId,
      privateHostedZoneId: privateLink.phzZoneId,
      vpcEndpointDnsName: privateLink.vpcEndpointDnsName,
    });

    // The `temporalcloud` provider generates this token; it's not created as an
    // SSM parameter itself, so ECS's ARN-based `secrets` block has nothing to
    // point at until this stack writes it into one. Terraform-managed, so the
    // value reaches state the same way the admin API key above does — flagged
    // in the class comment and README's Known gaps, not hidden.
    const temporalApiKeyParameter = new SsmParameter(this, "ssm-temporal-worker-api-key", {
      name: `${this.parameterPrefix}TEMPORAL_API_KEY`,
      type: "SecureString",
      value: namespace.apiKeyToken,
      tags: tags,
    });

    const worker = new TemporalWorkerService(this, "worker", {
      name: `temporal-worker-${config.environmentName}`,
      clusterArn: cluster.arn,
      vpcId: network.vpcId,
      subnetIds: network.publicSubnetIds,
      image: imageUri,
      cpu: config.cpu,
      memory: config.memory,
      desiredCount: config.desiredCount,
      environment: [
        { name: "NODE_ENV", value: "production" },
        { name: "TEMPORAL_HOST", value: namespace.namespaceClusterAddress },
        { name: "TEMPORAL_NAMESPACE", value: namespace.namespaceId },
        { name: "TEMPORAL_TASK_QUEUE", value: TASK_QUEUE_NAME },
        { name: "SPECIALIST_CLUSTER_ARN", value: specialistSandbox.clusterArn },
        { name: "SPECIALIST_TASK_DEFINITION_ARN", value: specialistSandbox.taskDefinitionArn },
        // specialist-task.ts derives the container name the same way it derives
        // the task definition family — formatName(config.name) — so the two are
        // always identical; no separate output needed for this.
        { name: "SPECIALIST_CONTAINER_NAME", value: specialistSandbox.taskDefinitionFamily },
        { name: "SPECIALIST_SECURITY_GROUP_ID", value: specialistSandbox.securityGroupId },
        // network.publicSubnetIds is a remote-state token list, not a real JS
        // array at synth time — a plain `.join()` call on it is exactly the
        // Array.join-on-a-token-list failure the design ledger once claimed
        // (then struck as unverified, since nothing in the codebase actually
        // did this yet). This is the first real instance, so it gets the fix
        // that claim originally described: Fn.join, Terraform's own list-join
        // resolved at apply time — same as network-vpc.ts already uses Fn for
        // its own token math.
        { name: "SPECIALIST_SUBNET_IDS", value: Fn.join(",", network.publicSubnetIds) },
        // Reviewer-of-record's static email -> GitHub-login table (see
        // class-doc above and worker-config.ts's parseReviewerMapping). A
        // context value, not a secret. Same class of bug as SPECIALIST_SUBNET_IDS
        // above, just triggered by different content: JSON.stringify produces a
        // plain JS string carrying literal `"` characters (from the emails'
        // quoted keys), and CDKTF's outer Fn.jsonencode splice doesn't re-escape
        // those when embedding a plain string value — confirmed live
        // (2026-08-13): synth produced HCL with the quotes unescaped, and
        // Terraform's parser rejected it ("Invalid character" mid-string).
        // Fn.jsonencode here instead makes this one value its own token, built
        // from the real object rather than pre-stringified text — Terraform
        // encodes and escapes it correctly when the outer jsonencode resolves.
        { name: "REVIEWER_EMAIL_TO_GITHUB_LOGIN", value: Fn.jsonencode(config.reviewerEmailToGithubLogin) },
      ],
      secrets: [...secrets, { name: "TEMPORAL_API_KEY", valueFrom: temporalApiKeyParameter.arn }],
      secretParameterArns: [...parameters.map((parameter) => parameter.arn), temporalApiKeyParameter.arn],
      awsRegion: this.aws.region,
      logRetentionDays: config.logRetentionDays,
      globalTags: tags,
      dispatchTarget: {
        clusterArn: specialistSandbox.clusterArn,
        taskDefinitionArn: specialistSandbox.taskDefinitionArn,
        executionRoleArn: specialistSandbox.executionRoleArn,
        taskRoleArn: specialistSandbox.taskRoleArn,
      },
    });

    const outputs: TemporalStackOutput = {
      namespaceId: namespace.namespaceId,
      namespaceClusterAddress: namespace.namespaceClusterAddress,
      taskQueueName: TASK_QUEUE_NAME,
      clusterArn: cluster.arn,
      serviceName: worker.service.name,
      logGroupName: worker.logGroupName,
    };

    this.renderOutputs(outputs);
  }
}
