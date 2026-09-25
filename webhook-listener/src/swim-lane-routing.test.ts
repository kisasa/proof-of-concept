import { describe, it, expect, vi, beforeAll } from "vitest";
import { route } from "./swim-lane-routing.js";
import type { TrackerEvent } from "./tracker-event.js";
import type { LaneConfig, SwimLaneRoutingConfig } from "./swim-lane-routing.js";

const AGENT_USER_ID = "agent-123";

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

/**
 * Routing against the real lane table in swim-lanes.ts, not a copy of it. A
 * hand-copied table drifts: the one these tests used to carry still had a
 * Decompose lane and an "In-Process" dispatch status after the real table
 * had neither, and every test kept passing.
 */
describe("the real lane table", () => {
  let cfg: SwimLaneRoutingConfig;
  let laneNamed: (name: string) => LaneConfig;

  beforeAll(async () => {
    // Lane modules read their model at import (env.ts's requireEnv); the
    // values are irrelevant here, only that the modules load.
    vi.stubEnv("CLAUDE_MODEL_INTAKE", "test-model");
    vi.stubEnv("CLAUDE_MODEL_SPECIFICATION", "test-model");
    const { lanes } = await import("./swim-lanes.js");
    cfg = { agentUserId: AGENT_USER_ID, lanes: lanes };
    laneNamed = (name) => {
      const lane = lanes.find((l) => l.name === name);
      if (!lane) throw new Error(`no lane named ${name}`);
      return lane;
    };
  });

  it("has exactly the Intake, Specification, and specialist-dispatch lanes", () => {
    expect(cfg.lanes.map((lane) => lane.name)).toEqual(["intake", "specification", "specialist-dispatch"]);
  });

  describe("Intake (label_added on a project, presence-gated)", () => {
    it("fires first pass when ready for intake is applied to a Backlog project", () => {
      const decision = route(
        event({ kind: "label_added", entityType: "project", status: "Backlog", addedLabels: ["ready for intake"], labels: ["ready for intake"] }),
        cfg,
      );
      expect(decision).toMatchObject({ fire: true, pass: "first", lane: "intake", agent: laneNamed("intake").agent });
    });

    it("does not fire when a different label is applied", () => {
      const decision = route(event({ kind: "label_added", entityType: "project", status: "Backlog", addedLabels: ["some-other-label"] }), cfg);
      expect(decision.fire).toBe(false);
    });

    it("does not fire when the project is not in Backlog", () => {
      const decision = route(event({ kind: "label_added", entityType: "project", status: "Started", addedLabels: ["ready for intake"] }), cfg);
      expect(decision.fire).toBe(false);
    });

    it("fires follow-up on a human reply while ready for intake is present", () => {
      const decision = route(
        event({ kind: "comment_added", entityType: "project", status: "Backlog", labels: ["ready for intake"], authorId: "human-456" }),
        cfg,
      );
      expect(decision).toMatchObject({ fire: true, pass: "follow-up", lane: "intake" });
    });

    it("does not fire on the agent's own comment (self-comment guard)", () => {
      const decision = route(
        event({ kind: "comment_added", entityType: "project", status: "Backlog", labels: ["ready for intake"], authorId: AGENT_USER_ID }),
        cfg,
      );
      expect(decision.fire).toBe(false);
    });

    it("stops following up once ready for intake is swapped for brief:confirmed", () => {
      const decision = route(
        event({ kind: "comment_added", entityType: "project", status: "Backlog", labels: ["brief:confirmed"], authorId: "human-456" }),
        cfg,
      );
      expect(decision.fire).toBe(false);
    });
  });

  describe("Specification (status_entered on an issue, absence-gated)", () => {
    it("fires first pass when an epic enters Evaluation with no spec:* label yet", () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "Evaluation", labels: [] }), cfg);
      expect(decision).toMatchObject({ fire: true, pass: "first", lane: "specification", agent: laneNamed("specification").agent });
    });

    it("does not fire when a spec:* label is already present — the absence gate", () => {
      const decision = route(
        event({ kind: "status_changed", entityType: "issue", status: "Evaluation", labels: ["spec:awaiting-architect"] }),
        cfg,
      );
      expect(decision.fire).toBe(false);
    });

    it("does not fire again for an epic moved back into Evaluation after spec:resolved", () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "Evaluation", labels: ["spec:resolved"] }), cfg);
      expect(decision.fire).toBe(false);
    });

    it("does not fire when entering a different status", () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "Todo", labels: [] }), cfg);
      expect(decision.fire).toBe(false);
    });

    for (const label of ["spec:awaiting-answers", "spec:awaiting-architect", "spec:awaiting-designer"]) {
      it(`fires follow-up on a reply while ${label} is present`, () => {
        const decision = route(
          event({ kind: "comment_added", entityType: "issue", status: "Evaluation", labels: [label], authorId: "architect-1" }),
          cfg,
        );
        expect(decision).toMatchObject({ fire: true, pass: "follow-up", lane: "specification" });
      });
    }

    it("wakes nothing when spec:resolved is applied — it is terminal", () => {
      const decision = route(
        event({ kind: "label_added", entityType: "issue", status: "Evaluation", addedLabels: ["spec:resolved"], labels: ["spec:resolved"] }),
        cfg,
      );
      expect(decision.fire).toBe(false);
    });

    it("does not follow up on a resolved epic's thread", () => {
      const decision = route(
        event({ kind: "comment_added", entityType: "issue", status: "Evaluation", labels: ["spec:resolved"], authorId: "architect-1" }),
        cfg,
      );
      expect(decision.fire).toBe(false);
    });
  });

  describe("specialist-dispatch (status_entered on a story, presence-gated)", () => {
    it("fires first pass when a story carrying a surface:* label enters In Progress", () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "In Progress", labels: ["surface:backend"] }), cfg);
      expect(decision).toMatchObject({ fire: true, pass: "first", lane: "specialist-dispatch", agent: laneNamed("specialist-dispatch").agent });
    });

    it("carries the event's actor through as entityActor — reviewer-of-record's source", () => {
      const mover = { id: "user-1", name: "Example User", email: "user@example.com" };
      const decision = route(
        event({ kind: "status_changed", entityType: "issue", status: "In Progress", labels: ["surface:backend"], actor: mover }),
        cfg,
      );
      expect(decision).toMatchObject({ fire: true, entityActor: mover });
    });

    it("does not fire for an epic entering In Progress with no surface:* label — the presence gate", () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "In Progress", labels: ["size:medium"] }), cfg);
      expect(decision.fire).toBe(false);
    });

    it('does not fire on the design vocabulary\'s "In-Process" — the tracker\'s real status name is In Progress', () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "In-Process", labels: ["surface:backend"] }), cfg);
      expect(decision.fire).toBe(false);
    });

    it("does not fire when entering a different status", () => {
      const decision = route(event({ kind: "status_changed", entityType: "issue", status: "Todo", labels: ["surface:frontend"] }), cfg);
      expect(decision.fire).toBe(false);
    });
  });

  describe("no matching lane", () => {
    it("does not fire when no lane is awaiting a reply on the entity", () => {
      const decision = route(event({ kind: "comment_added", entityType: "issue", status: "Todo", labels: [], authorId: "human-1" }), cfg);
      expect(decision.fire).toBe(false);
    });

    it("does not fire on a project status change", () => {
      const decision = route(event({ kind: "status_changed", entityType: "project", status: "Started", labels: [] }), cfg);
      expect(decision.fire).toBe(false);
    });
  });
});

