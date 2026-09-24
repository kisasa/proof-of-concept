# Design ledger

The record of what this pipeline decided and why. **Read this before planning
any change.**

Rules:

- Append-only, by date. Never rewrite an entry.
- A superseded entry keeps its text and gains one line at its end:
  `Superseded by <date> — <title>.`
- Each decision is marked **settled** or **proposal**. A proposal becomes
  settled only in a new, dated entry that says so.
- Detail that would bloat an entry lives in another document, and the entry
  links to it. For the bootstrap, that document is
  [`bootstrap-inventory.md`](bootstrap-inventory.md).

---

## 2026-09-24 — Plumbing copied from ItP

Plumbing copied from ItP at commit `5aed0398a013fe7cb3ccec8d6bf024e775a685a4`
on 2026-09-24.

ItP is Intent to Production, the production delivery pipeline this one is
derived from. The copy was made by `git archive` of that commit. It is
byte-identical for the 172 files copied, and its blob hashes and modes were
verified. The founding document is [`bootstrap.md`](bootstrap.md). The
entries that follow restate its Sections 1–4 as the decisions this repo
starts from.

---

## 2026-09-24 — Founding decisions (bootstrap.md Sections 1–4)

### F1. What this repo is — settled

This repo is a delivery pipeline for proofs of concept. It turns an idea into
software that functions end to end, fast and at low cost, without testing or
hardening it for production load. It reuses ItP's runtime but is a separate
codebase, with separate definitions, a separate ledger, and separate
infrastructure.

A PoC run ends in a verdict on a hypothesis: proven, disproven, or proven with
caveats. A proven PoC should leave a good starting point for full development,
meaning artifacts in ItP's input formats plus code whose shortcuts are marked
and recorded.

### F2. The dependency rule — settled (load-bearing)

**This repo may know about ItP. ItP must never know this repo exists.**

- Nothing is ever written to ItP's repository, branches, ledger, tracker team,
  infrastructure, or container registries.
- ItP is read once, at a pinned commit, during bootstrap. After that, porting
  a plumbing fix from ItP is a deliberate manual act, recorded here.
- Graduation hands ItP ordinary inputs, which ItP treats like any other
  engagement: a BRD seed, a conventions file, and a repo. ItP needs no change
  to accept a graduated PoC.

The reason: PoC standards are deliberately lower. The rule prevents PoC
reasoning from leaking into ItP as precedent and lowering production code
quality.

### F3. Principles inherited from ItP — settled

- **Humans gate, agents work.** A PoC has fewer gates, not zero.
- **Artifacts are documents; threads are for directing them.** Briefs, maps,
  and ledgers are attached documents, regenerated in place.
- **The agent writes machine-read formats; humans answer in prose.** No human
  hand-authors a structured record.
- **Reply-triggered prompts must not name the expected outcome.** The agent
  determines state from the thread.
- **Never silent.** No gate is satisfied by the absence of an objection.

### F4. Project = the hypothesis — settled

There is one tracker project per PoC, defined by a hypothesis brief that
replaces the BRD. The brief has six sections:

1. the hypothesis
2. the audience and a single verdict owner
3. the demo path, the ordered, watchable steps that prove the hypothesis
4. faked by design, known before work starts
5. layout references, as screenshots only
6. out of scope

Design is loose by intent, and there is no designer gate.

### F5. Epic = one demonstrable claim — settled

An epic is a step, or a small group of steps, of the demo path, phrased as a
claim that can be watched working. It closes at the demo gate, not at a test
gate.

### F6. Story = optional, and vertical — settled

A story exists only when an epic will not fit in one specialist run. Stories
slice along the demo path, not per surface. The monorepo default (F9) lets one
story carry several surfaces. The reason: the human reviews behavior, not
code, so ItP's reason for per-surface stories mostly disappears.

See 2026-09-24 — B9 for how "the epic dispatches directly" is expressed under
the current dispatcher.

### F7. The shortcut ledger — settled

The shortcut ledger is the PoC's substitute for a test suite and the hardening
backlog at graduation.

- It is a document attached to the project, regenerated in place.
- Each row has `SC-###`, a location (file and symbol, never a line number),
  what is faked, what production would need, and a weight (`cosmetic`,
  `structural`, or `load-bearing`).
- Every shortcut is also marked in code as `POC-SHORTCUT: SC-###`. A marker
  with no row, or a row with no marker, is a defect.
- Specialists add rows as they work and list new ids in their hand-back.

The reason: marked shortcuts become debt; unmarked ones become patterns.

### F8. Gates — settled, with one proposal

