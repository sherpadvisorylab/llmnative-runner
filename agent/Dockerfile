# The image of a Playbook agent: one container per turn, started by the dispatcher, removed at the end.
# It clones the repository (or uses one mounted at /work/repo), checks that the agent exists in the
# workflow package and runs it with opencode, without interaction. See docs/runner-setup.md.
# Java for the emulators of Firebase (Firestore, Storage, Auth) and the other tools of a project that need it:
# the agents ran the tests downloading a JDK at every turn.
FROM eclipse-temurin:21-jre AS java

FROM node:24-bookworm-slim

# opencode at a fixed version: a new one is adopted on purpose, by changing it here.
ARG OPENCODE_VERSION=1.19.3
# Claude Code, for the agents an organization runs with its subscription of Claude (§8.5).
ARG CLAUDE_CODE_VERSION=2.1.318

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# A browser, so that an agent sees the pages it builds, reviews or tests (`playbook.mjs screenshot`): Playwright with
# Chromium and its system libraries, in a folder every user reads. The script finds it by PLAYBOOK_PLAYWRIGHT.
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYBOOK_PLAYWRIGHT=/usr/local/lib/node_modules/playwright
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Not root: the agent works in /work with its own user.
RUN useradd --create-home --uid 10001 agent && mkdir -p /work && chown agent:agent /work
# The cache of npm: a volume of the organization keeps it from turn to turn (its owner taken from here).
RUN mkdir -p /home/agent/.npm && chown agent:agent /home/agent/.npm
COPY --chmod=0755 entrypoint.sh /usr/local/bin/playbook-agent
RUN mkdir -p /usr/local/lib/playbook && chmod 0755 /usr/local/lib/playbook
COPY --chmod=0644 usage.mjs /usr/local/lib/playbook/usage.mjs
COPY --chmod=0644 claude-stream.mjs /usr/local/lib/playbook/claude-stream.mjs
# The tools of the studio for a chat on the server (MCP on stdio, §8.7).
COPY --chmod=0644 studio-mcp.mjs /usr/local/lib/playbook/studio-mcp.mjs
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json

USER agent
WORKDIR /work
ENV HOME=/home/agent
LABEL org.opencontainers.image.title="playbook-agent" \
      org.opencontainers.image.description="A Playbook agent run by opencode or Claude Code, one container per turn"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/playbook-agent"]
