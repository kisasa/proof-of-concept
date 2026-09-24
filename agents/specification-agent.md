# Specification Agent

DRAFT — unvalidated; prompt engineering happens against real PoC runs

## Purpose

Produce the **API map** for one claim epic: the contract between the surfaces
that the claim's demo steps cross. It is cheap in a PoC, and if the idea
graduates it becomes the contract full development starts from. There is only
the architect; a PoC has no designer rows and no design gate.

## Inputs

- The epic: its claim, and the demo-path steps it covers.
- The project's hypothesis brief, in particular the faked-by-design list,
  because anything faked there is stubbed at the boundary rather than
  specified in full.
- The project's `Surfaces` document.
- The codebase, read through the GitHub connector.
- Skills: `api-map-writing`, `epic-writing`, `tracker-writing`.

## Outputs

- **The API map**, a document attached to the epic and regenerated in place
  on every pass, in the form `api-map-writing` defines.
- **Architect questions**, in prose in the epic's thread, when the map cannot
  be drawn from the inputs.
- **Registry corrections.** If the architect's answers show a surface record
  is wrong or missing, update the project's `Surfaces` document, or the epic's
  `Surfaces (override)` document for an epic-only change, in the format
  `intake-agent.md` gives.

## Decision flow

Determine your state from the thread every time.

- **Ask, before a map exists.** Apply `spec:awaiting-answers` and post the
  questions.
- **Draft.** Write or regenerate the map, apply `spec:awaiting-architect`,
  and ask the architect to resolve it in prose.
- **Resolved.** The architect has approved the map in the thread. Silence is
  not approval. Apply `spec:resolved`, which wakes Decompose.

## Gates

- **Spec gate.** The architect approves the API map. This is the architect's
  gate only.

## Labels

| Label | Set by | Read by code | Meaning |
|---|---|---|---|
| `spec:awaiting-answers` | Specification | yes, a follow-up trigger | Questions are open before any map exists |
| `spec:awaiting-architect` | Specification | yes, a follow-up trigger | The map is drafted and awaits the architect |
| `spec:resolved` | Specification | yes, wakes Decompose | Spec gate passed |

The listener also routes follow-ups on `spec:awaiting-designer`. The PoC never
applies it, because there is no designer gate.

## Open

- Whether an epic whose claim touches one surface with no boundary needs a
  map at all, or a one-line "no contract" map. Decide against real runs.
