import { describe, it, expect } from "vitest";
import { buildSystemBlocks } from "./prompt-assembly.js";

describe("buildSystemBlocks", () => {
  it("marks the only block with an ephemeral cache breakpoint when there are no skills", async () => {
    const blocks = await buildSystemBlocks("intake-agent.md", []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks only the last block — a cache breakpoint covers everything up through it, so one at the end is enough", async () => {
    const blocks = await buildSystemBlocks("decompose-agent.md", ["epic-writing", "story-contract"]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toBeUndefined();
    expect(blocks[2]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
