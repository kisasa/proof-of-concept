/**
 * The workflow: checks dependencies, resolves the target surface's repo
 * base, creates the story branch, dispatches the specialist, waits for it,
 * and checks whether a PR now exists — if so, waits for it to merge or
 * close. Covers the ledger's full "dispatch → wait for the specialist →
 * trigger CI → wait for the result → gate on human review → proceed" chain
 * now; "trigger CI" is a no-op here since it already runs automatically on
 * the PR's own push.
 *
 * No outcome label (removed 2026-08-07 — see `docs/design-ledger.md`): a
 * PR's existence *is* the outcome. The specialist's own comment on the story
 * carries the why when there isn't one (waiting on a dependency, blocked,
 * still thinking, crashed) — the workflow itself only needs to know whether
 * there's a PR to watch, not classify the reason there isn't one yet.
 *
 * Every path that ends without a specialist actively running or a PR left
 * open to watch — dependencies not ready, no PR after the specialist's run,
 * or the catch-all failure below — also moves the story back to To-Do.
 * Confirmed live (2026-08-07): without this, a story could sit in
 * "In Progress" long after its own dispatch had already stopped, and the
 * next move is always the developer's to make, not a workflow's to wait on.
 *
 * Runs in Temporal's deterministic workflow sandbox: no fetch, no AWS SDK, no
 * filesystem here — every real IO call goes through `proxyActivities`, which
 * only imports `interface.ts`'s types, never the real implementations.
 */

import { proxyActivities } from "@temporalio/workflow";
import type { PullRequestWatchResult } from "../activities/await-pull-request-outcome.js";
import type { DispatchActivities } from "../activities/interface.js";
import type { RepoBase } from "../activities/resolve-surfaces.js";
import type { Surface, StoryMover } from "../activities/types.js";
import { describeFailure } from "./describe-failure.js";
import {
  reviewerUnmatchedNotice,
  revisionRoundFailedNotice,
  revisionRoundFinishedNotice,
  revisionRoundStartedNotice,
  revisionRoundsExhaustedNotice,
} from "./revision-notices.js";

/**
 * How many times a reviewer-of-record can send the specialist back around on
 * one PR. Chosen by the architect (2026-09-19), and a diagnostic more than a
 * cost guard: every round needs a human to sit down and submit a review
 * first, so the loop cannot run away on its own. Reaching the cap is
 * evidence the *story* was mis-shaped rather than the code being wrong —
 * the same reading the size band takes of an over-band decomposition.
 *
 * Changing either constant changes workflow control flow, so an in-flight
 * execution replayed against a new value would diverge. Treat a change as a
 * versioned one (`patched()`) if any dispatch is live.
 */
const REVISION_ROUND_CAP = 3;

/**
 * Deliberately unrelated to `resolveMaxTurns`'s tier/size budget for the
 * initial build. It is a scope fence: feedback that cannot be applied inside
 * it was not a review comment, it was a story change, and the specialist is
 * told to say so up front rather than half-apply it.
 */
const REVISION_MAX_TURNS = 25;

// Domain-specific reason for a non-default retry policy (the SDK default is
// generous — up to 100 attempts): these six all call external, rate-limited
// APIs (Linear, GitHub, AWS ECS). A persistent failure after 3 attempts
// should surface as a failed workflow rather than hammer those APIs for
// the better part of a day. Permanent errors (an unsupported host, a
// missing surface record) skip retries entirely — see each activity's own use of
// `ApplicationFailure.nonRetryable`.
const {
  checkDependencies,
  resolveSurfaces,
  createStoryBranch,
  dispatchSpecialist,
  postSpecialistStarted,
  deleteSpecialistProgressComment,
  findPullRequest,
  requestPullRequestReviewer,
  postPullRequestNotice,
  editPullRequestNotice,
  postDispatchFailed,
  moveStoryToTodo,
} = proxyActivities<DispatchActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

// A specialist run can take a long time — the ledger's own "maxTurns is set
// ... since sessions do not time out on their own" applies here too, one
// level up: this activity has to be allowed to run at least that long, and
// it heartbeats every poll so Temporal doesn't mistake a long-but-alive run
// for a hung one.
const { awaitSpecialistTask } = proxyActivities<DispatchActivities>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "1 minute",
});

