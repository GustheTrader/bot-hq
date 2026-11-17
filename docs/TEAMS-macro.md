# Bot HQ — slice 3 (Macro Team sub-app): RESOLVED

Date: 2026-11-17 (updated after the Zen frontend finished building)

## Outcome

The Zen Macro frontend **serves** as of 2026-11-17: `macro-desktop-web-build`
(`127.0.0.1:3018` on Zen) answers a real HTTP 200 with the "Macro AI Workspace" HTML. The
earlier mid-rebuild blocker is gone.

It is now wired into Bot HQ end to end (option **(c)** from the decision list below):

```
Zen 127.0.0.1:3018  (Macro Vite dev server)
   ▲  Zen reverse SSH tunnel: ssh -R 3020:127.0.0.1:3018  (scheduled task `macro-sshtun`)
   │
modal 127.0.0.1:3020
   ▲  scripts/macro-gateway.ts  (process service `macro-gateway`, :8801) — rewrites Host, passes HMR ws
   │
Caddy `macro-workspace-tls`  (/var/lib/caddy-macro) — TLS on :8444 with this box's tailscale cert
   │
https://modal.taila95594.ts.net:8444/   (= MACRO_TEAM_URL in .env)
```

Verified from this box: `curl https://modal.taila95594.ts.net:8444/` → 200, `content-type:
text/html`, ~5.5 KB body. The RevOpt console's Macro panel points at exactly that URL.

## Residual caveat

The panel browser-embeds the tailnet URL. Tailnet hosts reach it; off-tailnet browsers do not
resolve `modal.taila95594.ts.net`. To render off-tailnet, front it through a Zo hosted service or
bind Caddy to a Zo-proxied port instead — a networking choice, not a Bot HQ code change.

## What shipped

- `scripts/macro-gateway.ts` — the Host-rewriting reverse gateway.
- Zen scheduled task `macro-sshtun` — keeps the reverse tunnel up (auto-restart).
- Zo process services `macro-workspace-tls` (Caddy) and `macro-gateway` (bun).
- `.env`: `MACRO_TEAM_URL=https://modal.taila95594.ts.net:8444/`.

## Superseded (original blocker, kept for history)

`macro-desktop-web` (3017) and `macro-desktop-web-build` (3018) were Up but not serving — TCP
connected, HTTP closed the connection — while the container ran a nix rebuild of the Rust
toolchain. That build completed and the frontend now serves.

### Original decision list (option (c) was chosen)

1. (a) Local compose stack on Zen; (b) hosted macro.com; (c) **point Bot HQ at the desktop
   frontend once it serves (3017/3018), embedded under Team** — chosen.
2. **Iframe vs. bot tool** — iframe, since the Zen frontend serves on a reachable (tailnet) URL.
