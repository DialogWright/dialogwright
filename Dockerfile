# syntax=docker/dockerfile:1
#
# The image of one of this repository's apps (apps/<APP>): its server, the phone line and the console,
# configured by its environment as on any machine (guide section 14). Build it from the repository root:
#
#   docker build --build-arg APP=clinic -t dialogwright-clinic .
#   docker run --rm -p 3000:3000 -e PUBLIC_HOST=<your hostname> -e TWILIO_AUTH_TOKEN=... -e HANDOFF_NUMBER=+1555... dialogwright-clinic
#
# The workspace runs its apps from src/ with tsx (each package's exports point at src/, and an app is
# TypeScript): the image does the same rather than build dist/, which only a project that installs the
# packages reads. The server is node itself, with tsx's loader (no pnpm or tsx process in between), under
# tini, so a `docker stop` (SIGTERM) reaches it and its drain runs: live calls finish or move to another
# server, then it exits. No key or settings file is in the image: give every setting at run time.

# Node 22, pinned by version and digest (Debian bookworm, slim).
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# 1. Install: every package the lockfile names, fetched first from the lockfile alone (a layer kept until
#    it changes), then the workspace installed offline from it, exactly as locked.
FROM ${NODE_IMAGE} AS install
# The pnpm of package.json's packageManager.
ARG PNPM_VERSION=9.12.0
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
ARG APP=clinic
RUN test -f "apps/${APP}/src/serve.ts" || { echo "APP=${APP}: there is no apps/${APP}/src/serve.ts" >&2; exit 1; }

# 2. Run: the installed workspace, a non-root user, tini as process 1.
FROM ${NODE_IMAGE} AS run
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ARG APP=clinic
ENV APP=${APP} \
    PORT=3000 \
    TRACE_DIR=/data/traces \
    AUDIT_DIR=/data/audit
# /data: a server's own records when they are not shared (TRACE_STORE, AUDIT_STORE, SESSION_STORE): its
# traces, its audit's day files, the console's sign-in link file beside them, and a file session store
# (SESSION_STORE=file:/data/sessions). Mount a volume there to keep them. NODE_ENV is left unset, as
# `pnpm serve` leaves it: the app runs as it does on any machine.
RUN mkdir -p /data && chown node:node /data
COPY --from=install /app /app
WORKDIR /app/apps/${APP}
USER node
EXPOSE 3000
# Ready: 200 while the server takes calls, 503 while it drains (a balancer sends it nothing new then).
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/serve.ts"]
