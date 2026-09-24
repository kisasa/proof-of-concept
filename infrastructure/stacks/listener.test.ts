import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { ListenerStack } from "./listener.js";

// Mirrors cdktf.json's own real context shape — the fixture a stack-level
// test needs, since BaseStack reads every field via node.tryGetContext at
// construction time rather than accepting injected config.
const TEST_CONTEXT = {
  aws: { region: "us-east-1", "account-number": "000000000000", profile: "example" },
  "state-bucket-name": "ki-webhook-listener-tfstate",
  "global-tags": { terraform: "true", project: "intent-to-production", environment: "test" },
  "domain-name": "example.com",
  "hosted-zone-id": "Z0000000000000000000",
  "vpc-cidr-block": "10.10.0.0/22",
  "parameter-prefix": "/example/test/",
    "resource-name-prefix": "example",
  listener: {
    "environment-name": "test",
    subdomain: "intent",
    "ecr-repository-name": "intent-to-production",
    "image-tag": "test-tag",
    port: 8787,
    cpu: 512,
    memory: 1024,
    "log-retention-days": 30,
    "debounce-ms": 15000,
    "log-level": "info",
    "linear-api-url": null,
    "linear-mcp-url": null,
    "github-mcp-url": null,
    "product-context-paths": null,
    "claude-model-intake": "claude-sonnet-5",
    "claude-model-specification": "claude-sonnet-5",
    "claude-model-decompose": "claude-sonnet-5",
    "claude-effort": "high",
  },
  "specialist-sandbox": {
    "environment-name": "test",
    "ecr-repository-name": "intent-to-production-specialist",
    "image-tag": "test-tag",
    cpu: 1024,
    memory: 2048,
    "log-retention-days": 30,
    "framework-repo": "example-org/intent-to-production",
    "framework-ref": "main",
    "claude-model": "claude-sonnet-5",
    "claude-effort": "high",
  },
  temporal: {
    "environment-name": "test",
    "namespace-name": "intent-to-production-test",
    "ecr-repository-name": "intent-to-production-temporal-worker",
    "image-tag": "test-tag",
    cpu: 512,
    memory: 1024,
    "desired-count": 1,
    "log-retention-days": 30,
    "reviewer-email-to-github-login": { "reviewer@example.com": "example-login" },
  },
};

function synth(): string {
  const app = Testing.app({ context: TEST_CONTEXT });
  const stack = new ListenerStack(app);
  return Testing.synth(stack);
}

describe("ListenerStack", () => {
  it("gives the container its own Temporal client connection info via temporal-workers's remote state", () => {
    const json = JSON.parse(synth());
    const taskDefinitions = Object.values(json.resource?.aws_ecs_task_definition ?? {}) as Array<{
      container_definitions: string;
    }>;
    expect(taskDefinitions).toHaveLength(1);

    const containerDefinition = JSON.parse(taskDefinitions[0]!.container_definitions)[0] as {
      environment: { name: string; value: string }[];
      secrets: { name: string; valueFrom: string }[];
    };

    const envNames = containerDefinition.environment.map((entry) => entry.name);
    expect(envNames).toEqual(expect.arrayContaining(["TEMPORAL_HOST", "TEMPORAL_NAMESPACE", "TEMPORAL_TASK_QUEUE"]));

    const temporalApiKeySecret = containerDefinition.secrets.find((entry) => entry.name === "TEMPORAL_API_KEY");
    expect(temporalApiKeySecret).toBeDefined();
  });

  it("reads the TEMPORAL_API_KEY parameter under the deployment's shared prefix", () => {
    const json = JSON.parse(synth());
    const ssmParameters = Object.values(json.data?.aws_ssm_parameter ?? {}) as Array<{ name: string }>;
    const temporalApiKeyParameter = ssmParameters.find((parameter) => parameter.name.endsWith("TEMPORAL_API_KEY"));
    expect(temporalApiKeyParameter?.name).toBe("/example/test/TEMPORAL_API_KEY");
  });

  it("grants the execution role read access to the TEMPORAL_API_KEY parameter's arn", () => {
    const json = JSON.parse(synth());
    const policies = Object.values(json.resource?.aws_iam_role_policy ?? {}) as Array<{ policy: string }>;
    const readSecretsPolicy = policies.find((policy) => policy.policy.includes("ssm:GetParameters"));
    expect(readSecretsPolicy).toBeDefined();

    const statement = JSON.parse(readSecretsPolicy!.policy).Statement[0] as { Resource: string[] };
    const referencesTemporalKey = statement.Resource.some((arn) => arn.includes("ssm-temporal-api-key"));
    expect(referencesTemporalKey).toBe(true);
  });
});
