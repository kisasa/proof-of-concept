/**
 * The shape every agent lane's config exports. This is the "registration" a
 * fourth lane needs to add: one file satisfying this interface, plus one entry
 * in swim-lanes.ts wiring its trigger rules. No change to activation-runner.ts,
 * prompt-assembly.ts, or routing.
 */

import type { EntityType } from "./tracker-event.js";

export interface AgentLaneConfig {
  name: string;
  entityType: EntityType;

  // Filename of the agent's .md definition inside the top-level agents/
  // directory — e.g. "intake-agent.md". Resolved by prompt-assembly.ts the
  // same way skills.ts resolves skill names, so lane configs never encode a
  // relative path themselves.
  agentFile: string;

  // Skill names loaded via skills.ts, attached as additional system blocks
  // after the agent file. Empty for an agent with no team-forked skill.
  skills: string[];

  // Whether the GitHub MCP server is attached this run, alongside Linear's.
  // Intake reasons from the brief/attachments/thread alone; Specification and
  // Decompose read the codebase — Claude does that directly via MCP, the same
  // way it reads/writes the tracker. The app never clones or reads a repo
  // itself and has no opinion on which repo — the agent discovers and records
  // the repo base per surface itself (see specification-agent.md).
  codebaseAccess: boolean;

  model: string;

  // Template file basenames under prompt-templates/, selected by activation
  // pass. Equal for a lane with one unified template across both passes
  // (Intake, Decompose); distinct for Specification's kickoff/reply split.
  templates: {
    first: string;
    followUp: string;
  };

  // Builds the literal placeholder values the chosen template substitutes.
  // Each lane owns its own placeholder set — the app supplies only what it can
  // actually produce (webhook payload fields, its own recorded state); anything
  // else is the agent's to discover via the tracker connector.
  buildPlaceholders(pass: "first" | "follow-up", entityId: string, entityTitle: string | null): Record<string, string>;
}
