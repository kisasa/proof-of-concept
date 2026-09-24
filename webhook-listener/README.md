# webhook-listener

An always-on worker implementing the shaping tier — and, as of the
specialist-dispatch lane, the entry point into the development tier — of the
Kisasa AI PM pipeline. See [`../Docs/design-ledger.md`](../Docs/design-ledger.md)
for the design this code follows, and [`../CLAUDE.md`](../CLAUDE.md) for the
current architecture summary. It receives Linear webhooks, routes them to the
lane whose trigger matches, and runs that lane's agent function.

Three lanes (Intake, Specification, Decompose) run an Anthropic activation:
Claude reads and writes the tracker itself during the run, and reads the
product codebase itself for lanes that need it — both via MCP servers
attached to the Anthropic call. This worker declares no tools of its own for
those lanes; its own tracker writes are kept to a "working on it" comment
posted right before opening the Anthropic call, that same comment refreshed
in place every couple of minutes for however long the run actually takes, and
a fail-fast error comment on failure (`src/tracker-notifier.ts`).

The fourth lane, specialist-dispatch, calls no Anthropic activation at all —
it starts a Temporal workflow (`dispatch-worker/`) that dispatches a
specialist against the specialist-sandbox. See "The lanes and their
triggers" below.

```
Linear webhook ──▶ adapters/linear.ts   parse the payload into a TrackerEvent
                         │
                         ▼
                 swim-lane-routing.ts    which lane fires, first pass or follow-up?
                         │
                         ▼
                 agent-scheduler.ts      dedupe deliveries, debounce follow-up bursts
                         │
                         ▼
                 activation-runner.ts    assemble the prompt, attach MCP servers,
                         │                post + refresh "working on it", open the
                         │                stream, error-report
                         ▼
                    Claude ◀──MCP──▶ Linear   (comments, labels, child issues, and the
                         │                     one status move each checkpoint authorized)
                         ▼
                        GitHub   (read-only — Specification and Decompose only)
```

## The lanes and their triggers

Routing matches on **labels and status, not column position** — agents move
labels, humans move statuses. Each lane in `swim-lanes.ts` declares its own
first-pass trigger and the label(s) that mark its thread "awaiting a reply":

