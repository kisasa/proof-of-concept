/**
 * Extracted from dispatch-story-workflow.ts into its own module, with no
 * Temporal imports at all, so it's safely importable — and testable — from a
 * plain vitest test. Importing dispatch-story-workflow.ts directly would run
 * its module-level `proxyActivities(...)` calls outside a real workflow
 * execution context, which throws.
 *
 * Temporal wraps an activity's own thrown error one layer deep before
 * handing it to the workflow (confirmed live, 2026-08-06, via `tctl workflow
 * show`: the outer failure's own message is the generic "Activity task
 * failed"; the activity's real, specific message — "Could not read epic
 * branch ... GitHub returned 404" — lives one level down, on `.cause`).
 * Prefers that inner message when present so the tracker comment says the
 * same specific thing a developer reading the raw history would see, not a
 * useless "Activity task failed" for every failure regardless of cause.
 */
export function describeFailure(err: unknown): string {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "message" in cause && typeof (cause as { message?: unknown }).message === "string") {
      return (cause as { message: string }).message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
