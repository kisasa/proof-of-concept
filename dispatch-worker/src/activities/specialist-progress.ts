/**
 * The shaping tier's own courtesy comment (webhook-listener/src/
 * tracker-notifier.ts), extended to the specialist tier: a "working on
 * this" comment posted right after the specialist container starts, edited
 * in place every couple of minutes with an elapsed-time line while
 * `awaitSpecialistTask` polls, and deleted once the container exits cleanly
 * (the specialist's own completion report already narrates what happened by
 * then — a "still going" line left behind reads as stuck). Without this, a
 * story could sit In Progress for up to four hours with nothing visible on
 * the tracker until the specialist's own report landed, a startup crash
 * posted a fallback comment, or nothing happened at all.
 *
 * Same fire-and-forget discipline as tracker-notifier.ts and
 * request-pull-request-reviewer.ts in this package: none of these ever
 * throw. A failure to post/update/delete this courtesy comment must never
 * fail a dispatch that is otherwise proceeding correctly — logged through
 * `@temporalio/activity`'s own log and swallowed.
 *
 * One real difference from tracker-notifier.ts, forced by Temporal's own
 * determinism rules: tracker-notifier picks one quip per activation and
 * reuses it for every comment in that run because a single function call
 * (activation-runner.ts) holds it in one closure. Here, posting the started
 * comment and polling for progress are two separate Temporal activities with
 * no shared closure, and the workflow itself can't call Math.random() (workflow
 * code must replay deterministically). So each side picks its own quip once —
 * the started comment gets one, and every progress edit within one
 * `awaitSpecialistTask` call reuses a second, separately-picked one — rather
 * than threading one value through the workflow for a cosmetic match.
 */

import { log } from "@temporalio/activity";
import { postComment, updateComment, deleteComment, linearApiUrl } from "../tracker.js";
import type { WorkerConfig } from "../worker-config.js";

const PATIENCE_QUIPS = [
  "Good things take time — this is one of those things.",
  "Tests don't write themselves, but they're close.",
  "A clean diff is worth the wait.",
  "Slow is smooth, smooth is fast.",
  "Even a paused container is still making progress.",
  "Reading the conventions spec, not skimming it.",
  "Criteria don't trace themselves.",
  "Running the suite that was already here, not just the new one.",
  "Reading the branch before writing to it.",
  "The boring part is the part that catches things.",
  "Every criterion gets a line — the empty ones too.",
];

export function pickPatienceQuip(): string {
  return PATIENCE_QUIPS[Math.floor(Math.random() * PATIENCE_QUIPS.length)] ?? "Good things take time.";
}

export function specialistStartedBody(quip: string): string {
  return (
    `**The specialist is working on this** _(automated)_\n\n` +
    `A specialist container has been dispatched to implement this story — this can take a while. No action ` +
    `needed yet. I'll leave an error comment if the dispatch itself fails; otherwise the specialist's own ` +
    `completion report will land here when it's done.\n\n` +
    `_${quip}_`
  );
}

export function specialistProgressBody(elapsedMs: number, quip: string): string {
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  return (
    `**The specialist is working on this** _(automated)_\n\n` +
    `A specialist container has been dispatched to implement this story — this can take a while. No action ` +
    `needed yet. I'll leave an error comment if the dispatch itself fails; otherwise the specialist's own ` +
    `completion report will land here when it's done.\n\n` +
    `_Still going — ${elapsedMinutes}m elapsed, connection active._\n\n` +
    `_${quip}_`
  );
}

export function createPostSpecialistStartedActivity(config: WorkerConfig) {
  return async function postSpecialistStarted(storyId: string): Promise<string | null> {
    try {
      return await postComment(storyId, config.linearAgentApiKey, linearApiUrl(), specialistStartedBody(pickPatienceQuip()));
    } catch (err) {
      log.warn(`failed to post specialist-started comment for ${storyId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
}

/**
 * Not a Temporal activity itself — called from inside `awaitSpecialistTask`'s
 * own long-running activity, on its existing poll loop, rather than as a
 * separate activity invocation per edit (the workflow can't drive its own
 * timer between activity calls the way a plain poll loop can).
 */
export function createUpdateSpecialistProgress(config: WorkerConfig) {
  return async function updateSpecialistProgress(commentId: string, elapsedMs: number, quip: string): Promise<void> {
    try {
      await updateComment(commentId, config.linearAgentApiKey, linearApiUrl(), specialistProgressBody(elapsedMs, quip));
    } catch (err) {
      log.warn(`failed to update specialist-progress comment ${commentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function createDeleteSpecialistProgressActivity(config: WorkerConfig) {
  return async function deleteSpecialistProgressComment(commentId: string): Promise<void> {
    try {
      await deleteComment(commentId, config.linearAgentApiKey, linearApiUrl());
    } catch (err) {
      log.warn(`failed to delete specialist-progress comment ${commentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
