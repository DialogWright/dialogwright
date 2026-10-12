# syntax=docker/dockerfile:1
#
# The image of {{display}}: its server, the phone line and the console, configured by its environment as
# on any machine (the guide's section 14, node_modules/dialogwright/docs/guide/14-running-it.md). Build
# and run it from this folder:
#
#   docker build -t {{name}} .
#   docker run --rm --stop-timeout 45 -p 3000:3000 -e PUBLIC_HOST=<your hostname> -e TWILIO_AUTH_TOKEN=... -e HANDOFF_NUMBER=+1555... {{name}}
#
# --stop-timeout: Docker kills a container 10 s after `docker stop` unless told otherwise, and the drain
# takes up to DRAIN_UNREADY_MS and DRAIN_MS (30 s by default): give it those and about 15 s more.
#
# The server is node itself with tsx's loader (no npm or tsx process in between), under tini, so a
# `docker stop` (SIGTERM) reaches it and its drain runs: live calls finish or move to another server,
# then it exits. No key or settings file is in the image (.dockerignore keeps .env out): give every
# setting at run time. Commit package-lock.json, so the image installs exactly what you tested.

# Node 22, pinned by version and digest (Debian bookworm, slim).
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# 1. Install: the packages the lockfile names (npm install when there is none yet), then the app.
FROM ${NODE_IMAGE} AS install
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
# The folder checked as `npx dialogwright check` checks it: an image of a broken app is not built.
RUN npx dialogwright check

# 2. Run: the installed project, a non-root user, tini as process 1.
FROM ${NODE_IMAGE} AS run
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENV PORT=3000 \
    TRACE_DIR=/data/traces \
    AUDIT_DIR=/data/audit
# /data: the server's own records when they are not shared (TRACE_STORE, AUDIT_STORE, SESSION_STORE): its
# traces, its audit's day files, the console's sign-in link file beside them, and a file session store
# (SESSION_STORE=file:/data/sessions). Mount a volume there to keep them.
RUN mkdir -p /data && chown node:node /data
COPY --from=install /app /app
WORKDIR /app
USER node
EXPOSE 3000
# Ready: 200 while the server takes calls, 503 while it drains (a balancer sends it nothing new then).
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/serve.ts"]
