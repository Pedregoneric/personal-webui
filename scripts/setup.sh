#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/personal-webui.service"
PORT="${PORT:-4547}"

if [[ -f "$ENV_FILE" ]]; then
  echo "Configuration already exists at $ENV_FILE"
  echo "Remove it manually only if you intentionally want to replace the WebUI password."
  exit 1
fi

TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
if [[ -z "$TAILSCALE_IP" ]]; then
  echo "No Tailscale IPv4 address was found. Falling back to 127.0.0.1 for local-only use." >&2
  TAILSCALE_IP="127.0.0.1"
fi

if [[ -t 0 ]]; then
  read -r -s -p "Choose a WebUI password (12+ characters): " PASSWORD
  echo
  read -r -s -p "Confirm password: " CONFIRM
  echo
  read -r -p "Username [eric]: " USERNAME
  USERNAME="${USERNAME:-eric}"
  read -r -p "DeepSeek API key (or leave blank to set later): " DEEPSEEK_KEY
else
  echo "Run this setup script from an interactive terminal." >&2
  exit 1
fi

if [[ ${#PASSWORD} -lt 12 ]]; then
  echo "Password must contain at least 12 characters." >&2
  exit 1
fi
if [[ "$PASSWORD" != "$CONFIRM" ]]; then
  echo "Passwords did not match." >&2
  exit 1
fi

umask 077
PASSWORD="$PASSWORD" HOST="$TAILSCALE_IP" PORT="$PORT" ROOT="$ROOT" \
USERNAME="$USERNAME" DEEPSEEK_KEY="${DEEPSEEK_KEY:-}" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const salt = crypto.randomBytes(24).toString('hex');
const hash = crypto.scryptSync(process.env.PASSWORD, salt, 64).toString('hex');
const lines = [
  `HOST=${process.env.HOST}`,
  `PORT=${process.env.PORT}`,
  'SESSION_HOURS=24',
  `WEBUI_USERNAME=${process.env.USERNAME}`,
  `PASSWORD_SALT=${salt}`,
  `PASSWORD_HASH=${hash}`,
  `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1`,
  `DEFAULT_MODEL=deepseek-chat`,
];
if (process.env.DEEPSEEK_KEY) lines.push(`DEEPSEEK_API_KEY=${process.env.DEEPSEEK_KEY}`);
else lines.push('DEEPSEEK_API_KEY=');
lines.push('');
fs.writeFileSync(path.join(process.env.ROOT, '.env'), lines.join('\n'), { mode: 0o600 });
NODE
unset PASSWORD CONFIRM DEEPSEEK_KEY

mkdir -p "$ROOT/data"/{chats,library/personas,library/characters,library/presets,media,uploads}
mkdir -p "$SERVICE_DIR"
if [[ -f "$ROOT/systemd/personal-webui.service" ]]; then
  sed -e "s|__PROJECT_ROOT__|$ROOT|g" \
    "$ROOT/systemd/personal-webui.service" > "$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable --now personal-webui.service
  echo
  echo "Personal WebUI is starting at http://$TAILSCALE_IP:$PORT"
  echo "Check: systemctl --user status personal-webui"
else
  echo
  echo "Wrote $ENV_FILE"
  echo "Start with: cd $ROOT && npm start"
  echo "URL: http://$TAILSCALE_IP:$PORT"
fi
