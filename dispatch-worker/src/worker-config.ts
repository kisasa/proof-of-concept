/**
 * Everything this worker process needs at startup, read once. All of it flows
 * from `infrastructure/stacks/temporal-workers.ts`'s container environment:
 * the Temporal connection vars (TEMPORAL_HOST, TEMPORAL_NAMESPACE,
 * TEMPORAL_TASK_QUEUE, TEMPORAL_API_KEY) and the specialist-sandbox
 * dispatch-target vars (SPECIALIST_*, wired from `specialist-sandbox-stack-
 * output.ts`'s clusterArn/taskDefinitionArn/securityGroupId plus `network`'s
 * publicSubnetIds). This worker fails fast at startup naming whichever var is
 * missing, rather than partway through a dispatch.
 */

import { envOr } from "./env.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/**
 * Reviewer-of-record's identity mapping: Linear only gives the pipeline a
 * story-mover's email (docs/design-ledger.md, "reviewer-of-record"); GitHub's
 * requested-reviewers API needs a login. No automatic way to bridge the two
 * reliably exists (an email-search API call would silently miss anyone whose
 * GitHub account doesn't expose a matching public email), so this is a static,
 * architect-maintained table instead — reviewed the same way a conventions
 * spec is, kept current as people join/leave.
 *
 * Optional and defaults to empty: an engagement that hasn't filled this in yet
 * still dispatches normally, it just skips requesting a reviewer (see
 * `request-pull-request-reviewer.ts`) rather than failing every dispatch.
 */
export function parseReviewerMapping(raw: string | undefined): Map<string, string> {
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`REVIEWER_EMAIL_TO_GITHUB_LOGIN is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("REVIEWER_EMAIL_TO_GITHUB_LOGIN must be a JSON object of email -> GitHub login");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [email, login] of entries) {
    if (typeof login !== "string" || login.length === 0) {
      throw new Error(`REVIEWER_EMAIL_TO_GITHUB_LOGIN's entry for "${email}" must be a non-empty string GitHub login`);
    }
  }
  return new Map(entries as [string, string][]);
}

export interface WorkerConfig {
  readonly temporalHost: string;
  readonly temporalNamespace: string;
  readonly temporalTaskQueue: string;

  /**
   * Optional: Temporal Cloud requires an API key, a local dev server
   * (`temporalio/auto-setup`, no namespace auth) doesn't have one at all.
   * `undefined` is a valid, real state here, not a missing-config error.
   */
  readonly temporalApiKey: string | undefined;

  /**
   * Defaults `true` (Temporal Cloud, the only thing this ever pointed at
   * until local dev needed a plain, unencrypted connection to a local
   * server) — only `TEMPORAL_TLS=false` turns it off, so existing
   * deployments need no env change to keep working.
   */
  readonly temporalTls: boolean;

  /** ARN of the specialist-sandbox ECS cluster to RunTask against. */
  readonly specialistClusterArn: string;
  /** ARN of the specialist-sandbox task definition (family or full ARN). */
  readonly specialistTaskDefinitionArn: string;

  /**
   * The container name inside that task definition — `specialist-task.ts`
   * names it `specialist-${environmentName}` (e.g. `specialist-prod`), a
   * deployment-specific value RunTask's container overrides must match
   * exactly, so it's config here rather than a guessed constant.
   */
  readonly specialistContainerName: string;
  readonly specialistSecurityGroupId: string;
  /** Comma-separated subnet ids — the network stack's public subnets. */
  readonly specialistSubnetIds: string[];

  readonly githubToken: string;
  readonly linearAgentApiKey: string;

  /** Reviewer-of-record's static Linear-email -> GitHub-login table. See parseReviewerMapping. */
  readonly reviewerEmailToGithubLogin: Map<string, string>;

  /**
   * This process's own log level (`logger.ts` already reads `LOG_LEVEL`
   * directly for its own logging) — surfaced here too so
   * `dispatch-specialist.ts` can pass it through as a RunTask container
   * override, propagating whatever this worker was configured with down to
   * the specialist container it launches, rather than the specialist
   * needing its own separate `LOG_LEVEL` wired in. Defaults to "info",
   * matching every other logger in this codebase.
   */
  readonly logLevel: string;
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    temporalHost: requireEnv("TEMPORAL_HOST"),
    temporalNamespace: requireEnv("TEMPORAL_NAMESPACE"),
    temporalTaskQueue: requireEnv("TEMPORAL_TASK_QUEUE"),
    temporalApiKey: process.env.TEMPORAL_API_KEY || undefined,
    temporalTls: process.env.TEMPORAL_TLS !== "false",

    specialistClusterArn: requireEnv("SPECIALIST_CLUSTER_ARN"),
    specialistTaskDefinitionArn: requireEnv("SPECIALIST_TASK_DEFINITION_ARN"),
    specialistContainerName: requireEnv("SPECIALIST_CONTAINER_NAME"),
    specialistSecurityGroupId: requireEnv("SPECIALIST_SECURITY_GROUP_ID"),
    specialistSubnetIds: requireEnv("SPECIALIST_SUBNET_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),

    githubToken: requireEnv("GITHUB_TOKEN"),
    linearAgentApiKey: requireEnv("LINEAR_AGENT_API_KEY"),

    reviewerEmailToGithubLogin: parseReviewerMapping(process.env.REVIEWER_EMAIL_TO_GITHUB_LOGIN),

    logLevel: envOr("LOG_LEVEL", "info"),
  };
}
