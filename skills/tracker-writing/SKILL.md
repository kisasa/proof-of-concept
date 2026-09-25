---
name: tracker-writing
description: How every agent in this pipeline writes to the issue tracker, covering documents versus comments, prose versus machine formats, and the label vocabulary. Use whenever posting, labelling, or attaching in the tracker.
---

# Tracker writing

DRAFT — unvalidated; prompt engineering happens against real PoC runs

## Principles

- **Humans gate, agents work.** A gate is passed by a human saying so, never
  by an agent inferring it.
- **Artifacts are documents; threads are for directing them.** The brief, the
  surface registry, API maps, the shortcut ledger, and demo records are
  documents attached to their project or epic, regenerated in place. Never
  paste an artifact into a comment.
- **The agent writes machine-read formats; humans answer in prose.** Never ask
  a human to fill in a table, a label, a registry record, or any other
  structured format. Ask in prose, and write the structure from their answer.
- **Never silent.** No gate is satisfied by the absence of an objection. If
  nobody has answered, the gate is still open.
- **Determine state from the thread.** Every activation reads the thread and
  decides where things stand. How you were woken is not evidence of the
  outcome.

## Comments

- Start with what you need from the reader, if anything, and from whom.
- Ask questions as a numbered list, so a reply can answer by number.
- Link documents; do not restate them.

## Label vocabulary

Labels the plumbing reads, which keep their exact names:

- `ready for intake`
- `spec:awaiting-answers`, `spec:awaiting-architect`
- `surface:<name>`

`spec:resolved` is terminal: Specification applies it when the map and
stories are approved, and nothing wakes on it. Any `spec:` label also keeps
the listener from treating the epic's next move into Evaluation as a first
look.

`surface:` is identical to the receiving pipeline's, because the registry
format is shared at graduation.

PoC-only labels, which are proposals and unsettled, and which no plumbing
reads:

- `brief:awaiting-confirmation`, `brief:confirmed` (project)
- `claim:awaiting-demo`, `claim:proven`, `claim:failed` (epic)
- `verdict:proven`, `verdict:disproven`, `verdict:proven-with-caveats`
  (project)

Each PoC-only gate has its own prefix, so no PoC label means something
different after graduation.

## Statuses

Humans move statuses; agents move labels. The plumbing reads these literal
status names: `Backlog`, `Evaluation`, `In Progress`, and `Todo`.
