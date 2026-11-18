# Moving Bot HQ from Zo to a VPS (InterServer)

Nothing here has been run. Every step is written to be done by a person, in order, with a way back. Zo keeps running,
untouched, until the final cutover, and for a week after.

**Facts this plan rests on** (read from Zo on 2026-11-18, secrets not looked at):

| Thing | Where it lives on Zo | Size |
|---|---|---|
| Bot HQ code + build | `/home/workspace/Projects/bot-hq` (service `bot-hq`, port 8797) | small |
| Database | `data/grokbot.db` (+ `-wal`, `-shm`), SQLite | under 1 MB |
| Each extra bot's own agent home | `data/engines/<bot id>/` (5 bots) | about 4 GB |
| Primary Hermes agent and its Python | `/root/.hermes` (launcher `/root/.local/bin/hermes`, API on 8642) | 4.7 GB |
| T3 Code workspace | `/root/.t3` (server on 127.0.0.1:3090) | 0.8 GB |
| Engine sign-ins and settings | `/root/.codex` 1.2 GB, `/root/.claude`, `/root/.pi` | 1.4 GB |
| Skills | `/home/workspace/Skills` (33) | small |
| Secrets | `.env`, plus a key file named by `GROK_INTEGRATION_KEY_SHA256_FILE` | tiny |

Total to copy: about 11 GB. Zo is a shared machine (it also runs other projects), so Bot HQ's own footprint is smaller
than Zo's 12 GB "used".

**Size to order: 4 slices (about 8 GB RAM, about $24/mo), not 2.** Six Hermes agents (about 0.4 to 0.5 GB each) plus T3,
Bot HQ and one Chromium screen per bot add up to roughly 5 to 6 GB. Two slices (4 GB) would swap constantly. If it is
quiet after a week you can try going down; if not, add slices.

---

## 0. Before ordering

- [ ] A **domain on Cloudflare** (free plan is fine; the domain itself is about $10 a year). A named tunnel needs one.
  Plan two names: `hq.<domain>` for Bot HQ and `code.<domain>` for T3.
- [ ] Order **Debian 12** (the same OS as Zo, so Chromium and the screen tools behave the same). 4 slices. Add your SSH
  public key at order time.
- [ ] Confirm on interserver.net: plan specs, renewal price, whether you can add slices later, and the backup price.

## 1. Prepare the server (about 10 minutes)

```bash
ssh root@NEW_IP
curl -fsSL https://raw.githubusercontent.com/GustheTrader/bot-hq/main/deploy/interserver/setup.sh -o setup.sh   # after this is merged
# or copy deploy/interserver/setup.sh over with scp
REPO_URL=https://github.com/GustheTrader/bot-hq.git bash setup.sh
```

If the repo is private the clone fails with a clear message. Clone it yourself with a fine-grained read-only token, then
re-run the script. The script starts nothing and copies no data.

## 2. Copy the data from Zo

Do this **from Zo's shell**, pushing to the new server (Zo needs a temporary SSH key to `root@NEW_IP`; delete that key
afterwards). `rsync` is resumable, so it is safe to re-run.

```bash
NEW=root@NEW_IP

# Database: take a consistent copy (the .db has a write-ahead log, so never copy the raw files while Bot HQ runs).
mkdir -p /tmp/hq-copy && sqlite3 /home/workspace/Projects/bot-hq/data/grokbot.db ".backup /tmp/hq-copy/grokbot.db"

ssh $NEW 'mkdir -p /home/workspace/Projects/bot-hq/data'
rsync -a /tmp/hq-copy/grokbot.db           $NEW:/home/workspace/Projects/bot-hq/data/
rsync -aH --info=progress2 /home/workspace/Projects/bot-hq/data/engines/  $NEW:/home/workspace/Projects/bot-hq/data/engines/
rsync -aH --info=progress2 /root/.hermes/           $NEW:/root/.hermes/
rsync -a  /root/.local/bin/hermes                   $NEW:/root/.local/bin/hermes
rsync -aH --info=progress2 /root/.t3/               $NEW:/root/.t3/
rsync -aH /root/.codex/ $NEW:/root/.codex/ ; rsync -aH /root/.claude/ $NEW:/root/.claude/ ; rsync -aH /root/.pi/ $NEW:/root/.pi/
rsync -a  /home/workspace/Skills/                   $NEW:/home/workspace/Skills/
```

Secrets go by `scp` only. **Never paste them into chat, a ticket or a commit.**

```bash
scp /home/workspace/Projects/bot-hq/.env  $NEW:/home/workspace/Projects/bot-hq/.env
# also the file named by GROK_INTEGRATION_KEY_SHA256_FILE in .env: copy it to the same path on the new server
ssh $NEW 'chmod 600 /home/workspace/Projects/bot-hq/.env'
```

- [ ] Check the copy: on the new server `sqlite3 /home/workspace/Projects/bot-hq/data/grokbot.db 'select count(*) from bots'` should match Zo.
- [ ] Remove the temporary SSH key from Zo and delete `/tmp/hq-copy`.

## 3. Edit `.env` on the new server

Paths stay the same as Zo on purpose. Change only the addresses (use the names from step 0):

| Key | New value |
|---|---|
| `APP_URL` | unchanged (the Vercel site) |
| `SERVER_URL` | `https://hq.<domain>` |
| `PUBLIC_WS_URL` | `wss://hq.<domain>` |
| `MCP_BASE_URL` | leave `http://127.0.0.1:8797` (it is local) |
| `ALLOWED_EMAILS`, `SESSION_SECRET` | unchanged (keeping `SESSION_SECRET` keeps everyone signed in) |

