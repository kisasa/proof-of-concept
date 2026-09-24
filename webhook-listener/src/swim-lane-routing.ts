/**
 * Maps a TrackerEvent to the agent lane that should handle it, if any.
 *
 * The routing criterion is labels and status, not column position — the control
 * model reserves status moves for humans and drives agent activation off labels
 * (agents move labels; humans move statuses). Each lane declares its own
 * first-pass trigger and the label(s) that mark its thread as "awaiting a reply."
 *
 * Two first-pass trigger shapes exist:
 *   label_added    — fires when a specific label is newly applied (Intake's
 *                     `ready for intake`, Decompose's `spec:resolved`).
 *   status_entered — fires when the entity's status changes to a target value.
 *                     Specification's is the one case gated on label *absence*
 *                     (`requireLabelsAbsentPrefix`) rather than presence — its
 *                     first touch is an epic entering Evaluation with no
 *                     `spec:*` label yet. Every other trigger in this file
 *                     matches on presence. The specialist-dispatch lane uses
 *                     the symmetric `requireLabelsPresentPrefix` to scope its
 *                     own status_entered trigger to stories (which carry a
 *                     `surface:*` label) and exclude epics (which share
 *                     the same status workflow but never carry one) — a pure,
 *                     synchronous check against the event's own label set, no
 *                     extra I/O.
 *
 * Follow-up is uniform across lanes: a human comment while any of the lane's
 * `awaitingLabels` is present. The self-comment guard applies only here — an
 * agent's own label changes (its handoff mechanism to the next lane) must not
 * be filtered, only its own comments, or agents could never wake each other.
 *
 * route() is a pure function — no I/O, no side effects. It can be unit tested
 * directly without a running server or live tracker connection.
 */

import type { AgentFn, EntityType, Pass, TrackerActor, TrackerEvent } from "./tracker-event.js";

export type FirstPassTrigger =
  | { on: "label_added"; label: string; statusRequired?: string }
  | {
      on: "status_entered";
      status: string;
      requireLabelsAbsentPrefix?: string;
      requireLabelsPresentPrefix?: string;
    };

export interface LaneConfig {
  name: string;
  entityType: EntityType;
  agent: AgentFn;
  firstPass: FirstPassTrigger;
  // Follow-up fires on a human comment while any of these labels is present —
  // the thread is "active" for this lane. Empty for a lane with no reply state.
  awaitingLabels: string[];
  // Optional extra guard so two lanes sharing a status (Specification and
  // Decompose both live inside Evaluation) don't cross-fire on each other's
  // awaiting labels from a differently-statused entity.
  statusRequiredForFollowUp?: string;
}

export interface SwimLaneRoutingConfig {
  agentUserId: string;
  lanes: LaneConfig[];
}

export type RouteDecision =
  | { fire: false; reason: string }
  | {
      fire: true;
      entityId: string;
      entityTitle: string | null;
      pass: Pass;
      agent: AgentFn;
      lane: string;
      entityActor: TrackerActor | null;
    };

export function route(event: TrackerEvent, cfg: SwimLaneRoutingConfig): RouteDecision {
  if (event.kind === "comment_added") {
    if (event.authorId === cfg.agentUserId) {
      return { fire: false, reason: "comment authored by the agent — ignored (self-comment guard)" };
    }
    const lane = cfg.lanes.find(
      (l) =>
        l.entityType === event.entityType &&
        (l.statusRequiredForFollowUp === undefined || l.statusRequiredForFollowUp === event.status) &&
        l.awaitingLabels.some((label) => event.labels.includes(label)),
    );
    if (!lane) {
      return { fire: false, reason: "no lane is awaiting a reply on this entity" };
    }
    return {
      fire: true,
      entityId: event.entityId,
      entityTitle: event.entityTitle,
      pass: "follow-up",
      agent: lane.agent,
      lane: lane.name,
      entityActor: event.actor,
    };
  }

  if (event.kind === "label_added") {
    const lane = cfg.lanes.find((l) => {
      if (l.firstPass.on !== "label_added") return false;
      if (l.entityType !== event.entityType) return false;
      if (!event.addedLabels.includes(l.firstPass.label)) return false;
      if (l.firstPass.statusRequired !== undefined && l.firstPass.statusRequired !== event.status) return false;
      return true;
    });
    if (!lane) {
      return { fire: false, reason: `no lane triggers on labels [${event.addedLabels.join(", ")}]` };
    }
    return {
      fire: true,
      entityId: event.entityId,
      entityTitle: event.entityTitle,
      pass: "first",
      agent: lane.agent,
      lane: lane.name,
      entityActor: event.actor,
    };
  }

  if (event.kind === "status_changed") {
    const lane = cfg.lanes.find((l) => {
      if (l.firstPass.on !== "status_entered") return false;
      if (l.entityType !== event.entityType) return false;
      if (l.firstPass.status !== event.status) return false;
      const requireAbsentPrefix = l.firstPass.requireLabelsAbsentPrefix;
      if (requireAbsentPrefix && event.labels.some((name) => name.startsWith(requireAbsentPrefix))) {
        return false;
      }
      const requirePresentPrefix = l.firstPass.requireLabelsPresentPrefix;
      if (requirePresentPrefix && !event.labels.some((name) => name.startsWith(requirePresentPrefix))) {
        return false;
      }
      return true;
    });
    if (!lane) {
      return { fire: false, reason: `no lane triggers on status "${event.status}"` };
    }
    return {
      fire: true,
      entityId: event.entityId,
      entityTitle: event.entityTitle,
      pass: "first",
      agent: lane.agent,
      lane: lane.name,
      entityActor: event.actor,
    };
  }

  return { fire: false, reason: "unrecognized event kind" };
}
