/**
 * Local-dev-only: loads `KEY=VALUE` lines from a file into `process.env`,
 * for any key not already set. Exists because docker-compose's own
 * `env_file:` directive resolves at container *creation* time, not process-
 * start time — confirmed empirically, not assumed: `dispatch-worker`'s
 * container was created (and its env snapshotted) before
 * `localstack-bootstrap` ever ran, so the `SPECIALIST_*` values that
 * script writes (see `scripts/localstack-bootstrap.sh`) never reached
 * `dispatch-worker` via `env_file` within a single `docker compose up`. A
 * bind mount, read here at actual process start instead, sidesteps that.
 *
 * The retry loop is defensive margin around container-start-order timing,
 * not a confirmed requirement — debug logging during the actual bug hunt
 * showed the file's real content was already there on the very first read,
 * every time. What genuinely was broken, and is the reason this file exists
 * in its current form: the same gotcha `env.ts`'s own `envOr` documents — a
 * `.env` file with `KEY=` present but no value sets `process.env.KEY` to an
 * empty string, not `undefined`. `dispatch-worker/.env` (copied from
 * `.env.example`) has exactly this for every `SPECIALIST_*` line, so an
 * `=== undefined` overwrite check silently let those empty strings win over
 * this file's real values — confirmed by adding temporary debug logging and
 * watching a fully correct read still fail to reach `loadWorkerConfig()`.
 *
 * A no-op in production: `LOCAL_ENV_FILE` is only ever set by
 * `docker-compose.yml`'s local dev stack.
 */

import { existsSync, readFileSync } from "node:fs";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Blank and comment-only content looks identical to "not written yet." */
function hasRealContent(content: string): boolean {
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}

function applyEnvFileContent(content: string): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    // Same gotcha env.ts's own envOr documents: a `.env` file with `KEY=`
    // present but no value sets process.env.KEY to an empty string, not
    // undefined — dispatch-worker/.env (copied from .env.example) has
    // exactly this for every SPECIALIST_* line, so `=== undefined` alone
    // would never let this file's real values through.
    if (!process.env[key]) process.env[key] = value;
  }
}

export async function loadLocalEnvFile(retries = 10, delayMs = 1000): Promise<void> {
  const path = process.env.LOCAL_ENV_FILE;
  if (!path) return;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (hasRealContent(content)) {
        applyEnvFileContent(content);
        return;
      }
    }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  // Give up silently — loadWorkerConfig() reports exactly which var is
  // still missing, a clearer error for whoever's debugging than one raised
  // here would be.
}
