import { Fn } from "cdktn";
import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { TemporalWorkerService } from "./temporal-worker-service.js";
import { assertSafeContainerDefinitions } from "../testing/synth-assertions.js";

const dispatchTarget = {
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/example-specialist-prod",
  taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/specialist-prod:3",
  executionRoleArn: "arn:aws:iam::123456789012:role/specialist-prod-exec-role",
  taskRoleArn: "arn:aws:iam::123456789012:role/specialist-prod-task-role",
};

const baseConfig = {
  name: "temporal-worker-test",
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/example-temporal-prod",
  vpcId: "vpc-0123456789abcdef0",
  // A plain array here, not a real remote-state token — the actual bug this
  // construct hit only appears with a CDKTF token whose own HCL text embeds
  // quote characters (Fn.join). A separate test below exercises that case
  // directly, since a plain string array can't reproduce it.
  subnetIds: ["subnet-aaaaaaaa", "subnet-bbbbbbbb"],
  image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/temporal-worker:latest",
  cpu: 512,
  memory: 1024,
  desiredCount: 1,
  environment: [{ name: "NODE_ENV", value: "production" }],
  secrets: [{ name: "GITHUB_TOKEN", valueFrom: "arn:aws:ssm:us-east-1:123456789012:parameter/github-token" }],
  secretParameterArns: ["arn:aws:ssm:us-east-1:123456789012:parameter/github-token"],
  awsRegion: "us-east-1",
  logRetentionDays: 30,
  globalTags: { project: "intent-to-production" },
  dispatchTarget: dispatchTarget,
};

function synth(config: typeof baseConfig = baseConfig): string {
  return Testing.synthScope((scope) => {
    new TemporalWorkerService(scope, "worker", config);
  });
}

describe("TemporalWorkerService", () => {
  it("registers an aws_ecs_service — a long-running poller, not a RunTask target", () => {
    const json = JSON.parse(synth());
    const services = Object.values(json.resource?.aws_ecs_service ?? {}) as Array<{ desired_count: number }>;
    expect(services).toHaveLength(1);
    expect(services[0]?.desired_count).toBe(1);
  });

  it("gives the security group no ingress rules — only outbound polling", () => {
    const json = JSON.parse(synth());
    const groups = Object.values(json.resource?.aws_security_group ?? {}) as Array<{ ingress?: unknown[] }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ingress ?? []).toEqual([]);
  });

  it("grants the task role RunTask/DescribeTasks scoped to the dispatch target, plus PassRole on both its roles", () => {
    const json = JSON.parse(synth());
    const policies = Object.values(json.resource?.aws_iam_role_policy ?? {}) as Array<{
      name: string;
      policy: string;
    }>;
    const dispatchPolicy = policies.find((p) => p.name.includes("dispatch-specialist"));
    expect(dispatchPolicy, "expected a dispatch-specialist IAM policy on the task role").toBeDefined();

    const statements = JSON.parse(dispatchPolicy!.policy).Statement as Array<{
      Sid: string;
      Action: string | string[];
      Resource: string | string[];
      Condition?: unknown;
    }>;

    const runTask = statements.find((s) => s.Sid === "RunSpecialistTask");
    expect(runTask?.Action).toBe("ecs:RunTask");
    expect(runTask?.Resource).toBe(dispatchTarget.taskDefinitionArn);
    expect(runTask?.Condition).toEqual({ ArnEquals: { "ecs:cluster": dispatchTarget.clusterArn } });

    const describeTasks = statements.find((s) => s.Sid === "DescribeSpecialistTasks");
    expect(describeTasks?.Action).toBe("ecs:DescribeTasks");
    expect(describeTasks?.Condition).toEqual({ ArnEquals: { "ecs:cluster": dispatchTarget.clusterArn } });

    const passRole = statements.find((s) => s.Sid === "PassSpecialistRoles");
    expect(passRole?.Action).toBe("iam:PassRole");
    expect(passRole?.Resource).toEqual([dispatchTarget.executionRoleArn, dispatchTarget.taskRoleArn]);
  });

  it("keeps container_definitions safe from the JSON/token double-encoding gotcha", () => {
    assertSafeContainerDefinitions(synth());
  });

  it("regression: a real Fn.join token in an environment value stays wrapped in Fn.jsonencode", () => {
    // Reproduces the exact bug found wiring SPECIALIST_SUBNET_IDS: a genuine
    // CDKTF token (not a hand-typed string that merely looks like one — a
    // plain literal string with `${...}` text in it is just ordinary string
    // content and would be escaped correctly by either JSON.stringify or
    // Fn.jsonencode, so it can't reproduce this). Fn.join's own HCL call
    // syntax embeds literal quote characters (`join(",", ...)`), and CDKTF
    // splices a token's resolved text in raw wherever it's referenced — that
    // only happens for a real token, which is why this test calls the same
    // Fn.join production code calls, not a fake stand-in. If
    // temporal-worker-service.ts ever regresses to JSON.stringify for
    // container_definitions, this fails the same way the real synth output
    // did before the fix (a second-level JSON.parse of the
    // container_definitions text throwing).
    const configWithJoinToken = {
      ...baseConfig,
      environment: [
        ...baseConfig.environment,
        { name: "SPECIALIST_SUBNET_IDS", value: Fn.join(",", ["subnet-aaaaaaaa", "subnet-bbbbbbbb"]) },
      ],
    };
    assertSafeContainerDefinitions(synth(configWithJoinToken));
  });

  it("regression: a literal object value goes through Fn.jsonencode, not JSON.stringify, to avoid raw embedded quotes", () => {
    // Reproduces the exact bug found wiring REVIEWER_EMAIL_TO_GITHUB_LOGIN:
    // JSON.stringify({"a@b.com": "c"}) produces a plain JS string carrying
    // literal `"` characters, from its own quoted keys and values — a
    // different trigger than the Fn.join case above (there it was a token's
    // own HCL call syntax; here it's a plain string that happens to contain
    // quote characters), but the same underlying gap: CDKTF's outer
    // Fn.jsonencode splice embeds a plain string's content raw, without
    // re-escaping it for the surrounding HCL string literal. Confirmed live
    // (2026-08-13, deploying REVIEWER_EMAIL_TO_GITHUB_LOGIN): Terraform's
    // parser rejected the result with "Invalid character," three characters
    // into what should have been one string value. Fn.jsonencode on the
    // object itself, instead of JSON.stringify, makes this one value its own
    // token — Terraform encodes and escapes it correctly when the outer
    // jsonencode resolves, the same fix already applied one call site over.
    const configWithQuotedLiteral = {
      ...baseConfig,
      environment: [...baseConfig.environment, { name: "REVIEWER_EMAIL_TO_GITHUB_LOGIN", value: Fn.jsonencode({ "a@b.com": "c" }) }],
    };
    const json = synth(configWithQuotedLiteral);
    assertSafeContainerDefinitions(json);

    const parsed = JSON.parse(json) as {
      resource: { aws_ecs_task_definition: Record<string, { container_definitions: string }> };
    };
    const containerDefinitions = Object.values(parsed.resource.aws_ecs_task_definition)[0]?.container_definitions ?? "";
    expect(containerDefinitions).toContain('"value" = jsonencode({"a@b.com" = "c"})');
    expect(containerDefinitions).not.toContain('"value" = "{"a@b.com":"c"}"');
  });
});
