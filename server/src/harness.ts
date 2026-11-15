import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { env } from './env.js';
import { displayFor } from './box.js';
import { engineKind, mcpToken } from './engine.js';

/**
 * Harnesses: the agent program that runs a bot's turns. Hermes is the built-in one (agent/loop.ts
 * talks to its gateway). The others speak ACP, the Agent Client Protocol: JSON-RPC over the stdio of
 * an adapter process. This file runs that conversation and turns the agent's updates into the same
 * events Hermes streams, so the turn loop treats every harness alike.
 */

export type HarnessId = 'hermes' | 'codex' | 'claude-code' | 'pi' | 'opencode';

interface HarnessDef { id: HarnessId; name: string; subscription: string; command?: string[] }

export const HARNESSES: HarnessDef[] = [
  { id: 'hermes', name: 'Hermes', subscription: 'Any provider set in its Engine panel' },
  { id: 'codex', name: 'Codex', subscription: 'ChatGPT', command: ['codex-acp'] },
  { id: 'claude-code', name: 'Claude Code', subscription: 'Claude', command: ['claude-agent-acp'] },
  { id: 'pi', name: 'Pi', subscription: 'Its own providers', command: ['pi-acp'] },
  { id: 'opencode', name: 'OpenCode', subscription: 'Its own providers', command: ['opencode', 'acp'] },
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

interface Agent { child: ChildProcess; harness: HarnessId; nextId: number; waiting: Map<number, (m: any) => void>; sessions: Map<string, string>; onUpdate: ((u: any) => void) | null; dead: boolean }

const agents = new Map<string, Agent>();
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

/** The agent asks something of us. Permission requests are allowed (as Hermes' own tools are); we offer no files or terminals. */
function answer(a: Agent, m: any) {
  if (m.method === 'session/request_permission') {
    const opts: any[] = Array.isArray(m.params?.options) ? m.params.options : [];
    const pick = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => String(o.kind).startsWith('allow'));
    send(a, { id: m.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } });
    return;
  }
  send(a, { id: m.id, error: { code: -32601, message: `${m.method} is not offered by this client` } });
}

function startAgent(botId: string, harness: HarnessDef, screenId: string | null): Agent {
  const [cmd, ...args] = harness.command!;
  const cwd = `${LIB_ROOT}/${botId}`;
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so stopping it also stops what it started (Codex runs a helper process).
    detached: true,
    // Its windows and browser land on the bot's own screen.
    env: { ...process.env, DISPLAY: displayFor(screenId), NO_COLOR: '1' },
  });
  const a: Agent = { child, harness: harness.id, nextId: 1, waiting: new Map(), sessions: new Map(), onUpdate: null, dead: false };
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
      else if (m.method && m.id !== undefined) answer(a, m);
    }
  });
  child.stderr?.on('data', () => { /* adapters log here; not ours to show */ });
  const gone = () => {
    a.dead = true;
    for (const w of a.waiting.values()) w({ error: { message: 'the harness stopped' } });
    a.waiting.clear();
    if (agents.get(botId) === a) agents.delete(botId);
  };
  child.on('exit', gone);
  child.on('error', gone);
  return a;
}

