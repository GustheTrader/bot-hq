#!/usr/bin/env bash
# Bot HQ: prepare a fresh Debian 12 VPS (InterServer, or any host) to run Bot HQ the way Zo runs it today.
#
# Run once as root on the NEW server, BEFORE migrating data:
#     REPO_URL=https://github.com/GustheTrader/bot-hq.git bash setup.sh
#
# What it does: packages, Node 22, swap, firewall, the agent engines, the Cloudflare tunnel client, and systemd
# units. What it deliberately does NOT do: copy secrets or data, sign in to any engine, or start any service.
# Those are the steps in MIGRATION.md, in order. Safe to re-run (each step skips what is already there).
#
# Paths match Zo on purpose (/root, /home/workspace/Projects/bot-hq): the bots' saved configs contain absolute
# paths, so keeping them identical means the copied data works without editing it.

set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = debian ] && [ "${VERSION_ID:-}" = 12 ] || echo "WARNING: written for Debian 12 (Zo's OS). Found ${PRETTY_NAME:-unknown}; chromium in particular differs on Ubuntu." >&2

REPO_URL="${REPO_URL:-https://github.com/GustheTrader/bot-hq.git}"
APP_DIR=/home/workspace/Projects/bot-hq
SWAP_GB="${SWAP_GB:-4}"
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n== %s\n' "$*"; }

step "Packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg git rsync sqlite3 ripgrep jq build-essential python3 python3-venv \
  ufw fail2ban unattended-upgrades \
  xvfb x11vnc websockify xfwm4 chromium imagemagick xdotool

step "Node 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

step "Swap (${SWAP_GB} GB), so a busy moment does not kill an engine"
if ! swapon --show | grep -q .; then
  fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf && sysctl -q -p /etc/sysctl.d/99-swappiness.conf
fi

step "Firewall: SSH only. Bot HQ is reached through the Cloudflare tunnel, so no web port is opened."
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

step "Agent engines (same versions as Zo)"
npm install -g --silent \
  @openai/codex@0.169.0 \
  @earendil-works/pi-coding-agent@1.5.2 \
  opencode-ai@1.19.5 \
  @agentclientprotocol/codex-acp@1.10.0 \
  @agentclientprotocol/claude-agent-acp@0.56.0 \
  pi-acp@0.0.34
if ! command -v claude >/dev/null && [ ! -x /root/.local/bin/claude ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
grep -q '/root/.local/bin' /root/.profile 2>/dev/null || echo 'export PATH="/root/.local/bin:$PATH"' >> /root/.profile

step "Cloudflare tunnel client (cloudflared)"
if ! command -v cloudflared >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared
fi

step "Bot HQ code"
install -d /home/workspace/Projects /home/workspace/Skills /root/grokbot/local-screens
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR" || { echo "Clone failed (private repo?). Clone it yourself to $APP_DIR, then re-run." >&2; exit 1; }
fi
echo "Code is at $APP_DIR. Dependencies and build happen in MIGRATION.md once the data is in place."

step "systemd units (installed, enabled, NOT started)"
# The real T3 binary is the newest one under ~/.t3/runtime/versions; a wrapper picks it so updates need no unit edit.
cat > /usr/local/bin/t3-real <<'WRAP'
#!/usr/bin/env bash
set -e
bin=$(ls -d /root/.t3/runtime/versions/*/t3 2>/dev/null | sort -V | tail -1)
[ -n "$bin" ] || { echo "No T3 runtime under /root/.t3 yet (copy it over first)." >&2; exit 1; }
exec "$bin" "$@"
WRAP
chmod +x /usr/local/bin/t3-real

cat > /etc/systemd/system/hermes-gateway.service <<'UNIT'
[Unit]
Description=Hermes gateway (the primary bot's agent and API on 127.0.0.1:8642)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root
Environment=HOME=/root
ExecStart=/root/.local/bin/hermes gateway run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/t3.service <<'UNIT'
[Unit]
Description=T3 Code workspace (127.0.0.1:3090)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/workspace
Environment=HOME=/root
ExecStart=/usr/local/bin/t3-real serve --host 127.0.0.1 --port 3090 --auto-bootstrap-project-from-cwd /home/workspace
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/bot-hq.service <<'UNIT'
[Unit]
Description=Bot HQ server (port 8797)
After=network-online.target hermes-gateway.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/workspace/Projects/bot-hq/server
Environment=HOME=/root
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node --env-file=../.env dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable hermes-gateway t3 bot-hq >/dev/null 2>&1

step "Done"
free -m | sed -n 1,2p
df -h / | tail -1
echo "Next: follow MIGRATION.md from step 2 (copy secrets and data)."
