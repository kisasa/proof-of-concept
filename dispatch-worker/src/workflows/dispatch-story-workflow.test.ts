/**
 * Workflow-level tests, per the Temporal TypeScript SDK's own testing
 * guidance: a real (local) Temporal test server plus a Worker running the
 * real workflow code against mocked activities — not just unit tests of the
 * activities' pure helper functions. `createLocal()` over
 * `createTimeSkipping()`: this workflow has no workflow-level timers to
 * skip through (the only sleep lives inside `awaitSpecialistTask`'s
 * activity code, invisible to the workflow sandbox), so time-skipping buys
 * nothing here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { dispatchStoryWorkflow } from "./dispatch-story-workflow.js";

const WORKFLOWS_PATH = fileURLToPath(new URL("./dispatch-story-workflow.ts", import.meta.url));

const TARGET = {
  repoBase: { host: "github", org: "example-org", repo: "example-api", ref: "main" },
  surfaces: [
    {
      surface: "backend",
      repoBase: { host: "github", org: "example-org", repo: "example-api", ref: "main" },
      path: "/",
      conventions: "CONVENTIONS.md",
      skills: [],
      status: "active" as const,
    },
  ],
};

const baseInput = {
  storyId: "PROJ-101",
  storyTitle: "Add refund endpoint",
  epicId: "PROJ-10",
  surfaces: ["backend"],
  storyBranch: "proj-101-refund-endpoint",
  epicBranch: "proj-10-refunds",
  maxTurns: 40,
  mover: { id: "00000000-0000-4000-8000-000000000001", name: "Example User", email: "user@example.com" },
};

const PR_URL = "https://github.com/example-org/example-api/pull/42";

function unexpectedCall(name: string) {
  return async () => {
    throw new Error(`${name} should not have been called on this path`);
  };
}

/** What the revision tests assert about each `dispatchSpecialist` call. */
interface DispatchRecord {
  readonly maxTurns: number;
  readonly revision?: { readonly round: number; readonly roundCap: number; readonly pullRequestNumber: number; readonly reviewId: number };
}

/** What they assert about each `awaitPullRequestOutcome` call. */
interface WatchRecord {
  readonly reviewerLogin: string | null;
  readonly afterReviewId: number | null;
  readonly watchForChangeRequests: boolean;
}

/**
 * Everything up to and including the PR existing, which every revision test
 * needs identically — the interesting assertions all live after that point.
 * Pass a `dispatches` array to record what each dispatch was asked for.
 */
function happyPathUpToPullRequest(dispatches?: DispatchRecord[]) {
  return {
    checkDependencies: async () => ({ ready: true, blockedBy: [] }),
    resolveSurfaces: async () => TARGET,
    createStoryBranch: async () => {},
    dispatchSpecialist: async (input: DispatchRecord) => {
      dispatches?.push(input);
      return "arn:aws:ecs:us-east-1:123:task/example-specialist-prod/abc123";
    },
    postSpecialistStarted: async () => "comment-1",
    awaitSpecialistTask: async () => {},
    deleteSpecialistProgressComment: async () => {},
    findPullRequest: async () => ({ number: 42, url: PR_URL }),
  };
}

