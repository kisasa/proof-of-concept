import type { Construct } from "constructs";
import { DataAwsEcrRepository } from "@cdktn/provider-aws/lib/data-aws-ecr-repository";
import { DataAwsSsmParameter } from "@cdktn/provider-aws/lib/data-aws-ssm-parameter";
import { EcsCluster } from "@cdktn/provider-aws/lib/ecs-cluster";
import { EcsClusterCapacityProviders } from "@cdktn/provider-aws/lib/ecs-cluster-capacity-providers";

import { formatName, tfStateKeys } from "../common";
import { ApplicationLoadBalancer } from "../constructs/application-load-balancer";
import { DomainCertificate } from "../constructs/domain-certificate";
import {
  type ContainerEnvironmentVariable,
  type ContainerSecret,
  SingleInstanceService,
} from "../constructs/single-instance-service";
import type { ListenerStackOutput } from "../models/listener-stack-output";
import { networkStackOutputFromRemoteState } from "../models/network-stack-output";
import { type TemporalStackOutput, temporalStackOutputFromRemoteState } from "../models/temporal-stack-output";
import { BaseStack } from "./base-stack";

/**
 * Environment variables the application reads at module load, and where each one
 * comes from. Names must match webhook-listener's `.env.example` exactly.
 *
 * All six are SSM parameters under the deployment's shared `parameter-prefix`
 * (see the README), read here only for their arns. AGENT_USER_ID is not itself
 * sensitive, but it lives alongside the others so that provisioning the
 * service's credentials is one step rather than two. TEMPORAL_API_KEY is the
 * parameter `temporal-workers.ts` creates for its own worker service — read
 * here, not created again, now that every stack shares one prefix.
 */
const SECRET_PARAMETER_NAMES: string[] = [
  "LINEAR_WEBHOOK_SECRET",
  "LINEAR_AGENT_API_KEY",
  "AGENT_USER_ID",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "TEMPORAL_API_KEY",
];

export class ListenerStack extends BaseStack {
  constructor(scope: Construct) {
    super(scope, tfStateKeys.listener, "listener");

    const environmentName = this.listener.environmentName;
    const tags = { ...this.globalTags, stack: `listener-${environmentName}` };
    const network = networkStackOutputFromRemoteState(this.remoteState(tfStateKeys.network));
    const temporal = temporalStackOutputFromRemoteState(this.remoteState(tfStateKeys.temporalWorkers));

    const hostname = formatName(`${this.listener.subdomain}.${environmentName}.${this.domainName}`, 253);

    // Read, not managed. The image has to be in the repository before this stack
    // can start a task from it, and the push happens in CI independently of any
    // Terraform run — so the repository belongs with the other prerequisites
    // (state bucket, hosted zone) rather than in this state file.
    const repository = new DataAwsEcrRepository(this, "ecr-repository", {
      name: this.listener.ecrRepositoryName,
    });
    const imageUri = `${repository.repositoryUrl}:${this.listener.imageTag}`;

    const parameters = SECRET_PARAMETER_NAMES.map((name) => {
      return new DataAwsSsmParameter(this, `ssm-${name.toLowerCase().replace(/_/g, "-")}`, {
        name: `${this.parameterPrefix}${name}`,

        // The arn is all this stack wants. Decryption happens in the ECS agent at
        // task start, under the execution role — never during synth or apply.
        withDecryption: false,
      });
    });

    const secrets: ContainerSecret[] = SECRET_PARAMETER_NAMES.map((name, index) => {
      const parameter = parameters[index];
      if (parameter === undefined) throw new Error(`No SSM parameter resolved for ${name}`);
      return { name: name, valueFrom: parameter.arn };
    });

    const certificate = new DomainCertificate(this, "certificate", {
      domainName: hostname,
      hostedZoneId: this.hostedZoneId,
      globalTags: tags,
    });

    const cluster = new EcsCluster(this, "ecs-cluster", {
      name: formatName(`${this.resourceNamePrefix}-${environmentName}`),
      tags: tags,
    });

    new EcsClusterCapacityProviders(this, "ecs-capacity-providers", {
      clusterName: cluster.name,
      capacityProviders: ["FARGATE"],
    });

    const loadBalancer = new ApplicationLoadBalancer(this, "load-balancer", {
      name: `${this.resourceNamePrefix}-${environmentName}`,
      vpcId: network.vpcId,
      subnetIds: network.publicSubnetIds,
      certificateArn: certificate.validatedCertificateArn,
      hostedZoneId: this.hostedZoneId,
      recordName: hostname,
      targetPort: this.listener.port,
      healthCheckPath: "/health",
      globalTags: tags,
    });

    const service = new SingleInstanceService(this, "service", {
      name: `webhook-listener-${environmentName}`,
      clusterArn: cluster.arn,
      vpcId: network.vpcId,
      subnetIds: network.publicSubnetIds,
      image: imageUri,
      containerPort: this.listener.port,
      cpu: this.listener.cpu,
      memory: this.listener.memory,
      environment: this.containerEnvironment(temporal),
      secrets: secrets,
      secretParameterArns: parameters.map((parameter) => parameter.arn),
      awsRegion: this.aws.region,
      logRetentionDays: this.listener.logRetentionDays,
      loadBalancerSecurityGroupId: loadBalancer.securityGroupId,
      targetGroupArn: loadBalancer.targetGroupArn,
      dependsOn: [loadBalancer.httpsListener],
      globalTags: tags,
    });

    const outputs: ListenerStackOutput = {
      webhookUrl: `https://${hostname}/webhooks/linear`,
      serviceName: service.service.name,
      logGroupName: service.logGroupName,
      imageUri: imageUri,
    };

    this.renderOutputs(outputs);
  }

