# Bootstrap inventory (Phase 0)

Status: produced 2026-09-24 by the Phase 0 session, for human review. Nothing
has been copied. Classifications below are proposals against
`docs/bootstrap.md` Section 6; conflicts with Section 6 are listed in §7 and
are **not resolved here**.

Deployment-specific names found in the ItP checkout (engagement deployment
configs, tracker team keys, client names, people) are deliberately **not
written into this file**, because Section 7 forbids engagement names in this
repo. They are described by kind and location only; the literal values were
reported in the review conversation.

---

## 1. Source

| Item | Value |
|---|---|
| Checkout | `C:\Users\David\Source\kisasa\intent-to-production` |
| Branch | `main` |
| Commit | `5aed0398a013fe7cb3ccec8d6bf024e775a685a4` |
| Commit date / subject | 2026-09-23 16:42:22 -0400, "Bring both Claude SDKs up to latest (#17)" |
| Tracked files | 197 |

**Registry present at this commit: yes.** The paths differ from those named in
Section 5 step 2 ("or its equivalent"):

- `dispatch-worker/src/activities/surface-registry.ts`: parser, merge,
  `resolveSurfaces`, `renderSurfacesBlock` (tests in `surface-registry.test.ts`)
- `dispatch-worker/src/activities/resolve-surfaces.ts`: the Temporal activity
  that reads the project `Surfaces` document and the epic's
  `Surfaces (override)` document

**Clean: yes.** `git status --porcelain` is empty. No `_to_delete/` exists.
The paths that are ignored but present on disk are listed below. None of them
is a copy source:

| Ignored path on disk | Kind |
|---|---|
| `.claude/`, `.idea/` | local tool state |
| `CLAUDE.md` | ItP's CLAUDE.md is **gitignored**, so it exists only locally and is not in the commit |
| `infrastructure/cdktf.<deployment>.json` ×2 | real deployment configs (two engagements) |
| `infrastructure/<deployment>.out/` ×2 | synthesized output for the same two deployments (may contain `.terraform/`, provider locks, plan artifacts) |
| `infrastructure/.gen/` | generated provider bindings |
| `*/node_modules/`, `dispatch-worker/dist/`, `scripts/__pycache__/` | build output |

`.junie/` exists on disk (holding `.junie/plans/`) but is neither tracked nor
ignored. It shows up in no git listing, which suggests it contains no files.

Phase 1 should copy from `git archive 5aed039` rather than from the working
tree. That makes the ignored paths above unreachable by construction. Phase 0's
test copy was made this way.

---

## 2. Top-level classification

Legend: **V** copy verbatim · **R** copy, then rename identity (Phase 2) ·
**A** re-author, never copy content · **X** exclude.

