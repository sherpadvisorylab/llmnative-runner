# The runner: API v1 and console, one container of the agent image per chat and per answer, through the Docker
# socket of the host. Plain Node 24 (TypeScript run as is, no dependencies). Built from the root of the repository:
#   docker build -f server/Dockerfile .
FROM node:24-bookworm-slim AS console
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:console

FROM docker:27.5.1-cli AS docker

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY server/package.json ./
COPY server/src ./src
COPY --from=console /build/dist/console ./console

ARG RUNNER_VERSION=dev
ENV RUNNER_VERSION=${RUNNER_VERSION} DATA_DIR=/data PORT=8080 NODE_ENV=production CONSOLE_DIR=/app/console
# Root in the container: the Docker socket gives that power anyway, and its group differs per host.
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1
LABEL org.opencontainers.image.title="llmnative-runner" \
      org.opencontainers.image.description="LLMNative Runner: Claude Code and opencode for many tenants, with accounts per person" \
      org.opencontainers.image.source="https://github.com/sherpadvisorylab/llmnative-runner"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/main.ts"]
