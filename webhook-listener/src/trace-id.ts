import { randomUUID } from "node:crypto";

/**
 * Correlates one causal chain — a webhook delivery through to whatever agent
 * activation it eventually causes, including across the debounce boundary —
 * so a single id can be grepped across every log line that chain produced.
 * Truncated for log readability: this is a debugging aid, not a uniqueness
 * guarantee, so the small collision risk is acceptable.
 */
export function newTraceId(): string {
  return randomUUID().slice(0, 8);
}
