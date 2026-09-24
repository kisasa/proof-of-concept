/**
 * The pre-dispatch dependency check the ledger names as "a plain tracker
 * read, not agent judgment... runs before the Anthropic call rather than
 * being left for the dispatched agent to discover mid-run." Reads the
 * story's "Blocking dependencies" section (tightened format —
 * `skills/story-contract/SKILL.md` — bare identifier as the first
 * token of each bullet line), confirms every named blocker's Linear state
 * is `completed`.
 *
 * Not a `dispatch:blocked` label yet — see the class comment in
 * `resolve-surfaces.ts` for why label application is out of scope here
 * (`save_issue`-style label writes replace the whole label set, so applying
 * one correctly needs the issue's current labels first; a comment carries
 * the same information for now). Named gap, not silently dropped.
 */

import { getIssue, postComment, linearApiUrl } from "../tracker.js";
import type { WorkerConfig } from "../worker-config.js";

export interface DependencyCheckResult {
  readonly ready: boolean;
  readonly blockedBy: string[];
}

// "-" or "*" — both are valid Markdown bullet markers and Decompose isn't
// pinned to one (the References section on this exact story used "*" while
// its own Blocking-dependencies section used "-"). The bullet marker itself
// is optional — confirmed live (2026-08-06): Decompose rendered a single
// blocker as a bare line ("PROJ-63 — Story: ...") with no marker at
// all, which silently produced zero blocker ids and let checkDependencies
// wave the story through — the specialist itself had to catch the real
// blocker mid-run. The identifier's own hyphen (e.g. "PROJ-42") is real
// tracker syntax, not incidental formatting, so that one stays literal.
const BULLET_IDENTIFIER = /^[-*]?\s*([A-Z][A-Z0-9]*-\d+)/;

/**
 * Strips everything but letters and digits, lowercased, so heading-text
 * comparisons key on the actual words rather than the punctuation/whitespace
 * around them: "Blocking dependencies", "Blocking-Dependencies", and
 * "blocking   dependencies" all normalize to "blockingdependencies". Formatting
 * (bold vs. heading markup, spacing, punctuation) is never the thing worth
 * matching on — Decompose doesn't render section headings identically every
 * time, and every occurrence of an exact-literal match against agent-produced
 * text in this file has broken once already (see below).
 */
function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A section heading, in either markup form seen in real story descriptions:
 * `**Blocking dependencies**` (story-contract.md's own documented example)
 * or `## Blocking dependencies` (what Decompose actually renders live —
 * confirmed live 2026-08-06 — matching the `## References`
 * footer convention the tracker-writing prose standard introduced the same
 * day). Accepting both, rather than picking one, is the lesson the
 * status-name mismatch just taught: match what Decompose actually produces,
 * not the one literal string a doc happened to show.
 */
function headingText(line: string): string | null {
  const trimmed = line.trim();
  const bold = trimmed.match(/^\*\*(.+)\*\*$/);
  if (bold?.[1]) return bold[1].trim();
  const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (heading?.[1]) return heading[1].trim();
  return null;
}

const BLOCKING_DEPENDENCIES_HEADING = normalizeForComparison("Blocking dependencies");

/**
 * Extracts blocker identifiers from a story description's "Blocking
 * dependencies" section. Returns an empty array both for "No blocking
 * dependencies." and for a heading with no bullet lines — both correctly
 * mean "nothing blocking." Throws if the heading itself is missing: every
 * well-formed story has this section per story-contract.md, so its absence
 * is a story defect, not something to silently treat as "ready."
 */
export function parseBlockingDependencyIds(description: string): string[] {
  const lines = description.split("\n");
  const headingIndex = lines.findIndex((line) => {
    const text = headingText(line);
    return text !== null && normalizeForComparison(text) === BLOCKING_DEPENDENCIES_HEADING;
  });
  if (headingIndex === -1) {
    throw new Error('Story description has no "Blocking dependencies" section');
  }

  const ids: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (headingText(line) !== null) break;
    const match = line.trim().match(BULLET_IDENTIFIER);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

export function createCheckDependenciesActivity(config: WorkerConfig) {
  return async function checkDependencies(storyId: string): Promise<DependencyCheckResult> {
    const baseUrl = linearApiUrl();
    const story = await getIssue(storyId, config.linearAgentApiKey, baseUrl);
    const blockerIds = parseBlockingDependencyIds(story.description);

    if (blockerIds.length === 0) {
      return { ready: true, blockedBy: [] };
    }

    const blockers = await Promise.all(
      blockerIds.map(async (id) => ({ id, issue: await getIssue(id, config.linearAgentApiKey, baseUrl) })),
    );
    const notDone = blockers.filter(({ issue }) => issue.stateType !== "completed").map(({ id }) => id);

    if (notDone.length > 0) {
      await postComment(
        storyId,
        config.linearAgentApiKey,
        baseUrl,
        `**Dispatch blocked** _(automated)_\n\nThis story's blocking dependencies aren't all Done yet: ` +
          `${notDone.join(", ")}. Moving this story back to To-Do — forward it to In Progress again once ` +
          `${notDone.length === 1 ? "it merges" : "they merge"} to retry.`,
      );
      return { ready: false, blockedBy: notDone };
    }

    return { ready: true, blockedBy: [] };
  };
}
