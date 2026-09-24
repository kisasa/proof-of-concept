/**
 * A surface is a place work happens — a repo, or a project inside one.
 * Same alias as `specialist-runner/src/dispatch-context.ts`'s `Surface`.
 * Was `SpecialistType`, a fixed union of the four specialist types, until
 * the specialist-types-collapse-into-surfaces redesign
 * (`docs/design-ledger.md`, 2026-08-08) opened the vocabulary: a surface is
 * whatever this engagement actually has, so it's a plain string rather than
 * an enumerated set. Dispatch mechanics (dependency check, branch creation,
 * repo-base resolution) were already fully generic over it before that —
 * only the type-name coupling and the `specialist-${type}.md` file lookup
 * (gone now — one `agents/specialist.md`) ever pinned it to four values.
 */
export type Surface = string;

/**
 * Whoever moved the story to In-Process — webhook-listener's own TrackerActor,
 * re-declared here rather than imported since the two packages share no lib
 * (this repo's existing pattern). Carries `email` because that's the only
 * field `requestPullRequestReviewer` can resolve to a GitHub login through the
 * static mapping — `id`/`name` ride along for logging only.
 */
export interface StoryMover {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}
