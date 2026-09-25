/**
 * Mirrors `dispatch-worker/src/activities/move-story-to-todo.ts` — same
 * rationale, same "Todo" literal, no shared lib between the two packages
 * (this repo's existing "each package owns its own small client" pattern,
 * per `story-context.ts`'s own class comment). This one covers the failure
 * paths *before* a dispatch workflow ever starts — `dispatch-trigger.ts`'s
 * own "story isn't dispatchable" and "workflow could not start" branches —
 * which dispatch-worker's own `moveStoryToTodo` activity never gets a
 * chance to run for, since no workflow exists yet. Confirmed live
 * (2026-08-07): a live story hit exactly this — a bad specialist-type label
 * resolution failed before any workflow started, and the story was left in
 * "In Progress" with only an error comment, no automatic move back.
 *
 * Best-effort like every other courtesy write in this package: a
 * missing/renamed "Todo" status or a Linear error here is logged and
 * swallowed, never allowed to compound an already-failed dispatch attempt.
 */

import { createLogger } from "./logger.js";

const log = createLogger("move-story-to-todo");

const TODO_STATUS_NAME = "Todo";

interface GraphQlResponse<T> {
  data?: T;
  errors?: unknown;
}

async function graphql<T>(apiKey: string, baseUrl: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as GraphQlResponse<T>;
  if (!res.ok || json.errors || json.data === undefined) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
  }
  return json.data;
}

export async function moveStoryToTodo(storyId: string, apiKey: string, baseUrl: string, traceId: string): Promise<void> {
  const reqLog = log.child(traceId);
  try {
    const { issue } = await graphql<{ issue: { team: { id: string } } }>(
      apiKey,
      baseUrl,
      `query($id:String!){ issue(id:$id){ team { id } } }`,
      { id: storyId },
    );
    const { team } = await graphql<{ team: { states: { nodes: { id: string; name: string }[] } } }>(
      apiKey,
      baseUrl,
      `query($teamId:String!){ team(id:$teamId){ states { nodes { id name } } } }`,
      { teamId: issue.team.id },
    );
    const stateId = team.states.nodes.find((state) => state.name === TODO_STATUS_NAME)?.id;
    if (!stateId) {
      reqLog.warn(`no "${TODO_STATUS_NAME}" status found for story ${storyId}'s team — leaving its status unchanged`);
      return;
    }
    await graphql(apiKey, baseUrl, `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id, input:$i){ success } }`, {
      id: storyId,
      i: { stateId: stateId },
    });
    reqLog.trace(`moved story ${storyId} back to ${TODO_STATUS_NAME}`);
  } catch (err) {
    reqLog.warn(`failed to move story ${storyId} back to ${TODO_STATUS_NAME}:`, err);
  }
}
