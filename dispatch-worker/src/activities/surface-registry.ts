/**
 * The surface registry — the machine-read record of where each surface lives
 * (docs/design-ledger.md, 2026-09-02, "The surface registry lives in the
 * project and is overridable in the epic").
 *
 * A registry is a Linear document whose content carries one fenced block
 * tagged `surfaces`, holding one record per surface:
 *
 *     ```surfaces
 *     surface: web
 *     repo: github/example-org/example-web
 *     ref: main
 *     path: /
 *     conventions: CONVENTIONS.md
 *     skills:
 *     status: active
 *
 *     surface: e2e
 *     repo: github/example-org/example-web
 *     ref: main
 *     path: e2e/
 *     conventions: e2e/CONVENTIONS.md
 *     skills: playwright-house-style
 *     status: active
 *     ```
 *
 * `surface`, `repo` (host/org/name), and `ref` are required. `path` defaults
 * to `/`, `conventions` to `<path>CONVENTIONS.md`, `skills` to none, `status`
 * to `active`. Records are separated by blank lines; a record begins at its
 * `surface:` line. Anything the parser does not recognise is an error rather
 * than a guess: the registry is written by an agent from a confirmed answer,
 * never typed by a human, so a malformed record is a bug to surface, not a
 * typo to tolerate. That is the opposite posture from the retired per-epic
 * `Repo base —` comment line, whose four defensive patches all existed
 * because humans typed it under time pressure.
 *
 * Two documents feed one resolution. The project's document, titled
 * `Surfaces`, is the registry for the engagement. An epic may carry its own,
 * titled `Surfaces (override)`, and a record there replaces the project's
 * record for that surface wholesale and may add a surface the project does
 * not list. Everything else comes from the project.
 */

export interface RepoBase {
  readonly host: string;
  readonly org: string;
  readonly repo: string;
  readonly ref: string;
}

export type SurfaceStatus = "active" | "none" | "deprecated";

export interface SurfaceRecord {
  readonly surface: string;
  readonly repoBase: RepoBase;
  /** Directory within the repo the surface lives in, `/` for the root. Always ends with `/`. */
  readonly path: string;
  /** Path to the conventions spec, relative to the repo root. */
  readonly conventions: string;
  /** Mandatory skills for this surface, resolved and inlined at dispatch. */
  readonly skills: readonly string[];
  readonly status: SurfaceStatus;
}

export const PROJECT_REGISTRY_TITLE = "Surfaces";
export const EPIC_OVERRIDE_TITLE = "Surfaces (override)";

const KNOWN_KEYS = new Set(["surface", "repo", "ref", "path", "conventions", "skills", "status"]);
const STATUSES = new Set<SurfaceStatus>(["active", "none", "deprecated"]);

export class SurfaceRegistryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceRegistryParseError";
  }
}

/** Extracts the body of the first ```surfaces fenced block; null when the document has none. */
export function extractSurfacesBlock(markdown: string): string | null {
  const match = /```surfaces[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(markdown);
  return match?.[1] ?? null;
}

function normalizePath(value: string | undefined): string {
  if (value === undefined || value.trim() === "" || value.trim() === "/") return "/";
  let path = value.trim().replace(/^\.?\//, "");
  if (!path.endsWith("/")) path += "/";
  return path;
}

function parseRepo(value: string, surface: string): RepoBase {
  if (/[<>`\s]/.test(value)) {
    throw new SurfaceRegistryParseError(`surface "${surface}": repo "${value}" contains a placeholder or whitespace`);
  }
  const parts = value.split("/");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new SurfaceRegistryParseError(`surface "${surface}": repo must be host/org/name, got "${value}"`);
  }
  const [host, org, repo] = parts as [string, string, string];
  return { host, org, repo, ref: "" };
}

/**
 * Parses the records in a ```surfaces block. Pure; throws
 * SurfaceRegistryParseError with a message that names the surface and the
 * field, so the failure comment on the story says what to fix.
 */
