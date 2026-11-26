# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Images and npm package share the version.

## [1.1.1] - 2026-11-26

From the first try of 1.1.0 in a browser.

### Fixed
- Console: «Sign in» works with a token the password manager of the browser filled in (it was disabled until the
  token was typed).
- Adding a runner: one call lost while waiting for the approval (a cold start of the backend) no longer shows an
  error; only five in a row do.

### Changed
- Adding a runner asks no name: the runner is named after its address.
- The buttons of each step are in the footer of the modal, on the right.

## [1.1.0] - 2026-11-26

### Added
- Connecting a runner already installed by asking it (device flow), as signing in to a service from another
  device: the platform asks (`POST /v1/pair/requests`, public, bounded: 20 waiting, 60 in ten minutes, 10 minutes
  each), the admin of the runner approves in the console (`/console/?approve=<code>`, the same code shown on both
  sides, with who asked and from where), the platform asks again with its secret (`POST /v1/pair/requests/poll`) and
  gets its platform key once. No code to copy.
- Admin routes `GET /v1/admin/pairing/requests`, `POST /v1/admin/pairing/requests/<code>/approve|deny`; client
  `requestPairing`, `pollPairing`, `pairingRequests`, `answerPairing`.
- UI: «It is already installed» asks the address, then shows the code and «Open the runner to approve», and
  connects by itself when approved (`RunnerFleet.startPairing`/`pairingStatus`); the pairing code stays as «I have
  a pairing code». The console lists the requests and can remember the admin token on the browser.
- `npx @llmnative/runner setup` connects runners the same way.

## [1.0.3] - 2026-11-26

### Fixed
- `curl … | sh`: the installer is read whole before it runs (everything in `main`) and Docker commands get no
  standard input; before, `docker compose exec` could swallow the rest of the script, which then ended with
  "Syntax error: end of file unexpected" (seen upgrading a VPS to 1.0.2: the runner was up, the summary missing).

## [1.0.2] - 2026-11-26

From the first automatic installation on a new VPS (161.97.140.94).

### Fixed
- Docker while the mirrors of Ubuntu are syncing ("File has unexpected size"): when get.docker.com fails, Docker is
  installed from its own repository with the indexes already there, tried again up to 3 times.
- Without `--key`, the command line and the setup page use the key (and user) `~/.ssh/config` gives the host, then
  the default keys; the setup page offers "The SSH key of this computer".

### Changed
- The workflow that publishes is `publish.yml` (was `release.yml`), the same name as the other packages: one
  Trusted Publisher configuration for all of them.

## [1.0.1] - 2026-11-26

Compared with the runner in production (Playbook 0.53.0 on Coolify, the reference).

### Added
- `npx @llmnative/runner setup`: the screens to add runners on this computer (installed for you over SSH, the guide
  for dummies, or a runner already installed), SSH from here, the runners and their platform keys in
  `~/.llmnative-runner/fleet.json` (0600). The same `RunnersSettings` a platform shows.
- `install.sh --agent-memory 3g --agent-cpus 3`: limits of each container of a harness (`AGENT_CPUS` in compose too).

### Fixed
- Chat replies through Caddy: flushed at once and kept open when Caddy reloads (as the proxy of the runner in
  production does with `stream_close_delay`), with a Caddyfile instead of `caddy reverse-proxy`.
- Containers of chats and answers left by a runner before a restart are removed at start (in production some ran for
  weeks).

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
