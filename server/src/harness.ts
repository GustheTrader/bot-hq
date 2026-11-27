import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { env } from './env.js';
import { displayFor } from './box.js';
import { db } from './db.js';
import { engineKind, mcpToken } from './engine.js';

/**
 * Harnesses: the agent program that runs a bot's turns. Hermes is the built-in one (agent/loop.ts
 * talks to its gateway). The others speak ACP, the Agent Client Protocol: JSON-RPC over the stdio of
 * an adapter process. This file runs that conversation and turns the agent's updates into the same
 * events Hermes streams, so the turn loop treats every harness alike.
 */

export type HarnessId = 'hermes' | 'codex' | 'claude-code' | 'pi' | 'opencode' | 'deepseek';

interface HarnessDef { id: HarnessId; name: string; subscription: string; command?: string[] }

export const HARNESSES: HarnessDef[] = [
  { id: 'hermes', name: 'Hermes', subscription: 'Any provider set in its Engine panel' },
  { id: 'codex', name: 'Codex', subscription: 'ChatGPT', command: ['codex-acp'] },
  { id: 'claude-code', name: 'Claude Code', subscription: 'Claude', command: ['claude-agent-acp'] },
  { id: 'pi', name: 'Pi', subscription: 'Its own providers', command: ['pi-acp'] },
  { id: 'opencode', name: 'OpenCode', subscription: 'Its own providers', command: ['opencode', 'acp'] },
  { id: 'deepseek', name: 'DeepSeek Harness', subscription: 'Its own providers', command: ['dsh', '--profile', 'acp'] },
];

export const isHarnessId = (v: unknown): v is HarnessId => HARNESSES.some((h) => h.id === v);

const installed = new Map<string, boolean>();
/** Whether the harness's program is on this machine (Hermes always is: it runs the bots). */
export function harnessInstalled(h: HarnessDef): boolean {
  if (!h.command) return true;
  const bin = h.command[0];
  if (!installed.has(bin)) installed.set(bin, spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0);
  return installed.get(bin)!;
}

export interface HarnessEvent { type: string; data: any }

// ---------- one ACP agent process per bot ----------

interface Session { id: string; conversation: string; info: any; defaultModel: string | null; applied: { model: string | null; effort: string | null } }
interface Agent { child: ChildProcess; botId: string; harness: HarnessId; nextId: number; waiting: Map<number, (m: any) => void>; session: Session | null; onUpdate: ((u: any) => void) | null; dead: boolean }

const agents = new Map<string, Agent>();

/**
 * One subscription serves every bot on that harness, and the plans meter how many sessions may run at once
 * (a third Claude Code session on one plan is the classic "it just hangs"). A turn waits for a slot instead
 * of failing, so the queue shows up as a slow turn rather than an error nobody can read.
 * BH_MAX_CONCURRENT_<HARNESS> overrides per harness; BH_MAX_CONCURRENT sets every harness. 0 = no cap.
 */
const TURN_LIMIT = (id: HarnessId): number => {
  const raw = process.env[`BH_MAX_CONCURRENT_${id.toUpperCase()}`] ?? process.env.BH_MAX_CONCURRENT ?? '2';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const turnSlots = new Map<HarnessId, { active: number; waiters: (() => void)[] }>();

/** Runs `fn` once this harness has a free turn slot. An aborted turn gives its place back. */
export async function withTurnSlot<T>(id: HarnessId, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const limit = TURN_LIMIT(id);
  if (limit === 0) return fn();
  let slot = turnSlots.get(id);
  if (!slot) turnSlots.set(id, (slot = { active: 0, waiters: [] }));
  while (slot.active >= limit) {
    const parked = slot;
    await new Promise<void>((resolve) => {
      const wake = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const i = parked.waiters.indexOf(wake);
        if (i >= 0) parked.waiters.splice(i, 1);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      parked.waiters.push(wake);
    });
    if (signal.aborted) throw new Error('interrupted');
  }
  slot.active++;
  try {
    return await fn();
  } finally {
    slot.active--;
    // The waiter re-checks the cap when it wakes and takes the slot itself; counting it here would
    // count one turn twice and shrink the cap by one per turn.
    slot.waiters.shift()?.();
  }
}
/** Bots being deleted: no harness may start for them again. */
const retired = new Set<string>();
const LIB_ROOT = '/root/grokbot/files';

function send(a: Agent, msg: object) { a.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); }

