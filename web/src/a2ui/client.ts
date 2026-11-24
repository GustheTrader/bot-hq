import { actionMessage, callAgentFunctionMessage, uuidv4, validationErrorMessage } from './messages';
import { createA2uiStore, type A2uiStore } from './store';
import type { AgentMessage, FunctionCall, JsonObject, RendererMessage } from './types';

/**
 * WebSocket client for the durable A2UI agent (docs/a2ui/CONTRACT.md): one A2UI message per text frame, no
 * envelope. Reconnects forever with 250 ms -> 2 s backoff. On every open it drops all surfaces first, so the
 * agent's snapshot replay (createSurface per live surface) can never duplicate a ticket, then re-sends any
 * function call still waiting for a response, once, with the same functionCallId (the agent dedups on it).
 */

export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 2000;
export const EDIT_DEBOUNCE_MS = 150;

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface ClientOptions {
  url?: () => string;
  socket?: SocketFactory;
  store?: A2uiStore;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (...a: unknown[]) => void;
}

const OPEN = 1;

export function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/a2ui/ws`;
}

export class A2uiClient {
  readonly store: A2uiStore;
  private ws: SocketLike | null = null;
  private running = false;
  private backoff = BACKOFF_MIN_MS;
  private retryTimer: unknown = null;
  private edits = new Map<string, { timer: unknown; msg: () => RendererMessage }>();
  private readonly url: () => string;
  private readonly socket: SocketFactory;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly log: (...a: unknown[]) => void;
  /** Every frame actually written to a socket (tests read this). */
  readonly sent: string[] = [];

  constructor(o: ClientOptions = {}) {
    this.store = o.store ?? createA2uiStore();
    this.url = o.url ?? defaultUrl;
    this.socket = o.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = o.log ?? ((...a) => console.warn('[a2ui]', ...a));
  }

  get connected(): boolean { return this.ws?.readyState === OPEN && this.store.getState().conn === 'connected'; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.getState().setConn({ conn: 'connecting' });
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) { this.clearTimer(this.retryTimer); this.retryTimer = null; }
    for (const e of this.edits.values()) this.clearTimer(e.timer);
    this.edits.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = ws.onclose = ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch { /* already closed */ } }
    this.store.getState().setConn({ conn: 'idle' });
  }

  private connect(): void {
    if (!this.running) return;
    let ws: SocketLike;
    try { ws = this.socket(this.url()); }
    catch (e) { this.log('socket construct failed', e); this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) this.handleOpen(); };
    ws.onmessage = (ev) => { if (this.ws === ws) this.handleFrame(ev.data); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleClose();
    };
  }

  private handleOpen(): void {
    const st = this.store.getState();
    const epoch = st.epoch + 1;
    // Replay safety: forget every surface before the new socket's snapshot arrives.
    st.dropSurfaces();
    st.setConn({ conn: 'connected', epoch, attempts: 0 });
    this.backoff = BACKOFF_MIN_MS;
    // A function call that never got its response: re-send it once, same functionCallId, on this new socket.
    for (const rec of Object.values(this.store.getState().calls)) {
      if (rec.state !== 'pending' || rec.sentEpoch >= epoch) continue;
      if (rec.resends >= 1) {
        this.store.getState().putCall({ ...rec, state: 'unconfirmed' });
        continue;
      }
      this.write(rec.frame);
      this.store.getState().putCall({ ...rec, resends: rec.resends + 1, sentEpoch: epoch });
    }
  }

  private handleClose(): void {
    // Edits typed into a dead socket are not sent: the fresh snapshot after reconnect is authoritative.
    for (const e of this.edits.values()) this.clearTimer(e.timer);
    this.edits.clear();
    if (!this.running) return;
    const st = this.store.getState();
    st.setConn({ conn: 'reconnecting', attempts: st.attempts + 1 });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  /** Exposed for tests: process one inbound text frame. */
  handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: AgentMessage;
    try { msg = JSON.parse(data) as AgentMessage; }
    catch { this.log('dropping non-JSON frame'); return; }
    const r = this.store.getState().apply(msg);
    if (r.ignored) this.log('ignored message:', r.ignored);
    for (const p of r.problems) this.send(validationErrorMessage(p.surfaceId, p.path, p.message));
  }

  private write(frame: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(frame);
    this.sent.push(frame);
    return true;
  }

  send(msg: RendererMessage): boolean { return this.write(JSON.stringify(msg)); }

  /** Debounced (150 ms) field-edit action, one pending per surface+name; the latest context wins. */
  queueAction(surfaceId: string, name: string, sourceComponentId: string, context: JsonObject): void {
    const key = `${surfaceId}\u0000${name}`;
    const prev = this.edits.get(key);
    if (prev) this.clearTimer(prev.timer);
    const msg = () => actionMessage({ name, surfaceId, sourceComponentId, context });
    const timer = this.setTimer(() => { this.edits.delete(key); this.send(msg()); }, EDIT_DEBOUNCE_MS);
    this.edits.set(key, { timer, msg });
  }

  /** Send any debounced action for this surface now (before a submit, so the journal has the final edit). */
  flushActions(surfaceId: string): void {
    for (const [key, e] of this.edits) {
      if (!key.startsWith(`${surfaceId}\u0000`)) continue;
      this.clearTimer(e.timer);
      this.edits.delete(key);
      this.send(e.msg());
    }
  }

  /**
   * callAgentFunction with a fresh uuid v4. Throws when not connected: the UI disables submit then, and a call is
   * never queued behind a dead socket. The record stays 'pending' until the agentFunctionResponse arrives.
   */
  callAgentFunction(surfaceId: string, callFunction: FunctionCall): string {
    if (!this.connected) throw new Error('Not connected to the agent');
    const functionCallId = uuidv4();
    const frame = JSON.stringify(callAgentFunctionMessage(surfaceId, functionCallId, callFunction));
    if (!this.write(frame)) throw new Error('Not connected to the agent');
    const epoch = this.store.getState().epoch;
    this.store.getState().putCall({ functionCallId, surfaceId, frame, state: 'pending', sentEpoch: epoch, resends: 0, startedAt: Date.now() });
    return functionCallId;
  }
}

let shared: A2uiClient | null = null;
let refs = 0;
/** The app-wide client; views call acquire() on mount and the returned release() on unmount. */
export function acquireA2uiClient(): { client: A2uiClient; release: () => void } {
  if (!shared) shared = new A2uiClient();
  const client = shared;
  refs += 1;
  client.start();
  let released = false;
  return {
    client,
    release: () => {
      if (released) return;
      released = true;
      refs -= 1;
      if (refs === 0) client.stop();
    },
  };
}
export function sharedA2uiClient(): A2uiClient {
  if (!shared) shared = new A2uiClient();
  return shared;
}
