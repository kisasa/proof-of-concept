import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],

    // activation-config.ts requires CLAUDE_EFFORT at module load (see
    // env.ts's requireEnv) — real deployments get it from infra
    // (infrastructure/models/listener-configuration.ts), but
    // activation-runner.test.ts imports that module transitively just by
    // importing activation-runner.ts. This is test-fixture wiring, not a
    // code-level default — the source has none.
    env: {
      CLAUDE_EFFORT: "high",
    },
  },
});
