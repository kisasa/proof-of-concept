import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalEnvFile } from "./local-env-file.js";

describe("loadLocalEnvFile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a no-op when LOCAL_ENV_FILE is unset — the production case", async () => {
    vi.stubEnv("LOCAL_ENV_FILE", undefined as unknown as string);
    delete process.env.LOCAL_ENV_FILE;
    delete process.env.SOME_TEST_VAR;

    await expect(loadLocalEnvFile()).resolves.toBeUndefined();
    expect(process.env.SOME_TEST_VAR).toBeUndefined();
  });

  it("gives up quietly when the file never appears, after the given number of retries", async () => {
    vi.stubEnv("LOCAL_ENV_FILE", join(tmpdir(), "does-not-exist-localstack.env"));
    await expect(loadLocalEnvFile(2, 1)).resolves.toBeUndefined();
  });

  it("loads KEY=VALUE lines into process.env, skipping blanks and comments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-env-file-test-"));
    const filePath = join(dir, "localstack.env");
    writeFileSync(
      filePath,
      ["SPECIALIST_CLUSTER_ARN=arn:aws:ecs:us-east-1:000000000000:cluster/specialist-local", "", "# a comment", "SPECIALIST_CONTAINER_NAME=specialist-local"].join(
        "\n",
      ),
    );
    vi.stubEnv("LOCAL_ENV_FILE", filePath);
    delete process.env.SPECIALIST_CLUSTER_ARN;
    delete process.env.SPECIALIST_CONTAINER_NAME;

    await loadLocalEnvFile();

    expect(process.env.SPECIALIST_CLUSTER_ARN).toBe("arn:aws:ecs:us-east-1:000000000000:cluster/specialist-local");
    expect(process.env.SPECIALIST_CONTAINER_NAME).toBe("specialist-local");

    rmSync(dir, { recursive: true, force: true });
  });

  it("never overwrites a value already set in process.env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-env-file-test-"));
    const filePath = join(dir, "localstack.env");
    writeFileSync(filePath, "SPECIALIST_CLUSTER_ARN=from-file\n");
    vi.stubEnv("LOCAL_ENV_FILE", filePath);
    vi.stubEnv("SPECIALIST_CLUSTER_ARN", "already-set");

    await loadLocalEnvFile();

    expect(process.env.SPECIALIST_CLUSTER_ARN).toBe("already-set");

    rmSync(dir, { recursive: true, force: true });
  });

  it("does overwrite a value that's set to an empty string — the real bug this file existed to fix", async () => {
    // dispatch-worker/.env (copied from .env.example) has literal
    // `SPECIALIST_CLUSTER_ARN=` lines — env_file sets these to "", not
    // undefined (env.ts's own envOr documents the same gotcha). An
    // `=== undefined` overwrite check would silently keep this empty
    // string forever, exactly the bug found and fixed here.
    const dir = mkdtempSync(join(tmpdir(), "local-env-file-test-"));
    const filePath = join(dir, "localstack.env");
    writeFileSync(filePath, "SPECIALIST_CLUSTER_ARN=from-file\n");
    vi.stubEnv("LOCAL_ENV_FILE", filePath);
    vi.stubEnv("SPECIALIST_CLUSTER_ARN", "");

    await loadLocalEnvFile();

    expect(process.env.SPECIALIST_CLUSTER_ARN).toBe("from-file");

    rmSync(dir, { recursive: true, force: true });
  });

  it("retries until the file actually has content — the Docker-Desktop-bind-mount-lag case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-env-file-test-"));
    const filePath = join(dir, "localstack.env");
    // Simulates the file existing but empty (bootstrap hasn't finished
    // propagating yet, from this container's point of view) on the first
    // read, then having real content by the second.
    writeFileSync(filePath, "");
    vi.stubEnv("LOCAL_ENV_FILE", filePath);
    delete process.env.SPECIALIST_CLUSTER_ARN;

    setTimeout(() => writeFileSync(filePath, "SPECIALIST_CLUSTER_ARN=arn:aws:ecs:us-east-1:000000000000:cluster/specialist-local\n"), 5);

    await loadLocalEnvFile(10, 20);

    expect(process.env.SPECIALIST_CLUSTER_ARN).toBe("arn:aws:ecs:us-east-1:000000000000:cluster/specialist-local");

    rmSync(dir, { recursive: true, force: true });
  });
});
