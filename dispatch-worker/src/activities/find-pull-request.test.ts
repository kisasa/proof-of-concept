import { describe, it, expect } from "vitest";
import { pickPullRequest, pickMergedPullRequest } from "./find-pull-request.js";

describe("pickPullRequest", () => {
  it("returns the first (and normally only) matching PR", () => {
    const candidates = [{ number: 42, html_url: "https://github.com/example-org/example-api/pull/42", merged_at: null }];
    expect(pickPullRequest(candidates)).toEqual({ number: 42, url: "https://github.com/example-org/example-api/pull/42" });
  });

  it("returns null when nothing matches", () => {
    expect(pickPullRequest([])).toBeNull();
  });
});

describe("pickMergedPullRequest", () => {
  it("returns the most recent closed PR when it was merged (a real observed race: merged before the open-check ran)", () => {
    const mostRecentFirst = [{ number: 7, html_url: "https://github.com/example-org/example-app/pull/7", merged_at: "2026-08-07T18:16:38.000Z" }];
    expect(pickMergedPullRequest(mostRecentFirst)).toEqual({ number: 7, url: "https://github.com/example-org/example-app/pull/7" });
  });

  it("returns null when the most recent closed PR was closed without merging", () => {
    const mostRecentFirst = [{ number: 9, html_url: "https://github.com/example-org/example-api/pull/9", merged_at: null }];
    expect(pickMergedPullRequest(mostRecentFirst)).toBeNull();
  });

  it("does not let an older merged PR shadow a newer closed-without-merging attempt", () => {
    const mostRecentFirst = [
      { number: 12, html_url: "https://github.com/example-org/example-api/pull/12", merged_at: null },
      { number: 9, html_url: "https://github.com/example-org/example-api/pull/9", merged_at: "2026-08-01T00:00:00.000Z" },
    ];
    expect(pickMergedPullRequest(mostRecentFirst)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickMergedPullRequest([])).toBeNull();
  });
});
