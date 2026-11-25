# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Images and npm package share the version.

## [1.0.0] - 2026-11-25

The runner of Playbook (0.53.0, history kept) as a product of its own, without anything of Playbook.

### Added
- **API v1** (`openapi/v1.yaml`): platform keys from a pairing code, tenants and their project keys with
  permissions, accounts per tenant and **per person** (`X-Runner-User` with `act-as-user`), models, answers, chats with
  NDJSON replies and the tools of the client over MCP. Keys kept as hashes.
- **Accounts per person**: each person connects their own Claude subscription (sign-in of Anthropic run on the runner)
  or OpenCode Go key, used only for them; then the accounts of the tenant. Out of credit: the next account, then
  `no-credit` with the time of the reset.
- **Installer**: `install.sh` (Docker, compose with Caddy TLS, pairing code; run again or `--upgrade`), its checksum
  in each release, `coolify.yaml`.
- **Console** at `/console` with the admin token: state, pairing codes, tenants, keys, accounts of a tenant.
- **`@llmnative/runner`**: `/client` (`RunnerClient`, `forwardToRunner` for the backend of a host), `/ui`
  (`RunnerAccounts`, `RunnersSettings` with automatic install, guide or existing runner, `InstallGuide`,
  `RunnerConsole`, en/it), `/setup` (install over SSH), `/steps` (one description of the installation), CLI
  `npx @llmnative/runner install|guide|pair`.
- Image of the harnesses `llmnative-runner-agent`: Claude Code and opencode only (amd64, arm64).

### Removed (stay in Playbook)
- Turns on GitHub issues, webhooks, workflows, design sessions, knowledge, memory, backups.
