---
name: shortcut-marking
description: Mandatory skill for every PoC specialist run. Prefer stubs over real integrations, mark every shortcut in code, record it in the shortcut ledger, and report new shortcut ids in the hand-back.
---

# Shortcut marking

DRAFT — unvalidated; prompt engineering happens against real PoC runs

This run is part of a proof of concept. The goal is software that functions
end to end along the demo path, fast, without production hardening. The
shortcut ledger stands in for a test suite: it is what makes the verdict
honest, and it is the hardening backlog if the PoC graduates.

## Prefer stubs

- Where the hypothesis brief's **faked by design** list names something,
  stub it. Do not integrate it.
- Where the demo path does not need something to be real, prefer a stub, a
  hardcoded value, or a skipped branch over a real implementation.
- Do not fake anything the demo path's claim depends on being real. If the
  demo path needs it, build it.

## Mark every shortcut in code

Every shortcut gets a greppable comment at the place the shortcut lives:

    // POC-SHORTCUT: SC-###

Use the comment syntax of the file's language. Place it on or directly above
the faked symbol, not at the top of the file.

## Add a ledger row

The shortcut ledger is a document attached to the tracker project,
regenerated in place. Each shortcut is one row:

| Column | Content |
|---|---|
| `id` | `SC-###`, the next free number in the ledger |
| `location` | File and symbol. **Never a line number**, which goes stale on the next edit. |
| `what is faked` | What the code does instead of the real thing |
| `what production would need` | What replacing it would take |
| `weight` | `cosmetic`, `structural`, or `load-bearing` |

Weights:

- `cosmetic`: replacing it touches nothing else.
- `structural`: replacing it reshapes the code around it.
- `load-bearing`: the demo path's claim holds only because of it.

## Keep code and ledger in agreement

A marker with no row, or a row with no marker, is a defect. When you remove a
shortcut, remove both. When you move one, update the row's `location`.

## Hand-back

List every shortcut id you added, changed, or removed in the completion report
on the story, with its weight.

## Open

- The ledger is one document that concurrent specialist runs can all edit. How
  id allocation avoids collisions is not decided.
