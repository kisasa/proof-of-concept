import { describe, it, expect } from "vitest";
import { buildContainerOverrides } from "./dispatch-specialist.js";

describe("buildContainerOverrides", () => {
  it("matches specialist-runner's dispatch-context.ts contract exactly, plus a propagated LOG_LEVEL", () => {
    const overrides = buildContainerOverrides(
      {
        storyId: "PROJ-101",
        storyTitle: "Add refund endpoint",
        epicId: "PROJ-10",
        surfaces: ["backend"],
        repoBase: { host: "github", org: "example-org", repo: "example-api", ref: "main" },
        surfacePaths: ["/"],
        surfaceSkills: [],
        storyBranch: "proj-101-refund-endpoint",
        epicBranch: "proj-10-refunds",
        maxTurns: 40,
      },
      "debug",
    );

    expect(overrides).toEqual([
      { name: "STORY_ID", value: "PROJ-101" },
      { name: "STORY_TITLE", value: "Add refund endpoint" },
      { name: "EPIC_ID", value: "PROJ-10" },
      { name: "SURFACES", value: "backend" },
      { name: "SURFACE_REPO", value: "example-org/example-api" },
      { name: "SURFACE_PATHS", value: "/" },
      { name: "SURFACE_SKILLS", value: "" },
      { name: "STORY_BRANCH", value: "proj-101-refund-endpoint" },
      { name: "EPIC_BRANCH", value: "proj-10-refunds" },
      { name: "MAX_TURNS", value: "40" },
      { name: "LOG_LEVEL", value: "debug" },
    ]);
  });

  it("comma-joins more than one surface", () => {
    const overrides = buildContainerOverrides(
      {
        storyId: "PROJ-101",
        storyTitle: "Add refund flow",
        epicId: "PROJ-10",
        surfaces: ["web", "e2e"],
        repoBase: { host: "github", org: "example-org", repo: "example-app", ref: "main" },
        surfacePaths: ["/"],
        surfaceSkills: [],
        storyBranch: "proj-101-refund-flow",
        epicBranch: "proj-10-refunds",
        maxTurns: 40,
      },
      "info",
    );

    expect(overrides).toContainEqual({ name: "SURFACES", value: "web,e2e" });
  });
});
