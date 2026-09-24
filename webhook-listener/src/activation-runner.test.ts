import { describe, it, expect } from "vitest";
import { findMcpError, findDuplicateWrites, type ToolUseRecord } from "./activation-runner.js";

// Minimal content blocks — only the fields findMcpError reads.
function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: "mcp_tool_use", id: id, name: name, input: input };
}
function toolResult(toolUseId: string, isError: boolean) {
  return { type: "mcp_tool_result", tool_use_id: toolUseId, is_error: isError, content: "result" };
}

describe("findMcpError", () => {
  it("returns null when nothing errored", () => {
    const content = [toolUse("t1", "get_issue"), toolResult("t1", false)];
    expect(findMcpError(content as never)).toBeNull();
  });

  it("ignores a failed read tool Claude recovered from (the observed false-positive case)", () => {
    // Real shape from a 2026-07-15 run: list_comments and get_document both
    // timed out; Claude tried other paths and still completed a real write
    // (save_comment, not shown here) — this must not be reported as a failure.
    const content = [
      toolUse("t1", "get_project"),
      toolResult("t1", false),
      toolUse("t2", "list_comments"),
      toolResult("t2", true),
      toolUse("t3", "get_document"),
      toolResult("t3", true),
      toolUse("t4", "save_comment"),
      toolResult("t4", false),
    ];
    expect(findMcpError(content as never)).toBeNull();
  });

  it("flags a failed write tool even if reads earlier succeeded", () => {
    const content = [
      toolUse("t1", "get_issue"),
      toolResult("t1", false),
      toolUse("t2", "save_comment"),
      toolResult("t2", true),
    ];
    expect(findMcpError(content as never)).not.toBeNull();
  });

  it("errs toward flagging when the tool name can't be resolved", () => {
    const content = [{ type: "mcp_tool_result", tool_use_id: "unknown", is_error: true, content: "boom" }];
    expect(findMcpError(content as never)).not.toBeNull();
  });

  it("ignores a failed write immediately retried against the same target and succeeded", () => {
    // Real shape from a 2026-07-17 run: a pause_turn boundary landed mid-argument-
    // stream on save_comment, corrupting its body field; Claude retried the same
    // call against the same issueId with corrected arguments and it succeeded.
    const content = [
      toolUse("t1", "save_comment", { issueId: "PROJ-19", body: { garbled: true } }),
      toolResult("t1", true),
      toolUse("t2", "save_comment", { issueId: "PROJ-19", body: "corrected text" }),
      toolResult("t2", false),
    ];
    expect(findMcpError(content as never)).toBeNull();
  });

  it("still flags a failed write when a later success targets a different entity", () => {
    // Decompose creating several stories: story A's save_issue fails, story B's
    // save_issue (a different target) succeeds — must not swallow A's failure.
    const content = [
      toolUse("t1", "save_issue", { issueId: "PROJ-30", title: "Story A" }),
      toolResult("t1", true),
      toolUse("t2", "save_issue", { issueId: "PROJ-31", title: "Story B" }),
      toolResult("t2", false),
    ];
    expect(findMcpError(content as never)).not.toBeNull();
  });

  it("ignores a failed write with no usable target at all, retried successfully with a different key", () => {
    // Real shape from a 2026-07-29 run: save_comment came back as just
    // {"issueId": ""} — no body, no real target — and was rejected by the
    // MCP server's own schema validation. Claude retried immediately with a
    // complete, correctly-targeted call using `projectId` (the target was a
    // project, not an issue) and that retry succeeded. sameTarget alone
    // would miss this (empty issueId vs. a populated projectId share no
    // key/value), so the run got reported as failed on top of a comment
    // that had actually posted fine.
    const content = [
      toolUse("t1", "save_comment", { issueId: "" }),
      toolResult("t1", true),
      toolUse("t2", "save_comment", { projectId: "a50e804f-6aa3-47a0-b973-b5fc2a78fa66", body: "Decision: ask" }),
      toolResult("t2", false),
    ];
    expect(findMcpError(content as never)).toBeNull();
  });

  it("recovers a write's target from an earlier round via the cross-round tool-use map", () => {
    // The corrupted call's own tool_use lives in a prior (already-pushed) round,
    // not in the final content array being scanned — findMcpError must still be
    // able to resolve its target through the caller-supplied map.
    const allToolUses = new Map<string, ToolUseRecord>([
      ["t1", { name: "save_comment", input: { issueId: "PROJ-19", body: { garbled: true } } }],
    ]);
    const finalContent = [
      toolResult("t1", true),
      toolUse("t2", "save_comment", { issueId: "PROJ-19", body: "corrected text" }),
      toolResult("t2", false),
    ];
    expect(findMcpError(finalContent as never, allToolUses)).toBeNull();
  });
});

