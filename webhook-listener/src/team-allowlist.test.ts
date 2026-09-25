import { describe, it, expect } from "vitest";
import { checkTeamAllowlist, parseAllowedTeamIds } from "./team-allowlist.js";

describe("parseAllowedTeamIds", () => {
  it("splits on commas and trims each id", () => {
    expect([...parseAllowedTeamIds(" team-a, team-b ,team-c")]).toEqual(["team-a", "team-b", "team-c"]);
  });

  it("drops blank entries, so a trailing comma is harmless", () => {
    expect([...parseAllowedTeamIds("team-a,, ,")]).toEqual(["team-a"]);
  });

  it("is empty for an unset or blank value", () => {
    expect(parseAllowedTeamIds(undefined).size).toBe(0);
    expect(parseAllowedTeamIds("  ").size).toBe(0);
  });
});

describe("checkTeamAllowlist", () => {
  const allowed = parseAllowedTeamIds("team-a,team-b");

  it("accepts an entity whose one team is allowlisted", () => {
    expect(checkTeamAllowlist(["team-a"], allowed)).toEqual({ allowed: true });
  });

  it("accepts a project whose every team is allowlisted", () => {
    expect(checkTeamAllowlist(["team-a", "team-b"], allowed)).toEqual({ allowed: true });
  });

  it("rejects an entity in a team that is not allowlisted, naming it", () => {
    const decision = checkTeamAllowlist(["team-x"], allowed);
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toContain("team-x");
  });

  it("rejects a project that spans an allowlisted team and any other team", () => {
    expect(checkTeamAllowlist(["team-a", "team-x"], allowed).allowed).toBe(false);
  });

  it("rejects when the entity's team could not be resolved", () => {
    expect(checkTeamAllowlist(null, allowed).allowed).toBe(false);
    expect(checkTeamAllowlist([], allowed).allowed).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(checkTeamAllowlist(["team-a"], new Set()).allowed).toBe(false);
  });
});