function call(a: Agent, method: string, params: object): Promise<any> {
  return new Promise((resolve, reject) => {
    if (a.dead) return reject(new Error('the harness stopped'));
    const id = a.nextId++;
    a.waiting.set(id, (m) => (m.error ? reject(new Error(String(m.error.message ?? 'harness error'))) : resolve(m.result)));
    send(a, { id, method, params });
  });
}

/** The agent asks something of us. */
async function answer(a: Agent, m: any) {
  if (m.method === 'session/request_permission') return permission(a, m);
  send(a, { id: m.id, error: { code: -32601, message: `${m.method} is not offered by this client` } });
}

/**
 * How a harness's permission request is answered. `ask` puts it in the conversation as an approval
 * card and waits, the same way the MCP tools do, and a standing "always allow" for that user and
 * kind answers it without a card. `allow` is the old behaviour, where every request was granted;
 * `deny` refuses everything, for a bot that should not touch its machine at all.
 */
const permissionMode = (): 'ask' | 'allow' | 'deny' => {
  const v = String(process.env.BH_HARNESS_PERMISSIONS ?? 'ask').toLowerCase();
  return v === 'allow' || v === 'deny' ? v : 'ask';
};

async function permission(a: Agent, m: any) {
  const opts: any[] = Array.isArray(m.params?.options) ? m.params.options : [];
  const allowPick = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => String(o.kind).startsWith('allow'));
  const denyPick = opts.find((o) => o.kind === 'reject_once') ?? opts.find((o) => String(o.kind).startsWith('reject'));
  const reply = (pick: any) =>
    send(a, { id: m.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } });

  const mode = permissionMode();
  const call = m.params?.toolCall ?? {};
  const kind = String(call.kind ?? 'other');
  const key = `harness:${kind}`;
  const title = String(call.title ?? kind);

  if (mode === 'allow') return reply(allowPick);
  if (mode === 'deny') return reply(denyPick);

  try {
    const userId = (db.prepare('SELECT user_id FROM bots WHERE id=?').get(a.botId) as any)?.user_id;
    if (!userId) return reply(denyPick);
    const standing = db.prepare("SELECT 1 FROM policies WHERE user_id=? AND tool=? AND mode='always_allow'").get(userId, key);
    if (standing) return reply(allowPick);
    const { requestApproval } = await import('./agent/loop.js');
    const decision = await requestApproval(
      { userId, botId: a.botId },
      { key, title: `harness: ${title}` },
      call.rawInput ?? { title, kind, locations: call.locations },
      null,
    );
    reply(decision === 'allow' ? allowPick : denyPick);
  } catch {
    reply(denyPick);
  }
}

/**
 * Per-bot home and tool config dirs. Default `isolated`: every bot gets its own HOME, CODEX_HOME,
 * CLAUDE_CONFIG_DIR and PI_CODING_AGENT_DIR under BH_HOME_ROOT, and the shared config dirs are
 * symlinked in rather than copied, so a sign-in done once keeps working (and rotating it updates
 * every bot). `shared` keeps the old behaviour: one set of dirs for the whole server.
 */
