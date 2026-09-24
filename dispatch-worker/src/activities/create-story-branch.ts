/**
 * Mechanical branch creation — "matching a tracker's gitBranchName field to a
 * git operation is mechanical, not the specialist's judgment to make... it's
 * the app's job." Reads the epic branch's current commit sha via the GitHub
 * REST API and creates the story branch ref from it. Never rebases or
 * re-parents an existing branch — if the story branch already exists, this
 * is idempotent (a retried activity attempt isn't an error), but it never
 * moves an existing ref, since a human or a previous attempt may already be
 * building on it.
 *
 * Only `github` is supported as a repo-base host for now — GitHub Enterprise
 * or another host would need a different API base URL, not built until an
 * actual engagement needs one.
 *
 * Retry classification matters here (Temporal retries a thrown activity by
 * default, generously): a 4xx from GitHub — an unsupported host, a missing
 * epic branch, a malformed create request — won't change on an identical
 * retry, so those throw `ApplicationFailure.nonRetryable`. A 5xx or a
 * network-level failure might be transient, so those throw a plain `Error`
 * and stay retryable.
 */

import { ApplicationFailure } from "@temporalio/activity";
import { githubRequest, isClientError } from "../github-request.js";
import type { RepoBase } from "./resolve-surfaces.js";

interface GitHubRefResponse {
  object: { sha: string };
}

export interface CreateStoryBranchInput {
  readonly repoBase: RepoBase;
  readonly epicBranch: string;
  readonly storyBranch: string;
}

export async function createStoryBranch(githubToken: string, input: CreateStoryBranchInput): Promise<void> {
  if (input.repoBase.host !== "github") {
    throw ApplicationFailure.nonRetryable(
      `Unsupported repo-base host "${input.repoBase.host}" — only "github" is supported today`,
      "UnsupportedRepoHost",
    );
  }

  const owner = input.repoBase.org;
  const repo = input.repoBase.repo;

  const epicRef = await githubRequest<GitHubRefResponse>(
    githubToken,
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(input.epicBranch)}`,
  );
  if (epicRef.status !== 200) {
    const message = `Could not read epic branch "${input.epicBranch}" in ${owner}/${repo}: GitHub returned ${epicRef.status}`;
    if (isClientError(epicRef.status)) throw ApplicationFailure.nonRetryable(message, "EpicBranchUnreadable");
    throw new Error(message);
  }

  const createResult = await githubRequest<{ message?: string }>(githubToken, "POST", `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${input.storyBranch}`,
    sha: epicRef.json.object.sha,
  });

  const alreadyExists = createResult.status === 422 && /already exists/i.test(createResult.json.message ?? "");
  if (createResult.status !== 201 && !alreadyExists) {
    const message =
      `Could not create story branch "${input.storyBranch}" in ${owner}/${repo}: ` +
      `GitHub returned ${createResult.status} (${createResult.json.message ?? "no message"})`;
    if (isClientError(createResult.status)) throw ApplicationFailure.nonRetryable(message, "StoryBranchCreateFailed");
    throw new Error(message);
  }

  if (alreadyExists) {
    await refuseAbandonedWork(githubToken, input);
  }
}

interface GitHubCompareResponse {
  ahead_by: number;
}

/**
 * A re-dispatch is a fresh start, so it refuses to build on the leftovers of
 * an earlier attempt.
 *
 * The reachable path is the one the specialist recommends when feedback is
 * too large for a revision round: close the PR, reshape the story, run it
 * again. Closing a PR does not delete its branch, so without this the next
 * specialist silently starts on top of work everyone has already agreed to
 * abandon — and code generation is immutable by intent: a new run regenerates
 * rather than inherits.
 *
 * **"Already exists" is not the test — carrying its own commits is.** The
 * epic branch moves forward as sibling stories merge, so a story branch cut
 * an hour ago legitimately points at an older epic sha while containing no
 * work of its own. Comparing heads would refuse that perfectly good branch.
 * `ahead_by` from the compare endpoint answers the question actually being
 * asked: does this branch carry commits the epic branch does not have.
 *
 * Only reached on a first dispatch. Revision rounds reuse the branch and the
 * PR deliberately, and the workflow never calls this activity again inside
 * its revision loop — if that ever changes, this refusal fires on round two.
 *
 * Nothing is deleted here. An agent never destroys commits; the message names
 * the remedy so the human's fix is one command rather than a puzzle.
 */
async function refuseAbandonedWork(githubToken: string, input: CreateStoryBranchInput): Promise<void> {
  const owner = input.repoBase.org;
  const repo = input.repoBase.repo;
  const comparison = await githubRequest<GitHubCompareResponse>(
    githubToken,
    "GET",
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(input.epicBranch)}...${encodeURIComponent(input.storyBranch)}`,
  );

  // An unreadable comparison is not evidence of abandoned work. Dispatch
  // proceeds rather than blocking a story on a transient GitHub read — the
  // specialist's own branch-chain verification is the backstop.
  if (comparison.status !== 200) return;
  if (comparison.json.ahead_by === 0) return;

  throw ApplicationFailure.nonRetryable(
    `Story branch "${input.storyBranch}" already carries ${comparison.json.ahead_by} commit(s) that are not on ` +
      `"${input.epicBranch}" — work from an earlier dispatch that was abandoned rather than merged. ` +
      `A re-dispatch is a fresh start and will not build on it. Delete the branch ` +
      `(git push origin --delete ${input.storyBranch}) and move the story into In Progress again.`,
    "StoryBranchCarriesAbandonedWork",
  );
}
