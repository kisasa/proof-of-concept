import { describe, it, expect, vi, afterEach } from "vitest";
import { createStoryBranch } from "./create-story-branch.js";

const REPO_BASE = { host: "github", org: "example-org", repo: "example-api", ref: "main" };
const INPUT = {
  repoBase: REPO_BASE,
  epicBranch: "proj-10-refunds",
  storyBranch: "proj-101-refund-endpoint",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
}

/**
 * Routes by URL rather than by call order: the abandoned-work check only
 * fires on one of the two create outcomes, so a positional stub would bake
 * the very control flow under test into the fixture.
 */
function stubGitHub(routes: { epicRef?: Response; create?: Response; compare?: Response }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/git/ref/heads/")) return routes.epicRef ?? jsonResponse(200, { object: { sha: "epicsha" } });
      if (url.includes("/git/refs")) return routes.create ?? jsonResponse(201, {});
      if (url.includes("/compare/")) return routes.compare ?? jsonResponse(200, { ahead_by: 0 });
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  return calls;
}

describe("createStoryBranch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unsupported repo-base host before making any request", async () => {
    await expect(
      createStoryBranch("gh-token", {
        repoBase: { host: "gitlab", org: "example-org", repo: "example-api", ref: "main" },
        epicBranch: "proj-10-refunds",
        storyBranch: "proj-101-refund-endpoint",
      }),
    ).rejects.toThrow(/Unsupported repo-base host "gitlab"/);
  });

  it("creates the branch and never compares when it did not already exist", async () => {
    const calls = stubGitHub({ create: jsonResponse(201, {}) });

    await createStoryBranch("gh-token", INPUT);

    expect(calls.some((url) => url.includes("/compare/"))).toBe(false);
  });

  it("stays idempotent when the branch exists but carries no work of its own", async () => {
    // The epic branch moves forward as sibling stories merge, so a story
    // branch cut an hour ago legitimately points at an older epic sha. That
    // is not abandoned work, and refusing it would block a healthy retry.
    stubGitHub({
      create: jsonResponse(422, { message: "Reference already exists" }),
      compare: jsonResponse(200, { ahead_by: 0 }),
    });

    await expect(createStoryBranch("gh-token", INPUT)).resolves.toBeUndefined();
  });

  it("refuses to build on a branch still carrying an earlier attempt's commits, and names the remedy", async () => {
    stubGitHub({
      create: jsonResponse(422, { message: "Reference already exists" }),
      compare: jsonResponse(200, { ahead_by: 3 }),
    });

    await expect(createStoryBranch("gh-token", INPUT)).rejects.toThrow(
      /already carries 3 commit\(s\).*git push origin --delete proj-101-refund-endpoint/s,
    );
  });

  it("proceeds rather than blocking the story when the comparison cannot be read", async () => {
    // An unreadable comparison is not evidence of abandoned work, and the
    // specialist's own branch-chain verification is still downstream.
    stubGitHub({
      create: jsonResponse(422, { message: "Reference already exists" }),
      compare: jsonResponse(500, {}),
    });

    await expect(createStoryBranch("gh-token", INPUT)).resolves.toBeUndefined();
  });
});
