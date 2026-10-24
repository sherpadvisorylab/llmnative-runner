#!/usr/bin/env bash
# A design session. Settings come from the environment (see docs/runner-setup.md):
#   GITHUB_REPOSITORY         owner/name to clone, with GITHUB_TOKEN (read only); skipped when the
#                             clone is already there (the session started again after a pause)
#   GITHUB_TOKEN              installation token for the clone; removed before opencode starts
#   OPENCODE_SERVER_PASSWORD  required: the dispatcher talks to opencode with it
#   PLAYBOOK_DESIGN_SETUP     a command run once in the clone before the session (set by the image of a
#                             kit that keeps a runtime in the project, e.g. BMAD and its `_bmad/`)
# Exit codes: 64 wrong settings; 65 clone failed; 66 setup of the kit failed; others from opencode.
set -euo pipefail

say() { printf '[playbook-designer] %s\n' "$*" >&2; }

if [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    say "OPENCODE_SERVER_PASSWORD is required"
    exit 64
fi

repo=/work/repo
if [[ ! -d "$repo/.git" ]]; then
    if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${GITHUB_TOKEN:-}" ]]; then
        say "set GITHUB_REPOSITORY and GITHUB_TOKEN, or mount the repository at ${repo}"
        exit 64
    fi
    say "cloning ${GITHUB_REPOSITORY}"
    # The token is read from the environment by a credential helper used for this clone only.
    if ! git -c credential.helper='!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f' \
        clone --quiet "https://github.com/${GITHUB_REPOSITORY}.git" "$repo"; then
        say "clone of ${GITHUB_REPOSITORY} failed"
        exit 65
    fi
fi
# The session writes documents; the dispatcher reads them and opens the pull request. No token stays.
unset GITHUB_TOKEN
cd "$repo"

# The runtime of the kit in the project, once (a session that starts again after a pause has it).
if [[ -n "${PLAYBOOK_DESIGN_SETUP:-}" && ! -e .git/playbook-design-setup ]]; then
    say "setting up the kit in the clone"
    if ! bash -c "$PLAYBOOK_DESIGN_SETUP" >&2; then
        say "the setup of the kit failed"
        exit 66
    fi
    touch .git/playbook-design-setup
fi

say "design session on ${GITHUB_REPOSITORY:-the mounted repository}"
exec opencode serve --hostname 0.0.0.0 --port 4096
