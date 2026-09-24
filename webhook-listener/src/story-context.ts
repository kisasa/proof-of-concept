/**
 * Reads what the specialist-dispatch lane needs from Linear directly, outside
 * any agent activation — the same category of direct app-level read as
 * `adapters/linear.ts`'s `fetchEntityContext` and `tracker-notifier.ts`'s own
 * comment writes, using the same raw-fetch GraphQL shape rather than a new
 * client library. Deliberately not shared with `dispatch-worker/src/tracker.ts`
 * — separate npm package, no shared lib between them, matching this repo's
 * existing "each package owns its own small client" pattern.
 *
 * The assignment label is `surface:<name>` — resolving the `specialist:<type>`
 * vs `spec:<type>` conflict design-ledger.md flagged as unresolved, and
 * renamed from `specialist:` after the specialist-types-collapse-into-
 * surfaces redesign (`docs/design-ledger.md`, 2026-08-08). A story may carry
 * more than one `surface:` label; this module only extracts the set of
 * names — whether they're all recognized by the epic (and, when there's more
 * than one, whether they all resolve to the same repo and ref) is
 * `dispatch-worker`'s `resolveSurfaces` to check, since that's the first
 * point in the pipeline that actually reads the epic's recorded repo bases.
 *
 * VERIFY before relying on this in production (same flagged-not-confirmed
 * category as `adapters/linear.ts`'s and `dispatch-worker/src/tracker.ts`'s
 * own notes): `parent { id branchName }` as the field name and shape for a
 * story's epic — inferred from Linear's public API docs, not confirmed
 * against a live query.
 */

import { createLogger } from "./logger.js";

const log = createLogger("story-context");

// A surface is a place work happens — a repo, or a project inside one. The
// vocabulary is open (`web`, `mobile`, `api`, `e2e`, ... whatever this
// engagement actually has), not a fixed union, so this is a plain string
// alias rather than a literal type.
export type Surface = string;

const SURFACE_LABEL_PREFIX = "surface:";

// story-contract.md: "tier — small, mid, or large: which execution tier
// (model class) runs the specialist for this story." A fixed enum, unlike
// Surface — the three values are framework vocabulary, not engagement-
// specific.
export type Tier = "small" | "mid" | "large";

const TIER_LABEL_PREFIX = "tier:";
const KNOWN_TIERS: readonly Tier[] = ["small", "mid", "large"];

// story-contract.md: "size — small, medium, or large: relative effort within
// this epic." A different axis from Tier: tier is architectural weight (which
// model class runs it), size is volume of work. Confirmed live
// (2026-08-10) that a story can be `tier:small` and still `size:medium` — the two
// don't move together, which is exactly why dispatch-trigger.ts's turn budget
// takes the larger of what each one implies rather than trusting tier alone.
export type Size = "small" | "medium" | "large";

const SIZE_LABEL_PREFIX = "size:";
const KNOWN_SIZES: readonly Size[] = ["small", "medium", "large"];

export interface StoryDispatchContext {
  readonly storyId: string;
  readonly storyBranch: string;
  readonly surfaces: Surface[];
  /** Null when the story carries no recognized `tier:<value>` label — dispatch-trigger.ts falls back to a default turn budget rather than blocking on it. */
  readonly tier: Tier | null;
  /** Null when the story carries no recognized `size:<value>` label — same fallback posture as tier. */
  readonly size: Size | null;
  readonly epicId: string;
  readonly epicBranch: string;
}

/**
 * Extracts the story's `tier:<value>` label, if it carries a recognized one.
 * Unlike `parseSurfaces`, a missing or unrecognized tier is not a dispatch
 * blocker — tier only sizes the specialist's turn budget (see
 * dispatch-trigger.ts's TIER_MAX_TURNS), and a story that's merely missing
 * this label is still real, dispatchable work. Returns the first recognized
 * `tier:*` label found, ignoring any that aren't one of the three known
 * values rather than treating a typo as fatal.
 */
export function parseTier(labels: string[]): Tier | null {
  for (const name of labels) {
    if (!name.startsWith(TIER_LABEL_PREFIX)) continue;
    const value = name.slice(TIER_LABEL_PREFIX.length);
    if (KNOWN_TIERS.includes(value as Tier)) return value as Tier;
  }
  return null;
}

