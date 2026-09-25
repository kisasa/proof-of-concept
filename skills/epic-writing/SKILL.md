---
name: epic-writing
description: What a well-formed PoC claim epic looks like. Use when creating an epic from the demo path, or when reading one to specify it, write its stories, or build it.
---

# Epic writing

DRAFT — unvalidated; prompt engineering happens against real PoC runs

An epic is **one demonstrable claim**: a step, or a small group of steps, of
the hypothesis brief's demo path, phrased as something that can be watched
working.

> A merchant can complete onboarding end to end against a stubbed payment
> provider.

An epic is not a release slice. It closes at the **demo gate**, not at a test
gate.

## Contents

1. **Claim**: one sentence that can be watched working, naming the actor, the
   outcome, and what is stubbed if a fake is load-bearing.
2. **Demo steps**: the brief's demo-path steps this epic covers, by their
   numbers in the brief, each with its visible result.
3. **Faked here**: the faked-by-design entries this claim relies on.
4. **Out of scope for this claim**: adjacent steps that belong to other
   epics.

## Quality bar

- The claim can be watched: someone could say "yes, I saw that" or "no".
- The demo steps are contiguous on the demo path.
- The epics of a project, taken in order, cover the demo path with no gaps.
- Every step belongs to exactly one epic.
