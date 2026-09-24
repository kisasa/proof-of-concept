# infrastructure

The AWS infrastructure that runs [webhook-listener](../webhook-listener/README.md) as a long-lived
service, defined in TypeScript with [CDK Terrain](https://cdktn.io/docs) (CDKTN).

Four stacks, each with its own state file:

| Stack | State key | What it holds |
|---|---|---|
| `network` | `network.tfstate` | VPC, internet gateway, two public subnets, route table |
| `listener` | `listener.tfstate` | ACM certificate, load balancer, DNS record, ECS cluster, task definition, service, IAM roles, log group |
| `specialist-sandbox` | `specialist-sandbox.tfstate` | ECS cluster, Fargate task definition (no service), security group, IAM roles, log group |
| `temporal-workers` | `temporal-workers.tfstate` | Temporal Cloud namespace + service account + API key, PrivateLink (VPC endpoint, private hosted zone), ECS cluster, Fargate service, IAM roles, log group |

The split follows rate of change: the network never changes, while the other three stacks are re-applied
every time an image tag moves. All three read the network's outputs through S3 remote state.

## Specialist sandbox — a task definition, not a service

`specialist-sandbox` registers a Fargate task definition meant for on-demand `ecs:RunTask`, one task per
story dispatch, as many concurrent as there are stories being worked. It is not an `EcsService`: nothing
in this stack launches a task, sets a desired count, or registers with a load balancer. That's the job of
the Temporal-based orchestrator (`temporal-workers`), which reads this stack's outputs (cluster arn, task
definition arn/family, role arns) via remote state — the same way `listener.ts` reads `network`'s — and
calls `RunTask` itself, from `dispatch-worker/src/activities/dispatch-specialist.ts`.

It gets its own ECS cluster, separate from the listener's, so that `RunTask`/`PassRole` IAM scoping for
that orchestrator never has to reach into anything touching the always-on listener service. The
security group carries no ingress rules at all: nothing connects to this task over the network (`RunTask`
is an AWS API call, not a network request), so there's nothing to accept a connection from.

Two things this stack does not yet do, both recorded in Known gaps below rather than built speculatively:
egress is unrestricted rather than allowlisted, and its secrets are read directly from SSM rather than
through a credential-injection proxy.

## Temporal workers — a service, and why PrivateLink

`temporal-workers` registers the Temporal Cloud namespace the automated-dispatch design sequences
dispatch → wait-for-specialist → CI → human-review-gate through, plus an always-on ECS Fargate **service**
running the worker that polls it — unlike the specialist sandbox, this is a service, not a bare task
definition, because a Temporal worker is a long-lived poller, not a one-shot dispatch target. It is not
pinned to a single task the way the listener is: Temporal workers are safely concurrent pollers with no
in-process shared state to split, so `desired_count` is a plain config value, not an asserted `1`.

Namespace traffic reaches Temporal Cloud over **PrivateLink** (an Interface VPC Endpoint plus a private
Route53 zone for `tmprl.cloud`), not Temporal Cloud's public endpoint — chosen because PrivateLink doesn't
need a NAT gateway, so it layers onto the existing public-subnet-only `network` stack without reopening
the no-NAT decision made there, at a modest fixed cost. The pattern is ported from the reference CDKTF project
project's `CloudPrivateLink`/`NamespaceWithApikey` constructs.

**One deliberate exception to this project's secrets discipline lives here.** Everywhere else, Terraform
only ever holds an SSM parameter's ARN — the value itself reaches a container at task start, never synth.
The `temporalcloud` Terraform provider can't work that way: it authenticates with an admin API key that
has to be a real string at synth time, so that one value (read from this deployment's own out-of-band SSM
parameter, `${parameter-prefix}temporal-admin/API_KEY`) does reach Terraform state. The namespace's own generated worker API
key has the same shape: the `temporalcloud` provider hands back a token as a resource attribute, not
something already living in SSM, so `temporal-workers.ts` writes it into a new SSM parameter itself before
handing it to the worker service the normal ARN-based way. Both are recorded in Known gaps, not hidden.

