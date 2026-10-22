# The image of a Playbook agent: one container per turn, started by the dispatcher, removed at the end.
# It clones the repository (or uses one mounted at /work/repo), checks that the agent exists in the
# workflow package and runs it with opencode, without interaction. See docs/runner-setup.md.
FROM node:24-bookworm-slim

# opencode at a fixed version: a new one is adopted on purpose, by changing it here.
ARG OPENCODE_VERSION=1.19.3

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

# Not root: the agent works in /work with its own user.
RUN useradd --create-home --uid 10001 agent && mkdir -p /work && chown agent:agent /work
COPY --chmod=0755 entrypoint.sh /usr/local/bin/playbook-agent
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json

USER agent
WORKDIR /work
ENV HOME=/home/agent
LABEL org.opencontainers.image.title="playbook-agent" \
      org.opencontainers.image.description="A Playbook agent run by opencode, one container per turn"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/playbook-agent"]
