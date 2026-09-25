import { type ContextNode, requireNumber, requireString, requireStringMap } from "./context";

/**
 * Everything that varies between environments for the Temporal worker service —
 * the always-on poller that sequences dispatch → wait-for-specialist → CI →
 * human-review-gate. Mirrors `listener-configuration.ts`'s shape.
 *
 * Unlike the listener or the specialist sandbox, `desiredCount` here is not
 * pinned to 1: Temporal workers are safely concurrent pollers with no
 * in-process shared state, so there is no singleton constraint to enforce.
 */
export interface TemporalConfiguration {
  readonly environmentName: string;
  readonly namespaceName: string;
  readonly ecrRepositoryName: string;
  readonly imageTag: string;
  readonly cpu: number;
  readonly memory: number;
  readonly desiredCount: number;
  readonly logRetentionDays: number;
  // Reviewer-of-record's static Linear-email -> GitHub-login table (see
  // dispatch-worker/src/worker-config.ts's parseReviewerMapping). Context, not
  // an SSM parameter: it's architect-maintained data, not a credential, and
  // nothing here needs it to change without a redeploy already happening.
  readonly reviewerEmailToGithubLogin: Record<string, string>;
}

export function temporalConfigurationFromContext(node: ContextNode): TemporalConfiguration {
  const path = "temporal";

  return {
    environmentName: requireString(node, "environment-name", path),
    namespaceName: requireString(node, "namespace-name", path),
    ecrRepositoryName: requireString(node, "ecr-repository-name", path),
    imageTag: requireString(node, "image-tag", path),
    cpu: requireNumber(node, "cpu", path),
    memory: requireNumber(node, "memory", path),
    desiredCount: requireNumber(node, "desired-count", path),
    logRetentionDays: requireNumber(node, "log-retention-days", path),
    reviewerEmailToGithubLogin: requireStringMap(node, "reviewer-email-to-github-login", path),
  };
}
