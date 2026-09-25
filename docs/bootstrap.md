# Proof-of-concept pipeline — bootstrap document

Status: founding document, written 2026-09-24, before any code exists in this
repo. It serves two purposes. Sections 1–4 are the design record this repo
starts from; they become the first entries of `docs/design-ledger.md`. Sections
5–8 are the bootstrap plan a Claude Code session executes, with human gates
between phases.

Working name: the repo folder name. No product name has been chosen, and none
should be invented during bootstrap.

---

## 1. What this repo is

A delivery pipeline for proofs of concept: turning an idea into software that
**functions end to end** fast, at low cost, without being tested or hardened
for production load. It is derived from Intent to Production (ItP) and reuses
its runtime, but it is a separate codebase with separate definitions, a
separate ledger, and separate infrastructure.

The goal of a PoC run is a verdict on a hypothesis: proven, disproven, or
proven with caveats. If proven, the idea is expected to go on to full
development, so the PoC should leave behind a good starting point for that
work: artifacts in ItP's input formats, plus code whose shortcuts are marked
and recorded.

### The dependency rule (load-bearing)

**This repo may know about ItP. ItP must never know this repo exists.**

- Nothing is ever written to the ItP repository, its branches, its ledger, its
  issue tracker team, its infrastructure, or its container registries.
- ItP is read from, once, at a pinned commit, during bootstrap. After that,
  porting a plumbing fix from ItP is a deliberate manual act recorded in this
  repo's ledger.
- Graduation (Section 3.8) hands ItP ordinary inputs (a BRD seed, a
  conventions file, a repo) that ItP treats like any other engagement. ItP
  needs no change to accept a graduated PoC.

The reason for the rule: PoC standards are deliberately lower. The failure this
prevents is PoC reasoning leaking into ItP as precedent and lowering production
code quality.

---

## 2. Principles inherited from ItP (restated, not referenced)

These are carried over deliberately and restated here so this repo does not
depend on reading ItP's ledger.

- **Humans gate, agents work.** Every automation decision is evaluated against
  this. A PoC has fewer gates, not zero.
- **Artifacts are documents; threads are for directing them.** Briefs, maps,
  and ledgers are attached documents regenerated in place, not comments.
- **The agent writes machine-read formats; humans answer in prose.** No human
  is ever asked to hand-author a structured record. This is the lesson of the
  repo-base failures in ItP's first engagement.
- **Reply-triggered prompts must not name the expected outcome.** The agent
  determines state from the thread.
- **Never silent.** No gate is satisfied by the absence of an objection.

---

## 3. The PoC model

### 3.1 Project = the hypothesis

One tracker project per PoC. The project is defined by a **hypothesis brief**
(replacing the BRD), which contains:

1. **Hypothesis:** what is being proven, in one or two sentences.
2. **Audience and verdict owner:** who decides whether it was proven. One
   person signs the verdict.
3. **Demo path:** the ordered sequence of user-visible steps that, if they
   work, prove the hypothesis. This is the spine of the whole project.
4. **Faked by design:** the explicit list of what will be stubbed, mocked,
   hardcoded, or skipped (integrations, auth, multi-tenancy, data volume,
   error handling beyond the demo path). Known before work starts.
5. **Layout references:** screenshots only. Specialists have no web access, so
   a live site used as a reference must be captured as screenshots at intake
   and attached to the brief.
6. **Out of scope:** what the PoC will not attempt even as a fake.

Design is loose by intent. The point of a PoC is to see the idea function, not
to settle visual design; that belongs in a design tool. There is no designer
gate.

### 3.2 Epic = one demonstrable claim

An epic is a step (or a small group of steps) of the demo path, phrased as a
claim that can be watched working:

> "A merchant can complete onboarding end to end against a stubbed payment
> provider."

An epic is not a release slice. It closes at the **demo gate** (3.5), not at a
test gate.

### 3.3 Story = optional, and vertical

A story exists only when an epic will not fit in one specialist run. When an
epic is split, stories slice along the demo path, not per surface.

This is possible because a PoC defaults to a **monorepo** (3.7): all surfaces
share one repo and ref, so a story labeled with several surfaces passes the
same-repo dispatch check, and the registry's `path` field scopes each surface.

Rationale: in ItP, per-surface stories exist largely to keep PRs reviewable by
an architect. In a PoC the human reviews behavior, not code, so that reason
mostly disappears.

### 3.4 The shortcut ledger

The shortcut ledger is a PoC's substitute for a test suite. It makes the
verdict honest ("proven, given these fakes") and is the hardening backlog if
the PoC graduates.

