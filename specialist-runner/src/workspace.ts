/**
 * Prepares the ephemeral container's filesystem for one run: the framework
 * repo (agent + skill files) and the one target surface repo this run writes
 * to. Both are cloned fresh every run — deliberately, not baked into the
 * image — which is the automated fix for the ledger's own flagged gap ("the
 * framework clone is a silent version dependency... a stale clone will
 * quietly dispatch a superseded definition"): a fresh per-run clone can't go
 * stale the way a human's forgotten `git pull` can.
 *
 * Named limitation: assumes a Node-based target surface. A non-Node surface
 * would need a broader image or a per-dispatch toolchain step — out of scope
 * until an actual non-Node surface needs a specialist run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchContext } from "./dispatch-context.js";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const GIT_AUTHOR_NAME = "Specialist";
const GIT_AUTHOR_EMAIL = "specialist@example.com";

export interface WorkspacePaths {
  readonly frameworkPath: string;
  readonly surfaceRepoPath: string;
}

/**
 * Redacts the GitHub token from any string before it can reach a log line or
 * a tracker comment. Necessary, not optional: confirmed live (2026-08-06)
 * that a failed `git clone` on the authenticated URL leaks the token
 * straight through, because Node's own `child_process` error message embeds
 * the full argv (including the URL) verbatim — `execFileAsync`'s rejection
 * is "Command failed: git clone ... https://x-access-token:<token>@...",
 * regardless of what git's own stderr says. That message is exactly what
 * `run.ts`'s top-level catch hands to `postFallbackComment`, so an
 * unredacted failure here posts the real token to Linear, not just a local
 * log — worse than a log leak, since the comment is visible to anyone with
 * access to the story.
 */
export function redact(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

async function runGit(args: string[], cwd: string | undefined, log: Logger, githubToken: string): Promise<void> {
  log.trace(`git ${redact(args.join(" "), githubToken)}`);
  try {
    await execFileAsync("git", args, { cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redact(message, githubToken));
  }
}

function authenticatedCloneUrl(repo: string, githubToken: string): string {
  return `https://x-access-token:${githubToken}@github.com/${repo}.git`;
}

/**
 * Clones the framework and surface repos under `root`, checks out the story
 * branch, and sets a git identity for the commits the specialist will make.
 *
 * The framework repo is a shallow clone (`--depth 1`) — only the agent/skill
 * files at `frameworkRef` are needed, no history. The surface repo is
 * deliberately NOT shallow: it uses `--filter=blob:none` instead (full commit
 * graph, blobs fetched lazily), because step 3 of the specialist's own
 * definition verifies branch ancestry against real repository history, which
 * a shallow clone doesn't carry.
 */
export async function prepareWorkspace(
  root: string,
  context: DispatchContext,
  githubToken: string,
  log: Logger,
): Promise<WorkspacePaths> {
  await mkdir(root, { recursive: true });

  const frameworkPath = join(root, "framework");
  const surfaceRepoPath = join(root, "surface");

  log.info(`cloning framework repo ${context.frameworkRepo} at ref ${context.frameworkRef}`);
  await runGit(
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      context.frameworkRef,
      authenticatedCloneUrl(context.frameworkRepo, githubToken),
      frameworkPath,
    ],
    undefined,
    log,
    githubToken,
  );

  log.info(`cloning surface repo ${context.surfaceRepo}`);
  await runGit(
    ["clone", "--filter=blob:none", authenticatedCloneUrl(context.surfaceRepo, githubToken), surfaceRepoPath],
    undefined,
    log,
    githubToken,
  );

  // If the branch doesn't exist, this throws — that's the broken-chain case
  // the specialist's own definition already handles (post a comment and
  // stop), not this module's job to paper over or repair.
  log.info(`checking out story branch ${context.storyBranch}`);
  await runGit(["checkout", context.storyBranch], surfaceRepoPath, log, githubToken);

  await runGit(["config", "user.name", GIT_AUTHOR_NAME], surfaceRepoPath, log, githubToken);
  await runGit(["config", "user.email", GIT_AUTHOR_EMAIL], surfaceRepoPath, log, githubToken);

  return { frameworkPath, surfaceRepoPath };
}
