/**
 * The pipeline's swim lane registry. Each lane pairs a trigger rule (when does
 * this agent wake) with an agent function (what runs when it does) — trigger
 * rules are a routing concern and live here, not in the agent's own config,
 * since they encode which label/status names this deployment's tracker uses.
 *
 * To add an Anthropic-calling lane: implement the agent's AgentLaneConfig
 * under lanes/, then add one entry below built via createActivationRunner.
 * specialist-dispatch is the one exception — its `agent` starts a Temporal
 * workflow, not an activation, so it exports a full `LaneConfig` directly
 * from its own lanes/ file and is spread in as-is. Either way: no other file
 * changes — this is what makes a new lane a registration, not a
 * rearchitecture.
 */

import type { LaneConfig } from "./swim-lane-routing.js";
import { createActivationRunner } from "./activation-runner.js";
import { config as intakeConfig } from "./lanes/intake.js";
import { config as specificationConfig } from "./lanes/specification.js";
import { config as decomposeConfig } from "./lanes/decompose.js";
import { config as specialistDispatchConfig } from "./lanes/specialist-dispatch.js";

export const lanes: LaneConfig[] = [
  {
    name: intakeConfig.name,
    entityType: intakeConfig.entityType,
    agent: createActivationRunner(intakeConfig),
    // First touch: `ready for intake` applied to a Backlog project — a human act.
    firstPass: { on: "label_added", label: "ready for intake", statusRequired: "Backlog" },
    // Intake's own trigger section: follow-up fires on any reply while the label
    // is present, not a narrower awaiting-sub-label — `ask` leaves labels
    // untouched, so the label that gated first-pass is the same one that gates
    // every follow-up until `slice` swaps it for `ready for eval`.
    awaitingLabels: ["ready for intake"],
    statusRequiredForFollowUp: "Backlog",
  },
  {
    name: specificationConfig.name,
    entityType: specificationConfig.entityType,
    agent: createActivationRunner(specificationConfig),
    // The one absence-gated trigger in this table: an epic entering Evaluation
    // with no spec:* label yet — everything else here matches on presence.
    firstPass: { on: "status_entered", status: "Evaluation", requireLabelsAbsentPrefix: "spec:" },
    // spec:awaiting-answers covers a pre-draft `ask` (e.g. an unresolved repo
    // base) — the one case where the agent needs to hear back before a map
    // exists at all, so awaiting-architect/designer aren't up yet to route
    // the reply. Observed live 2026-07-29: without it, a reply to a
    // pre-draft question matched neither the first-pass trigger (not a fresh
    // status entry) nor the other two awaiting labels (never applied pre-map),
    // leaving the epic stuck with no route back to Specification.
    awaitingLabels: ["spec:awaiting-architect", "spec:awaiting-designer", "spec:awaiting-answers"],
    statusRequiredForFollowUp: "Evaluation",
  },
  {
    name: decomposeConfig.name,
    entityType: decomposeConfig.entityType,
    agent: createActivationRunner(decomposeConfig),
    // First touch: the Specification Agent applying spec:resolved — an agent's
    // own label change, not guarded by the self-comment filter (that guard
    // covers comments only; label changes are exactly how lanes hand off).
    firstPass: { on: "label_added", label: "spec:resolved", statusRequired: "Evaluation" },
    awaitingLabels: ["eval:awaiting-answers", "eval:awaiting-approval"],
    statusRequiredForFollowUp: "Evaluation",
  },
  specialistDispatchConfig,
];
