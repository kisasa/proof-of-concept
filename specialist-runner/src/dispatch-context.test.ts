import { describe, it, expect, vi, afterEach } from "vitest";
import { loadDispatchContext } from "./dispatch-context.js";

const REQUIRED_VARS = {
  STORY_ID: "PROJ-101",
  STORY_TITLE: "Add refund endpoint",
  EPIC_ID: "PROJ-10",
  SURFACES: "backend",
  SURFACE_REPO: "example-org/example-api",
  STORY_BRANCH: "proj-101-refund-endpoint",
  EPIC_BRANCH: "proj-10-refunds",
  FRAMEWORK_REPO: "example-org/intent-to-production",
  FRAMEWORK_REF: "main",
  MAX_TURNS: "40",
};

type StubbableVar = keyof typeof REQUIRED_VARS;

function stubAll(overrides: Partial<Record<StubbableVar, string | undefined>> = {}): void {
  const merged = { ...REQUIRED_VARS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      vi.stubEnv(key, undefined as unknown as string);
      delete process.env[key];
    } else {
      vi.stubEnv(key, value);
    }
  }
}

describe("loadDispatchContext", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads a complete, valid context", () => {
    stubAll();
    const context = loadDispatchContext();
    expect(context).toEqual({
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
    });
  });

  it("reads SURFACE_PATHS and SURFACE_SKILLS from the registry when the dispatcher sets them", () => {
    stubAll({ SURFACES: "web,e2e" });
    vi.stubEnv("SURFACE_PATHS", "/, e2e/");
    vi.stubEnv("SURFACE_SKILLS", "playwright-house-style, cdkterrain");
    const context = loadDispatchContext();
    expect(context.surfacePaths).toEqual(["/", "e2e/"]);
    expect(context.surfaceSkills).toEqual(["playwright-house-style", "cdkterrain"]);
  });

  it("defaults every surface path to the repo root when SURFACE_PATHS is unset", () => {
    stubAll({ SURFACES: "web,e2e" });
    expect(loadDispatchContext().surfacePaths).toEqual(["/", "/"]);
  });

  it("rejects SURFACE_PATHS that does not correspond one to one with SURFACES", () => {
    stubAll({ SURFACES: "web,e2e" });
    vi.stubEnv("SURFACE_PATHS", "/");
    expect(() => loadDispatchContext()).toThrow(/one to one/);
  });

  it("parses more than one comma-separated surface", () => {
    stubAll({ SURFACES: "web,e2e" });
    expect(loadDispatchContext().surfaces).toEqual(["web", "e2e"]);
  });

  it("trims whitespace around comma-separated surfaces", () => {
    stubAll({ SURFACES: " web , e2e " });
    expect(loadDispatchContext().surfaces).toEqual(["web", "e2e"]);
  });

  it("accepts any surface name — the vocabulary is open, not a fixed list", () => {
    stubAll({ SURFACES: "mobile" });
    expect(loadDispatchContext().surfaces).toEqual(["mobile"]);
  });

  it("throws naming the missing var when FRAMEWORK_REPO is unset", () => {
    stubAll({ FRAMEWORK_REPO: undefined });
    expect(() => loadDispatchContext()).toThrow(/FRAMEWORK_REPO/);
  });

  it("throws naming the missing var when FRAMEWORK_REF is unset", () => {
    stubAll({ FRAMEWORK_REF: undefined });
    expect(() => loadDispatchContext()).toThrow(/FRAMEWORK_REF/);
  });

  it("respects an explicit frameworkRef", () => {
    stubAll({ FRAMEWORK_REF: "dev" });
    expect(loadDispatchContext().frameworkRef).toBe("dev");
  });

  it("throws naming the missing var when STORY_ID is unset", () => {
    stubAll({ STORY_ID: undefined });
    expect(() => loadDispatchContext()).toThrow(/STORY_ID/);
  });

  it("rejects an empty SURFACES value", () => {
    stubAll({ SURFACES: "" });
    expect(() => loadDispatchContext()).toThrow(/SURFACES/);
  });

  it("rejects a SURFACES value that is only commas and whitespace", () => {
    stubAll({ SURFACES: " , , " });
    expect(() => loadDispatchContext()).toThrow(/must name at least one surface/);
  });

  it("rejects a non-numeric MAX_TURNS", () => {
    stubAll({ MAX_TURNS: "not-a-number" });
    expect(() => loadDispatchContext()).toThrow(/MAX_TURNS/);
  });

  it("rejects a zero or negative MAX_TURNS", () => {
    stubAll({ MAX_TURNS: "0" });
    expect(() => loadDispatchContext()).toThrow(/MAX_TURNS/);
  });
});

describe("loadDispatchContext — revision rounds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubRevision(overrides: Record<string, string | undefined> = {}): void {
    const vars: Record<string, string | undefined> = {
      REVISION_ROUND: "2",
      REVISION_ROUND_CAP: "3",
      PULL_REQUEST_NUMBER: "42",
      REVIEW_ID: "501",
      ...overrides,
    };
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        vi.stubEnv(key, value);
      }
    }
  }

  it("is null on a first build, which is the only thing distinguishing the two modes", () => {
    stubAll();
    stubRevision({ REVISION_ROUND: undefined, REVISION_ROUND_CAP: undefined, PULL_REQUEST_NUMBER: undefined, REVIEW_ID: undefined });
    expect(loadDispatchContext().revision).toBeNull();
  });

  it("loads the round, the cap, the PR and the review it is answering", () => {
    stubAll();
    stubRevision();
    expect(loadDispatchContext().revision).toEqual({ round: 2, roundCap: 3, pullRequestNumber: 42, reviewId: 501 });
  });

  it("refuses a partial set rather than guessing the missing half", () => {
    // A revision run that does not know which review it is answering would
    // still produce confident-looking output, which is worse than refusing.
    stubAll();
    stubRevision({ REVIEW_ID: undefined });
    expect(() => loadDispatchContext()).toThrow(/REVIEW_ID/);
  });

  it("rejects a round that is not a positive integer", () => {
    stubAll();
    stubRevision({ REVISION_ROUND: "0" });
    expect(() => loadDispatchContext()).toThrow(/REVISION_ROUND="0"/);
  });
});
