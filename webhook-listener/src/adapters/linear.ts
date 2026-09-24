/**
 * Linear adapter. The only file in the pipeline that knows Linear's specific payload
 * shape, header names, and environment variables. It produces TrackerEvents;
 * everything downstream is tracker-agnostic.
 *
 * Two Linear entity types feed this pipeline: Projects (Intake's home) and Issues
 * (Specification's and Decompose's home, both inside the Evaluation status). Both
 * fire the same three TrackerEvent kinds — label_added, status_changed,
 * comment_added — the routing layer decides which lane owns which.
 *
 * Confirmed against live payloads (2026-07-15): Issue/Project webhooks carry
 * `data.labelIds` / `updatedFrom.labelIds` as flat arrays of label ids — no
 * names, no nested `labels.nodes`. Label-only changes on a Project do NOT
 * additionally fire a "ProjectLabel"-typed event carrying the project id
 * (that event describes the label object itself, with no entity reference at
 * all — a dead end); the plain `Project`/`Issue` update event is the only
 * usable signal, gated on subscribing the webhook to that team specifically
 * (a webhook scoped to "all public teams" never fires for a private team).
 *
 * Confirmed against a live payload (2026-07-16): Linear does not emit a
 * webhook for comments added to a Project — only Issue/Document comments are
 * webhook-visible. A human's follow-up on a Project (Intake's entity type)
 * therefore can't arrive as a `Comment` event; it arrives as a `ProjectUpdate`
 * ("status update") post instead, mapped onto the same comment_added
 * TrackerEvent kind below. Posting a ProjectUpdate also fires a same-tick
 * `Project`/`update` webhook (health/lastUpdateId changed) — already a no-op
 * here since that branch only reacts to label/status changes.
 *
 * VERIFY before relying on this in production (marked inline, still
 * unconfirmed against a live payload):
 *   - `issueLabels` / `projectLabels` as the query root fields for resolving
 *     label ids to names, and `filter: { id: { in: $ids } }` as their filter
 *     shape — inferred from the "ProjectLabel" webhook resource-type naming
 *     and Linear's general query-naming convention, not confirmed against
 *     the live schema.
 *   - Project status shape — assumed `status { name }` (custom project statuses),
 *     confirmed shape-wise against a live payload, but the exact set of status
 *     names/types in use is engagement-specific.
 *
 * To support a different tracker, implement TrackerAdapter in a new file under
 * adapters/, export a default instance, and update the import in server.ts.
 * No other files change.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TrackerAdapter } from "./tracker-adapter";
import type { EntityType, TrackerActor, TrackerEvent } from "../tracker-event.js";
import { createLogger } from "../logger.js";
import { envOr } from "../env.js";

const log = createLogger("linear");

interface LinearWebhookActor {
  id: string;
  name: string;
  email?: string;
  type?: string;
}

interface LinearWebhook {
  action: "create" | "update" | "remove";
  type: "Issue" | "Project" | "Comment" | string;
  actor?: LinearWebhookActor;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  webhookTimestamp?: number;
}

/**
 * The top-level `actor` object is present on every Linear webhook regardless
 * of type — confirmed against live payloads 2026-08-06, both a human move
 * and an agent-driven one (the pipeline's own bot user, distinguishable by
 * id/email) on the same issue. `email` is technically optional in Linear's
 * own schema, so this still degrades to null rather than a partial object —
 * reviewer-of-record needs email to resolve a GitHub login and a partial
 * actor is useless for that.
 */
function extractActor(hook: LinearWebhook): TrackerActor | null {
  const actor = hook.actor;
  if (!actor || !actor.email) return null;
  return { id: actor.id, name: actor.name, email: actor.email };
}

const LINEAR_API = envOr("LINEAR_API_URL", "https://api.linear.app/graphql");

interface EntityContext {
  title: string;
  status: string;
  labels: string[];
}

/**
 * Comment webhooks carry only the comment and its parent's id — not the parent's
 * status, labels, or title. Fetch it separately so every TrackerEvent field is
 * populated regardless of source event type.
 */
