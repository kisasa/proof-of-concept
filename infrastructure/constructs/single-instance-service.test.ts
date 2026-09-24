import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { SingleInstanceService } from "./single-instance-service.js";
import { assertSafeContainerDefinitions } from "../testing/synth-assertions.js";

const baseConfig = {
  name: "webhook-listener-test",
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/example-prod",
  vpcId: "vpc-0123456789abcdef0",
  subnetIds: ["subnet-aaaaaaaa", "subnet-bbbbbbbb"],
  image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/intent-to-production:latest",
  containerPort: 8787,
  cpu: 512,
  memory: 1024,
  environment: [{ name: "NODE_ENV", value: "production" }],
  secrets: [{ name: "LINEAR_AGENT_API_KEY", valueFrom: "arn:aws:ssm:us-east-1:123456789012:parameter/linear-key" }],
  secretParameterArns: ["arn:aws:ssm:us-east-1:123456789012:parameter/linear-key"],
  awsRegion: "us-east-1",
  logRetentionDays: 30,
  loadBalancerSecurityGroupId: "sg-alb0123456789abc",
  targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/example-tg/abc123",
  dependsOn: [],
  globalTags: { project: "intent-to-production" },
};

function synth(): string {
  return Testing.synthScope((scope) => {
    new SingleInstanceService(scope, "listener", baseConfig);
  });
}

describe("SingleInstanceService", () => {
  it("pins desiredCount to exactly 1 and stops the old task before starting the new one", () => {
    const json = JSON.parse(synth());
    const services = Object.values(json.resource?.aws_ecs_service ?? {}) as Array<{
      desired_count: number;
      deployment_minimum_healthy_percent: number;
      deployment_maximum_percent: number;
    }>;
    expect(services).toHaveLength(1);
    expect(services[0]?.desired_count).toBe(1);
    expect(services[0]?.deployment_minimum_healthy_percent).toBe(0);
    expect(services[0]?.deployment_maximum_percent).toBe(100);
  });

  it("restricts the security group's ingress to the load balancer's own security group, on the container port only", () => {
    const json = JSON.parse(synth());
    const groups = Object.values(json.resource?.aws_security_group ?? {}) as Array<{
      ingress: Array<{ from_port: number; to_port: number; security_groups: string[] }>;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ingress).toEqual([
      expect.objectContaining({
        from_port: baseConfig.containerPort,
        to_port: baseConfig.containerPort,
        security_groups: [baseConfig.loadBalancerSecurityGroupId],
      }),
    ]);
  });

  it("keeps container_definitions safe from the JSON/token double-encoding gotcha", () => {
    assertSafeContainerDefinitions(synth());
  });
});