const BOT_HOME_MODE = (process.env.BH_BOT_HOME ?? 'isolated').toLowerCase();
const HOME_ROOT = process.env.BH_HOME_ROOT ?? `${LIB_ROOT}/.homes`;
const SHARED_CONFIG = {
  codex: process.env.CODEX_HOME ?? `${os.homedir()}/.codex`,
  claude: process.env.CLAUDE_CONFIG_DIR ?? `${os.homedir()}/.claude`,
  pi: process.env.PI_CODING_AGENT_DIR ?? `${os.homedir()}/.pi/agent`,
  claudeJson: `${os.homedir()}/.claude.json`,
};
/** What stays shared per tool: the sign-in, the model list, the skills. Everything else is per-bot. */
function sharedLinks(dirs: Record<string, string>): [to: string, from: string][] {
  return [
    [`${dirs.CODEX_HOME}/auth.json`, `${SHARED_CONFIG.codex}/auth.json`],
    [`${dirs.CODEX_HOME}/config.toml`, `${SHARED_CONFIG.codex}/config.toml`],
    [`${dirs.CODEX_HOME}/skills`, `${SHARED_CONFIG.codex}/skills`],
    [`${dirs.CLAUDE_CONFIG_DIR}/.claude.json`, SHARED_CONFIG.claudeJson],
    [`${dirs.CLAUDE_CONFIG_DIR}/.credentials.json`, `${SHARED_CONFIG.claude}/.credentials.json`],
    [`${dirs.CLAUDE_CONFIG_DIR}/settings.json`, `${SHARED_CONFIG.claude}/settings.json`],
    [`${dirs.CLAUDE_CONFIG_DIR}/skills`, `${SHARED_CONFIG.claude}/skills`],
    [`${dirs.CLAUDE_CONFIG_DIR}/plugins`, `${SHARED_CONFIG.claude}/plugins`],
    [`${dirs.CLAUDE_CONFIG_DIR}/policy-limits.json`, `${SHARED_CONFIG.claude}/policy-limits.json`],
    [`${dirs.PI_CODING_AGENT_DIR}/auth.json`, `${SHARED_CONFIG.pi}/auth.json`],
    [`${dirs.PI_CODING_AGENT_DIR}/models.json`, `${SHARED_CONFIG.pi}/models.json`],
    [`${dirs.PI_CODING_AGENT_DIR}/models-store.json`, `${SHARED_CONFIG.pi}/models-store.json`],
    [`${dirs.PI_CODING_AGENT_DIR}/settings.json`, `${SHARED_CONFIG.pi}/settings.json`],
    [`${dirs.PI_CODING_AGENT_DIR}/skills`, `${SHARED_CONFIG.pi}/skills`],
    // Identity, not config: a bot that cannot see these cannot push or sign a commit, and it could
    // see them anyway when HOME was the server's own (the behaviour this replaces).
    [`${dirs.HOME}/.gitconfig`, `${os.homedir()}/.gitconfig`],
    [`${dirs.HOME}/.git-credentials`, `${os.homedir()}/.git-credentials`],
    [`${dirs.HOME}/.ssh`, `${os.homedir()}/.ssh`],
    [`${dirs.HOME}/.config/gh`, `${os.homedir()}/.config/gh`],
  ];
}

/**
 * The env a bot's harness processes get for home and config. Bots must not share these: a harness
 * turn can read anything in its own config dir, including another bot's transcripts. Credentials are
 * symlinked from the shared dirs, so one sign-in still serves every bot.
 */
export function botEnvDirs(botId: string): Record<string, string> {
  if (BOT_HOME_MODE === 'shared') return {};
  const root = `${HOME_ROOT}/${botId}`;
  const home = `${root}/home`;
  const dirs: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_RUNTIME_DIR: `${home}/.run`,
    CODEX_HOME: `${root}/codex`,
    CLAUDE_CONFIG_DIR: `${root}/claude`,
    PI_CODING_AGENT_DIR: `${root}/pi`,
  };
  try {
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.mkdirSync(`${dirs.HOME}/.config`, { recursive: true, mode: 0o700 });
    for (const [to, from] of sharedLinks(dirs)) {
      if (fs.existsSync(to) || !fs.existsSync(from)) continue;
      fs.symlinkSync(from, to);
    }
  } catch { /* a missing link costs a sign-in, not the turn */ }
  return dirs;
}

