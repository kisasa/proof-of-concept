# dispatch-worker

Hosts the Temporal workflow that dispatches a story to a specialist. Runs
inside the `temporal-workers` ECS service [`infrastructure/`](../infrastructure)
registers, and launches the `specialist-sandbox` stack's task definition
([`infrastructure/README.md`](../infrastructure/README.md)) once per
specialist run. The caller is `webhook-listener`'s specialist-dispatch lane.

Covers the full "dispatch → wait for the specialist → trigger CI → wait for
the result → gate on human review → proceed" chain for one story. "Trigger
CI" needs no code of its own — it already runs automatically once the
specialist opens a PR; "wait for the result" and "gate on human review" are
collapsed into one long-poll activity (see step 7 below) rather than two,
since a red CI check isn't a terminal state either (a human can push a fix
and CI goes green later) — the only two states that actually end a story's
dispatch are merged and closed-without-merging.

## What it does

`workflows/dispatch-story-workflow.ts`, one workflow execution per story:

1. **Check dependencies** — reads the story's "Blocking dependencies" section
   (tightened format, see below) and confirms every named blocker is Done via
   Linear. Not ready → posts a comment naming which blocker isn't done, moves
   the story back to Todo, and returns `{ outcome: "not-ready" }`. No
   `dispatch:blocked` label yet — see "What this does NOT do".
2. **Resolve the surfaces** — reads the surface registry (the project's
   `Surfaces` document, with the epic's `Surfaces (override)` document
   layered on top), finds each of the story's surfaces, and requires them to
   share one repo and ref. Also yields each surface's directory and
   mandatory skills for the specialist.
3. **Create the story branch** — mechanical: reads the epic branch's current
   commit sha via the GitHub API, creates the story branch ref from it. If
   the epic branch doesn't exist yet (the first dispatch under an epic), it
   is created first, from the head of the surface's registry `ref`. An
   existing epic branch is never moved.
   Idempotent (a retried attempt against an already-created branch is not an
   error); never rebases or re-parents an existing branch. An existing story
   branch that already carries commits the epic branch does not have — work
   from an earlier, abandoned attempt — is refused rather than built on; the
   failure names the `git push origin --delete` that clears it.
4. **Dispatch the specialist** — `ecs:RunTask` against the specialist-sandbox
   task definition, container overrides matching
   [`specialist-runner`](../specialist-runner)'s documented
   `dispatch-context.ts` contract, plus this worker's own `LOG_LEVEL`
   propagated down as one more override — the specialist's verbosity follows
   whatever this worker was configured with, no separate setting to keep in
   sync.
5. **Wait for it** — polls the ECS task until it stops (long-running
   activity, heartbeats every poll — a specialist run can take a long time).
6. **Check for a PR — this is the outcome check.** Mechanically, via GitHub's
   own head/base filter, not a label and not the specialist's free-prose "PR
   & branch" completion-report line: a PR's existence *is* the outcome.
   Checks `open` first, then the single most recent `closed` PR for the same
   pair, trusting it only if it was actually merged — a merge that happened
   faster than this check must still read as complete, not "no-pr". No
   matching PR at all → moves the story back to Todo and returns
   `{ outcome: "no-pr" }` — waiting on a dependency, blocked, still thinking,
   or crashed all look the same to this workflow; the specialist's own
   comment on the story is the record of which one it was.
