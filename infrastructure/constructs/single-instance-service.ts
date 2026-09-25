import type { ITerraformDependable } from "cdktn";
import { Construct } from "constructs";
import { CloudwatchLogGroup } from "@cdktn/provider-aws/lib/cloudwatch-log-group";
import { EcsService } from "@cdktn/provider-aws/lib/ecs-service";
import { EcsTaskDefinition } from "@cdktn/provider-aws/lib/ecs-task-definition";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy";
import { IamRolePolicyAttachment } from "@cdktn/provider-aws/lib/iam-role-policy-attachment";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";

import { formatName, securityGroupDescription } from "../common";

/** A plain environment variable, visible in the task definition. */
export interface ContainerEnvironmentVariable {
  readonly name: string;
  readonly value: string;
}

/**
 * A value the ECS agent fetches from SSM Parameter Store at task start and
 * injects as an environment variable. `valueFrom` is a parameter arn — the value
 * itself never enters the task definition, the synthesized JSON, or state.
 */
export interface ContainerSecret {
  readonly name: string;
  readonly valueFrom: string;
}

interface ContainerPortMapping {
  readonly name: string;
  readonly containerPort: number;
  readonly hostPort: number;
  readonly protocol: string;
  readonly appProtocol: string;
}

interface ContainerLogConfiguration {
  readonly logDriver: string;
  readonly options: Record<string, string>;
}

/**
 * The shape ECS expects in `container_definitions`. Declared as an interface and
 * serialized with JSON.stringify — the reference project hand-concatenates this
 * JSON to work around a C# serialization problem that does not exist here.
 */
interface ContainerDefinition {
  readonly name: string;
  readonly image: string;
  readonly essential: boolean;
  readonly portMappings: ContainerPortMapping[];
  readonly environment: ContainerEnvironmentVariable[];
  readonly secrets: ContainerSecret[];
  readonly logConfiguration: ContainerLogConfiguration;
  readonly stopTimeout: number;
}

export interface SingleInstanceServiceConfig {
  readonly name: string;
  readonly clusterArn: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly image: string;
  readonly containerPort: number;

  /** Task-level Fargate sizing. Container-level sizing is left unset. */
  readonly cpu: number;
  readonly memory: number;

  readonly environment: ContainerEnvironmentVariable[];
  readonly secrets: ContainerSecret[];

  /** Arns the execution role is allowed to read, for the `secrets` above. */
  readonly secretParameterArns: string[];

  readonly awsRegion: string;
  readonly logRetentionDays: number;
  readonly loadBalancerSecurityGroupId: string;
  readonly targetGroupArn: string;
  readonly dependsOn: ITerraformDependable[];
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
 * A Fargate service pinned to exactly one running task.
 *
 * This is the reason the reference project's EcsClusterService could not be
 * reused as-is: that construct defaults to two-to-four instances behind
 * CPU/memory target tracking, and it tells Terraform to ignore desired_count
 * drift. The webhook listener keeps its dedupe set and debounce timers in
 * process memory, so a second instance would split that state and produce
 * duplicate agent runs. Here there is no autoscaling target at all, and
 * desired_count is asserted rather than ignored.
 *
 * The deployment settings follow from the same constraint: minimum healthy 0 and
 * maximum 100 percent stop the old task before starting the new one, so the two
 * never overlap. That costs a short gap on every deploy, which is acceptable
 * because the tracker retries webhook deliveries.
 *
 * What it does not solve: an activation can run far longer than the 120 seconds
 * `stopTimeout` allows, so replacing the task mid-activation drops that run.
 */
export class SingleInstanceService extends Construct {
  public readonly service: EcsService;
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, config: SingleInstanceServiceConfig) {
    super(scope, id);

    const logGroupName = `/ecs/${formatName(config.name)}`;

    const logGroup = new CloudwatchLogGroup(this, "log-group", {
      name: logGroupName,
      retentionInDays: config.logRetentionDays,
      tags: config.globalTags,
    });

    // The reference project reuses one pre-existing account-level role for both
    // the execution and the task role. They are split here because they are not
    // the same trust surface: the execution role is the ECS agent's identity for
    // pulling the image, writing logs, and reading secrets, while the task role
    // is the application's own — and the application makes no AWS calls at all.
    const executionRole = new IamRole(this, "execution-role", {
      name: formatName(`${config.name}-exec-role`, 64),
      assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY,
      tags: config.globalTags,
    });

    new IamRolePolicyAttachment(this, "execution-role-managed-policy", {
      role: executionRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    });

    // Scoped to exactly the parameters this task injects, not the whole prefix.
    // No kms:Decrypt statement: parameters under the account's default
    // alias/aws/ssm key are readable in-account without one. A customer-managed
    // key would need it added here.
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

    // Solely so `aws ecs execute-command` can open a shell in the running task.
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

    const containerDefinition: ContainerDefinition = {
      name: formatName(config.name),
      image: config.image,
      essential: true,
      portMappings: [
        {
          name: "http",
          containerPort: config.containerPort,
          hostPort: config.containerPort,
          protocol: "tcp",
          appProtocol: "http",
        },
      ],
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

      // Fargate's ceiling. Gives an in-flight activation two minutes to finish
      // on a graceful stop; anything longer than that is lost.
      stopTimeout: 120,
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

    const serviceSecurityGroup = new SecurityGroup(this, "security-group", {
      name: formatName(`${config.name}-svc-sg`, 255),
      description: securityGroupDescription("Webhook listener task; inbound from the load balancer only"),
      vpcId: config.vpcId,
      ingress: [
        {
          fromPort: config.containerPort,
          toPort: config.containerPort,
          protocol: "tcp",
          securityGroups: [config.loadBalancerSecurityGroupId],
          description: securityGroupDescription("From the application load balancer"),
        },
      ],

      // Outbound to the Anthropic API, the tracker's API and MCP endpoint, the
      // GitHub MCP endpoint, ECR, and CloudWatch Logs. Unrestricted because
      // these are third-party endpoints without stable address ranges.
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
          description: securityGroupDescription("Anthropic, tracker, GitHub, ECR, CloudWatch Logs"),
        },
      ],
      tags: config.globalTags,
    });

    this.service = new EcsService(this, "service", {
      name: formatName(`${config.name}-svc`),
      cluster: config.clusterArn,
      taskDefinition: taskDefinition.arn,
      launchType: "FARGATE",

      // Exactly one, always. See the class comment.
      desiredCount: 1,
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,

      networkConfiguration: {
        subnets: config.subnetIds,
        securityGroups: [serviceSecurityGroup.id],

        // Stands in for a NAT gateway. Inbound is still closed to everything but
        // the load balancer's security group.
        assignPublicIp: true,
      },
      loadBalancer: [
        {
          containerName: containerDefinition.name,
          containerPort: config.containerPort,
          targetGroupArn: config.targetGroupArn,
        },
      ],

      // The container is listening within a second or two, but the target group
      // needs two successful polls thirty seconds apart before it will call the
      // task healthy.
      healthCheckGracePeriodSeconds: 60,
      enableExecuteCommand: true,
      propagateTags: "SERVICE",
      tags: config.globalTags,
      dependsOn: config.dependsOn,
    });

    this.logGroupName = logGroupName;
  }
}
