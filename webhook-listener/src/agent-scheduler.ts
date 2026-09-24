/**
 * Controls when agents run, not what they do. Two scheduling concerns:
 *
 * Dedupe — Most trackers retry webhook delivery on timeout or error. A stable key
 *   built from the event's own fields (not a delivery id) prevents the same event
 *   from firing an agent twice.
 *
 * Debounce — A human answering the agent's questions often sends several comments in
 *   quick succession. Coalescing them into one run avoids redundant work and gives the
 *   agent the full context of all answers at once rather than reacting to each comment
 *   in isolation.
 *
 * All state is in-memory — a deliberate v1 choice. One instance, no infrastructure
 * dependency, easy to reason about. When you need multi-instance or crash-survival,
 * back these maps with a database. The function signatures don't change.
 */

import type { AgentFn, TrackerActor } from "./tracker-event.js";
import { createLogger } from "./logger.js";

const log = createLogger("scheduler");

export interface AgentSchedulerConfig {
  debounceMs: number;
}

// Webhook deliveries can repeat (Linear retries). Dedupe on a stable key.
const seenEvents = new Set<string>();
// One pending debounce timer per entity, so a burst of comments fires once.
// traceId is the most recent call's — read back when a later call supersedes
// this timer, so the trace log shows which delivery's follow-up won.
const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; traceId: string }>();

export function alreadySeen(eventKey: string): boolean {
  if (seenEvents.has(eventKey)) return true;
  seenEvents.add(eventKey);
  // Bound the set so a long-lived process doesn't grow without limit.
  if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value as string);
  return false;
}

export function makeDispatcher(cfg: AgentSchedulerConfig) {
  // The first pass fires immediately; follow-ups debounce so several answers in a
  // row become one run. The agent is passed per call, so different lanes can use
  // different agents without reconfiguring the dispatcher.
  return function dispatch(
    entityId: string,
    pass: "first" | "follow-up",
    entityTitle: string | null,
    traceId: string,
    actor: TrackerActor | null,
    agent: AgentFn,
  ): void {
    const reqLog = log.child(traceId);

    if (pass === "first") {
      reqLog.trace(`first pass — firing immediately, entity=${entityId}`);
      void agent(entityId, pass, entityTitle, traceId, actor);
      return;
    }

    const existing = timers.get(entityId);
    if (existing) {
      reqLog.trace(`follow-up — superseding pending timer from trace ${existing.traceId}, entity=${entityId}`);
      clearTimeout(existing.timer);
    } else {
      reqLog.trace(`follow-up — starting a ${cfg.debounceMs}ms debounce timer, entity=${entityId}`);
    }

    timers.set(entityId, {
      timer: setTimeout(() => {
        timers.delete(entityId);
        reqLog.trace(`debounce elapsed — firing now, entity=${entityId}`);
        void agent(entityId, pass, entityTitle, traceId, actor);
      }, cfg.debounceMs),
      traceId: traceId,
    });
  };
}
