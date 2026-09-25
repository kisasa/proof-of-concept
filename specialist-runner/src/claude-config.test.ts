import { describe, it, expect, vi, afterEach } from "vitest";
import { loadClaudeConfig } from "./claude-config.js";

describe("loadClaudeConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when CLAUDE_MODEL is unset — no code-level default", () => {
    vi.stubEnv("CLAUDE_MODEL", undefined as unknown as string);
    vi.stubEnv("CLAUDE_EFFORT", "high");
    delete process.env.CLAUDE_MODEL;

    expect(() => loadClaudeConfig()).toThrow("CLAUDE_MODEL is not set");
  });

  it("throws when CLAUDE_EFFORT is unset — no code-level default", () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-sonnet-5");
    vi.stubEnv("CLAUDE_EFFORT", undefined as unknown as string);
    delete process.env.CLAUDE_EFFORT;

    expect(() => loadClaudeConfig()).toThrow("CLAUDE_EFFORT is not set");
  });

  it("respects an explicit model and effort", () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-opus-5-5");
    vi.stubEnv("CLAUDE_EFFORT", "xhigh");

    expect(loadClaudeConfig()).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
  });

  it("rejects an unsupported effort level", () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-sonnet-5");
    vi.stubEnv("CLAUDE_EFFORT", "ludicrous");
    expect(() => loadClaudeConfig()).toThrow(/not a valid effort level/);
  });
});
