import { describe, it, expect, vi, afterEach } from "vitest";
import { envOr, requireEnv } from "./env.js";

describe("envOr", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the fallback when the var is unset", () => {
    vi.stubEnv("ENV_OR_TEST", undefined as unknown as string);
    delete process.env.ENV_OR_TEST;
    expect(envOr("ENV_OR_TEST", "fallback")).toBe("fallback");
  });

  it("returns the fallback when the var is present but empty — the .env.example case", () => {
    vi.stubEnv("ENV_OR_TEST", "");
    expect(envOr("ENV_OR_TEST", "fallback")).toBe("fallback");
  });

  it("returns the var's value when it's set to something non-empty", () => {
    vi.stubEnv("ENV_OR_TEST", "explicit-value");
    expect(envOr("ENV_OR_TEST", "fallback")).toBe("explicit-value");
  });
});

describe("requireEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when the var is unset", () => {
    vi.stubEnv("REQUIRE_ENV_TEST", undefined as unknown as string);
    delete process.env.REQUIRE_ENV_TEST;
    expect(() => requireEnv("REQUIRE_ENV_TEST")).toThrow("REQUIRE_ENV_TEST is not set");
  });

  it("throws when the var is present but empty — the .env.example case", () => {
    vi.stubEnv("REQUIRE_ENV_TEST", "");
    expect(() => requireEnv("REQUIRE_ENV_TEST")).toThrow("REQUIRE_ENV_TEST is not set");
  });

  it("returns the var's value when it's set to something non-empty", () => {
    vi.stubEnv("REQUIRE_ENV_TEST", "explicit-value");
    expect(requireEnv("REQUIRE_ENV_TEST")).toBe("explicit-value");
  });
});