describe("findDuplicateWrites", () => {
  it("returns empty when no write repeats", () => {
    const content = [
      toolUse("t1", "save_comment", { issueId: "PROJ-19", body: "first" }),
      toolResult("t1", false),
      toolUse("t2", "save_comment", { issueId: "PROJ-19", body: "second" }),
      toolResult("t2", false),
    ];
    const allToolUses = new Map<string, ToolUseRecord>([
      ["t1", { name: "save_comment", input: { issueId: "PROJ-19", body: "first" } }],
      ["t2", { name: "save_comment", input: { issueId: "PROJ-19", body: "second" } }],
    ]);
    expect(findDuplicateWrites(content as never, allToolUses)).toEqual([]);
  });

  it("flags the same successful write repeated against the same target (the observed real case)", () => {
    // Real shape from a 2026-07-20 run: decompose posted the exact same
    // save_comment (same issueId, byte-identical body) twice, 219ms apart.
    // Neither call errored, so findMcpError has nothing to see here — this
    // is the check that catches it instead.
    const body = "Picking this up for decomposition... (same text both times)";
    const content = [
      toolUse("t1", "save_comment", { issueId: "PROJ-32", body: body }),
      toolResult("t1", false),
      toolUse("t2", "save_comment", { issueId: "PROJ-32", body: body }),
      toolResult("t2", false),
    ];
    const allToolUses = new Map<string, ToolUseRecord>([
      ["t1", { name: "save_comment", input: { issueId: "PROJ-32", body: body } }],
      ["t2", { name: "save_comment", input: { issueId: "PROJ-32", body: body } }],
    ]);
    const duplicates = findDuplicateWrites(content as never, allToolUses);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.name).toBe("save_comment");
  });

  it("does not flag a failed write's near-miss retry as a duplicate", () => {
    // The corrupted-then-corrected save_comment shape findMcpError already
    // tolerates — the first call errored, so it must never count as a
    // "successful duplicate" of the corrected retry.
    const content = [
      toolUse("t1", "save_comment", { issueId: "PROJ-19", body: { garbled: true } }),
      toolResult("t1", true),
      toolUse("t2", "save_comment", { issueId: "PROJ-19", body: "corrected text" }),
      toolResult("t2", false),
    ];
    const allToolUses = new Map<string, ToolUseRecord>([
      ["t1", { name: "save_comment", input: { issueId: "PROJ-19", body: { garbled: true } } }],
      ["t2", { name: "save_comment", input: { issueId: "PROJ-19", body: "corrected text" } }],
    ]);
    expect(findDuplicateWrites(content as never, allToolUses)).toEqual([]);
  });

  it("does not flag two different writes to different entities sharing a tool name", () => {
    const content = [
      toolUse("t1", "save_issue", { issueId: "PROJ-30", title: "Story A" }),
      toolResult("t1", false),
      toolUse("t2", "save_issue", { issueId: "PROJ-31", title: "Story B" }),
      toolResult("t2", false),
    ];
    const allToolUses = new Map<string, ToolUseRecord>([
      ["t1", { name: "save_issue", input: { issueId: "PROJ-30", title: "Story A" } }],
      ["t2", { name: "save_issue", input: { issueId: "PROJ-31", title: "Story B" } }],
    ]);
    expect(findDuplicateWrites(content as never, allToolUses)).toEqual([]);
  });
});
