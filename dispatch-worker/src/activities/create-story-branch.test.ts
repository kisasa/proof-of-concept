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

interface Routes {
  /** The epic branch's head; a function so a test can answer differently on a second read. */
  epicRef?: () => Response;
  baseRef?: Response;
  createEpic?: Response;
  create?: Response;
  compare?: Response;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: { ref?: string; sha?: string } | null;
}

/**
 * Routes by URL and request body rather than by call order: whether the epic
 * branch is created, and whether the abandoned-work check fires, each depend
 * on an earlier answer, so a positional stub would bake the very control flow
 * under test into the fixture.
 */
function stubGitHub(routes: Routes) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith(`/git/ref/heads/${INPUT.epicBranch}`)) {
        return routes.epicRef ? routes.epicRef() : jsonResponse(200, { object: { sha: "epicsha" } });
      }
      if (url.endsWith(`/git/ref/heads/${REPO_BASE.ref}`)) return routes.baseRef ?? jsonResponse(200, { object: { sha: "mainsha" } });
      if (url.endsWith("/git/refs")) {
        if (body?.ref === `refs/heads/${INPUT.epicBranch}`) return routes.createEpic ?? jsonResponse(201, {});
        return routes.create ?? jsonResponse(201, {});
      }
      if (url.includes("/compare/")) return routes.compare ?? jsonResponse(200, { ahead_by: 0 });
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  return calls;
}

function created(calls: Call[], branch: string): Call | undefined {
  return calls.find((call) => call.method === "POST" && call.body?.ref === `refs/heads/${branch}`);
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

    expect(calls.some((call) => call.url.includes("/compare/"))).toBe(false);
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

  describe("when the epic branch does not exist yet", () => {
    it("creates it from the registry ref's head, then cuts the story branch from it", async () => {
      const calls = stubGitHub({ epicRef: () => jsonResponse(404, { message: "Not Found" }) });

      await createStoryBranch("gh-token", INPUT);

      expect(created(calls, INPUT.epicBranch)?.body?.sha).toBe("mainsha");
      expect(created(calls, INPUT.storyBranch)?.body?.sha).toBe("mainsha");
    });

    it("never creates the epic branch when it already exists", async () => {
      const calls = stubGitHub({});

      await createStoryBranch("gh-token", INPUT);

      expect(created(calls, INPUT.epicBranch)).toBeUndefined();
      expect(calls.some((call) => call.url.endsWith(`/git/ref/heads/${REPO_BASE.ref}`))).toBe(false);
      expect(created(calls, INPUT.storyBranch)?.body?.sha).toBe("epicsha");
    });

    it("uses the branch another dispatch just created, when it loses that race", async () => {
      // Two stories under one epic dispatched together: both see the 404, and
      // the second create gets "already exists". The story is cut from where
      // the epic branch actually points, not from an assumed base sha.
      let reads = 0;
      const calls = stubGitHub({
        epicRef: () => (reads++ === 0 ? jsonResponse(404, { message: "Not Found" }) : jsonResponse(200, { object: { sha: "racedsha" } })),
        createEpic: jsonResponse(422, { message: "Reference already exists" }),
      });

      await createStoryBranch("gh-token", INPUT);

      expect(created(calls, INPUT.storyBranch)?.body?.sha).toBe("racedsha");
    });

    it("fails without retrying, naming the ref, when the registry ref cannot be read", async () => {
      stubGitHub({
        epicRef: () => jsonResponse(404, { message: "Not Found" }),
        baseRef: jsonResponse(404, { message: "Not Found" }),
      });

      await expect(createStoryBranch("gh-token", INPUT)).rejects.toMatchObject({
        type: "BaseRefUnreadable",
        nonRetryable: true,
        message: expect.stringMatching(/registry ref "main" returned 404/),
      });
    });
  });

  it("still reports an epic branch that cannot be read for a reason other than a 404, without creating anything", async () => {
    const calls = stubGitHub({ epicRef: () => jsonResponse(403, { message: "Forbidden" }) });

    await expect(createStoryBranch("gh-token", INPUT)).rejects.toMatchObject({ type: "EpicBranchUnreadable", nonRetryable: true });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