| Gate | PoC form |
|---|---|
| Intake / brief | A human confirms the brief, especially the demo path and the faked-by-design list. |
| Spec | Kept, lighter: an API map, architect only, no designer rows. |
| Decompose | Only when an epic exceeds one specialist run; otherwise the epic dispatches directly. |
| Demo gate | Replaces the epic-completion gate. A human watches the claim work and records pass or fail on the epic. |
| Verdict | Replaces the three-way BRD sign-off. The verdict owner records proven, disproven, or proven with caveats. |

- **Proposal:** the demo path also exists as an executable happy-path
  Playwright script, run in GitHub Actions rather than the specialist sandbox.
  It would serve as the demo gate's evidence and become the first production
  E2E test at graduation.
- **Settled:** no gate logic is removed from the copied plumbing until the
  trial evidence (see Open items) is written down.

### F9. Conventions — settled

Every PoC starts with a short `CONVENTIONS.md` at each surface root, written
before the first dispatch. It covers structure only: layering, boundaries,
naming, and the shortcut-marking rule.

### F10. Surfaces and repo shape — settled

- The default is a monorepo with one registry record per surface, each with a
  `path`.
- The surface registry format is **identical** to ItP's, so a graduated PoC's
  entry is usable by ItP unchanged.
- PoC-specific specialist behavior arrives through the registry's
  mandatory-skills field. At graduation the skill is removed from the record
  and the specialist definition does not change.

### F11. Graduation — settled

A proven PoC produces a graduation package:

1. a BRD seed in ItP's format
2. the API map, as-is
3. the registry entry, as-is, minus the PoC skill
4. the shortcut ledger, as the hardening backlog
5. a rewritten `CONVENTIONS.md` per surface, stating that `POC-SHORTCUT` code
   is debt, not precedent
6. a per-area recommendation, harden or rewrite, for the architect

ItP receives the package through its normal intake and learns nothing about
this pipeline.

### F12. Separation requirements — settled

Separate codebases are not enough. Each of the following must be separate
before the first PoC dispatch:

- a separate Linear team or workspace, with the listener allowlisting only the
  PoC team
- a separate Temporal namespace and task queues
- separate AWS stacks, task definitions, and names, with no shared state
- Terraform state never copied
- separate container image repositories
- a separate GitHub App or token, scoped to PoC repos only
- a separate Claude project for PoC design work

---

## 2026-09-24 — Bootstrap decisions (Phases 0–4)

Made while executing `bootstrap.md` Sections 5–6. Full detail is in
[`bootstrap-inventory.md`](bootstrap-inventory.md) §7–§11.

### B1. Bootstrap commits land on a `bootstrap` branch — settled

Phases 0–5 are one commit each, on `bootstrap`, not `main`. Nothing was pushed
during the bootstrap.

### B2. Classification corrections to bootstrap.md Section 6 — settled

- `docker-compose.yml` is copy-then-rename, not verbatim. It named ItP's
  framework repo.
- `infrastructure/.gitignore` is copied verbatim.
- `scripts/localstack-bootstrap.sh` is copied then renamed; compose mounts it.
- `scripts/build-docs-pdf.py` is excluded; it belongs to ItP's docs.
- `scripts/new-deployment.py` and its test are copied. They are needed to
  deploy the PoC.

### B3. Private-reference rules are ItP's, unchanged — settled

`scripts/check-no-private-references.mjs` and its test were copied with their
rules as they were. This accepts that those two exempt files contain the
private strings they search for.

### B4. ItP identities became `proof-of-concept` — settled

Every ItP resource name in code, config, CI, and fixtures was replaced. This
covers the ECR repositories, the Temporal namespace, the framework repo, the
project tag, and the listener subdomain. The task queue name was kept: task
queues are namespace-scoped, and the namespace is separate.

### B5. Listener team allowlist — settled

- `TRACKER_ALLOWED_TEAM_IDS` is required, and the listener refuses to start
  without it.
- Each event's entity is resolved to its team or teams, and the event is
  dropped unless every team is allowlisted. Anything unresolved is dropped.
  This fails closed.
- It is supplied through the required `listener.allowed-team-ids` context key.
- No team filtering existed in the copied code. This implements F12's
  allowlist.

### B6. The check fails on ItP identities outside markdown — settled

A new rule matches `intent-to-production`, `ki-webhook-listener`, and an
`intent` subdomain value. Markdown is exempt because F2 lets this repo know
about ItP; code, config, and CI must not name ItP resources.

### B7. Definitions resolve inside this repo — settled

- No ItP agent or skill file was copied.
- The intake lane loads `hypothesis-brief-writing` in place of
  `business-requirements-writing`; that role does not carry over (F4).
- Two guard tests fail CI if any definition the plumbing loads is missing.

