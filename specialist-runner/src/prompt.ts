/**
 * Builds this run's systemPrompt (the specialist's own definition plus the two
 * skills it declares) and its initial user message (assignment: which story,
 * which surface(s), which branches — everything else the agent fetches itself
 * via MCP, per its own definition). Adapts "The prompt" template from
 * docs/development-tier-dispatch.pdf — generated programmatically here rather
 * than filling `<PLACEHOLDER>` tokens in a static file, since there is exactly
 * one shape of specialist prompt to produce, not one per lane the way the
 * shaping tier's templates are (see prompt-assembly.ts in webhook-listener).
 *
 * One agent file for every surface now (`agents/specialist.md`), not a
 * `specialist-${type}.md` selected by type — the specialist-types-collapse-
 * into-surfaces redesign (docs/design-ledger.md, 2026-08-08) found no
 * genuine type-specific behavior once the four definitions were compared
 * properly. What used to be told by loading a different file is now told in
 * the user message instead: which surface(s) this story is labelled with.
 *
 * Two deliberate differences from the manual prompt: the agent file and
 * skills are read here and placed directly in systemPrompt, rather than told
 * to Claude as paths to read itself — saves a turn and guarantees they're
 * read. And there is no "sibling repositories" paragraph — v1 clones only the
 * one target surface (see workspace.ts's own note on this gap).
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchContext, RevisionContext } from "./dispatch-context.js";

const AGENT_FILE = "specialist.md";
/** Framework-process skills every specialist reads, whatever the surface. */
const FRAMEWORK_SKILL_NAMES = ["story-contract", "epic-writing"];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a mandatory surface skill is looked for, in order: the surface
 * repo's own `.claude/skills/<name>/SKILL.md` (a client team's skill, or its
 * override of a framework one), then the framework catalog
 * `skills/<name>/SKILL.md`. Surface repo first so a client can override
 * (docs/design-ledger.md, 2026-08-23, "Resolver order ... surface repo first
 * and framework catalog second"). A mandatory skill that resolves nowhere is
 * a hard failure before the session starts: "mandatory" means guaranteed
 * read, and a silent skip is exactly the failure discretionary discovery
 * already has.
 */
export async function resolveSurfaceSkill(name: string, frameworkPath: string, surfaceRepoPath: string): Promise<{ path: string; source: "surface" | "framework" }> {
  const inSurface = join(surfaceRepoPath, ".claude", "skills", name, "SKILL.md");
  if (await exists(inSurface)) return { path: inSurface, source: "surface" };
  const inFramework = join(frameworkPath, "skills", name, "SKILL.md");
  if (await exists(inFramework)) return { path: inFramework, source: "framework" };
  throw new Error(
    `Mandatory skill "${name}" (from the surface registry) was not found at ${inSurface} or ${inFramework}. ` +
      `Add it to the surface repo's .claude/skills/ or to the framework's skills/, or remove it from the registry.`,
  );
}

export interface SystemPromptBuild {
  readonly systemPrompt: string;
  /** Every skill inlined, with where each came from — logged, and worth putting in the hand-back. */
  readonly skills: readonly { name: string; source: "framework" | "surface" }[];
}

export async function buildSystemPrompt(frameworkPath: string, surfaceRepoPath: string, context: DispatchContext): Promise<SystemPromptBuild> {
  const agentText = await readFile(join(frameworkPath, "agents", AGENT_FILE), "utf8");
  const frameworkSkills = await Promise.all(
    FRAMEWORK_SKILL_NAMES.map(async (name) => ({
      name,
      source: "framework" as const,
      text: await readFile(join(frameworkPath, "skills", name, "SKILL.md"), "utf8"),
    })),
  );
  const surfaceSkills = await Promise.all(
    context.surfaceSkills
      .filter((name) => !FRAMEWORK_SKILL_NAMES.includes(name))
      .map(async (name) => {
        const resolved = await resolveSurfaceSkill(name, frameworkPath, surfaceRepoPath);
        return { name, source: resolved.source, text: await readFile(resolved.path, "utf8") };
      }),
  );
  const all = [...frameworkSkills, ...surfaceSkills];
  return {
    systemPrompt: [agentText, ...all.map((s) => s.text)].join("\n\n---\n\n"),
    skills: all.map(({ name, source }) => ({ name, source })),
  };
}

function describePaths(context: DispatchContext): string {
  const scoped = context.surfaces.map((surface, i) => ({ surface, path: context.surfacePaths[i] ?? "/" }));
  if (scoped.every((s) => s.path === "/")) {
    return "The surface is the whole repository.";
  }
  const parts = scoped.map((s) => (s.path === "/" ? `${s.surface} is the repository root` : `${s.surface} lives under ${s.path}`));
  return `Within the repository, ${parts.join("; ")}. Write only inside those directories.`;
}

export function buildUserMessage(context: DispatchContext): string {
  const surfaceLabels = context.surfaces.map((surface) => `surface:${surface}`).join(" ");
  if (context.revision) {
    return buildRevisionMessage(context, context.revision, surfaceLabels);
  }

  return `You are the Specialist described in the system prompt. Follow that definition; this message only tells you which story and where.

Assignment: story ${context.storyId} — "${context.storyTitle}", under epic ${context.epicId}.

Your story carries the label(s) ${surfaceLabels} — that is your surface, or surfaces if more than one is listed (they all resolve to the same repo and ref). ${describePaths(context)} Every write you make goes there and nowhere else. It is checked out on ${context.storyBranch}; the epic branch is ${context.epicBranch}. Both names come from the tracker, and the branch chain was set up before you were dispatched — verify it, do not repair it.

Using the Linear connector, read ${context.storyId}'s description and its full comment thread, then walk up to ${context.epicId} for the parent epic, its resolved API map, and the linked design issue. The comment thread on ${context.storyId} may carry a question-and-answer exchange between the developer who picked this up and the architect from before you were engaged — read it as part of the story, not as commentary on it.

Then act per your definition: check blocking dependencies, verify the branch chain, read the codebase and its conventions spec, do the story's work, open the PR into ${context.epicBranch}, and post your completion report on ${context.storyId}.

If the branch chain is wrong, a blocking dependency is unmerged, or the story has a gap you cannot resolve from the thread — stop and report it rather than deciding for yourself. A blocker you surface is the useful output of this run.`;
}

/**
 * A revision round's assignment. Same shape of message as the first build's
 * — which story, where — plus which review it is answering. What to *do*
 * with that review lives in the agent definition, not here.
 *
 * It does not carry the review's text. The specialist fetches the review and
 * its inline comments itself, for the same reason it reads the story and the
 * code itself rather than being told about them.
 */
function buildRevisionMessage(context: DispatchContext, revision: RevisionContext, surfaceLabels: string): string {
  return `You are the Specialist described in the system prompt. This is a revision round, not a fresh build — follow the revision lifecycle in that definition.

Assignment: story ${context.storyId} — "${context.storyTitle}", under epic ${context.epicId}. You already built this story and opened pull request #${revision.pullRequestNumber}. The reviewer-of-record has submitted a review requesting changes, id ${revision.reviewId}. This is revision round ${revision.round} of ${revision.roundCap}.

Your story carries the label(s) ${surfaceLabels}. ${describePaths(context)} It is checked out on ${context.storyBranch}, carrying your own earlier commits; the epic branch is ${context.epicBranch}. The branch and the PR both already exist — never create either, and never close or merge the PR.

Read review ${revision.reviewId} on pull request #${revision.pullRequestNumber} yourself: its summary comment and every inline comment, each with the file and line it is anchored to. Read your own completion report on ${context.storyId} and the acceptance-criteria trace in the PR body before you change anything — you will not remember why you made a call three days ago, and the record of it is there.

Then act per the revision lifecycle: size the work first, apply what falls inside this story's scope, reply in the thread each comment was left in, and update the criteria trace with which criteria your changes touched. Leave every checkbox exactly as the reviewer left it.

You have ${context.maxTurns} turns, deliberately fewer than a build. That is a scope fence, not a target: if the feedback needs more than this, it was a story change rather than a review comment — say so up front and recommend closing the PR and reshaping the story, rather than half-applying it.`;
}
