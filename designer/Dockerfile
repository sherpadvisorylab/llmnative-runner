# The image of the design agent: one container per design session, started by the dispatcher and kept
# until the session ends. opencode serves the session over HTTP (with a password), on a clone of the
# repository, with the design skills of mattpocock/skills (MIT) at a fixed commit. It writes documents
# only: the dispatcher reads them at the end and opens the pull request. See docs/runner-setup.md.
FROM node:24-bookworm-slim

# opencode at a fixed version, the same as the agent image.
ARG OPENCODE_VERSION=1.19.3
# The skills at a fixed commit: a new one is adopted on purpose, by changing it here.
ARG SKILLS_REPOSITORY=https://github.com/mattpocock/skills.git
ARG SKILLS_COMMIT=5beb35b040e3de97e54fa9e386d7e42d15c295c2
ARG SKILLS="engineering/grill-with-docs productivity/grilling engineering/domain-modeling engineering/to-spec engineering/to-tickets"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

RUN useradd --create-home --uid 10001 agent && mkdir -p /work && chown agent:agent /work

# Copied, never installed with a script: what runs is what was read at that commit.
RUN git clone --quiet --filter=blob:none "${SKILLS_REPOSITORY}" /tmp/skills \
    && git -C /tmp/skills checkout --quiet "${SKILLS_COMMIT}" \
    && mkdir -p /home/agent/.config/opencode/skills \
    && for skill in ${SKILLS}; do cp -r "/tmp/skills/skills/${skill}" /home/agent/.config/opencode/skills/; done \
    && rm -rf /home/agent/.config/opencode/skills/*/agents \
    && cp /tmp/skills/LICENSE /home/agent/.config/opencode/skills/LICENSE     # The configuration setup-matt-pocock-skills writes, from its own templates: the issue tracker as
    # local markdown (.scratch/, the session has no write access to GitHub), the default triage labels,
    # a single-context domain. Kept outside the repository, so the pull request holds documents only.
    && mkdir -p /home/agent/.config/opencode/matt/agents     && cp /tmp/skills/skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md /home/agent/.config/opencode/matt/agents/issue-tracker.md     && cp /tmp/skills/skills/engineering/setup-matt-pocock-skills/triage-labels.md /tmp/skills/skills/engineering/setup-matt-pocock-skills/domain.md /home/agent/.config/opencode/matt/agents/ \
    && printf '%s@%s\n%s\n' "${SKILLS_REPOSITORY}" "${SKILLS_COMMIT}" "${SKILLS}" > /home/agent/.config/opencode/skills/SOURCE \
    && rm -rf /tmp/skills \
    && chown -R agent:agent /home/agent/.config

COPY --chmod=0755 entrypoint.sh /usr/local/bin/playbook-designer
COPY --chmod=0755 design-files.mjs /usr/local/bin/playbook-design-files
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json
# How to talk with the studio: questions with choices through the question tool; then the Agent skills
# block of setup-matt-pocock-skills and the flow of a session: grilling, then the spec, then the PR.
COPY --chown=agent:agent AGENTS.md matt.md /tmp/agents/
RUN cat /tmp/agents/AGENTS.md /tmp/agents/matt.md > /home/agent/.config/opencode/AGENTS.md     && chown agent:agent /home/agent/.config/opencode/AGENTS.md && rm -rf /tmp/agents

USER agent
WORKDIR /work
ENV HOME=/home/agent
EXPOSE 4096
LABEL org.opencontainers.image.title="playbook-design-matt" \
      org.opencontainers.image.description="The design agent of Playbook: an interactive opencode session with the design skills of mattpocock/skills" \
      playbook.design.kit="matt" \
      playbook.design.name="Matt Pocock" \
      playbook.design.command="grill-with-docs" \
      playbook.design.skills="${SKILLS}" \
      playbook.design.source="${SKILLS_REPOSITORY}" \
      playbook.design.commit="${SKILLS_COMMIT}" \
      playbook.design.opencode="${OPENCODE_VERSION}"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/playbook-designer"]
