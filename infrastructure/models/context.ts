/**
 * Context is the only configuration source for these stacks — every value comes
 * from the `context` block of cdktf.json, read once per stack in the base
 * constructor.
 *
 * Nothing here reads process.env, and there are no sensitive Terraform
 * variables: the four secrets reach the container from SSM Parameter Store at
 * task-start time, so no secret is ever in scope during synth and none can
 * land in the synthesized JSON or in state.
 *
 * These accessors throw rather than defaulting. A missing region or account
 * number should fail at synth with the key name in the message, not produce a
 * plan against the wrong account.
 */

export type ContextNode = Record<string, unknown>;

export function requireNode(node: ContextNode, key: string, path: string): ContextNode {
  const value = node[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Context ${path}.${key} must be an object`);
  }
  return value as ContextNode;
}

export function requireString(node: ContextNode, key: string, path: string): string {
  const value = node[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Context ${path}.${key} must be a non-empty string`);
  }
  return value;
}

export function requireNumber(node: ContextNode, key: string, path: string): number {
  const value = node[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Context ${path}.${key} must be a number`);
  }
  return value;
}

/**
 * For values the application itself already defaults (LINEAR_API_URL and the
 * two MCP URLs, via webhook-listener's envOr). Absent and explicitly null both
 * mean "let the app decide" — JSON has no undefined, and the shipped cdktf.json
 * spells these out as null to document that they exist.
 */
export function optionalString(node: ContextNode, key: string, path: string): string | undefined {
  const value = node[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Context ${path}.${key} must be a non-empty string when present`);
  }
  return value;
}

export function requireStringMap(node: ContextNode, key: string, path: string): Record<string, string> {
  const raw = requireNode(node, key, path);
  const result: Record<string, string> = {};

  for (const [entryKey, entryValue] of Object.entries(raw)) {
    if (typeof entryValue !== "string") {
      throw new Error(`Context ${path}.${key}.${entryKey} must be a string`);
    }
    result[entryKey] = entryValue;
  }

  return result;
}
