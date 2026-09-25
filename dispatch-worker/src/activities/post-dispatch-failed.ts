/**
 * The development tier's own "never silent" guarantee, mirroring the
 * shaping tier's fail-fast error comment (webhook-listener/src/
 * tracker-notifier.ts's postErrorComment) and the ledger's own stated
 * principle: "an agent's turn is not complete until the tracker shows what
 * happened. Silence is the one unacceptable outcome."
 *
 * Before this, individual activities each decided for themselves whether to
 * post a comment on failure — the surface resolver and find-pull-request.ts
 * did, for the one failure mode each anticipated; createStoryBranch,
 * dispatchSpecialist, and everything else didn't. Confirmed live
 * (2026-08-06): a real dispatch failed on a GitHub 404 nobody had written a
 * comment for, and the only way to find out was querying Temporal directly.
 * Centralized here instead: `dispatchStoryWorkflow` wraps its own body in one
 * try/catch and calls this once, in one place, covering every failure path —
 * anticipated or not — rather than requiring every current and future
 * activity to remember to post its own.
 */

import { log } from "@temporalio/activity";
import { postComment, linearApiUrl } from "../tracker.js";
import type { WorkerConfig } from "../worker-config.js";

export function createPostDispatchFailedActivity(config: WorkerConfig) {
  return async function postDispatchFailed(storyId: string, message: string): Promise<void> {
    const body =
      `**Dispatch failed** _(automated)_\n\n` +
      `This story's dispatch did not complete.\n\n**Error:** ${message}\n\n` +
      `Check the dispatch-worker logs (or the Temporal UI) for the full history. This story is being moved ` +
      `back to To-Do — once resolved, forward it to In Progress again to retry.`;

    // Unlike reviewer-of-record and the specialist-progress comment, this is
    // the one thing standing between a failed dispatch and true silence —
    // but it still can't throw past the workflow's own catch (that would
    // mask the real failure with a secondary one), so a failure to post is
    // logged and swallowed, same as every other courtesy write here.
    try {
      await postComment(storyId, config.linearAgentApiKey, linearApiUrl(), body);
    } catch (err) {
      log.error(`failed to post dispatch-failed comment for ${storyId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
