/**
 * The listener's tracker-team allowlist. This pipeline may share a tracker
 * workspace with another pipeline's listener; if both acted on the same
 * workspace's webhooks unfiltered, both would act on every event. So an event
 * is accepted only when its entity's team(s) are all on the list configured
 * for this deployment (TRACKER_ALLOWED_TEAM_IDS).
 *
 * Fails closed throughout: an empty list refuses every event (and server.ts
 * refuses to start without one), an entity whose team cannot be resolved is
 * rejected, and a project spanning an allowed team and any other team is
 * rejected — it belongs, in part, to someone else's pipeline.
 *
 * Pure: the team lookup is the tracker adapter's (`entityTeamIds`), so this
 * module stays tracker-agnostic and is tested without any I/O.
 */

/** Parses the comma-separated env value; blanks and surrounding whitespace are dropped. */
export function parseAllowedTeamIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export type AllowlistDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export function checkTeamAllowlist(teamIds: readonly string[] | null, allowed: ReadonlySet<string>): AllowlistDecision {
  if (allowed.size === 0) return { allowed: false, reason: "no tracker teams are allowlisted" };
  if (teamIds === null || teamIds.length === 0) return { allowed: false, reason: "the entity's team could not be resolved" };
  const foreign = teamIds.filter((id) => !allowed.has(id));
  if (foreign.length > 0) return { allowed: false, reason: `team(s) not allowlisted: ${foreign.join(", ")}` };
  return { allowed: true };
}
