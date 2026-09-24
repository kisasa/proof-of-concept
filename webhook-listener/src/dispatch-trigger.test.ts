import { describe, it, expect, vi, beforeEach } from "vitest";

const postErrorComment = vi.fn();
vi.mock("./tracker-notifier.js", () => ({
  default: { postErrorComment: (...args: unknown[]) => postErrorComment(...args) },
}));

const fetchStoryDispatchContext = vi.fn();
vi.mock("./story-context.js", () => ({
  fetchStoryDispatchContext: (...args: unknown[]) => fetchStoryDispatchContext(...args),
}));

const moveStoryToTodo = vi.fn();
vi.mock("./move-story-to-todo.js", () => ({
  moveStoryToTodo: (...args: unknown[]) => moveStoryToTodo(...args),
}));

class FakeAlreadyStartedError extends Error {}
vi.mock("@temporalio/client", () => ({
  WorkflowExecutionAlreadyStartedError: FakeAlreadyStartedError,
}));

const { createDispatchTrigger, resolveMaxTurns } = await import("./dispatch-trigger.js");

const MOVER = { id: "00000000-0000-4000-8000-000000000001", name: "Example User", email: "user@example.com" };

const WELL_FORMED_CONTEXT = {
  ok: true,
  context: {
    storyId: "story-1",
    storyBranch: "story/story-1",
    surfaces: ["backend"],
    tier: null,
    size: null,
    epicId: "epic-1",
    epicBranch: "epic/epic-1",
  },
};

function makeConfig(startImpl: (...args: unknown[]) => unknown) {
  const start = vi.fn(startImpl);
  const client = { workflow: { start: start } };
  return {
    config: {
      linearAgentApiKey: "test-api-key",
      linearApiUrl: "https://api.linear.app/graphql",
      getClient: vi.fn().mockResolvedValue(client),
      taskQueue: () => "dispatch-task-queue",
    },
    start: start,
  };
}

beforeEach(() => {
  postErrorComment.mockReset();
  fetchStoryDispatchContext.mockReset();
  moveStoryToTodo.mockReset();
});