- Lives as a document attached to the tracker project, regenerated in place.
- One row per shortcut: `id` (`SC-###`), `location` (file and symbol, never a
  line number), `what is faked`, `what production would need`, and `weight`
  (`cosmetic` | `structural` | `load-bearing`).
- Every shortcut is also **marked in the code** with a greppable comment:
  `POC-SHORTCUT: SC-###`. Code and ledger must agree; a marker with no row, or
  a row with no marker, is a defect.
- Specialists add rows as they work and list new shortcut ids in their
  hand-back.

Why markers matter: at graduation, the PoC code becomes the starting codebase,
and production specialists imitate what they read. Unmarked shortcuts become
patterns. Marked shortcuts become debt.

### 3.5 Gates

| Gate | PoC form |
|---|---|
| Intake / brief | Human confirms the hypothesis brief, especially the demo path and the faked-by-design list. |
| Spec | Kept, lighter. An API map is cheap and becomes the contract if the idea graduates. Architect only; no designer rows. |
| Decompose | Only when an epic exceeds one specialist run. Otherwise the epic dispatches directly. |
| Demo gate (replaces epic-completion gate) | A human watches the epic's claim work and records pass or fail on the epic. No full test suite. |
| Verdict (replaces three-way BRD sign-off) | The verdict owner records proven / disproven / proven-with-caveats on the project. |

**Proposal, not settled:** the demo path should also exist as an executable
happy-path Playwright script, run in GitHub Actions (not the specialist
sandbox, which could not reliably run frontend builds in ItP's first
engagement). It serves as the demo gate's evidence and becomes the first
production E2E test at graduation.

**Evidence not yet recorded:** a PoC trial was run through the full ItP
pipeline and worked well. Which ItP gates felt like ceremony on that trial, and
which caught real problems, should drive which gates are removed from the
copied plumbing. That list does not exist yet and is the first design input
after bootstrap. Until then, no gate logic is removed from the code.

### 3.6 Conventions

Every PoC starts with a short `CONVENTIONS.md` at each surface root, written
before the first dispatch. It covers structure only: layering, where boundaries
sit, naming, and the shortcut-marking rule. It is cheap at the start and
expensive to retrofit once code has set the pattern.

### 3.7 Surfaces and repo shape

- Default is a monorepo with multiple surfaces, one per project inside it,
  each a registry record with a `path`. This was the shape of the successful
  trial; cross-cutting changes were easy because all code was present and
  organized.
- The surface registry format is kept **identical** to ItP's, so a graduated
  PoC's registry entry is usable by ItP unchanged.
- The mandatory-skills field of the registry is how PoC-specific specialist
  behavior (prefer stubs, mark shortcuts, maintain the ledger) is delivered.
  At graduation the skill is removed from the record; the specialist
  definition does not change.

### 3.8 Graduation

When the verdict is "proven" and the idea goes to full development, this
pipeline produces a **graduation package**:

1. A BRD seed in ItP's business-requirements format, built from the hypothesis
   brief, the demo findings, and the verdict.
2. The API map, as-is.
3. The surface registry entry, as-is, with the PoC mandatory skill removed.
4. The shortcut ledger, as the hardening backlog.
5. A rewritten `CONVENTIONS.md` per surface that states: code marked
   `POC-SHORTCUT` is known debt, not precedent; retire it rather than extend
   it.
6. A per-area recommendation, harden or rewrite, for the architect to decide.

ItP receives this through its normal intake. ItP learns nothing about this
pipeline; to ItP, it is a repo with conventions and a BRD.

---

## 4. Separation requirements

Separate codebases are not sufficient on their own. Each of these is a place
the two runtimes can cross wires, and each must be separate before the first
PoC dispatch:

- **Issue tracker:** a separate Linear team (or workspace). The PoC listener
  allowlists only the PoC team. If both listeners received the same
  workspace's webhooks unfiltered, both would act on every event.
- **Temporal:** a separate namespace and task queues.
- **AWS:** separate stacks, task definitions, and names. No shared state.
- **Terraform state:** never copied. See Section 6.
- **Container registry:** separate image repositories. Copied CI workflows
  must not push to ItP's ECR repositories.
- **GitHub credentials:** a separate GitHub App or token, scoped to PoC repos
  only, so a PoC specialist cannot push to a production engagement's repo.
- **Claude project:** PoC design happens in its own Claude project, not ItP's,
  so PoC decisions do not enter ItP's memory.

---

## 5. Bootstrap plan

Executed by a Claude Code session with read access to an ItP checkout and
write access to this repo. The ItP checkout is **read-only for the whole
session**: no writes, no branch changes, no commits, no `git` commands other
than read-only ones (`log`, `show`, `rev-parse`, `status`).

Bootstrap is structural only. It copies, renames, and scaffolds. It does not
change pipeline behavior or gate logic, and it does not finalize any agent
prompt. Behavior changes come later, driven by the trial evidence in 3.5.