async function fetchEntityContext(
  entityType: EntityType,
  entityId: string,
  apiKey: string,
  traceId: string,
): Promise<EntityContext | null> {
  const reqLog = log.child(traceId);
  const query =
    entityType === "issue"
      ? `query($id:String!){ issue(id:$id){ title state { name } labels { nodes { name } } } }`
      : `query($id:String!){ project(id:$id){ name status { name } labels { nodes { name } } } }`;

  reqLog.trace(`fetching entity context for ${entityType} ${entityId}`);
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: query, variables: { id: entityId } }),
  });
  if (!res.ok) {
    reqLog.error(`${entityType} fetch failed: ${res.status}`);
    return null;
  }

  const json = (await res.json()) as {
    data?: {
      issue?: { title?: string; state?: { name?: string }; labels?: { nodes?: { name: string }[] } };
      project?: { name?: string; status?: { name?: string }; labels?: { nodes?: { name: string }[] } };
    };
  };

  if (entityType === "issue") {
    const issue = json.data?.issue;
    if (!issue) return null;
    return {
      title: issue.title ?? "",
      status: issue.state?.name ?? "",
      labels: (issue.labels?.nodes ?? []).map((n) => n.name),
    };
  }

  const project = json.data?.project;
  if (!project) return null;
  return {
    title: project.name ?? "",
    status: project.status?.name ?? "",
    labels: (project.labels?.nodes ?? []).map((n) => n.name),
  };
}

/**
 * Issue/Project webhook payloads carry label ids only (data.labelIds,
 * updatedFrom.labelIds — flat arrays, no names). Routing matches labels by
 * name, so every id this adapter reports has to be resolved. Batched: one
 * call per event, not one per id.
 */
async function resolveLabelNames(
  entityType: EntityType,
  labelIds: string[],
  apiKey: string,
  traceId: string,
): Promise<Map<string, string>> {
  if (labelIds.length === 0) return new Map();
  const reqLog = log.child(traceId);
  const rootField = entityType === "issue" ? "issueLabels" : "projectLabels";

  reqLog.trace(`resolving ${labelIds.length} label id(s) via ${rootField}`);
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({
      query: `query($ids:[ID!]!){ ${rootField}(filter:{id:{in:$ids}}){ nodes { id name } } }`,
      variables: { ids: labelIds },
    }),
  });
  if (!res.ok) {
    reqLog.error(`${rootField} lookup failed: ${res.status}`);
    return new Map();
  }

  const json = (await res.json()) as { data?: Record<string, { nodes?: { id: string; name: string }[] } | undefined> };
  const nodes = json.data?.[rootField]?.nodes ?? [];
  reqLog.trace(`resolved: [${nodes.map((n) => `${n.id}=${n.name}`).join(", ")}]`);
  return new Map(nodes.map((n) => [n.id, n.name] as const));
}

/**
 * Creates a Linear TrackerAdapter with explicit credentials.
 * Use this in tests to pass credentials directly without env var stubs.
 * server.ts uses the default export, which reads env vars at startup.
 */
