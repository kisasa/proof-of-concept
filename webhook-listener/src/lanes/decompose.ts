/**
 * Decompose lane. Second agent inside the Evaluation status — wakes when the
 * Specification Agent's API map is resolved (`spec:resolved` applied). Reads
 * the codebase; cuts the epic into dependency-sequenced, specialist-assigned
 * stories behind an explicit human checkpoint.
 */

import type { AgentLaneConfig } from "../agent-lane.js";
import { requireEnv } from "../env.js";

// A variable clause supplying what happened this activation, without naming
// the outcome — decompose-agent.md's own decision-flow logic determines
// ask/checkpoint/shaped from the thread regardless of what this says.
const ACTIVATION_DESCRIPTION = {
  first:
    "The Specification Agent's API map was just resolved (spec:resolved applied) — this is your first look at decomposition.",
  "follow-up": "A human replied in the comment thread you're participating in.",
};

export const config: AgentLaneConfig = {
  name: "decompose",
  entityType: "issue",
  agentFile: "decompose-agent.md",
  skills: ["epic-writing", "story-contract", "tracker-writing"],
  codebaseAccess: true,
  // Infra-required per engagement, no code-level default — see
  // infrastructure/models/listener-configuration.ts and CLAUDE_MODEL_DECOMPOSE
  // in webhook-listener/.env.example.
  model: requireEnv("CLAUDE_MODEL_DECOMPOSE"),
  templates: {
    first: "decompose.md",
    followUp: "decompose.md",
  },
  buildPlaceholders(pass, entityId, entityTitle) {
    return {
      EPIC_TITLE: entityTitle ?? "(untitled)",
      EPIC_ID: entityId,
      PASS: pass,
      ACTIVATION_DESCRIPTION: ACTIVATION_DESCRIPTION[pass],
    };
  },
};
