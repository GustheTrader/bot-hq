/**
 * Task tests for the Wiki's models-and-harness cheat sheet. Runs a few operator tasks on each
 * harness and model, through the same paths a chat turn uses, and grades each result:
 *
 *   node --env-file=../.env dist/bench.js <out.json> [parallel]
 *
 * Hermes setups run on a Hermes engine with the provider and model set per request (store: false,
 * no conversation). ACP harness setups run in a process of their own with the app's tools. Nothing
 * lands in any chat. Not part of the server: run it by hand on the computer when models change.
 */
import fs from 'node:fs';
import { engineFor } from './engine.js';
import { harnessTurn, harnessInstalled, HARNESSES, type HarnessId } from './harness.js';
import { failureText, sseEvents, type StreamEvent } from './agent/loop.js';

interface Setup { id: string; harness: HarnessId; provider?: string; model?: string; label: string; botId: string }
interface Task { id: string; name: string; prompt: (run: string) => string; grade: (r: Outcome, run: string) => boolean }
interface Outcome { reply: string; tools: string[]; error?: string }
export interface BenchResult { setup: string; task: string; ok: boolean; ms: number; tools: number; error?: string; reply?: string }

const PRIMARY = 'bot_K3YhoJcBKDFD'; // Thoth: the computer's own Hermes, with the hq tools at /mcp/primary
const GROK = 'bot_yPbvTc1yQQGq'; // the bot whose own Hermes is signed in to xAI
const HARNESS_BOT = 'bot_CAOPGjtM1obI'; // Gus: identity (hq tools, folder) for the ACP harness runs
const SCRATCH = '/tmp/gnoesis-bench';

