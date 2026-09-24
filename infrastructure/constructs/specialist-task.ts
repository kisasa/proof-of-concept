import { Construct } from "constructs";
import { CloudwatchLogGroup } from "@cdktn/provider-aws/lib/cloudwatch-log-group";
import { EcsTaskDefinition } from "@cdktn/provider-aws/lib/ecs-task-definition";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy";
import { IamRolePolicyAttachment } from "@cdktn/provider-aws/lib/iam-role-policy-attachment";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";

import { formatName, securityGroupDescription } from "../common";
import type { ContainerEnvironmentVariable, ContainerSecret } from "./single-instance-service";

export interface SpecialistTaskConfig {
  readonly name: string;
  readonly vpcId: string;
  readonly image: string;

  /** Task-level Fargate sizing. Container-level sizing is left unset. */
  readonly cpu: number;
  readonly memory: number;

  readonly environment: ContainerEnvironmentVariable[];
  readonly secrets: ContainerSecret[];

  /** Arns the execution role is allowed to read, for the `secrets` above. */
  readonly secretParameterArns: string[];

  readonly awsRegion: string;
  readonly logRetentionDays: number;
  readonly globalTags: Record<string, string>;
}

const ECS_TASKS_ASSUME_ROLE_POLICY: string = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ecs-tasks.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

/**
 * A Fargate task definition meant for `ecs:RunTask`, not `ecs:CreateService`.
 *
 * This is deliberately not a variant of `SingleInstanceService`: that construct is
 * built around the singleton-service invariant (desiredCount, load balancer
 * registration, health-check grace period) which does not apply here — a
 * specialist run is one task per dispatch, launched on demand by whatever
 * orchestrator calls `RunTask` against this definition's arn/family, and nothing
 * in this stack calls it. There is no `EcsService` resource at all.
 *
 * The security group carries no ingress rules: nothing connects to the task over
 * the network (`RunTask` is an AWS API call, not a network request), so there is
 * nothing to accept a connection from. Egress is unrestricted for now — the
 * design calls for allowlisting to the Anthropic API, GitHub, Linear, and the
 * gateway-processor test endpoints specifically, but none of those publish
 * stable enough IP ranges for a security-group rule; real enforcement needs a
 * NAT gateway plus a forward proxy or AWS Network Firewall, which is its own
 * build (see `infrastructure/README.md`'s Known gaps).
 */
export class SpecialistTask extends Construct {
  public readonly taskDefinitionArn: string;
  public readonly taskDefinitionFamily: string;
  public readonly securityGroupId: string;
  public readonly executionRoleArn: string;
  public readonly taskRoleArn: string;
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, config: SpecialistTaskConfig) {
    super(scope, id);

    const logGroupName = `/ecs/${formatName(config.name)}`;

    const logGroup = new CloudwatchLogGroup(this, "log-group", {
      name: logGroupName,
      retentionInDays: config.logRetentionDays,
      tags: config.globalTags,
    });

    // Split from the task role for the same reason single-instance-service.ts
    // splits them: the execution role is the ECS agent's identity (pull image,
    // write logs, read secrets); the task role is the specialist's own, and the
    // specialist's real external credentials (tracker, source control) arrive as
    // container secrets below, not as AWS permissions.
    const executionRole = new IamRole(this, "execution-role", {
      name: formatName(`${config.name}-exec-role`, 64),
      assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY,
      tags: config.globalTags,
    });

    new IamRolePolicyAttachment(this, "execution-role-managed-policy", {
      role: executionRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    });

    // Scoped to exactly the parameters this task injects, not the whole prefix —
    // same discipline as the listener's execution role.
    new IamRolePolicy(this, "execution-role-read-secrets", {
      name: formatName(`${config.name}-read-secrets`, 128),
      role: executionRole.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["ssm:GetParameters"],
            Resource: config.secretParameterArns,
          },
        ],
      }),
    });

    const taskRole = new IamRole(this, "task-role", {
      name: formatName(`${config.name}-task-role`, 64),
      assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY,
      tags: config.globalTags,
    });

    // Solely so `aws ecs execute-command` can open a shell in a running task.
    new IamRolePolicy(this, "task-role-execute-command", {
      name: formatName(`${config.name}-execute-command`, 128),
      role: taskRole.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ssmmessages:CreateControlChannel",
              "ssmmessages:CreateDataChannel",
              "ssmmessages:OpenControlChannel",
              "ssmmessages:OpenDataChannel",
            ],
            Resource: "*",
          },
        ],
      }),
    });

    const containerDefinition = {
      name: formatName(config.name),
      image: config.image,
      essential: true,
      environment: config.environment,
      secrets: config.secrets,
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": logGroupName,
          "awslogs-region": config.awsRegion,
          "awslogs-stream-prefix": "ecs",
        },
      },
    };

    const taskDefinition = new EcsTaskDefinition(this, "task-definition", {
      family: formatName(config.name),
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: String(config.cpu),
      memory: String(config.memory),
      executionRoleArn: executionRole.arn,
      taskRoleArn: taskRole.arn,
      containerDefinitions: JSON.stringify([containerDefinition]),
      runtimePlatform: {
        cpuArchitecture: "X86_64",
        operatingSystemFamily: "LINUX",
      },
      tags: config.globalTags,
      dependsOn: [logGroup],
    });

    const securityGroup = new SecurityGroup(this, "security-group", {
      name: formatName(`${config.name}-sg`, 255),
      description: securityGroupDescription("Specialist sandbox task; no inbound, RunTask is an AWS API call"),
      vpcId: config.vpcId,

      // No ingress: nothing connects to this task over the network.
      ingress: [],

      // Anthropic, tracker, source control, and the gateway-processor test
      // endpoints. Unrestricted for now — see the class comment and the
      // README's Known gaps.
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
          description: securityGroupDescription("Anthropic, tracker, source control; not yet allowlisted, see Known gaps"),
        },
      ],
      tags: config.globalTags,
    });

    this.taskDefinitionArn = taskDefinition.arn;
    this.taskDefinitionFamily = taskDefinition.family;
    this.securityGroupId = securityGroup.id;
    this.executionRoleArn = executionRole.arn;
    this.taskRoleArn = taskRole.arn;
    this.logGroupName = logGroupName;
  }
}
