# specialist-runner

Runs **the Specialist** — one generic developer definition
(`agents/specialist.md`) — against one story, in whichever surface(s) that
story is labelled with, inside the `specialist-sandbox` ECS task
[`infrastructure/`](../infrastructure) registers. The automated replacement
for the human half of
[`docs/development-tier-dispatch.pdf`](../docs/development-tier-dispatch.pdf) —
same specialist definition, same MCP-driven orientation and hand-back, just
triggered by a `RunTask` call instead of a developer pasting a prompt into
Claude Code.

Until 2026-08-08 this ran one of four type-specific definitions
(`specialist-backend.md`, `specialist-frontend.md`, `specialist-tests.md`,
`specialist-e2e.md`), selected by a `SPECIALIST_TYPE` env var. The
specialist-types-collapse-into-surfaces redesign (`docs/design-ledger.md`)
found the four were roughly 85% identical once compared properly — no
genuine type-specific behavior survived — and collapsed them into the one
file above. `SPECIALIST_TYPE` is now `SURFACES`, a comma-separated list: a
story may carry more than one `surface:` label (all resolving to the same
repo and ref), and this runner passes every one of them through so the
specialist knows what it may write in, rather than which file to load.

`tests` and `e2e` both needed no new infrastructure to register for
app-dispatch (2026-08-07): `workspace.ts` already clones exactly one target
surface repo per dispatch, resolved by `dispatch-worker`'s
`resolveSurfaces(epicId, surfaces)` from the surface registry (the project's
`Surfaces` document, overridable per epic) — the same mechanism backend and
frontend already used. `e2e`'s registration was blocked slightly longer than
`tests`'s, but not by anything in this package — `specialist-e2e.md` (now
folded into the one generic file) used to require the specialist to stand up
and self-verify against a live environment, which no sandbox here can do
(see `docs/design-ledger.md`, "Integration and E2E run in GitHub Actions":
Fargate can't run the team's privileged docker-compose stack). Once that
requirement was dropped in favor of CI doing the actual execution, dispatch
mechanics were already fully generic and `e2e` registered exactly like
`tests` did.

**This still doesn't execute the E2E suite it writes.** The specialist
writes tests and opens a PR. The decided design has a GitHub Actions
workflow, triggered by the epic's own PR into the BRD branch, stand up
docker-compose and run them. That workflow has not been built in any target
repository, and as of 2026-09-02 it is deliberately parked: for the next
engagement, humans stand the BRD branch up after each epic's stories merge,
run the suite by hand, and sign the epic off in its thread before it merges.
See `docs/engagement-readiness.pdf` for the procedure and
`docs/design-ledger.md` (2026-09-02) for the decision.

Registering `tests` also only covers integration testing *within* one repo
(this engagement's actual shape — `frontend/` and presumably `backend/` as
folders in one `example-app` monorepo). It does **not** cover a hypothetical
engagement where backend and frontend are genuinely separate GitHub repos
and integration tests need both checked out simultaneously — that would
need this package's clone step to support more than one target repo, which
it doesn't today.

## What it does

1. Reads its dispatch context from env vars (below) — nothing is handed to it
   beyond that, same as the manually-dispatched specialist.
2. Clones the framework repo (`agents/`, `skills/`) and the one target surface
   repo fresh, every run — see `src/workspace.ts`. Checks out the story branch
   the tracker already assigned; does not create or repair one.
3. Builds a system prompt from the specialist's own `.md` definition plus the
   two skills it declares (`story-contract`, `epic-writing`), and an initial
   user message naming the story, epic, branches, and surface(s).
