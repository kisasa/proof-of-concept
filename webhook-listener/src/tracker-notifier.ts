/**
 * The app's tracker writes outside of Claude's own MCP calls — kept
 * deliberately small, and every case documented here rather than left to
 * accumulate silently elsewhere:
 *
 *   postActivationStarted — posted right before opening the Anthropic stream,
 *     not after Claude's first move. Some activations (adaptive thinking +
 *     MCP tool use) run for minutes before Claude makes its own first
 *     tracker write; without this, a human watching the tracker sees nothing
 *     happen in the meantime. Returns the created comment's id so the caller
 *     can keep it current — see updateActivationProgress.
 *   updateActivationProgress — edits that same comment in place every so
 *     often for a long-running activation, rather than posting a new comment
 *     each time (which would spam the thread). One evolving status line, not
 *     a growing stack of near-identical comments.
 *   postErrorComment — the two enumerated failure modes the app itself must
 *     catch, because Claude never got (or never used) a clean turn to
 *     narrate either:
 *       (a) infra failure — the Anthropic call itself never completed
 *       (b) explicit tool failure — an mcp_tool_result block shows an error
 *   deleteComment — removes the activation-started comment once a run
 *     concludes cleanly. Only called on the clean-success path: on any
 *     failure the comment stays, as a trace of how long the run ran before
 *     the error comment posted. On success it's pure noise — Claude's own
 *     comments already narrate what happened, and a "still going" line left
 *     behind reads as stuck.
 *
 * All four are the deliberate exceptions to "Claude's own MCP writes only"
 * on the happy path — everything else (comments, labels, the authorized
 * status move) stays Claude's. All four are fire-and-forget: one attempt,
 * no retry, no read-back to confirm the write landed. If the write itself
 * fails, that failure is logged and swallowed — there is no other channel to
 * surface it through, and none of the four should ever block the
 * activation they're attached to.
 *
 * VERIFY: CommentUpdateInput's shape — assumed `{ body: string }`, mirroring
 * CommentCreateInput — unconfirmed against the live schema.
 */

import { createLogger } from "./logger.js";
import { envOr } from "./env.js";
import type { EntityType } from "./tracker-event.js";

const log = createLogger("tracker-notifier");

export interface TrackerNotifier {
  // Returns the created comment's id, or null if the post itself failed —
  // callers use that id to keep the comment current, and skip doing so if
  // it's null (nothing to update).
  postActivationStarted(
    entityId: string,
    entityType: EntityType,
    traceId: string,
    laneName: string,
    timeoutMinutes: number,
    quip: string,
  ): Promise<string | null>;
  updateActivationProgress(
    commentId: string,
    traceId: string,
    laneName: string,
    elapsedMs: number,
    timeoutMinutes: number,
    quip: string,
    attempt: number,
  ): Promise<void>;
  postErrorComment(entityId: string, entityType: EntityType, traceId: string, message: string): Promise<void>;
  deleteComment(commentId: string, traceId: string): Promise<void>;
}

const DEFAULT_API_URL = "https://api.linear.app/graphql";

// One-liners, not a running joke — a single quip is picked once per
// activation (by the caller, so every update on one run repeats the same
// line rather than shuffling underneath the reader) and threaded through.
const PATIENCE_QUIPS = [
  "Good things take time — this is one of those things.",
  "Slow is smooth, smooth is fast.",
  "Rome wasn't sliced into epics in a day.",
  "The tortoise reads the whole BRD before it moves.",
  "Patience: the art of watching a status comment update itself.",
  "A checkpoint rushed is a checkpoint reopened.",
  "The API map gets read once and drawn once — no shortcuts either way.",
  "Confirm rows don't resolve themselves, but they will.",
  "Even a paused activation is still making progress.",
  "The map is being drawn, not guessed.",
  "Reading the whole thread takes longer than skimming it. That's the point.",
  "Still walking the codebase — existence is read here, never assumed.",
  "Every row is addressed to someone who has to read it.",
  "Decomposition is mostly deciding what not to cut.",
  "A good slice map beats a fast one, and takes about this long.",
];

export function pickPatienceQuip(): string {
  return PATIENCE_QUIPS[Math.floor(Math.random() * PATIENCE_QUIPS.length)] ?? "Good things take time.";
}

// Each attempt (the initial call, and every pause_turn resume after it) gets
// its own fresh requestTimeoutMs window from the SDK — a resume is a brand
// new HTTP request, not a continuation of the old one's clock. Observed
// 2026-07-20: a run spanning several continuations kept showing "~0m left
// before timeout" for over an hour past the stated deadline, because the
// original wording promised one global countdown from the very first call
// while the code underneath was actually resetting the clock on every
// resume. Worded per-attempt now so the two agree.
function activationStartedBody(laneName: string, timeoutMinutes: number, quip: string): string {
  return (
    `**${laneName} is working on this** _(automated)_\n\n` +
    `This can take a few minutes — no action needed yet. Each attempt gets up to ${timeoutMinutes} minutes; if the ` +
    `server's own tool-call loop pauses partway through, it resumes automatically with a fresh ${timeoutMinutes}-minute ` +
    `window rather than picking up the old one's clock. I'll leave an error comment if it can't complete.\n\n` +
    `_${quip}_`
  );
}

