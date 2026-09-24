import { describe, expect, it, vi } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { awaitPullRequestOutcome, pickChangeRequest, summarizeCheckRuns } from "./await-pull-request-outcome.js";
import type { GitHubReview } from "./await-pull-request-outcome.js";

const PR_NUMBER = 42;

function state(overrides: Partial<{ merged: boolean; state: "open" | "closed"; statusSummary: string }> = {}) {
  return { merged: false, state: "open" as const, statusSummary: "CI: 0/0 passed", ...overrides };
}

describe("summarizeCheckRuns", () => {
  it("reports no checks yet when none have been reported", () => {
    expect(summarizeCheckRuns({ total_count: 0, check_runs: [] })).toBe("no CI checks reported yet");
  });

  it("counts passed, failed, and pending separately", () => {
    const checks = {
      total_count: 5,
      check_runs: [
        { status: "completed" as const, conclusion: "success" },
        { status: "completed" as const, conclusion: "success" },
        { status: "completed" as const, conclusion: "success" },
        { status: "completed" as const, conclusion: "failure" },
        { status: "in_progress" as const, conclusion: null },
      ],
    };
    expect(summarizeCheckRuns(checks)).toBe("CI: 3/5 passed, 1 failed, 1 pending");
  });

  it("reports all-passed with no failed/pending clauses", () => {
    const checks = {
      total_count: 2,
      check_runs: [
        { status: "completed" as const, conclusion: "success" },
        { status: "completed" as const, conclusion: "success" },
      ],
    };
    expect(summarizeCheckRuns(checks)).toBe("CI: 2/2 passed");
  });
});

describe("awaitPullRequestOutcome", () => {
  it("polls until merged, heartbeating every intermediate status", async () => {
    const statuses = [
      state({ statusSummary: "CI: 0/2 passed, 2 pending" }),
      state({ statusSummary: "CI: 1/2 passed, 1 failed" }),
      state({ statusSummary: "CI: 2/2 passed" }),
      state({ merged: true, state: "closed", statusSummary: "merged" }),
    ];
    let call = 0;
    const getPullRequestState = vi.fn(async () => statuses[call++]!);

    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on("heartbeat", (details: unknown) => heartbeats.push(details));

    const outcome = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, null, 1);

    expect(outcome).toEqual({ outcome: "merged" });
    expect(getPullRequestState).toHaveBeenCalledTimes(4);
    expect(getPullRequestState).toHaveBeenNthCalledWith(1, PR_NUMBER);
    expect(heartbeats).toEqual(["CI: 0/2 passed, 2 pending", "CI: 1/2 passed, 1 failed", "CI: 2/2 passed"]);
  });

  it("resolves immediately, without heartbeating, when already merged", async () => {
    const getPullRequestState = vi.fn(async () => state({ merged: true, state: "closed", statusSummary: "merged" }));
    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on("heartbeat", (details: unknown) => heartbeats.push(details));

    const outcome = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, null, 1);

    expect(outcome).toEqual({ outcome: "merged" });
    expect(getPullRequestState).toHaveBeenCalledTimes(1);
    expect(heartbeats).toEqual([]);
  });

  it("resolves to closed when the PR is closed without merging", async () => {
    const getPullRequestState = vi.fn(async () => state({ merged: false, state: "closed", statusSummary: "closed without merging" }));
    const env = new MockActivityEnvironment();

    const outcome = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, null, 1);

    expect(outcome).toEqual({ outcome: "closed" });
  });

  it("keeps polling through a failing CI conclusion rather than treating it as terminal", async () => {
    const statuses = [state({ statusSummary: "CI: 0/1 passed, 1 failed" }), state({ merged: true, state: "closed", statusSummary: "merged" })];
    let call = 0;
    const getPullRequestState = vi.fn(async () => statuses[call++]!);
    const env = new MockActivityEnvironment();

    const outcome = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, null, 1);

    expect(outcome).toEqual({ outcome: "merged" });
    expect(getPullRequestState).toHaveBeenCalledTimes(2);
  });

  it("rejects when the activity is cancelled mid-poll", async () => {
    const getPullRequestState = vi.fn(async () => state());
    const env = new MockActivityEnvironment();

    const runPromise = env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, null, 50);
    setTimeout(() => env.cancel(), 10);

    await expect(runPromise).rejects.toThrow();
  });
});