/**
 * Routing mechanics the real table no longer exercises. It has no label
 * trigger on an issue, and no two lanes share a status. route() supports
 * both, so they are pinned against neutral fixture lanes that make no claim
 * about the real table.
 */
describe("route mechanics (fixture lanes)", () => {
  const firstAgent = vi.fn();
  const secondAgent = vi.fn();
  const fixture: SwimLaneRoutingConfig = {
    agentUserId: AGENT_USER_ID,
    lanes: [
      {
        name: "first",
        entityType: "issue",
        agent: firstAgent,
        firstPass: { on: "label_added", label: "fixture:start", statusRequired: "Review" },
        awaitingLabels: ["fixture:first-awaiting"],
        statusRequiredForFollowUp: "Review",
      },
      {
        name: "second",
        entityType: "issue",
        agent: secondAgent,
        firstPass: { on: "label_added", label: "fixture:next", statusRequired: "Review" },
        awaitingLabels: ["fixture:second-awaiting"],
        statusRequiredForFollowUp: "Review",
      },
    ],
  };

  it("fires a label trigger on an issue in the required status", () => {
    const decision = route(event({ kind: "label_added", entityType: "issue", status: "Review", addedLabels: ["fixture:start"] }), fixture);
    expect(decision).toMatchObject({ fire: true, pass: "first", lane: "first", agent: firstAgent });
  });

  it("does not fire a label trigger on an issue in another status", () => {
    const decision = route(event({ kind: "label_added", entityType: "issue", status: "Backlog", addedLabels: ["fixture:start"] }), fixture);
    expect(decision.fire).toBe(false);
  });

  it("routes each follow-up by its own awaiting label when two lanes share a status", () => {
    const toFirst = route(
      event({ kind: "comment_added", entityType: "issue", status: "Review", labels: ["fixture:first-awaiting"], authorId: "human-1" }),
      fixture,
    );
    const toSecond = route(
      event({ kind: "comment_added", entityType: "issue", status: "Review", labels: ["fixture:second-awaiting"], authorId: "human-1" }),
      fixture,
    );
    expect(toFirst).toMatchObject({ fire: true, lane: "first" });
    expect(toSecond).toMatchObject({ fire: true, lane: "second" });
  });

  it("does not follow up on an awaiting label when the entity is in another status", () => {
    const decision = route(
      event({ kind: "comment_added", entityType: "issue", status: "Backlog", labels: ["fixture:first-awaiting"], authorId: "human-1" }),
      fixture,
    );
    expect(decision.fire).toBe(false);
  });
});