**The worker application code, and the wiring to dispatch against `specialist-sandbox`, both exist now** —
[`dispatch-worker/`](../dispatch-worker) is the Temporal workflow/activities/worker; this stack passes it
the `SPECIALIST_*` env vars it needs and grants its task role the `ecs:RunTask`/`ecs:DescribeTasks`/
`iam:PassRole` permission to actually dispatch (see `constructs/temporal-worker-service.ts`'s
`dispatchTarget` config). The trigger exists too, on the app side rather than in this stack:
`webhook-listener`'s `specialist-dispatch` lane (`src/lanes/specialist-dispatch.ts`, `src/dispatch-
trigger.ts`) calls `WorkflowClient.start(dispatchStoryWorkflow, ...)` when a story enters `In Progress` —
see that package's own README. What's still open: neither `specialist-sandbox` nor `temporal-workers` has
ever had a real image built and deployed — `cdktf.json`'s `image-tag` is still the `REPLACE_ME` placeholder
for both, since the CI workflows that push a real one only trigger on a merge to `main`.

## Why a Fargate service, and why exactly one task

Three properties of the listener drive every significant choice here.

**Its state is in memory, on purpose.** The dedupe set and the debounce timers live in the process
([`agent-scheduler.ts`](../webhook-listener/src/agent-scheduler.ts)). A second instance would split
that state and produce duplicate agent runs, so the service is pinned to `desired_count = 1` with no
autoscaling target at all, and the deployment configuration (minimum healthy 0, maximum 100 percent)
stops the old task before starting the new one so the two never overlap.

**Work continues long after the HTTP response returns.** The webhook handler dispatches and returns
immediately; the activation itself can run for 30 minutes. That rules out Lambda (15-minute ceiling)
and App Runner (which suspends the instance between requests unless always-on is paid for, freezing
a mid-flight activation). An always-on Fargate task is the shape that fits.

**Inbound is trivial, outbound is everything.** A handful of webhooks a day arrive; the task talks
constantly to the Anthropic API, the tracker's API and MCP endpoint, and the GitHub MCP endpoint.

## Prerequisites

These are not managed here — each one either has to exist before Terraform runs, or is created by a
process outside it.

| Thing | Why it is not in a stack |
|---|---|
| S3 state bucket, versioned | Cannot live in the state it holds. `scripts/new-deployment.py` offers to create it |
| Route53 hosted zone for the domain | Usually predates the project; the certificate and DNS record attach to it |
| ECR repository (listener) | The image must exist before a task can start from it, and CI pushes it independently of any Terraform run — see [`build-and-push-webhook-listener-ecr.yml`](../.github/workflows/build-and-push-webhook-listener-ecr.yml), which creates the repository idempotently. Read here as a data source. |
| ECR repository (specialist sandbox) | Same posture as the listener's — the application code, Dockerfile, and CI workflow now exist ([`specialist-runner/`](../specialist-runner), [`build-and-push-specialist-ecr.yml`](../.github/workflows/build-and-push-specialist-ecr.yml)), so this repository gets created and populated the same idempotent way the listener's is. `specialist-sandbox` still won't apply until the first merge to `main` under `specialist-runner/` actually runs that workflow. |
| The listener's SSM parameters | See below — keeping creation out-of-band is what keeps secret values out of state |
| The specialist sandbox's SSM parameters | Same mechanism, same shared `parameter-prefix` as every other stack — see below |
| ECR repository (Temporal worker) | Same posture as the other two — the application code, Dockerfile, and CI workflow now exist ([`dispatch-worker/`](../dispatch-worker), [`build-and-push-dispatch-worker-ecr.yml`](../.github/workflows/build-and-push-dispatch-worker-ecr.yml)). `temporal-workers` still won't apply until the first merge to `main` under `dispatch-worker/` actually runs that workflow. |
| The temporal-workers stack's SSM parameters | Same mechanism, same shared `parameter-prefix` |
| A Temporal Cloud account, and an admin API key per deployment | Out-of-band, same category as the AWS account itself — the `temporalcloud` provider creates namespaces *within* an existing account, it doesn't create the account. Each deployment's own admin key goes in an SSM parameter under that deployment's prefix (`/example/prod/temporal-admin/API_KEY`), read directly (not by ARN) at synth — see the Temporal workers section above and Known gaps |
| The `temporalcloud` provider's generated bindings | No prebuilt `@cdktn/provider-temporalcloud` package exists — run `npx cdktn get` locally (needs Terraform on PATH) before this stack will typecheck or synth. See Known gaps |
| An AWS profile named in `aws.profile` | |
| Terraform or OpenTofu **>= 1.10** on PATH | Required for S3-native state locking (`use_lockfile`), which is why there is no DynamoDB lock table |

Terraform behaves best on Linux; WSL with Ubuntu works well on Windows. Keep line endings `LF`.

### Creating the SSM parameters

Terraform reads only these parameters' ARNs and grants the task execution role permission to fetch
them. No secret value ever enters the synthesized JSON or the state file. Create them once per
environment, matching the deployment's shared `parameter-prefix`.

Standing up a *further* deployment against the same credentials does not mean retyping these:
`scripts/new-deployment.py` offers to copy everything under the previous deployment's prefix into
the new one, skipping `TEMPORAL_API_KEY` (written per apply by the `temporal-workers` stack) and any
name already set on the target. For the first deployment, or for a value that genuinely differs:

```bash
PREFIX=/example/prod
PROFILE=kisasa
for name in LINEAR_WEBHOOK_SECRET LINEAR_AGENT_API_KEY ANTHROPIC_API_KEY GITHUB_TOKEN; do
  read -rsp "$name: " value; echo
  aws ssm put-parameter --region "us-east-1" --profile "$PROFILE" --name "$PREFIX/$name" --type SecureString --value "$value" --overwrite
