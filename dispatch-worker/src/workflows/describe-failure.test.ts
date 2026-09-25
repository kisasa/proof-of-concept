import { describe, it, expect } from "vitest";
import { describeFailure } from "./describe-failure.js";

describe("describeFailure", () => {
  it("prefers the inner cause's message over the outer wrapper's generic one", () => {
    const cause = new Error("Could not read epic branch \"proj-58\" in example-org/example-app: GitHub returned 404");
    const outer = new Error("Activity task failed", { cause: cause });
    expect(describeFailure(outer)).toBe('Could not read epic branch "proj-58" in example-org/example-app: GitHub returned 404');
  });

  it("falls back to the error's own message when there is no cause", () => {
    expect(describeFailure(new Error("plain failure"))).toBe("plain failure");
  });

  it("falls back to the error's own message when the cause has no message", () => {
    const outer = new Error("Activity task failed", { cause: {} });
    expect(describeFailure(outer)).toBe("Activity task failed");
  });

  it("stringifies a non-Error value", () => {
    expect(describeFailure("just a string")).toBe("just a string");
  });
});