| Lane | Entity | First pass fires on | Follow-up fires on |
|---|---|---|---|
| Intake | Project | `ready for intake` applied while status = Backlog | a Project Update ("status update") post while `ready for intake` is present |
| Specification | Issue (epic) | status enters Evaluation **and no** `spec:*` label exists yet | human comment while `spec:awaiting-architect` or `spec:awaiting-designer` is present |
| Decompose | Issue (epic) | `spec:resolved` applied | human comment while `eval:awaiting-answers` or `eval:awaiting-approval` is present |
| specialist-dispatch | Issue (story) | status enters In-Process **and** a `surface:*` label is present | — (no follow-up state; a dispatch either starts or it doesn't) |

Specification's first-pass trigger is the one case gated on label *absence*
rather than presence; specialist-dispatch's is the symmetric case gated on
label *presence* via the same mechanism
(`requireLabelsPresentPrefix`/`requireLabelsAbsentPrefix` in
`swim-lane-routing.ts`) — both epics and stories are Issues sharing one status
workflow, so presence of a `surface:*` label is what tells the router
this is a story, not an epic, entering that status. The self-comment guard
(routing ignores the agent's own comments) applies only to comments — an
agent's own label change is exactly how one lane hands off to the next, and
must never be filtered.

Intake's follow-up is the one case that isn't a comment reply: confirmed
against a live payload (2026-07-16), Linear does not emit a webhook for
comments added to a Project — only Issue/Document comments are webhook-
visible. A Project Update post is the only webhook-visible signal of human
activity on a project, so `adapters/linear.ts` maps it onto the same
`comment_added` event kind Specification/Decompose get from real comments.
This is a webhook-routing workaround only — see "Not yet built" below for
what it doesn't yet cover.

## Run it locally

For the deployed environment — an always-on Fargate service behind a load
balancer, with env vars sourced from SSM — see
[infrastructure/](../infrastructure/README.md). Everything below is local.

To run this service alongside `dispatch-worker`, a local Temporal server,
and a LocalStack-emulated ECS — the whole dispatch loop, not just this one
service — see [`docs/local-development.pdf`](../docs/local-development.pdf)
instead. What follows here is this service in isolation.

```bash
cp .env.example .env   # fill in the required values
npm install
npm run dev
```

Then expose it so Linear can reach it:

```bash
cloudflared tunnel --url http://localhost:8787
```

Put the resulting `https://…/webhooks/linear` URL into a Linear webhook
(Settings → API → Webhooks), subscribed to Issues, Projects, and Comments.

There is currently no local emulator or e2e harness — the previous one drove
the pre-MCP write path (queued GraphQL/REST responses matching exact
`TrackerApiClient` call sequences) and couldn't emulate Claude's own MCP calls
to Linear, which happen server-side between Anthropic and Linear and are
invisible to a local HTTP mock. `npm run test:unit` covers routing, the
scheduler, and the adapter's payload parsing.

### Standing the pipeline up incrementally

Rather than pointing straight at a real Linear workspace and a real Anthropic
key, `TEST_STAGE` lets you verify one rung at a time, with `LOG_LEVEL=trace`
on so each rung's decisions are visible:

1. `TEST_STAGE=accept` — POST a webhook payload and confirm it's verified,
   deduped, and parsed correctly. The response echoes the parsed event; the
   trace log shows signature check → dedupe → parse. Stops before routing.
2. *(next rung, not yet wired up)* — stop after the routing decision, before
   dispatch, to confirm the right lane and pass get picked.
3. *(next rung, not yet wired up)* — stop after an activation's prompt is
   assembled, before the Anthropic call, to review exactly what would be sent.

Unset `TEST_STAGE` (or any other value) runs the full pipeline.

## Logging

Every module logs through `createLogger(scope)` (`src/logger.ts`) instead of
calling `console.*` directly, so output is consistently `[scope] message` and
verbosity is controlled by one env var, `LOG_LEVEL` — `trace` < `debug` <
`info` < `warn` < `error`, default `info`.

- `info` is what you want for normal operation: webhook fires, activation
  starts, startup banner.
- `debug` adds per-run token counts and routine "no-fire" routing decisions —
  noteworthy, but too noisy to keep on by default.
- `trace` is the full play-by-play: every decision and move in one webhook
  delivery and whatever activation it causes — signature check, dedupe,
  parsed event fields, the routing match, the debounce decision (including a
  coalesce or supersession), prompt assembly, which MCP servers got attached,
  the raw Anthropic response shape, and the error-detection outcome.
- `warn`/`error` narrow further to problems.

Every delivery gets a short correlation id (`src/trace-id.ts`), carried via
`Logger.child(traceId)` from the moment the webhook lands all the way into
the activation it eventually causes — even across the debounce boundary,
where the id that survives is whichever reply last reset the timer. Set
`LOG_LEVEL=trace` and grep one id (e.g. `[decompose:a1b2c3d4]`) to reconstruct
one request's entire path through the system.

## Files

| File | Role |
|---|---|
| `src/server.ts` | HTTP endpoint: verify signature, dedupe, route, dispatch |
| `src/adapters/linear.ts` | The only file that knows Linear's payload shape; produces `TrackerEvent`s |
| `src/tracker-event.ts` | The tracker-agnostic event contract adapters produce |
| `src/swim-lane-routing.ts` | Pure function: event + lane registry → fire decision |
| `src/swim-lanes.ts` | The lane registry — trigger rules paired with each lane's agent function |
| `src/agent-scheduler.ts` | In-memory dedupe + per-entity debounce |
| `src/agent-lane.ts` | The `AgentLaneConfig` shape every lane's config satisfies |
| `src/lanes/{intake,specification,decompose}.ts` | Per-lane identity: agent file, skills, codebase access, templates, placeholders |
| `src/lanes/specialist-dispatch.ts` | The one lane exporting a plain `LaneConfig` directly (not `AgentLaneConfig`) — its `agent` starts a Temporal workflow, not an activation |
| `src/dispatch-trigger.ts` | Gathers a story's dispatch context, starts `dispatchStoryWorkflow` on `dispatch-worker`'s task queue, posts an error comment and moves the story back to Todo on a malformed story or a start failure — the workflow never gets a chance to run its own equivalent for either case |
| `src/story-context.ts` | Reads a story's `branchName`, `surface:<name>` label(s), and parent epic (`id`/`branchName`) from Linear directly — this lane's own small GraphQL client, same pattern as `tracker-notifier.ts`. `parseSurfaces` extracts every `surface:`-prefixed label (a story may carry more than one); the surface vocabulary itself is open, so whether the epic actually recognizes a given surface is `dispatch-worker`'s `resolveRepoBase` to catch, not this parse |
| `src/move-story-to-todo.ts` | Best-effort: moves a story back to To-Do when `dispatch-trigger.ts` can't proceed, before any workflow starts — mirrors `dispatch-worker/src/activities/move-story-to-todo.ts`, no shared lib between the two packages |
| `src/temporal-client.ts` | This process's `@temporalio/client` connection for *starting* workflows — distinct from `dispatch-worker`'s own `NativeConnection`, which executes them |
| `src/prompt-assembly.ts` + `src/prompt-templates/*.md` | Template lookup, placeholder substitution, system-block assembly |
| `src/activation-runner.ts` | Generic runner: assembles the prompt, attaches the Linear MCP server (+ GitHub's for codebase-access lanes), posts + refreshes "working on it", makes the Anthropic call (resuming past a paused server-side MCP tool-call loop, up to `maxPauseContinuations`), error-reports |
| `src/activation-config.ts` | Shared token/content/timing limits, effort, and the pause-continuation cap |
| `src/tracker-notifier.ts` | The app's own tracker writes, kept small: post/refresh the "working on it" comment (states when it'll time out, plus a one-line patience quip), and the fail-fast error comment |
| `src/skills.ts` | Resolves skill names to `skills/<name>/<name>.md` |
| `src/logger.ts` | Scoped, leveled logging (`LOG_LEVEL`) — every module logs through this instead of `console.*` directly |
| `src/trace-id.ts` | Mints the per-delivery correlation id threaded through `Logger.child()` |
| `src/env.ts` | `envOr(name, fallback)` — treats an env var present but empty (the `.env.example` default shape) the same as unset |

## State

Canonical state lives in **Linear** — statuses, and the `ready for intake` /
`spec:*` / `eval:*` labels. The worker holds only ephemeral state in memory:
webhook dedupe and per-entity debounce timers. Safe at one instance; back
those two maps with a shared store if you need multi-instance or
crash-survival — the function signatures in `agent-scheduler.ts` don't change.

## Not yet built

- **A second issue tracker.** The write path is Linear-specific (MCP) — a
  Jira or GitHub Issues adapter would need its own MCP server to reach the
  same architecture, not just a webhook parser. (GitHub is already wired in,
  but only as the read-only codebase MCP server for Specification/Decompose —
  that's a different role from GitHub Issues as a tracker.)
- **A local e2e harness** that can exercise Claude's MCP calls, not just the
  webhook-to-dispatch path.
- **`intake-agent.md` reading Project Updates.** The webhook-routing fix above
  only gets Intake's follow-up activation to fire — it doesn't change what
  Claude reads once it runs. `intake-agent.md` currently describes its input
  as "the project's comment thread" and instructs Claude to post its own
  checkpoint as a comment; a PM's reply now lands as a Project Update
  ("status update"), a Linear object comments-reading tools don't surface.
  Until the agent's own instructions are updated to also read status updates
  (the Linear MCP server exposes `get_status_updates`), Intake's follow-up
  pass may run without ever seeing what the PM actually said.

Note: `../Docs/for-pms/` and `../Docs/for-engineers/` describe an earlier,
CI-Actions-and-channel-adapter-based design (a single "Evaluation Agent," a
GitHub Actions dispatch model, multi-channel Intake) that predates the
Intake/Specification/Decompose split this worker implements and was never
built as described. Treat `../Docs/design-ledger.md` as authoritative over
those files until they're reconciled.