| Path | Class | Reason |
|---|---|---|
| `webhook-listener/` | V* | Plumbing. *Carries identity (§4) and the agent/skill loaders (§3); renames in Phase 2, repointing in Phase 3. |
| `dispatch-worker/` | V* | Plumbing, including the surface registry. *Has a few identity-bearing literals (§4). |
| `specialist-runner/` | V* | Plumbing. *Clones a "framework repo" for agents/skills at runtime, and its tests use an ItP coordinate (§3, §4). |
| `docker-compose.yml` | **R** (Section 6 says V; accepted, §8) | Hardcodes `FRAMEWORK_REPO: example-org/intent-to-production` and the task queue name. See §7 C3. |
| `docker-compose.override.yml.example` | V | Blank secrets and a blank `FRAMEWORK_REPO`. No identity. |
| `.dockerignore`, `.gitattributes`, `.gitignore` | V | Generic. `.gitignore` already ignores `cdktf.*.json`, `**.out/`, `CLAUDE.md`, `.claude/`. |
| `infrastructure/main.ts`, `common.ts`, `constructs/`, `models/`, `stacks/`, `testing/` | R | Names come from context. Some literals and all test fixtures carry ItP identity (§4). |
| `infrastructure/package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.mts` | R | Package name is generic (`infrastructure`). Listed under R per Section 6; likely no edits needed. |
| `infrastructure/cdktf.example.json` | R | The template. Every placeholder that names ItP (project tag, ECR repo names, namespace, framework repo, subdomain) changes. |
| `infrastructure/README.md` | R | Operator doc; refers to `example-org/intent-to-production` and the ItP ECR names. |
| `infrastructure/.gitignore` | V (not in Section 6) | Ignores `.gen/`, `.terraform/`, `*.tfstate*`, `*.tfvars`. Protective, so keep it. §7 C5. |
| `infrastructure/cdktf.<deployment>.json` (×2, untracked) | X | Real engagement deployment configs. |
| `infrastructure/<deployment>.out/` (×2, untracked) | X | **Terraform output and state-adjacent files for live ItP deployments. The most dangerous class.** |
| `infrastructure/.gen/` | X | Generated. Regenerate with `cdktn get`. |
| `.github/workflows/build-and-push-*-ecr.yml` (×3) | R | Push to ItP's ECR repository names on push to `main` (§4). |
| `.github/workflows/unit-tests.yml` | R | No identity found. Section 6 puts the whole directory under R. |
| `.github/workflows/private-references.yml` | R | Runs the check below. |
| `scripts/check-no-private-references.mjs` + `.test.mjs` | R | The rule list itself **contains** ItP's private identities. See §7 C1. |
| `scripts/new-deployment.py` + `new-deployment.test.py` | R | Needed to deploy the PoC (§8, C2). |
| `scripts/localstack-bootstrap.sh` | R (not in Section 6) | Mounted by `docker-compose.yml`, so it is needed if compose is copied. Passes through `FRAMEWORK_REPO`. §7 C5. |
| `scripts/build-docs-pdf.py` | X (not in Section 6) | Renders ItP's `docs/source/*.md` to PDF. Belongs with `docs/`. §7 C5. |
| `agents/` (4 files) | A | Section 6. |
| `skills/` (6 skills) | A | Section 6. |
| `README.md`, `CONTRIBUTING.md` | A | Section 6. |
| `CLAUDE.md` | A | Section 6. Untracked in ItP, so there is nothing to copy anyway. |
| `docs/` (design ledger, 3 PDFs, 3 sources) | X | Section 6. |
| `desktop-skills/` | X | Section 6. |
| `.claude/`, `.idea/`, `.junie/` | X | Section 6. |
| `LICENSE` | X | Section 6. It is MIT, "Copyright (c) 2026 Kisasa". Decide deliberately (open item). |
| `node_modules/`, `dist/`, `__pycache__/` | X | Section 6. |

---

## 3. Plumbing → agent definition / skill references

These are the points Phase 3 repoints. "Loads" means a file is read at run
time; "names" means the plumbing only mentions the agent in text.

### Loads a file