Each phase ends with a commit in this repo and a stop for human review. Do not
begin the next phase without explicit approval.

### Phase 0 — Inventory (read-only)

1. Record the ItP commit being read (`git rev-parse HEAD`) and its branch.
2. Confirm the surface registry is present at that commit
   (`dispatch-worker/src/surface-registry.ts` or its equivalent, and
   `resolve-surfaces.ts`). If it is not, stop and report. The PoC must fork
   after the registry lands.
3. Confirm the checkout is clean (`git status`). If it has uncommitted changes
   or a `_to_delete/` directory, report it and do not copy from those paths.
4. Produce `docs/bootstrap-inventory.md` in this repo, covering:
   - Every top-level directory and file, classified as **copy verbatim**,
     **copy then rename identity**, **re-author**, or **exclude**, with a
     one-line reason each. Section 6 gives the default classification.
   - Every place the plumbing references an agent definition, a skill name, or
     a skill path (for example the runner's inlined skill list and the
     listener's routing to agents), with file and symbol.
   - Every place the code or config carries an ItP-specific identity: Linear
     team or workspace ids, Temporal namespace, ECR repository names, AWS
     resource names and prefixes, GitHub App ids, deployment config names,
     client or engagement names.
   - Every place gate logic lives in code (dependency gating, same-repo check,
     surface resolution, label-driven routing), with file and symbol. Listed
     for later decisions, not changed now.
   - Test commands and current pass counts for each package, run in the ItP
     checkout without modifying it. If running tests would write into the ItP
     checkout (build output, caches), run them in a temporary copy instead.

**Stop.** Human reviews the inventory and approves the classification.

### Phase 1 — Copy plumbing verbatim

1. Copy the packages classified "copy verbatim" and "copy then rename
   identity," with their tests, into this repo at the same relative paths.
2. Do not copy `node_modules`, `dist`, build output, caches, or anything in
   Section 6's exclusion list.
3. Install dependencies and run every test suite. Pass counts must match
   Phase 0's. A test that passes in ItP and fails here is a copy defect; fix
   the copy, never the test.
4. Make no behavioral edits in this phase. Identity renames happen in Phase 2.

**Stop.** Human reviews the diff summary and test results.

### Phase 2 — Separate identity

1. Replace every ItP-specific identity from the inventory with a PoC
   placeholder or configuration variable. Nothing that identifies an ItP
   resource may remain as a live value. Examples: container image and ECR
   repository names, CI workflow names and push targets, Temporal namespace,
   AWS resource prefixes, default Linear team.
2. Add a listener-level allowlist for the tracker team, configured by
   environment variable, that rejects events from any other team. If the
   copied listener already has team filtering, configure it; do not add a
   second mechanism.
3. Copy the private-reference check (`scripts/check-no-private-references.mjs`
   and its test) and extend it so CI fails if any ItP-specific identity
   string from the Phase 0 inventory appears in this repo.
4. Rerun all tests. Counts may only change where a test asserted an ItP
   identity value; list each such change.

**Stop.** Human reviews.

### Phase 3 — Detach from ItP definitions

1. At every point in the inventory where plumbing loads an ItP agent
   definition or skill, point it at this repo's `agents/` and `skills/`
   directories instead. Keep file names only where the role genuinely
   carries over (see Phase 4).
2. Do not copy any ItP agent or skill file into this repo. Where plumbing
   needs a file to exist to pass tests, create a stub containing only a
   header and `DRAFT — not yet authored`.
3. Rerun all tests.

**Stop.** Human reviews.

### Phase 4 — Scaffold PoC definitions

Create draft definitions from the contracts in Section 3. These are
structural drafts: purpose, inputs, outputs, output contracts, gates, and
labels. Mark every file `DRAFT — unvalidated; prompt engineering happens
against real PoC runs`. ItP's definitions may be read for format, but content
comes from this document, not from adapting ItP text.

Agents (in `agents/`):
- `intake-agent.md`: produces and regenerates the hypothesis brief (3.1);
  captures layout references as attachments; proposes the surface registry for
  a monorepo from what it can read; asks the human to confirm in prose.
- `specification-agent.md`: API map, architect rows only.
- `decompose-agent.md`: invoked only when an epic exceeds one specialist run;
  vertical slicing along the demo path.
- `specialist.md`: generic, like ItP's. PoC-specific behavior arrives via the
  mandatory skill, not this file.

Skills (in `skills/`):
- `hypothesis-brief-writing`: the brief's structure and quality bar.
- `shortcut-marking`: the mandatory specialist skill. Prefer stubs over real
  integrations; mark every shortcut in code; add a ledger row; report new ids
  in the hand-back.
- `demo-gate`: what the human is shown, how pass or fail is recorded on the
  epic.
- `graduation-packaging`: produces the package in 3.8.

Carry `api-map-writing` and `tracker-writing` only if the inventory shows the
plumbing requires them, and re-author them rather than copying.

Labels are proposals, recorded in the ledger as unsettled. Keep `surface:`
identical to ItP (the registry format is shared at graduation). Use distinct
prefixes for PoC-only gates, for example `brief:`, `claim:` (`awaiting-demo`,
`proven`, `failed`), and `verdict:`, so no PoC label means something different
after graduation.

**Stop.** Human reviews.

### Phase 5 — Ledger and README

1. Create `docs/design-ledger.md`. First entry, dated: "Plumbing copied from
   ItP at commit `<sha>` on `<date>`," followed by Sections 1–4 of this
   document as the founding decisions, each marked settled or proposal as it
   is marked here.
2. Append entries for anything decided during Phases 0–4, strictly
   append-only by date. A superseded entry gets a one-line pointer forward.
3. Add an "Open items" section with Section 8's list.
4. Write a `README.md` describing the repo as a PoC delivery pipeline derived
   from ItP, with the dependency rule stated plainly.
5. Write a `CLAUDE.md` for this repo that tells future sessions to read the
   ledger before planning, and states the dependency rule. Do not copy ItP's.

**Stop.** Bootstrap complete.

---

## 6. Default classification

Phase 0 confirms or corrects these against the actual checkout.

**Copy verbatim (with tests):**
- `webhook-listener/`
- `dispatch-worker/`
- `specialist-runner/`
- `docker-compose.yml`, `docker-compose.override.yml.example`
- `.dockerignore`, `.gitattributes`, `.gitignore`

**Copy, then rename identity (Phase 2):**
- `infrastructure/` code only: `main.ts`, `common.ts`, `constructs/`,
  `models/`, `stacks/`, `testing/`, `package.json`, `package-lock.json`,
  `tsconfig.json`, `vitest.config.mts`, `cdktf.example.json`, `README.md`
- `.github/workflows/`: every image name and push target changes
- `scripts/check-no-private-references.mjs` and its test
- `scripts/new-deployment.py` and its test, if the inventory shows the
  infrastructure depends on it

**Re-author (never copy the content):**
- `agents/`, `skills/`
- `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`

**Exclude:**
- `docs/`, including ItP's design ledger. Nothing from ItP's docs enters this
  repo.
- `desktop-skills/`. Ad-hoc epic and story creation may be re-authored later
  if needed.
- `infrastructure/cdktf.*.json` other than the example: these are ItP
  deployment configs and carry engagement identities.
- `infrastructure/*.out/`, any `.terraform/`, `terraform.tfstate`, and
  `.terraform.lock.hcl` under output directories. **Copying Terraform state
  would let a deploy from this repo modify or destroy ItP's live resources.**
  This is the most dangerous file class in the checkout.
- `infrastructure/.gen/` (generated; regenerate)
- `.claude/` (settings, locks, worktrees), `.idea/`, `.junie/`
- `_to_delete/`, if present
- `node_modules/`, `dist/`, `__pycache__/`, any build output
- `LICENSE`: decide deliberately; do not copy by default

---

## 7. Acceptance criteria for bootstrap

- All copied test suites pass, with counts matching Phase 0 except for
  itemized identity-assertion changes.
- The private-reference check passes and fails CI on any ItP identity string.
- No Terraform state, deployment config, or engagement name exists in this
  repo.
- Every plumbing reference to an agent or skill resolves inside this repo.
- Every agent and skill file is marked DRAFT.
- The ItP checkout is byte-for-byte unchanged (`git status` clean, same HEAD
  as Phase 0).
- The ledger's first entry records the source commit.

---

## 8. Open items (carried into the ledger)

- **Trial evidence:** which ItP gates were ceremony on the PoC trial and which
  caught real problems. This decides which gate logic is removed from the
  copied plumbing. Nothing is removed until this is written down.
- **Temporal's role:** with fewer long human waits, how much durable
  orchestration a PoC needs. Keep it until evidence says otherwise.
- **Executable demo script:** whether the Playwright happy path is required,
  and whether GitHub Actions can run it for a monorepo PoC.
- **Sandbox build capability:** in a PoC with no test gate, "it runs" is the
  only verification. If specialists cannot run what they build, nothing
  verifies function until the demo gate. Decide whether this is a
  prerequisite.
- **Label vocabulary:** Phase 4's prefixes are proposals.
- **Plumbing ports:** how fixes found in either codebase are tracked for
  manual porting, if at all.
- **License** for this repo.
