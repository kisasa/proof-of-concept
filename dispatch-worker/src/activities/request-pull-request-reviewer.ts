/**
 * Reviewer-of-record — the property that preserves "the person who reviews
 * decides when it gets written" under app-driven dispatch (CLAUDE.md, Agent
 * Roster). The story's mover is confirmed, live, to be exactly who the
 * webhook's own `actor` names for the status change that dispatched this
 * workflow (docs/design-ledger.md, "reviewer-of-record") — this activity's
 * only job is turning that identity into a GitHub reviewer request on the
 * specialist's PR, once one exists.
 *
 * Deliberately best-effort, unlike every other activity in this package: a
 * missing mapping entry, an unknown GitHub login, or a transient GitHub
 * error here must never fail a dispatch that otherwise succeeded — the PR
 * already exists and a human is already going to review it regardless of
 * whether this metadata landed. So this never throws; every failure mode
 * logs through Temporal's own activity log and returns.
 */

import { log } from "@temporalio/activity";
import { githubRequest } from "../github-request.js";
import type { WorkerConfig } from "../worker-config.js";
import type { RepoBase } from "./resolve-surfaces.js";
import type { StoryMover } from "./types.js";

/**
 * The decision of whether/whom to request is pure and tested directly, same
 * "parse/select is pure and tested, the IO wrapper isn't" split as
 * `find-pull-request.ts`'s own `pickPullRequest`.
 */
export function resolveReviewerLogin(mover: StoryMover | null, mapping: Map<string, string>): string | null {
  if (!mover) return null;
  return mapping.get(mover.email) ?? null;
}

export function createRequestPullRequestReviewerActivity(config: WorkerConfig) {
  return async function requestPullRequestReviewer(repoBase: RepoBase, prNumber: number, mover: StoryMover | null): Promise<string | null> {
    if (!mover) {
      log.debug("no story-mover identity on this dispatch — skipping reviewer-of-record request");
      return null;
    }

    const login = resolveReviewerLogin(mover, config.reviewerEmailToGithubLogin);
    if (!login) {
      log.warn(
        `no GitHub login mapped for reviewer-of-record "${mover.name}" <${mover.email}> — ` +
          `add it to REVIEWER_EMAIL_TO_GITHUB_LOGIN to request them automatically. Skipping.`,
      );
      return null;
    }

    const owner = repoBase.org;
    const repo = repoBase.repo;
    try {
      const result = await githubRequest<{ message?: string }>(
        config.githubToken,
        "POST",
        `/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
        { reviewers: [login] },
      );
      if (result.status !== 201) {
        log.warn(
          `could not request "${login}" as reviewer on ${owner}/${repo}#${prNumber}: ` +
            `GitHub returned ${result.status} (${result.json.message ?? "no message"})`,
        );
      } else {
        log.info(`requested "${login}" (reviewer-of-record, ${mover.email}) on ${owner}/${repo}#${prNumber}`);
      }
    } catch (err) {
      log.warn(`reviewer-of-record request failed for ${owner}/${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // The login is returned even when the request itself failed: the review
    // request is cosmetic, but matching this person's later reviews is not —
    // revision rounds key on it, and a reviewer who was never formally
    // requested can still submit one.
    return login;
  };
}
