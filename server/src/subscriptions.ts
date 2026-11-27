import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { primaryProviderAuth } from './engine.js';
import { env } from './env.js';
import type { Subscription } from './types.js';

/**
 * Which model subscriptions the bots' computer is signed in to, and on which plan. Read from the
 * sign-in files the harnesses keep on that computer. Only plan facts leave this module: never a token.
 */

const home = os.homedir();
const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(home, file), 'utf8')); } catch { return null; } };

/** The claims of a JWT, without checking its signature (it is our own file; we only read the plan from it). */
function claims(jwt: unknown): any {
  if (typeof jwt !== 'string') return null;
  try { return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return null; }
}

const PLAN_NAMES: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', max: 'Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
/** A known plan by name; anything else only if it is a short plain word, so nothing token-like is ever passed on. */
function planName(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  const key = p.toLowerCase();
  // Own keys only: 'constructor' or '__proto__' must not reach Object.prototype.
  const known = Object.prototype.hasOwnProperty.call(PLAN_NAMES, key) ? PLAN_NAMES[key] : undefined;
  if (known) return known;
  return /^[a-z][a-z0-9_-]{0,23}$/i.test(p) ? p.charAt(0).toUpperCase() + p.slice(1).replace(/[_-]+/g, ' ') : null;
}

/** Pi's own folder: PI_CODING_AGENT_DIR when set, else ~/.pi/agent. */
const piDir = () => process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');

export async function listSubscriptions(): Promise<Subscription[]> {
  const auth = await primaryProviderAuth();
  // Hermes here is the main agent; null when it does not answer, so its rows read "could not tell", not "signed out".
  const hermes = (id: string) => (auth ? !!auth[id] : null);

  // ChatGPT: the Codex CLI keeps an id_token whose claims carry the plan and when it runs out.
  const codex = readJson('.codex/auth.json');
  const openaiClaims = claims(codex?.tokens?.id_token)?.['https://api.openai.com/auth'] ?? {};
  const codexSignedIn = !!codex?.tokens?.access_token;

  // Claude: Claude Code stores the plan beside its tokens.
  const claude = readJson('.claude/.credentials.json')?.claudeAiOauth ?? null;
  const claudeCodeSignedIn = !!claude?.accessToken;

  // Pi keeps one entry per provider it has a key or login for.
  const pi = readJson(path.join(piDir(), 'auth.json')) ?? {};

  const rows: Subscription[] = [
    {
      id: 'openai',
      name: 'ChatGPT',
      plan: planName(openaiClaims.chatgpt_plan_type),
      renews: typeof openaiClaims.chatgpt_subscription_active_until === 'string' ? openaiClaims.chatgpt_subscription_active_until : null,
      kind: 'subscription',
      harnesses: [
        { name: 'Codex', signedIn: codexSignedIn },
        { name: 'Hermes', signedIn: hermes('openai-codex') },
      ],
    },
    {
      id: 'anthropic',
      name: 'Claude',
      plan: planName(claude?.subscriptionType),
      renews: null,
      kind: 'subscription',
      harnesses: [
        { name: 'Claude Code', signedIn: claudeCodeSignedIn },
        { name: 'Hermes', signedIn: hermes('anthropic') },
      ],
    },
    {
      id: 'xai',
      name: 'Grok',
      plan: null,
      renews: null,
      kind: auth && !auth['xai-oauth'] && auth.xai ? 'api_key' : 'subscription',
      harnesses: [{ name: 'Hermes', signedIn: auth ? !!(auth['xai-oauth'] || auth.xai) : null }],
    },
    {
      id: 'ollama-cloud',
      name: 'Ollama Cloud',
      plan: null,
      renews: null,
      kind: 'api_key',
      harnesses: [
        { name: 'Hermes', signedIn: hermes('ollama-cloud') },
        { name: 'Pi', signedIn: !!pi['ollama-cloud'] },
      ],
    },
  ];
  // Connections turned off on this server (HIDDEN_PROVIDERS) are not shown.
  return rows.filter((r) => !env.hiddenProviders.includes(r.id));
}