describe("pickChangeRequest", () => {
  function review(overrides: Partial<GitHubReview> = {}): GitHubReview {
    return {
      id: 500,
      user: { login: "example-reviewer" },
      state: "CHANGES_REQUESTED",
      body: "please fix",
      submitted_at: "2026-09-19T10:00:00Z",
      ...overrides,
    };
  }

  it("picks the reviewer-of-record's change request", () => {
    expect(pickChangeRequest([review()], "example-reviewer", null)?.id).toBe(500);
  });

  it("ignores reviews from anyone else", () => {
    // Otherwise any passer-by could spend an ECS task rewriting someone
    // else's story, and "one named human owns this review" stops holding.
    expect(pickChangeRequest([review({ user: { login: "someone-else" } })], "example-reviewer", null)).toBeNull();
  });

  it("ignores approvals and plain comments from the same reviewer", () => {
    const reviews = [review({ id: 501, state: "APPROVED" }), review({ id: 502, state: "COMMENTED" })];
    expect(pickChangeRequest(reviews, "example-reviewer", null)).toBeNull();
  });

  it("ignores a review at or below the watermark", () => {
    // The decisive case: "changes requested" persists until the reviewer
    // clears it, so without the watermark the same review would re-fire on
    // every poll and dispatch a round each time.
    expect(pickChangeRequest([review({ id: 500 })], "example-reviewer", 500)).toBeNull();
    expect(pickChangeRequest([review({ id: 501 })], "example-reviewer", 500)?.id).toBe(501);
  });

  it("takes the newest when several are unactioned", () => {
    const reviews = [review({ id: 503 }), review({ id: 501 }), review({ id: 502 })];
    expect(pickChangeRequest(reviews, "example-reviewer", null)?.id).toBe(503);
  });

  it("matches logins case-insensitively", () => {
    // The mapping table is hand-maintained, so capitalisation that differs
    // from GitHub's would otherwise silently disable revisions.
    expect(pickChangeRequest([review({ user: { login: "Example-Reviewer" } })], "example-reviewer", null)?.id).toBe(500);
  });

  it("tolerates a review whose author is gone", () => {
    expect(pickChangeRequest([review({ user: null })], "example-reviewer", null)).toBeNull();
  });
});

describe("awaitPullRequestOutcome — change requests", () => {
  it("returns the change request instead of continuing to poll", async () => {
    const getPullRequestState = vi.fn(async () => state());
    const changeRequest = { reviewId: 501, submittedAt: "2026-09-19T10:00:00Z" };
    const getChangeRequest = vi.fn(async () => changeRequest);
    const env = new MockActivityEnvironment();

    const result = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, getChangeRequest, 1);

    expect(result).toEqual({ outcome: "changes-requested", changeRequest: changeRequest });
    expect(getPullRequestState).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the reviewer has said nothing new", async () => {
    const states = [state(), state(), state({ merged: true, state: "closed", statusSummary: "merged" })];
    let call = 0;
    const getPullRequestState = vi.fn(async () => states[call++]!);
    const getChangeRequest = vi.fn(async () => null);
    const env = new MockActivityEnvironment();

    const result = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, getChangeRequest, 1);

    expect(result).toEqual({ outcome: "merged" });
    expect(getChangeRequest).toHaveBeenCalledTimes(2);
  });

  it("lets a merge win over a change request submitted on the same PR", async () => {
    // Merged is terminal and irreversible; a change request is not. Checking
    // it first would dispatch a revision round against a merged PR.
    const getPullRequestState = vi.fn(async () => state({ merged: true, state: "closed", statusSummary: "merged" }));
    const getChangeRequest = vi.fn(async () => ({ reviewId: 501, submittedAt: "2026-09-19T10:00:00Z" }));
    const env = new MockActivityEnvironment();

    const result = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, getChangeRequest, 1);

    expect(result).toEqual({ outcome: "merged" });
    expect(getChangeRequest).not.toHaveBeenCalled();
  });

  it("never looks for change requests when it was told not to watch for them", async () => {
    const states = [state(), state({ merged: true, state: "closed", statusSummary: "merged" })];
    let call = 0;
    const getPullRequestState = vi.fn(async () => states[call++]!);
    const env = new MockActivityEnvironment();

    const result = await env.run(awaitPullRequestOutcome, PR_NUMBER, getPullRequestState, null, 1);

    expect(result).toEqual({ outcome: "merged" });
  });
});
