# 9Router in Bot HQ: scope and plan

Status: **Phase 1 done 2026-11-24** (9Router 0.5.116 running on Zo, localhost only; combos `hq-google`, `hq-free`, `hq-smart`; no provider keys connected yet). **Phase 2 done the same day:** Hermes provider `9router` added to the primary and all 7 managed bots; it shows in every bot's Engine panel. Hermes reloads provider config live, so no restart was needed.

**Model rule (user decision):** no frontier labs (Anthropic, OpenAI including gpt-oss, xAI) in 9Router. Open-weight models only, plus all new Google models (Gemini + Gemma). This rules out Kiro, OpenCode Free and llm7, so §3's tiers become Google + open-weight hosts (NVIDIA, Cerebras, Groq, Cloudflare).

Original status: scoped. Written 2026-11-23 from the 9Router README (github.com/decolua/9router) and the Bot HQ code as of `448c053`.

## 1. What 9Router is

- A self-hosted proxy (Next.js, MIT license, about 33k stars). It shows one **OpenAI-compatible endpoint**, `http://localhost:20128/v1`, plus a dashboard at `/dashboard`.
- Behind that endpoint it connects to 40+ model providers. It translates request formats (OpenAI, Claude, Gemini, Kiro, Vertex), refreshes OAuth tokens, and falls back to the next provider when one runs out of quota or fails.
- Install: `npm install -g 9router && 9router`, or Docker (`decolua/9router`, data volume at `~/.9router`). Its data is a single SQLite file, `${DATA_DIR}/db/data.sqlite`.
- Clients sign in with a key created in the dashboard (`Authorization: Bearer …`). Models are named `provider/model`, for example `kr/claude-sonnet-4.5`, or by a **combo** name.

### What "free" really means (Nov 2026)

| Source | Actually free? | Notes |
|---|---|---|
| OpenCode Free | Yes, no sign-in | The model list changes often; some models are only free during promotions |
| Kiro | 50 credits/month (+500 trial credits) | Has been paid since Sep 2025 |
| Vertex AI | $300 one-time credit for new GCP accounts | Must go through the Vertex endpoint, not the Gemini API |
| Gemini CLI, Qwen Code, iFlow | **No** | Free tiers ended in 2026 |
| Claude Code / Codex / Copilot / Cursor | No: reuses *your paid plan* through OAuth | ToS risk (see §5) |
| GLM ($0.6/1M), MiniMax ($0.2/1M) | Cheap, not free | Needs an API key |

**Bottom line:** 9Router does not give unlimited free Claude or GPT. What it adds is a small free tier, a cheap tier, automatic fallback between them, token savings, and one usage dashboard.

### The advanced features, and which ones Bot HQ should use

| Feature | What it does | Bot HQ use |
|---|---|---|
| Combos / 3-tier fallback | One model name that tries a list of providers in order | **Core.** The whole simplification is built on this |
| RTK Token Saver | Shrinks tool output (git diff, grep, ls, tree) before the model sees it; claims 20–40% input savings, and keeps the original if a filter fails | **On.** Bots do a lot of tool calls |
| Headroom | Extra compression through an external `headroom proxy` | Off for now (one more service to run) |
| Caveman / Ponytail | Injects terse "speak briefly" system prompts | **Off.** They hurt quality on customer-facing writing (GTM, RevOpt) |
| Multi-account round-robin | Several accounts per provider | Optional, later |
| Quota tracking + usage analytics | Live tokens, reset countdowns, estimated cost | Read it in the 9Router dashboard |
| Self-hosted STT/TTS/embeddings | `/v1/audio/*`, `/v1/embeddings` to llama.cpp, whisper.cpp, etc. | Later; `voice.ts` could use it |
| Cloud Sync | Sends config to `9router.com` | **Off.** It would send provider tokens off the box |

## 2. How Bot HQ calls models today

- Every bot runs on **Hermes** (`server/src/engine.ts`). The primary Hermes has its own config. Managed bots copy `model`, `providers`, `custom_providers` and `fallback_*` from it (`SHARED_CONFIG`, engine.ts:113).
- Other harnesses (`server/src/harness.ts`) are Codex, Claude Code, Pi and OpenCode. Each uses its own sign-in.
- Settings lists subscriptions from `server/src/subscriptions.ts` and providers from Hermes's `/api/model/options` (`WELL_KNOWN`, engine.ts:448).

**This means the integration is mostly configuration:** Hermes already accepts an OpenAI-compatible `custom_providers` entry, and managed bots inherit it without code changes.

## 3. The simplified design