4. Runs one [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
   session (`@anthropic-ai/claude-agent-sdk`) with the Linear and GitHub MCP
   servers attached, local Read/Write/Edit/Bash/Grep/Glob tools,
   `permissionMode: "bypassPermissions"` (unattended container, no human to
   approve tool calls), and an explicit model + effort (see below — never the
   SDK's own default).
5. Exits. **This runner does not decide complete/waiting/blocked** — that's
   the specialist's own tracker write, through its own Linear MCP calls, per
   its definition. This process only guarantees the container doesn't hang
   and something is visible if it crashes before Claude gets a turn (see
   `src/tracker-fallback.ts`).

## Dispatch context — the contract for whoever calls this

`src/dispatch-context.ts` validates all of these at startup and fails fast
naming whatever's missing. Most come from `dispatch-worker/src/activities/
dispatch-specialist.ts`'s per-dispatch `RunTask` container overrides;
`FRAMEWORK_REPO`/`FRAMEWORK_REF` don't — they're baked into the specialist
sandbox's own task definition instead (`infrastructure/stacks/
specialist-sandbox.ts`, from `specialist-sandbox.framework-repo`/
`.framework-ref` in `cdktf.json`), since which agents/skills repo and ref a
specialist run uses is a deployment-level setting, not something that varies
per story:

| Var | Required | Meaning | Set by |
|---|---|---|---|
| `STORY_ID`, `STORY_TITLE` | yes | The story | `dispatch-specialist.ts` (`RunTask` override) |
| `EPIC_ID` | yes | Parent epic | `dispatch-specialist.ts` (`RunTask` override) |
| `SURFACES` | yes | Comma-separated `surface:<name>` label(s) the story carries, e.g. `backend` or `web,e2e` | `dispatch-specialist.ts` (`RunTask` override) |
| `SURFACE_REPO` | yes | `org/name` on GitHub — the one repo this run writes to | `dispatch-specialist.ts` (`RunTask` override) |
| `SURFACE_PATHS` | no | Comma-separated directory per surface, same order as `SURFACES` (`/` for the root), from the surface registry. Defaults to `/` for each | `dispatch-specialist.ts` (`RunTask` override) |
| `SURFACE_SKILLS` | no | Comma-separated mandatory skills from the registry; resolved surface-repo `.claude/skills/` first, then the framework catalog, and inlined into the system prompt. A name that resolves nowhere fails the run before it starts | `dispatch-specialist.ts` (`RunTask` override) |
| `STORY_BRANCH`, `EPIC_BRANCH` | yes | Branch names the tracker already assigned | `dispatch-specialist.ts` (`RunTask` override) |
| `MAX_TURNS` | yes | Hard cap on Agent SDK turns — the ledger is explicit a session doesn't time out on its own | `dispatch-specialist.ts` (`RunTask` override) |
| `FRAMEWORK_REPO` | yes | `org/name` on GitHub for the framework (agents/skills) repo | `specialist-sandbox.ts` (task definition) |
| `FRAMEWORK_REF` | yes | Git ref of the framework repo to clone | `specialist-sandbox.ts` (task definition) |

Plus the secrets every container in this project reads the same way (SSM,
injected by the ECS agent — see `infrastructure/README.md`):
`ANTHROPIC_API_KEY`, `LINEAR_AGENT_API_KEY`, `GITHUB_TOKEN`. Optional URL
overrides: `LINEAR_MCP_URL`, `GITHUB_MCP_URL`, `LINEAR_API_URL` (used only by
the fallback-comment path).

`LOG_LEVEL` is set too, but it isn't part of `dispatch-context.ts`'s own
contract above — `src/logger.ts` reads it independently, same as every other
package's logger. `dispatch-specialist.ts` propagates `dispatch-worker`'s own
configured `LOG_LEVEL` (docker-compose locally, the ECS task definition in
prod) down as a container override on every dispatch, so this runner's
verbosity follows the worker that launched it without a second setting to
keep in sync.

## Model and effort — always explicit, never the SDK's own default

`src/claude-config.ts` reads `CLAUDE_MODEL` and `CLAUDE_EFFORT` (validated
against the SDK's own `low`/`medium`/`high`/`xhigh`/`max`) and passes both to
every `query()` call. **Neither has a code-level default** — both go through
`requireEnv`, and an unset one fails the run at startup rather than falling
back. The values come from the `specialist-sandbox.claude-model` /
`.claude-effort` context keys; an earlier version of this paragraph named
defaults that the code has never had.
Deliberately not left unset: an unset `model`/`effort` would silently track
whatever the Agent SDK's CLI default happens to be on a given build, drifting
the specialist's behavior out from under this codebase without a line
changing here. Mirrors `webhook-listener/src/activation-config.ts`'s own
uniform-knobs-are-explicit convention (that module's `effort: "high"` is the
same default, for the same reason).

## A real ambiguity, resolved and flagged

The specialist definition says "you work in a local checkout... run git
directly" (orienting) and "you touch two systems, each through its own MCP:
source control... and the issue tracker" (handing back). Resolved here as:
local git handles clone/checkout/commit/push (needed for real test execution,
and for verifying branch ancestry against actual history — a shallow clone
can't do that, which is why `workspace.ts` uses `--filter=blob:none` for the
surface repo instead of `--depth`). GitHub's MCP server is attached
specifically for **opening the pull request**, the one action local git
without `gh` can't do. Same category of flagged-not-confirmed assumption as
`webhook-listener/src/activation-runner.ts`'s own MCP notes — verify against a
live run.

## Playwright/Chromium support

The image installs Chromium's OS-level shared libraries
(`npx playwright@latest install-deps chromium`) at build time, as root,
before the runtime switch to `USER node` — confirmed missing live
(2026-08-07): a real E2E specialist run tried to sanity-check its
spec locally per `specialist-e2e.md`'s "if you can stand up and exercise the
app locally as you write, do," and chromium/chromium-headless-shell both
failed to launch ("error while loading shared libraries"), with no root
access at runtime to fix it. The browser *binary* itself is deliberately not
baked in — a specialist downloads it fresh per run
(`npx playwright install chromium`) inside whichever surface repo's `e2e/`
project it's actually working in, matching that project's own pinned
`@playwright/test` version rather than whatever was current when this image
was built. Verified for real, not assumed: built the image and, as the
non-root `node` user, installed and launched `chromium-headless-shell`
against a `data:` URL — no crash, where before the fix it failed
immediately.

## Toolchains

The image carries `node`, `python3` + Poetry, and the .NET SDK, plus `git` and
`curl`. Versions are matched to the reference CI workflows rather than chosen
here, and verified in the built image as the runtime `node` user:

| | version | how it is pinned |
|---|---|---|
| Node | 22 | the base image, `node:22-slim` |
| Python | 3.11.2 | the base image's Debian release (bookworm), not an apt pin |
| Poetry | 2.4.3 | `POETRY_VERSION` build arg, installed via `pipx` |
| .NET SDK | 10.0.401 | `DOTNET_CHANNEL` build arg (`10.0`) |

Python and .NET arrived 2026-09-19. Before that the image was Node-only, which
made one of the specialist's own rules unfollowable — the definition says "run
the surface's existing tests, not only your own," and the design ledger's
isolation decision says "unit tests run in this same sandbox," and neither held
on a Python or .NET surface. Observed on a 2026-09-18 run against a Python
surface: the specialist wrote 22 new test cases, could not execute one of them,
and reported that CI was the first execution. On those surfaces "CI is the
independent check on your own green" was false, because there was no green for
it to be independent of.

The two build args exist so an engagement can retarget the image without
editing the Dockerfile. Python is the deliberate exception: it comes from the
base image's Debian release, because an apt pin on top of that installs a
second interpreter and leaves `python3` meaning the wrong one. A surface
needing a different minor is a base-image decision.

### Locked-mode restore

The specialist restores from committed lock files and never resolves fresh
(`agents/specialist.md`, "Do the work"). The three ecosystems do not behave
alike, and the difference is worth knowing before trusting any of them:

| | no lock file | lock present, drifted |
|---|---|---|
| `npm ci` | fails | fails |
| `poetry check --lock` | fails | fails |
| `dotnet restore --locked-mode` | **silently passes** | fails `NU1004` |

Verified in the built image, all six cells. The .NET cell is the trap: with no
`packages.lock.json` the flag restores normally and reports success, so a
solution that carries no lock file gets a check that means nothing. Enabling it
for real needs `RestorePackagesWithLockFile` set in the target repo and the
resulting lock files committed — a change in that repository, not this one.

## Known gaps

- **The toolchain set is engagement-shaped.** Node, Python and .NET are here
  because the surfaces in front of this framework use them. A surface built on
  anything else needs the image extended; the two build args cover a version
  change, not a new ecosystem.
- **No Docker, deliberately, and not coming.** Fargate offers no privileged
  mode and no socket mount, which is why integration and E2E execution live in
  GitHub Actions (design ledger, "Integration and E2E run in GitHub Actions").
  A criterion that needs a running stack cannot be closed in this sandbox at
  any toolchain level — it needs a CI check or a human at a terminal.
- **No sibling-repo reads.** `workspace.ts` clones only `SURFACE_REPO`. A
  full-stack epic's frontend story confirming the real backend contract needs
  the app to know which sibling repos exist for a given epic — nothing does
  yet.

## Working with it

```bash
npm install
npm run typecheck
npm run test:unit
```

```bash
docker build -f Dockerfile .
```

`./smoke-test.sh` builds the image and verifies it against the claims this
file makes about it — the toolchain versions, the unprivileged runtime user,
the continued absence of Docker, and all six locked-restore cells. Local only,
deliberately not in CI: it needs a Docker daemon, and what it guards changes
only when someone edits the Dockerfile. Run it then. `--image <tag>` skips the
build and checks an image already built.

No live run is possible from this repo alone — it needs real credentials and
an actual story/epic/branch chain against a live target repo.