| File | Symbol | What it loads |
|---|---|---|
| `webhook-listener/src/prompt-assembly.ts` | `AGENTS_DIR` (`../../agents/`), `loadAgentFile`, `buildSystemBlocks` | `agents/<agentFile>` |
| `webhook-listener/src/skills.ts` | `SKILLS_DIR` (`../../skills/`), `loadSkills` | `skills/<name>/SKILL.md` |
| `webhook-listener/src/lanes/intake.ts` | `config.agentFile`, `config.skills` | `intake-agent.md`, plus `epic-writing`, `business-requirements-writing`, `tracker-writing` |
| `webhook-listener/src/lanes/specification.ts` | `config.agentFile`, `config.skills` | `specification-agent.md`, plus `api-map-writing`, `epic-writing`, `tracker-writing` |
| `webhook-listener/src/lanes/decompose.ts` | `config.agentFile`, `config.skills` | `decompose-agent.md`, plus `epic-writing`, `story-contract`, `tracker-writing` |
| `webhook-listener/src/swim-lanes.ts` | `lanes` | Registers the three lanes above plus `specialist-dispatch` (which loads no agent) |
| `webhook-listener/src/prompt-templates/*.md` | (templates) | Lane prompt text. `intake.md`, `specification-kickoff.md`, `specification-reply.md`, `decompose.md`. These are prompt content, loaded by `renderActivationPrompt`. |
| `webhook-listener/Dockerfile` | `COPY agents`, `COPY skills` | Bakes repo-root `agents/` and `skills/` into the image (build context = repo root) |
| `specialist-runner/src/prompt.ts` | `AGENT_FILE = "specialist.md"`, `FRAMEWORK_SKILL_NAMES = ["story-contract", "epic-writing"]`, `buildSystemPrompt` | Inlines `agents/specialist.md` plus those two skills |
| `specialist-runner/src/prompt.ts` | `resolveSurfaceSkill` | Registry `skills:`. Checks the surface repo's `.claude/skills/<name>/SKILL.md` first, then the framework `skills/<name>/SKILL.md`. **This is where `shortcut-marking` would arrive.** |
| `specialist-runner/src/workspace.ts` | `prepareWorkspace` | **Shallow-clones `FRAMEWORK_REPO@FRAMEWORK_REF` from GitHub every run** to get `agents/` and `skills/`. The image does not bake them in. |
| `specialist-runner/src/dispatch-context.ts` | `frameworkRepo`, `frameworkRef` (`requireEnv`) | Supplies the clone target above |
| `infrastructure/models/specialist-sandbox-configuration.ts` / `stacks/specialist-sandbox.ts` | `frameworkRepo`/`frameworkRef` → `FRAMEWORK_REPO`/`FRAMEWORK_REF` env | Bakes the clone target into the ECS task definition |
| `dispatch-worker/src/workflows/dispatch-story-workflow.ts` | `surfaceSkills` passed to `dispatchSpecialist` | Unions the registry `skills` across the story's surfaces |
| `dispatch-worker/src/activities/dispatch-specialist.ts` | `buildContainerOverrides` → `SURFACE_SKILLS` | Carries those skills to the runner |

**Dependency-rule note (flag for Phase 3):** the specialist's definitions come
from a *GitHub repo named in config*, not from this repo's files on disk.
Every shipped default of that config points at ItP: `cdktf.example.json`
(`framework-repo: example-org/intent-to-production`, `framework-ref: dev`),
`docker-compose.yml`, and `specialist-runner/.env.example`. Repointing the
loaders to this repo's `agents/` is not enough on its own. The clone target has
to become this repo, or the PoC specialist will run ItP's `specialist.md` and
skills.

### Names an agent or skill in text only (no load)

- `dispatch-worker/src/activities/resolve-surfaces.ts`, `createResolveSurfacesActivity`:
  failure messages say "The Specification Agent writes it". The same file's
  `surface-registry.ts` `resolveSurfaces` says "the Specification or Decompose
  Agent adds a surface".
- `dispatch-worker/src/activities/check-dependencies.ts`, `parseBlockingDependencyIds`:
  its parsing contract is `story-contract`'s "Blocking dependencies" section
  format. (Comments cite `skills/story-contract/SKILL.md`.)
- `webhook-listener/src/story-context.ts`: `tier:` and `size:` semantics are
  cited from `story-contract.md`.
- `specialist-runner/src/prompt.ts`, `buildUserMessage` / `buildRevisionMessage`:
  the user message tells the specialist to read "the parent epic, its resolved
  API map, and the linked design issue", check dependencies, and verify the
  branch chain. This is prompt content living in plumbing.
- `specialist-runner/src/mcp-servers.ts`: header comment cites
  `agents/specialist-backend.md` / `-frontend.md`. These are stale; neither
  exists at this commit.