done
```

`AGENT_USER_ID` is not sensitive but is provisioned the same way, so that standing up the service's
credentials is one step rather than two:

```bash
aws ssm put-parameter --region "us-east-1" --profile example --name /example/prod/AGENT_USER_ID --type String --value "<bot user id>" --overwrite
```

Rotating any of these is a `put-parameter` followed by forcing a new deployment — the value is read
at task start, so Terraform has nothing to re-apply:

```bash
aws ecs update-service --region "us-east-1" --profile example --cluster example-prod --service webhook-listener-prod-svc --force-new-deployment
```

### The specialist sandbox and Temporal workers reuse the listener's parameters

All three stacks now read from one shared `parameter-prefix`, and `specialist-sandbox`'s three secret
names (`ANTHROPIC_API_KEY`, `LINEAR_AGENT_API_KEY`, `GITHUB_TOKEN`) and `temporal-workers`'s two
(`LINEAR_AGENT_API_KEY`, `GITHUB_TOKEN`) are each an exact subset of the listener's own five — so the
"Creating the SSM parameters" step above already provisions everything both stacks need. There is no
separate provisioning step for either, and no separate credential per stack: a specialist run and the
listener now read the identical `ANTHROPIC_API_KEY` value, not distinct ones.

### Creating the Temporal admin API key parameter

Read directly by the `temporalcloud` provider at synth, not by ARN — the one place in this project a
secret value legitimately reaches Terraform state (see the Temporal workers section above).

It lives **under** the shared `parameter-prefix`, at `${parameter-prefix}temporal-admin/API_KEY`, and
is issued fresh per deployment like any other credential here. This paragraph previously claimed the
opposite — that it was one account-level key read from a fixed path regardless of which deployment was
synthesizing — which `temporal-workers.ts` never did; it has always interpolated the prefix. The
nesting is the only thing that distinguishes it from the flat names beside it, and that is a grouping,
not a different lifetime. `scripts/new-deployment.py` treats it accordingly: it is one of the
credentials the script asks you to type rather than copying across from the previous deployment.

```bash
read -rsp "Temporal Cloud admin API key: " value; echo
aws ssm put-parameter --region "us-east-1" --profile example --name /example/prod/temporal-admin/API_KEY --type SecureString --value "$value" --overwrite
```

The namespace's own generated worker API key is different: `temporal-workers.ts` writes it into SSM
itself (under the shared `parameter-prefix`, as `TEMPORAL_API_KEY`), generated fresh each apply from the
`temporalcloud` provider's `Apikey` resource, then read back by both `temporal-workers.ts` and
`listener.ts` — see the pattern above.

### Generating the `temporalcloud` provider bindings

No prebuilt `@cdktn/provider-temporalcloud` npm package exists (confirmed via `npm view`) — unlike
`@cdktn/provider-aws`, this one has to be generated locally, once, before `temporal-workers.ts` will
typecheck or synth:

```bash
npx cdktn get
```

This shells out to the Terraform CLI to introspect the provider schema, so it needs Terraform or OpenTofu
on PATH (already a prerequisite above). The generated code lands in `.gen/providers/temporalcloud/` and is
gitignored, same as `cdktn.out/` — regenerate it after a fresh clone, same as `npm install`.

## Configuration

**`cdktf.json` is not in the repository.** It carries one deployment's identity — AWS account,
state bucket, domain, hosted zone, SSM prefix, reviewer table — which is engagement-specific, not
framework material, so it is gitignored. Start from the committed template:

```bash
cp infrastructure/cdktf.example.json infrastructure/cdktf.json
```

### The second deployment onward

Once one real deployment exists, the rest are derived from it rather than from the template:

```bash
python3 scripts/new-deployment.py PROJ     # tracker team id; prompted for when omitted
```

It asks which existing config to base on, the tracker team id if it was not given as the argument
(the deployment name is that plus `MMDD`), and the VPC CIDR — defaulting to the next block above
every one already in use, which is
the choice most worth not making by hand, since two deployments on the same block only collide
later when something tries to route between them. It then writes
`infrastructure/cdktf.<NAME>.json`, and offers to create the state bucket and copy the previous
deployment's SSM parameters into the new prefix. Everything else is inherited from the base config
unchanged, deliberately — the base you pick is the shape you get.

Writing the config needs nothing installed. The two AWS steps need `boto3` (`pip install boto3`),
and use the profile and region from the config being created — never the default profile; without
boto3 the script says so up front, writes the config anyway, and tells you what is left to do by
hand. It talks to the AWS API directly rather than driving the `aws` CLI so that a copied secret
exists only in memory between the read and the write — never in a file and never on a command line.

Before either step it resolves the profile through `sts:GetCallerIdentity` and refuses if the
account does not match the config's `aws.account-number`. That is the same guard the stacks get
from Terraform's `allowed_account_ids`, applied to the two things that happen before Terraform
runs: a bucket in the wrong account is recoverable, a parameter store in the wrong account seeded
with this deployment's secrets is not.

Each deployment's config is kept beside the others under its own name. `cdktn` only ever reads
`cdktf.json`, so a run means standing one in under that name and moving it back after:

```bash
mv cdktf.PROJ0903.json cdktf.json && npm run synth && npm run deploy; mv cdktf.json cdktf.PROJ0903.json
```

Then replace every placeholder value: the account number and profile, `state-bucket-name`,
`domain-name` and `hosted-zone-id`, `parameter-prefix`, `framework-repo`, `output` if you want a
different synth directory, and the `reviewer-email-to-github-login` table. Nothing synths until
those are real. The template's key set is kept identical to a working config, so a missing key is a
diff away rather than a runtime surprise.

Every setting comes from the `context` block of that file — read once per stack in the base
stack's constructor, validated by the factories in [`models/`](models). Nothing reads
`process.env`, and there are no sensitive Terraform variables, so there is no `secrets.tfvars` to
manage. Values marked `REPLACE_ME` must be filled in before the first synth.

| Key | Example | Notes |
|---|---|---|
| `aws.region` | `us-east-1` | |
| `aws.account-number` | `123456789012` | Also passed as `allowed_account_ids`, so a mis-set profile fails the plan rather than applying to the wrong account. `scripts/new-deployment.py` checks the profile against it the same way before creating anything |
| `aws.profile` | `kisasa` | |
| `state-bucket-name` | `example-terraform-state-001` | |
| `global-tags` | `{ "terraform": "true", … }` | Applied to everything, plus a per-stack `stack` tag |
| `domain-name` | `example.com` | |
| `hosted-zone-id` | `Z0852…` | |
| `vpc-cidr-block` | `10.6.0.0/22` | Split into /24 subnets; two blocks left spare |
| `parameter-prefix` | `/example/prod/` | Trailing slash included. One shared prefix for every stack's SSM secrets — see Creating the SSM parameters |
| `listener.environment-name` | `prod` | **Max 30 characters** — load balancer and target group names cap at 32 |
| `listener.subdomain` | `hooks` | Combines into `hooks.prod.example.com` |
| `listener.ecr-repository-name` | `intent-to-production` | Must match the CI workflow's `ECR_REPOSITORY` |
| `listener.image-tag` | `a1b2c3d4e5f6` | See below |
| `listener.port` | `8787` | Container port and target group port |
| `listener.cpu` / `.memory` | `512` / `1024` | Task-level Fargate sizing |
| `listener.log-retention-days` | `30` | |
| `listener.debounce-ms` | `15000` | Passed through as `DEBOUNCE_MS` |
| `listener.log-level` | `info` | Passed through as `LOG_LEVEL` |
| `listener.linear-api-url`, `.linear-mcp-url`, `.github-mcp-url`, `.product-context-paths` | `null` | Optional. `null` means the application's own default applies; the keys are spelled out to document that they exist |
| `listener.claude-model-intake`, `.claude-model-specification`, `.claude-model-decompose` | `claude-opus-5-5` (intake, specification) / `claude-sonnet-5` (decompose) | Required — no code-level default. Per-lane model, passed through as `CLAUDE_MODEL_INTAKE`/`_SPECIFICATION`/`_DECOMPOSE`. Tune per engagement without a code change or redeploying the image — just this stack |
| `listener.claude-effort` | `high` | Required — no code-level default. Uniform across every lane's activation call, passed through as `CLAUDE_EFFORT`. One of `low`/`medium`/`high`/`xhigh`/`max` |
| `specialist-sandbox.environment-name` | `prod` | Validated independently of `listener.environment-name`, though today they're the same value |
| `specialist-sandbox.ecr-repository-name` | `intent-to-production-specialist` | Doesn't exist yet — see Prerequisites |
| `specialist-sandbox.image-tag` | `REPLACE_ME` | Placeholder until the specialist has a Dockerfile and a CI push target |
| `specialist-sandbox.cpu` / `.memory` | `2048` / `4096` | Task-level Fargate sizing. Raised from the original `1024`/`2048` (1 vCPU, the smallest memory Fargate allows at that CPU tier) — undersized for a real target repo's `npm ci` + build + test run, on top of the Chromium install this image already carries for Playwright (see the Dockerfile's own note). Fargate has no swap: exceeding the memory limit is a hard OOM kill of the whole task, not graceful degradation, and a killed task looks like an unexplained specialist failure with no clear error from the app itself. Raise further (e.g. `4096`/`8192`) if a real engagement's build/test suite is heavier than this |
| `specialist-sandbox.log-retention-days` | `30` | |
| `specialist-sandbox.framework-repo` | `example-org/intent-to-production` | `org/name` on GitHub — where the specialist clones its own `agents/`/`skills/` definitions from. Baked into the task definition's container environment as `FRAMEWORK_REPO`; not part of any per-dispatch `RunTask` override |
| `specialist-sandbox.framework-ref` | `main` | Git ref of the framework repo to clone, as `FRAMEWORK_REF`. A pinned ref here controls what every specialist run in this deployment uses, independent of whatever ref this deployment's own listener/temporal-workers images were built from |
| `specialist-sandbox.claude-model`, `.claude-effort` | `claude-opus-5-5` / `high` | Required — no code-level default. Baked into the task definition's baseline environment as `CLAUDE_MODEL`/`CLAUDE_EFFORT` — every specialist run in this deployment uses it, not just one dispatch |
| `temporal.environment-name` | `prod` | Validated independently of the other stacks' `environment-name`, though today they're the same value |
| `temporal.namespace-name` | `intent-to-production-prod` | Base name — Temporal Cloud appends an account-id suffix to form the fully-qualified namespace id |
| `temporal.ecr-repository-name` | `intent-to-production-temporal-worker` | Doesn't exist yet — see Prerequisites |
| `temporal.image-tag` | `REPLACE_ME` | Placeholder until the worker has a Dockerfile and a CI push target |
| `temporal.cpu` / `.memory` | `512` / `1024` | Task-level Fargate sizing |
| `temporal.desired-count` | `1` | Not a singleton constraint like the listener's — safe to raise once there's real load to justify it |
| `temporal.log-retention-days` | `30` | |

### Model choice

The example values are not placeholders — they are what this framework's own
engagements settled on, and a new deployment can copy them as-is.

Opus goes where the judgment is expensive to redo. **Intake** cuts the slice
map, and a mis-cut propagates into every epic below it; the size band only
catches that at decomposition, which is a late and expensive place to find
it. The **specialist** writes the code. **Specification** judges what already
exists by reading real code — the least contract-bound work in the shaping
tier, and the judgment that failed on 2026-09-04, when a runtime claim was
taken from a conventions document with the repository already open and six
capabilities were mapped on top of it.

Sonnet holds up on **Decompose** because it fills a tight output contract —
`story-contract.md` and `epic-writing.md` specify the shape of a good answer,
so the model is completing a form rather than deciding what is true.

Keeping Decompose on the cheaper model is also deliberate as a comparison
rather than a saving: at this volume — a handful of activations per epic — the
per-token difference is under a dollar either way, and the thing actually
worth measuring is whether the stronger model reduces rework. The API map
records that directly: design touchpoints resolve to `confirmed` or
`corrected`, so the correction rate is countable in the threads. Move
Decompose up when that number says to, not on principle.

The split is per lane precisely so it can be re-tuned per engagement without a
code change or a new image. If a lane starts producing work the architect
keeps sending back, move that one key up and redeploy this stack.

**Set `claude-effort` explicitly — it matters more than it used to.** Claude
Opus 5.5 defaults to `medium` effort, one level below Claude Opus 5's `high`,
so a deployment that leaves effort to the model's own default gets quieter,
cheaper runs than the same config did on the previous model. Both surfaces
here send it on every call, and neither has a code-level default, which is
what keeps that invisible change from happening silently.

### Image tags

`listener.image-tag` (and `specialist-sandbox.image-tag`, `temporal.image-tag`) is pinned rather than
tracking `:latest`, so that Terraform sees a real diff and the running version is auditable in git.
Deploying a new build is: read the tag CI pushed, edit the key, apply. Tracking `:latest` would leave
Terraform with nothing to plan.

## Working with it

```bash
npm install
npm run synth
```

```bash
npx cdktn diff --skip-synth network
npx cdktn deploy --skip-synth --auto-approve network
```

`specialist-sandbox` synths and diffs the same way, but deploying it will fail until its ECR repository
and first image exist (see Prerequisites):

```bash
npx cdktn diff --skip-synth specialist-sandbox
npx cdktn deploy --skip-synth --auto-approve specialist-sandbox
```

`temporal-workers` needs `npx cdktn get` run first (see above), and will fail to deploy until its ECR
repository, its SSM parameters, and the Temporal Cloud admin API key all exist — same not-yet-applyable
posture as `specialist-sandbox`:

```bash
npx cdktn get
npx cdktn diff --skip-synth temporal-workers
npx cdktn deploy --skip-synth --auto-approve temporal-workers
```

**`listener` now depends on `temporal-workers` having deployed first** — it reads that stack's remote
state (namespace address, namespace id, task queue name) for the webhook listener's own Temporal client,
plus the `TEMPORAL_API_KEY` SSM parameter `temporal-workers.ts` creates under the shared
`parameter-prefix` — read there, not created again, the same way `listener.ts` reads its own other five
secrets. On a from-scratch stand-up, deploy `temporal-workers` before `listener`, not the two together the
way `network`+`listener` used to be a single step:

```bash
npx cdktn diff --skip-synth listener
npx cdktn deploy --skip-synth --auto-approve listener
```

The first `listener` deploy blocks while ACM validates the certificate through DNS — several minutes is
normal.

`npx cdktn output listener` reports the webhook URL to register with the tracker, the service name,
the log group, and the exact image URI running.

```bash
npm run test:unit && npm run typecheck
```

## Layout

```
main.ts                  Stack construction and dependency wiring
common.ts                Name formatting and state keys
cdktf.json               Project config (gitignored); the context block is all the settings. The
                         only name cdktn reads, so each deployment's own cdktf.<NAME>.json stands
                         in under it for a run — see Configuration
