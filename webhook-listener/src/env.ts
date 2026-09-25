/**
 * A `.env` file with `KEY=` present but no value sets process.env.KEY to an
 * empty string, not undefined — `??` doesn't fall back on that, so every env
 * var in this codebase that has a real default needs a truthy check instead.
 * `.env.example` ships every var as `KEY=`, so this is the common case, not
 * an edge case.
 *
 * Only ever call this at module load, per this repo's env-var convention —
 * never inside a function.
 */
export function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? value : fallback;
}

/**
 * The required counterpart to envOr, for values with no code-level default —
 * an infra-supplied setting (e.g. a per-lane model, or effort) where guessing
 * a fallback would silently mask a missing deployment config. Same
 * module-load-only convention as envOr.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