- Tests that fabricate agent and skill files: `webhook-listener/src/prompt-assembly.test.ts`
  (reads the **real** `intake-agent.md` and `decompose-agent.md`, plus
  `epic-writing` and `story-contract`, from `../../agents` and `../../skills`),
  and `specialist-runner/src/prompt.test.ts` (writes temp `specialist.md`,
  `story-contract`, `epic-writing`, `house-style`, `cdkterrain`).
  **`prompt-assembly.test.ts` will fail in Phase 1 unless `agents/` and
  `skills/` exist.** This is relevant to the Phase 3 stub rule and to the
  Phase 1 count match (§7 C6).

**Skills the plumbing requires to exist, by name:** `epic-writing`,
`business-requirements-writing`, `tracker-writing`, `api-map-writing`,
`story-contract`. Two further files are exercised by tests only:
`intake-agent.md` and `decompose-agent.md`. `conventions-writing` is not
referenced by any plumbing. So `api-map-writing` and `tracker-writing` *are*
required by the plumbing as it stands. That answers Section 5 Phase 4's
condition.

---

## 4. ItP-specific identity in code and config

Found by reading and by pattern search across tracked non-doc files.
"Fixture" means test data only.

### Tracker (Linear)

- **No team or workspace id appears anywhere in code or config.** There is
  **no team filtering** in the listener: `webhook-listener/src/server.ts`
  (the `/webhooks/linear` handler) and `adapters/linear.ts`
  (`createLinearAdapter().parseEvent`) accept any signed event. Phase 2 step 2
  therefore *adds* the allowlist; there is no existing mechanism to configure.
  The payload does carry a team: `move-story-to-todo.ts` already queries
  `issue { team { id } }`.
- Tracker identity is entirely env-supplied: `LINEAR_WEBHOOK_SECRET`,
  `LINEAR_AGENT_API_KEY`, `AGENT_USER_ID`, `LINEAR_API_URL`, `LINEAR_MCP_URL`.
  There are no committed values.
- Status names are hardcoded and tracker-configuration-specific (not ItP
  identity, but deployment-shaped): `"Backlog"`, `"Evaluation"`,
  `"In Progress"`, `"Todo"`. See §5.

### Temporal

- `infrastructure/stacks/temporal-workers.ts`: `TASK_QUEUE_NAME = "dispatch-task-queue"`
  (a literal, not from context).
- `docker-compose.yml`: `TEMPORAL_TASK_QUEUE: dispatch-task-queue` ×2,
  `TEMPORAL_NAMESPACE: default`.
- `infrastructure/cdktf.example.json`: `temporal.namespace-name: intent-to-production-prod`.
- Fixtures: `webhook-listener/src/temporal-client.test.ts` and
  `dispatch-trigger.test.ts` (`dispatch-task-queue`);
  `infrastructure/stacks/listener.test.ts` (`intent-to-production-test`).
- Code: namespace, host, and queue are otherwise env-driven
  (`webhook-listener/src/temporal-client.ts` `envConfig`;
  `dispatch-worker/src/worker-config.ts` `loadWorkerConfig`).

### Container registry (ECR)

| Where | Value |
|---|---|
| `.github/workflows/build-and-push-webhook-listener-ecr.yml` `env.ECR_REPOSITORY` | `intent-to-production` |
| `.github/workflows/build-and-push-specialist-ecr.yml` `env.ECR_REPOSITORY` | `intent-to-production-specialist` |
| `.github/workflows/build-and-push-dispatch-worker-ecr.yml` `env.ECR_REPOSITORY` | `intent-to-production-temporal-worker` |
| `infrastructure/cdktf.example.json` `*.ecr-repository-name` | the same three |
| `infrastructure/stacks/listener.test.ts` (fixture) | the same three |

