import { describe, it, expect, vi, afterEach } from "vitest";

// The threshold is read from LOG_LEVEL once at module load, matching every
// other env var in this codebase — so each scenario needs a fresh module
// instance with the env var stubbed before import.
async function importLoggerWith(level: string | undefined) {
  vi.resetModules();
  if (level === undefined) {
    vi.stubEnv("LOG_LEVEL", "");
    delete process.env.LOG_LEVEL;
  } else {
    vi.stubEnv("LOG_LEVEL", level);
  }
  return import("./logger.js");
}

function spyConsole() {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("createLogger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefixes every line with the scope, defaulting to info level", async () => {
    const { createLogger } = await importLoggerWith(undefined);
    const spies = spyConsole();
    const log = createLogger("test-scope");

    log.debug("a debug line");
    log.info("an info line");
    log.warn("a warn line");
    log.error("an error line");

    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith("[test-scope] an info line");
    expect(spies.warn).toHaveBeenCalledWith("[test-scope] a warn line");
    expect(spies.error).toHaveBeenCalledWith("[test-scope] an error line");
  });

  it("falls back to info for an unrecognized LOG_LEVEL value", async () => {
    const { createLogger } = await importLoggerWith("verbose");
    const spies = spyConsole();
    const log = createLogger("test-scope");

    log.debug("suppressed");
    log.info("shown");

    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalled();
  });

  it("emits debug and everything above it when LOG_LEVEL=debug", async () => {
    const { createLogger } = await importLoggerWith("debug");
    const spies = spyConsole();
    const log = createLogger("test-scope");

    log.debug("now visible");

    expect(spies.debug).toHaveBeenCalledWith("[test-scope] now visible");
  });

  it("suppresses info and warn when LOG_LEVEL=error", async () => {
    const { createLogger } = await importLoggerWith("error");
    const spies = spyConsole();
    const log = createLogger("test-scope");

    log.info("suppressed");
    log.warn("suppressed");
    log.error("shown");

    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith("[test-scope] shown");
  });

  it("passes additional args through to console", async () => {
    const { createLogger } = await importLoggerWith(undefined);
    const spies = spyConsole();
    const log = createLogger("test-scope");
    const err = new Error("boom");

    log.error("failed:", err);

    expect(spies.error).toHaveBeenCalledWith("[test-scope] failed:", err);
  });

  it("suppresses trace by default and shows it only at LOG_LEVEL=trace", async () => {
    const atInfo = await importLoggerWith(undefined);
    const infoSpies = spyConsole();
    atInfo.createLogger("test-scope").trace("hidden at default level");
    expect(infoSpies.debug).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    const atTrace = await importLoggerWith("trace");
    const traceSpies = spyConsole();
    atTrace.createLogger("test-scope").trace("visible at trace level");
    expect(traceSpies.debug).toHaveBeenCalledWith("[test-scope] visible at trace level");
  });

  it("never calls console.trace, which dumps a stack trace rather than logging a line", async () => {
    const { createLogger } = await importLoggerWith("trace");
    const traceSpy = vi.spyOn(console, "trace").mockImplementation(() => {});
    spyConsole();

    createLogger("test-scope").trace("a trace line");

    expect(traceSpy).not.toHaveBeenCalled();
  });

  it("child() composes the scope and inherits the same level threshold", async () => {
    const { createLogger } = await importLoggerWith("info");
    const spies = spyConsole();
    const log = createLogger("webhook").child("a1b2c3d4");

    log.debug("suppressed, same threshold as the parent");
    log.info("an info line");

    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith("[webhook:a1b2c3d4] an info line");
  });
});
