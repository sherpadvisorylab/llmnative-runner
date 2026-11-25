# LLMNative Runner

Claude Code and opencode on **your own VPS**, for many tenants, with **subscriptions per person**.

- One runner serves many tenants; a platform (a CMS, a studio) can connect several runners and spread its tenants on them.
- Each person connects **their own** Claude subscription (or OpenCode Go key): used only for their requests. Without one, a tenant can have accounts shared by everyone, and a host falls back to its own API keys.
- When an account reaches its limit, the runner goes on with the next one and says when it resets.
- Chats run in a container each; the harness changes nothing and calls the tools of the client through MCP.
- No dependency on Google or any cloud: any Linux VPS, a console served by the runner itself.

This repository holds everything: the server (`server/`), the image of the harnesses (`agent/`), the installer (`install/`), the API (`openapi/v1.yaml`) and the npm package `@llmnative/runner`.

## Install a runner

On a VPS (Ubuntu 22.04+ or Debian 12+, 2 cores, 4 GB, ports 80 and 443 open) with a domain pointed at it:

```bash
curl -fsSL https://github.com/sherpadvisorylab/llmnative-runner/releases/download/v1.0.0/install.sh \
  | sudo sh -s -- --domain runner.example.com
```

It installs Docker if missing, starts the runner and Caddy (TLS by itself), and prints the address and a **pairing code**. Run it again at any time; `--upgrade <version>` moves to another release. To check the script first, download it with its `install.sh.sha256` from the release.

From your computer, over SSH:

```bash
npx @llmnative/runner install --host 203.0.113.10 --domain runner.example.com --key ~/.ssh/id_ed25519 --pair
npx @llmnative/runner guide --domain runner.example.com   # the steps to do it by hand
```

On Coolify: `install/coolify.yaml`, then `node src/cli.ts pair` in the terminal of the service.

**Console**: `https://runner.example.com/console`, signed in with the admin token
(`docker compose -f /opt/llmnative-runner/compose.yaml exec runner node src/cli.ts admin-token`): state, pairing codes, tenants, keys, accounts of a tenant.

## Keys

| Key | Who has it | What it does |
|---|---|---|
| admin token | the machine (`/data/admin-token`) | the console; pairing codes |
| platform key `rk_platform_…` | the backend of a platform, from a pairing code | tenants and their keys; acts for any tenant with `X-Runner-Tenant` |
| project key `rk_…` | the backend of a tenant | `complete`, `chat`, `chat:tools`, `accounts`, `accounts:tenant`, `act-as-user`, `keys` |

Keys are kept as hashes. A host never puts a key in the browser of its people: its backend verifies the person and forwards with `X-Runner-User` (`forwardToRunner`).

## The package `@llmnative/runner`

| Entry | For | What |
|---|---|---|
| `@llmnative/runner/client` | browser, Node | `RunnerClient` (API v1: platform, accounts, models, complete, chats as async iterables), `RunnerError`, `forwardToRunner(request, path, { url, key, user })` for the backend of a host |
| `@llmnative/runner/ui` | React on `@llmnative/react` | `RunnerAccounts` (“My subscriptions”, or a tenant’s), `RunnersSettings` + `RunnerFleet` (the runners of a platform: add one automatically over SSH, with the guide, or already installed; default, draining, tenants), `InstallGuide`, `RunnerConsole`; texts in English and Italian (`texts` to override) |
| `@llmnative/runner/setup` | Node | `installOverSsh`, `installAndPair` (the same install.sh, its log streamed, the SSH access never kept) |
| `@llmnative/runner/steps` | browser, Node | the requirements, `installCommand`, `GUIDE_STEPS`, `parseInstallOutput`, `lookupDomain`, `checkRunner` |
| `npx @llmnative/runner` | command line | `install`, `guide`, `pair` |

The UI components need what the fields of `@llmnative/react` need around them: a router, a `DataProvider` and the `I18nProvider`.

```tsx
// In the backend of a host (e.g. a Cloud Function): the person verified by the host.
import { forwardToRunner } from '@llmnative/runner/client';
export const runner = (request: Request, uid: string) =>
  forwardToRunner(request, new URL(request.url).pathname.replace(/^\/api\/runner/, ''), { url: RUNNER_URL, key: TENANT_KEY, user: uid });

// In the page: the client talks to the backend of the host, not to the runner.
import { RunnerClient } from '@llmnative/runner/client';
import { RunnerAccounts } from '@llmnative/runner/ui';
const client = new RunnerClient({ url: '/api/runner', headers: async () => ({ authorization: `Bearer ${await idToken()}` }) });
<RunnerAccounts client={client} scope="user" locale="it" />
```

## Develop

```bash
npm install
npm run typecheck   # library and server
npm test            # Vitest
npm run build       # dist/: client, ui, setup, steps
npm run build:console
cd server && DATA_DIR=/tmp/runner CONSOLE_DIR=../dist/console node src/main.ts   # the server, without Docker for chats
```

The server is plain Node 24 (TypeScript run as is, no dependencies). Releases: a tag `v<version>` builds the images (amd64, arm64), the GitHub release with `install.sh` and publishes the package (`.github/workflows/release.yml`). Images and package share the version.

## Terms of the subscriptions

Claude Pro and Max are personal. Connect only your own, used for your own requests. Check the terms of Anthropic before offering subscriptions to the people of a product.

## License

Apache-2.0
