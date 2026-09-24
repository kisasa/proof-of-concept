/**
 * Intake lane. Wakes on `ready for intake` applied to a Backlog project;
 * translates an approved business-requirements document into slice epics.
 * Reasons from the brief, its attachments, and the thread alone — no
 * codebase access.
 */

import type { AgentLaneConfig } from "../agent-lane.js";
import { requireEnv } from "../env.js";

// The two fixed activation-trigger strings from the design ledger. This is
// reinforcement, not load-bearing — intake-agent.md's own decision-flow logic
// already determines ask/checkpoint/slice state from the thread regardless of
// what this says — but it's cheap and removes ambiguity for the model.
const ACTIVATION_TRIGGER = {
  first: "The label was just applied — this is a first look.",
  "follow-up":
    "A human replied in the comment thread you're participating in. The thread contains your own prior " +
    "checkpoint proposal — treat it as your prior activation's output and carry the conversation forward.",
};

export const config: AgentLaneConfig = {
  name: "intake",
  entityType: "project",
  agentFile: "intake-agent.md",
  skills: ["epic-writing", "business-requirements-writing", "tracker-writing"],
  codebaseAccess: false,
  // Infra-required per engagement, no code-level default — see
  // infrastructure/models/listener-configuration.ts and CLAUDE_MODEL_INTAKE
  // in webhook-listener/.env.example.
  model: requireEnv("CLAUDE_MODEL_INTAKE"),
  templates: {
    first: "intake.md",
    followUp: "intake.md",
  },
  buildPlaceholders(pass, entityId, entityTitle) {
    return {
      PROJECT_TITLE: entityTitle ?? "(untitled)",
      PROJECT_ID: entityId,
      ACTIVATION_TRIGGER: ACTIVATION_TRIGGER[pass],
    };
  },
};
