/**
 * The model and effort level every specialist run uses — uniform tuning
 * knobs, not per-dispatch identity (that's dispatch-context.ts). Mirrors the
 * separation in webhook-listener/src/activation-config.ts: "per-lane identity
 * lives in each lane's own config; this module is only the knobs that apply
 * uniformly."
 *
 * Both are required, with no code-level default: an unset `model`/`effort`
 * would otherwise either silently track whatever the CLI's default happens
 * to be on a given build, or mask a missing deployment config behind a value
 * this codebase invented. In production both are baked into the specialist-
 * sandbox task definition's baseline environment by infrastructure/stacks/
 * specialist-sandbox.ts (context keys `claude-model` / `claude-effort`) —
 * tune them there, not here, to change every specialist run in a deployment.
 */

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { requireEnv } from "./env.js";

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface ClaudeConfig {
  readonly model: string;
  readonly effort: EffortLevel;
}

function loadEffort(raw: string): EffortLevel {
  if ((EFFORT_LEVELS as string[]).includes(raw)) return raw as EffortLevel;
  throw new Error(`CLAUDE_EFFORT="${raw}" is not a valid effort level. Supported: ${EFFORT_LEVELS.join(", ")}`);
}

export function loadClaudeConfig(): ClaudeConfig {
  return {
    model: requireEnv("CLAUDE_MODEL"),
    effort: loadEffort(requireEnv("CLAUDE_EFFORT")),
  };
}