const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG',
  // Model keys the harness itself reads from the environment (the DeepSeek Harness); the ACP
  // agents that keep keys in files get them through their config dirs instead.
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'];
function harnessEnv(screenId: string | null, harness?: HarnessId, botId?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) out[k] = process.env[k];
  // pi-acp starts `pi` itself; the wrapper adds --approve so the bot's own .pi/mcp.json (which
  // carries the app's hq server) is read without an interactive trust prompt.
  if (harness === 'pi') out.PI_ACP_PI_COMMAND = fileURLToPath(new URL('../scripts/pi-trusted', import.meta.url));
  // Its windows and browser land on the bot's own screen.
  return { ...out, ...(botId ? botEnvDirs(botId) : {}), DISPLAY: displayFor(screenId), NO_COLOR: '1' };
}

/**
 * pi-acp prints a startup block (version, skills, extensions) at the start of a session's first
 * prompt, which would land in front of the bot's reply. Pi's project settings in the bot's folder
 * turn it off, leaving the user's own Pi settings alone.
 */
function quietPi(cwd: string) {
  const file = `${cwd}/.pi/settings.json`;
  try {
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    if (settings.quietStartup === true) return;
    fs.mkdirSync(`${cwd}/.pi`, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...settings, quietStartup: true }, null, 2));
  } catch { /* the banner shows; nothing else depends on it */ }
}

/**
 * Pi's own MCP config for this bot. pi-acp accepts `mcpServers` in session/new but never connects
 * them (it advertises `mcpCapabilities: { http: false, sse: false }`), so Pi is given the app's
 * tools the way Pi reads them: `.pi/mcp.json` in the bot's folder, trusted by the wrapper above.
 */
function piHqConfig(cwd: string, botId: string) {
  const slug = engineKind(botId) === 'primary' ? 'primary' : botId;
  const file = `${cwd}/.pi/mcp.json`;
  const want = {
    mcpServers: {
      hq: {
        url: `${env.mcpBaseUrl}/mcp/${slug}`,
        headers: { Authorization: `Bearer ${mcpToken(slug)}` },
      },
    },
  };
  try {
    fs.mkdirSync(`${cwd}/.pi`, { recursive: true });
    const now = JSON.stringify(want, null, 2);
    let have = '';
    try { have = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    if (have !== now) fs.writeFileSync(file, now);
  } catch { /* Pi runs without the app's tools; the turn still works */ }
}

/** `key` names the process in `agents`: the bot's id, or a separate one for a settings check. */
function startAgent(key: string, botId: string, harness: HarnessDef, screenId: string | null): Agent {
  const [cmd, ...args] = harness.command!;
  const cwd = `${LIB_ROOT}/${botId}`;
  fs.mkdirSync(cwd, { recursive: true });
  if (harness.id === 'pi') { quietPi(cwd); piHqConfig(cwd, botId); }
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so stopping it also stops what it started (Codex runs a helper process).
    detached: true,
    env: harnessEnv(screenId, harness.id, botId),
  });
  const a: Agent = { child, botId, harness: harness.id, nextId: 1, waiting: new Map(), session: null, onUpdate: null, dead: false };
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && !m.method && a.waiting.has(m.id)) { a.waiting.get(m.id)!(m); a.waiting.delete(m.id); }
      else if (m.method === 'session/update') a.onUpdate?.(m.params?.update);
      else if (m.method && m.id !== undefined) void answer(a, m).catch(() => { /* the harness gets no reply; the turn fails, the server stays up */ });
    }
  });
  child.stderr?.on('data', () => { /* adapters log here; not ours to show */ });
  const gone = () => {
    a.dead = true;
    for (const w of a.waiting.values()) w({ error: { message: 'the harness stopped' } });
    a.waiting.clear();
    if (agents.get(key) === a) agents.delete(key);
  };
  child.on('exit', gone);
  child.on('error', gone);
  return a;
}