function activationProgressBody(
  laneName: string,
  elapsedMs: number,
  timeoutMinutes: number,
  quip: string,
  attempt: number,
): string {
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  const remainingMinutes = Math.max(timeoutMinutes - elapsedMinutes, 0);
  const attemptNote = attempt > 1 ? ` (attempt ${attempt} — resumed after the server's tool-call loop paused)` : "";
  return (
    `**${laneName} is working on this** _(automated)_\n\n` +
    `This can take a few minutes — no action needed yet. Each attempt gets up to ${timeoutMinutes} minutes; if the ` +
    `server's own tool-call loop pauses partway through, it resumes automatically with a fresh ${timeoutMinutes}-minute ` +
    `window rather than picking up the old one's clock. I'll leave an error comment if it can't complete.\n\n` +
    `_Still going — ${elapsedMinutes}m elapsed this attempt${attemptNote}, ~${remainingMinutes}m left before this ` +
    `attempt's timeout, connection active._\n\n` +
    `_${quip}_`
  );
}

async function postComment(
  apiKey: string,
  baseUrl: string,
  entityId: string,
  entityType: EntityType,
  body: string,
): Promise<string | null> {
  if (!apiKey) throw new Error("LINEAR_AGENT_API_KEY is not set");
  const idField = entityType === "issue" ? "issueId" : "projectId";
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({
      query: `mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment { id } } }`,
      variables: { i: { [idField]: entityId, body: body } },
    }),
  });
  const json = (await res.json()) as {
    data?: { commentCreate?: { success: boolean; comment?: { id: string } } };
    errors?: unknown;
  };
  if (!res.ok || json.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
  }
  return json.data?.commentCreate?.comment?.id ?? null;
}

async function deleteCommentMutation(apiKey: string, baseUrl: string, commentId: string): Promise<void> {
  if (!apiKey) throw new Error("LINEAR_AGENT_API_KEY is not set");
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({
      query: `mutation($id:String!){ commentDelete(id:$id){ success } }`,
      variables: { id: commentId },
    }),
  });
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
  }
}

async function updateComment(apiKey: string, baseUrl: string, commentId: string, body: string): Promise<void> {
  if (!apiKey) throw new Error("LINEAR_AGENT_API_KEY is not set");
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({
      query: `mutation($id:String!,$i:CommentUpdateInput!){ commentUpdate(id:$id, input:$i){ success } }`,
      variables: { id: commentId, i: { body: body } },
    }),
  });
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
  }
}

/**
 * Creates a Linear-backed TrackerNotifier with an explicit API key.
 * Use this in tests to pass credentials directly without env var stubs.
 * The default export reads env vars at startup.
 */
export function createLinearTrackerNotifier(apiKey: string, baseUrl: string = DEFAULT_API_URL): TrackerNotifier {
  return {
    async postActivationStarted(
      entityId: string,
      entityType: EntityType,
      traceId: string,
      laneName: string,
      timeoutMinutes: number,
      quip: string,
    ): Promise<string | null> {
      const reqLog = log.child(traceId);
      reqLog.trace(`posting activation-started comment to ${entityType} ${entityId}`);
      try {
        const commentId = await postComment(
          apiKey,
          baseUrl,
          entityId,
          entityType,
          activationStartedBody(laneName, timeoutMinutes, quip),
        );
        reqLog.trace(`activation-started comment posted to ${entityType} ${entityId}, id=${commentId ?? "(unknown)"}`);
        return commentId;
      } catch (err) {
        // Never lets a failure here block the activation itself — this
        // comment is a courtesy, not a precondition.
        reqLog.warn(`failed to post activation-started comment for ${entityType} ${entityId}:`, err);
        return null;
      }
    },

    async updateActivationProgress(
      commentId: string,
      traceId: string,
      laneName: string,
      elapsedMs: number,
      timeoutMinutes: number,
      quip: string,
      attempt: number,
    ): Promise<void> {
      const reqLog = log.child(traceId);
      reqLog.trace(`updating progress comment ${commentId}, elapsedMs=${elapsedMs}, attempt=${attempt}`);
      try {
        await updateComment(
          apiKey,
          baseUrl,
          commentId,
          activationProgressBody(laneName, elapsedMs, timeoutMinutes, quip, attempt),
        );
        reqLog.trace(`progress comment ${commentId} updated`);
      } catch (err) {
        reqLog.warn(`failed to update progress comment ${commentId}:`, err);
      }
    },

    async postErrorComment(
      entityId: string,
      entityType: EntityType,
      traceId: string,
      message: string,
    ): Promise<void> {
      const reqLog = log.child(traceId);
      const body =
        `**Pipeline error** _(automated)_\n\n` +
        `The agent run for this ${entityType} did not complete.\n\n` +
        `**Error:** ${message}\n\n` +
        `Check the application logs for the full stack trace. Once resolved, re-trigger by adding a comment or re-applying the triggering label.`;

      reqLog.trace(`posting error comment to ${entityType} ${entityId}`);
      try {
        await postComment(apiKey, baseUrl, entityId, entityType, body);
        reqLog.trace(`error comment posted to ${entityType} ${entityId}`);
      } catch (err) {
        reqLog.error(`failed to post error comment for ${entityType} ${entityId}:`, err);
      }
    },

    async deleteComment(commentId: string, traceId: string): Promise<void> {
      const reqLog = log.child(traceId);
      reqLog.trace(`deleting progress comment ${commentId}`);
      try {
        await deleteCommentMutation(apiKey, baseUrl, commentId);
        reqLog.trace(`progress comment ${commentId} deleted`);
      } catch (err) {
        reqLog.warn(`failed to delete progress comment ${commentId}:`, err);
      }
    },
  };
}

// Default instance — credentials resolved from env at startup. activation-runner.ts imports this.
export default createLinearTrackerNotifier(
  process.env.LINEAR_AGENT_API_KEY ?? "",
  envOr("LINEAR_API_URL", DEFAULT_API_URL),
);
