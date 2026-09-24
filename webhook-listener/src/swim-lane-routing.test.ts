import { describe, it, expect, vi } from "vitest";
import { route } from "./swim-lane-routing.js";
import type { TrackerEvent } from "./tracker-event.js";
import type { LaneConfig, SwimLaneRoutingConfig } from "./swim-lane-routing.js";

const AGENT_USER_ID = "agent-123";
const intakeAgent = vi.fn();
const specificationAgent = vi.fn();
const decomposeAgent = vi.fn();
const specialistDispatchAgent = vi.fn();

const lanes: LaneConfig[] = [
  {
    name: "intake",
    entityType: "project",
    agent: intakeAgent,
    firstPass: { on: "label_added", label: "ready for intake", statusRequired: "Backlog" },
    awaitingLabels: ["ready for intake"],
    statusRequiredForFollowUp: "Backlog",
  },
  {
    name: "specification",
    entityType: "issue",
    agent: specificationAgent,
    firstPass: { on: "status_entered", status: "Evaluation", requireLabelsAbsentPrefix: "spec:" },
    awaitingLabels: ["spec:awaiting-architect", "spec:awaiting-designer"],
    statusRequiredForFollowUp: "Evaluation",
  },
  {
    name: "decompose",
    entityType: "issue",
    agent: decomposeAgent,
    firstPass: { on: "label_added", label: "spec:resolved", statusRequired: "Evaluation" },
    awaitingLabels: ["eval:awaiting-answers", "eval:awaiting-approval"],
    statusRequiredForFollowUp: "Evaluation",
  },
  {
    name: "specialist-dispatch",
    entityType: "issue",
    agent: specialistDispatchAgent,
    firstPass: { on: "status_entered", status: "In-Process", requireLabelsPresentPrefix: "surface:" },
    awaitingLabels: [],
  },
];

const cfg: SwimLaneRoutingConfig = { agentUserId: AGENT_USER_ID, lanes: lanes };

function event(overrides: Partial<TrackerEvent>): TrackerEvent {
  return {
    kind: "label_added",
    entityType: "issue",
    entityId: "entity-1",
    entityTitle: "Some Entity",
    status: "Backlog",
    labels: [],
    authorId: null,
    addedLabels: [],
    actor: null,
    ...overrides,
  };
}

describe("route — Intake (label_added, project, presence-gated)", () => {
  it("fires first pass when ready for intake is applied to a Backlog project", () => {
    const decision = route(
      event({ kind: "label_added", entityType: "project", status: "Backlog", addedLabels: ["ready for intake"], labels: ["ready for intake"] }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, pass: "first", lane: "intake", agent: intakeAgent });
  });

  it("does not fire when a different label is applied", () => {
    const decision = route(
      event({ kind: "label_added", entityType: "project", status: "Backlog", addedLabels: ["some-other-label"] }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });

  it("does not fire when the status doesn't match (Backlog required)", () => {
    const decision = route(
      event({ kind: "label_added", entityType: "project", status: "Started", addedLabels: ["ready for intake"] }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });
});

describe("route — Intake follow-up (comment while label present)", () => {
  it("fires follow-up on a human reply while ready for intake is present", () => {
    const decision = route(
      event({
        kind: "comment_added",
        entityType: "project",
        status: "Backlog",
        labels: ["ready for intake"],
        authorId: "human-456",
      }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, pass: "follow-up", lane: "intake" });
  });

  it("does not fire on the agent's own comment (self-comment guard)", () => {
    const decision = route(
      event({
        kind: "comment_added",
        entityType: "project",
        status: "Backlog",
        labels: ["ready for intake"],
        authorId: AGENT_USER_ID,
      }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });

  it("does not fire once ready for intake has been swapped for ready for eval", () => {
    const decision = route(
      event({
        kind: "comment_added",
        entityType: "project",
        status: "Backlog",
        labels: ["ready for eval"],
        authorId: "human-456",
      }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });
});

describe("route — Specification (status_entered, absence-gated)", () => {
  it("fires first pass when an issue enters Evaluation with no spec:* label yet", () => {
    const decision = route(event({ kind: "status_changed", entityType: "issue", status: "Evaluation", labels: [] }), cfg);
    expect(decision).toMatchObject({ fire: true, pass: "first", lane: "specification" });
  });

  it("does not fire when a spec:* label is already present — the absence gate", () => {
    const decision = route(
      event({ kind: "status_changed", entityType: "issue", status: "Evaluation", labels: ["spec:awaiting-architect"] }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });

  it("does not fire when entering a different status", () => {
    const decision = route(event({ kind: "status_changed", entityType: "issue", status: "To-Do", labels: [] }), cfg);
    expect(decision.fire).toBe(false);
  });

  it("fires follow-up on a reply while spec:awaiting-designer is present", () => {
    const decision = route(
      event({
        kind: "comment_added",
        entityType: "issue",
        status: "Evaluation",
        labels: ["spec:awaiting-designer"],
        authorId: "architect-1",
      }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, pass: "follow-up", lane: "specification" });
  });
});

describe("route — Decompose (label_added, presence-gated)", () => {
  it("fires first pass when spec:resolved is applied", () => {
    const decision = route(
      event({ kind: "label_added", entityType: "issue", status: "Evaluation", addedLabels: ["spec:resolved"] }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, pass: "first", lane: "decompose" });
  });

  it("does not fire on an unrelated label addition", () => {
    const decision = route(
      event({ kind: "label_added", entityType: "issue", status: "Evaluation", addedLabels: ["spec:awaiting-architect"] }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });

  it("fires follow-up on a reply while eval:awaiting-answers is present", () => {
    const decision = route(
      event({
        kind: "comment_added",
        entityType: "issue",
        status: "Evaluation",
        labels: ["eval:awaiting-answers"],
        authorId: "pm-1",
      }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, pass: "follow-up", lane: "decompose" });
  });
});

describe("route — specialist-dispatch (status_entered, presence-gated, stories not epics)", () => {
  it("fires first pass when a story (carrying a surface:* label) enters In-Process", () => {
    const decision = route(
      event({ kind: "status_changed", entityType: "issue", status: "In-Process", labels: ["surface:backend"] }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, pass: "first", lane: "specialist-dispatch" });
  });

  it("carries the event's actor through as entityActor — reviewer-of-record's source", () => {
    const mover = { id: "user-1", name: "Example User", email: "user@example.com" };
    const decision = route(
      event({ kind: "status_changed", entityType: "issue", status: "In-Process", labels: ["surface:backend"], actor: mover }),
      cfg,
    );
    expect(decision).toMatchObject({ fire: true, entityActor: mover });
  });

  it("does not fire for an epic entering In-Process with no surface:* label — the presence gate", () => {
    const decision = route(
      event({ kind: "status_changed", entityType: "issue", status: "In-Process", labels: ["size:medium"] }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });

  it("does not fire when entering a different status", () => {
    const decision = route(
      event({ kind: "status_changed", entityType: "issue", status: "To-Do", labels: ["surface:frontend"] }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });
});

describe("route — no matching lane", () => {
  it("does not fire when no lane is awaiting a reply on the entity", () => {
    const decision = route(
      event({ kind: "comment_added", entityType: "issue", status: "To-Do", labels: [], authorId: "human-1" }),
      cfg,
    );
    expect(decision.fire).toBe(false);
  });

  it("does not fire on an unrecognized event kind's absence of matches", () => {
    const decision = route(event({ kind: "status_changed", entityType: "project", status: "Started", labels: [] }), cfg);
    expect(decision.fire).toBe(false);
  });
});
