/**
 * The app's courtesy and failure comments on the pull request — the GitHub
 * half of the small write set `webhook-listener/src/tracker-notifier.ts`
 * already posts to the tracker (CLAUDE.md, Layering: "App (deterministic)").
 *
 * The reviewer lives in the PR, so that is where they have to be told what
 * the pipeline is doing. A revision round announced only in the tracker is a
 * round the person who asked for it never sees, which is the same
 * surface-mismatch that let an architect's questions sit unanswered above a
 * merge for nine days (docs/design-ledger.md, 2026-09-17).
 *
 * **These lines never say what the specialist did.** The app reports that a
 * round ran and how many remain; the specialist posts its own reply, in its
 * own words, in the thread the review was left in. Same layer split as the
 * tracker notifier, which posts "working on it" and never a summary.
 *
 * Deliberately best-effort, like `request-pull-request-reviewer.ts`: a
 * comment that fails to post must not fail a dispatch that is otherwise
 * running fine. Every failure logs and returns, and the workflow tolerates a
 * null comment id.
 */

import { log } from "@temporalio/activity";
import { githubRequest } from "../github-request.js";
import type { WorkerConfig } from "../worker-config.js";
import type { RepoBase } from "./resolve-surfaces.js";

interface GitHubCommentResponse {
  id?: number;
  message?: string;
}

/** The notice wording lives in `workflows/revision-notices.ts` — the workflow composes it, this only delivers it. */
export function createPostPullRequestNoticeActivity(config: WorkerConfig) {
  return async function postPullRequestNotice(repoBase: RepoBase, prNumber: number, body: string): Promise<number | null> {
    const owner = repoBase.org;
    const repo = repoBase.repo;
    try {
      // A PR's conversation comments are issue comments — the `pulls` API is
      // only for review comments, which are anchored to a diff line and are
      // the reviewer's medium, not the app's.
      const result = await githubRequest<GitHubCommentResponse>(
        config.githubToken,
        "POST",
        `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { body: body },
      );
      if (result.status !== 201 || typeof result.json.id !== "number") {
        log.warn(
          `could not post notice on ${owner}/${repo}#${prNumber}: ` +
            `GitHub returned ${result.status} (${result.json.message ?? "no message"})`,
        );
        return null;
      }
      return result.json.id;
    } catch (err) {
      log.warn(`notice post failed for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
}

/**
 * Edits a notice in place rather than deleting it, which is where this
 * diverges from the tracker's progress comment — that one is removed once
 * the agent posts its own. A PR conversation is a review record people
 * scroll back through when deciding to merge, and "round 2 finished, one
 * remaining" is exactly what a reviewer wants to find there later. A comment
 * that vanishes leaves a hole where a round happened.
 */
export function createEditPullRequestNoticeActivity(config: WorkerConfig) {
  return async function editPullRequestNotice(repoBase: RepoBase, commentId: number, body: string): Promise<void> {
    const owner = repoBase.org;
    const repo = repoBase.repo;
    try {
      const result = await githubRequest<GitHubCommentResponse>(
        config.githubToken,
        "PATCH",
        `/repos/${owner}/${repo}/issues/comments/${commentId}`,
        { body: body },
      );
      if (result.status !== 200) {
        log.warn(
          `could not edit notice ${commentId} on ${owner}/${repo}: ` +
            `GitHub returned ${result.status} (${result.json.message ?? "no message"})`,
        );
      }
    } catch (err) {
      log.warn(`notice edit failed for ${owner}/${repo} comment ${commentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