```
 Bot (Hermes / Pi / OpenCode)
        │  model = "hq-free" | "hq-cheap" | "hq-smart"
        ▼
 9Router  127.0.0.1:20128/v1   (Zo process service, not public)
        │  combo fallback + RTK token saver
        ├── Tier 1 (hq-smart only): your API keys (OpenRouter / Anthropic / OpenAI)
        ├── Tier 2: GLM, MiniMax           (cheap)
        └── Tier 3: OpenCode Free → Kiro → Vertex   (free)
```

**Users see three model names, not 40 providers.** All provider setup lives in 9Router. Bot HQ only chooses one of three combos:

- `hq-free`: OpenCode Free → Kiro → Vertex. Costs nothing and has the lowest quality. Good for triage, summaries and background bots.
- `hq-cheap`: GLM → MiniMax → `hq-free`.
- `hq-smart`: your paid API key(s) → `hq-cheap`. It never stops: when quota runs out, it steps down a tier.

Claude Code and Codex keep their **direct** sign-ins, exactly as they work today. They are not routed through 9Router.

## 4. Build plan

**Phase 1: run it on Zo (about 1 hour, ops only)**
1. Install a pinned version (`npm i -g 9router@<exact>`). Do not use `latest`, because this package handles OAuth tokens.
2. Register a Zo **process** service `9router`: `PORT=20128 HOSTNAME=127.0.0.1 DATA_DIR=/root/.9router REQUIRE_API_KEY=true`, with `INITIAL_PASSWORD`, `JWT_SECRET`, `API_KEY_SECRET` and `MACHINE_ID_SALT` set to random values in root-only files. This uses no web-service slot (Zo's 5 slots are full).
3. In the dashboard: Cloud Sync off, RTK on, Caveman/Ponytail off. Connect OpenCode Free, Kiro and (optionally) GLM/MiniMax/Vertex. Create the 3 combos. Create a key for Bot HQ in `/root/.9router/bothq.key` (mode 600).

**Phase 2: connect Hermes (about 30 min, config only)**
4. Add to the primary Hermes config:
   ```yaml
   custom_providers:
     - name: 9router
       base_url: http://127.0.0.1:20128/v1
       api_key: <from bothq.key>
       models: [hq-free, hq-cheap, hq-smart]
   ```
   Managed bots get it on their next provisioning through `SHARED_CONFIG`.
5. Optionally set Hermes `fallback_model` to `9router/hq-free`, so any bot whose main provider fails drops to free instead of erroring.

**Phase 3: Bot HQ code (about half a day)**
6. New `server/src/ninerouter.ts`: a health check via `GET /v1/models`, and an env var `NINEROUTER_URL` + `NINEROUTER_KEY_FILE` in `env.ts`.
7. `subscriptions.ts`: a "9Router (Free / Cheap / Smart)" row, `kind: 'api_key'`, signed in = the health check passes.
8. `engine.ts`: add `9router` to `WELL_KNOWN` so it shows in each bot's Engine panel even when it is down.
9. Pi / OpenCode harnesses: write a `9router` OpenAI-compatible provider into their per-bot config, so those harnesses can choose `hq-*` too.
10. Optional: proxy the dashboard at `/9router/*` behind Bot HQ sign-in, like `/buildflow/*`. **Risk:** it is a Next.js app that expects to be served from `/`, so asset paths may break under a sub-path. Check this first, and fall back to an SSH tunnel for admin use.

**Phase 4: verify**
11. One bot on `hq-free` finishes a tool-using turn. Kill the first provider in the combo and confirm the fallback happens. Confirm RTK savings show in the 9Router usage page.

## 5. Risks and decisions

- **ToS (important):** connecting your Claude Pro/Max or ChatGPT Plus/Pro OAuth to a proxy and sharing it across several bots is very likely outside Anthropic's and OpenAI's consumer terms, and can get the account banned. Recommendation: **do not connect subscription OAuth providers in 9Router.** Use it only for free tiers and API keys.
- **Supply chain:** a community npm package holds provider tokens. Pin the version, run it on localhost only, and review the changelog before upgrading.
- **Insecure defaults:** dashboard password `123456`, no client API key required, default secrets. Phase 1 step 2 changes all of these.
- **Free tiers move:** three free tiers ended in 2026. Combos absorb this (a dead provider is skipped), but expect `hq-free` quality to drift.
- **Cost display is an estimate:** 9Router shows "what this would have cost", not real spend.

## 6. Check during install (the README left these open)

- Does it expose Anthropic-native `/v1/messages`? This only matters if Claude Code should ever use 9Router; the plan doesn't need it.
- Is `npm i -g 9router` the supported path? The README also calls the package private, so Docker may be the fallback.
- Is there a usage/quota API Bot HQ could read for an in-app usage card? If not, use the dashboard only.
- Can it be served under a sub-path (Phase 3 step 10)?
