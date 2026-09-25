import { describe, it, expect } from "vitest";
import { specialistStartedBody, specialistProgressBody, pickPatienceQuip } from "./specialist-progress.js";

describe("specialistStartedBody", () => {
  it("names the working-on-it state and includes the quip", () => {
    const body = specialistStartedBody("Good things take time.");
    expect(body).toContain("**The specialist is working on this**");
    expect(body).toContain("_Good things take time._");
  });
});

describe("specialistProgressBody", () => {
  it("reports whole elapsed minutes and includes the quip", () => {
    const body = specialistProgressBody(150_000, "Slow is smooth, smooth is fast.");
    expect(body).toContain("2m elapsed");
    expect(body).toContain("_Slow is smooth, smooth is fast._");
  });

  it("floors partial minutes rather than rounding", () => {
    const body = specialistProgressBody(119_000, "quip");
    expect(body).toContain("1m elapsed");
  });
});

describe("pickPatienceQuip", () => {
  it("always returns a non-empty string", () => {
    for (let i = 0; i < 20; i++) {
      expect(pickPatienceQuip().length).toBeGreaterThan(0);
    }
  });
});
