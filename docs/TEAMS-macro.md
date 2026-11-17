# Bot HQ — slice 3 (Macro Team sub-app): status + decision needed

Date: 2026-11-17

## What I verified this pass

- Slices 1–2 are **shipped and green**: `npm run typecheck` 0 errors, `npm test -w server` 18/18 pass,
  working tree clean, `HEAD = 2ba7745` pushed to `origin/main`.
- Live service is healthy: `http://127.0.0.1:8797/api/health` → `{"ok":true,"engine":"hermes"}`.
- Teams API is mounted at `/api/rooms` (list, create, members GET/PUT, lead, brief GET/PUT, role, humans).
  Reference: `docs/TEAMS.md`.

## Slice 3 scope (from `docs/TEAMS.md` "Still open")

Surface the **Macro** sub-app under the **Team** label: Docker stack on the Zen laptop,
`macro-desktop-web` on `127.0.0.1:3017`. Iframe vs. bot-tool is undecided.

## Blocker found on Zen (real, not theoretical)

`macro-desktop-web` (3017) and `macro-desktop-web-build` (3018) are **Up** but **not serving** —
TCP connects, HTTP closes the connection. `docker logs macro-desktop-web` shows the container is
mid-**nix rebuild of the Rust toolchain** (`rust-std 1.94.0`, `rustc 1.94.0`, llvm/clang 21.1.8,
playwright, cargo-lambda). It has been building for hours and will keep re-building because the
image is a from-source dev image (`Dockerfile.dev`), not a prebuilt runtime.

Also: `docker ps` shows **no Macro backend/DB** (postgres/redis/kafka not up). Only the frontend
containers exist. Ports 5432/6379 are already held by `honcho-quanta-core`.

## Decision needed before building

1. **Which Macro endpoint does the Team sub-app point at?**
   - (a) Local compose stack on Zen — needs the full build to finish + backend/db up; heavy, and
     port-conflicts with honcho-quanta-core.
   - (b) Hosted `macro.com` / `*-dev` services, frontend-only — light, no docker, but requires a
     Macro account/session and outbound access from the Zen browser.
   - (c) **Point Bot HQ at the desktop frontend once it serves** (`3017`), embedded under Team.
2. **Iframe vs. bot tool.** Iframe is fastest if the Zen frontend serves on a reachable URL; a bot
   tool is needed if the app is only reachable inside the Zen desktop and must be driven by a Bot.

## Recommendation

Don't build the embed against a container that isn't serving. Two concrete unblocks, pick one:

- **Fast path:** get the Zen Macro frontend actually answering on 3017 (prove with a real 200 +
  HTML body), then embed it under the Team label behind a `VITE_MACRO_TEAM_URL` build constant
  (mirrors the existing `VITE_T3_WORKSPACE_URL` pattern, which is already a build-time constant).
- **Heavy path:** stand up the Macro backend (postgres/redis/kafka on free ports, e.g. 55432/56379)
  so the local stack is functional, then embed.

Until the Zen frontend serves a real HTTP 200, slice 3 is an infra task on Zen, not a Bot HQ code task.
