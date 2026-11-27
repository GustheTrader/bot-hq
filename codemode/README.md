# Code Mode executor

Runs a bot's `run_code` script in a fresh V8 isolate with **no network** (`globalOutbound: null`).
The script's only way out is `codemode.<tool>(input)`, which calls back to Bot HQ at
`POST {HQ_URL}/mcp/<botId>/inner` with a short-lived run token. Policies, approvals and activity rows
all stay in Bot HQ. Plan: `docs/integrations/codemode-plan.md`.

## Run on Zo (local, no Cloudflare account)

```sh
cd codemode && npm ci
printf 'CODEMODE_SECRET=%s\n' "$(cat /root/.codemode/secret)" > .dev.vars
npx wrangler dev --ip 127.0.0.1 --port 8792
```

Bot HQ `.env`: `CODEMODE_URL=http://127.0.0.1:8792` and `CODEMODE_SECRET_FILE=/root/.codemode/secret`.

## Move to Cloudflare later

Set `HQ_URL` to Bot HQ's public URL, `npx wrangler secret put CODEMODE_SECRET`, `npx wrangler deploy`,
then point `CODEMODE_URL` at the workers.dev URL. Worker Loader must be enabled on the account.