All three workflows run on `push` to `main` (path-filtered) and on
`workflow_dispatch`. They authenticate with `secrets.AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and **create the repository if it is
missing**. Copied unchanged into a repo whose secrets point at ItP's AWS
account, the first push to `main` would push PoC images into ItP's
repositories.

### AWS names and prefixes

- Every resource name is built from context `resource-name-prefix` and
  `environment-name` (`stacks/listener.ts`, `network.ts`,
  `specialist-sandbox.ts`, `temporal-workers.ts`, and the `constructs/*`
  `formatName(...)` calls). There are no hardcoded ItP prefixes in stack code.
- State keys are literals in `infrastructure/common.ts` `tfStateKeys`
  (`network.tfstate`, `listener.tfstate`, `specialist-sandbox.tfstate`,
  `temporal-workers.tfstate`) inside context `state-bucket-name`. They are not
  ItP-specific in themselves, but they are safe only while the bucket is
  separate.
- `cdktf.example.json`: `global-tags.project: intent-to-production`,
  `listener.subdomain: intent`, `parameter-prefix: /example/prod/`,
  `resource-name-prefix: example`, and `projectId`.
- Fixtures: `global-tags.project: intent-to-production` in
  `constructs/network-vpc.test.ts`, `single-instance-service.test.ts`,
  `specialist-task.test.ts`, `temporal-privatelink.test.ts`,
  `temporal-worker-service.test.ts`, and `stacks/listener.test.ts`.
  **`stacks/listener.test.ts` also has `state-bucket-name: "ki-webhook-listener-tfstate"`**,
  a prefix that looks org-derived and is not caught by ItP's own check.
- `scripts/localstack-bootstrap.sh`: local-only names (`specialist-local-sg`,
  and cluster and task family from env). Not ItP identity.

### GitHub

- No GitHub App id anywhere. Auth is a PAT via `GITHUB_TOKEN` (listener MCP,
  dispatch-worker REST, runner clone and MCP).
- Framework repo coordinate `example-org/intent-to-production`: in
  `cdktf.example.json`, `docker-compose.yml`, `specialist-runner/.env.example`
  (comment default), `infrastructure/README.md`, and the fixtures
  `specialist-runner/src/prompt.test.ts`, `dispatch-context.test.ts`,
  `infrastructure/stacks/listener.test.ts`, and `scripts/new-deployment.test.py`.
- `specialist-runner/src/workspace.ts`: `GIT_AUTHOR_NAME = "Specialist"`,
  `GIT_AUTHOR_EMAIL = "specialist@example.com"`. Generic.
- `dispatch-worker/src/activities/create-story-branch.ts`: host must be
  `github` (not identity; a limitation).

### Deployment configs and engagement names

- Two untracked deployment configs and two `.out/` directories (§1). Their
  names encode tracker team keys plus a date, per `scripts/new-deployment.py`'s
  naming rule. Excluded, and not reproduced here.
- `scripts/check-no-private-references.mjs` `RULES` hard-codes, as literals:
  five tracker team keys, a client-name regex covering at least two client
  organisations and their repos, people (full names, logins, an email domain,
  and one Linear user UUID), bare first names, and a named-environment prefix.
  The test file carries examples of each. **This is the densest concentration
  of ItP and engagement identity in the plumbing.** See §7 C1.
- `LICENSE`: the copyright holder's name.
- Package names (`webhook-listener`, `dispatch-worker`, `specialist-runner`,
  `infrastructure`) are generic.

### Dangling references to ItP documents

There are 60 references across 32 files in the copy set to `docs/design-ledger.md`,
`docs/*.pdf`/`*.md`, or `CLAUDE.md`. All are comments, READMEs, or `.env.example`
text. None is loaded at run time. The heaviest are `dispatch-worker/README.md`
(9) and `specialist-runner/README.md` (7). After copying, they point at ItP
documents that will not exist here. They are listed for a later decision and
are not changed by the bootstrap.

---

## 5. Gate logic in code (listed, not changed)

| Gate | File | Symbol | What it decides |
|---|---|---|---|
| Webhook authenticity | `webhook-listener/src/adapters/linear.ts` | `verifySignature` | HMAC on the raw body |
| Dedupe / debounce | `webhook-listener/src/agent-scheduler.ts` | `alreadySeen`, `makeDispatcher` | Retry dedupe; coalesce comment bursts (`DEBOUNCE_MS`) |
| Dry-run stage | `webhook-listener/src/server.ts` | `TEST_STAGE` | `accept` stops before routing |
| Team scoping | none | none | **Absent.** Phase 2 adds it. |
| Lane triggers | `webhook-listener/src/swim-lanes.ts` | `lanes` | Intake: label `ready for intake` on a `Backlog` project. Specification: epic enters `Evaluation` with no `spec:*`; follow-up on `spec:awaiting-architect`/`-designer`/`-answers`. Decompose: `spec:resolved` in `Evaluation`; follow-up on `eval:awaiting-answers`/`-approval`. Dispatch: story enters `In Progress` carrying `surface:*`. |
| Routing | `webhook-listener/src/swim-lane-routing.ts` | `route` | label_added / status_entered / comment_added matching; `requireLabelsAbsentPrefix` / `requireLabelsPresentPrefix`; `statusRequiredForFollowUp`; **self-comment guard** (`agentUserId`) |
| Label handoffs set by agents | agent definitions (via MCP) | none | `ready for intake` → `ready for eval`, `spec:*`, `eval:*` are written by the agents, not by the plumbing. The designer rows (`spec:awaiting-designer`, `design:asset` in `prompt-templates/specification-kickoff.md`) are ItP gates a PoC may not want (Section 3.5). |
| Dispatchability | `webhook-listener/src/story-context.ts` | `fetchStoryDispatchContext`, `parseSurfaces` | Needs a parent epic and at least one `surface:` label; otherwise comment and move back to Todo |
| Turn budget | `webhook-listener/src/dispatch-trigger.ts` | `resolveMaxTurns`, `BASE_MAX_TURNS`, `TIER_MULTIPLIER`, `SIZE_MULTIPLIER`; `story-context.ts` `parseTier`, `parseSize` | `tier:`/`size:` labels scale the specialist's `maxTurns` |
| Workflow start | `webhook-listener/src/dispatch-trigger.ts` | `createDispatchTrigger` | `workflowId = dispatch-<story>`; an already-running workflow is a no-op |
| Retreat to Todo | `webhook-listener/src/move-story-to-todo.ts`; `dispatch-worker/src/activities/move-story-to-todo.ts` | `moveStoryToTodo`, `TODO_STATUS_NAME = "Todo"` | Every stopped-without-PR path |
| **Dependency gating** | `dispatch-worker/src/activities/check-dependencies.ts` | `parseBlockingDependencyIds`, `createCheckDependenciesActivity` | Blockers listed in the story description must have `stateType === "completed"` |
| **Surface resolution** | `dispatch-worker/src/activities/resolve-surfaces.ts` | `buildEffectiveRegistry`, `createResolveSurfacesActivity` | Project `Surfaces` + epic `Surfaces (override)`; a missing or malformed registry is non-retryable |
| **Same-repo check** | `dispatch-worker/src/activities/surface-registry.ts` | `resolveSurfaces` (`sameRepoAndRef`) | All of a story's surfaces must be active and share one repo and ref |
| Registry format | `dispatch-worker/src/activities/surface-registry.ts` | `parseSurfacesBlock`, `renderSurfacesBlock`, `PROJECT_REGISTRY_TITLE`, `EPIC_OVERRIDE_TITLE` | Strict parser. The format must stay identical to ItP (Section 3.7). |
| Branch chain | `dispatch-worker/src/activities/create-story-branch.ts` | `createStoryBranch` | The epic branch must exist; the host must be `github` |
| Dispatch sequence | `dispatch-worker/src/workflows/dispatch-story-workflow.ts` | `dispatchStoryWorkflow` | deps → surfaces → branch → specialist → find PR → reviewer → watch |
| Revision loop | same file | `REVISION_ROUND_CAP = 3`, `REVISION_MAX_TURNS = 25` | Reviewer "changes requested" re-dispatches the specialist |
| Reviewer-of-record | `dispatch-worker/src/activities/request-pull-request-reviewer.ts` | `resolveReviewerLogin` | Story mover's email → GitHub login mapping (`REVIEWER_EMAIL_TO_GITHUB_LOGIN`) |
| Review watermark | `dispatch-worker/src/activities/await-pull-request-outcome.ts` | `pickChangeRequest`, `awaitPullRequestOutcome` | Only a review newer than the last one acted on counts; merged or closed ends the watch |
| Mandatory skills | `specialist-runner/src/prompt.ts` | `resolveSurfaceSkill` | A registry skill that resolves nowhere fails the run before it starts |
| Specialist instructions | `specialist-runner/src/prompt.ts` | `buildUserMessage` | Tells the agent to check deps and verify the branch chain (prompt-level gate) |

---

## 6. Tests and baseline counts

These were run in a scratch copy made with `git archive HEAD` (outside both
repos), after `npm ci` per package. Nothing was run in the ItP checkout. The
environment was Windows 11, Node 24.13.0, npm 11.6.2, and Python 3.14.7. CI
uses Node 22 on ubuntu.

| Package | Command | Typecheck | Result |
|---|---|---|---|
| `webhook-listener` | `npm run test:unit` | pass | **113 passed / 113**, 10 files |
| `dispatch-worker` | `npm run test:unit` | pass | **127 passed / 127**, 14 files (warm run). The first, cold run had 1 timeout: `dispatch-story-workflow.test.ts` › "short-circuits to not-ready…" hit the 30 s limit while the Temporal test server was first downloaded. It passed on rerun. This is environmental. |
| `specialist-runner` | `npm run test:unit` | pass | **42 passed / 42**, 5 files |
| `infrastructure` | `npm run test:unit` | **fails** (5× TS2307) | **35 passed / 35 across 7 of 8 files. 1 file fails to load**: `constructs/temporal-namespace.test.ts` imports `../.gen/providers/temporalcloud/*`, which exists only after `cdktn get`. CI deliberately does not test this package (`unit-tests.yml` comment). |
| `scripts` (node) | `node --test 'scripts/*.test.mjs'` | n/a | **14 passed / 14** |
| `scripts` (python) | `python scripts/new-deployment.test.py` | n/a | **81 passed / 81** (`python -m unittest` cannot import the hyphenated filename; run the file directly) |

The owner has said ItP is stable. These counts are recorded only as the
Phase 1 comparison baseline, and the failures above were not investigated
beyond identifying their cause.

---

## 7. Conflicts with Section 6, and decisions needed

**C1. The private-reference check cannot be copied without importing ItP
identity.** `scripts/check-no-private-references.mjs` (and its test) works by
listing ItP's own private strings: team keys, client names, people, and a
Linear user id. Section 6 says to copy it and rename identity. Section 7 says no
engagement name may exist in this repo. Phase 2 step 3 says to extend it with
every ItP identity string from this inventory. Taken literally, those three
requirements make the check the leak. Some options, for the reviewer to pick
from:

1. Keep the mechanism, but load the deny-list from outside the repo (a CI
   secret or variable).
2. Commit only hashes of the strings.
3. Copy the rules as they are and accept this file as the one exemption.

The existing rules also flag `David`, `Dieruf`, and `@kisasa.io`, which will
match this repo's own authorship if that appears in files.

**C2. `scripts/new-deployment.py`: the condition is ambiguous.** No
infrastructure code imports it. `infrastructure/README.md` makes it the
documented way to create every deployment after the first, and it reads and
writes `infrastructure/cdktf.*.json`. Its tests fixture ItP coordinates. Should
it be excluded (the condition is not met by code) or included (the condition is
met by procedure)?

**C3. `docker-compose.yml` is not identity-free.** It hardcodes
`FRAMEWORK_REPO: example-org/intent-to-production` and `dispatch-task-queue`.
It should probably be R rather than V.

**C4. The "copy verbatim" packages carry identity.** This affects
`webhook-listener/`, `dispatch-worker/`, and `specialist-runner/`, mostly in
fixtures and `.env.example` comments. The largest items are the framework-repo
coordinate and the task queue name (§4). This fits Phase 2 as written ("replace
every ItP-specific identity from the inventory"), but it means those packages
are not "verbatim" after Phase 2, and some test counts may move.

**C5. Paths Section 6 does not classify.** These proposals need confirmation:

| Path | Proposed class | Reason |
|---|---|---|
| `infrastructure/.gitignore` | V | Protects against state and `.gen/` |
| `scripts/localstack-bootstrap.sh` | R | Required by compose |
| `scripts/build-docs-pdf.py` | X | Belongs to ItP's docs |

**C6. The Phase 1 count match depends on Phase 3 files.** `webhook-listener`'s
`prompt-assembly.test.ts` reads the real `agents/intake-agent.md`,
`agents/decompose-agent.md`, and the `epic-writing` and `story-contract`
skills. Phase 1 copies no agents or skills, so this file would fail and the
113 would not match. That would be a missing fixture, not a copy defect. Which
should Phase 1 do?

1. Create the Phase 3 `DRAFT — not yet authored` stubs early.
2. Record the expected failures and match counts net of them.

**C7. The specialist's definitions are cloned from a repo named in config**
(§3). The bootstrap's Phase 3 wording ("point it at this repo's `agents/` and
`skills/`") covers the listener's on-disk loaders. For the runner, it means
changing the configured `FRAMEWORK_REPO` default to this repo. That is a
configuration value, so it may belong in Phase 2.

**C8. `infrastructure` does not pass cleanly even in ItP** (§6). Is the
Phase 1 target "35/35 with 1 unloadable file, typecheck failing", or should
Phase 1 run `cdktn get` first? That step needs network access and a
`cdktf.json`; the example template would do.

---

## 8. Review decisions

Recorded 2026-09-24, from the reviewer's answers. Append-only.

- **C1, decided.** The PoC's private-reference rules are the same as ItP's.
  Copy `check-no-private-references.mjs` and its test with `RULES` unchanged.
  This deliberately accepts that those two exempt files contain the listed
  private strings. Wherever an `intent-to-production` identity appears, the
  PoC uses `proof-of-concept`. `RULES` does not contain `intent-to-production`
  at this commit, so the swap does not touch the script itself. It applies to
  the identities in §4 (ECR names, project tag, namespace, framework repo).
  Phase 2's extension then adds the ItP identity strings from §4 as forbidden
  patterns.
- **C2, decided.** `scripts/new-deployment.py` and its test are copied, in
  class R. They are needed to deploy the PoC.
- **C6, decided.** The PoC gets its own listener and shares nothing with
  ItP's. Phase 1 copies `webhook-listener/` as that listener's starting code,
  which then diverges and is deployed separately. So that Phase 1 counts match
  (113), the Phase 3 `DRAFT — not yet authored` stubs that
  `prompt-assembly.test.ts` needs are created in Phase 1:
  `agents/intake-agent.md`, `agents/decompose-agent.md`,
  `skills/epic-writing/SKILL.md`, and `skills/story-contract/SKILL.md`. No ItP
  content goes into them.
- **C3, C4, C5, C7, C8: proposals accepted.**
  - C3: `docker-compose.yml` is class R.
  - C4: identity inside the plumbing packages is renamed in Phase 2, and every
    test change is itemized.
  - C5: `infrastructure/.gitignore` is V, `scripts/localstack-bootstrap.sh` is
    R, and `scripts/build-docs-pdf.py` is X.
  - C7: the `FRAMEWORK_REPO` defaults are changed to this repo in Phase 2.
  - C8: the Phase 1 baseline for `infrastructure` is 35/35 with
    `temporal-namespace.test.ts` unloadable and typecheck failing, and
    `cdktn get` is not run.

**Not a conflict, noted:** ItP's `CLAUDE.md` is gitignored, and code comments
cite it as if it were committed ("CLAUDE.md, Agent Roster", "No Private
References").
