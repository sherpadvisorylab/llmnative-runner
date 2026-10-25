# The dispatcher of a company: it receives the webhook of its GitHub App, reconciles every few minutes
# and runs one container of the agent image per turn, through the Docker socket of the host.
# Plain Node 24 (TypeScript run as is, no dependencies). See docs/runner-setup.md.
FROM docker:27.5.1-cli AS docker

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json ./
COPY src ./src

# The release of the runner, shown by /health (the studio compares it with the latest published).
ARG RUNNER_VERSION=dev
ENV PLAYBOOK_RUNNER_VERSION=${RUNNER_VERSION}

# Root in the container: the Docker socket gives that power anyway, and its group differs per host.
ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1
LABEL org.opencontainers.image.title="playbook-dispatcher" \
      org.opencontainers.image.description="Runs the agents of a Playbook workflow on the issues of a GitHub organization"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/main.ts"]
