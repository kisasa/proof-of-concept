import { describe, it, expect, vi, afterEach } from "vitest";
import { loadWorkerConfig, parseReviewerMapping } from "./worker-config.js";

const REQUIRED_VARS = {
  TEMPORAL_HOST: "prod.abcde.tmprl.cloud:7233",
  TEMPORAL_NAMESPACE: "prod.abcde",
  TEMPORAL_TASK_QUEUE: "dispatch-task-queue",
  SPECIALIST_CLUSTER_ARN: "arn:aws:ecs:us-east-1:123:cluster/example-specialist-prod",
  SPECIALIST_TASK_DEFINITION_ARN: "arn:aws:ecs:us-east-1:123:task-definition/specialist-prod:1",
  SPECIALIST_CONTAINER_NAME: "specialist-prod",
  SPECIALIST_SECURITY_GROUP_ID: "sg-0123456789abcdef0",
  SPECIALIST_SUBNET_IDS: "subnet-aaa, subnet-bbb",
  GITHUB_TOKEN: "gh-token",
  LINEAR_AGENT_API_KEY: "linear-key",
};

function stubAll(overrides: Record<string, string | undefined> = {}): void {
  const merged = { ...REQUIRED_VARS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      vi.stubEnv(key, undefined as unknown as string);
      delete process.env[key];
    } else {
      vi.stubEnv(key, value);
    }
  }
}

describe("loadWorkerConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads a complete config, splitting and trimming subnet ids", () => {
    stubAll({ TEMPORAL_API_KEY: "temporal-key" });
    expect(loadWorkerConfig()).toEqual({
      temporalHost: "prod.abcde.tmprl.cloud:7233",
      temporalNamespace: "prod.abcde",
      temporalTaskQueue: "dispatch-task-queue",
      temporalApiKey: "temporal-key",
      temporalTls: true,
      specialistClusterArn: "arn:aws:ecs:us-east-1:123:cluster/example-specialist-prod",
      specialistTaskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-definition/specialist-prod:1",
      specialistContainerName: "specialist-prod",
      specialistSecurityGroupId: "sg-0123456789abcdef0",
      specialistSubnetIds: ["subnet-aaa", "subnet-bbb"],
      githubToken: "gh-token",
      linearAgentApiKey: "linear-key",
      reviewerEmailToGithubLogin: new Map(),
      logLevel: "info",
    });
  });

  it("throws naming the missing var", () => {
    stubAll({ SPECIALIST_CLUSTER_ARN: undefined });
    expect(() => loadWorkerConfig()).toThrow(/SPECIALIST_CLUSTER_ARN/);
  });

  it("leaves temporalApiKey undefined when not set — a real state, not a missing-config error", () => {
    stubAll();
    expect(loadWorkerConfig().temporalApiKey).toBeUndefined();
  });

  it("defaults temporalTls to true", () => {
    stubAll();
    expect(loadWorkerConfig().temporalTls).toBe(true);
  });

  it("only turns temporalTls off on the literal string \"false\"", () => {
    stubAll({ TEMPORAL_TLS: "false" });
    expect(loadWorkerConfig().temporalTls).toBe(false);
  });

  it("parses REVIEWER_EMAIL_TO_GITHUB_LOGIN when set", () => {
    stubAll({ REVIEWER_EMAIL_TO_GITHUB_LOGIN: '{"user@example.com":"example-login"}' });
    expect(loadWorkerConfig().reviewerEmailToGithubLogin).toEqual(new Map([["user@example.com", "example-login"]]));
  });

  it("defaults logLevel to info", () => {
    stubAll();
    expect(loadWorkerConfig().logLevel).toBe("info");
  });

  it("reads logLevel from LOG_LEVEL when set", () => {
    stubAll({ LOG_LEVEL: "trace" });
    expect(loadWorkerConfig().logLevel).toBe("trace");
  });
});

describe("parseReviewerMapping", () => {
  it("returns an empty map when unset", () => {
    expect(parseReviewerMapping(undefined)).toEqual(new Map());
  });

  it("returns an empty map for an empty string", () => {
    expect(parseReviewerMapping("")).toEqual(new Map());
  });

  it("parses a well-formed email -> login object", () => {
    const mapping = parseReviewerMapping('{"user@example.com":"example-login","second@example.com":"example-login-2"}');
    expect(mapping).toEqual(
      new Map([
        ["user@example.com", "example-login"],
        ["second@example.com", "example-login-2"],
      ]),
    );
  });

  it("throws on malformed JSON", () => {
    expect(() => parseReviewerMapping("{not json")).toThrow(/not valid JSON/);
  });

  it("throws on a JSON array", () => {
    expect(() => parseReviewerMapping("[]")).toThrow(/must be a JSON object/);
  });

  it("throws on a non-string login value", () => {
    expect(() => parseReviewerMapping('{"user@example.com":42}')).toThrow(/must be a non-empty string GitHub login/);
  });

  it("throws on an empty-string login value", () => {
    expect(() => parseReviewerMapping('{"user@example.com":""}')).toThrow(/must be a non-empty string GitHub login/);
  });
});
