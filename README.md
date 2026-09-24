# proof-of-concept

A delivery pipeline for **proofs of concept**. It turns an idea into software
that functions end to end, fast and at low cost, without testing or hardening
it for production load. A run ends in a verdict on a hypothesis: proven,
disproven, or proven with caveats. A proven idea graduates to full
development with a head start: its brief, API maps, surface registry, and a
ledger of every shortcut taken.

It is derived from **Intent to Production (ItP)**, the production delivery
pipeline, and reuses ItP's runtime. It is a separate codebase, with its own
definitions, its own design ledger, and its own infrastructure.

## The dependency rule

**This repo may know about ItP. ItP must never know this repo exists.**

- Nothing is ever written to ItP's repository, branches, ledger, tracker
  team, infrastructure, or container registries.
- ItP was read once, at a pinned commit, to bootstrap this repo. Porting a
  later ItP fix here is a deliberate manual act, recorded in the design
  ledger.
- A graduated PoC reaches ItP only as ordinary inputs (a BRD seed,
  conventions files, a repository) through ItP's normal intake.

PoC standards are deliberately lower. The rule exists so PoC reasoning never
becomes precedent in production code.

## How a PoC runs

1. **Brief.** One tracker project per PoC, defined by a hypothesis brief: the
   hypothesis, a single verdict owner, the demo path, what is faked by
   design, layout screenshots, and what is out of scope. A human confirms it.
2. **Claims.** Each epic is one demonstrable claim, a step of the demo path
   that can be watched working.
3. **Spec and build.** The architect approves a light API map for each claim.
   Specialists build it, preferring stubs, and mark every shortcut in code
   (`POC-SHORTCUT: SC-###`) and in the shortcut ledger.
4. **Demo gate.** A human watches each claim work and records pass or fail.
5. **Verdict.** The verdict owner records the outcome. If it is proven, the
   pipeline produces a graduation package.

## Layout

| Path | What it is |
|---|---|
| `webhook-listener/` | Receives tracker webhooks, allowlists this pipeline's tracker team, and runs the Intake, Specification, and Decompose agents |
| `dispatch-worker/` | Temporal worker that dispatches a specialist for a story, watches its PR, and runs revision rounds |
| `specialist-runner/` | The container a specialist runs in, one story per run |
| `infrastructure/` | CDK for Terraform (`cdktn`) stacks for AWS and Temporal Cloud; see its README |
| `agents/`, `skills/` | This pipeline's own agent definitions and skills, all drafts for now |
| `scripts/` | The private-reference check, deployment setup, and local-stack bootstrap |
| `docs/design-ledger.md` | Every decision and why. Read it before changing anything. |
| `docs/bootstrap.md` | The founding design record and bootstrap plan |

## Status

Bootstrapped 2026-09-24 from ItP. The plumbing is copied and separated from
ItP's identity. The agent and skill definitions are unvalidated drafts,
awaiting real PoC runs. Open items are listed at the end of the design
ledger.

## Development

Each package is its own npm project:

```bash
cd webhook-listener && npm ci && npm run typecheck && npm run test:unit
```

The same applies to `dispatch-worker/`, `specialist-runner/`, and
`infrastructure/`. Its `temporal-namespace` test needs `cdktn get` first. The
repo-wide checks are:

```bash
node --test 'scripts/*.test.mjs'
```

```bash
node scripts/check-no-private-references.mjs
```

```bash
python scripts/new-deployment.test.py
```