cdktf.example.json       Committed template; copy to cdktf.json and fill in. Later deployments are
                         derived from an existing one by `scripts/new-deployment.py` instead
models/                  Typed configuration and stack outputs, with fromContext factories
constructs/              Reusable pieces: VPC, certificate, load balancer, single-instance service,
                         specialist task, Temporal PrivateLink/namespace/worker service. Every
                         construct with real branching logic or a security-relevant invariant
                         (region guards, AZ-count guard, singleton desiredCount, ingress scoping,
                         the container_definitions JSON/token double-encoding gotcha) has a
                         `Testing.synthScope`-based test — see `testing/synth-assertions.ts` for
                         the shared container_definitions check
stacks/                  base-stack.ts (base) plus network.ts, listener.ts, specialist-sandbox.ts,
                         temporal-workers.ts
.gen/                    Locally generated `temporalcloud` provider bindings (gitignored) — run
                         `npx cdktn get` after cloning, same as `npm install`
```

The shape follows the C# reference project this was modelled on (`a reference CDKTF project`):
context as the single configuration source, a base stack owning the provider and backend, typed
config records with validating factories, named state keys, and reusable constructs. Two things
diverge deliberately.

**Outputs and remote-state reads are spelled out, not reflected.** The reference project reflects
over a C# record's constructor parameters to read cross-stack outputs. TypeScript has no runtime view
of a type, so [`network-stack-output.ts`](models/network-stack-output.ts) carries an explicit codec
instead. Writing one of those by hand for each boundary is part of why this is two stacks and not
three.

**The service construct is not a copy of `EcsClusterService`.** That construct defaults to two-to-four
instances behind CPU and memory target tracking and tells Terraform to ignore `desired_count` drift —
all three of which are wrong for a service that must be a singleton. It also reuses one pre-existing
account-level role as both the execution and the task role; here they are separate roles with
separate policies, because the ECS agent's permissions (pull image, write logs, read secrets) and the
application's (none — it makes no AWS calls) are not the same thing.

## Known gaps

Honest about what this does not do.

- **No drain on deploy.** An activation can run for 30 minutes; Fargate's `stopTimeout` caps at 120
  seconds. Replacing the task mid-activation drops that run, possibly after the agent has already
  written partial comments to the tracker. Deploy when the lanes are idle. A real fix means moving
  the scheduler's state out of process — the same change that would allow more than one instance.
- **A short gap on every deploy.** Stopping before starting is what guarantees a single instance. The
  tracker retries webhook deliveries, so a missed delivery during the gap arrives on the retry.
- **No alarms.** `HealthyHostCount < 1` is the obvious one, but an alarm without an action is
  theater, and wiring SNS means managing a subscription confirmation. Not built rather than
  half-built.
- **The load balancer is open to the internet on 443.** Authenticity is established in the
  application by HMAC signature verification, not by source address. An IP allowlist is available as
  a knob but would be a second thing to keep current, failing closed and silently when the tracker's
  ranges change.
- **One environment per run.** Nothing in the code assumes one environment; only `cdktf.json` does,
  because that is the one filename `cdktn` reads. So each deployment keeps its own
  `cdktf.<NAME>.json` and is renamed into place for the duration of a run —
  `scripts/new-deployment.py` generates one and prints that dance, but does not perform it, and
  forgetting to rename back leaves the next run reading the wrong deployment's context. A real fix
  is a wrapper that renames, runs and restores under a trap, or a second directory of stacks.
- **Specialist-sandbox egress is unrestricted, not allowlisted.** The design calls for locking egress to
  the Anthropic API, GitHub, Linear, and the gateway-processor test endpoints specifically — but none of
  those publish IP ranges stable enough for a security-group rule, unlike AWS's own services. Real
  enforcement needs a NAT gateway plus a forward proxy, or AWS Network Firewall's domain-name filtering,
  either of which is its own build. Until then, the task's egress is `0.0.0.0/0`, same as the listener's,
  with zero inbound.
- **Specialist-sandbox secrets are read directly, not through a credential-injection proxy.** The design
  calls for a proxy outside the sandbox that injects GitHub/Linear/gateway-processor credentials into
  requests, so the specialist container never holds one directly. That proxy doesn't exist yet — its own
  design questions (where it runs, how it authenticates a sandbox task, its request-signing story) aren't
  settled. For now the task reads its own sandbox-scoped SSM parameters directly via its execution role,
  same mechanism the listener already uses, just under a separate prefix — so a specialist run is never
  holding a *production* credential, even though it is still holding a raw one.
- **Two secret values reach Terraform state in `temporal-workers`, not just an ARN.** The `temporalcloud`
  provider's admin API key (read directly from SSM) and the namespace's generated worker API key (written
  into SSM by this stack, since the provider hands it back as a resource attribute rather than something
  already living there) both break this project's otherwise-universal "only an ARN reaches synth" rule —
  unavoidable, since Terraform provider authentication doesn't support the ARN-indirection ECS container
  secrets use. See the Temporal workers section above.
- **Temporal worker egress is unrestricted**, same reasoning and same gap as the specialist sandbox's.
- **Neither `specialist-sandbox` nor `temporal-workers` has ever had a real image deployed.** Both
  applications, their Dockerfiles, and their CI push workflows all exist now, but those workflows only
  push on a merge to `main` — until one lands, `cdktf.json`'s `image-tag` for both stacks stays the
  `REPLACE_ME` placeholder and a `deploy` against either would fail resolving it. See the Temporal
  workers section above for what's already wired and ready once a real image exists.