export function parseSurfacesBlock(block: string): SurfaceRecord[] {
  const records: SurfaceRecord[] = [];
  let current: Record<string, string> | null = null;

  const finish = () => {
    if (current === null) return;
    const surface = current["surface"];
    if (!surface) throw new SurfaceRegistryParseError("a record has no surface name");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(surface)) {
      throw new SurfaceRegistryParseError(`surface "${surface}": names are lower-case letters, digits, and hyphens`);
    }
    const status = (current["status"] ?? "active").trim() as SurfaceStatus;
    if (!STATUSES.has(status)) {
      throw new SurfaceRegistryParseError(`surface "${surface}": status must be active, none, or deprecated, got "${status}"`);
    }
    if (status === "none") {
      records.push({ surface, repoBase: { host: "", org: "", repo: "", ref: "" }, path: "/", conventions: "", skills: [], status });
      current = null;
      return;
    }
    const repoValue = current["repo"];
    const ref = current["ref"]?.trim();
    if (!repoValue) throw new SurfaceRegistryParseError(`surface "${surface}": repo is required`);
    if (!ref) throw new SurfaceRegistryParseError(`surface "${surface}": ref is required`);
    if (/[<>`\s]/.test(ref)) throw new SurfaceRegistryParseError(`surface "${surface}": ref "${ref}" contains a placeholder or whitespace`);
    const path = normalizePath(current["path"]);
    const conventions = (current["conventions"] ?? "").trim() || `${path === "/" ? "" : path}CONVENTIONS.md`;
    const skills = (current["skills"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const skill of skills) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) {
        throw new SurfaceRegistryParseError(`surface "${surface}": skill "${skill}" is not a valid skill name`);
      }
    }
    records.push({ surface, repoBase: { ...parseRepo(repoValue.trim(), surface), ref }, path, conventions, skills, status });
    current = null;
  };

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      finish();
      continue;
    }
    if (line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) throw new SurfaceRegistryParseError(`line "${line}" is not key: value`);
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!KNOWN_KEYS.has(key)) throw new SurfaceRegistryParseError(`unknown key "${key}"`);
    if (key === "surface") {
      finish();
      current = { surface: value };
      continue;
    }
    if (current === null) throw new SurfaceRegistryParseError(`"${key}" appears before any surface: line`);
    if (key in current) throw new SurfaceRegistryParseError(`surface "${current["surface"]}": "${key}" given twice`);
    current[key] = value;
  }
  finish();

  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.surface)) throw new SurfaceRegistryParseError(`surface "${r.surface}" is recorded twice`);
    seen.add(r.surface);
  }
  return records;
}

/** Parses a registry document's markdown; an absent block is an empty registry. */
export function parseRegistryDocument(markdown: string | null | undefined): SurfaceRecord[] {
  if (!markdown) return [];
  const block = extractSurfacesBlock(markdown);
  if (block === null) return [];
  return parseSurfacesBlock(block);
}

/**
 * Epic override on top of the project registry: a record in the override
 * replaces the project's record for the same surface wholesale, and may add
 * a surface the project does not list. Field-by-field merging was rejected
 * as producing records nobody can read.
 */
export function mergeRegistries(project: readonly SurfaceRecord[], epicOverride: readonly SurfaceRecord[]): SurfaceRecord[] {
  const bySurface = new Map<string, SurfaceRecord>();
  for (const r of project) bySurface.set(r.surface, r);
  for (const r of epicOverride) bySurface.set(r.surface, r);
  return [...bySurface.values()];
}

export interface ResolvedTarget {
  readonly repoBase: RepoBase;
  readonly surfaces: readonly SurfaceRecord[];
}

export type ResolveResult = { readonly ok: true; readonly target: ResolvedTarget } | { readonly ok: false; readonly reason: string };

function formatRepoBase(base: RepoBase): string {
  return `${base.host}/${base.org}/${base.repo}/${base.ref}`;
}

function sameRepoAndRef(a: RepoBase, b: RepoBase): boolean {
  return a.host === b.host && a.org === b.org && a.repo === b.repo && a.ref === b.ref;
}

/**
 * The pure decision: every surface the story carries must be an active
 * record, and all of them must share one repo and ref — one story, one
 * branch, one PR. Paths may differ (that is what lets two surfaces share a
 * repo legitimately); repo and ref may not.
 */
export function resolveSurfaces(registry: readonly SurfaceRecord[], surfaces: readonly string[]): ResolveResult {
  if (surfaces.length === 0) return { ok: false, reason: "Story carries no surface: label to resolve." };
  const bySurface = new Map(registry.map((r) => [r.surface, r]));

  const missing = surfaces.filter((s) => !bySurface.has(s));
  if (missing.length > 0) {
    const known = registry.map((r) => r.surface).sort().join(", ") || "(the registry is empty)";
    return {
      ok: false,
      reason:
        `No surface record for: ${missing.join(", ")}. Surfaces recorded for this project (plus any epic override): ${known}. ` +
        `The registry is the project's "${PROJECT_REGISTRY_TITLE}" document, or the epic's "${EPIC_OVERRIDE_TITLE}" document; ` +
        `the Specification or Decompose Agent adds a surface once the architect confirms where it lives.`,
    };
  }

  const records = surfaces.map((s) => bySurface.get(s) as SurfaceRecord);
  const inactive = records.filter((r) => r.status !== "active");
  if (inactive.length > 0) {
    return {
      ok: false,
      reason:
        `Surface(s) not active: ${inactive.map((r) => `${r.surface} (${r.status})`).join(", ")}. ` +
        `A story cannot be dispatched into a surface recorded as "none" or "deprecated".`,
    };
  }

  const first = records[0] as SurfaceRecord;
  const mismatched = records.filter((r) => !sameRepoAndRef(r.repoBase, first.repoBase));
  if (mismatched.length > 0) {
    const detail = records.map((r) => `${r.surface}: ${formatRepoBase(r.repoBase)}`).join("; ");
    return {
      ok: false,
      reason:
        `This story's surfaces resolve to different repos or refs (${detail}); they must share one repo and ref. ` +
        `Decomposition should not have assigned them together.`,
    };
  }

  return { ok: true, target: { repoBase: first.repoBase, surfaces: records } };
}

/** The registry block as the agents write it — one canonical rendering, so regeneration is stable. */
export function renderSurfacesBlock(records: readonly SurfaceRecord[]): string {
  const body = records
    .map((r) => {
      if (r.status === "none") return `surface: ${r.surface}\nstatus: none`;
      return [
        `surface: ${r.surface}`,
        `repo: ${r.repoBase.host}/${r.repoBase.org}/${r.repoBase.repo}`,
        `ref: ${r.repoBase.ref}`,
        `path: ${r.path}`,
        `conventions: ${r.conventions}`,
        `skills: ${r.skills.join(", ")}`,
        `status: ${r.status}`,
      ].join("\n");
    })
    .join("\n\n");
  return "```surfaces\n" + body + "\n```";
}
