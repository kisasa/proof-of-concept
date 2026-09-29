import { describe, it, expect, vi, afterEach } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { createEnsureEpicPullRequestActivity, createMergeStoryPullRequestActivity } from "./story-merge.js";
import type { WorkerConfig } from "../worker-config.js";

const CONFIG = { githubToken: "gh-token", linearAgentApiKey: "lin-key" } as unknown as WorkerConfig;
const REPO_BASE = { host: "github", org: "example-org", repo: "example-api", ref: "p-o-c" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

/** Routes by method and URL, so each test states only the answers it cares about. */
function stubFetch(route: (method: string, url: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      return route(method, url);
    }),
  );
  return calls;
}

const env = new MockActivityEnvironment();

describe("mergeStoryPullRequest", () => {
  const merge = createMergeStoryPullRequestActivity(CONFIG);
  afterEach(() => vi.unstubAllGlobals());

  it("merges the PR with a merge commit, so the story branch stays an ancestor of the epic branch", async () => {
    const calls = stubFetch((method) =>
      method === "PUT" ? jsonResponse(200, { merged: true }) : jsonResponse(200, { number: 42, merged: false, state: "open" }),
    );

    expect(await env.run(merge, REPO_BASE, 42)).toBe(true);
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toMatch(/\/repos\/example-org\/example-api\/pulls\/42\/merge$/);
    expect(put?.body).toEqual({ merge_method: "merge" });
  });

  it("treats an already-merged PR as success without merging again", async () => {
    const calls = stubFetch(() => jsonResponse(200, { number: 42, merged: true, state: "closed" }));

    expect(await env.run(merge, REPO_BASE, 42)).toBe(true);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("returns false and says why on the PR when GitHub refuses the merge", async () => {
    const calls = stubFetch((method) => {
      if (method === "PUT") return jsonResponse(405, { message: "Pull Request is not mergeable" });
      if (method === "POST") return jsonResponse(201, { id: 1 });
      return jsonResponse(200, { number: 42, merged: false, state: "open" });
    });

    expect(await env.run(merge, REPO_BASE, 42)).toBe(false);
    const notice = calls.find((call) => call.method === "POST");
    expect(notice?.url).toMatch(/\/issues\/42\/comments$/);
    expect(String(notice?.body?.body)).toContain("405: Pull Request is not mergeable");
  });
});

describe("ensureEpicPullRequest", () => {
  const ensure = createEnsureEpicPullRequestActivity(CONFIG);
  afterEach(() => vi.unstubAllGlobals());

  const LINEAR_EPIC = {
    data: {
      issue: {
        id: "epic-uuid",
        identifier: "PROJ-9",
        title: "A consumer can run charge-card locally",
        description: "",
        branchName: "proj-9-run-charge-card",
        state: { type: "unstarted", name: "Evaluation" },
        team: { id: "team-1" },
        labels: { nodes: [] },
        comments: { nodes: [] },
      },
    },
  };

  it("returns the epic PR that is already open, without opening another", async () => {
    const calls = stubFetch(() => jsonResponse(200, [{ number: 7, html_url: "https://github.com/example-org/example-api/pull/7" }]));

    expect(await env.run(ensure, REPO_BASE, "epic-uuid", "proj-9-run-charge-card")).toEqual({
      number: 7,
      url: "https://github.com/example-org/example-api/pull/7",
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(calls[0]?.url).toContain("base=p-o-c");
  });

  it("opens the epic branch's PR into the registry's base branch, titled from the epic", async () => {
    const calls = stubFetch((method, url) => {
      if (url.includes("linear")) return jsonResponse(200, LINEAR_EPIC);
      if (method === "POST") return jsonResponse(201, { number: 8, html_url: "https://github.com/example-org/example-api/pull/8" });
      return jsonResponse(200, []);
    });

    expect(await env.run(ensure, REPO_BASE, "epic-uuid", "proj-9-run-charge-card")).toEqual({
      number: 8,
      url: "https://github.com/example-org/example-api/pull/8",
    });
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/pulls"));
    expect(created?.body).toMatchObject({
      title: "PROJ-9: A consumer can run charge-card locally",
      head: "proj-9-run-charge-card",
      base: "p-o-c",
    });
  });

  it("falls back to the branch name as the title when the epic cannot be read", async () => {
    const calls = stubFetch((method, url) => {
      if (url.includes("linear")) return jsonResponse(500, {});
      if (method === "POST") return jsonResponse(201, { number: 9, html_url: "https://github.com/example-org/example-api/pull/9" });
      return jsonResponse(200, []);
    });

    await env.run(ensure, REPO_BASE, "epic-uuid", "proj-9-run-charge-card");
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/pulls"))?.body?.title).toBe("proj-9-run-charge-card");
  });

  it("returns null rather than failing a merged story when the epic PR cannot be opened", async () => {
    stubFetch((method, url) => {
      if (url.includes("linear")) return jsonResponse(200, LINEAR_EPIC);
      if (method === "POST") return jsonResponse(422, { message: "Validation Failed" });
      return jsonResponse(200, []);
    });

    expect(await env.run(ensure, REPO_BASE, "epic-uuid", "proj-9-run-charge-card")).toBeNull();
  });
});
