/**
 * Leveled logging. Every module logs through a scoped logger created here
 * rather than calling console.* directly, so verbosity is one env var away
 * from being turned up or down without touching call sites.
 *
 * Levels, low to high severity: trace < debug < info < warn < error. LOG_LEVEL
 * sets the threshold — a message below it is dropped. Default: info. Read
 * once at module load, like every other env var in this codebase.
 *
 * trace is the "show everything" tier: every decision and move through a
 * single request/activation, not just the noteworthy diagnostics debug
 * carries. Pair it with child() (below) to stitch those lines together.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

function parseLevel(raw: string | undefined): LogLevel {
  if (raw === "trace" || raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const threshold = LEVEL_ORDER[parseLevel(process.env.LOG_LEVEL)];

export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;

  // Returns a logger whose scope is this logger's scope plus one more
  // segment — e.g. createLogger("webhook").child(traceId) logs as
  // "[webhook:a1b2c3d4]". Use this to stitch every line one webhook
  // delivery (and whatever activation it eventually causes) produces into
  // one greppable id, without threading a logger-construction call through
  // every function — construct the child once, pass that Logger down.
  child(suffix: string): Logger;
}

// console has its own console.trace() that dumps a full stack trace on every
// call — not what a "trace" severity log line means here. Both trace and
// debug render through console.debug; LEVEL_ORDER is what actually
// distinguishes them for filtering.
function consoleMethodFor(level: LogLevel): "debug" | "info" | "warn" | "error" {
  return level === "trace" ? "debug" : level;
}

function emit(level: LogLevel, scope: string, message: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold) return;
  console[consoleMethodFor(level)](`[${scope}] ${message}`, ...args);
}

function makeLogger(scope: string): Logger {
  return {
    trace(message: string, ...args: unknown[]): void {
      emit("trace", scope, message, args);
    },
    debug(message: string, ...args: unknown[]): void {
      emit("debug", scope, message, args);
    },
    info(message: string, ...args: unknown[]): void {
      emit("info", scope, message, args);
    },
    warn(message: string, ...args: unknown[]): void {
      emit("warn", scope, message, args);
    },
    error(message: string, ...args: unknown[]): void {
      emit("error", scope, message, args);
    },
    child(suffix: string): Logger {
      return makeLogger(`${scope}:${suffix}`);
    },
  };
}

// scope prefixes every line (e.g. "webhook", "linear", or a lane name) so log
// output stays greppable without each call site re-typing its own tag.
export function createLogger(scope: string): Logger {
  return makeLogger(scope);
}
