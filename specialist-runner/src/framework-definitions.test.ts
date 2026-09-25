import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "./prompt.js";
import type { DispatchContext } from "./dispatch-context.js";

/**
 * The specialist clones FRAMEWORK_REPO and reads its definition and framework
 * skills from that clone. This repository is that framework repo, so the
 * files the runner reads must exist here. Building the system prompt against
 * this checkout's own root proves it; a missing file would otherwise surface
 * only inside a dispatched container.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
  frameworkRepo: "example-org/proof-of-concept",
  frameworkRef: "main",
  maxTurns: 40,
  revision: null,
};

describe("framework definitions in this repository", () => {
  it("has the specialist definition and every framework skill the runner inlines", async () => {
    const build = await buildSystemPrompt(REPO_ROOT, REPO_ROOT, context);
    expect(build.skills.every((skill) => skill.source === "framework")).toBe(true);
    expect(build.skills.length).toBeGreaterThan(0);
    expect(build.systemPrompt.length).toBeGreaterThan(0);
  });
});
