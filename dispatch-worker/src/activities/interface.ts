/**
 * The activity signatures the workflow depends on — type-only, imported by
 * `workflows/dispatch-story-workflow.ts` via `proxyActivities<DispatchActivities>()`.
 * Workflow code runs in Temporal's deterministic sandbox and must never
 * import the real (non-deterministic) activity implementations directly;
 * this file exists so the workflow gets full type-checking on activity calls
 * without pulling any real code (fetch, the AWS SDK, Node's child_process)
 * into the workflow bundle. `worker.ts` is the only module that imports the
 * real implementations and binds them to these same names.
 */

import type { AwaitPullRequestOutcomeInput, PullRequestWatchResult } from "./await-pull-request-outcome.js";
import type { DependencyCheckResult } from "./check-dependencies.js";
import type { CreateStoryBranchInput } from "./create-story-branch.js";
import type { DispatchSpecialistInput } from "./dispatch-specialist.js";
import type { PullRequestReference } from "./find-pull-request.js";
import type { RepoBase, ResolvedTarget } from "./resolve-surfaces.js";
import type { Surface, StoryMover } from "./types.js";

export interface DispatchActivities {
  checkDependencies(storyId: string): Promise<DependencyCheckResult>;
  resolveSurfaces(epicId: string, surfaces: Surface[]): Promise<ResolvedTarget>;
  createStoryBranch(input: CreateStoryBranchInput): Promise<void>;
  dispatchSpecialist(input: DispatchSpecialistInput): Promise<string>;
  postSpecialistStarted(storyId: string): Promise<string | null>;
  awaitSpecialistTask(taskArn: string, progressCommentId: string | null): Promise<void>;
  deleteSpecialistProgressComment(commentId: string): Promise<void>;
  findPullRequest(repoBase: RepoBase, headBranch: string, baseBranch: string): Promise<PullRequestReference | null>;
  /** Returns the reviewer-of-record's GitHub login, or null when the mover could not be mapped to one. */
  requestPullRequestReviewer(repoBase: RepoBase, prNumber: number, mover: StoryMover | null): Promise<string | null>;
  awaitPullRequestOutcome(input: AwaitPullRequestOutcomeInput): Promise<PullRequestWatchResult>;
  postPullRequestNotice(repoBase: RepoBase, prNumber: number, body: string): Promise<number | null>;
  editPullRequestNotice(repoBase: RepoBase, commentId: number, body: string): Promise<void>;
  postDispatchFailed(storyId: string, message: string): Promise<void>;
  moveStoryToTodo(storyId: string): Promise<void>;
}
