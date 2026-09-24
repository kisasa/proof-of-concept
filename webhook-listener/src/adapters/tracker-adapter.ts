import type { TrackerEvent } from "../tracker-event";

/**
 * The contract every tracker adapter must fulfill. Adapters translate a tracker's
 * specific wire format — headers, payload shape, authentication scheme — into the
 * normalized types the pipeline works with.
 *
 * To add a tracker: implement this interface in adapters/<tracker>.ts, export a
 * default instance, and wire it into server.ts. No other files change.
 *
 * Each method is narrow by design:
 *   verifySignature → authenticate before touching the payload; reads its own secret
 *   dedupeKey       → stable identity for this event, used to suppress redeliveries
 *   parseEvent      → translate payload to TrackerEvent, or null if not a firing case
 *
 * traceId is server.ts's per-delivery correlation id (see trace-id.ts), passed
 * through purely so an adapter's own parsing decisions can be trace-logged
 * under the same id as everything else that delivery goes on to cause.
 */
export interface TrackerAdapter {
  verifySignature(rawBody: string, headers: Headers): boolean;
  dedupeKey(rawBody: string): string;
  parseEvent(rawBody: string, traceId: string): Promise<TrackerEvent | null>;
}
