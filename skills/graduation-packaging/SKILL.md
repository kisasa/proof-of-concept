---
name: graduation-packaging
description: Produces the graduation package for a proven PoC, which hands the idea to full development as ordinary inputs. Use when the verdict is proven and the idea is going on to full development.
---

# Graduation packaging

DRAFT — unvalidated; prompt engineering happens against real PoC runs

## When

Run this only when the verdict owner has recorded `verdict:proven` or
`verdict:proven-with-caveats` on the project, and the idea is going on to full
development.

## The receiving pipeline learns nothing about this one

The package is made of ordinary inputs that full development's normal intake
already accepts: a requirements seed, conventions files, and a repository.
Nothing in it names this pipeline, and nothing in it needs the receiving side
to change.

## The package

1. **A BRD seed**, in the receiving pipeline's business-requirements format,
   built from three sources:
   - the hypothesis brief;
   - the demo findings, from each epic's demo record;
   - the verdict, with its caveats stated as requirements, not as history.
2. **The API map** of each epic, as-is.
3. **The surface registry entry**, as-is, with `shortcut-marking` removed from
   every record's `skills`. The specialist definition does not change; only
   the mandatory skill goes.
4. **The shortcut ledger**, as the hardening backlog, with every row.
5. **A rewritten `CONVENTIONS.md` per surface**. It keeps the structure rules
   and adds the rule that code marked `POC-SHORTCUT` is known debt, not
   precedent: retire it rather than extend it.
6. **A per-area recommendation, harden or rewrite**, for the architect to
   decide. Group the ledger rows by area. The `load-bearing` and `structural`
   counts are the main input to each recommendation.

## Verdict labels

| Label | On | Set by |
|---|---|---|
| `verdict:proven` | project | The verdict owner |
| `verdict:disproven` | project | The verdict owner |
| `verdict:proven-with-caveats` | project | The verdict owner |

These are proposals and unsettled. The verdict owner records the verdict;
no agent infers one.

## Open

- **No lane runs this skill yet.**
- **Format dependency.** Producing the BRD seed needs the receiving
  pipeline's business-requirements format. This repo may read it but must not
  depend on it at runtime; how the format is kept current is undecided.