  /**
   * The non-secret half of the container's environment. Optional entries are
   * omitted rather than set empty: webhook-listener's `envOr` treats an empty
   * string as absent already, but leaving them out keeps the task definition
   * honest about which values are actually pinned by this deployment.
   *
   * `temporal` is passed in rather than read from `this` a second time — it's
   * already resolved once in the constructor via remote state, and threading
   * it through keeps that a single read rather than two independent ones
   * that could in principle observe different remote state.
   */
  private containerEnvironment(temporal: TemporalStackOutput): ContainerEnvironmentVariable[] {
    const environment: ContainerEnvironmentVariable[] = [
      { name: "NODE_ENV", value: "production" },
      { name: "PORT", value: String(this.listener.port) },
      { name: "DEBOUNCE_MS", value: String(this.listener.debounceMs) },
      { name: "LOG_LEVEL", value: this.listener.logLevel },

      // The webhook listener's own Temporal client — starts a dispatch
      // workflow on the specialist-dispatch lane's trigger, never a
      // NativeConnection/Worker (that's temporal-workers.ts's own service).
      { name: "TEMPORAL_HOST", value: temporal.namespaceClusterAddress },
      { name: "TEMPORAL_NAMESPACE", value: temporal.namespaceId },
      { name: "TEMPORAL_TASK_QUEUE", value: temporal.taskQueueName },

      // Required context keys, not optional overrides — webhook-listener's
      // own lane configs and activation-config.ts have no fallback for these
      // (see env.ts's requireEnv), so this deployment must supply them.
      { name: "CLAUDE_MODEL_INTAKE", value: this.listener.claudeModelIntake },
      { name: "CLAUDE_MODEL_SPECIFICATION", value: this.listener.claudeModelSpecification },
      { name: "CLAUDE_MODEL_DECOMPOSE", value: this.listener.claudeModelDecompose },
      { name: "CLAUDE_EFFORT", value: this.listener.claudeEffort },
    ];

    const optional: Record<string, string | undefined> = {
      LINEAR_API_URL: this.listener.linearApiUrl,
      LINEAR_MCP_URL: this.listener.linearMcpUrl,
      GITHUB_MCP_URL: this.listener.githubMcpUrl,
      PRODUCT_CONTEXT_PATHS: this.listener.productContextPaths,
    };

    for (const [name, value] of Object.entries(optional)) {
      if (value !== undefined) environment.push({ name: name, value: value });
    }

    return environment;
  }
}
