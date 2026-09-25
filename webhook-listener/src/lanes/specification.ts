/**
 * Specification lane. The one agent inside the Evaluation status — wakes when
 * an epic enters Evaluation with no `spec:*` label yet, and on replies while a
 * `spec:awaiting-*` label is present. Reads the codebase; produces the API map
 * and the epic's stories together, under one architect approval.
 */

import type { AgentLaneConfig } from "../agent-lane.js";
import { requireEnv } from "../env.js";

export const config: AgentLaneConfig = {
  name: "specification",
  entityType: "issue",
  agentFile: "specification-agent.md",
  skills: ["api-map-writing", "epic-writing", "story-contract", "tracker-writing"],
  codebaseAccess: true,
  // Infra-required per engagement, no code-level default — see
  // infrastructure/models/listener-configuration.ts and
  // CLAUDE_MODEL_SPECIFICATION in webhook-listener/.env.example.
  model: requireEnv("CLAUDE_MODEL_SPECIFICATION"),
  templates: {
    first: "specification-kickoff.md",
    followUp: "specification-reply.md",
  },
  buildPlaceholders(_pass, entityId, entityTitle) {
    return {
      EPIC_TITLE: entityTitle ?? "(untitled)",
      EPIC_ID: entityId,
    };
  },
};
