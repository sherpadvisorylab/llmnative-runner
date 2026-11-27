# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Images and npm package share the version.

## [1.4.0] - 2026-11-27

### Added
- The name of an account: `PATCH /v1/accounts/<provider>/<id>` `{ label }` (the email of the account, say; empty
  takes it away), `client.accounts.rename`.
- `RunnerAccounts`: one section per subscription (Claude Code, OpenCode Go), each with several accounts in the order
  they are used (dragged, or moved with the arrows of the handle), their state (available, or the limit and when it
  comes back), their name, renamed in place; a second Claude account with the warning on personal subscriptions; a
  token of `claude setup-token` next to the sign-in, the link copied too; for a tenant, the API keys of the providers
  by use in their own section. `renderProvider` shows what the host gives under a subscription (e.g. the model its
  chats start with), `onStack` tells the host a modal of its own is open over it.
- `AddRunner` `position` (`'right'`): the modal on the right, over another.
- `forwardToRunner` forwards `PATCH` too (the name of an account, through the backend of a host).

## [1.3.1] - 2026-11-26

### Fixed
- The client names the permission `modules` (`RunnerPermission`) and the modules of `/v1/info`.

## [1.3.0] - 2026-11-26

### Added
- Modules (`server/src/modules.ts`): what a product builds on the runner without forking it. An image
  `FROM llmnative-runner` adds its modules and names them in `RUNNER_MODULES` (files or packages exporting a
  `RunnerModule`). Each one is started with the runner as it is — its tenants, their keys and accounts (`keysFor`),
  their credit, the containers of the harnesses, a folder of its own (`DATA_DIR/modules/<name>`) — and serves
  `/v1/modules/<name>/…` for one tenant (a project key with the new permission `modules`, or a platform key of its
  project with `X-Runner-Tenant`) and `/hooks/<name>/…` in public (a webhook: the module checks its signature). It hears
  when a tenant is removed. A module that fails to load or start is left out and said in the log. `/v1/info` lists the
  modules.

## [1.2.0] - 2026-11-26

### Added
- A platform key of a project: pairing (by code or by asking) can name a `project` (lowercase and digits, no hyphen).
  That key sees, makes, reaches and gives keys only for the tenants `<project>` and `<project>-<tenant>`, and sees and
  revokes only the platform keys of its project: several projects share a runner without seeing each other. The
  console shows the project of each request and lists the connected platforms («Connected platforms»), where the
  admin gives a project to a key made before (`PUT /v1/admin/keys/<id>/project`); until then it sees every tenant.
  `installAndPair({ project })`, client `pair(code, name, project)`, `requestPairing(name, project)`, `setKeyProject`.
- API keys of the providers by use (Anthropic, OpenAI, Gemini, Mistral, DeepSeek, OpenRouter) as accounts of a tenant
  or a person, run by opencode in answers and chats with the model named as opencode wants it (`gemini` →
  `google/<model>`); `/v1/models` says the kind of each provider (`subscription` | `usage`). `RunnerAccounts` adds the
  key of any provider (`providers` prop; a tenant gets them all by default).

## [1.1.2] - 2026-11-26

### Fixed
- Claude sign-in asked twice at once (the page of a person in React strict mode, two tabs): the second request killed
  the CLI of the first, and the first, ending without its link, closed the second: both failed with "could not start
  the sign-in". Now a sign-in going gives the same page of Anthropic to both, and an ending sign-in closes only itself.

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
