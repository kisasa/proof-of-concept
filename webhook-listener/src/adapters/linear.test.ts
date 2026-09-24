import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createLinearAdapter } from "./linear.js";

const SECRET = "test-secret";
const API_KEY = "test-api-key";
const BODY = '{"type":"Issue","action":"create","data":{"id":"issue-1"}}';

describe("verifySignature", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  it("accepts a valid HMAC-SHA256 signature", () => {
    const sig = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(adapter.verifySignature(BODY, new Headers({ "Linear-Signature": sig }))).toBe(true);
  });

  it("rejects a tampered signature", () => {
    expect(adapter.verifySignature(BODY, new Headers({ "Linear-Signature": "deadbeef" }))).toBe(false);
  });

  it("rejects when the signature header is absent", () => {
    expect(adapter.verifySignature(BODY, new Headers())).toBe(false);
  });
});

describe("dedupeKey", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  it("builds a stable key from type, action, id, and timestamp", () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "abc-123" },
      webhookTimestamp: 1000,
    });
    expect(adapter.dedupeKey(payload)).toBe("Issue:update:abc-123:1000");
  });

  it("omits the timestamp segment when webhookTimestamp is absent", () => {
    const payload = JSON.stringify({ type: "Issue", action: "create", data: { id: "def-456" } });
    expect(adapter.dedupeKey(payload)).toBe("Issue:create:def-456:");
  });
});

// Issue/Project webhooks carry label ids only (data.labelIds,
// updatedFrom.labelIds) — confirmed against a live payload. Every test that
// touches a non-empty labelIds set needs the id→name lookup stubbed.
function stubLabelLookup(rootField: "issueLabels" | "projectLabels", labels: { id: string; name: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { [rootField]: { nodes: labels } } }),
    }),
  );
}

describe("parseEvent — Issue create", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns label_added when created with labels already applied", async () => {
    stubLabelLookup("issueLabels", [{ id: "l1", name: "spec:resolved" }]);
    const payload = JSON.stringify({
      type: "Issue",
      action: "create",
      data: { id: "issue-1", state: { name: "Evaluation" }, labelIds: ["l1"] },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "label_added",
      entityType: "issue",
      entityId: "issue-1",
      status: "Evaluation",
      labels: ["spec:resolved"],
      addedLabels: ["spec:resolved"],
    });
  });

  it("returns status_changed when created with no labels", async () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "create",
      data: { id: "issue-2", state: { name: "Backlog" }, labelIds: [] },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "status_changed",
      status: "Backlog",
    });
  });
});

describe("parseEvent — Issue update", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns status_changed when stateId changed", async () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "issue-3", state: { name: "Evaluation" }, labelIds: [] },
      updatedFrom: { stateId: "old-state-id" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "status_changed",
      status: "Evaluation",
    });
  });

  it("carries the webhook's actor through on status_changed — reviewer-of-record's source", async () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      actor: { id: "user-1", name: "Example User", email: "user@example.com", type: "user" },
      data: { id: "issue-3", state: { name: "In-Process" }, labelIds: [] },
      updatedFrom: { stateId: "old-state-id" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "status_changed",
      actor: { id: "user-1", name: "Example User", email: "user@example.com" },
    });
  });

  it("reports a null actor when the webhook's actor has no email", async () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      actor: { id: "bot-1", name: "Some Bot", type: "user" },
      data: { id: "issue-3b", state: { name: "In-Process" }, labelIds: [] },
      updatedFrom: { stateId: "old-state-id" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({ actor: null });
  });

  it("returns label_added with only the newly applied label's name", async () => {
    stubLabelLookup("issueLabels", [
      { id: "l1", name: "bug" },
      { id: "l2", name: "spec:resolved" },
    ]);
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "issue-4", state: { name: "Evaluation" }, labelIds: ["l1", "l2"] },
      updatedFrom: { labelIds: ["l1"] },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "label_added",
      addedLabels: ["spec:resolved"],
      labels: ["bug", "spec:resolved"],
    });
  });

  it("returns null when a label was removed but none added", async () => {
    stubLabelLookup("issueLabels", [{ id: "l1", name: "bug" }]);
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "issue-5", state: { name: "Evaluation" }, labelIds: ["l1"] },
      updatedFrom: { labelIds: ["l1", "l2"] },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });

  it("returns null when neither status nor labels changed", async () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "issue-6", state: { name: "Evaluation" }, labelIds: [] },
      updatedFrom: { title: "old title" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });

  it("returns null for remove events", async () => {
    const payload = JSON.stringify({ type: "Issue", action: "remove", data: { id: "issue-7" } });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });

  it("returns null when an added label id can't be resolved to a name (e.g. no API key configured)", async () => {
    const adapterWithoutKey = createLinearAdapter(SECRET, "");
    const payload = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "issue-8", state: { name: "Evaluation" }, labelIds: ["l1"] },
      updatedFrom: { labelIds: [] },
    });
    expect(await adapterWithoutKey.parseEvent(payload, "test-trace")).toBeNull();
  });
});