// A PR can sit unreviewed for days — a much longer ceiling than the
// specialist's own run, and its own separate proxyActivities call for the
// same reason: a different activity, a different realistic wait.
const { awaitPullRequestOutcome } = proxyActivities<DispatchActivities>({
  startToCloseTimeout: "14 days",
  heartbeatTimeout: "5 minutes",
});

export interface DispatchStoryWorkflowInput {
  readonly storyId: string;
  readonly storyTitle: string;
  readonly epicId: string;
  readonly surfaces: Surface[];
  readonly storyBranch: string;
  readonly epicBranch: string;
  readonly maxTurns: number;
  /** Whoever moved this story to In-Process — reviewer-of-record. Null if the triggering webhook carried no resolvable actor. */
  readonly mover: StoryMover | null;
}

export interface DispatchStoryWorkflowResult {
  readonly outcome: "not-ready" | "no-pr" | "complete";
  /** Only set when `outcome` is "not-ready" — the blocking dependencies that aren't Done yet. */
  readonly blockedBy?: string[];
  /** Only set when `outcome` is "complete" — the PR this story's dispatch was watching. */
  readonly pullRequest?: { readonly number: number; readonly url: string; readonly merged: boolean };
}

export async function dispatchStoryWorkflow(input: DispatchStoryWorkflowInput): Promise<DispatchStoryWorkflowResult> {
  // Held outside the try so the catch-all can reach the PR: once one exists,
  // the person waiting on a failed revision round is reading the PR, not the
  // tracker, and silence there is the failure this whole path exists to
  // avoid. Null until the specialist has actually opened one.
  let openPullRequest: { readonly number: number; readonly url: string; readonly repoBase: RepoBase } | null = null;
  let revisionRound = 0;

  try {
    const dependencyCheck = await checkDependencies(input.storyId);
    if (!dependencyCheck.ready) {
      await moveStoryToTodo(input.storyId);
      return { outcome: "not-ready", blockedBy: dependencyCheck.blockedBy };
    }

    const target = await resolveSurfaces(input.epicId, input.surfaces);
    const repoBase = target.repoBase;

    await createStoryBranch({
      repoBase: repoBase,
      epicBranch: input.epicBranch,
      storyBranch: input.storyBranch,
    });

    const taskArn = await dispatchSpecialist({
      storyId: input.storyId,
      storyTitle: input.storyTitle,
      epicId: input.epicId,
      surfaces: input.surfaces,
      repoBase: repoBase,
      surfacePaths: target.surfaces.map((s) => s.path),
      surfaceSkills: [...new Set(target.surfaces.flatMap((s) => s.skills))],
      storyBranch: input.storyBranch,
      epicBranch: input.epicBranch,
      maxTurns: input.maxTurns,
    });

    const progressCommentId = await postSpecialistStarted(input.storyId);
    await awaitSpecialistTask(taskArn, progressCommentId);
    if (progressCommentId) {
      await deleteSpecialistProgressComment(progressCommentId);
    }

    const pr = await findPullRequest(repoBase, input.storyBranch, input.epicBranch);
    if (!pr) {
      // No PR yet, for whatever reason (waiting on a dependency, blocked,
      // still thinking, crashed) — the specialist's own comment on the
      // story already says why. Nothing is actively running anymore, so
      // hand the next move back to a developer rather than leaving the
      // board showing "In Progress" for a dispatch that's already stopped.
      await moveStoryToTodo(input.storyId);
      return { outcome: "no-pr" };
    }

    openPullRequest = { number: pr.number, url: pr.url, repoBase: repoBase };

    const reviewerLogin = await requestPullRequestReviewer(repoBase, pr.number, input.mover);
    if (!reviewerLogin) {
      // Said once, now, rather than discovered later by a developer whose
      // "request changes" review went nowhere. A missing mapping entry used
      // to be purely cosmetic; keying revision rounds on it made it
      // load-bearing, and an unmapped reviewer silently disables them.
      await postPullRequestNotice(repoBase, pr.number, reviewerUnmatchedNotice(input.mover ? input.mover.name : null));
    }

    // Watermark, not review state. A "changes requested" decision persists
    // until the reviewer clears it themselves, so triggering on the state
    // would re-fire every poll; only a review newer than the last one acted
    // on counts. See `await-pull-request-outcome.ts`.
    let afterReviewId: number | null = null;

    for (;;) {
      const watch: PullRequestWatchResult = await awaitPullRequestOutcome({
        storyId: input.storyId,
        repoBase: repoBase,
        prNumber: pr.number,
        prUrl: pr.url,
        reviewerLogin: reviewerLogin,
        afterReviewId: afterReviewId,
        watchForChangeRequests: revisionRound < REVISION_ROUND_CAP,
      });

      if (watch.outcome === "merged") {
        return {
          outcome: "complete",
          pullRequest: { number: pr.number, url: pr.url, merged: true },
        };
      }

      if (watch.outcome === "closed") {
        // Nothing is running and nothing is left to watch, which is the
        // condition that retreats a story to the gate a human has to re-open
        // anyway. A closed PR is also where the specialist's "close it,
        // reshape the story, run it again" recommendation lands, and that
        // re-run starts from To-Do.
        await moveStoryToTodo(input.storyId);
        return {
          outcome: "complete",
          pullRequest: { number: pr.number, url: pr.url, merged: false },
        };
      }

      revisionRound += 1;
      afterReviewId = watch.changeRequest.reviewId;

      const noticeId = await postPullRequestNotice(
        repoBase,
        pr.number,
        revisionRoundStartedNotice(revisionRound, REVISION_ROUND_CAP),
      );

      const revisionTaskArn = await dispatchSpecialist({
        storyId: input.storyId,
        storyTitle: input.storyTitle,
        epicId: input.epicId,
        surfaces: input.surfaces,
        repoBase: repoBase,
        surfacePaths: target.surfaces.map((s) => s.path),
        surfaceSkills: [...new Set(target.surfaces.flatMap((s) => s.skills))],
        storyBranch: input.storyBranch,
        epicBranch: input.epicBranch,
        maxTurns: REVISION_MAX_TURNS,
        revision: {
          round: revisionRound,
          roundCap: REVISION_ROUND_CAP,
          pullRequestNumber: pr.number,
          reviewId: watch.changeRequest.reviewId,
        },
      });

      const revisionProgressCommentId = await postSpecialistStarted(input.storyId);
      await awaitSpecialistTask(revisionTaskArn, revisionProgressCommentId);
      if (revisionProgressCommentId) {
        await deleteSpecialistProgressComment(revisionProgressCommentId);
      }

      if (noticeId !== null) {
        await editPullRequestNotice(repoBase, noticeId, revisionRoundFinishedNotice(revisionRound, REVISION_ROUND_CAP));
      }

      if (revisionRound >= REVISION_ROUND_CAP) {
        await postPullRequestNotice(repoBase, pr.number, revisionRoundsExhaustedNotice(REVISION_ROUND_CAP));
      }
      // Round done; back to watching. With the cap spent the next watch can
      // only end in merged or closed, so this never spins.
    }
  } catch (err) {
    // Posted, then re-thrown — Temporal still records the workflow itself
    // as Failed (the durable, queryable source of truth); the comment is
    // this tier's own equivalent of the shaping tier's fail-fast comment,
    // so a human watching the tracker (not Temporal) also finds out.
    const failure = describeFailure(err);
    await postDispatchFailed(input.storyId, failure);
    // Only a failed *revision* round gets a PR notice. A first-build failure
    // has no PR yet, and one that fails after a clean build but before any
    // revision has nothing on the PR to correct.
    if (openPullRequest && revisionRound > 0) {
      await postPullRequestNotice(
        openPullRequest.repoBase,
        openPullRequest.number,
        revisionRoundFailedNotice(revisionRound, REVISION_ROUND_CAP, failure),
      );
    }
    await moveStoryToTodo(input.storyId);
    throw err;
  }
}
