import { describe, it, expect, vi, beforeAll } from "vitest";
import type { AgentLaneConfig } from "./agent-lane.js";
import { buildSystemBlocks } from "./prompt-assembly.js";

/**
 * Every agent file and skill a lane loads must exist in this repository's
 * own agents/ and skills/ — the pipeline's definitions are its own, never
 * another pipeline's. A lane naming a definition that is not here would
 * otherwise surface only at activation time, as a failed run on a live
 * tracker entity.
 */

let laneConfigs: AgentLaneConfig[] = [];

beforeAll(async () => {
  // Lane modules read their model at import (env.ts's requireEnv); the values
  // are irrelevant here, only that the modules load.
  vi.stubEnv("CLAUDE_MODEL_INTAKE", "test-model");
  vi.stubEnv("CLAUDE_MODEL_SPECIFICATION", "test-model");
  const lanes = await Promise.all([import("./lanes/intake.js"), import("./lanes/specification.js")]);
  laneConfigs = lanes.map((lane) => lane.config);
});

describe("lane definitions", () => {
  it("covers both Anthropic-calling lanes", () => {
    expect(laneConfigs.map((lane) => lane.name)).toEqual(["intake", "specification"]);
  });

  it("resolves every lane's agent file and skills inside this repository", async () => {
    for (const lane of laneConfigs) {
      const blocks = await buildSystemBlocks(lane.agentFile, lane.skills);
      expect(blocks, lane.name).toHaveLength(1 + lane.skills.length);
    }
  });
});
