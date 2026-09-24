/**
 * Entry point. Thin by design — all decision logic lives in the three layers it wires together:
 *   adapters/          → verify the request, parse the raw payload into a TrackerEvent
 *   swim-lane-routing  → decide which agent lane fires, if any
 *   agent-scheduler    → debounce follow-ups, call the agent
 *
 * To add a swim lane: edit swim-lanes.ts.
 * To add a tracker:   implement adapters/<tracker>.ts and point the import below at it.
 */

import adapter from "./adapters/linear.js";

import { route } from "./swim-lane-routing.js";
import { alreadySeen, makeDispatcher } from "./agent-scheduler.js";
import { lanes } from "./swim-lanes.js";
import { createLogger } from "./logger.js";
import { newTraceId } from "./trace-id.js";
import { envOr } from "./env.js";

// Choose what HTTP server you want to use.
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const log = createLogger("webhook");

// A staged dry run for standing the pipeline up incrementally, without a live
// Anthropic/Linear round trip on every rung. "accept" is the first rung: stop
// right after the webhook is verified, deduped, and parsed, before routing
// even runs. Later rungs ("route" — stop after the routing decision, before
// dispatch; "prompt" — stop after the activation's prompt is assembled,
// before the Anthropic call) extend this the same way, in their own files.
// Unset means run the full pipeline.
const TEST_STAGE = process.env.TEST_STAGE;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error(`missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

// The agent's user ID in the issue tracker. Swim-lane routing uses this to
// ignore comments the agent itself posted — without it, every agent comment
// would re-trigger evaluation, creating an infinite loop.
const AGENT_USER_ID = required("AGENT_USER_ID");
const port = Number(envOr("PORT", "8787"));

const dispatch = makeDispatcher({
  debounceMs: Number(envOr("DEBOUNCE_MS", "15000")),
});

const app = new Hono();

app.get("/health", (c) => c.text("ok"));

app.post("/webhooks/linear", async (c) => {
  // One id per delivery, threaded through parsing, routing, scheduling, and
  // whatever activation this delivery eventually causes — grep it to see the
  // whole chain end to end, even across the debounce boundary.
  const traceId = newTraceId();
  const reqLog = log.child(traceId);

  const raw = await c.req.text();
  reqLog.trace(`received webhook, ${raw.length} bytes`);

  if (!adapter.verifySignature(raw, c.req.raw.headers)) {
    reqLog.warn("rejected: bad signature");
    return c.json({ ok: false, error: "bad signature" }, 401);
  }
  reqLog.trace("signature verified");

  if (alreadySeen(adapter.dedupeKey(raw))) {
    reqLog.trace("duplicate delivery — already seen this event, discarding");
    return c.json({ ok: true, deduped: true });
  }

  const event = await adapter.parseEvent(raw, traceId);
  if (!event) {
    reqLog.trace("adapter did not produce an event — nothing to route");
    return c.json({ ok: true, fired: false });
  }
  reqLog.trace(`parsed event: kind=${event.kind} entityType=${event.entityType} entityId=${event.entityId}`);

  if (TEST_STAGE === "accept") {
    reqLog.info(`TEST_STAGE=accept — webhook accepted, stopping before routing`);
    return c.json({ ok: true, stage: "accept", traceId: traceId, event: event });
  }

  const decision = route(event, { agentUserId: AGENT_USER_ID, lanes: lanes });
  if (!decision.fire) {
    // Routine — most deliveries don't match any lane's trigger. Debug-only so
    // the default level doesn't drown in expected no-fires.
    reqLog.debug(`no-fire — ${decision.reason}`);
    return c.json({ ok: true, fired: false });
  }

  reqLog.info(`FIRE — lane=${decision.lane} entity=${decision.entityId} pass=${decision.pass}`);
  dispatch(decision.entityId, decision.pass, decision.entityTitle, traceId, decision.entityActor, decision.agent);
  return c.json({ ok: true, fired: true });
});

serve({ fetch: app.fetch, port: port }, (info) => {
  log.info(`webhook-listener listening on :${info.port}`);
  log.info(`webhook URL → POST http://<host>:${info.port}/webhooks/linear`);
});
