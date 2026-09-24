# CLAUDE.md

This repo is a delivery pipeline for proofs of concept, derived from Intent to
Production (ItP). Start with `README.md` for the shape of it.

## Before planning anything, read `docs/design-ledger.md`

The ledger records every decision this repo has made and why, and whether
each is **settled** or a **proposal**.

- Do not re-decide a settled entry without saying so and recording it.
- Do not build on a proposal as if it were settled.
- Record every new decision as a new dated entry, appended to the end.
  Never edit an old entry. A superseded entry keeps its text and gains one
  line pointing forward.

## The dependency rule

**This repo may know about ItP. ItP must never know this repo exists.**

- Never write to ItP. That covers its repository, a local checkout of it, its
  branches, ledger, tracker team, infrastructure, and container registries.
  Treat any ItP checkout as read-only: read-only git commands only, and no
  builds or test runs inside it.
- Never make this repo's code, config, or CI name an ItP resource.
  `node scripts/check-no-private-references.mjs` fails on ItP identities
  outside markdown, and CI runs it.
- Porting a fix from ItP is a deliberate, manual act. Record it in the ledger
  with the ItP commit it came from.
- Do not bring ItP's reasoning in as precedent. PoC standards are
  deliberately lower, and that must never flow the other way.

## Working here

- **Gate logic stays as copied** until the trial evidence (ledger, Open items)
  is written down. That covers routing labels, dependency gating, surface
  resolution, and the same-repo check. Change it only against a ledger entry
  that decides it.
- **Definitions in `agents/` and `skills/` are drafts.** Each is marked
  `DRAFT — unvalidated`. Improve them against real PoC runs. Their content
  comes from this repo's design, never from adapting ItP's definitions.
- **The surface registry format is shared with ItP** at graduation. Keep it
  identical, along with the `surface:` label.
- **Run the package's tests and the private-reference check before
  committing.** Each package is its own npm project; see `README.md`.
- **No private references.** Use placeholders in committed files (`PROJ-<n>`
  for issue keys, `example-org` for repo owners, `example.com`). Real
  deployment config lives only in untracked `infrastructure/cdktf.<name>.json`
  files. Terraform state and `*.out/` directories are never committed.
