# The specialist runner. Unlike webhook-listener/Dockerfile, this image does
# NOT bake in agents/ or skills/ — workspace.ts clones the framework repo
# fresh every run, which is the whole point (a stale baked-in copy would
# reintroduce exactly the staleness risk the design ledger flags for the
# manual dispatch workflow). Build context is this directory, self-contained:
#   docker build -f specialist-runner/Dockerfile specialist-runner
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Chromium's OS-level shared libraries (libglib-2.0.so.0, libnss3, libatk*,
# libx11*, etc.) — confirmed missing live (2026-08-07): a specialist
# tried to sanity-check its own E2E spec locally, per specialist-e2e.md's "if
# you can stand up and exercise the app locally as you write, do," and
# chromium/chromium-headless-shell both failed to launch with "error while
# loading shared libraries." The runtime user (USER node, below) has no
# install permissions, so this has to happen here, as root, at build time.
# Deliberately NOT the browser *binary* itself — that stays out of the image
# so it's downloaded fresh per run (`npx playwright install chromium` inside
# whatever surface repo's `e2e/` project actually gets cloned), matching
# that project's own pinned `@playwright/test` version instead of whatever
# was current when this image was built. `install-deps` runs its own
# `apt-get update` internally, so the removed package lists above don't
# matter here.
RUN npx --yes playwright@latest install-deps chromium

# --- Toolchains for the non-Node surfaces ------------------------------------
#
# The image was Node-only until 2026-09-19, which quietly made one of this
# agent's own rules unfollowable: the definition says "run the surface's
# existing tests, not only your own," and the design ledger's isolation
# decision says "unit tests run in this same sandbox." Neither held on a
# Python or .NET surface, because neither interpreter was here. Observed on a
# 2026-09-18 run against a Python surface: the specialist wrote 22 new test
# cases, could not execute one of them, and reported that CI was the first
# execution — which also means that on those surfaces "CI is the independent
# check on your own green" was false, since there was no green to be
# independent of.
#
# Docker is deliberately still absent and is not coming: Fargate offers no
# privileged mode and no socket mount, which is why integration and E2E
# execution live in GitHub Actions (design ledger, "Integration and E2E run in
# GitHub Actions"). These toolchains close the unit-test gap only.

# curl is a build dependency of the .NET install below, and is kept rather
# than removed: a surface's own verification steps are commonly written as
# curl invocations, and the specialist is expected to be able to read and run
# what a README documents.
RUN apt-get update   && apt-get install -y --no-install-recommends curl   && rm -rf /var/lib/apt/lists/*

# Python comes from the base image's Debian release rather than a pin here,
# and that is the whole mechanism: node:22-slim is bookworm, whose python3 is
# 3.11.x. A surface needing a different minor is a base-image decision, not an
# apt pin bolted on top of one — pinning here would silently install a second
# interpreter alongside Debian's and leave `python3` meaning the wrong one.
#
# pipx rather than `pip install poetry`, matching the reference CI workflow's
# reasoning: Poetry lands in its own isolated environment, so Poetry's own
# dependency tree can never be resolved against, or quietly land in, the
# project virtualenv it is managing. PIPX_BIN_DIR is /usr/local/bin because
# pipx's default (~/.local/bin) belongs to whoever ran it — root, at build
# time — and would not be on the runtime user's PATH.
ARG POETRY_VERSION=2.4.3
ENV PIPX_HOME=/opt/pipx     PIPX_BIN_DIR=/usr/local/bin
RUN apt-get update   && apt-get install -y --no-install-recommends python3 python3-venv pipx   && rm -rf /var/lib/apt/lists/*   && pipx install "poetry==${POETRY_VERSION}"

# Both match the reference CI workflow. NO_INTERACTION because a blocked
# prompt in a container with no console reads as a timeout rather than a
# failure, which is the expensive way to find out. VIRTUALENVS_IN_PROJECT so
# the venv is at <surface>/.venv, a path the specialist can see and reason
# about, rather than under a hashed directory in the cache.
ENV POETRY_NO_INTERACTION=1     POETRY_VIRTUALENVS_IN_PROJECT=true

# The .NET SDK via Microsoft's own install script rather than their apt feed:
# the script takes a channel directly, so the pin below is the same trade the
# reference CI workflow makes with `dotnet-version: "10.0.x"` — the major is
# named explicitly and patches keep flowing. The apt feed would add a third-
# party repository to every subsequent apt operation in this image for no
# gain.
#
# libicu is not optional. Without it the SDK fails at startup unless
# DOTNET_SYSTEM_GLOBALIZATION_INVARIANT is set, and setting that would change
# how string comparison and formatting behave inside the target repo's tests —
# a sandbox that quietly disagrees with CI about culture handling is worse
# than one that has no SDK at all.
ARG DOTNET_CHANNEL=10.0
ENV DOTNET_ROOT=/usr/share/dotnet
RUN apt-get update   && apt-get install -y --no-install-recommends libicu72   && rm -rf /var/lib/apt/lists/*   && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh   && chmod +x /tmp/dotnet-install.sh   && /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir "${DOTNET_ROOT}" --no-path   && rm /tmp/dotnet-install.sh   && ln -s "${DOTNET_ROOT}/dotnet" /usr/local/bin/dotnet

# Noise reduction, not hang guards, and the same pair the reference CI
# workflow sets: the first-run banner is printed rather than prompted, and
# opting a sandbox out of telemetry is the point of the second.
#
# DOTNET_CLI_HOME is explicit because the SDK writes first-run state into it
# and defaults it to $HOME. The runtime user below owns /home/node, so the
# default would work today; naming it means an image that later runs as a
# different user fails loudly at build time rather than at first `dotnet
# restore`, several minutes into someone's dispatch.
#
# The workload integrity check is skipped because this image installs no
# workloads and the check has nothing to verify: it prints "An issue was
# encountered verifying workloads" on ordinary restores here. Harmless, but
# the specialist reads its own command output to decide what happened, and a
# line like that invites it to go and fix something that is not broken.
ENV DOTNET_NOLOGO=true     DOTNET_CLI_TELEMETRY_OPTOUT=true     DOTNET_CLI_HOME=/home/node     DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK=true
# --- end toolchains ----------------------------------------------------------

WORKDIR /app

# Install deps (incl. tsx/typescript — runs TS via tsx, no build step, same
# convention as webhook-listener).
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# The platform injects every env var below — most as an ECS RunTask override,
# FRAMEWORK_REPO/FRAMEWORK_REF from the task definition itself instead — see
# src/dispatch-context.ts for the required ones (no defaults; all of them fail
# fast if unset) and README.md for the full list. No .env file.
#
# NODE_ENV=development, deliberately not production despite matching
# webhook-listener's and dispatch-worker's own Dockerfiles otherwise — this
# container's own code never reads NODE_ENV, but the specialist's shelled-out
# `npm install` in whatever target repo it clones inherits it, and
# NODE_ENV=production makes npm silently skip devDependencies. Confirmed live
# (2026-08-10, two live runs): a target repo whose test tooling (Angular
# CLI, Playwright) lives in devDependencies got an empty-looking node_modules
# and a misleading failure — one run's specialist worked around it with
# `npm ci --include=dev`; the other's didn't, and shipped without running its
# suite at all. Set explicitly to `development` rather than left unset — this
# container's actual job is developing against a target repo, and some
# tooling branches on the literal value rather than just "not production,"
# so this states what's true instead of relying on an implicit default
# happening to behave the same way.
ENV NODE_ENV=development

RUN mkdir -p /workspace && chown -R node:node /app /workspace
USER node

CMD ["npm", "run", "start"]