async function agentFor(botId: string, harness: HarnessDef, screenId: string | null): Promise<Agent> {
  const have = agents.get(botId);
  if (have && !have.dead && have.harness === harness.id) return have;
  if (have) stopHarness(botId);
  const a = startAgent(botId, harness, screenId);
  agents.set(botId, a);
  await call(a, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  return a;
}

/** Stop the bot's harness process (harness changed, bot deleted). Its next turn starts a fresh one. */
export function stopHarness(botId: string) {
  const a = agents.get(botId);
  if (!a) return;
  agents.delete(botId);
  try { if (a.child.pid) process.kill(-a.child.pid, 'SIGTERM'); else a.child.kill('SIGTERM'); } catch { /* already gone */ }
}

/** The app's tools for this bot, as an MCP server the harness connects to. */
function hqTools(botId: string) {
  const slug = engineKind(botId) === 'primary' ? 'primary' : botId;
  return [{ type: 'http', name: 'hq', url: `${env.mcpBaseUrl}/mcp/${slug}`, headers: [{ name: 'Authorization', value: `Bearer ${mcpToken(slug)}` }] }];
}

/** ACP tool kinds that are the agent thinking or checking itself, not a step worth a row. */
const QUIET_KINDS = new Set(['think', 'switch_mode']);

/**
 * Settings a harness offers per session, applied when it has them:
 *  - a full-access mode (Codex: agent-full-access). Its sandbox cannot start inside the computer's own
 *    sandbox, so every command would fail once before running unsandboxed; Hermes' tools run with
 *    the same access.
 *  - the bot's reasoning effort, when the harness has that option and the value.
 */
async function setUpSession(a: Agent, sessionId: string, session: any, effort: string | undefined) {
  const modes: any[] = Array.isArray(session?.modes?.availableModes) ? session.modes.availableModes : [];
  const full = modes.find((m) => /full[-_]?access/i.test(String(m?.id ?? '')));
  if (full && session?.modes?.currentModeId !== full.id) await call(a, 'session/set_mode', { sessionId, modeId: full.id }).catch(() => {});
  const options: any[] = Array.isArray(session?.configOptions) ? session.configOptions : [];
  const eff = options.find((o) => o?.id === 'reasoning_effort');
  const values = (eff?.options ?? []).map((x: any) => x?.value ?? x?.id);
  if (effort && eff && values.includes(effort) && eff.currentValue !== effort) {
    await call(a, 'session/set_config_option', { sessionId, configId: 'reasoning_effort', value: effort }).catch(() => {});
  }
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
}): AsyncGenerator<HarnessEvent> {
  const def = HARNESSES.find((h) => h.id === opts.harness);
  if (!def?.command) throw new Error(`${opts.harness} is not an ACP harness`);
  if (!harnessInstalled(def)) throw new Error(`${def.name} is not installed on the computer`);
  const a = await agentFor(opts.botId, def, opts.screenId);

  let sessionId = a.sessions.get(opts.conversation);
  let first = false;
  if (!sessionId) {
    const r = await call(a, 'session/new', { cwd: `${LIB_ROOT}/${opts.botId}`, mcpServers: hqTools(opts.botId) });
    sessionId = String(r?.sessionId ?? '');
    if (!sessionId) throw new Error(`${def.name} did not start a session`);
    a.sessions.set(opts.conversation, sessionId);
    first = true;
    await setUpSession(a, sessionId, r, opts.effort);
  }
  const text = first && opts.instructions ? `${opts.instructions}\n\n---\n\n${opts.input}` : opts.input;

  // Updates arrive while the prompt call is open; queue them for the generator.
  const queue: HarnessEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: Error | null = null;
  const push = (e: HarnessEvent) => { queue.push(e); wake?.(); };
  const quiet = new Set<string>();
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
        const name = toolName(u);
        push({ type: 'response.output_item.added', data: { item: { type: 'function_call', call_id: id, name, arguments: JSON.stringify({ title: u.title ?? '', ...(u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}) }) } } });
        break;
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        if (quiet.has(id) || (u.status !== 'completed' && u.status !== 'failed')) break;
        const out = outputText(u);
        const exit = u.rawOutput?.exit_code;
        const output = u.status === 'failed' ? JSON.stringify({ error: out.trim().slice(0, 300) || 'failed' }) : typeof exit === 'number' ? JSON.stringify({ exit_code: exit, output: out.slice(0, 2000) }) : out.slice(0, 2000);
        push({ type: 'response.output_item.done', data: { item: { type: 'function_call_output', call_id: id, output } } });
        break;
      }
    }
  };

  const stop = () => { if (sessionId) send(a, { method: 'session/cancel', params: { sessionId } }); };
  opts.signal.addEventListener('abort', stop, { once: true });
  call(a, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
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
  } finally {
    opts.signal.removeEventListener('abort', stop);
    if (a.onUpdate) a.onUpdate = null;
  }
}