async function agentFor(key: string, botId: string, harness: HarnessDef, screenId: string | null): Promise<Agent> {
  if (retired.has(botId)) throw new Error('this Bot is being removed');
  const have = agents.get(key);
  if (have && !have.dead && have.harness === harness.id) return have;
  if (have) stopHarness(key);
  const a = startAgent(key, botId, harness, screenId);
  agents.set(key, a);
  await call(a, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  return a;
}

/** The bot is being deleted: stop its harness and never start one for it again. */
export function retireHarness(botId: string) {
  retired.add(botId);
  stopHarness(botId);
  stopHarness(checkKey(botId));
}

/** The process a settings check runs in, apart from the bot's own conversation. */
const checkKey = (botId: string) => `${botId}~check`;

export interface HarnessModels { models: { value: string; name: string }[]; current: string | null }
const modelLists = new Map<HarnessId, { at: number; data: HarnessModels }>();
const modelListing = new Map<HarnessId, Promise<HarnessModels>>();
const MODEL_LIST_TTL = 10 * 60_000;

/**
 * The models a harness offers with its sign-in on this computer, as it lists them when a session
 * starts. Read from a short-lived process of its own (no bot, no tools) and kept for ten minutes.
 */
export function harnessModels(harness: HarnessId): Promise<HarnessModels> {
  const hit = modelLists.get(harness);
  if (hit && Date.now() - hit.at < MODEL_LIST_TTL) return Promise.resolve(hit.data);
  const going = modelListing.get(harness);
  if (going) return going;
  const p = (async () => {
    const def = HARNESSES.find((h) => h.id === harness);
    if (!def?.command) return { models: [], current: null };
    if (!harnessInstalled(def)) throw new Error(`${def.name} is not installed on the computer`);
    const key = `~models~${harness}`;
    const timer = setTimeout(() => stopHarness(key), 60_000);
    try {
      const a = await agentFor(key, '_models', def, null);
      const r = await call(a, 'session/new', { cwd: `${LIB_ROOT}/_models`, mcpServers: [] });
      const c = choicesOf(r, MODEL_OPTION);
      const data: HarnessModels = { models: c?.values ?? [], current: c?.option.currentValue ?? null };
      modelLists.set(harness, { at: Date.now(), data });
      return data;
    } finally {
      clearTimeout(timer);
      stopHarness(key);
    }
  })().finally(() => modelListing.delete(harness));
  modelListing.set(harness, p);
  return p;
}

/** Stop the bot's harness process (harness changed, new chat). Its next turn starts a fresh one. */
export function stopHarness(botId: string) {
  const a = agents.get(botId);
  if (!a) return;
  agents.delete(botId);
  try { if (a.child.pid) process.kill(-a.child.pid, 'SIGTERM'); else a.child.kill('SIGTERM'); } catch { /* already gone */ }
}

/**
 * The app's tools for this bot, as an MCP server the harness connects to.
 *
 * pi-acp's session/new schema wants `{ type, id, url, headers, env }` on every entry and rejects a
 * stdio one, so Pi gets the same http server with the fields its schema requires.
 */
function hqTools(botId: string, harness?: HarnessId) {
  const slug = engineKind(botId) === 'primary' ? 'primary' : botId;
  const url = `${env.mcpBaseUrl}/mcp/${slug}`;
  const auth = `Bearer ${mcpToken(slug)}`;
  // pi-acp accepts an entry here but never connects it (mcpCapabilities http:false), so Pi is given
  // the app's tools through its own .pi/mcp.json instead (piHqConfig) and handed nothing here.
  if (harness === 'pi') return [];
  return [{ type: 'http', name: 'hq', url, headers: [{ name: 'Authorization', value: auth }] }];
}

/** ACP tool kinds that are the agent thinking or checking itself, not a step worth a row. */
const QUIET_KINDS = new Set(['think', 'switch_mode']);

/**
 * Settings a harness offers per session, applied when it has them:
 *  - a full-access mode (Codex: agent-full-access). Its sandbox cannot start inside the computer's own
 *    sandbox, so every command would fail once before running unsandboxed; Hermes' tools run with
 *    the same access.
 *  - the bot's model and reasoning effort, when the harness has those options and the values.
 */
async function setUpSession(a: Agent, sessionId: string, session: any, want: Wanted): Promise<Applied> {
  const modes: any[] = Array.isArray(session?.modes?.availableModes) ? session.modes.availableModes : [];
  const full = modes.find((m) => /full[-_]?access/i.test(String(m?.id ?? '')));
  if (full && session?.modes?.currentModeId !== full.id) await call(a, 'session/set_mode', { sessionId, modeId: full.id }).catch(() => {});
  return applySettings(a, sessionId, session, want, { model: null, effort: null });
}

interface Wanted { model?: string | null; effort?: string }
interface Applied { model: string | null; effort: string | null }

/**
 * Session settings by what they are, not their name: harnesses call effort reasoning_effort (Codex),
 * effort (Claude Code) or thought_level (Pi), but all mark it with the thought_level category.
 */
const MODEL_OPTION = (o: any) => o?.category === 'model' || o?.id === 'model';
const EFFORT_OPTION = (o: any) => o?.category === 'thought_level' || o?.id === 'reasoning_effort';

/** A session's choices for a setting, as values and the names the harness gives them. */
function choicesOf(session: any, which: (o: any) => boolean): { option: any; values: { value: string; name: string }[] } | null {
  const options: any[] = Array.isArray(session?.configOptions) ? session.configOptions : [];
  const option = options.find(which);
  if (!option) return null;
  const values = (Array.isArray(option.options) ? option.options : [])
    .map((x: any) => ({ value: String(x?.value ?? x?.id ?? ''), name: String(x?.name ?? x?.value ?? x?.id ?? '') }))
    .filter((x: { value: string }) => x.value);
  return { option, values };
}

/** Set one session option to `want` if the harness offers that value and it differs from what is set. */
async function applyOption(a: Agent, sessionId: string, session: any, which: (o: any) => boolean, want: string | null | undefined, current: string | null): Promise<string | null> {
  const c = choicesOf(session, which);
  const now = current ?? c?.option.currentValue ?? null;
  if (!want || !c || !c.values.some((v) => v.value === want) || now === want) return now;
  const ok = await call(a, 'session/set_config_option', { sessionId, configId: c.option.id, value: want }).then((res) => {
    // The answer carries the session's options as they are now (a new model can bring other effort levels).
    if (Array.isArray(res?.configOptions) && session) session.configOptions = res.configOptions;
    return true;
  }, () => false);
  return ok ? want : now;
}

/** The bot's model, then its effort (a model change can reset the effort choices). */
async function applySettings(a: Agent, sessionId: string, session: any, want: Wanted, now: Applied): Promise<Applied> {
  const model = await applyOption(a, sessionId, session, MODEL_OPTION, want.model, now.model);
  const effort = await applyOption(a, sessionId, session, EFFORT_OPTION, want.effort, now.effort);
  return { model, effort };
}

/** ACP tool kinds as the names the app already labels (see agent/tools.ts activityFor). */
const KIND_NAMES: Record<string, string> = { execute: 'terminal', edit: 'write_file', delete: 'write_file', move: 'write_file', read: 'read_file', search: 'search_files', fetch: 'web_extract' };

/** A call to one of the app's own tools keeps the name the app knows it by (mcp_hq_<tool>). */
function toolName(u: any): string {
  const input = u?.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {};
  const server = input.server ?? input.server_name ?? input.mcp_server;
  const tool = input.tool ?? input.tool_name ?? input.name;
  if (server === 'hq' && typeof tool === 'string') return `mcp_hq_${tool}`;
  const title = typeof u?.title === 'string' ? u.title : '';
  const m = /^(?:mcp__)?hq(?:__|\.|\/|: ?)([A-Za-z0-9_]+)/.exec(title);
  if (m) return `mcp_hq_${m[1]}`;
  return KIND_NAMES[u?.kind] ?? 'tool';
}

function outputText(u: any): string {
  const raw = u?.rawOutput;
  if (raw && typeof raw === 'object') {
    if (typeof raw.formatted_output === 'string') return raw.formatted_output;
    if (typeof raw.output === 'string') return raw.output;
  }
  const parts: any[] = Array.isArray(u?.content) ? u.content : [];
  return parts.map((p) => p?.content?.text ?? p?.text ?? '').join('');
}

/**
 * Run one turn on an ACP harness. Yields Responses-API-shaped events (output_text deltas,
 * function_call items and their outputs) for agent/loop.ts.
 *
 * `instructions` go in front of the first prompt of each conversation, as ACP has no system prompt.
 */
export async function* harnessTurn(opts: {
  botId: string; harness: HarnessId; screenId: string | null; conversation: string; input: string; instructions: string; effort?: string; signal: AbortSignal;
  /** The model picked for this harness; null keeps the harness's own default. */
  model?: string | null;
  /** A settings check: its own process, without the app's tools, stopped when the turn ends. */
  check?: boolean;
  /** Run in a process of its own under this name (with the app's tools), stopped when the turn ends: the wiki's task tests. */
  isolate?: string;
}): AsyncGenerator<HarnessEvent> {
  const def = HARNESSES.find((h) => h.id === opts.harness);
  if (!def?.command) throw new Error(`${opts.harness} is not an ACP harness`);
  if (!harnessInstalled(def)) throw new Error(`${def.name} is not installed on the computer`);
  const apart = opts.check || !!opts.isolate;
  const key = opts.check ? checkKey(opts.botId) : opts.isolate ? `${opts.botId}~${opts.isolate}` : opts.botId;
  if (apart) stopHarness(key); // every check starts clean, with the settings saved now
  let a = await agentFor(key, opts.botId, def, opts.screenId);
  // One conversation per process: a New chat starts a fresh one, so old sessions never pile up.
  if (a.session && a.session.conversation !== opts.conversation) {
    stopHarness(key);
    a = await agentFor(key, opts.botId, def, opts.screenId);
  }
  if (opts.signal.aborted) { if (apart) stopHarness(key); throw new Error('interrupted'); }
  try { yield* runPrompt(a, def, opts); } finally { if (apart) stopHarness(key); }
}

async function* runPrompt(a: Agent, def: HarnessDef, opts: {
  botId: string; conversation: string; input: string; instructions: string; effort?: string; model?: string | null; signal: AbortSignal; check?: boolean;
}): AsyncGenerator<HarnessEvent> {
  let first = false;
  if (!a.session) {
    const r = await call(a, 'session/new', { cwd: `${LIB_ROOT}/${opts.botId}`, mcpServers: opts.check ? [] : hqTools(opts.botId, def.id) });
    const id = String(r?.sessionId ?? '');
    if (!id) throw new Error(`${def.name} did not start a session`);
    // The harness's own default, kept so going back to "default" later sets it again.
    const defaultModel = choicesOf(r, MODEL_OPTION)?.option.currentValue ?? null;
    a.session = { id, conversation: opts.conversation, info: r, defaultModel, applied: { model: null, effort: null } };
    a.session.applied = await setUpSession(a, id, r, { model: opts.model ?? defaultModel, effort: opts.effort });
    first = true;
  } else {
    // The bot's model or effort may have changed since the session started.
    a.session.applied = await applySettings(a, a.session.id, a.session.info, { model: opts.model ?? a.session.defaultModel, effort: opts.effort }, a.session.applied);
  }
  // A model the harness did not take must not pass for the one that was picked.
  if (opts.model && a.session.applied.model !== opts.model) {
    throw new Error(`${def.name} does not offer the model “${opts.model}”. Pick another model in the Engine panel.`);
  }
  const sessionId = a.session.id;
  const text = first && opts.instructions ? `${opts.instructions}\n\n---\n\n${opts.input}` : opts.input;

  // Updates arrive while the prompt call is open; queue them for the generator.
  const queue: HarnessEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  // Whether the turn produced anything: a harness that cannot reach its model may end it with nothing.
  let said = false;
  const push = (e: HarnessEvent) => { if (e.type !== 'response.reasoning_text.delta') said = true; queue.push(e); wake?.(); };
  const quiet = new Set<string>();
  // A call is shown once we know what it is (its input, or it has started or ended), merging fields
  // that later updates fill in, so a call to one of the app's tools keeps its name.
  const calls = new Map<string, { u: any; shown: boolean }>();
  const showCall = (id: string) => {
    const c = calls.get(id);
    if (!c || c.shown) return;
    c.shown = true;
    const u = c.u;
    push({ type: 'response.output_item.added', data: { item: { type: 'function_call', call_id: id, name: toolName(u), arguments: JSON.stringify({ title: u.title ?? '', ...(u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}) }) } } });
  };
  const known = (u: any) => (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length > 0) || u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed';
  a.onUpdate = (u: any) => {
    if (!u || typeof u !== 'object') return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (typeof u.content?.text === 'string') push({ type: 'response.output_text.delta', data: { delta: u.content.text } });
        break;
      case 'agent_thought_chunk':
        if (typeof u.content?.text === 'string') push({ type: 'response.reasoning_text.delta', data: { delta: u.content.text } });
        break;
      case 'tool_call': {
        const id = String(u.toolCallId ?? '');
        if (QUIET_KINDS.has(u.kind)) { quiet.add(id); break; }
        calls.set(id, { u: { ...u }, shown: false });
        if (known(u)) showCall(id);
        break;
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        if (quiet.has(id)) break;
        const c = calls.get(id);
        if (c) {
          for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== null && k !== 'sessionUpdate') c.u[k] = v;
          if (known(c.u)) showCall(id);
        } else if (QUIET_KINDS.has(u.kind)) { quiet.add(id); break; }
        else { calls.set(id, { u: { ...u }, shown: false }); showCall(id); }
        if (u.status !== 'completed' && u.status !== 'failed') break;
        const out = outputText(u);
        const exit = u.rawOutput?.exit_code;
        const output = u.status === 'failed' ? JSON.stringify({ error: out.trim().slice(0, 300) || 'failed' }) : typeof exit === 'number' ? JSON.stringify({ exit_code: exit, output: out.slice(0, 2000) }) : out.slice(0, 2000);
        push({ type: 'response.output_item.done', data: { item: { type: 'function_call_output', call_id: id, output } } });
        break;
      }
    }
  };

  const stop = () => send(a, { method: 'session/cancel', params: { sessionId } });
  // A Stop pressed while the harness was starting must still keep the prompt from running.
  if (opts.signal.aborted) { a.onUpdate = null; throw new Error('interrupted'); }
  opts.signal.addEventListener('abort', stop, { once: true });
  withTurnSlot(a.harness, opts.signal, () => call(a, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] }))
    .catch((e) => { failure = e instanceof Error ? e : new Error(String(e)); })
    .finally(() => { finished = true; wake?.(); });

  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((r) => { wake = r; });
      wake = null;
    }
    while (queue.length) yield queue.shift()!;
    if (failure && !opts.signal.aborted) throw failure;
    if (!said && !opts.signal.aborted) throw new Error(`${def.name} ended the turn without replying. Its sign-in or model on the computer may need setting up.`);
  } finally {
    opts.signal.removeEventListener('abort', stop);
    if (a.onUpdate) a.onUpdate = null;
  }
}
