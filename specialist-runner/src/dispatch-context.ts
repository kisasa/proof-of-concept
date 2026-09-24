/**
 * The contract between this runner and whatever dispatches it —
 * `dispatch-worker/src/activities/dispatch-specialist.ts` calls `ecs:RunTask`
 * with these as container overrides. Fails fast, naming the missing var,
 * rather than partway through a run — same discipline as
 * `infrastructure/models/context.ts`'s `requireX` helpers, just over env vars
 * instead of a JSON context tree.
 */

// A surface is a place work happens — a repo, or a project inside one. The
// vocabulary is open (whatever this engagement actually has), not a fixed
// union, so this is a plain string alias, matching `dispatch-worker/src/
// activities/types.ts`'s own `Surface`.
export type Surface = string;

export interface DispatchContext {
  readonly storyId: string;
  readonly storyTitle: string;
  readonly epicId: string;

  /** Every `surface:<name>` label the story carries — one or more. */
  readonly surfaces: Surface[];

  /** `org/name` on GitHub — the one repo this run writes to. */
  readonly surfaceRepo: string;
  /**
   * Directory of each surface within the repo (`/` for the root), same order
   * as `surfaces`, from the surface registry. Optional in the env contract so
   * a dispatcher predating the registry still works; defaults to `/` for each.
   */
  readonly surfacePaths: string[];
  /**
   * Mandatory skills for the story's surfaces, from the surface registry.
   * Resolved at prompt-build time — the surface repo's own `.claude/skills/`
   * first, the framework catalog second — and inlined into the system prompt,
   * so a mandatory skill is guaranteed read rather than discretionarily
   * discovered. Optional in the env contract; defaults to none.
   */
  readonly surfaceSkills: string[];
  readonly storyBranch: string;
  readonly epicBranch: string;

  /** `org/name` on GitHub for the framework repo. */
  readonly frameworkRepo: string;

  /** Git ref of the framework repo to clone. */
  readonly frameworkRef: string;

  /**
   * Hard cap on Agent SDK turns for this run. Required, not defaulted-and-
   * forgotten: the ledger is explicit that a session "does not time out on
   * its own," so a caller must set this deliberately.
   */
  readonly maxTurns: number;

  /**
   * Set only on a revision round — the reviewer-of-record asked for changes
   * on a PR this story already has open. Null means this is the story's
   * first build, and the absence of these vars is the only thing
   * distinguishing the two modes.
   */
  readonly revision: RevisionContext | null;
}

/**
 * What a revision round is told. The review's prose and its inline comments
 * are deliberately not passed: the specialist reads them from the PR itself,
 * the same way it reads the story and the code. An agent handed a
 * pre-digested copy builds against the copy.
 */
export interface RevisionContext {
  readonly round: number;
  readonly roundCap: number;
  readonly pullRequestNumber: number;
  readonly reviewId: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — the dispatching worker must set this as a RunTask override`);
  }
  return value;
}

/**
 * `SURFACES` is comma-separated because a story may carry more than one
 * `surface:` label (docs/design-ledger.md, 2026-08-08) — all resolving to
 * this same repo, so this runner still clones exactly one. No supported-list
 * check here: the surface vocabulary is open, and whether the epic actually
 * recognizes a given surface was already validated upstream, by
 * `dispatch-worker`'s `resolveSurfaces`, before this container was ever
 * launched.
 */
function requireSurfaces(name: string): Surface[] {
  const raw = requireEnv(name);
  const surfaces = raw
    .split(",")
    .map((surface) => surface.trim())
    .filter((surface) => surface.length > 0);
  if (surfaces.length === 0) {
    throw new Error(`${name}="${raw}" must name at least one surface`);
  }
  return surfaces;
}

function optionalList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function requireMaxTurns(name: string): number {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}="${raw}" must be a positive number`);
  }
  return value;
}

function surfacePathsFor(surfaces: Surface[], paths: string[]): string[] {
  if (paths.length === 0) return surfaces.map(() => "/");
  if (paths.length !== surfaces.length) {
    throw new Error(`SURFACE_PATHS lists ${paths.length} path(s) for ${surfaces.length} surface(s); they must correspond one to one`);
  }
  return paths;
}

function requirePositiveInt(name: string): number {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}="${raw}" must be a positive integer`);
  }
  return value;
}

/**
 * All four revision vars travel together or not at all. A partial set means
 * the dispatcher is broken, and guessing at the missing half would produce a
 * revision run that does not know which review it is answering — worse than
 * refusing, because it would still open with confident-looking output.
 */
function optionalRevision(): RevisionContext | null {
  if (!process.env.REVISION_ROUND) return null;
  return {
    round: requirePositiveInt("REVISION_ROUND"),
    roundCap: requirePositiveInt("REVISION_ROUND_CAP"),
    pullRequestNumber: requirePositiveInt("PULL_REQUEST_NUMBER"),
    reviewId: requirePositiveInt("REVIEW_ID"),
  };
}

export function loadDispatchContext(): DispatchContext {
  return {
    storyId: requireEnv("STORY_ID"),
    storyTitle: requireEnv("STORY_TITLE"),
    epicId: requireEnv("EPIC_ID"),
    surfaces: requireSurfaces("SURFACES"),
    surfaceRepo: requireEnv("SURFACE_REPO"),
    surfacePaths: surfacePathsFor(requireSurfaces("SURFACES"), optionalList("SURFACE_PATHS")),
    surfaceSkills: optionalList("SURFACE_SKILLS"),
    storyBranch: requireEnv("STORY_BRANCH"),
    epicBranch: requireEnv("EPIC_BRANCH"),
    frameworkRepo: requireEnv("FRAMEWORK_REPO"),
    frameworkRef: requireEnv("FRAMEWORK_REF"),
    maxTurns: requireMaxTurns("MAX_TURNS"),
    revision: optionalRevision(),
  };
}
