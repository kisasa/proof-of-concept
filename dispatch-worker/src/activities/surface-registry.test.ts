import { describe, expect, it } from "vitest";
import {
  extractSurfacesBlock,
  mergeRegistries,
  parseRegistryDocument,
  parseSurfacesBlock,
  renderSurfacesBlock,
  resolveSurfaces,
  SurfaceRegistryParseError,
} from "./surface-registry.js";
import { buildEffectiveRegistry } from "./resolve-surfaces.js";

const PROJECT_DOC = `# Surfaces

The engagement's surfaces. Written by the Specification Agent; confirm changes in an epic thread.

\`\`\`surfaces
surface: web
repo: github/example-org/example-web
ref: main
path: /
conventions: CONVENTIONS.md
skills:
status: active

surface: e2e
repo: github/example-org/example-web
ref: main
path: e2e/
conventions: e2e/CONVENTIONS.md
skills: playwright-house-style
status: active

surface: api
repo: github/example-org/example-api
ref: main

surface: legacy-reports
status: none
\`\`\`
`;

describe("extractSurfacesBlock", () => {
  it("returns the body of the fenced surfaces block", () => {
    expect(extractSurfacesBlock(PROJECT_DOC)).toContain("surface: web");
  });
  it("returns null when the document has no block", () => {
    expect(extractSurfacesBlock("# Surfaces\n\nnothing yet")).toBeNull();
  });
  it("ignores other fenced blocks", () => {
    expect(extractSurfacesBlock("```yaml\nsurface: web\n```")).toBeNull();
  });
});

describe("parseSurfacesBlock", () => {
  const records = parseRegistryDocument(PROJECT_DOC);

  it("parses every record with defaults applied", () => {
    expect(records.map((r) => r.surface)).toEqual(["web", "e2e", "api", "legacy-reports"]);
    const api = records.find((r) => r.surface === "api")!;
    expect(api.path).toBe("/");
    expect(api.conventions).toBe("CONVENTIONS.md");
    expect(api.skills).toEqual([]);
    expect(api.status).toBe("active");
    expect(api.repoBase).toEqual({ host: "github", org: "example-org", repo: "example-api", ref: "main" });
  });

  it("normalizes a path to a trailing slash and derives the conventions default from it", () => {
    expect(parseSurfacesBlock("surface: e2e\nrepo: github/o/r\nref: main\npath: e2e").at(0)).toMatchObject({
      path: "e2e/",
      conventions: "e2e/CONVENTIONS.md",
    });
  });

  it("splits skills on commas", () => {
    expect(records.find((r) => r.surface === "e2e")!.skills).toEqual(["playwright-house-style"]);
    expect(parseSurfacesBlock("surface: x\nrepo: github/o/r\nref: main\nskills: a, b ,c").at(0)!.skills).toEqual(["a", "b", "c"]);
  });

  it("accepts a none record with only a surface and status", () => {
    expect(records.find((r) => r.surface === "legacy-reports")!.status).toBe("none");
  });

  it("tolerates CRLF and comment lines", () => {
    const out = parseSurfacesBlock("# the web app\r\nsurface: web\r\nrepo: github/o/r\r\nref: main\r\n");
    expect(out).toHaveLength(1);
  });

  it.each([
    ["missing repo", "surface: web\nref: main", /repo is required/],
    ["missing ref", "surface: web\nrepo: github/o/r", /ref is required/],
    ["placeholder in repo", "surface: web\nrepo: <host>/<org>/<repo>\nref: main", /placeholder/],
    ["two segments", "surface: web\nrepo: org/repo\nref: main", /host\/org\/name/],
    ["unknown key", "surface: web\nrepo: github/o/r\nref: main\nbranch: main", /unknown key/],
    ["bad status", "surface: web\nrepo: github/o/r\nref: main\nstatus: retired", /status must be/],
    ["duplicate surface", "surface: web\nrepo: github/o/r\nref: main\n\nsurface: web\nrepo: github/o/r\nref: main", /recorded twice/],
    ["key before surface", "repo: github/o/r\nsurface: web\nref: main", /before any surface/],
    ["bad surface name", "surface: Web App\nrepo: github/o/r\nref: main", /lower-case/],
    ["not key: value", "surface: web\nrepo github/o/r\nref: main", /not key: value/],
  ])("rejects %s", (_label, block, message) => {
    expect(() => parseSurfacesBlock(block)).toThrow(SurfaceRegistryParseError);
    expect(() => parseSurfacesBlock(block)).toThrow(message);
  });
});

