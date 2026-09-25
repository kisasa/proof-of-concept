import { type ContextNode, requireNumber, requireString } from "./context";

/**
 * Everything that varies between environments for the specialist sandbox — the
 * ephemeral per-dispatch Fargate task, distinct from the listener's own service.
 * Mirrors `listener-configuration.ts`'s shape; kept as a separate type because the
 * two are provisioned and scaled on entirely different terms (one always-on
 * singleton service vs. many short-lived tasks).
 */
export interface SpecialistSandboxConfiguration {
  readonly environmentName: string;
  readonly ecrRepositoryName: string;
  readonly imageTag: string;
  readonly cpu: number;
  readonly memory: number;
  readonly logRetentionDays: number;

  /** `org/name` on GitHub for the framework (agents/skills) repo the specialist clones. */
  readonly frameworkRepo: string;

  /** Git ref of the framework repo to clone. */
  readonly frameworkRef: string;

  /**
   * Required, with no code-level default in specialist-runner/src/claude-
   * config.ts (see its own env.ts's requireEnv). Baked into the task
   * definition's baseline container environment (CLAUDE_MODEL /
   * CLAUDE_EFFORT) rather than a per-dispatch RunTask override, same posture
   * as frameworkRepo/frameworkRef above — every specialist run in this
   * deployment uses whichever model this engagement is currently tuned to.
   */
  readonly claudeModel: string;
  readonly claudeEffort: string;
}

export function specialistSandboxConfigurationFromContext(node: ContextNode): SpecialistSandboxConfiguration {
  const path = "specialist-sandbox";

  return {
    environmentName: requireString(node, "environment-name", path),
    ecrRepositoryName: requireString(node, "ecr-repository-name", path),
    imageTag: requireString(node, "image-tag", path),
    cpu: requireNumber(node, "cpu", path),
    memory: requireNumber(node, "memory", path),
    logRetentionDays: requireNumber(node, "log-retention-days", path),
    frameworkRepo: requireString(node, "framework-repo", path),
    frameworkRef: requireString(node, "framework-ref", path),
    claudeModel: requireString(node, "claude-model", path),
    claudeEffort: requireString(node, "claude-effort", path),
  };
}
