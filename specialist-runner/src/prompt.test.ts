import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import type { DispatchContext } from "./dispatch-context.js";

const context: DispatchContext = {
  storyId: "PROJ-101",
  storyTitle: "Add refund endpoint",
  epicId: "PROJ-10",
  surfaces: ["backend"],
  surfaceRepo: "example-org/example-api",
  surfacePaths: ["/"],
  surfaceSkills: [],
  storyBranch: "proj-101-refund-endpoint",
  epicBranch: "proj-10-refunds",
  frameworkRepo: "example-org/intent-to-production",
  frameworkRef: "main",
  maxTurns: 40,
  revision: null,
};

describe("buildUserMessage", () => {
  it("names the specialist, the story, the epic, and both branches", () => {
    const message = buildUserMessage(context);
    expect(message).toContain("You are the Specialist described in the system prompt");
    expect(message).toContain('PROJ-101 — "Add refund endpoint"');
    expect(message).toContain("PROJ-10");
    expect(message).toContain("proj-101-refund-endpoint");
    expect(message).toContain("proj-10-refunds");
  });

  it("names the story's single surface label", () => {
    const message = buildUserMessage(context);
    expect(message).toContain("surface:backend");
  });

  it("names every surface label when a story carries more than one", () => {
    const message = buildUserMessage({ ...context, surfaces: ["web", "e2e"] });
    expect(message).toContain("surface:web surface:e2e");
  });

  it("does not tell the specialist to run tests — not true for e2e, which only self-reviews", () => {
    const message = buildUserMessage(context);
    expect(message).not.toMatch(/run the tests/i);
  });

  it("does not mention an outcome label — removed 2026-08-07, the comment is the only record", () => {
    const message = buildUserMessage(context);
    expect(message).not.toMatch(/outcome label/i);
  });
});

