/**
 * Linear reads/writes this package makes directly, outside any workflow —
 * activities are plain async functions with real IO, unlike workflow code,
 * which runs in Temporal's deterministic sandbox and must call out to
 * activities for anything like this. Mirrors
 * `webhook-listener/src/tracker-notifier.ts`'s own request shape (same
 * GraphQL endpoint, same raw-API-key `Authorization` header) rather than
 * reinventing it.
 *
 * VERIFY before relying on this in production (unconfirmed against the live
 * Linear schema, same category as tracker-notifier.ts's own flagged
 * assumptions): the exact field names for state type and branch name are
 * assumed to be `state { type name }` and `branchName` respectively, per
 * Linear's public API docs, not confirmed against a live query.
 */

import { envOr } from "./env.js";

export const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

export interface TrackerIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly branchName: string;
  /** Linear's WorkflowState.type — "completed" means Done. */
  readonly stateType: string;
  readonly teamId: string;
  readonly labels: string[];
  readonly comments: string[];
}

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

const ISSUE_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      branchName
      state { type name }
      team { id }
      labels { nodes { name } }
      comments { nodes { body } }
    }
  }
`;

interface IssueQueryResult {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    branchName: string;
    state: { type: string; name: string };
    team: { id: string };
    labels: { nodes: { name: string }[] };
    comments: { nodes: { body: string }[] };
  };
}

export async function getIssue(issueId: string, apiKey: string, baseUrl: string): Promise<TrackerIssue> {
  const { issue } = await graphql<IssueQueryResult>(apiKey, baseUrl, ISSUE_QUERY, { id: issueId });
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    branchName: issue.branchName,
    stateType: issue.state.type,
    teamId: issue.team.id,
    labels: issue.labels.nodes.map((label) => label.name),
    comments: issue.comments.nodes.map((comment) => comment.body),
  };
}

/**
 * Resolves a workflow-state id by exact name within one team — needed
 * because `IssueUpdateInput.stateId` (used to move an issue, e.g. back to
 * To-Do) takes an id, not a name, and state ids are per-team, not global.
 * Returns null rather than throwing on no match so callers can log and skip
 * the move rather than fail whatever triggered it — a renamed or missing
 * status shouldn't take down the caller's own real work.
 */
export async function findStateIdByName(teamId: string, name: string, apiKey: string, baseUrl: string): Promise<string | null> {
  const { team } = await graphql<{ team: { states: { nodes: { id: string; name: string }[] } } }>(
    apiKey,
    baseUrl,
    `query($teamId:String!){ team(id:$teamId){ states { nodes { id name } } } }`,
    { teamId: teamId },
  );
  return team.states.nodes.find((state) => state.name === name)?.id ?? null;
}

/** Moves an issue to a different workflow state — e.g. back to To-Do. */
export async function updateIssueState(issueId: string, stateId: string, apiKey: string, baseUrl: string): Promise<void> {
  await graphql(apiKey, baseUrl, `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id, input:$i){ success } }`, {
    id: issueId,
    i: { stateId: stateId },
  });
}

/**
 * Returns the created comment's id, or null if the response didn't carry
 * one — callers that need to keep the comment current (specialist-progress.ts)
 * use it; every existing caller just ignores the return value.
 */
export async function postComment(issueId: string, apiKey: string, baseUrl: string, body: string): Promise<string | null> {
  const data = await graphql<{ commentCreate: { success: boolean; comment?: { id: string } } }>(
    apiKey,
    baseUrl,
    `mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment { id } } }`,
    { i: { issueId: issueId, body: body } },
  );
  return data.commentCreate.comment?.id ?? null;
}

/**
 * Edits an existing comment in place — mirrors webhook-listener/src/
 * tracker-notifier.ts's own updateComment (same GraphQL shape, same
 * unconfirmed-CommentUpdateInput-shape caveat: assumed `{ body: string }`,
 * mirroring CommentCreateInput).
 */
export async function updateComment(commentId: string, apiKey: string, baseUrl: string, body: string): Promise<void> {
  await graphql(apiKey, baseUrl, `mutation($id:String!,$i:CommentUpdateInput!){ commentUpdate(id:$id, input:$i){ success } }`, {
    id: commentId,
    i: { body: body },
  });
}

/** Mirrors tracker-notifier.ts's own deleteComment. */
export async function deleteComment(commentId: string, apiKey: string, baseUrl: string): Promise<void> {
  await graphql(apiKey, baseUrl, `mutation($id:String!){ commentDelete(id:$id){ success } }`, { id: commentId });
}

export interface TrackerDocument {
  readonly title: string;
  readonly content: string;
}

/**
 * The documents attached to an issue, and the id of the project it belongs
 * to — both needed to find a surface registry: the epic's own
 * `Surfaces (override)` document, then the project's `Surfaces` document.
 *
 * VERIFY before relying on this in production (same category as the caveats
 * above): the `documents` connection on Issue and Project, and `content` as
 * the markdown body field on Document, are taken from Linear's public API
 * docs and the Linear MCP connector's own `save_document` (which attaches a
 * document to exactly one of project/issue/initiative/cycle/team), not
 * confirmed against a live query from this code.
 */
export async function getIssueDocuments(
  issueId: string,
  apiKey: string,
  baseUrl: string,
): Promise<{ projectId: string | null; documents: TrackerDocument[] }> {
  const data = await graphql<{
    issue: { project: { id: string } | null; documents: { nodes: { title: string; content: string | null }[] } };
  }>(
    apiKey,
    baseUrl,
    `query($id:String!){ issue(id:$id){ project { id } documents { nodes { title content } } } }`,
    { id: issueId },
  );
  return {
    projectId: data.issue.project?.id ?? null,
    documents: data.issue.documents.nodes.map((d) => ({ title: d.title, content: d.content ?? "" })),
  };
}

export async function getProjectDocuments(projectId: string, apiKey: string, baseUrl: string): Promise<TrackerDocument[]> {
  const data = await graphql<{ project: { documents: { nodes: { title: string; content: string | null }[] } } }>(
    apiKey,
    baseUrl,
    `query($id:String!){ project(id:$id){ documents { nodes { title content } } } }`,
    { id: projectId },
  );
  return data.project.documents.nodes.map((d) => ({ title: d.title, content: d.content ?? "" }));
}

export function linearApiUrl(): string {
  return envOr("LINEAR_API_URL", DEFAULT_LINEAR_API_URL);
}
