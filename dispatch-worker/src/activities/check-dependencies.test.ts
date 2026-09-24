import { describe, it, expect } from "vitest";
import { parseBlockingDependencyIds } from "./check-dependencies.js";

describe("parseBlockingDependencyIds — bold-heading form (story-contract.md's documented example)", () => {
  it("returns an empty array for 'No blocking dependencies.'", () => {
    const description = ["**Scope boundary**", "Nothing else.", "", "**Blocking dependencies**", "No blocking dependencies."].join(
      "\n",
    );
    expect(parseBlockingDependencyIds(description)).toEqual([]);
  });

  it("extracts the bare identifier as the first token of each bullet line", () => {
    const description = [
      "**Blocking dependencies**",
      "- PROJ-42 — Add refund data model",
      "- PROJ-43 — Add refund validation",
      "",
      "**Assignment metadata**",
      "surface: backend",
    ].join("\n");
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-42", "PROJ-43"]);
  });

  it("stops at the next bold heading line", () => {
    const description = ["**Blocking dependencies**", "- PROJ-1 — First blocker", "**Assignment metadata**", "- PROJ-99 — Not a blocker"].join(
      "\n",
    );
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-1"]);
  });

  it("returns an empty array for a heading with no bullet lines", () => {
    const description = "**Blocking dependencies**\n\n**Assignment metadata**";
    expect(parseBlockingDependencyIds(description)).toEqual([]);
  });
});

describe("parseBlockingDependencyIds — markdown-heading form (what Decompose actually renders live)", () => {
  it("extracts identifiers from a real observed description shape (## headings, ## References footer)", () => {
    const description = [
      "## Scope boundary",
      "Nothing else.",
      "",
      "## Blocking dependencies",
      "No blocking dependencies.",
      "",
      "## References",
      "* Employee model — `frontend: core/models/auth/employee.model.ts`",
    ].join("\n");
    expect(parseBlockingDependencyIds(description)).toEqual([]);
  });

  it("extracts bullet identifiers and stops at the next ## heading", () => {
    const description = ["## Blocking dependencies", "- PROJ-1 — First blocker", "- PROJ-2 — Second blocker", "## References", "* some anchor"].join(
      "\n",
    );
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("matches the heading case-insensitively and regardless of heading level", () => {
    const description = ["### blocking dependencies", "- PROJ-9 — A blocker"].join("\n");
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-9"]);
  });

  it("matches the heading regardless of internal spacing or hyphenation", () => {
    const description = ["##   Blocking-Dependencies", "- PROJ-3 — A blocker"].join("\n");
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-3"]);
  });

  it("accepts '*' bullet markers, not just '-'", () => {
    const description = ["## Blocking dependencies", "* PROJ-7 — A blocker", "* PROJ-8 — Another blocker"].join("\n");
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-7", "PROJ-8"]);
  });

  it("accepts a bare identifier line with no bullet marker at all (an observed real shape)", () => {
    const description = [
      "## Blocking dependencies",
      "",
      "PROJ-63 — Story: Extend the Employee model with department and tier enumeration",
      "",
      "## References",
    ].join("\n");
    expect(parseBlockingDependencyIds(description)).toEqual(["PROJ-63"]);
  });
});

describe("parseBlockingDependencyIds — missing section", () => {
  it("throws when the section is missing entirely", () => {
    const description = "**Scope boundary**\nNothing else.";
    expect(() => parseBlockingDependencyIds(description)).toThrow(/no "Blocking dependencies" section/);
  });
});
