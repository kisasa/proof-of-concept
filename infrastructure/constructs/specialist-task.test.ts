import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { SpecialistTask } from "./specialist-task.js";
import { assertSafeContainerDefinitions } from "../testing/synth-assertions.js";

const baseConfig = {
  name: "specialist-test",
  vpcId: "vpc-0123456789abcdef0",
  image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/specialist:latest",
  cpu: 1024,
  memory: 2048,
  environment: [{ name: "NODE_ENV", value: "production" }],
  secrets: [{ name: "GITHUB_TOKEN", valueFrom: "arn:aws:ssm:us-east-1:123456789012:parameter/github-token" }],
  secretParameterArns: ["arn:aws:ssm:us-east-1:123456789012:parameter/github-token"],
  awsRegion: "us-east-1",
  logRetentionDays: 30,
  globalTags: { project: "intent-to-production" },
};

function synth(): string {
  return Testing.synthScope((scope) => {
    new SpecialistTask(scope, "specialist", baseConfig);
  });
}

describe("SpecialistTask", () => {
  it("registers no aws_ecs_service — RunTask target, not a long-running service", () => {
    const json = JSON.parse(synth());
    expect(json.resource?.aws_ecs_service).toBeUndefined();
  });

  it("registers a Fargate task definition with no port mappings", () => {
    const json = JSON.parse(synth());
    const taskDefs = Object.values(json.resource?.aws_ecs_task_definition ?? {}) as Array<{
      requires_compatibilities: string[];
      network_mode: string;
    }>;
    expect(taskDefs).toHaveLength(1);
    expect(taskDefs[0]?.requires_compatibilities).toEqual(["FARGATE"]);
    expect(taskDefs[0]?.network_mode).toBe("awsvpc");
  });

  it("gives the security group no ingress rules — nothing connects to it over the network", () => {
    const json = JSON.parse(synth());
    const groups = Object.values(json.resource?.aws_security_group ?? {}) as Array<{ ingress?: unknown[] }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ingress ?? []).toEqual([]);
  });

  it("keeps container_definitions safe from the JSON/token double-encoding gotcha", () => {
    assertSafeContainerDefinitions(synth());
  });
});
