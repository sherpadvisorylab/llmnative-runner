#!/bin/sh
# The installer of the LLMNative Runner. On a Linux VPS, as root:
#
#   curl -fsSL https://github.com/sherpadvisorylab/llmnative-runner/releases/download/v1.0.0/install.sh \
#     | sudo sh -s -- --domain runner.example.com
#
# It checks the machine, installs Docker if missing, writes /opt/llmnative-runner (compose and .env), starts the
# runner and Caddy (TLS by itself once the domain points here), and prints the address and a pairing code to
# connect it. Run again at any time: nothing is lost. `--upgrade <version>` moves to another release.
#
# For a machine reading it, some lines are `NAME=value`: STEP=<phase>, RUNNER_URL=, PAIRING_CODE=, RUNNER_ERROR=.
set -eu

VERSION="1.1.1"
DIR="/opt/llmnative-runner"
DOMAIN=""
MAX_CHATS=""
AGENT_MEMORY=""
AGENT_CPUS=""
SKIP_TLS_CHECK=""

say() { printf '%s\n' "$*"; }
step() { say "STEP=$1"; say "==> $2"; }
fail() { say "RUNNER_ERROR=$1"; say "error: $2" >&2; exit 1; }

# Run as `curl … | sh`, the script itself is the standard input: everything is in main, called on the last line, so
# that the whole script is read before anything runs, and no command can read what is left of it.
main() {

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --max-chats) MAX_CHATS="${2:-}"; shift 2 ;;
    --agent-memory) AGENT_MEMORY="${2:-}"; shift 2 ;;
    --agent-cpus) AGENT_CPUS="${2:-}"; shift 2 ;;
    --upgrade|--version) VERSION="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --skip-tls-check) SKIP_TLS_CHECK=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) fail invalid-argument "unknown argument: $1" ;;
  esac
done

# An upgrade without --domain keeps the one of the installation.
if [ -z "$DOMAIN" ] && [ -f "$DIR/.env" ]; then
  DOMAIN="$(sed -n 's/^RUNNER_DOMAIN=//p' "$DIR/.env")"
fi

step check "Checking the machine"
[ "$(id -u)" = "0" ] || fail not-root "run it as root (sudo sh install.sh …)"
[ "$(uname -s)" = "Linux" ] || fail not-linux "the runner runs on Linux"
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) fail architecture "unsupported architecture: $(uname -m) (x86_64 or arm64)" ;;
esac
printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' \
  || fail invalid-domain "--domain must be a host name of its own, e.g. runner.example.com"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail invalid-version "--upgrade needs a version like 1.0.0"
MEMORY_KB="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)"
CPUS="$(nproc 2>/dev/null || echo 1)"
if [ "${MEMORY_KB:-0}" -lt 3500000 ]; then say "warning: $((MEMORY_KB / 1024)) MB of memory; 4 GB or more are advised"; fi
if [ "$CPUS" -lt 2 ]; then say "warning: $CPUS core; 2 or more are advised"; fi
for port in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^llmnative-runner-caddy'; then
      fail port-busy "port $port is used by another program: the runner needs 80 and 443 (Caddy)"
    fi
  fi
done

step docker "Docker"
# Docker from its own repository with apt, without stopping when an index of the distribution does not download (its
# mirrors syncing: "File has unexpected size"): apt then uses the indexes it already has.
docker_from_apt() {
  command -v apt-get >/dev/null 2>&1 || return 1
  . /etc/os-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc || return 1
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq >/dev/null 2>&1 || say "warning: some indexes of the distribution did not download (its mirrors are syncing): the ones of before are used"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
}
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker…"
  command -v curl >/dev/null 2>&1 || { apt-get update -qq || true; apt-get install -y -qq curl ca-certificates; }
  if ! curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; then
    say "get.docker.com did not finish: installing from the repository of Docker"
    tries=0
    until docker_from_apt; do
      tries=$((tries + 1))
      [ "$tries" -lt 3 ] || fail docker "Docker could not be installed: try again in some minutes"
      say "Docker not installed yet (attempt $tries of 3): trying again in 30 seconds…"
      sleep 30
    done
  fi
fi
docker compose version >/dev/null 2>&1 || fail docker-compose "the compose plugin of Docker is missing (docker compose)"
systemctl enable --now docker >/dev/null 2>&1 || true

step files "Writing $DIR"
mkdir -p "$DIR"
chmod 700 "$DIR"
cat > "$DIR/compose.yaml" <<'COMPOSE'
# The LLMNative Runner on a VPS: the runner (API and console) and Caddy, which asks for the TLS certificate of
# RUNNER_DOMAIN by itself. install.sh writes this file in /opt/llmnative-runner with its .env.
name: llmnative-runner