7. **Request the reviewer, then watch the PR** — requests the
   reviewer-of-record (below) and polls the PR (re-reading its current head
   sha every poll, so a force-push can't leave it tracking a stale commit),
   heartbeating a CI/status summary each poll, until it is merged, closed
   without merging, or the reviewer-of-record submits a new "request
   changes" review. Merged or closed posts the final "PR merged" / "PR closed
   without merging" comment on the story and returns
   `{ outcome: "complete" }`; closed also moves the story back to Todo. A
   change request starts a revision round (below), then watching resumes.

## Revision rounds

When the reviewer-of-record requests changes, the workflow re-dispatches the
specialist on the same story branch and PR, with `REVISION_ROUND`,
`REVISION_ROUND_CAP`, `PULL_REQUEST_NUMBER`, and `REVIEW_ID` added to its
container overrides and its own, smaller turn budget (`REVISION_MAX_TURNS`,
25). The review's text is not passed; the specialist reads it from the PR.

- The trigger is a review newer than the last one acted on, never the
  review state: a "changes requested" decision stays on the PR until the
  reviewer clears it, so keying on the state would re-fire every poll.
- Rounds are capped at `REVISION_ROUND_CAP` (3). Reaching the cap is read as
  evidence the story was mis-shaped. Once it is spent the workflow says so
  on the PR and only watches for merged or closed.
- The workflow posts a notice on the PR when a round starts, edits it when
  the round finishes, and posts one when a round fails
  (`workflows/revision-notices.ts`). What the specialist changed is its own
  reply on the PR, not the workflow's.
- Change requests are detected on the same poll, not by GitHub webhook: the
  workflow is already fetching this PR, and a webhook delivered while the
  single-task listener is redeploying would be dropped silently.

Changing either constant changes workflow control flow; treat a change as a
versioned one (`patched()`) if any dispatch is live.

## Two tightened content formats — why they exist

Two pieces of data this workflow reads mechanically are held to a strict
format so a mechanical reader can trust them:

- **Blocking dependencies** (`skills/story-contract/SKILL.md`): each blocker
  is its own line with the blocker's bare identifier as the first token
  (`- PROJ-42 — <title>`; the bullet marker is optional), so
  `activities/check-dependencies.ts` can extract it without depending on any
  particular wording after it.
- **Surface registry** (`agents/intake-agent.md` proposes it,
  `agents/specification-agent.md` corrects it): where each surface lives is
  recorded as a fenced `surfaces` block in a Linear document — the project's
  `Surfaces`, optionally overridden per epic by `Surfaces (override)` —
  written by the agents, never typed by a human.
  `activities/surface-registry.ts` parses and merges it;
  `activities/resolve-surfaces.ts` reads the documents and resolves a
  story's surfaces. A malformed record is a bug to report, not a typo to
  work around.

## Env vars

| Var | Wired into infra today? | Meaning |
|---|---|---|
| `TEMPORAL_HOST`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_API_KEY` | yes | Connection to the namespace `infrastructure/constructs/temporal-namespace.ts` creates. `TEMPORAL_API_KEY` is optional locally (a local dev server has no namespace auth) |
| `TEMPORAL_TLS` | no (optional) | Defaults true; the literal `false` turns TLS off, for a local dev server only |
| `SPECIALIST_CLUSTER_ARN` | yes | From `specialist-sandbox`'s `clusterArn` output |
| `SPECIALIST_TASK_DEFINITION_ARN` | yes | From `specialist-sandbox`'s `taskDefinitionArn` output |
| `SPECIALIST_CONTAINER_NAME` | yes | From `specialist-sandbox`'s `taskDefinitionFamily` output — identical to the container name by construction (`specialist-task.ts` derives both from `formatName(config.name)`) |
| `SPECIALIST_SECURITY_GROUP_ID` | yes | From `specialist-sandbox`'s `securityGroupId` output |
| `SPECIALIST_SUBNET_IDS` | yes | Comma-separated (via Terraform's own `Fn.join`, not a JS-side join — see `stacks/temporal-workers.ts`); from `network`'s `publicSubnetIds` output |
| `GITHUB_TOKEN`, `LINEAR_AGENT_API_KEY` | yes (already in `temporal.parameter-prefix`) | Same secrets, same mechanism as every other container in this project |
| `REVIEWER_EMAIL_TO_GITHUB_LOGIN` | yes (from the deployment config) | Reviewer-of-record's static Linear-email -> GitHub-login table, JSON object string. Optional; unset or missing an entry skips the reviewer request for that dispatch — see `activities/request-pull-request-reviewer.ts` |
| `LINEAR_API_URL` | no (optional) | Default `https://api.linear.app/graphql` |
| `LOG_LEVEL` | no (optional) | `trace` / `debug` / `info` / `warn` / `error`, default `info`; also passed down to the specialist container |

All five `SPECIALIST_*` vars are wired into
`infrastructure/stacks/temporal-workers.ts`'s container environment, and the
worker's task role carries the matching `ecs:RunTask`/`ecs:DescribeTasks`/
`iam:PassRole` permission (see `constructs/temporal-worker-service.ts`'s
`dispatchTarget` config). The caller is
`webhook-listener/src/dispatch-trigger.ts`'s `specialist-dispatch` lane,
which calls `client.workflow.start("dispatchStoryWorkflow", ...)` when a
story enters `In Progress` — see `webhook-listener/README.md`'s own lane
table.

## Reviewer-of-record

`dispatchStoryWorkflow`'s input carries `mover` — the tracker actor
`webhook-listener` read off the very webhook that moved the story to
`In Progress` (Linear's own `actor` field, present on every event kind, not
just comments). Once `findPullRequest` locates the specialist's PR,
`requestPullRequestReviewer` resolves `mover.email` through
`REVIEWER_EMAIL_TO_GITHUB_LOGIN` and requests that login as a GitHub
reviewer — so the person who dispatched the story is the one who reviews it.
Only that reviewer's change requests start revision rounds.

Deliberately best-effort, unlike every other activity in this package: a null
`mover`, a missing mapping entry, or a GitHub error here never fails the
workflow — the PR already exists and a human is already going to review it
regardless of whether this metadata landed, so the activity only ever logs
and returns. When no reviewer login resolves, the workflow posts a notice on
the PR saying so, since an unmapped reviewer silently disables revision
rounds.

## Never silent — `dispatchStoryWorkflow`'s own catch-all

`dispatchStoryWorkflow`'s entire body is wrapped in one try/catch, so no
activity has to decide for itself whether to post a comment on failure. Any
unhandled failure — anticipated or not — calls `postDispatchFailed` once,
naming the real cause, posts a PR notice if at least one revision round had
started, moves the story back to Todo, then re-throws so Temporal still records the
workflow as failed. Without it, a failure no activity had written a comment
for would be discoverable only by querying Temporal directly.

`describeFailure` (`workflows/describe-failure.ts`) unwraps Temporal's own
activity-failure wrapping — the workflow only ever sees a generic "Activity
task failed" on the top-level caught error; the activity's real message
lives one level down, on `.cause` — so the posted comment says the same
specific thing a developer reading the raw Event History would see.

## Moving back to Todo — the next step is always the developer's

Every path through `dispatchStoryWorkflow` that ends without a specialist
actively running or a PR left open to watch — dependencies not ready
(`checkDependencies`), no PR after the specialist's run, a PR closed without
merging, or the catch-all failure above — also calls `moveStoryToTodo`.
Status is the human dispatch act: a workflow that can't proceed hands the
next move back to a developer rather than leaving a story sitting in
"In Progress" as if work were still happening.

`moveStoryToTodo` (`activities/move-story-to-todo.ts`) is best-effort like
every other courtesy activity here: it resolves the story's team's "Todo"
status by name (`findStateIdByName`/`updateIssueState` in `tracker.ts` —
state ids are per-team, so this is a two-step lookup, not a literal), and a
missing/renamed status or a Linear error is logged and swallowed rather than
failing the dispatch outcome it's just trying to reflect. "Todo" is Linear's
stock state name — tracker configuration in the same category as
`specialist-dispatch.ts`'s own "In Progress".

## Specialist-progress comment

The shaping tier's own courtesy comment (`webhook-listener/src/
tracker-notifier.ts` — "working on this," edited every couple of minutes,
deleted on a clean run) extended to the specialist tier:
`postSpecialistStarted` posts once the specialist container is dispatched,
`awaitSpecialistTask` edits it in place every ~2 minutes with an elapsed-time
line while it polls, and `deleteSpecialistProgressComment` removes it once
the container exits — all before the PR check that follows, so this courtesy
comment is gone by the time the specialist's own completion report is the
only thing left narrating what happened. Without it a story could sit
In Progress for up to four hours with nothing visible on the tracker at all.
Revision rounds get the same comment.

Same best-effort discipline as reviewer-of-record above: none of the three
ever throw. A failure to post/update/delete this comment must never fail an
otherwise-successful dispatch. Left on the tracker (not deleted) whenever
`dispatchSpecialist` or `awaitSpecialistTask` itself fails — the same "leave
it as a trace of how long the run ran" rule tracker-notifier.ts follows.

## What this does NOT do

- **Does not advance the story's Linear status to Done on merge.** Status is
  human-moved, always — this workflow doesn't relax that for a
  seemingly-mechanical case. Its own job ends at "merged"; a human still has
  to move the story to Done, the same way `check-dependencies.ts`'s
  `stateType !== "completed"` check already expects for every *other* story
  that depends on this one. A real, load-bearing consequence of that
  invariant, not a bug: a dependent story's own dispatch waits until a human
  notices the merge and moves the status.
- No `dispatch:blocked` label — `check-dependencies.ts` posts a comment
  naming the incomplete blocker, but doesn't apply the label, since Linear's
  label-write API replaces an issue's entire label set and applying one
  correctly needs its current labels read first — a small subsystem not
  built for the marginal gain over a comment.
- Only `github` is a supported repo-base host — see
  `activities/create-story-branch.ts`.
- No epic-level orchestration (merging the epic branch, the demo gate, the
  verdict) — this is the per-story loop only. Everything above a story is a
  human procedure for now.

## Production bundling — `workflowBundle`, not `workflowsPath`

`workflowsPath` (bundling the workflow with webpack at Worker startup) is
fine for local development but the wrong choice for production per the
Temporal TypeScript SDK's own guidance — it's slow and repeats every time the
container starts. `scripts/build-workflow-bundle.mjs` pre-builds
`dist/workflow-bundle.js` once (the Dockerfile runs it at image build time,
not container start); `worker.ts` prefers that bundle when present and falls
back to `workflowsPath` only when running straight from source without a
build step.

## Testing

`workflows/dispatch-story-workflow.test.ts` runs the real workflow code
against a real (local, in-memory) Temporal test server —
`TestWorkflowEnvironment.createLocal()` plus a `Worker` with every activity
mocked — not just unit tests of the activities' own pure helper functions.
Covers the not-ready short-circuit, the no-PR short-circuit, the full
sequence ending in a merged PR (asserting both the returned result and the
exact call order), the catch-all failure path, a PR closed without merging,
a revision round, the round cap, and the unmapped-reviewer notice.
`createLocal()` over `createTimeSkipping()`: this workflow has no
workflow-level timers to skip through (the only sleeps live inside
`awaitSpecialistTask`'s and `awaitPullRequestOutcome`'s activity code,
invisible to the workflow sandbox), so time-skipping buys nothing here.

`activities/await-specialist-task.test.ts` and
`activities/await-pull-request-outcome.test.ts` test the two activities that
call `heartbeat()`/`sleep()` from `@temporalio/activity` — both need a real
Activity Context to do anything (heartbeat emits an event only a Context
provides; `sleep()` is cancellation-aware and needs one to reject through).
Uses `@temporalio/testing`'s `MockActivityEnvironment`: `env.run(fn,
...args)` runs `fn` inside a real Context, `env.on('heartbeat', ...)`
observes heartbeat calls, `env.cancel()` drives cancellation. Both cover
polling to their terminal state with the right heartbeat sequence, resolving
immediately when already terminal, and mid-poll cancellation actually
rejecting the activity; `await-pull-request-outcome.test.ts` additionally
confirms a failing CI conclusion on an intermediate poll doesn't end the
loop. Each activity takes its own lookup as an injected function
(`DescribeTaskStatus` / `GetPullRequestState`) rather than constructing a
client internally, specifically so tests can substitute a fake one — same
"explicit parameter, not read internally" discipline
`create-story-branch.ts` already uses for its GitHub token.

`activities/find-pull-request.test.ts` tests `pickPullRequest` and
`pickMergedPullRequest` only — the pure selection logic, not the fetch call
around it, same "parse/select is pure and tested, the IO wrapper isn't"
split `parseBlockingDependencyIds` and the surface-registry parser follow.

Retry classification also matters, and isn't left to defaults everywhere:
`resolveSurfaces`'s setup failures (a missing or inactive surface, a
repo/ref mismatch, a malformed registry), `createStoryBranch`'s permanent
failures (an unsupported host, a 4xx from GitHub, abandoned work on the
branch), and a 4xx from `findPullRequest`'s PR listing throw
`ApplicationFailure.nonRetryable` rather than a plain `Error` — Temporal's
default retry policy is generous (up to 100 attempts), and retrying a config
problem would just repeat the same failure. The quick activities also get a
domain-specific `retry: { maximumAttempts: 3 }` in the workflow's
`proxyActivities` call, so a persistent failure against Linear/GitHub/AWS
surfaces as a failed workflow rather than hammering those APIs for hours.
`awaitPullRequestOutcome` gets its own, much longer `startToCloseTimeout`
(14 days, vs. `awaitSpecialistTask`'s 12 hours) — a PR can sit unreviewed for
days in a way an ECS task never sits unfinished.

## Working with it

```bash
npm install
npm run typecheck
npm run test:unit
```

```bash
npm run build:bundle       # writes dist/workflow-bundle.js
docker build -f Dockerfile .
```

No live workflow execution against real Temporal Cloud is possible from
this repo alone — that needs real credentials and a real story/epic/branch
chain against live tracker and GitHub state. The workflow tests above are
real Temporal execution, just against a local test server and mocked
activities. A real (if local) end-to-end run — this worker, a local
Temporal server, and a real `ecs:RunTask` call against LocalStack that
actually launches a `specialist-runner` container — is possible via the
repo-root `docker-compose.yml`; see
["Running locally"](../README.md#running-locally) in the root README.
