import { describe, it, expect, vi, afterEach } from "vitest";
import { alreadySeen, makeDispatcher } from "./agent-scheduler.js";

// agent-scheduler uses module-level maps (seenEvents, timers) that persist for
// the lifetime of the process. Tests use unique issue IDs to avoid cross-test
// contamination without needing module resets.

describe("alreadySeen", () => {
  it("returns false the first time a key is seen", () => {
    expect(alreadySeen("as-test-1")).toBe(false);
  });

  it("returns true on a repeated key", () => {
    alreadySeen("as-test-2");
    expect(alreadySeen("as-test-2")).toBe(true);
  });

  it("treats different keys independently", () => {
    expect(alreadySeen("as-test-3a")).toBe(false);
    expect(alreadySeen("as-test-3b")).toBe(false);
  });
});

describe("makeDispatcher", () => {
  afterEach(() => {
    // Discards any pending fake timers so they don't leak into the next test.
    vi.useRealTimers();
  });

  it("fires the agent immediately on first pass", () => {
    const agent = vi.fn();
    const dispatch = makeDispatcher({ debounceMs: 5000 });
    const actor = { id: "user-1", name: "Example User", email: "user@example.com" };
    dispatch("disp-first-1", "first", "Some Title", "trace-1", actor, agent);
    expect(agent).toHaveBeenCalledOnce();
    expect(agent).toHaveBeenCalledWith("disp-first-1", "first", "Some Title", "trace-1", actor);
  });

  it("debounces follow-up calls and fires once after the window elapses", () => {
    vi.useFakeTimers();
    const agent = vi.fn();
    const dispatch = makeDispatcher({ debounceMs: 500 });

    dispatch("disp-debounce-1", "follow-up", null, "trace-a", null, agent);
    dispatch("disp-debounce-1", "follow-up", null, "trace-b", null, agent);
    dispatch("disp-debounce-1", "follow-up", null, "trace-c", null, agent);
    expect(agent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(agent).toHaveBeenCalledOnce();
    // The last call's trace id is the one that survives the coalescing.
    expect(agent).toHaveBeenCalledWith("disp-debounce-1", "follow-up", null, "trace-c", null);
  });
});
