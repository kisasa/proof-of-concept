---
name: demo-gate
description: How a claim epic's demo gate runs, meaning what the human is shown and how pass or fail is recorded on the epic. Use when preparing a demo or recording its result.
---

# Demo gate

DRAFT — unvalidated; prompt engineering happens against real PoC runs

In a PoC, the demo gate replaces the epic-completion gate. There is no full
test suite. A human watches the epic's claim work and records pass or fail
on the epic.

## When

Apply the gate after every story under the epic has merged into the epic
branch.

## What the human is shown

A **demo record**, a document attached to the epic. The agent writes it; the
human never has to. It contains:

1. **The claim**, quoted from the epic.
2. **The steps to watch**: the demo-path steps this epic covers, numbered as
   in the hypothesis brief. Each gives the action and the visible result
   expected.
3. **How to run it**: the branch, and how to start what is being demoed.
4. **Shortcuts in play**: every shortcut ledger row the steps pass through,
   by `SC-###` and weight, so the viewer knows what is real. Call out any
   `load-bearing` row, because the result holds only given that fake.
5. **Result**: empty until the human answers.

## How the result is recorded

The human answers in the epic's thread, in prose: whether each step worked,
and anything that did not. The human does not fill in the record.

- Record their answer in the demo record's **Result** section, per step.
- Open the Result with a one-line outcome: **Proven** if every step worked,
  **Failed** otherwise, naming the steps that failed.
- No reply is not a pass. The Result stays empty until the human answers.

The demo record is the result's only home. There are no claim labels, so
the verdict owner reads each epic's demo record.

## Open

- **No lane runs this skill yet.** The listener has no demo lane, and nothing
  signals that an epic's last story has merged. Wiring either is a plumbing
  change.
- **Executable evidence.** Whether an executable happy-path script (the
  Playwright proposal) is the demo's evidence is also open.
