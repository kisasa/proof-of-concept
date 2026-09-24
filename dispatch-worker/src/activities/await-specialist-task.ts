/**
 * Long-running activity: polls the specialist's ECS task until it stops.
 * Heartbeats every poll so Temporal knows this activity is alive rather than
 * hung — a specialist run can take many minutes (the ledger's own
 * `maxTurns`/no-timeout language), so a plain single-call activity with a
 * short default timeout is the wrong shape here.
 *
 * Only tells you the container exited, and returns on STOPPED whatever the
 * exit code was. Nothing in the worker reads the specialist's own
 * complete/waiting/blocked outcome — an earlier version of this comment
 * pointed at a `read-specialist-outcome.ts` that was never built. The
 * workflow infers what it needs from the world instead: whether a PR now
 * exists, and later whether it merged. The specialist's own comment on the
 * story carries the why, posted through its Linear MCP calls (or
 * `specialist-runner`'s tracker-fallback path, on a startup failure).
 */

import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { heartbeat, sleep } from "@temporalio/activity";
import type { WorkerConfig } from "../worker-config.js";
import { createUpdateSpecialistProgress, pickPatienceQuip } from "./specialist-progress.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
// Matches webhook-listener/src/activation-config.ts's own
// progressUpdateIntervalMs — the shaping tier's cadence for the same kind of
// courtesy edit. Independent of pollIntervalMs (ECS liveness is checked far
// more often than the Linear comment needs touching).
const DEFAULT_PROGRESS_UPDATE_INTERVAL_MS = 2 * 60_000;

export type DescribeTaskStatus = (taskArn: string) => Promise<string | undefined>;
export type UpdateProgress = (elapsedMs: number) => Promise<void>;

/**
 * The pure polling loop, taking its ECS lookup as an injected function rather
 * than constructing a client itself — same "explicit parameter, not read
 * internally" discipline as `create-story-branch.ts` taking `githubToken`.
 * This is what makes it testable with `@temporalio/testing`'s
 * `MockActivityEnvironment`: `heartbeat()`/`sleep()` need a real Activity
 * Context to do anything meaningful (heartbeat emits an event only that
 * environment provides; `sleep()` is cancellation-aware and needs a `Context`
 * to reject through), which only exists when this runs inside `env.run(...)`
 * or inside a real Worker — never in a plain unit test that calls it
 * directly.
 *
 * `updateProgress` is optional (null when there's no progress comment to
 * keep current — e.g. `postSpecialistStarted` itself failed) and is called
 * on its own cadence, separate from `pollIntervalMs`: touching the Linear
 * comment every 15s would be needless API traffic and noise, so it only
 * fires once `progressUpdateIntervalMs` has actually elapsed since the last
 * edit, checked on top of the existing ECS poll rather than a second timer.
 */
export async function awaitSpecialistTask(
  taskArn: string,
  describeTaskStatus: DescribeTaskStatus,
  updateProgress: UpdateProgress | null = null,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  progressUpdateIntervalMs: number = DEFAULT_PROGRESS_UPDATE_INTERVAL_MS,
): Promise<void> {
  const startedAt = Date.now();
  let lastProgressUpdateAt = startedAt;

  for (;;) {
    const status = await describeTaskStatus(taskArn);

    if (status === "STOPPED") {
      return;
    }

    heartbeat(status ?? "unknown");

    if (updateProgress) {
      const now = Date.now();
      if (now - lastProgressUpdateAt >= progressUpdateIntervalMs) {
        await updateProgress(now - startedAt);
        lastProgressUpdateAt = now;
      }
    }

    await sleep(pollIntervalMs);
  }
}

export function createAwaitSpecialistTaskActivity(config: WorkerConfig) {
  const client = new ECSClient({});

  const describeTaskStatus: DescribeTaskStatus = async (taskArn) => {
    const result = await client.send(
      new DescribeTasksCommand({ cluster: config.specialistClusterArn, tasks: [taskArn] }),
    );
    return result.tasks?.[0]?.lastStatus;
  };

  const updateSpecialistProgress = createUpdateSpecialistProgress(config);

  return (taskArn: string, progressCommentId: string | null) => {
    // Picked once per activity invocation (once per dispatch), not per poll —
    // same "repeats the same line rather than shuffling" intent as
    // tracker-notifier.ts's own quip, just picked here instead of in the
    // workflow (which can't call Math.random()). See specialist-progress.ts's
    // own note on why this doesn't match postSpecialistStarted's quip.
    const quip = pickPatienceQuip();
    const updateProgress: UpdateProgress | null = progressCommentId
      ? (elapsedMs) => updateSpecialistProgress(progressCommentId, elapsedMs, quip)
      : null;
    return awaitSpecialistTask(taskArn, describeTaskStatus, updateProgress);
  };
}