### B8. The first definitions are drafts — proposal

Four agents and eight skills are drafted from F4–F11, each marked
`DRAFT — unvalidated; prompt engineering happens against real PoC runs`.
Prompt engineering happens against real PoC runs.

### B9. Section 3 expressed under the unchanged gate logic — proposal

These hold until the trial evidence decides which gate logic changes:

- **Direct dispatch.** "The epic dispatches directly" (F8) is Decompose
  creating a single story, because the dispatcher dispatches only stories.
- **Decompose wakes on every approved map.** Decompose still wakes on every
  `spec:resolved`. The drafts never apply `spec:awaiting-designer`.
- **Routed labels keep their names.** The routed labels and statuses are kept,
  and the `brief:`, `claim:`, and `verdict:` labels are layered on as state
  that no code reads.

### B10. Label vocabulary — proposal

- **Keep:** `surface:` stays identical to ItP's.
- **Brief:** `brief:awaiting-confirmation` and `brief:confirmed`.
- **Claim:** `claim:awaiting-demo`, `claim:proven`, and `claim:failed`.
- **Verdict:** `verdict:proven`, `verdict:disproven`, and
  `verdict:proven-with-caveats`.

Each PoC-only gate has its own prefix, so no PoC label changes meaning after
graduation.

### B11. `CLAUDE.md` is committed — settled

The copied `.gitignore` ignored `CLAUDE.md`, as ItP's does. This repo commits
its own `CLAUDE.md` (bootstrap Phase 5), so that ignore line was removed.

---

## 2026-09-24 — Local-only operation for now

### L1. The pipeline runs locally, with no AWS — settled

The PoC pipeline runs through `docker-compose.yml`. Temporal is a local dev
server, not Temporal Cloud. LocalStack emulates the ECS calls the dispatch
worker makes, and it launches the specialist container on the local Docker
engine. No AWS account is used.

- `infrastructure/`, `scripts/new-deployment.py`, and the three
  `build-and-push-*-ecr.yml` workflows are kept but not used.
- The ECR workflows run only on a push to `main`. With no AWS secrets
  configured they fail at the credentials step and push nothing.
- F12's separation holds locally because:
  - the local Temporal namespace is separate from ItP's by construction;
  - the listener allowlists only the PoC tracker team;
  - the GitHub token used locally must still be scoped to PoC repos only.
- The specialist still clones `agents/` and `skills/` from GitHub
  (`FRAMEWORK_REPO` at `FRAMEWORK_REF`), so this repo must be on GitHub at
  the ref the local stack names.

---

## 2026-09-24 — ItP debt sweep

### D1. Copied plumbing no longer cites ItP's documents — settled

- **Citations removed.** The copied comments cited ItP's design-ledger entries
  by date or name, ItP's `CLAUDE.md` sections, ItP's `CONTRIBUTING.md`, and
  ItP's PDFs. Those citations are gone: 44 exact edits across 29 files, with
  the reasoning kept wherever it still holds.
- **References repointed.** References to "No Private References" now point
  to this repo's `CLAUDE.md`. Local-development pointers now point to the
  root README's "Running locally" section.
- **Package READMEs.** The four package READMEs were rewritten against the
  code. The pass removed ItP branding, ItP history (four specialist types, the
  BRD branch, engagement readiness), and dead links. It also fixed claims
  that no longer matched the code, such as the undocumented revision rounds,
  the `In Progress` literal, and the registry's owner.
- **What still names ItP.** ItP's name now appears only in `docs/`,
  `README.md`, `CLAUDE.md`, and the private-reference check. That is where
  F2 lets this repo know about ItP. No code, config, CI, or agent definition
  names it.

### D2. Lane prompts and the specialist message describe the PoC flow — proposal

This supersedes nothing; it replaces ItP-flow text the bootstrap left in place
(B9, "Lane prompt templates" in Open items).

- `prompt-templates/intake.md` reads the hypothesis brief and the `Surfaces`
  document, not a linked BRD and evidence issue.
- `specification-kickoff.md` no longer makes missing designer assets the
  first question, which would have stalled every PoC epic.
- `specification-reply.md` no longer assumes a designer gate.
- The specialist's assignment message points to the brief, the layout
  references, and the shortcut ledger, not to a design issue.

This is prompt text, so it is a proposal until validated against real runs.
The routing logic, including `spec:awaiting-designer`, is unchanged.

---

## 2026-09-24 — PoC conventions skill

### W1. Surfaces get conventions through `poc-conventions-writing` — proposal

