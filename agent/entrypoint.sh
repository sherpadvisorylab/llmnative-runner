#!/usr/bin/env bash
# One turn of a Playbook agent. Settings come from the environment (see docs/runner-setup.md):
#   PLAYBOOK_AGENT    the agent of the workflow package (.opencode/agents/<name>.md)    required
#   PLAYBOOK_PROMPT   what the agent is asked; default: work on PLAYBOOK_ISSUE
#   PLAYBOOK_ISSUE    the issue number of the turn
#   PLAYBOOK_MODEL    provider/model for opencode; default: the one of the agent
#   PLAYBOOK_TIMEOUT  seconds before the turn is stopped (default 3600)
#   GITHUB_REPOSITORY owner/name to clone, with GITHUB_TOKEN; without it, /work/repo must be mounted
#   GITHUB_TOKEN      installation token of the turn; never written to disk or to the log
# Exit codes: 0 done; 64 wrong settings or unknown agent; 65 clone failed; 124 timeout; others from opencode.
set -euo pipefail

say() { printf '[playbook-agent] %s\n' "$*" >&2; }

agent="${PLAYBOOK_AGENT:-}"
if [[ ! "$agent" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    say "PLAYBOOK_AGENT is missing or not a valid agent name"
    exit 64
fi

repo=/work/repo
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    if [[ -z "${GITHUB_TOKEN:-}" ]]; then
        say "GITHUB_REPOSITORY needs GITHUB_TOKEN"
        exit 64
    fi
    # The token is read from the environment by a credential helper: it never ends up in a URL,
    # in .git/config or in the log, and pushes of the agent use it the same way.
    git config --global credential.helper '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'
    git config --global user.name "playbook-${agent}"
    git config --global user.email "playbook-${agent}@users.noreply.github.com"
    say "cloning ${GITHUB_REPOSITORY}"
    if ! git clone --quiet "https://github.com/${GITHUB_REPOSITORY}.git" "$repo"; then
        say "clone of ${GITHUB_REPOSITORY} failed"
        exit 65
    fi
elif [[ ! -d "$repo" ]]; then
    say "nothing to work on: set GITHUB_REPOSITORY and GITHUB_TOKEN, or mount the repository at ${repo}"
    exit 64
fi
cd "$repo"

# opencode falls back to its default agent on an unknown name: refuse it here instead.
if [[ ! -f ".opencode/agents/${agent}.md" ]]; then
    say "agent ${agent} not found in .opencode/agents of the repository"
    exit 64
fi
# Nor does it run a subagent with --agent: it falls back to its default one. The agents of a GitHub
# package are `mode: all` (or `primary`).
if sed -n '/^---$/,/^---$/p' ".opencode/agents/${agent}.md" | grep -Eq '^mode:[[:space:]]*subagent[[:space:]]*$'; then
    say "agent ${agent} is a subagent: opencode runs only primary agents (mode: all or primary)"
    exit 64
fi

prompt="${PLAYBOOK_PROMPT:-}"
if [[ -z "$prompt" ]]; then
    if [[ -z "${PLAYBOOK_ISSUE:-}" ]]; then
        say "set PLAYBOOK_PROMPT or PLAYBOOK_ISSUE"
        exit 64
    fi
    prompt="Work on issue #${PLAYBOOK_ISSUE} as your instructions say."
fi

args=(run --agent "$agent")
[[ -n "${PLAYBOOK_MODEL:-}" ]] && args+=(--model "$PLAYBOOK_MODEL")

say "agent ${agent}${PLAYBOOK_ISSUE:+ on issue #${PLAYBOOK_ISSUE}}${PLAYBOOK_MODEL:+ with ${PLAYBOOK_MODEL}}"
set +e
timeout --signal=TERM --kill-after=30 "${PLAYBOOK_TIMEOUT:-3600}" opencode "${args[@]}" "$prompt"
code=$?
set -e
[[ $code -eq 124 ]] && say "stopped after ${PLAYBOOK_TIMEOUT:-3600}s"
say "exit ${code}"
exit "$code"