`SERVER_URL` is used for sign-in callbacks, so **step 7 matters**.

## 4. Install and build

```bash
cd /home/workspace/Projects/bot-hq
npm ci
npm run build -w server && npm run build -w web
```

## 5. The tunnel (this is the only public door)

In the Cloudflare dashboard: Zero Trust, Networks, Tunnels, **Create a tunnel** (Cloudflared). Copy the install token it
shows, then on the server:

```bash
cloudflared service install <TOKEN>      # the token stays on the server; do not share it
```

In the tunnel's **Public hostnames** add:

| Hostname | Service |
|---|---|
| `hq.<domain>` | `http://localhost:8797` |
| `code.<domain>` | `http://localhost:3090` |

WebSockets work through the tunnel, which is why `PUBLIC_WS_URL` points straight at it.

## 6. Start, in order, and check each

```bash
systemctl start hermes-gateway && sleep 5 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8642/health
systemctl start t3
systemctl start bot-hq && sleep 3
curl -s -o /dev/null -w 'local  %{http_code}\n' http://127.0.0.1:8797/api/health          # 200
curl -s -o /dev/null -w 'public %{http_code}\n' https://hq.<domain>/api/health            # 200
curl -s -o /dev/null -w 'bots   %{http_code}\n' https://hq.<domain>/api/bots              # 401 when signed out
journalctl -u bot-hq -n 50 --no-pager
```

If Hermes' health path differs, check `journalctl -u hermes-gateway`. **The `hermes gateway run` command is what Zo's own
process list showed; I have not confirmed the exact health URL.**

## 7. Sign-ins that can break (the real risk in this move)

Things tied to the old address or to the machine itself:

- [ ] **Google/Composio sign-in callback.** Anything registered with `https://bot-hq-herb.zocomputer.io/...` as a redirect
  must also list `https://hq.<domain>/...` (Composio and the Google OAuth client). Add the new one; keep the old until
  cutover is done.
- [ ] **Engine sign-ins.** The copied `/root/.codex`, `/root/.claude`, `/root/.pi` may keep working, or the provider may
  have tied them to the old machine. If one asks again, sign in once on the new server (`codex login`, `claude` then
  `/login`, `pi`). Thoth runs on Codex, so check it first.
- [ ] **T3 pairing.** Make a fresh token on the new server (`t3-real pair --ttl 30m --label new-host`) and pair again.
  Then set `VITE_T3_WORKSPACE_URL=https://code.<domain>` in Vercel's environment and redeploy the web app.
- [ ] **Anything else on Zo that a bot calls** (for example the other local services Zo runs). Bot HQ's `.env` does not
  need them, but a bot's own tools or skills might. Test a few bots (below) and read their logs.

## 8. Rehearse on a Vercel preview, before touching production

Make a branch that changes only the destination in `vercel.json`:

```json
{ "source": "/api/:path*", "destination": "https://hq.<domain>/api/:path*" }
```

Open the preview URL and check, signed in:
- [ ] The roster loads and every bot shows its right engine.
- [ ] Work > Launch lists skills; a harmless "reply with just OK" request on Sam gets an answer.
- [ ] A bot's screen opens (this uses WebSockets, so it proves `PUBLIC_WS_URL`).
- [ ] Code opens at the new T3 address.
- [ ] A question card from a bot can be answered.

## 9. Cutover (pick a quiet time; ask me to do the Zo side only after you say go)

1. Stop work: let running turns finish, or tell people.
2. On Zo, stop the `bot-hq` service. Re-run the step 2 `sqlite3 .backup` and `rsync` commands (only changes move).
3. On the new server: `systemctl restart bot-hq`, re-check step 6.
4. Merge the `vercel.json` branch. Vercel redeploys on its own.
5. Check the live site against the step 8 list.

## 10. Rollback (about 2 minutes)

Revert the `vercel.json` change (the site points back at Zo) and start the `bot-hq` service on Zo. Because Zo was left
as it was, nothing else is needed. If work happened on the new server in the meantime, that chat history is on the new
server only, so decide before reverting.

## 11. After the move

- [ ] Nightly backup (put in `crontab -e`; keeps 14 days):

  ```cron
  30 3 * * * sqlite3 /home/workspace/Projects/bot-hq/data/grokbot.db ".backup /root/backups/grokbot-$(date +\%F).db" && find /root/backups -name 'grokbot-*.db' -mtime +14 -delete
  ```
  Also copy `/root/backups` somewhere off the server (a second cheap bucket or your laptop). A VPS disk is not a backup.
- [ ] Keep Zo's `bot-hq` stopped but intact for 7 days, then retire it.
- [ ] Harden later: this runs as root to match Zo's paths. Once stable, move to a dedicated user and remap the saved paths.
- [ ] SSH keys only: set `PasswordAuthentication no` in `/etc/ssh/sshd_config.d/` after confirming your key works.
- [ ] Watch memory for a week: `free -m`, `journalctl -u bot-hq`. Adjust slices from what you see.

## What I could not check from here

- InterServer's current plan specs, renewal price, resize and backup terms (reviews disagree; confirm on their site).
- Whether the copied engine sign-ins survive on a new machine.
- The Hermes gateway's health URL and whether any bot depends on other services on Zo.
- That Zo can open an outbound SSH connection to the new server (if not, pull from the new server or use a tarball).
