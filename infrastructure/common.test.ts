import { describe, expect, it } from "vitest";

// Extensionless imports throughout this project: cdktn ships CommonJS, so this
// package is CJS with classic Node resolution — unlike webhook-listener, which
// is ESM and therefore needs explicit .js suffixes.
import { formatName, formatTerraformId, securityGroupDescription } from "./common";

describe("formatName", () => {
  it("lowercases and replaces spaces", () => {
    expect(formatName("Example Webhook Listener")).toBe("example-webhook-listener");
  });

  it("leaves an already-conforming name alone", () => {
    expect(formatName("webhook-listener-prod")).toBe("webhook-listener-prod");
  });

  it("truncates to the requested length", () => {
    expect(formatName("abcdefghij", 4)).toBe("abcd");
  });

  // The reason this helper exists: an ALB name that ends in a hyphen is
  // rejected by AWS, and truncation is the most common way to produce one.
  it("trims a hyphen left behind by truncation", () => {
    expect(formatName("webhook-listener", 8)).toBe("webhook");
  });

  it("trims leading hyphens", () => {
    expect(formatName("-leading")).toBe("leading");
  });
});

describe("securityGroupDescription", () => {
  it("passes text within the allowed charset", () => {
    const description = "HTTPS from anywhere; authenticity enforced by webhook signature, not by address";
    expect(securityGroupDescription(description)).toBe(description);
  });

  // The two that actually bit: an em dash from prose-style punctuation, and an
  // apostrophe. Both are rejected by AWS several minutes into an apply.
  it("rejects an em dash", () => {
    expect(() => securityGroupDescription("HTTPS from anywhere — signature checked")).toThrow(/characters AWS rejects/);
  });

  it("rejects an apostrophe", () => {
    expect(() => securityGroupDescription("The listener's ingress")).toThrow(/characters AWS rejects/);
  });

  it("rejects descriptions over 255 characters", () => {
    expect(() => securityGroupDescription("a".repeat(256))).toThrow(/exceeds 255 characters/);
  });
});

describe("formatTerraformId", () => {
  it("defaults to the 32-character ALB ceiling", () => {
    const id = formatTerraformId("a-very-long-environment-name-that-will-not-fit-in-a-load-balancer-name");
    expect(id).toHaveLength(32);
    expect(id).toBe("a-very-long-environment-name-tha");
  });
});