describe("mergeRegistries", () => {
  const project = parseRegistryDocument(PROJECT_DOC);

  it("replaces a surface's record wholesale and keeps the rest", () => {
    const override = parseSurfacesBlock("surface: web\nrepo: github/example-org/example-web\nref: epic-branch");
    const merged = mergeRegistries(project, override);
    expect(merged.find((r) => r.surface === "web")!.repoBase.ref).toBe("epic-branch");
    expect(merged.find((r) => r.surface === "api")!.repoBase.ref).toBe("main");
    expect(merged).toHaveLength(project.length);
  });

  it("adds a surface the project does not list", () => {
    const override = parseSurfacesBlock("surface: perf\nrepo: github/example-org/example-perf\nref: main");
    expect(mergeRegistries(project, override).map((r) => r.surface)).toContain("perf");
  });
});

describe("resolveSurfaces", () => {
  const registry = parseRegistryDocument(PROJECT_DOC);

  it("resolves one active surface", () => {
    const r = resolveSurfaces(registry, ["api"]);
    expect(r.ok && r.target.repoBase.repo).toBe("example-api");
  });

  it("resolves two surfaces sharing a repo and ref, with distinct paths", () => {
    const r = resolveSurfaces(registry, ["web", "e2e"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.surfaces.map((s) => s.path)).toEqual(["/", "e2e/"]);
  });

  it("rejects surfaces on different repos, naming both", () => {
    const r = resolveSurfaces(registry, ["web", "api"]);
    expect(!r.ok && r.reason).toMatch(/different repos or refs/);
    expect(!r.ok && r.reason).toContain("example-api");
  });

  it("rejects a missing surface and lists what is recorded", () => {
    const r = resolveSurfaces(registry, ["mobile"]);
    expect(!r.ok && r.reason).toMatch(/No surface record for: mobile/);
    expect(!r.ok && r.reason).toContain("api, e2e, legacy-reports, web");
  });

  it("rejects a surface recorded as none", () => {
    const r = resolveSurfaces(registry, ["legacy-reports"]);
    expect(!r.ok && r.reason).toMatch(/not active/);
  });

  it("rejects an empty label set", () => {
    expect(resolveSurfaces(registry, []).ok).toBe(false);
  });
});

describe("buildEffectiveRegistry", () => {
  it("finds the documents by title, case-insensitively, and layers the override", () => {
    const registry = buildEffectiveRegistry(
      [{ title: "surfaces (override)", content: "```surfaces\nsurface: web\nrepo: github/example-org/example-web\nref: feature\n```" }],
      [{ title: "API Map", content: "not a registry" }, { title: "Surfaces", content: PROJECT_DOC }],
    );
    expect(registry.find((r) => r.surface === "web")!.repoBase.ref).toBe("feature");
    expect(registry.find((r) => r.surface === "api")).toBeDefined();
  });

  it("is empty when neither document exists", () => {
    expect(buildEffectiveRegistry([], [])).toEqual([]);
  });
});

describe("renderSurfacesBlock", () => {
  it("round-trips through the parser", () => {
    const records = parseRegistryDocument(PROJECT_DOC);
    const rendered = renderSurfacesBlock(records);
    expect(parseSurfacesBlock(extractSurfacesBlock(rendered)!)).toEqual(records);
  });
});
