---
name: story-contract
description: The output contract for a well-formed PoC story, including the parts the dispatcher parses. Use when producing stories or checking whether one is ready to dispatch.
---

# Story contract

DRAFT — unvalidated; prompt engineering happens against real PoC runs

A story exists only when a claim epic will not fit one specialist run, or as
the single story that carries an epic that does fit (see `decompose-agent.md`).
Stories slice **along the demo path**, not per surface.

## Machine-read parts

The dispatcher reads these literally. Get them exactly right.

### Parent

The story is a child of its claim epic. A story with no parent epic is refused
at dispatch. Branch names are the tracker's own: the story's and the epic's.

### `surface:<name>` labels

Add one label per surface the story writes to. Every name must be an `active`
record in the project's `Surfaces` document (or the epic's
`Surfaces (override)`), and all of the story's surfaces must share one repo
and ref. A story with no `surface:` label is refused at dispatch.

### `tier:` and `size:` labels

- `tier:small|mid|large` is architectural weight.
- `size:small|medium|large` is volume of work.
- The two are independent, and each multiplies the specialist's turn budget.
  A missing or unrecognized value counts as the smallest.

### `Blocking dependencies` section

Every story description has one, even when nothing blocks it.

- The heading is either `## Blocking dependencies` or
  `**Blocking dependencies**`.
- Below it, each blocker is its own line, and the line **starts** with the
  blocker's identifier. A bullet marker (`-` or `*`) is optional. For example:

      ## Blocking dependencies

      - PROJ-42 — the demo account seed exists

- When nothing blocks the story, write `No blocking dependencies.` under the
  heading.
- The section ends at the next heading.
- A missing heading fails dispatch. A blocker that is not done sends the story
  back to `Todo` with a comment.

## Human-read parts

- **Claim slice**: which demo-path steps this story makes watchable.
- **Acceptance criteria**: one per watchable result. Each criterion is
  checkable by watching, and phrased so the specialist's PR can trace it.
- **Faked here**: which entries of the brief's faked-by-design list this story
  stubs, so the specialist marks them.
- **References**: the epic, its API map, and the layout references it uses.
