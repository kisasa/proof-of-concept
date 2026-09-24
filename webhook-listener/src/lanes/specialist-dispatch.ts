/**
 * Specialist-dispatch lane. Not an Anthropic-calling lane — no `agentFile`,
 * no skills, no model. Its `agent` starts a Temporal workflow instead of an
 * activation run (see `dispatch-trigger.ts`), which is why this exports a
 * plain `LaneConfig` directly rather than going through `AgentLaneConfig`/
 * `createActivationRunner` the way Intake/Specification/Decompose do.
 *
 * Fires when a story enters the tracker's "started" status — the
 * automated-dispatch redesign's replacement for the developer's
 * local-terminal dispatch act (docs/design-ledger.md, "automated dispatch
 * and BRD closure"). Scoped to stories, not epics, via
 * `requireLabelsPresentPrefix` — both share Linear's one status workflow,
 * but only a decomposed story carries a `surface:<name>` label.
 *
 * The literal status string below is the real Linear state name, not
 * CLAUDE.md's own hyphenated "In-Process" framework vocabulary — confirmed
 * against a live payload (2026-08-06) after this exact mismatch silently
 * no-op'd a real dispatch attempt (`{"name":"In Progress","type":"started"}`,
 * Linear's own stock name for the started state; nobody had customized it to
 * match the docs). This is engagement-specific tracker configuration, the
 * same category as the repo base or the specialist container name — it
 * belongs here, in the Linear-specific lane file, not in the tool-agnostic
 * framework vocabulary CLAUDE.md uses.
 */

import { createDispatchTrigger } from "../dispatch-trigger.js";
import { getClient, temporalTaskQueue } from "../temporal-client.js";
import { envOr } from "../env.js";
import type { LaneConfig } from "../swim-lane-routing.js";

const LINEAR_API_URL = envOr("LINEAR_API_URL", "https://api.linear.app/graphql");

export const config: LaneConfig = {
  name: "specialist-dispatch",
  entityType: "issue",
  agent: createDispatchTrigger({
    linearAgentApiKey: process.env.LINEAR_AGENT_API_KEY ?? "",
    linearApiUrl: LINEAR_API_URL,
    getClient: getClient,
    taskQueue: temporalTaskQueue,
  }),
  // No follow-up state — a dispatch either starts or it doesn't; there's no
  // reply thread this lane waits on afterward.
  firstPass: { on: "status_entered", status: "In Progress", requireLabelsPresentPrefix: "surface:" },
  awaitingLabels: [],
};
