/**
 * Leveled logging. Every module logs through a scoped logger created here
 * rather than calling console.* directly, so verbosity is one env var away
 * from being turned up or down without touching call sites. This is that
 * exception for this package, same as webhook-listener/src/logger.ts is for
 * its own.
 *
 * Levels, low to high severity: trace < debug < info < warn < error. LOG_LEVEL
 * sets the threshold — a message below it is dropped. Default: info.
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
  child(suffix: string): Logger;
}

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

export function createLogger(scope: string): Logger {
  return makeLogger(scope);
}