describe("parseEvent — Project", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns label_added when ready for intake is applied to a Backlog project", async () => {
    stubLabelLookup("projectLabels", [{ id: "l1", name: "ready for intake" }]);
    const payload = JSON.stringify({
      type: "Project",
      action: "update",
      data: { id: "project-1", name: "Merchant Onboarding", status: { name: "Backlog" }, labelIds: ["l1"] },
      updatedFrom: { labelIds: [] },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "label_added",
      entityType: "project",
      entityId: "project-1",
      entityTitle: "Merchant Onboarding",
      status: "Backlog",
      addedLabels: ["ready for intake"],
    });
  });

  it("does not fire for a webhook scoped to a different team's ProjectLabel event", async () => {
    // The label-touch event carries no project id at all — it describes the
    // shared label object, not an application of it. Confirmed against a
    // live payload: this must fall through to the generic discard, not be
    // mistaken for a Project update.
    const payload = JSON.stringify({
      type: "ProjectLabel",
      action: "update",
      data: { id: "label-1", name: "ready for intake", lastAppliedAt: "2026-07-15T19:09:24.269Z" },
      updatedFrom: { lastAppliedAt: "2026-07-15T19:05:00.757Z" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });
});

describe("parseEvent — ProjectUpdate", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns comment_added when a status update is posted (Linear has no webhook for Project comments)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { project: { name: "Merchant Onboarding", status: { name: "Backlog" }, labels: { nodes: [{ name: "ready for intake" }] } } },
        }),
      }),
    );
    const payload = JSON.stringify({
      type: "ProjectUpdate",
      action: "create",
      data: { id: "update-1", projectId: "project-7", userId: "user-abc", body: "Approve slice map" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "comment_added",
      entityType: "project",
      entityId: "project-7",
      entityTitle: "Merchant Onboarding",
      status: "Backlog",
      authorId: "user-abc",
      labels: ["ready for intake"],
    });
  });

  it("returns null when the projectId is missing", async () => {
    const payload = JSON.stringify({
      type: "ProjectUpdate",
      action: "create",
      data: { id: "update-2", userId: "user-abc" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });

  it("returns null for a ProjectUpdate edit (action !== create)", async () => {
    const payload = JSON.stringify({
      type: "ProjectUpdate",
      action: "update",
      data: { id: "update-3", projectId: "project-7", userId: "user-abc" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });
});

describe("parseEvent — Comment", () => {
  const adapter = createLinearAdapter(SECRET, API_KEY);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns comment_added on an issue with context fetched from the entity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { issue: { title: "Payment visibility", state: { name: "Evaluation" }, labels: { nodes: [{ name: "eval:awaiting-answers" }] } } },
        }),
      }),
    );
    const payload = JSON.stringify({
      type: "Comment",
      action: "create",
      data: { id: "comment-1", issueId: "issue-5", userId: "user-abc" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "comment_added",
      entityType: "issue",
      entityId: "issue-5",
      entityTitle: "Payment visibility",
      status: "Evaluation",
      authorId: "user-abc",
      labels: ["eval:awaiting-answers"],
    });
  });

  it("returns comment_added on a project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { project: { name: "Merchant Onboarding", status: { name: "Backlog" }, labels: { nodes: [{ name: "ready for intake" }] } } },
        }),
      }),
    );
    const payload = JSON.stringify({
      type: "Comment",
      action: "create",
      data: { id: "comment-2", projectId: "project-7", userId: "user-abc" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toMatchObject({
      kind: "comment_added",
      entityType: "project",
      entityId: "project-7",
    });
  });

  it("returns null when the entity context fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const payload = JSON.stringify({
      type: "Comment",
      action: "create",
      data: { id: "comment-3", issueId: "issue-6" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });

  it("returns null when neither issueId nor projectId is present", async () => {
    const payload = JSON.stringify({
      type: "Comment",
      action: "create",
      data: { id: "comment-4" },
    });
    expect(await adapter.parseEvent(payload, "test-trace")).toBeNull();
  });
});
