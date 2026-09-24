/**
 * The specialist-dispatch lane's `agent` function — not an Anthropic
 * activation (no `createActivationRunner` here), a Temporal workflow start.
 * Satisfies `AgentFn`'s signature so it registers into `swim-lanes.ts` like
 * any other lane (see `swim-lane-routing.ts`'s own claim: "adding a lane is a
 * registration, not a rearchitecture").
 *
 * What this does NOT do: re-run the dependency check. `checkDependencies`
 * already runs as `dispatchStoryWorkflow`'s own first activity and already
 * posts its own "Dispatch blocked" comment on failure
 * (`dispatch-worker/src/activities/check-dependencies.ts`, already built and
 * tested) — this trigger's only job is gathering input and starting the
 * workflow.
 *
 * Reviewer-of-record: `actor` is the webhook's own TrackerActor for this
 * status move — confirmed against live payloads 2026-08-06 that Linear
 * carries it uniformly, including for status_changed (docs/design-ledger.md,
 * "reviewer-of-record"). Passed into the workflow as `mover`; dispatch-worker
 * resolves it to a GitHub login via its own static mapping and requests them
 * as a reviewer once the specialist's PR is found. `actor` can be null in
 * principle (a malformed or partial webhook) — the workflow input just
 * carries that through; dispatch-worker's activity treats a null mover as
 * "nothing to request," not an error.
 */

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { Client } from "@temporalio/client";
import { createLogger } from "./logger.js";
import type { AgentFn, TrackerActor } from "./tracker-event.js";
import { moveStoryToTodo } from "./move-story-to-todo.js";
import { fetchStoryDispatchContext, type Surface, type Tier, type Size } from "./story-context.js";
import trackerNotifier from "./tracker-notifier.js";

const log = createLogger("dispatch-trigger");

// Temporal resolves a workflow by its registered type name — a plain string,
// not an imported function reference. dispatch-worker and webhook-listener
// are separate npm packages with no shared lib (this repo's existing
// pattern), so the name and input shape below are deliberately mirrored, not
// imported, from dispatch-worker/src/workflows/dispatch-story-workflow.ts.
const WORKFLOW_TYPE = "dispatchStoryWorkflow";

/**
 * Sizes the specialist's turn budget from two labels, not one flat number.
 * Replaces the old flat `DEFAULT_MAX_TURNS = 80` applied to every dispatch
 * regardless of scope — confirmed live (2026-08-10) that a single
 * flat number doesn't fit every story: an e2e story enumerating several flow
 * scenarios plus a cross-surface consistency check hit the 80-turn ceiling
 * and got bounced back to To-Do.
 *
 * A tier-only lookup was the first cut, then a live story disproved it: the
 * story was `tier:small` (per story-contract.md, tier is "which execution
 * tier — model class — runs the specialist," i.e. architectural weight) but
 * `size:medium` ("relative effort within this epic," i.e. volume of work) —
 * the two axes measure different things and don't move together.
 *
 * BASE_MAX_TURNS is the floor a story with neither label (or an unrecognized
 * value on both) gets — same number the old flat default used, not a new
 * number pulled from nowhere. Each label independently multiplies that floor;
 * a story elevated on both axes compounds rather than being capped at
 * whichever axis is worse, since tier and size are read as genuinely
 * independent cost signals, not two votes on one "difficulty" score. That story
 * (`tier:small` × `size:medium` → 1 × 2) would have gotten 160 turns instead
 * of 80. Not a claim these specific multipliers are correct forever — a
 * story that still runs out at its combined budget is real information (the
 * work needs more room, or Decompose under-labeled it on one or both axes),
 * not a bug in this table.
 */
const BASE_MAX_TURNS = 80;

const TIER_MULTIPLIER: Record<Tier, number> = {
  small: 1,
  mid: 2,
  large: 4,
};

const SIZE_MULTIPLIER: Record<Size, number> = {
  small: 1,
  medium: 2,
  large: 4,
};

