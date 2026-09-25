import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchStoryDispatchContext, parseSurfaces, parseTier, parseSize } from "./story-context.js";

const API_KEY = "test-api-key";
const BASE_URL = "https://api.linear.app/graphql";
const TRACE_ID = "trace-1";

function stubIssueQuery(issue: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issue: issue } }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSurfaces", () => {
  it("extracts a single surface from its label", () => {
    expect(parseSurfaces(["size:medium", "surface:backend"])).toEqual({ surfaces: ["backend"] });
  });

  it("accepts any surface name — the vocabulary is open, not a fixed list", () => {
    expect(parseSurfaces(["surface:mobile"])).toEqual({ surfaces: ["mobile"] });
  });

  it("extracts more than one surface label, in the order they were applied", () => {
    expect(parseSurfaces(["surface:web", "surface:e2e", "size:medium"])).toEqual({ surfaces: ["web", "e2e"] });
  });

  it("dedupes a repeated label", () => {
    expect(parseSurfaces(["surface:web", "size:medium", "surface:web"])).toEqual({ surfaces: ["web"] });
  });

  it("reports when no surface:* label is present", () => {
    expect(parseSurfaces(["size:medium"])).toEqual({
      reason: "no surface:<name> label found",
    });
  });
});

describe("parseTier", () => {
  it("extracts a recognized tier", () => {
    expect(parseTier(["surface:backend", "tier:mid"])).toBe("mid");
  });

  it("recognizes each of the three known tiers", () => {
    expect(parseTier(["tier:small"])).toBe("small");
    expect(parseTier(["tier:mid"])).toBe("mid");
    expect(parseTier(["tier:large"])).toBe("large");
  });

  it("returns null when no tier:* label is present", () => {
    expect(parseTier(["surface:backend", "size:medium"])).toBeNull();
  });

  it("returns null for an unrecognized tier value rather than treating it as fatal", () => {
    expect(parseTier(["tier:huge"])).toBeNull();
  });
});

describe("parseSize", () => {
  it("extracts a recognized size", () => {
    expect(parseSize(["surface:backend", "size:medium"])).toBe("medium");
  });

  it("recognizes each of the three known sizes", () => {
    expect(parseSize(["size:small"])).toBe("small");
    expect(parseSize(["size:medium"])).toBe("medium");
    expect(parseSize(["size:large"])).toBe("large");
  });

  it("returns null when no size:* label is present", () => {
    expect(parseSize(["surface:backend", "tier:small"])).toBeNull();
  });

  it("returns null for an unrecognized size value rather than treating it as fatal", () => {
    expect(parseSize(["size:huge"])).toBeNull();
  });
});

describe("fetchStoryDispatchContext", () => {
  it("builds a full dispatch context from a well-formed story", async () => {
    stubIssueQuery({
      id: "story-1",
      branchName: "story/story-1-add-refund-model",
      labels: { nodes: [{ name: "surface:backend" }, { name: "size:medium" }, { name: "tier:mid" }] },
      parent: { id: "epic-1", branchName: "epic/epic-1-refunds" },
    });

    const result = await fetchStoryDispatchContext("story-1", API_KEY, BASE_URL, TRACE_ID);

    expect(result).toEqual({
      ok: true,
      context: {
        storyId: "story-1",
        storyBranch: "story/story-1-add-refund-model",
        surfaces: ["backend"],
        tier: "mid",
        size: "medium",
        epicId: "epic-1",
        epicBranch: "epic/epic-1-refunds",
      },
    });
  });

  it("carries a null tier and size through when the story has neither recognized label", async () => {
    stubIssueQuery({
      id: "story-1",
      branchName: "story/story-1-add-refund-model",
      labels: { nodes: [{ name: "surface:backend" }] },
      parent: { id: "epic-1", branchName: "epic/epic-1-refunds" },
    });

    const result = await fetchStoryDispatchContext("story-1", API_KEY, BASE_URL, TRACE_ID);

    expect(result).toEqual({
      ok: true,
      context: {
        storyId: "story-1",
        storyBranch: "story/story-1-add-refund-model",
        surfaces: ["backend"],
        tier: null,
        size: null,
        epicId: "epic-1",
        epicBranch: "epic/epic-1-refunds",
      },
    });
  });

  it("carries more than one surface label through when a story has several", async () => {
    stubIssueQuery({
      id: "story-1",
      branchName: "story/story-1-refund-flow",
      labels: { nodes: [{ name: "surface:web" }, { name: "surface:e2e" }] },
      parent: { id: "epic-1", branchName: "epic/epic-1-refunds" },
    });

    const result = await fetchStoryDispatchContext("story-1", API_KEY, BASE_URL, TRACE_ID);

    expect(result).toEqual({
      ok: true,
      context: {
        storyId: "story-1",
        storyBranch: "story/story-1-refund-flow",
        surfaces: ["web", "e2e"],
        tier: null,
        size: null,
        epicId: "epic-1",
        epicBranch: "epic/epic-1-refunds",
      },
    });
  });

  it("returns ok:false when the story has no parent epic recorded", async () => {
    stubIssueQuery({
      id: "story-1",
      branchName: "story/story-1",
      labels: { nodes: [{ name: "surface:backend" }] },
      parent: null,
    });

    const result = await fetchStoryDispatchContext("story-1", API_KEY, BASE_URL, TRACE_ID);
    expect(result).toEqual({ ok: false, reason: "story has no parent epic recorded" });
  });

  it("returns ok:false when no surface:* label is present", async () => {
    stubIssueQuery({
      id: "story-1",
      branchName: "story/story-1",
      labels: { nodes: [{ name: "size:medium" }] },
      parent: { id: "epic-1", branchName: "epic/epic-1" },
    });

    const result = await fetchStoryDispatchContext("story-1", API_KEY, BASE_URL, TRACE_ID);
    expect(result).toEqual({ ok: false, reason: "no surface:<name> label found" });
  });

  it("returns ok:false when the story could not be read from the tracker", async () => {
    stubIssueQuery(null);

    const result = await fetchStoryDispatchContext("missing-story", API_KEY, BASE_URL, TRACE_ID);
    expect(result).toEqual({ ok: false, reason: "story missing-story could not be read from the tracker" });
  });

  it("throws when the API key is missing", async () => {
    await expect(fetchStoryDispatchContext("story-1", "", BASE_URL, TRACE_ID)).rejects.toThrow(
      "LINEAR_AGENT_API_KEY is not set",
    );
  });

  it("throws on a GraphQL error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ errors: ["boom"] }) }),
    );
    await expect(fetchStoryDispatchContext("story-1", API_KEY, BASE_URL, TRACE_ID)).rejects.toThrow(
      "Linear GraphQL error",
    );
  });
});