describe("buildSystemPrompt", () => {
  let frameworkPath: string;
  let surfaceRepoPath: string;

  async function scaffold() {
    frameworkPath = await mkdtemp(join(tmpdir(), "specialist-runner-fw-"));
    surfaceRepoPath = await mkdtemp(join(tmpdir(), "specialist-runner-surface-"));
    await mkdir(join(frameworkPath, "agents"), { recursive: true });
    await mkdir(join(frameworkPath, "skills", "story-contract"), { recursive: true });
    await mkdir(join(frameworkPath, "skills", "epic-writing"), { recursive: true });
    await writeFile(join(frameworkPath, "agents", "specialist.md"), "AGENT DEFINITION");
    await writeFile(join(frameworkPath, "skills", "story-contract", "SKILL.md"), "STORY CONTRACT SKILL");
    await writeFile(join(frameworkPath, "skills", "epic-writing", "SKILL.md"), "EPIC WRITING SKILL");
  }

  afterEach(async () => {
    if (frameworkPath) await rm(frameworkPath, { recursive: true, force: true });
    if (surfaceRepoPath) await rm(surfaceRepoPath, { recursive: true, force: true });
  });

  it("concatenates the agent file and both framework skill files", async () => {
    await scaffold();
    const { systemPrompt, skills } = await buildSystemPrompt(frameworkPath, surfaceRepoPath, context);

    expect(systemPrompt).toContain("AGENT DEFINITION");
    expect(systemPrompt).toContain("STORY CONTRACT SKILL");
    expect(systemPrompt).toContain("EPIC WRITING SKILL");
    expect(systemPrompt.indexOf("AGENT DEFINITION")).toBeLessThan(systemPrompt.indexOf("STORY CONTRACT SKILL"));
    expect(skills).toEqual([
      { name: "story-contract", source: "framework" },
      { name: "epic-writing", source: "framework" },
    ]);
  });

  it("inlines a mandatory surface skill from the surface repo first, then the framework catalog", async () => {
    await scaffold();
    await mkdir(join(surfaceRepoPath, ".claude", "skills", "house-style"), { recursive: true });
    await writeFile(join(surfaceRepoPath, ".claude", "skills", "house-style", "SKILL.md"), "SURFACE HOUSE STYLE");
    await mkdir(join(frameworkPath, "skills", "cdkterrain"), { recursive: true });
    await writeFile(join(frameworkPath, "skills", "cdkterrain", "SKILL.md"), "FRAMEWORK CDKTERRAIN");

    const { systemPrompt, skills } = await buildSystemPrompt(frameworkPath, surfaceRepoPath, {
      ...context,
      surfaceSkills: ["house-style", "cdkterrain"],
    });

    expect(systemPrompt).toContain("SURFACE HOUSE STYLE");
    expect(systemPrompt).toContain("FRAMEWORK CDKTERRAIN");
    expect(skills).toContainEqual({ name: "house-style", source: "surface" });
    expect(skills).toContainEqual({ name: "cdkterrain", source: "framework" });
  });

  it("prefers the surface repo's copy when both exist", async () => {
    await scaffold();
    await mkdir(join(surfaceRepoPath, ".claude", "skills", "cdkterrain"), { recursive: true });
    await writeFile(join(surfaceRepoPath, ".claude", "skills", "cdkterrain", "SKILL.md"), "SURFACE OVERRIDE");
    await mkdir(join(frameworkPath, "skills", "cdkterrain"), { recursive: true });
    await writeFile(join(frameworkPath, "skills", "cdkterrain", "SKILL.md"), "FRAMEWORK COPY");

    const { systemPrompt } = await buildSystemPrompt(frameworkPath, surfaceRepoPath, { ...context, surfaceSkills: ["cdkterrain"] });
    expect(systemPrompt).toContain("SURFACE OVERRIDE");
    expect(systemPrompt).not.toContain("FRAMEWORK COPY");
  });

  it("fails before the session starts when a mandatory skill resolves nowhere", async () => {
    await scaffold();
    await expect(buildSystemPrompt(frameworkPath, surfaceRepoPath, { ...context, surfaceSkills: ["missing-skill"] })).rejects.toThrow(
      /Mandatory skill "missing-skill"/,
    );
  });
});

describe("buildUserMessage — revision rounds", () => {
  const revisionContext: DispatchContext = {
    ...context,
    maxTurns: 25,
    revision: { round: 2, roundCap: 3, pullRequestNumber: 42, reviewId: 501 },
  };

  it("says which PR and which review it is answering, and where in the budget it sits", () => {
    const message = buildUserMessage(revisionContext);
    expect(message).toContain("#42");
    expect(message).toContain("501");
    expect(message).toContain("revision round 2 of 3");
  });

  it("sends it to read the review itself rather than handing it a copy", () => {
    // Same reason it reads the story and the code itself: an agent given a
    // pre-digested copy builds against the copy.
    expect(buildUserMessage(revisionContext)).toMatch(/Read review 501 .* yourself/);
  });

  it("points it at its own prior report and the trace before it changes anything", () => {
    const message = buildUserMessage(revisionContext);
    expect(message).toContain("your own completion report");
    expect(message).toContain("acceptance-criteria trace");
    expect(message).toContain("before you change anything");
  });

  it("frames the smaller budget as a fence, with the recommendation to make when it does not fit", () => {
    const message = buildUserMessage(revisionContext);
    expect(message).toContain("25 turns");
    expect(message).toContain("scope fence");
    expect(message).toContain("closing the PR and reshaping the story");
  });

  it("forbids creating or ending anything, and leaves the checkboxes to the reviewer", () => {
    const message = buildUserMessage(revisionContext);
    expect(message).toContain("never close or merge the PR");
    expect(message).toContain("Leave every checkbox exactly as the reviewer left it");
  });

  it("still leaves a first build's message untouched", () => {
    const message = buildUserMessage(context);
    expect(message).not.toContain("revision round");
    expect(message).toContain("open the PR into");
  });
});
