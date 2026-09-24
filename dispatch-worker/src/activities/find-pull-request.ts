/**
 * Checks whether the specialist opened its PR — mechanically, via GitHub's
 * own head/base filter, not by parsing the specialist's free-prose "PR &
 * branch" completion-report line (the same class of problem
 * `story-contract.md`/`specification-agent.md` already solved twice by
 * tightening a recording *format*), and not via any outcome label either
 * (removed 2026-08-07 — see `docs/design-ledger.md`; the comment is the
 * only record now). The workflow already knows the exact story/epic branch
 * names before it ever dispatches the specialist, so it can just ask GitHub
 * directly.
 *
 * A PR's existence *is* the outcome, not a follow-up check on a claimed one:
 * returns `null` rather than throwing when none is found, since that's now
 * the ordinary "didn't finish this run" case (waiting on a dependency,
 * blocked, still thinking, crashed) — the specialist's own comment carries
 * the why; this activity only needs to know whether there's a PR to watch.
 *
 * Checks `open` first, then falls back to the most recent `closed` PR for
 * the same head/base pair and trusts it only if it was actually merged.
 * Confirmed live (2026-08-07): querying `state=open` alone lost a
 * genuine race — a reviewer merged the specialist's PR within ~40 seconds of it
 * opening, faster than this activity's own next check, which then found
 * zero open PRs and told the workflow "no-pr," moving a story that had
 * already succeeded back to Todo with no comment explaining why (the
 * specialist's own "Complete" comment already existed, and this path
 * doesn't post one of its own). A merge is permanent, unambiguous truth
 * once it happens — checking `closed` and trusting a merged result doesn't
 * risk resurrecting a stale PR from an earlier, unrelated attempt, since
 * only the single *most recent* closed PR for this exact pair is consulted:
 * if the latest attempt closed without merging, that's still correctly
 * "no-pr," same as before.
 */

import { ApplicationFailure } from "@temporalio/activity";
import { githubRequest, isClientError } from "../github-request.js";
import type { WorkerConfig } from "../worker-config.js";
import type { RepoBase } from "./resolve-surfaces.js";

export interface PullRequestReference {
  readonly number: number;
  readonly url: string;
}

interface GitHubPullRequestListItem {
  number: number;
  html_url: string;
  merged_at: string | null;
}

/**
 * GitHub's own head/base/state query params already narrow the result set —
 * this just picks the first (there should be at most one open PR for a given
 * head+base pair, and the closed-list caller sorts newest-first). Pure and
 * tested directly, unlike the fetch call around it (same "parse/select is
 * pure and tested, the IO wrapper isn't" split as
 * `resolveSurfaces`/`parseBlockingDependencyIds`).
 */
export function pickPullRequest(candidates: GitHubPullRequestListItem[]): PullRequestReference | null {
  const first = candidates[0];
  return first ? { number: first.number, url: first.html_url } : null;
}

/** Only trusts the single most recent closed PR — an older, unrelated closed-without-merging attempt must not shadow it. */
export function pickMergedPullRequest(mostRecentClosed: GitHubPullRequestListItem[]): PullRequestReference | null {
  const first = mostRecentClosed[0];
  return first?.merged_at ? { number: first.number, url: first.html_url } : null;
}

async function listPullRequests(
  config: WorkerConfig,
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
  state: "open" | "closed",
): Promise<GitHubPullRequestListItem[]> {
  const query = new URLSearchParams({
    head: `${owner}:${headBranch}`,
    base: baseBranch,
    state: state,
    sort: "created",
    direction: "desc",
  });

  const result = await githubRequest<GitHubPullRequestListItem[]>(
    config.githubToken,
    "GET",
    `/repos/${owner}/${repo}/pulls?${query.toString()}`,
  );
  if (result.status !== 200) {
    const message =
      `Could not list pull requests for ${owner}/${repo} (head=${headBranch}, base=${baseBranch}): ` +
      `GitHub returned ${result.status}`;
    if (isClientError(result.status)) throw ApplicationFailure.nonRetryable(message, "PullRequestListUnreadable");
    throw new Error(message);
  }
  return result.json;
}

export function createFindPullRequestActivity(config: WorkerConfig) {
  return async function findPullRequest(
    repoBase: RepoBase,
    headBranch: string,
    baseBranch: string,
  ): Promise<PullRequestReference | null> {
    const owner = repoBase.org;
    const repo = repoBase.repo;

    const openPrs = await listPullRequests(config, owner, repo, headBranch, baseBranch, "open");
    const open = pickPullRequest(openPrs);
    if (open) return open;

    const closedPrs = await listPullRequests(config, owner, repo, headBranch, baseBranch, "closed");
    return pickMergedPullRequest(closedPrs);
  };
}