/** Same shape and same non-blocking posture as `parseTier`, for the `size:<value>` label. */
export function parseSize(labels: string[]): Size | null {
  for (const name of labels) {
    if (!name.startsWith(SIZE_LABEL_PREFIX)) continue;
    const value = name.slice(SIZE_LABEL_PREFIX.length);
    if (KNOWN_SIZES.includes(value as Size)) return value as Size;
  }
  return null;
}

export type StoryContextResult =
  | { readonly ok: true; readonly context: StoryDispatchContext }
  | { readonly ok: false; readonly reason: string };

interface GraphQlResponse<T> {
  data?: T;
  errors?: unknown;
}

const STORY_CONTEXT_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id
      branchName
      labels { nodes { name } }
      parent { id branchName }
    }
  }
`;

interface StoryContextQueryResult {
  issue: {
    id: string;
    branchName: string;
    labels: { nodes: { name: string }[] };
    parent: { id: string; branchName: string } | null;
  } | null;
}

/**
 * Extracts the story's `surface:<name>` label(s). Returns the reason string
 * for the one way a story can fail to carry a usable one — no label at all —
 * rather than a bare null; `dispatch-trigger.ts` posts this reason verbatim
 * in its error comment, so it has to be specific enough for a human to act
 * on.
 *
 * Unlike the old `specialist:<type>` version, there is no supported-type
 * check here: the surface vocabulary is open (whatever this engagement
 * actually has), so any `surface:*` label is presumptively valid at this
 * stage. Whether the epic actually recognizes a given surface — and, when
 * a story carries more than one, whether they all resolve to the same repo
 * and ref — is `resolveSurfaces` to catch downstream, since that is the
 * first point that reads the epic's recorded repo bases. Deduplicates a
 * repeated label and preserves the order labels were applied in, but places
 * no upper bound on count: a story may legitimately carry several surface
 * labels (`docs/design-ledger.md`, 2026-08-08 — "the labels widen what the
 * specialist may write").
 */
export function parseSurfaces(labels: string[]): { surfaces: Surface[] } | { reason: string } {
  const surfaces: Surface[] = [];
  for (const name of labels) {
    if (!name.startsWith(SURFACE_LABEL_PREFIX)) continue;
    const surface = name.slice(SURFACE_LABEL_PREFIX.length);
    if (!surfaces.includes(surface)) surfaces.push(surface);
  }

  if (surfaces.length === 0) {
    return { reason: `no ${SURFACE_LABEL_PREFIX}<name> label found` };
  }

  return { surfaces: surfaces };
}

export async function fetchStoryDispatchContext(
  storyId: string,
  apiKey: string,
  baseUrl: string,
  traceId: string,
): Promise<StoryContextResult> {
  const reqLog = log.child(traceId);
  if (!apiKey) throw new Error("LINEAR_AGENT_API_KEY is not set");

  reqLog.trace(`fetching story dispatch context for ${storyId}`);
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: STORY_CONTEXT_QUERY, variables: { id: storyId } }),
  });
  const json = (await res.json()) as GraphQlResponse<StoryContextQueryResult>;
  if (!res.ok || json.errors || json.data === undefined) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
  }

  const issue = json.data.issue;
  if (!issue) {
    return { ok: false, reason: `story ${storyId} could not be read from the tracker` };
  }

  if (!issue.parent) {
    return { ok: false, reason: "story has no parent epic recorded" };
  }

  const labelNames = issue.labels.nodes.map((node) => node.name);
  const surfacesResult = parseSurfaces(labelNames);
  if ("reason" in surfacesResult) {
    return { ok: false, reason: surfacesResult.reason };
  }
  const tier = parseTier(labelNames);
  const size = parseSize(labelNames);

  reqLog.trace(
    `story ${storyId}: surfaces=${surfacesResult.surfaces.join(",")} tier=${tier ?? "(none)"} size=${size ?? "(none)"} ` +
      `epicId=${issue.parent.id} storyBranch=${issue.branchName} epicBranch=${issue.parent.branchName}`,
  );

  return {
    ok: true,
    context: {
      storyId: issue.id,
      storyBranch: issue.branchName,
      surfaces: surfacesResult.surfaces,
      tier: tier,
      size: size,
      epicId: issue.parent.id,
      epicBranch: issue.parent.branchName,
    },
  };
}
