import type { Construct } from "constructs";
import { DataAwsEcrRepository } from "@cdktn/provider-aws/lib/data-aws-ecr-repository";
import { DataAwsSsmParameter } from "@cdktn/provider-aws/lib/data-aws-ssm-parameter";
import { EcsCluster } from "@cdktn/provider-aws/lib/ecs-cluster";
import { EcsClusterCapacityProviders } from "@cdktn/provider-aws/lib/ecs-cluster-capacity-providers";

import { formatName, tfStateKeys } from "../common";
import { SpecialistTask } from "../constructs/specialist-task";
import type { ContainerEnvironmentVariable, ContainerSecret } from "../constructs/single-instance-service";
import type { SpecialistSandboxConfiguration } from "../models/specialist-sandbox-configuration";
import type { SpecialistSandboxStackOutput } from "../models/specialist-sandbox-stack-output";
import { networkStackOutputFromRemoteState } from "../models/network-stack-output";
import { BaseStack } from "./base-stack";

/**
 * Environment variables a specialist run reads at process start, and where each one
 * comes from — mirrors `specialist-runner/.env.example`'s own secrets section
 * exactly, same as the listener's SECRET_PARAMETER_NAMES mirrors
 * webhook-listener's.
 */
const SECRET_PARAMETER_NAMES: string[] = ["ANTHROPIC_API_KEY", "LINEAR_AGENT_API_KEY", "GITHUB_TOKEN"];

/**
 * NODE_ENV=development, deliberately not production — this container's job
 * is shelling out `npm install`/build/test against whatever target repo it
 * clones, and NODE_ENV=production makes npm silently skip devDependencies
 * there, confirmed live breaking a target repo's own Angular CLI/Playwright
 * installs (see `specialist-runner/Dockerfile`'s own note, which sets the
 * same value as the image's default). A code constant here rather than a
 * `cdktf.json` context key on purpose: unlike `config.cpu`/`config.imageTag`,
 * this doesn't vary by engagement or deploy environment — there's no
 * legitimate scenario where this container should run as `production`, so
 * it isn't exposed as a knob someone could reasonably flip to reintroduce
 * this exact bug.
 *
 * FRAMEWORK_REPO/FRAMEWORK_REF are the opposite case — which agents/skills
 * repo and ref a specialist clones for its own definitions genuinely does
 * vary by engagement (a fork, a pinned ref for a controlled rollout), so
 * those come from `config` below rather than being baked in here.
 * `specialist-runner/src/dispatch-context.ts` requires both with no
 * fallback — if this task definition doesn't set them, the container fails
 * fast at startup naming whichever is missing.
 *
 * CLAUDE_MODEL/CLAUDE_EFFORT are required, same posture as FRAMEWORK_REPO/
 * FRAMEWORK_REF: specialist-runner/src/claude-config.ts has no code-level
 * default for either (see its own env.ts's requireEnv) — this deployment
 * must supply both. Set here on the task definition's baseline environment,
 * not as a dispatch-specialist.ts RunTask override, so tweaking either is a
 * context edit and a redeploy of this stack alone — no dispatch-worker
 * change needed.
 */
function containerEnvironment(config: SpecialistSandboxConfiguration): ContainerEnvironmentVariable[] {
  return [
    { name: "NODE_ENV", value: "development" },
    { name: "FRAMEWORK_REPO", value: config.frameworkRepo },
    { name: "FRAMEWORK_REF", value: config.frameworkRef },
    { name: "CLAUDE_MODEL", value: config.claudeModel },
    { name: "CLAUDE_EFFORT", value: config.claudeEffort },
  ];
}

/**
 * The specialist sandbox: registers a Fargate task definition for on-demand
 * `ecs:RunTask` dispatch, one task per story. Distinct from `listener` on purpose —
 * see `constructs/specialist-task.ts` — down to its own ECS cluster, so that
 * `RunTask`/`PassRole` scoping for a future orchestrator stays separate from
 * anything touching the always-on listener service.
 *
 * Nothing in this stack calls `RunTask`. That belongs to the Temporal-workers
 * stack this precedes, which reads this stack's outputs via remote state
 * exactly as `listener.ts` reads `network`'s.
 */
export class SpecialistSandboxStack extends BaseStack {
  constructor(scope: Construct) {
    super(scope, tfStateKeys.specialistSandbox, "specialist-sandbox");

    const config = this.specialistSandbox;
    const tags = { ...this.globalTags, stack: `specialist-sandbox-${config.environmentName}` };
    const network = networkStackOutputFromRemoteState(this.remoteState(tfStateKeys.network));

    // Read, not managed — same posture as the listener's own ECR repository.
    // `specialist-runner/Dockerfile` and `.github/workflows/build-and-push-
    // specialist-ecr.yml` both exist and push on merge to main; what hasn't
    // happened yet is a real deploy — `config.imageTag` is still the
    // `REPLACE_ME` placeholder in cdktf.json until a push actually lands.
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
      name: formatName(`${this.resourceNamePrefix}-specialist-${config.environmentName}`),
      tags: tags,
    });

    new EcsClusterCapacityProviders(this, "ecs-capacity-providers", {
      clusterName: cluster.name,
      capacityProviders: ["FARGATE"],
    });

    const task = new SpecialistTask(this, "task", {
      name: `specialist-${config.environmentName}`,
      vpcId: network.vpcId,
      image: imageUri,
      cpu: config.cpu,
      memory: config.memory,
      environment: containerEnvironment(config),
      secrets: secrets,
      secretParameterArns: parameters.map((parameter) => parameter.arn),
      awsRegion: this.aws.region,
      logRetentionDays: config.logRetentionDays,
      globalTags: tags,
    });

    const outputs: SpecialistSandboxStackOutput = {
      clusterArn: cluster.arn,
      taskDefinitionArn: task.taskDefinitionArn,
      taskDefinitionFamily: task.taskDefinitionFamily,
      securityGroupId: task.securityGroupId,
      executionRoleArn: task.executionRoleArn,
      taskRoleArn: task.taskRoleArn,
      logGroupName: task.logGroupName,
    };

    this.renderOutputs(outputs);
  }
}
