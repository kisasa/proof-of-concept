# The Temporal worker that dispatches specialists. No git, no local clone —
# branch creation is a GitHub API call (create-story-branch.ts), not a local
# git operation. Build context is this directory, self-contained:
#   docker build -f dispatch-worker/Dockerfile dispatch-worker
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (incl. tsx/typescript — the worker process itself runs via
# tsx, no build step, same convention as webhook-listener and
# specialist-runner). The workflow is the one thing that IS pre-built here:
# bundling at Worker startup (`workflowsPath`) is fine for local development
# but the wrong choice for production per the Temporal TypeScript SDK's own
# guidance, so `build:bundle` runs once at image build time instead —
# worker.ts prefers dist/workflow-bundle.js when present.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build:bundle

# The platform injects every env var below as this ECS service's container
# environment — see src/worker-config.ts for the required ones and
# README.md for the full list, including which are not yet wired into
# infrastructure/stacks/temporal-workers.ts.
ENV NODE_ENV=production

RUN chown -R node:node /app
USER node

CMD ["npm", "run", "start"]
