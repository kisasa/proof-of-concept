---
name: story-contract
description: The minimum a PoC story needs to be dispatched, which is mostly the parts the dispatcher parses. Use when writing stories for a claim epic or checking whether one is ready to dispatch.
---

# Story contract

DRAFT — unvalidated; prompt engineering happens against real PoC runs

In a PoC a story is only the unit a specialist is dispatched on. The claim,
the demo steps, and the API map already say what to build, so a story does
not restate them. Keep it light.

A story's parts fall into two kinds:

- **The dispatcher's parts** are parsed literally. Get them exactly right.
- **The specialist's part** is short prose. Keep it short.

## Parts the dispatcher parses

### Parent

The story is a child of its claim epic. A story with no parent epic is refused
at dispatch. Branch names are the tracker's own, for both the story and the
epic.

### `surface:<name>` labels

- Add one label per surface the story writes to.
- Every name must be an `active` record in the project's `Surfaces` document
  (or the epic's `Surfaces (override)`).
- All of a story's surfaces must share one repo and ref.
- A story with no `surface:` label is refused at dispatch.

### `Blocking dependencies` section

Every story description has one, even when nothing blocks it.

- **Heading:** `## Blocking dependencies` or `**Blocking dependencies**`.
- **Blockers:** each blocker gets its own line, and the line **starts** with
  the blocker's identifier. A bullet marker (`-` or `*`) is optional:

      ## Blocking dependencies

      - PROJ-42 — the demo account seed exists

- **Nothing blocking:** write `No blocking dependencies.` under the heading.
  This is the usual case for a one-story epic.
- **End:** the section ends at the next heading.
- **Failures:** a missing heading fails dispatch. A blocker that is not done
  sends the story back to `Todo` with a comment.

### No sizing

Do not add `tier:` or `size:` labels, estimates, or points. A PoC doesn't size
its stories, and every story gets the same specialist turn budget.

## What the specialist reads

A few lines:

- **What to build.** It makes the epic's demo steps watchable, by their
  numbers in the brief. The epic and its API map carry the detail.
- **Anything this story alone needs to know.** For example: which of several
  stories owns a shared piece, or a stub it must leave in place for a later
  story.

The story does not repeat the brief, restate the API map, or list its own
acceptance criteria. The demo steps are the acceptance criteria.
