import { describe, it, expect } from "vitest";
import { redact } from "./workspace.js";

describe("redact", () => {
  it("replaces every occurrence of the token", () => {
    const message =
      'Command failed: git clone --branch main https://x-access-token:ghp_abc123@github.com/example-org/repo.git\n' +
      "fatal: repository 'https://x-access-token:ghp_abc123@github.com/example-org/repo.git/' not found";
    expect(redact(message, "ghp_abc123")).not.toContain("ghp_abc123");
    expect(redact(message, "ghp_abc123")).toBe(
      "Command failed: git clone --branch main https://x-access-token:***@github.com/example-org/repo.git\n" +
        "fatal: repository 'https://x-access-token:***@github.com/example-org/repo.git/' not found",
    );
  });

  it("returns the text unchanged when the token is empty", () => {
    expect(redact("some message with no secret", "")).toBe("some message with no secret");
  });

  it("returns the text unchanged when the token doesn't appear", () => {
    expect(redact("some unrelated message", "ghp_abc123")).toBe("some unrelated message");
  });
});
