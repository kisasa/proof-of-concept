/**
 * The PoC's merge path (docs/design-ledger.md, E2): a story's PR merges into
 * its epic branch as soon as the specialist opens it, and the epic branch's
 * own PR into the surface's base branch (`repoBase.ref`) opens automatically.
 * Per-story review is ceremony at PoC scale; the epic PR is where a human
 * reviews, tests, and merges, once, at the end.
 *
 * Both activities are best-effort towards the human, never towards the work:
 *
 * - `mergeStoryPullRequest` returns false rather than throwing when GitHub
 *   will not merge (a conflict with a sibling story, a branch protection
 *   rule), after saying why on the PR. The workflow then falls back to the
 *   reviewer path, where a person resolves it.
 * - `ensureEpicPullRequest` returns null rather than throwing when it cannot
 *   open the epic PR. The story itself is already merged, and failing its
 *   dispatch over a courtesy PR would move a finished story back to Todo.
 */

import { log } from "@temporalio/activity";
import { githubRequest } from "../github-request.js";
import { getIssue, linearApiUrl } from "../tracker.js";
import type { WorkerConfig } from "../worker-config.js";
import type { PullRequestReference } from "./find-pull-request.js";
import type { RepoBase } from "./resolve-surfaces.js";

interface GitHubPullRequest {
  number: number;
  html_url: string;
  merged: boolean;
  state: "open" | "closed";
}

/** A merge commit, not a squash: the story branch stays an ancestor of the
 * epic branch, so a later re-dispatch's abandoned-work check (commits on the
 * story branch that are not on the epic branch) reads zero, as it should. */
const MERGE_METHOD = "merge";

export function mergeFailureNotice(status: number, reason: string): string {
  return (
    `**Not merged automatically** _(automated)_\n\n` +
    `This story's PR would normally merge into the epic branch on its own, but GitHub refused ` +
    `(${status}: ${reason}). It is left open for a person to resolve and merge; the dispatch keeps ` +
    `watching it.`
  );
}

export function createMergeStoryPullRequestActivity(config: WorkerConfig) {
  return async function mergeStoryPullRequest(repoBase: RepoBase, prNumber: number): Promise<boolean> {
    const owner = repoBase.org;
    const repo = repoBase.repo;

    // A re-dispatch can find a PR that is already merged; that is success.
    const current = await githubRequest<GitHubPullRequest>(config.githubToken, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
    if (current.status === 200 && current.json.merged) return true;

    const merge = await githubRequest<{ merged?: boolean; message?: string }>(
      config.githubToken,
      "PUT",
      `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      { merge_method: MERGE_METHOD },
    );
    if (merge.status === 200 && merge.json.merged) {
      log.info(`merged ${owner}/${repo}#${prNumber} into its epic branch`);
      return true;
    }

    const reason = merge.json.message ?? "no message";
    log.warn(`could not merge ${owner}/${repo}#${prNumber}: ${merge.status} ${reason}`);
    const notice = await githubRequest(config.githubToken, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      body: mergeFailureNotice(merge.status, reason),
    });
    if (notice.status !== 201) log.warn(`could not post the merge-failure notice on #${prNumber}: ${notice.status}`);
    return false;
  };
}

export function epicPullRequestBody(epicIdentifier: string, baseBranch: string): string {
  return (
    `Merges the stories of ${epicIdentifier} into \`${baseBranch}\`.\n\n` +
    `Opened by the PoC dispatch workflow when the epic's first story merged. Each later story merges ` +
    `into the epic branch on its own and shows up here. Review and test the epic here, then merge.`
  );
}

export function createEnsureEpicPullRequestActivity(config: WorkerConfig) {
  return async function ensureEpicPullRequest(
    repoBase: RepoBase,
    epicId: string,
    epicBranch: string,
  ): Promise<PullRequestReference | null> {
    const owner = repoBase.org;
    const repo = repoBase.repo;
    const base = repoBase.ref;

    const open = await githubRequest<GitHubPullRequest[]>(
      config.githubToken,
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${epicBranch}`)}&base=${encodeURIComponent(base)}`,
    );
    const existing = open.status === 200 ? open.json[0] : undefined;
    if (existing) return { number: existing.number, url: existing.html_url };

    let title = epicBranch;
    let identifier = epicBranch;
    try {
      const epic = await getIssue(epicId, config.linearAgentApiKey, linearApiUrl());
      title = `${epic.identifier}: ${epic.title}`;
      identifier = epic.identifier;
    } catch (err) {
      log.warn(`could not read epic ${epicId} for the epic PR title; using the branch name`, { error: String(err) });
    }

    const created = await githubRequest<GitHubPullRequest & { message?: string }>(config.githubToken, "POST", `/repos/${owner}/${repo}/pulls`, {
      title: title,
      head: epicBranch,
      base: base,
      body: epicPullRequestBody(identifier, base),
    });
    if (created.status === 201) {
      log.info(`opened epic PR ${owner}/${repo}#${created.json.number} (${epicBranch} → ${base})`);
      return { number: created.json.number, url: created.json.html_url };
    }

    log.warn(`could not open the epic PR ${epicBranch} → ${base}: ${created.status} ${created.json.message ?? "no message"}`);
    return null;
  };
}
