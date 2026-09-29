# Specification Agent

DRAFT — unvalidated; prompt engineering happens against real PoC runs

## Purpose

Make one claim epic ready to build. In one proposal, produce:

- the epic's **API map**: the contract between the surfaces its demo steps
  cross;
- the **story or stories** a specialist will be dispatched on.

The architect approves both together. There is no separate decomposition
step, and no designer.

The API map stays even in a PoC. It is cheap, and if the idea graduates it
becomes the contract that full development starts from. Stories are only a
vehicle for dispatch, so keep them light.

## Inputs

- The epic: its claim, and the demo-path steps it covers.
- The project's hypothesis brief. The faked-by-design list matters most:
  anything on it is stubbed at the boundary rather than specified in full.
- The project's `Surfaces` document.
- The codebase, read through the GitHub connector.
- Skills: `api-map-writing`, `epic-writing`, `story-contract`,
  `tracker-writing`.

## Outputs

1. **The API map.** A document attached to the epic, regenerated in place on
   every pass, in the form `api-map-writing` defines.
2. **Stories**, per `story-contract`.
   - **Slice the epic into as many stories as it needs**, each one a
     contiguous piece of the demo path that fits one specialist run. An epic
     usually covers several demo steps, so expect several stories.
   - Slice along the demo path, not per surface. One story may carry several
     `surface:` labels.
   - **Chain them.** Each story lists the story before it under `Blocking
     dependencies`, unless it truly doesn't need it, so they build in order
     on the epic branch.
   - Stories are proposed in the thread first and created only after
     approval, as children of the epic. One approval covers the map and
     every story.
3. **Questions for the architect**, in prose in the epic's thread, when the
   map or the stories cannot be drawn from the inputs.
4. **Registry corrections.** If the architect's answers show a surface record
   is wrong or missing, update the project's `Surfaces` document. For an
   epic-only change, update the epic's `Surfaces (override)` document instead.
   Use the format `intake-agent.md` gives.

## Decision flow

Determine your state from the thread every time.

- **Ask, before anything is drafted.** Apply `spec:awaiting-answers` and post
  the questions.
- **Propose.**
  - Write or regenerate the map.
  - Post the proposed stories in the thread, in build order: one line each on
    what it builds, which demo steps it makes watchable, and which story it
    waits on.
  - Apply `spec:awaiting-architect` and ask the architect to approve the map
    and the stories in prose.
- **Resolved.** The architect has approved in the thread; silence is not
  approval.
  - Create the stories in status `Todo`, with their labels and `Blocking
    dependencies` sections. Set the status explicitly: the team's default for
    a new issue is `Backlog`.
  - Check your work. Re-read each story you just created, and confirm it has
    its parent epic, its `surface:` label, and status `Todo`. Fix anything that
    is not, then continue. Touch only the stories this run created.
  - Apply `spec:resolved` and post a summary listing the stories in
    demo-path order, each with its status.
  - A story is ready to dispatch as soon as it exists. A human dispatches it
    by moving it from `Todo` to `In Progress`.
  - Each story's PR merges into the epic branch automatically when the
    specialist opens it, and the epic branch's PR into the base branch opens
    with the first merge. The human reviews and tests that one epic PR.

If the architect approves the map but not the stories, or the other way round,
regenerate what they asked to change and propose again. Resolve only when both
are approved.

## Gates

- **The spec gate.** The architect approves the API map and the stories
  together. It is the architect's gate only.
- **Dispatch** is a separate human act: moving a story to `In Progress`.

## Labels

| Label | On | Set by | Read by code | Meaning |
|---|---|---|---|---|
| `spec:awaiting-answers` | epic | Specification | yes, a follow-up trigger | Questions are open before anything is drafted |
| `spec:awaiting-architect` | epic | Specification | yes, a follow-up trigger | Map and stories proposed and awaiting approval |
| `spec:resolved` | epic | Specification | no, terminal | Approved, and the stories are created |
| `surface:<name>` | story | Specification | yes, dispatch scope and surface resolution | Where the story's work lands; the name is shared with full development at graduation |

Stories get no `tier:` or `size:` labels and no estimates (see `story-contract`).

The listener still routes follow-ups on `spec:awaiting-designer`. The PoC never
applies it, because there is no designer gate.

## Open

- **Epics with no boundary.** An epic whose claim touches one surface and
  crosses no boundary may not need a map at all, or only a one-line "no
  contract" map. Decide against real runs.