export function createLinearAdapter(webhookSecret: string, agentApiKey: string): TrackerAdapter {
  return {
    /**
     * Linear sends HMAC-SHA256 of the raw request body in the `Linear-Signature` header.
     * Must verify against the raw bytes — re-serializing the parsed JSON will not match.
     */
    verifySignature(rawBody: string, headers: Headers): boolean {
      if (!webhookSecret) throw new Error("LINEAR_WEBHOOK_SECRET is not set");
      const signature = headers.get("Linear-Signature");
      if (!signature) return false;
      const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    },

    /**
     * Linear doesn't send a delivery id, so key on the event's own fields —
     * stable across retries of the same event.
     */
    dedupeKey(rawBody: string): string {
      const hook = JSON.parse(rawBody) as LinearWebhook;
      return `${hook.type}:${hook.action}:${String(hook.data.id)}:${hook.webhookTimestamp ?? ""}`;
    },

    async parseEvent(rawBody: string, traceId: string): Promise<TrackerEvent | null> {
      const reqLog = log.child(traceId);
      // Full raw body, unconditionally — this is what makes an unrecognized
      // or wrongly-parsed webhook shape debuggable after the fact instead of
      // needing a trip to Linear's delivery log. Trace-only: this is real
      // payload content (comment bodies, etc.), not just field summaries.
      reqLog.trace(`raw payload: ${rawBody}`);
      const hook = JSON.parse(rawBody) as LinearWebhook;
      reqLog.trace(`parsing webhook: type=${hook.type} action=${hook.action}`);

      if (hook.type === "Issue" || hook.type === "Project") {
        if (hook.action !== "create" && hook.action !== "update") {
          reqLog.trace(`${hook.type} action "${hook.action}" is not create/update — discarding`);
          return null;
        }

        const entityType: EntityType = hook.type === "Issue" ? "issue" : "project";
        const entityId = String(hook.data.id);
        const title =
          (hook.data.title as string | undefined) ?? (hook.data.name as string | undefined) ?? null;
        const currentLabelIds = (hook.data.labelIds as string[] | undefined) ?? [];
        const status =
          entityType === "issue"
            ? (hook.data.state as { name?: string } | undefined)?.name
            : (hook.data.status as { name?: string } | undefined)?.name;
        if (!status) {
          reqLog.trace(`${entityType} ${entityId} has no resolvable status — discarding`);
          return null;
        }

        // Every branch below needs current label *names* (create/status_changed
        // report the full set; label_added additionally needs to know which
        // ids are new) — resolve once, up front, rather than per branch.
        const labelNames = agentApiKey
          ? await resolveLabelNames(entityType, currentLabelIds, agentApiKey, traceId)
          : new Map<string, string>();
        const currentLabels = currentLabelIds.map((id) => labelNames.get(id)).filter((n): n is string => n !== undefined);
        reqLog.trace(`${entityType} ${entityId}: status=${status} labels=[${currentLabels.join(", ")}]`);
        const actor = extractActor(hook);

        if (hook.action === "create") {
          // Nothing existed before creation — every current label is newly "added,"
          // and the entity's status is whatever it was created into. Reported as
          // label_added when labels are present so a lane whose trigger is a label
          // (Intake, Decompose) can still fire on an entity created with it already
          // applied; status_changed otherwise.
          const kind = currentLabels.length > 0 ? "label_added" : "status_changed";
          reqLog.trace(`${entityType} ${entityId} created — reporting ${kind}`);
          return {
            kind: kind,
            entityType: entityType,
            entityId: entityId,
            entityTitle: title,
            status: status,
            labels: currentLabels,
            authorId: null,
            addedLabels: currentLabels,
            actor: actor,
          };
        }

        // action === "update". A single update can in principle change both status
        // and labels at once; Linear's UI does not do this in one action, so label
        // changes are checked first and status changes only when labels didn't move —
        // reporting one TrackerEvent kind per webhook, not both.
        const updatedFrom = hook.updatedFrom ?? {};
        if ("labelIds" in updatedFrom) {
          reqLog.trace(`${entityType} ${entityId}: labelIds changed, diffing against the previous set`);
          const previousIds = new Set((updatedFrom.labelIds as string[] | undefined) ?? []);
          const addedIds = currentLabelIds.filter((id) => !previousIds.has(id));
          if (addedIds.length === 0) {
            reqLog.trace(`${entityType} ${entityId}: no net label addition (a removal) — discarding`);
            return null;
          }
          const addedLabels = addedIds.map((id) => labelNames.get(id)).filter((n): n is string => n !== undefined);
          if (addedLabels.length === 0) {
            reqLog.warn(`${entityType} ${entityId}: added label id(s) [${addedIds.join(", ")}] did not resolve to a name — discarding`);
            return null;
          }
          reqLog.trace(`${entityType} ${entityId}: added labels=[${addedLabels.join(", ")}]`);
          return {
            kind: "label_added",
            entityType: entityType,
            entityId: entityId,
            entityTitle: title,
            status: status,
            labels: currentLabels,
            authorId: null,
            addedLabels: addedLabels,
            actor: actor,
          };
        }

        const statusFieldChanged = "stateId" in updatedFrom || "statusId" in updatedFrom;
        if (statusFieldChanged) {
          reqLog.trace(`${entityType} ${entityId}: status field changed — reporting status_changed`);
          return {
            kind: "status_changed",
            entityType: entityType,
            entityId: entityId,
            entityTitle: title,
            status: status,
            labels: currentLabels,
            authorId: null,
            addedLabels: [],
            actor: actor,
          };
        }

        reqLog.trace(`${entityType} ${entityId}: neither labels nor status changed — discarding`);
        return null; // some other field changed (title edit, description, etc.) — not a trigger
      }

      // Linear does not emit a webhook for comments on a Project — only for
      // comments on Issues/Documents. A ProjectUpdate ("status update") post
      // is the only webhook-visible signal that a human touched a project's
      // discussion, so it stands in for comment_added on Projects. Confirmed
      // against a live payload (2026-07-16): data.projectId/data.userId/
      // data.body mirror the Comment branch's field names, just without the
      // nested-object fallback Comment needs (project/user are always
      // present alongside the flat ids here, but the flat id is simpler).
      if (hook.type === "ProjectUpdate" && hook.action === "create") {
        const authorId = (hook.data.userId as string | undefined) ?? null;
        const entityId = hook.data.projectId as string | undefined;
        if (!entityId) {
          reqLog.trace("project update has no projectId — discarding");
          return null;
        }
        reqLog.trace(`project update on ${entityId} by ${authorId ?? "(unknown author)"}`);

        const ctx = agentApiKey ? await fetchEntityContext("project", entityId, agentApiKey, traceId) : null;
        if (!ctx) {
          reqLog.trace(`could not resolve context for project ${entityId} — discarding`);
          return null;
        }

        return {
          kind: "comment_added",
          entityType: "project",
          entityId: entityId,
          entityTitle: ctx.title,
          status: ctx.status,
          labels: ctx.labels,
          authorId: authorId,
          addedLabels: [],
          actor: extractActor(hook),
        };
      }

      if (hook.type === "Comment" && hook.action === "create") {
        const authorId =
          (hook.data.userId as string | undefined) ??
          (hook.data.user as { id?: string } | undefined)?.id ??
          null;
        const issueId =
          (hook.data.issueId as string | undefined) ??
          (hook.data.issue as { id?: string } | undefined)?.id;
        const projectId =
          (hook.data.projectId as string | undefined) ??
          (hook.data.project as { id?: string } | undefined)?.id;
        const entityType: EntityType | null = issueId ? "issue" : projectId ? "project" : null;
        const entityId = issueId ?? projectId;
        if (!entityType || !entityId) {
          reqLog.trace("comment has neither issueId nor projectId — discarding");
          return null;
        }
        reqLog.trace(`comment on ${entityType} ${entityId} by ${authorId ?? "(unknown author)"}`);

        const ctx = agentApiKey ? await fetchEntityContext(entityType, entityId, agentApiKey, traceId) : null;
        if (!ctx) {
          reqLog.trace(`could not resolve context for ${entityType} ${entityId} — discarding`);
          return null;
        }

        return {
          kind: "comment_added",
          entityType: entityType,
          entityId: entityId,
          entityTitle: ctx.title,
          status: ctx.status,
          labels: ctx.labels,
          authorId: authorId,
          addedLabels: [],
          actor: extractActor(hook),
        };
      }

      reqLog.trace(`webhook type "${hook.type}" action "${hook.action}" is not a recognized firing case — discarding`);
      return null;
    },
  };
}

// Default instance — credentials resolved from env at startup. server.ts imports this.
export default createLinearAdapter(
  process.env.LINEAR_WEBHOOK_SECRET ?? "",
  process.env.LINEAR_AGENT_API_KEY ?? "",
);