/**
 * Exported for direct testing, same reason parseSurfaces/parseTier/parseSize
 * are pure functions in story-context.ts rather than inlined: it's the actual
 * decision, not IO. A missing or unrecognized label contributes a neutral 1×
 * rather than blocking the calculation, so a story with neither label lands
 * exactly on BASE_MAX_TURNS.
 */
export function resolveMaxTurns(tier: Tier | null, size: Size | null): number {
  const tierMultiplier = tier ? TIER_MULTIPLIER[tier] : 1;
  const sizeMultiplier = size ? SIZE_MULTIPLIER[size] : 1;
  return BASE_MAX_TURNS * tierMultiplier * sizeMultiplier;
}

interface DispatchStoryWorkflowInput {
  readonly storyId: string;
  readonly storyTitle: string;
  readonly epicId: string;
  readonly surfaces: Surface[];
  readonly storyBranch: string;
  readonly epicBranch: string;
  readonly maxTurns: number;
  readonly mover: TrackerActor | null;
}

export interface DispatchTriggerConfig {
  readonly linearAgentApiKey: string;
  readonly linearApiUrl: string;
  readonly getClient: () => Promise<Client>;
  readonly taskQueue: () => string;
  readonly maxTurns?: number;
}

export function createDispatchTrigger(config: DispatchTriggerConfig): AgentFn {
  return async function dispatchTrigger(
    entityId: string,
    _pass,
    entityTitle: string | null,
    traceId: string,
    actor: TrackerActor | null,
  ) {
    const reqLog = log.child(traceId);
    reqLog.trace(`specialist-dispatch: gathering context for story ${entityId}`);

    const contextResult = await fetchStoryDispatchContext(entityId, config.linearAgentApiKey, config.linearApiUrl, traceId);
    if (!contextResult.ok) {
      reqLog.warn(`specialist-dispatch: story ${entityId} is not dispatchable — ${contextResult.reason}`);
      await trackerNotifier.postErrorComment(
        entityId,
        "issue",
        traceId,
        `This story could not be dispatched: ${contextResult.reason}.`,
      );
      // No workflow ever started, so dispatch-worker's own moveStoryToTodo
      // activity never gets a chance to run — this failure happens entirely
      // before that. Without this, the story is left in In Progress with
      // only an error comment and nothing dispatched (confirmed live
      // 2026-08-07).
      await moveStoryToTodo(entityId, config.linearAgentApiKey, config.linearApiUrl, traceId);
      return;
    }

    const { tier, size } = contextResult.context;
    const maxTurns = config.maxTurns ?? resolveMaxTurns(tier, size);
    reqLog.trace(`specialist-dispatch: story ${entityId} tier=${tier ?? "(none)"} size=${size ?? "(none)"} maxTurns=${maxTurns}`);

    const input: DispatchStoryWorkflowInput = {
      storyId: contextResult.context.storyId,
      storyTitle: entityTitle ?? "(untitled)",
      epicId: contextResult.context.epicId,
      surfaces: contextResult.context.surfaces,
      storyBranch: contextResult.context.storyBranch,
      epicBranch: contextResult.context.epicBranch,
      maxTurns: maxTurns,
      mover: actor,
    };

    try {
      const client = await config.getClient();
      const handle = await client.workflow.start(WORKFLOW_TYPE, {
        workflowId: `dispatch-${entityId}`,
        taskQueue: config.taskQueue(),
        args: [input],
      });
      reqLog.info(`specialist-dispatch: started ${WORKFLOW_TYPE} for story ${entityId}, workflowId=${handle.workflowId}`);
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        // Benign — a duplicate webhook delivery or a story bounced back and
        // forth into In-Process again while its dispatch is still running.
        // Not a failure worth a tracker comment.
        reqLog.trace(`specialist-dispatch: a dispatch workflow for story ${entityId} is already running — no-op`);
        return;
      }
      reqLog.error(`specialist-dispatch: failed to start ${WORKFLOW_TYPE} for story ${entityId}:`, err);
      await trackerNotifier.postErrorComment(
        entityId,
        "issue",
        traceId,
        `Dispatch could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      await moveStoryToTodo(entityId, config.linearAgentApiKey, config.linearApiUrl, traceId);
    }
  };
}