describe("dispatchStoryWorkflow", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it("short-circuits to not-ready without touching any later activity, but does move the story back to Todo", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-not-ready";
    const movedStoryIds: string[] = [];

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        checkDependencies: async () => ({ ready: false, blockedBy: ["PROJ-42"] }),
        resolveSurfaces: unexpectedCall("resolveSurfaces"),
        createStoryBranch: unexpectedCall("createStoryBranch"),
        dispatchSpecialist: unexpectedCall("dispatchSpecialist"),
        postSpecialistStarted: unexpectedCall("postSpecialistStarted"),
        awaitSpecialistTask: unexpectedCall("awaitSpecialistTask"),
        deleteSpecialistProgressComment: unexpectedCall("deleteSpecialistProgressComment"),
        findPullRequest: unexpectedCall("findPullRequest"),
        requestPullRequestReviewer: unexpectedCall("requestPullRequestReviewer"),
        awaitPullRequestOutcome: unexpectedCall("awaitPullRequestOutcome"),
        postPullRequestNotice: unexpectedCall("postPullRequestNotice"),
        editPullRequestNotice: unexpectedCall("editPullRequestNotice"),
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: async (storyId: string) => {
          movedStoryIds.push(storyId);
        },
      },
    });

    await worker.runUntil(async () => {
      const result = await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-not-ready-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
      expect(result).toEqual({ outcome: "not-ready", blockedBy: ["PROJ-42"] });
    });

    expect(movedStoryIds).toEqual([baseInput.storyId]);
  }, 30_000);

  it("skips PR-watching and moves the story back to Todo when the specialist's run leaves no PR behind", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-not-complete";
    const movedStoryIds: string[] = [];

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        checkDependencies: async () => ({ ready: true, blockedBy: [] }),
        resolveSurfaces: async () => TARGET,
        createStoryBranch: async () => {},
        dispatchSpecialist: async () => "arn:aws:ecs:us-east-1:123:task/example-specialist-prod/abc123",
        postSpecialistStarted: async () => "comment-1",
        awaitSpecialistTask: async () => {},
        deleteSpecialistProgressComment: async () => {},
        findPullRequest: async () => null,
        requestPullRequestReviewer: unexpectedCall("requestPullRequestReviewer"),
        awaitPullRequestOutcome: unexpectedCall("awaitPullRequestOutcome"),
        postPullRequestNotice: unexpectedCall("postPullRequestNotice"),
        editPullRequestNotice: unexpectedCall("editPullRequestNotice"),
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: async (storyId: string) => {
          movedStoryIds.push(storyId);
        },
      },
    });

    await worker.runUntil(async () => {
      const result = await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-not-complete-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
      expect(result).toEqual({ outcome: "no-pr" });
    });

    expect(movedStoryIds).toEqual([baseInput.storyId]);
  }, 30_000);

  it("runs the full sequence and returns the specialist's outcome", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-full-sequence";
    const calls: string[] = [];

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        checkDependencies: async () => {
          calls.push("checkDependencies");
          return { ready: true, blockedBy: [] };
        },
        resolveSurfaces: async () => {
          calls.push("resolveSurfaces");
          return TARGET;
        },
        createStoryBranch: async () => {
          calls.push("createStoryBranch");
        },
        dispatchSpecialist: async () => {
          calls.push("dispatchSpecialist");
          return "arn:aws:ecs:us-east-1:123:task/example-specialist-prod/abc123";
        },
        postSpecialistStarted: async () => {
          calls.push("postSpecialistStarted");
          return "comment-1";
        },
        awaitSpecialistTask: async () => {
          calls.push("awaitSpecialistTask");
        },
        deleteSpecialistProgressComment: async () => {
          calls.push("deleteSpecialistProgressComment");
        },
        findPullRequest: async () => {
          calls.push("findPullRequest");
          return { number: 42, url: "https://github.com/example-org/example-api/pull/42" };
        },
        requestPullRequestReviewer: async () => {
          calls.push("requestPullRequestReviewer");
          return "example-reviewer";
        },
        awaitPullRequestOutcome: async () => {
          calls.push("awaitPullRequestOutcome");
          return { outcome: "merged" };
        },
        postPullRequestNotice: unexpectedCall("postPullRequestNotice"),
        editPullRequestNotice: unexpectedCall("editPullRequestNotice"),
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: unexpectedCall("moveStoryToTodo"),
      },
    });

    await worker.runUntil(async () => {
      const result = await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-full-sequence-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
      expect(result).toEqual({
        outcome: "complete",
        pullRequest: { number: 42, url: "https://github.com/example-org/example-api/pull/42", merged: true },
      });
    });

    expect(calls).toEqual([
      "checkDependencies",
      "resolveSurfaces",
      "createStoryBranch",
      "dispatchSpecialist",
      "postSpecialistStarted",
      "awaitSpecialistTask",
      "deleteSpecialistProgressComment",
      "findPullRequest",
      "requestPullRequestReviewer",
      "awaitPullRequestOutcome",
    ]);
  }, 30_000);

  it("posts a dispatch-failed comment naming the real cause, moves the story back to Todo, then still fails the workflow (never silent)", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-unanticipated-failure";
    const postedMessages: string[] = [];
    const movedStoryIds: string[] = [];

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        checkDependencies: async () => ({ ready: true, blockedBy: [] }),
        resolveSurfaces: async () => TARGET,
        // No activity anticipates this failure with its own comment — the
        // exact shape of today's real createStoryBranch/GitHub-404 incident.
        createStoryBranch: async () => {
          throw new Error("Could not read epic branch \"proj-10-refunds\" in example-org/example-api: GitHub returned 404");
        },
        dispatchSpecialist: unexpectedCall("dispatchSpecialist"),
        postSpecialistStarted: unexpectedCall("postSpecialistStarted"),
        awaitSpecialistTask: unexpectedCall("awaitSpecialistTask"),
        deleteSpecialistProgressComment: unexpectedCall("deleteSpecialistProgressComment"),
        findPullRequest: unexpectedCall("findPullRequest"),
        requestPullRequestReviewer: unexpectedCall("requestPullRequestReviewer"),
        awaitPullRequestOutcome: unexpectedCall("awaitPullRequestOutcome"),
        postPullRequestNotice: unexpectedCall("postPullRequestNotice"),
        editPullRequestNotice: unexpectedCall("editPullRequestNotice"),
        postDispatchFailed: async (_storyId: string, message: string) => {
          postedMessages.push(message);
        },
        moveStoryToTodo: async (storyId: string) => {
          movedStoryIds.push(storyId);
        },
      },
    });

    await worker.runUntil(async () => {
      await expect(
        client.workflow.execute(dispatchStoryWorkflow, {
          workflowId: "test-unanticipated-failure-1",
          taskQueue: taskQueue,
          args: [baseInput],
        }),
      ).rejects.toThrow();
    });

    expect(postedMessages).toEqual(['Could not read epic branch "proj-10-refunds" in example-org/example-api: GitHub returned 404']);
    expect(movedStoryIds).toEqual([baseInput.storyId]);
  }, 30_000);

  it("moves the story back to Todo when the PR is closed without merging", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-pr-closed";
    const movedStoryIds: string[] = [];

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        ...happyPathUpToPullRequest(),
        requestPullRequestReviewer: async () => "example-reviewer",
        awaitPullRequestOutcome: async () => ({ outcome: "closed" }),
        postPullRequestNotice: unexpectedCall("postPullRequestNotice"),
        editPullRequestNotice: unexpectedCall("editPullRequestNotice"),
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: async (storyId: string) => {
          movedStoryIds.push(storyId);
        },
      },
    });

    await worker.runUntil(async () => {
      const result = await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-pr-closed-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
      expect(result).toEqual({
        outcome: "complete",
        pullRequest: { number: 42, url: PR_URL, merged: false },
      });
    });

    // Nothing running and no PR left to watch — the condition the board rule
    // retreats a story for. A closed PR is also where the specialist's
    // "close it, reshape the story, run it again" recommendation lands.
    expect(movedStoryIds).toEqual([baseInput.storyId]);
  }, 30_000);

  it("dispatches a revision round on a change request, with its own turn budget, then resumes watching past that review", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-revision-round";
    const dispatches: DispatchRecord[] = [];
    const watches: WatchRecord[] = [];
    const notices: string[] = [];
    const edits: string[] = [];

    let watchCall = 0;
    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        ...happyPathUpToPullRequest(dispatches),
        requestPullRequestReviewer: async () => "example-reviewer",
        awaitPullRequestOutcome: async (input: WatchRecord) => {
          watches.push(input);
          watchCall += 1;
          if (watchCall === 1) {
            return { outcome: "changes-requested", changeRequest: { reviewId: 501, submittedAt: "2026-09-19T10:00:00Z" } };
          }
          return { outcome: "merged" };
        },
        postPullRequestNotice: async (_repoBase: unknown, _prNumber: number, body: string) => {
          notices.push(body);
          return 9001;
        },
        editPullRequestNotice: async (_repoBase: unknown, _commentId: number, body: string) => {
          edits.push(body);
        },
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: unexpectedCall("moveStoryToTodo"),
      },
    });

    await worker.runUntil(async () => {
      const result = await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-revision-round-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
      expect(result.pullRequest?.merged).toBe(true);
    });

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]?.revision).toBeUndefined();
    expect(dispatches[0]?.maxTurns).toBe(baseInput.maxTurns);

    // The revision budget is deliberately unrelated to the build's.
    expect(dispatches[1]?.maxTurns).toBe(25);
    expect(dispatches[1]?.revision).toEqual({ round: 1, roundCap: 3, pullRequestNumber: 42, reviewId: 501 });

    // The watermark, not the review state: the second watch must ignore the
    // review it just acted on, or the same one re-fires on every poll.
    expect(watches[0]?.afterReviewId).toBeNull();
    expect(watches[0]?.watchForChangeRequests).toBe(true);
    expect(watches[1]?.afterReviewId).toBe(501);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Revision round 1 of 3");
    expect(edits[0]).toContain("finished");
    expect(edits[0]).toContain("2 of 3 rounds remaining");
  }, 30_000);

  it("stops dispatching at the round cap, says so on the PR, and keeps watching for merge", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-round-cap";
    const dispatches: DispatchRecord[] = [];
    const watches: WatchRecord[] = [];
    const notices: string[] = [];

    let watchCall = 0;
    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        ...happyPathUpToPullRequest(dispatches),
        requestPullRequestReviewer: async () => "example-reviewer",
        awaitPullRequestOutcome: async (input: WatchRecord) => {
          watches.push(input);
          watchCall += 1;
          if (watchCall <= 3) {
            return {
              outcome: "changes-requested",
              changeRequest: { reviewId: 500 + watchCall, submittedAt: "2026-09-19T10:00:00Z" },
            };
          }
          return { outcome: "merged" };
        },
        postPullRequestNotice: async (_repoBase: unknown, _prNumber: number, body: string) => {
          notices.push(body);
          return 9001;
        },
        editPullRequestNotice: async () => {},
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: unexpectedCall("moveStoryToTodo"),
      },
    });

    await worker.runUntil(async () => {
      await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-round-cap-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
    });

    // One build plus exactly three revisions, never a fourth.
    expect(dispatches).toHaveLength(4);
    expect(dispatches[3]?.revision?.round).toBe(3);

    // The fourth watch still runs — merge detection outlives the cap — but
    // it is no longer listening for reviews.
    expect(watches).toHaveLength(4);
    expect(watches[3]?.watchForChangeRequests).toBe(false);

    const exhausted = notices.filter((body) => body.includes("No revision rounds remaining"));
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toContain("still being watched for merge or close");
  }, 30_000);

  it("says on the PR that revision requests are off when the mover maps to no GitHub login", async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = "test-unmatched-reviewer";
    const watches: WatchRecord[] = [];
    const notices: string[] = [];

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        ...happyPathUpToPullRequest(),
        requestPullRequestReviewer: async () => null,
        awaitPullRequestOutcome: async (input: WatchRecord) => {
          watches.push(input);
          return { outcome: "merged" };
        },
        postPullRequestNotice: async (_repoBase: unknown, _prNumber: number, body: string) => {
          notices.push(body);
          return 9001;
        },
        editPullRequestNotice: unexpectedCall("editPullRequestNotice"),
        postDispatchFailed: unexpectedCall("postDispatchFailed"),
        moveStoryToTodo: unexpectedCall("moveStoryToTodo"),
      },
    });

    await worker.runUntil(async () => {
      await client.workflow.execute(dispatchStoryWorkflow, {
        workflowId: "test-unmatched-reviewer-1",
        taskQueue: taskQueue,
        args: [baseInput],
      });
    });

    // Said once, up front. A developer whose "request changes" goes nowhere
    // would otherwise have nothing anywhere telling them why.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Revision requests are off for this story");
    expect(notices[0]).toContain("Example User");
    expect(watches[0]?.reviewerLogin).toBeNull();
  }, 30_000);
});