describe("createDispatchTrigger", () => {
  it("starts the workflow with a full input built from the story's dispatch context", async () => {
    fetchStoryDispatchContext.mockResolvedValue(WELL_FORMED_CONTEXT);
    const { config, start } = makeConfig(() => ({ workflowId: "dispatch-story-1" }));
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Add refund data model", "trace-1", MOVER);

    expect(start).toHaveBeenCalledWith("dispatchStoryWorkflow", {
      workflowId: "dispatch-story-1",
      taskQueue: "dispatch-task-queue",
      args: [
        {
          storyId: "story-1",
          storyTitle: "Add refund data model",
          epicId: "epic-1",
          surfaces: ["backend"],
          storyBranch: "story/story-1",
          epicBranch: "epic/epic-1",
          maxTurns: 80,
          mover: MOVER,
        },
      ],
    });
    expect(postErrorComment).not.toHaveBeenCalled();
    expect(moveStoryToTodo).not.toHaveBeenCalled();
  });

  it("sizes maxTurns from the story's tier label alone", async () => {
    fetchStoryDispatchContext.mockResolvedValue({
      ok: true,
      context: { ...WELL_FORMED_CONTEXT.context, tier: "mid" },
    });
    const { config, start } = makeConfig(() => ({ workflowId: "dispatch-story-1" }));
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Add refund data model", "trace-1", MOVER);

    expect(start).toHaveBeenCalledWith(
      "dispatchStoryWorkflow",
      expect.objectContaining({ args: [expect.objectContaining({ maxTurns: 160 })] }),
    );
  });

  it("gives a large-tier story the biggest single-axis turn budget", async () => {
    fetchStoryDispatchContext.mockResolvedValue({
      ok: true,
      context: { ...WELL_FORMED_CONTEXT.context, tier: "large" },
    });
    const { config, start } = makeConfig(() => ({ workflowId: "dispatch-story-1" }));
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Add refund data model", "trace-1", MOVER);

    expect(start).toHaveBeenCalledWith(
      "dispatchStoryWorkflow",
      expect.objectContaining({ args: [expect.objectContaining({ maxTurns: 320 })] }),
    );
  });

  it("compounds tier and size multipliers together (a real observed shape)", async () => {
    fetchStoryDispatchContext.mockResolvedValue({
      ok: true,
      context: { ...WELL_FORMED_CONTEXT.context, tier: "small", size: "medium" },
    });
    const { config, start } = makeConfig(() => ({ workflowId: "dispatch-story-1" }));
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Add refund data model", "trace-1", MOVER);

    expect(start).toHaveBeenCalledWith(
      "dispatchStoryWorkflow",
      expect.objectContaining({ args: [expect.objectContaining({ maxTurns: 160 })] }),
    );
  });

  it("an explicit config.maxTurns override wins over the tier/size lookup", async () => {
    fetchStoryDispatchContext.mockResolvedValue({
      ok: true,
      context: { ...WELL_FORMED_CONTEXT.context, tier: "large" },
    });
    const { config, start } = makeConfig(() => ({ workflowId: "dispatch-story-1" }));
    const trigger = createDispatchTrigger({ ...config, maxTurns: 5 });

    await trigger("story-1", "first", "Add refund data model", "trace-1", MOVER);

    expect(start).toHaveBeenCalledWith(
      "dispatchStoryWorkflow",
      expect.objectContaining({ args: [expect.objectContaining({ maxTurns: 5 })] }),
    );
  });

  it("uses a fallback title when entityTitle is null", async () => {
    fetchStoryDispatchContext.mockResolvedValue(WELL_FORMED_CONTEXT);
    const { config, start } = makeConfig(() => ({ workflowId: "dispatch-story-1" }));
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", null, "trace-1", null);

    expect(start).toHaveBeenCalledWith(
      "dispatchStoryWorkflow",
      expect.objectContaining({ args: [expect.objectContaining({ storyTitle: "(untitled)" })] }),
    );
  });

  it("posts an error comment and does not start a workflow when the story isn't dispatchable", async () => {
    fetchStoryDispatchContext.mockResolvedValue({ ok: false, reason: "no surface:<name> label found" });
    const { config, start } = makeConfig(() => ({}));
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Some story", "trace-1", null);

    expect(start).not.toHaveBeenCalled();
    expect(postErrorComment).toHaveBeenCalledWith(
      "story-1",
      "issue",
      "trace-1",
      "This story could not be dispatched: no surface:<name> label found.",
    );
    expect(moveStoryToTodo).toHaveBeenCalledWith("story-1", "test-api-key", "https://api.linear.app/graphql", "trace-1");
  });

  it("treats an already-started workflow as a benign no-op, not an error comment or a status move", async () => {
    fetchStoryDispatchContext.mockResolvedValue(WELL_FORMED_CONTEXT);
    const { config } = makeConfig(() => {
      throw new FakeAlreadyStartedError("already started");
    });
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Some story", "trace-1", null);

    expect(postErrorComment).not.toHaveBeenCalled();
    expect(moveStoryToTodo).not.toHaveBeenCalled();
  });

  it("posts an error comment and moves the story back to Todo when the workflow fails to start for any other reason", async () => {
    fetchStoryDispatchContext.mockResolvedValue(WELL_FORMED_CONTEXT);
    const { config } = makeConfig(() => {
      throw new Error("connection refused");
    });
    const trigger = createDispatchTrigger(config);

    await trigger("story-1", "first", "Some story", "trace-1", null);

    expect(postErrorComment).toHaveBeenCalledWith("story-1", "issue", "trace-1", "Dispatch could not start: connection refused");
    expect(moveStoryToTodo).toHaveBeenCalledWith("story-1", "test-api-key", "https://api.linear.app/graphql", "trace-1");
  });
});

describe("resolveMaxTurns", () => {
  it("lands on the base 80 when neither label is recognized", () => {
    expect(resolveMaxTurns(null, null)).toBe(80);
  });

  it("applies the tier multiplier alone when size is unrecognized", () => {
    expect(resolveMaxTurns("mid", null)).toBe(160);
    expect(resolveMaxTurns("large", null)).toBe(320);
  });

  it("applies the size multiplier alone when tier is unrecognized", () => {
    expect(resolveMaxTurns(null, "medium")).toBe(160);
    expect(resolveMaxTurns(null, "large")).toBe(320);
  });

  it("compounds both multipliers — a real observed shape: tier:small × size:medium", () => {
    expect(resolveMaxTurns("small", "medium")).toBe(160);
  });

  it("compounds to the largest budget when both axes are elevated", () => {
    expect(resolveMaxTurns("large", "large")).toBe(1280);
  });
});
