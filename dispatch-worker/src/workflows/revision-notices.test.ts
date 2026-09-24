/**
 * The notice wording is the whole product of `revision-notices.ts` — a
 * developer reads these instead of reading the pipeline — so it is tested as
 * behaviour, not as strings: each case asserts the fact the reader has to
 * come away with.
 */

import { describe, it, expect } from "vitest";
import {
  reviewerUnmatchedNotice,
  revisionRoundFailedNotice,
  revisionRoundFinishedNotice,
  revisionRoundStartedNotice,
  revisionRoundsExhaustedNotice,
} from "./revision-notices.js";

describe("revision notices", () => {
  it("tells the reader where in the budget a starting round sits", () => {
    expect(revisionRoundStartedNotice(2, 3)).toContain("Revision round 2 of 3");
  });

  it("counts remaining rounds down, and singularises the last one", () => {
    expect(revisionRoundFinishedNotice(1, 3)).toContain("2 of 3 rounds remaining");
    expect(revisionRoundFinishedNotice(2, 3)).toContain("1 of 3 round remaining");
    expect(revisionRoundFinishedNotice(3, 3)).toContain("No rounds remaining");
  });

  it("never claims what the specialist did — that is the specialist's own reply", () => {
    const body = revisionRoundFinishedNotice(1, 3);
    expect(body).toContain("specialist's own reply");
    expect(body).toContain("only records that the round ran");
  });

  it("says plainly that a further review will not dispatch, and that merge is still watched", () => {
    const body = revisionRoundsExhaustedNotice(3);
    // Both halves matter: without the first a developer submits a fourth
    // review into silence; without the second they assume the PR was dropped.
    expect(body).toContain("will not dispatch the specialist");
    expect(body).toContain("still being watched for merge or close");
  });

  it("points an exhausted PR at reshaping the story, including the branch deletion a re-run needs", () => {
    const body = revisionRoundsExhaustedNotice(3);
    expect(body).toContain("adjusting the story");
    expect(body).toContain("delete the story branch first");
  });

  it("names the person when one is known, and falls back to their role when not", () => {
    expect(reviewerUnmatchedNotice("Example User")).toContain('"Example User"');
    expect(reviewerUnmatchedNotice(null)).toContain("whoever moved this story to In Progress");
  });

  it("keeps the unmatched-reviewer notice actionable without leaking an address into the target repo", () => {
    const body = reviewerUnmatchedNotice("Example User");
    expect(body).toContain("REVIEWER_EMAIL_TO_GITHUB_LOGIN");
    expect(body).not.toContain("@");
    expect(body).toContain("Reviewing and merging this PR are unaffected");
  });

  it("carries the real cause into a failed round and says nothing further will run", () => {
    const body = revisionRoundFailedNotice(2, 3, "RunTask failed to start the specialist: no container instances");
    expect(body).toContain("Revision round 2 of 3 failed");
    expect(body).toContain("no container instances");
    expect(body).toContain("moved back to Todo");
  });
});