services:
  runner:
    image: ghcr.io/sherpadvisorylab/llmnative-runner:${RUNNER_VERSION}
    restart: unless-stopped
    environment:
      AGENT_IMAGE: ghcr.io/sherpadvisorylab/llmnative-runner-agent:${RUNNER_VERSION}
      PUBLIC_URL: https://${RUNNER_DOMAIN}
      # Chats open at once on the whole runner, and per tenant (about 1 GB of memory each while answering).
      MAX_CHATS: ${MAX_CHATS:-6}
      MAX_CHATS_PER_TENANT: ${MAX_CHATS_PER_TENANT:-6}
      # Memory and cores of each container of a harness (e.g. 3g and 3); empty: no limit.
      AGENT_MEMORY: ${AGENT_MEMORY:-}
      AGENT_CPUS: ${AGENT_CPUS:-}
    volumes:
      # The runner starts the containers of the harnesses next to itself.
      - /var/run/docker.sock:/var/run/docker.sock
      - runner-data:/data

  # TLS by itself for RUNNER_DOMAIN. Replies of chats are streams: flushed at once, and kept open (up to a day)
  # when Caddy reloads, so that a reply being written is not cut.
  caddy:
    image: caddy:2.8.4
    restart: unless-stopped
    configs:
      - source: caddyfile
        target: /etc/caddy/Caddyfile
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - caddy-data:/data

configs:
  caddyfile:
    content: |
      ${RUNNER_DOMAIN} {
        header -Server
        reverse_proxy runner:8080 {
          flush_interval -1
          stream_close_delay 24h
        }
      }

volumes:
  runner-data:
  caddy-data:
COMPOSE
# The .env: what was there kept (limits set by hand), the version and domain of now.
touch "$DIR/.env"
chmod 600 "$DIR/.env"
set_env() {
  if grep -q "^$1=" "$DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$DIR/.env"; else printf '%s=%s\n' "$1" "$2" >> "$DIR/.env"; fi
}
set_env RUNNER_VERSION "$VERSION"
set_env RUNNER_DOMAIN "$DOMAIN"
if [ -n "$MAX_CHATS" ]; then set_env MAX_CHATS "$MAX_CHATS"; fi
if [ -n "$AGENT_MEMORY" ]; then set_env AGENT_MEMORY "$AGENT_MEMORY"; fi
if [ -n "$AGENT_CPUS" ]; then set_env AGENT_CPUS "$AGENT_CPUS"; fi

step start "Starting the runner $VERSION"
cd "$DIR"
docker compose pull -q </dev/null || fail pull "the images of $VERSION could not be downloaded"
docker compose up -d --remove-orphans </dev/null >/dev/null || fail start "the runner did not start (docker compose logs runner)"

step agent "Downloading the image of the harnesses"
docker pull -q "ghcr.io/sherpadvisorylab/llmnative-runner-agent:$VERSION" >/dev/null || say "warning: the image of the harnesses will be downloaded at the first chat"

step health "Waiting for the runner"
tries=0
until docker compose exec -T runner curl -fsS http://127.0.0.1:8080/health </dev/null >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || fail health "the runner does not answer (docker compose logs runner)"
  sleep 2
done

step pair "Pairing code"
PAIRING="$(docker compose exec -T runner node src/cli.ts pair </dev/null | sed -n 's/^PAIRING_CODE=//p')"
[ -n "$PAIRING" ] || fail pair "no pairing code (docker compose logs runner)"

step tls "Certificate for https://$DOMAIN"
TLS_OK=""
if [ -z "$SKIP_TLS_CHECK" ]; then
  tries=0
  while [ "$tries" -lt 30 ]; do
    if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then TLS_OK=1; break; fi
    tries=$((tries + 1))
    sleep 4
  done
  [ -n "$TLS_OK" ] || say "warning: https://$DOMAIN does not answer yet: check that the domain points to this VPS and that ports 80 and 443 are open. Caddy keeps trying by itself."
fi

step done "Done"
say ""
say "  The runner $VERSION is installed."
say "  Address:       https://$DOMAIN"
say "  Pairing code:  $PAIRING   (valid 15 minutes, once)"
say "  Console:       https://$DOMAIN/console   (sign in with: docker compose -f $DIR/compose.yaml exec runner node src/cli.ts admin-token)"
say "  Another code:  docker compose -f $DIR/compose.yaml exec runner node src/cli.ts pair"
say ""
say "RUNNER_URL=https://$DOMAIN"
say "PAIRING_CODE=$PAIRING"
}

main "$@" </dev/null
