# Webhook listener. Reads the tracker and the product codebase via MCP —
# no local git clone, so no git dependency here.
#
# Build context must be the REPO ROOT, not this directory — prompt-assembly.ts
# and skills.ts resolve agents/ and skills/ two levels up from src/
# (../../agents, ../../skills), so this image mirrors that same layout rather
# than flattening everything under one folder:
#   docker build -f webhook-listener/Dockerfile -t webhook-listener .
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Siblings of webhook-listener/ in the real repo layout; agent/skill files are
# read fresh at process start (buildSystemBlocks), so they need to exist here.
COPY agents ./agents
COPY skills ./skills

WORKDIR /app/webhook-listener

# Install deps (incl. tsx/typescript — the prod start runs TS via tsx, no build step).
COPY webhook-listener/package.json webhook-listener/package-lock.json ./
RUN npm ci

COPY webhook-listener/tsconfig.json ./
COPY webhook-listener/src ./src

# The platform injects env vars (no .env file) and a PORT to bind; 8787 is
# just the documented default (see src/env.ts's envOr fallback).
ENV NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT||8787}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

RUN chown -R node:node /app
USER node

CMD ["npm", "run", "start:prod"]
