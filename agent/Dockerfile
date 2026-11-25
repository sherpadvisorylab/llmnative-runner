# The image of the harnesses of the runner: Claude Code and opencode at fixed versions, nothing of a project.
# One container per chat (and one short-lived per answer), started by the runner through the Docker socket,
# removed at the end. Projects that need more (a browser, Java…) build their image FROM this one.
FROM node:24-bookworm-slim

# A new version of a harness is adopted on purpose, by changing it here.
ARG OPENCODE_VERSION=1.19.3
ARG CLAUDE_CODE_VERSION=2.1.318

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# Not root: the harness works in /work with its own user.
RUN useradd --create-home --uid 10001 agent && mkdir -p /work && chown agent:agent /work
RUN mkdir -p /usr/local/lib/runner && chmod 0755 /usr/local/lib/runner
# The tools of the client for a chat (MCP on stdio).
COPY --chmod=0644 tools-mcp.mjs /usr/local/lib/runner/tools-mcp.mjs
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json

USER agent
WORKDIR /work
ENV HOME=/home/agent
LABEL org.opencontainers.image.title="llmnative-runner-agent" \
      org.opencontainers.image.description="Claude Code and opencode for the LLMNative Runner, one container per chat" \
      org.opencontainers.image.source="https://github.com/sherpadvisorylab/llmnative-runner"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
