import { describe, it, expect } from "vitest";
import { resolveReviewerLogin } from "./request-pull-request-reviewer.js";

const MOVER = { id: "00000000-0000-4000-8000-000000000001", name: "Example User", email: "user@example.com" };

describe("resolveReviewerLogin", () => {
  it("returns null when there is no story-mover identity", () => {
    expect(resolveReviewerLogin(null, new Map([["user@example.com", "example-login"]]))).toBeNull();
  });

  it("returns the mapped GitHub login for the mover's email", () => {
    const mapping = new Map([["user@example.com", "example-login"]]);
    expect(resolveReviewerLogin(MOVER, mapping)).toBe("example-login");
  });

  it("returns null when the mover's email has no mapping entry", () => {
    expect(resolveReviewerLogin(MOVER, new Map())).toBeNull();
  });
});
