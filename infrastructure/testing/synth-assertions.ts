/**
 * Shared assertions for construct-level synth tests — encodes the checks
 * that used to be one-off `node -e` inspections of `cdktn.out/` into real,
 * repeatable tests. See design-ledger.md's "Finishing the wiring" entry for
 * the real bug `assertSafeContainerDefinitions` exists to catch.
 */

import { expect } from "vitest";

/**
 * Every `aws_ecs_task_definition` resource's `container_definitions` field
 * must be safe from the JSON-inside-JSON double-encoding CDKTF gotcha:
 * `JSON.stringify([containerDefinition])` corrupts the moment any embedded
 * token's own resolved HCL text contains a quote character (e.g. `Fn.join`'s
 * separator argument, `","`) — CDKTF splices a token's text in raw wherever
 * it's referenced, without re-escaping the surrounding JSON string.
 *
 * A token-free `container_definitions` value must parse as real JSON
 * directly. A value containing any `${...}` token must be wrapped in exactly
 * one `Fn.jsonencode(...)` call — the fix that makes Terraform itself do the
 * encoding, after every token resolves, rather than JS trying to encode
 * around not-yet-resolved placeholders.
 */
export function assertSafeContainerDefinitions(synthesizedJson: string): void {
  const parsed = JSON.parse(synthesizedJson) as {
    resource?: { aws_ecs_task_definition?: Record<string, { container_definitions: string }> };
  };
  const taskDefinitions = parsed.resource?.aws_ecs_task_definition ?? {};
  const entries = Object.entries(taskDefinitions);

  expect(entries.length, "expected at least one aws_ecs_task_definition resource to check").toBeGreaterThan(0);

  for (const [name, taskDefinition] of entries) {
    const value = taskDefinition.container_definitions;
    if (value.includes("${")) {
      expect(value, `${name}'s container_definitions carries a token but isn't wrapped in Fn.jsonencode`).toMatch(
        /^\$\{jsonencode\(.*\)\}$/s,
      );
    } else {
      expect(() => JSON.parse(value), `${name}'s container_definitions is not valid JSON`).not.toThrow();
    }
  }
}