- **What it is.** A new skill, `skills/poc-conventions-writing`. It writes
  the structure-only `CONVENTIONS.md` that F9 requires before a surface's
  first dispatch. The file covers layering, boundaries, naming, and the
  shortcut rule, and runs to about a page.
- **Who runs it.** The architect answers in prose and the agent writes the
  file (F3).
- **Why the name.** It is named `poc-` so it cannot be confused with ItP's
  `conventions-writing` where both are installed. That skill writes the full
  production file, which graduation hands to ItP instead (F11).
- **Existing code wins.** In a repo that already has code, the skill
  describes the structure that is there. Conventions that contradict the code
  lose to it.
- **Default location.** The file stays at the default `<path>CONVENTIONS.md`,
  because the dispatcher does not pass the registry's `conventions` path to
  the specialist (see Open items, "Conventions path").
- **Shortcuts section.** It is identical on every surface, and
  `shortcut-marking` is its source of truth.
- **No lane runs it yet.** An architect runs it in their own session.

Amended by 2026-09-24 — W2.

### W2. Conventions say where tests go, with no length cap — proposal

This amends W1, on the owner's direction.

- **Tests section.** The file gains a **Tests** section: where a test goes,
  how it is named, and the command that runs it. It follows the surface's
  existing setup, or the stack's usual default if there is none. It is not a
  requirement to write tests. Tests stay optional on a PoC, because the demo
  gate is what verifies function. This keeps F9's structure-only scope, since
  a test's location is structure.
- **No length cap.** The one-page limit is removed.

---

## 2026-09-24 — No ad-hoc epic or story skills

### A1. Ad-hoc epic and story creation is not carried over — settled

ItP's desktop skills for creating an epic or story outside the normal path
(`desktop-skills/`) were excluded at bootstrap. `bootstrap.md` Section 6 left
open whether they would be re-authored later. The owner decided they are not
needed: work enters a PoC through its hypothesis brief and demo path, and
there is no separate path for ad-hoc epics or stories.

---

## Open items

From `bootstrap.md` Section 8:

- **Trial evidence.** Which ItP gates were ceremony on the PoC trial, and
  which caught real problems. This decides which gate logic is removed from
  the copied plumbing. Nothing is removed until it is written down.
- **Temporal's role.** With fewer long human waits, how much durable
  orchestration a PoC needs. Keep it until evidence says otherwise.
- **Executable demo script.** Whether the Playwright happy path is required,
  and whether GitHub Actions can run it for a monorepo PoC.
- **Sandbox build capability.** In a PoC with no test gate, "it runs" is the
  only verification. If specialists cannot run what they build, nothing
  verifies function until the demo gate. Decide whether this is a
  prerequisite.
- **Label vocabulary.** The Phase 4 prefixes (B10) are proposals.
- **Plumbing ports.** How fixes found in either codebase are tracked for
  manual porting, if at all.
- **License** for this repo.

Found during the bootstrap:

- **Team allowlist in `new-deployment.py`.** The script copies a base
  deployment's config, including its `allowed-team-ids`. It must prompt for
  or flag that value before it is used for a second PoC deployment.
- **Lanes for skills no lane runs.** `demo-gate` and `graduation-packaging`
  have no lane, and nothing applies `claim:awaiting-demo` when an epic's last
  story merges.
- **Conventions authorship.** Who writes each surface's `CONVENTIONS.md`
  before the first dispatch (F9).
  Proposed 2026-09-24 — see W1. Still open: whether a lane should run it.
- **Concurrent shortcut ids.** How shortcut ids avoid collisions when
  specialist runs are concurrent (F7).
- **BRD-seed format.** How graduation keeps up with ItP's business-requirements
  format without a runtime dependency (F2, F11).
- **Lane prompt templates.** `webhook-listener/src/prompt-templates/*.md` still
  describe ItP's flow, and the runner's assignment message names a "design
  issue".
  Resolved 2026-09-24 — see D2.
- **Dangling references.** 60 comment references in the copied plumbing point
  to ItP documents that do not exist here, and the private-reference check
  points to a `CONTRIBUTING.md` that has not been re-authored.
  Resolved 2026-09-24 — see D1.
- **Unverified query.** The Linear `project { teams }` query behind the team
  allowlist is unverified against the live schema.
- **Infrastructure tests.** They need generated provider bindings
  (`cdktn get`) before `temporal-namespace.test.ts` can load, and the package
  is not in CI.
- **Framework ref.** The template's `framework-ref` is `dev`, and this repo
  has no `dev` branch.
- **Conventions path.** The specialist is not told where a surface's
  conventions file is. The dispatcher passes the surface directories but
  not the registry's `conventions` path, so only the default
  `<path>CONVENTIONS.md` is found without reading the `Surfaces` document.