const SETUPS: Setup[] = [
  { id: 'hermes-codex-gpt-6.1-sol', harness: 'hermes', provider: 'openai-codex', model: 'gpt-6.1-sol', label: 'Hermes · ChatGPT · gpt-6.1-sol', botId: PRIMARY },
  { id: 'hermes-codex-gpt-6-luna', harness: 'hermes', provider: 'openai-codex', model: 'gpt-6-luna', label: 'Hermes · ChatGPT · gpt-6-luna', botId: PRIMARY },
  { id: 'hermes-anthropic-fable-5.1', harness: 'hermes', provider: 'anthropic', model: 'claude-fable-5.1', label: 'Hermes · Claude · claude-fable-5.1', botId: PRIMARY },
  { id: 'hermes-anthropic-sonnet-5-5', harness: 'hermes', provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Hermes · Claude · claude-sonnet-5-5', botId: PRIMARY },
  { id: 'hermes-anthropic-haiku-5-5', harness: 'hermes', provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Hermes · Claude · claude-haiku-5-5', botId: PRIMARY },
  { id: 'hermes-copilot-gemini-4-argon', harness: 'hermes', provider: 'copilot', model: 'gemini-4-argon', label: 'Hermes · Copilot · gemini-4-argon', botId: PRIMARY },
  { id: 'hermes-xai-grok-4.6', harness: 'hermes', provider: 'xai', model: 'grok-4.6', label: 'Hermes · Grok · grok-4.6', botId: GROK },
  { id: 'hermes-openrouter-deepseek-v4.1-flash', harness: 'hermes', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', label: 'Hermes · OpenRouter · deepseek-v4.1-flash', botId: PRIMARY },
  { id: 'hermes-openrouter-kimi-k3', harness: 'hermes', provider: 'openrouter', model: 'moonshotai/kimi-k3', label: 'Hermes · OpenRouter · kimi-k3', botId: PRIMARY },
  { id: 'codex-default', harness: 'codex', label: 'Codex · default (gpt-6-astra)', botId: HARNESS_BOT },
  { id: 'codex-gpt-5.6-sol', harness: 'codex', model: 'gpt-5.6-sol', label: 'Codex · gpt-5.6-sol', botId: HARNESS_BOT },
  { id: 'claude-code-default', harness: 'claude-code', label: 'Claude Code · default', botId: HARNESS_BOT },
  { id: 'claude-code-opus', harness: 'claude-code', model: 'opus', label: 'Claude Code · opus', botId: HARNESS_BOT },
  { id: 'opencode-big-pickle', harness: 'opencode', label: 'OpenCode · big-pickle (default)', botId: HARNESS_BOT },
  { id: 'opencode-deepseek-free', harness: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', label: 'OpenCode · deepseek-v4.1-flash-free', botId: HARNESS_BOT },
];

const TASKS: Task[] = [
  {
    id: 'shell', name: 'Run a shell command',
    prompt: () => 'Run this shell command: echo $((6*7)) && uname -s\nThen reply with exactly its two output lines.',
    grade: (r) => r.tools.length > 0 && /\b42\b/.test(r.reply) && /Linux/.test(r.reply),
  },
  {
    id: 'file', name: 'Write a file',
    prompt: (run) => `Create the file ${SCRATCH}/${run}.txt containing exactly the text gnoesis-${run} (no newline needed), creating the folder if it is missing. Then reply DONE.`,
    grade: (_r, run) => { try { return fs.readFileSync(`${SCRATCH}/${run}.txt`, 'utf8').trim() === `gnoesis-${run}`; } catch { return false; } },
  },
  {
    id: 'web', name: 'Read a web page',
    prompt: () => 'Fetch https://example.com and reply with the exact text of the page\'s <title> tag, and nothing else.',
    grade: (r) => /Example Domain/i.test(r.reply),
  },
  {
    id: 'reason', name: 'Reason without tools',
    prompt: () => 'Without using any tools: what is the sum of all prime numbers below 50? Reply with just the number.',
    grade: (r) => /\b328\b/.test(r.reply) && r.tools.length === 0,
  },
  {
    id: 'app-tools', name: 'Use the app\'s tools',
    prompt: () => 'Use the team app\'s list_routines tool (from the "hq" MCP server) to list your routines, then reply with how many it returned, as a number.',
    grade: (r) => r.tools.some((t) => /list_routines/.test(t)) && /\d/.test(r.reply),
  },
];

const LIMIT_MS = 180_000;

async function runOne(setup: Setup, task: Task): Promise<BenchResult> {
  const run = `${setup.id}-${task.id}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMIT_MS);
  const t0 = Date.now();
  const out: Outcome = { reply: '', tools: [] };
  try {
    let events: AsyncIterable<StreamEvent>;
    if (setup.harness === 'hermes') {
      const engine = await engineFor(setup.botId);
      const res = await fetch(`${engine.url}/v1/responses`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
        body: JSON.stringify({ model: setup.model, provider: setup.provider, input: task.prompt(run), stream: true, store: false, model_options: { reasoning_effort: 'medium' } }),
      });
      if (!res.ok || !res.body) throw new Error(`${res.status}: ${await failureText(res)}`);
      events = sseEvents(res.body);
    } else {
      events = harnessTurn({ botId: setup.botId, harness: setup.harness, screenId: null, conversation: run, input: task.prompt(run), instructions: '', effort: 'medium', model: setup.model ?? null, signal: ctrl.signal, isolate: `bench-${setup.id}` });
    }
    for await (const ev of events) {
      const d = ev.data;
      if (ev.type === 'response.output_text.delta' && typeof d?.delta === 'string') out.reply += d.delta;
      else if (ev.type === 'response.output_item.added' && d?.item?.type === 'function_call') out.tools.push(`${d.item.name ?? ''} ${typeof d.item.arguments === 'string' ? d.item.arguments : JSON.stringify(d.item.arguments ?? '')}`);
      else if (ev.type === 'response.output_item.done' && d?.item?.type === 'message' && !out.reply) out.reply = (d.item.content ?? []).map((c: any) => c?.text ?? '').join('');
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(String(d?.response?.error?.message ?? d?.error?.message ?? d?.message ?? 'the run failed'));
    }
  } catch (e: any) {
    out.error = ctrl.signal.aborted ? `no answer within ${LIMIT_MS / 1000}s` : String(e?.message ?? e).slice(0, 300);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  const ok = !out.error && task.grade(out, run);
  return { setup: setup.id, task: task.id, ok, ms: Date.now() - t0, tools: out.tools.length, ...(out.error ? { error: out.error } : {}), reply: out.reply.trim().slice(0, 160) };
}

async function main() {
  const [file, par] = process.argv.slice(2);
  if (!file) throw new Error('usage: bench.js <out.json> [parallel]');
  fs.mkdirSync(SCRATCH, { recursive: true });
  const setups = SETUPS.filter((s) => s.harness === 'hermes' || harnessInstalled(HARNESSES.find((h) => h.id === s.harness)!));
  const results: BenchResult[] = [];
  const save = () => fs.writeFileSync(file, JSON.stringify({
    ranAt: new Date().toISOString(),
    setups: SETUPS.map(({ id, harness, provider, model, label }) => ({ id, harness, provider: provider ?? null, model: model ?? null, label })),
    tasks: TASKS.map(({ id, name }) => ({ id, name })),
    results,
  }, null, 2));
  // Setups in parallel (each its own engine request or process); a setup's tasks one after another.
  const queue = [...setups];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      for (const t of TASKS) {
        const r = await runOne(s, t);
        results.push(r);
        console.log(`${r.ok ? 'PASS' : 'FAIL'} ${s.id} ${t.id} ${(r.ms / 1000).toFixed(1)}s${r.error ? ` ${r.error.slice(0, 120)}` : ''}`);
        save();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(par) || 3) }, worker));
  save();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
