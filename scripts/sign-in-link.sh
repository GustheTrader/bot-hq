#!/usr/bin/env bash
# Print a link that signs one browser in to the app, once, within 15 minutes. Run ON the computer, as root.
#   bash sign-in-link.sh you@example.com
# For when Google sign-in is not set up or not working. The address must be in ALLOWED_EMAILS
# (or already have an account). The key it uses never leaves this machine.
set -euo pipefail
email="${1:?usage: sign-in-link.sh <email>}"
ENV_FILE="${ENV_FILE:-/opt/hq/app/.env}"
val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
key="$(printf 'owner-login' | openssl dgst -sha256 -hmac "$(val SESSION_SECRET)" -r | cut -d' ' -f1)"
curl -fsS -X POST "http://127.0.0.1:$(val PORT)/api/auth/owner" \
  -H "authorization: Bearer $key" -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"link\":true}" | sed -E 's/.*"url":"([^"]+)".*/\1/'
echo
