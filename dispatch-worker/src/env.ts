/**
 * A `.env` file with `KEY=` present but no value sets process.env.KEY to an
 * empty string, not undefined — `??` doesn't fall back on that, so every env
 * var in this codebase that has a real default needs a truthy check instead.
 *
 * Only ever call this at module load, per this repo's env-var convention —
 * never inside a function.
 */
export function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? value : fallback;
}
