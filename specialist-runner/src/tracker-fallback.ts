/**
 * One direct Linear write, outside the Agent SDK entirely: a comment on the
 * story when the runner fails before Claude gets a turn (the git clone fails,
 * the SDK throws on startup). Mirrors why `postErrorComment` exists in
 * `webhook-listener/src/tracker-notifier.ts` — an infra failure has no Claude
 * turn to narrate it, so the app must, and Claude's own Linear MCP tool is
 * unavailable if it never started.
 *
 * Deliberately the only tracker write this package makes directly. Every
 * other write (the story's actual completion/waiting/blocked report) is the
 * specialist's own, through its Linear MCP tool calls — this function exists
 * only for the one case where that path never opened.
 *
 * Mirrors tracker-notifier.ts's own request shape (same mutation, same raw
 * API-key header, same GraphQL endpoint) rather than reinventing it.
 */

import { createLogger } from "./logger.js";
import { envOr } from "./env.js";

const log = createLogger("tracker-fallback");

const LINEAR_API_URL = envOr("LINEAR_API_URL", "https://api.linear.app/graphql");

export async function postFallbackComment(storyId: string, apiKey: string, message: string): Promise<void> {
  if (!apiKey) {
    log.error(`cannot post fallback comment on ${storyId} — LINEAR_AGENT_API_KEY is not set`);
    return;
  }

  const body = `**Specialist run failed to start** _(automated)_\n\n${message}`;

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({
        query: `mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment { id } } }`,
        variables: { i: { issueId: storyId, body: body } },
      }),
    });
    const json = (await res.json()) as { data?: unknown; errors?: unknown };
    if (!res.ok || json.errors) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
    }
    log.info(`posted fallback comment on ${storyId}`);
  } catch (err) {
    // Nowhere else to surface this — swallowed after logging, same as every
    // fire-and-forget write in tracker-notifier.ts.
    log.error(`failed to post fallback comment on ${storyId}: ${String(err)}`);
  }
}
