import { type ContextNode, optionalString, requireNumber, requireString } from "./context";

/**
 * Everything that varies between environments for the webhook-listener service.
 * Mirrors the `listener-config` node in the reference project: one nested
 * object per deployable thing, with a `fromContext` factory that validates.
 *
 * `imageTag` is the value that changes on every deploy. It is pinned here
 * rather than tracking `:latest` so that Terraform sees a real diff and the
 * running version is auditable in git — the same choice the reference project
 * makes with its per-service `version` keys.
 */
export interface ListenerConfiguration {
  readonly environmentName: string;
  readonly subdomain: string;
  readonly ecrRepositoryName: string;
  readonly imageTag: string;
  readonly port: number;
  readonly cpu: number;
  readonly memory: number;
  readonly logRetentionDays: number;
  readonly debounceMs: number;
  readonly logLevel: string;

  /** Optional overrides for values webhook-listener already defaults itself. */
  readonly linearApiUrl: string | undefined;
  readonly linearMcpUrl: string | undefined;
  readonly githubMcpUrl: string | undefined;
  readonly productContextPaths: string | undefined;

  /**
   * Model and effort for every shaping-tier activation call — required, with
   * no code-level default in webhook-listener (see env.ts's requireEnv):
   * guessing a fallback here would silently mask a missing deployment
   * config instead of failing synth with a clear key name. Kept one model
   * key per lane, not a shared "claude-model" key, because
   * AgentLaneConfig.model is per-lane identity, not a uniform knob — an
   * engagement may want Decompose on a stronger model than Intake while
   * leaving the rest alone. Effort, by contrast, genuinely is uniform (see
   * activation-config.ts's own ActivationConfig.effort), so it's one key.
   */
  readonly claudeModelIntake: string;
  readonly claudeModelSpecification: string;
  readonly claudeModelDecompose: string;
  readonly claudeEffort: string;
}

export function listenerConfigurationFromContext(node: ContextNode): ListenerConfiguration {
  const path = "listener";
  const environmentName = requireString(node, "environment-name", path);

  // 32 characters is the hard cap on load balancer and target group names, and
  // the environment name is only one component of those. Failing here beats
  // failing several minutes into an apply.
  if (environmentName.length > 30) {
    throw new Error(
      `Context ${path}.environment-name must be 30 characters or fewer (got ${environmentName.length}) — ` +
        `load balancer and target group names are capped at 32`,
    );
  }

  return {
    environmentName: environmentName,
    subdomain: requireString(node, "subdomain", path),
    ecrRepositoryName: requireString(node, "ecr-repository-name", path),
    imageTag: requireString(node, "image-tag", path),
    port: requireNumber(node, "port", path),
    cpu: requireNumber(node, "cpu", path),
    memory: requireNumber(node, "memory", path),
    logRetentionDays: requireNumber(node, "log-retention-days", path),
    debounceMs: requireNumber(node, "debounce-ms", path),
    logLevel: requireString(node, "log-level", path),
    linearApiUrl: optionalString(node, "linear-api-url", path),
    linearMcpUrl: optionalString(node, "linear-mcp-url", path),
    githubMcpUrl: optionalString(node, "github-mcp-url", path),
    productContextPaths: optionalString(node, "product-context-paths", path),
    claudeModelIntake: requireString(node, "claude-model-intake", path),
    claudeModelSpecification: requireString(node, "claude-model-specification", path),
    claudeModelDecompose: requireString(node, "claude-model-decompose", path),
    claudeEffort: requireString(node, "claude-effort", path),
  };
}
