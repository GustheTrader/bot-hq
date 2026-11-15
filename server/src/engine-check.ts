import { db } from './db.js';
import { getBotRow } from './store.js';
import { engineFor } from './engine.js';
import { HARNESSES, harnessTurn, isHarnessId } from './harness.js';
import { failureText, sseEvents, type StreamEvent } from './agent/loop.js';

/**
 * A settings check: one short real turn through whatever runs the bot now (Hermes with its provider
 * and model, or its ACP harness), so a bad pairing or a billing refusal shows up on Save rather
 * than on the next chat message. Nothing is stored: no conversation, no rows in the chat.
 */
export interface CheckResult {
  ok: boolean;
  /** The upstream answer: 200 when a reply came back, otherwise the code the provider gave (or 502). */
  status: number;
  ms: number;
  /** What ran it, as the panel names it ("Hermes · modal-shared · deepseek-…", "Codex"). */
  via: string;
  reply?: string;
  error?: string;
}

const PROMPT = 'This is a connection check. Reply with just the word OK.';
const LIMIT_MS = 90_000;
/** Checks in flight, one per bot: a second Save waits for the first instead of doubling the cost. */
const running = new Map<string, Promise<CheckResult>>();

export function checkBot(botId: string): Promise<CheckResult> {
  const have = running.get(botId);
  if (have) return have;
  const p = runCheck(botId).finally(() => running.delete(botId));
  running.set(botId, p);
  return p;
}

/** "HTTP 429: …" inside an engine's error text is the provider's own status. */
function statusIn(message: string): number {
  const m = /\b(?:HTTP|Error code:?)\s*(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : 502;
}

async function runCheck(botId: string): Promise<CheckResult> {
  const bot = getBotRow(botId);
  const t0 = Date.now();
  const done = (r: Omit<CheckResult, 'ms'>): CheckResult => ({ ...r, ms: Date.now() - t0 });
  if (!bot) return done({ ok: false, status: 404, via: '', error: 'This Bot no longer exists.' });
  const harness = isHarnessId(bot.harness) ? bot.harness : 'hermes';
  const via = harness === 'hermes'
    ? ['Hermes', bot.provider || 'default provider', bot.model || 'default model'].join(' · ')
    : [HARNESSES.find((h) => h.id === harness)!.name, bot.harness_model || 'default model'].join(' · ');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMIT_MS);
  let reply = '';
  try {
    let events: AsyncIterable<StreamEvent>;
    if (harness === 'hermes') {
      const engine = await engineFor(botId);
      const res = await fetch(`${engine.url}/v1/responses`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
        body: JSON.stringify({
          model: bot.model || 'hermes-agent',
          ...(bot.provider ? { provider: bot.provider } : {}),
          input: PROMPT,
          stream: true,
          store: false,
          model_options: { reasoning_effort: 'low' },
        }),
      });
      if (!res.ok || !res.body) return done({ ok: false, status: res.status, via, error: await failureText(res) });
      events = sseEvents(res.body);
    } else {
      const screenId = (db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as any)?.screen_id ?? null;
      events = harnessTurn({ botId, harness, screenId, conversation: `check-${Date.now()}`, input: PROMPT, instructions: '', effort: 'low', model: bot.harness_model ?? null, signal: ctrl.signal, check: true });
    }
    for await (const ev of events) {
      const d = ev.data;
      if (ev.type === 'response.output_text.delta' && typeof d?.delta === 'string') reply += d.delta;
      else if (ev.type === 'response.output_item.done' && d?.item?.type === 'message' && !reply) reply = (d.item.content ?? []).map((c: any) => c?.text ?? '').join('');
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        const msg = String(d?.response?.error?.message ?? d?.error?.message ?? d?.message ?? 'the agent run failed');
        return done({ ok: false, status: statusIn(msg), via, error: msg.slice(0, 400) });
      }
    }
    reply = reply.trim();
    if (!reply) return done({ ok: false, status: 502, via, error: 'It answered without any reply.' });
    return done({ ok: true, status: 200, via, reply: reply.slice(0, 120) });
  } catch (e: any) {
    if (ctrl.signal.aborted) return done({ ok: false, status: 504, via, error: `No reply within ${LIMIT_MS / 1000} seconds.` });
    const msg = String(e?.message ?? e);
    return done({ ok: false, status: statusIn(msg), via, error: msg.slice(0, 400) });
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // ends a stream left open after an early return
  }
}
