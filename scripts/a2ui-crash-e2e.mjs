#!/usr/bin/env node
// A2UI durable-agent crash E2E + latency measurement (PRD v1.1, Day 5).
//
// Acts as a scripted renderer against the real `bothq-a2ui-agent` binary over the wire
// contract in docs/a2ui/CONTRACT.md (WS /a2ui/ws, raw A2UI v1.0 frames, GET /a2ui/health).
//
//   node scripts/a2ui-crash-e2e.mjs                 # crash test at all three kill points, then latency (print-only)
//   node scripts/a2ui-crash-e2e.mjs --mode crash    # crash test only (the CI gate)
//   node scripts/a2ui-crash-e2e.mjs --mode latency  # latency only (never fails on numbers)
//   node scripts/a2ui-crash-e2e.mjs --points mid_edit,after_order_placed
//
// Options / env:
//   --bin <path>        | BOTHQ_A2UI_BIN      agent binary (default: agents/a2ui-durable/target/{release,debug}/bothq-a2ui-agent)
//   --fixture <path>    | BOTHQ_A2UI_FIXTURE  replay JSONL (default: first *.jsonl under agents/a2ui-durable/fixtures/)
//   --samples <n>       | A2UI_LAT_SAMPLES    /market updates to sample (default 30; the agent only pushes CHANGED quotes,
//                                             so a short fixture may yield fewer; the run reports how many it got)
//   --replay-interval-ms <n> | A2UI_LAT_REPLAY_MS  agent replay pace for the latency run only (default 100)
//   --submits <n>       | A2UI_LAT_SUBMITS    submit round trips to sample (default 20)
//   --keep                                    keep temp DBs/logs (path printed)
//   A2UI_AGENT_ARGS     extra args appended to the agent command line (space-separated)
//
//   --require-schema                          fail (exit 2) if ajv is not installed instead of falling back
//
// Node 22+ (global WebSocket and fetch). No new dependencies. Validation, on EVERY frame sent or received:
//   1. Full JSON-Schema (draft 2020-12) against agents/a2ui-durable/schemas/v1_0/{agent_to_renderer,
//      renderer_to_agent}.json with the agent's catalog (catalog/bothq.trading.v0.json) registered in place
//      of catalog.json, IF ajv + ajv-formats resolve from the repo (they are web devDependencies, so after
//      `npm ci` they do). Same catalog-substitution setup as web/test/a2ui.test.ts.
//   2. Always: a shape check (envelope, version, one message key, required/allowed fields, OrderTicket bindings).
// The Rust suite additionally validates every emitted frame with the jsonschema crate (cargo test).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(REPO, 'agents', 'a2ui-durable');
const RESUME_BUDGET_MS = 5000;
const LATENCY_TARGET_MS = 100;
const PAUSE_POINTS = ['after_render', 'mid_edit', 'after_order_placed'];

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, env, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[env] ?? dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const MODE = opt('mode', 'A2UI_E2E_MODE', 'all');
const POINTS = opt('points', 'A2UI_E2E_POINTS', PAUSE_POINTS.join(',')).split(',').filter(Boolean);
const SAMPLES = Number(opt('samples', 'A2UI_LAT_SAMPLES', '30'));
const REPLAY_MS = opt('replay-interval-ms', 'A2UI_LAT_REPLAY_MS', '100'); // latency run only: replay the fixture faster
const SUBMITS = Number(opt('submits', 'A2UI_LAT_SUBMITS', '20'));
const KEEP = flag('keep');
const REQUIRE_SCHEMA = flag('require-schema');
const EXTRA_ARGS = (process.env.A2UI_AGENT_ARGS ?? '').split(/\s+/).filter(Boolean);
for (const p of POINTS) if (!PAUSE_POINTS.includes(p)) die(`unknown kill point ${p}`);
if (!['all', 'crash', 'latency'].includes(MODE)) die(`unknown --mode ${MODE}`);
if (typeof WebSocket !== 'function') die('global WebSocket missing: Node 22+ required');

function die(msg) { console.error(`a2ui-e2e: ${msg}`); process.exit(2); }

function findBinary() {
  const explicit = opt('bin', 'BOTHQ_A2UI_BIN', '');
  if (explicit) { if (!fs.existsSync(explicit)) die(`binary not found: ${explicit}`); return path.resolve(explicit); }
  const candidates = [
    path.join(AGENT_DIR, 'target', 'release', 'bothq-a2ui-agent'),
    path.join(AGENT_DIR, 'target', 'debug', 'bothq-a2ui-agent'),
    path.join(REPO, 'target', 'release', 'bothq-a2ui-agent'),
    path.join(REPO, 'target', 'debug', 'bothq-a2ui-agent'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) die(`no bothq-a2ui-agent binary; build it (cargo build --release in agents/a2ui-durable) or pass --bin. Looked in:\n  ${candidates.join('\n  ')}`);
  return found;
}

function findFixture() {
  const explicit = opt('fixture', 'BOTHQ_A2UI_FIXTURE', '');
  if (explicit) { if (!fs.existsSync(explicit)) die(`fixture not found: ${explicit}`); return path.resolve(explicit); }
  const root = path.join(AGENT_DIR, 'fixtures');
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  out.sort();
  if (!out.length) die(`no *.jsonl replay fixture under ${root}; pass --fixture`);
  return out[0];
}

// ---------------------------------------------------------------- full JSON-Schema validation (optional ajv)
const V1 = 'https://a2ui.org/specification/v1_0/';
async function loadSchemaValidators() {
  const req = createRequire(path.join(REPO, 'package.json'));
  let Ajv2020, addFormats;
  try {
    Ajv2020 = (await import(pathToFileURL(req.resolve('ajv/dist/2020.js')).href)).default;
    addFormats = (await import(pathToFileURL(req.resolve('ajv-formats')).href)).default;
  } catch (e) {
    return { why: `ajv/ajv-formats not resolvable from ${REPO} (run npm ci): ${e.code ?? e.message}` };
  }
  Ajv2020 = Ajv2020.default ?? Ajv2020; addFormats = addFormats.default ?? addFormats;
  const dir = path.join(AGENT_DIR, 'schemas', 'v1_0');
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const catPath = path.join(AGENT_DIR, 'catalog', 'bothq.trading.v0.json');
  if (!fs.existsSync(catPath)) return { why: `agent catalog missing: ${catPath}` };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const s of [read(path.join(dir, 'common_types.json')), { ...read(catPath), $id: `${V1}catalog.json` }, read(path.join(dir, 'agent_to_renderer.json')), read(path.join(dir, 'renderer_to_agent.json'))]) ajv.addSchema(s);
  const mk = (name) => {
    const v = ajv.getSchema(`${V1}${name}`);
    return (m) => (v(m) ? null : ajv.errorsText(v.errors?.slice(0, 3), { separator: '; ' }));
  };
  return { a2r: mk('agent_to_renderer.json'), r2a: mk('renderer_to_agent.json') };
}
const SCHEMA = await loadSchemaValidators();
if (!SCHEMA.a2r && REQUIRE_SCHEMA) die(`--require-schema: ${SCHEMA.why}`);
const schemaInvalid = []; // {dir, reason, raw}
function schemaCheck(dir, m) {
  if (!SCHEMA.a2r) return;
  const why = (dir === 'in' ? SCHEMA.a2r : SCHEMA.r2a)(m);
  if (why) schemaInvalid.push({ dir, reason: why, raw: JSON.stringify(m).slice(0, 300) });
}

// ---------------------------------------------------------------- utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] ?? NaN };
}
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

// ---------------------------------------------------------------- message shape checks
const A2R_KEYS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface', 'callRendererFunction', 'agentFunctionResponse'];
const R2A_KEYS = ['action', 'callAgentFunction', 'rendererFunctionResponse', 'error'];
const SECRET_KEY = /(api[_-]?key|secret|private[_-]?key|password|passphrase|credential|access[_-]?token|account[_-]?id)/i;

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${where}: unexpected property "${k}"`;
  return null;
}
function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

/** Returns null when the agent->renderer frame has a valid shape, else a reason. */
function checkAgentMsg(m) {
  if (!isObj(m)) return 'frame is not a JSON object';
  if (m.version !== '1.0') return `version is ${JSON.stringify(m.version)}, want "1.0"`;
  const keys = Object.keys(m).filter((k) => k !== 'version');
  if (keys.length !== 1) return `want exactly one message key besides version, got [${keys}]`;
  const [k] = keys;
  if (!A2R_KEYS.includes(k)) return `unknown agent_to_renderer message "${k}"`;
  const b = m[k];
  if (!isObj(b)) return `${k} is not an object`;
  switch (k) {
    case 'createSurface': {
      const e = onlyKeys(b, ['surfaceId', 'catalogId', 'sendDataModel', 'components', 'dataModel', 'metadata'], k); if (e) return e;
      if (typeof b.surfaceId !== 'string') return 'createSurface.surfaceId missing';
      if (b.components !== undefined) { const ce = checkComponents(b.components); if (ce) return ce; }
      if (b.dataModel !== undefined && !isObj(b.dataModel)) return 'createSurface.dataModel is not an object';
      return null;
    }
    case 'updateComponents': {
      const e = onlyKeys(b, ['surfaceId', 'components'], k); if (e) return e;
      if (typeof b.surfaceId !== 'string') return 'updateComponents.surfaceId missing';
      return checkComponents(b.components);
    }
    case 'updateDataModel': {
      const e = onlyKeys(b, ['surfaceId', 'path', 'value'], k); if (e) return e;
      if (typeof b.surfaceId !== 'string') return 'updateDataModel.surfaceId missing';
      if (!('value' in b)) return 'updateDataModel.value missing';
      if (b.path !== undefined && typeof b.path !== 'string') return 'updateDataModel.path not a string';
      return null;
    }
    case 'deleteSurface': {
      const e = onlyKeys(b, ['surfaceId'], k); if (e) return e;
      return typeof b.surfaceId === 'string' ? null : 'deleteSurface.surfaceId missing';
    }
    case 'callRendererFunction':
      return 'callRendererFunction is deferred in the MVP and must not be emitted';
    case 'agentFunctionResponse': {
      const e = onlyKeys(b, ['functionCallId', 'value', 'error'], k); if (e) return e;
      if (typeof b.functionCallId !== 'string') return 'agentFunctionResponse.functionCallId missing';
      if (('value' in b) === ('error' in b)) return 'agentFunctionResponse needs exactly one of value/error';
      if ('error' in b) {
        if (!isObj(b.error) || typeof b.error.code !== 'string' || typeof b.error.message !== 'string') return 'agentFunctionResponse.error needs string code+message';
        const ee = onlyKeys(b.error, ['code', 'message'], 'agentFunctionResponse.error'); if (ee) return ee;
      }
      return null;
    }
  }
  return null;
}
function checkComponents(cs) {
  if (!Array.isArray(cs) || cs.length < 1) return 'components must be a non-empty array';
  for (const c of cs) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.component !== 'string') return 'component missing id/component';
    if (c.component === 'Surface') return 'component "Surface" is reserved';
  }
  return null;
}
/** OrderTicket-specific checks on a createSurface body (contract section "Catalog bothq.trading.v0"). */
function checkOrderTicket(cs) {
  if (cs.catalogId !== 'bothq.trading.v0') return `catalogId ${JSON.stringify(cs.catalogId)} != "bothq.trading.v0"`;
  const root = (cs.components ?? []).find((c) => c.id === 'root');
  if (!root) return 'no component with id "root"';
  if (root.component !== 'OrderTicket') return `root component is ${root.component}, want OrderTicket`;
  const want = { symbol: '/ticket/symbol', side: '/ticket/side', quantity: '/ticket/quantity', limitPrice: '/ticket/limitPrice', livePrice: '/market/lastPrice', buyingPower: '/account/buyingPower', position: '/account/position', status: '/ticket/status' };
  for (const [prop, p] of Object.entries(want)) if (root[prop]?.['@path'] !== p) return `root.${prop} not bound to {"@path":"${p}"}`;
  if (root.submit?.functionCall?.['@call'] !== 'submitOrder') return 'root.submit.functionCall.@call != submitOrder';
  const dm = cs.dataModel;
  if (!isObj(dm?.ticket) || !isObj(dm?.market) || !isObj(dm?.account)) return 'dataModel lacks ticket/market/account';
  return null;
}
function checkRendererMsg(m) {
  if (m.version !== '1.0') return 'outbound version != 1.0';
  const keys = Object.keys(m).filter((k) => k !== 'version');
  if (keys.length !== 1 || !R2A_KEYS.includes(keys[0])) return `outbound has keys [${keys}]`;
  const b = m[keys[0]];
  if (keys[0] === 'action') for (const r of ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context']) if (!(r in b)) return `action.${r} missing`;
  if (keys[0] === 'callAgentFunction') {
    for (const r of ['surfaceId', 'functionCallId', 'callFunction']) if (!(r in b)) return `callAgentFunction.${r} missing`;
    if (typeof b.callFunction['@call'] !== 'string') return 'callFunction.@call missing';
  }
  return null;
}
function findSecretKeys(x, at = '', out = []) {
  if (Array.isArray(x)) x.forEach((v, i) => findSecretKeys(v, `${at}/${i}`, out));
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) { if (SECRET_KEY.test(k)) out.push(`${at}/${k}`); findSecretKeys(v, `${at}/${k}`, out); }
  return out;
}

// ---------------------------------------------------------------- agent process
class Agent {
  constructor({ bin, fixture, db, port, pauseAt, logPath, extra = [] }) {
    Object.assign(this, { bin, fixture, db, port, pauseAt, logPath, extra });
    this.base = `http://127.0.0.1:${port}`;
    this.stderr = '';
    this.pauseSeen = new Map(); // name -> performance.now()
    this.exited = null;
  }
  start() {
    const args = ['--db', this.db, '--listen', `127.0.0.1:${this.port}`, '--feed', 'replay', '--replay-file', this.fixture, ...this.extra, ...EXTRA_ARGS];
    const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'info' };
    delete env.BOTHQ_A2UI_PAUSE_AT;
    delete env.BOTHQ_A2UI_DB; delete env.BOTHQ_A2UI_LISTEN; delete env.BOTHQ_A2UI_FEED;
    if (this.pauseAt) env.BOTHQ_A2UI_PAUSE_AT = this.pauseAt;
    this.cmd = `${this.pauseAt ? `BOTHQ_A2UI_PAUSE_AT=${this.pauseAt} ` : ''}${this.bin} ${args.join(' ')}`;
    const log = fs.createWriteStream(this.logPath, { flags: 'a' });
    log.write(`\n=== ${new Date().toISOString()} ${this.cmd}\n`);
    this.t0 = now();
    this.proc = spawn(this.bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => log.write(d));
    this.proc.stderr.on('data', (d) => {
      const s = d.toString();
      log.write(s);
      this.stderr += s;
      for (const m of this.stderr.matchAll(/PAUSE_POINT (\w+)/g)) if (!this.pauseSeen.has(m[1])) this.pauseSeen.set(m[1], now());
    });
    this.exitP = new Promise((r) => this.proc.on('exit', (code, sig) => { this.exited = { code, sig }; log.end(); r(this.exited); }));
    return this;
  }
  async waitPause(name, timeoutMs) {
    const end = now() + timeoutMs;
    while (now() < end) {
      if (this.pauseSeen.has(name)) return true;
      if (this.exited) throw new Error(`agent exited (${JSON.stringify(this.exited)}) before PAUSE_POINT ${name}`);
      await sleep(10);
    }
    throw new Error(`no "PAUSE_POINT ${name}" on stderr within ${timeoutMs} ms`);
  }
  async kill9() {
    if (this.exited) return this.exited;
    this.proc.kill('SIGKILL');
    return this.exitP;
  }
  async health(timeoutMs = 1500) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${this.base}/a2ui/health`, { signal: ac.signal });
      if (!r.ok) throw new Error(`health HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async waitHealthy(timeoutMs, stopIf = () => false) {
    const end = now() + timeoutMs;
    let last;
    while (now() < end) {
      if (this.exited) throw new Error(`agent exited (${JSON.stringify(this.exited)}) before becoming healthy`);
      if (stopIf()) return null;
      try { return await this.health(500); } catch (e) { last = e; }
      await sleep(25);
    }
    throw new Error(`health not reachable within ${timeoutMs} ms: ${last?.message ?? last}`);
  }
  tail(n = 25) { return this.stderr.split('\n').slice(-n).join('\n'); }
}

// ---------------------------------------------------------------- scripted renderer
class Renderer {
  constructor(url) { this.url = url; this.msgs = []; this.invalid = []; this.waiters = new Set(); this.closed = false; }
  open(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws open timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(this); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws error')); });
      ws.addEventListener('close', () => { this.closed = true; this.#notify(); });
      ws.addEventListener('message', (ev) => {
        const at = now();
        const wall = Date.now();
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); }
        catch { this.invalid.push({ reason: 'not JSON', raw: String(ev.data).slice(0, 200) }); return; }
        const why = checkAgentMsg(m);
        if (why) this.invalid.push({ reason: why, raw: JSON.stringify(m).slice(0, 300) });
        schemaCheck('in', m);
        this.msgs.push({ m, at, wall });
        this.#notify();
      });
    });
  }
  /** Connect, retrying until `deadline` (performance.now()), for the restart-time measurement. */
  static async connectRetry(url, deadline) {
    let last;
    while (now() < deadline) {
      const r = new Renderer(url);
      try { return await r.open(Math.max(100, Math.min(1000, deadline - now()))); } catch (e) { last = e; }
      await sleep(25);
    }
    throw new Error(`could not open ${url}: ${last?.message ?? last}`);
  }
  #notify() { for (const w of this.waiters) w(); }
  /** Waits for a message matching pred, scanning from index `from`. Resolves {m,at,wall,idx}. */
  waitFor(pred, timeoutMs, from = 0, what = 'message') {
    return new Promise((resolve, reject) => {
      let i = from;
      const check = () => {
        for (; i < this.msgs.length; i++) if (pred(this.msgs[i].m)) { done(); return resolve({ ...this.msgs[i], idx: i }); }
        if (this.closed) { done(); reject(new Error(`socket closed while waiting for ${what}`)); }
      };
      const t = setTimeout(() => { done(); reject(new Error(`timeout ${timeoutMs} ms waiting for ${what}`)); }, timeoutMs);
      const done = () => { clearTimeout(t); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }
  send(m) {
    const why = checkRendererMsg(m);
    if (why) throw new Error(`script bug, invalid outbound frame: ${why}`);
    schemaCheck('out', m);
    this.ws.send(JSON.stringify(m));
    return now();
  }
  close() { try { this.ws?.close(); } catch {} }
}

const isCreate = (m) => !!m.createSurface;
const isResp = (id) => (m) => m.agentFunctionResponse?.functionCallId === id;
const isTicketEcho = (m) => !!m.updateDataModel && /^\/ticket(\/|$)/.test(m.updateDataModel.path ?? '/');

function editAction(surfaceId, ctx) {
  return { version: '1.0', action: { name: 'ticketEdited', surfaceId, sourceComponentId: 'root', timestamp: new Date().toISOString(), context: ctx } };
}
// requiresUserActivation evidence (catalog bothq.trading.v0 UserActivation): what the renderer attaches from the
// trusted DOM click. The agent rejects missing, untrusted or stale (>120 s) evidence for NEW calls; a repeated
// functionCallId is answered from the journal before that check, so a re-sent frame keeps its original timestamp.
function submitCall(surfaceId, functionCallId, t) {
  const userActivation = { type: 'click', isTrusted: true, timestamp: new Date().toISOString() };
  return { version: '1.0', callAgentFunction: { surfaceId, functionCallId, callFunction: { '@call': 'submitOrder', args: { symbol: t.symbol, side: t.side, quantity: t.quantity, limitPrice: t.limitPrice, userActivation } } } };
}
/** Latest /market object this renderer has seen (snapshot + updateDataModel). */
function latestMarket(r) {
  let mk = {};
  for (const { m } of r.msgs) {
    if (m.createSurface?.dataModel?.market) mk = { ...m.createSurface.dataModel.market };
    const u = m.updateDataModel;
    if (!u) continue;
    const p = u.path ?? '/';
    if (p === '/' && isObj(u.value?.market)) mk = { ...u.value.market };
    else if (p === '/market' && isObj(u.value)) mk = { ...u.value };
    else if (p.startsWith('/market/')) mk[p.slice(8)] = u.value;
  }
  return mk;
}
/** Marketable buy limit for the paper IOC fill rule: latest ask + 2 cents, capped at 0.99. */
function marketableLimit(r, fallback) {
  const ask = Number(latestMarket(r).ask);
  if (!(ask > 0 && ask < 1)) return fallback;
  return Math.min(0.99, Math.round((ask + 0.02) * 100) / 100);
}
/** An edit that is distinguishable from the agent's defaults: buy (never a naked sell), qty 3, limit at the ask. */
function pickEdit(dm) {
  const t = dm.ticket ?? {};
  let lp = Number(dm.market?.ask ?? dm.market?.lastPrice ?? 0.5);
  lp = Math.min(0.99, Math.max(0.01, Math.round(lp * 100) / 100));
  if (lp === Number(t.limitPrice)) lp = lp >= 0.98 ? lp - 0.01 : lp + 0.01;
  lp = Math.round(lp * 100) / 100;
  const quantity = Number(t.quantity) === 3 ? 4 : 3;
  return { side: 'buy', quantity, limitPrice: lp };
}

// ---------------------------------------------------------------- crash test
class Checks {
  constructor(point) { this.point = point; this.rows = []; }
  ok(name, cond, detail = '') { this.rows.push({ point: this.point, name, pass: !!cond, detail: String(detail) }); return !!cond; }
  fail(name, detail) { return this.ok(name, false, detail); }
  info(name, detail) { this.rows.push({ point: this.point, name, pass: null, detail: String(detail) }); }
}

async function crashCase(point, ctx) {
  const c = new Checks(point);
  const dir = fs.mkdtempSync(path.join(ctx.tmp, `${point}-`));
  const db = path.join(dir, 'agent.sqlite');
  const logPath = path.join(dir, 'agent.log');
  const port = await freePort();
  const wsUrl = `ws://127.0.0.1:${port}/a2ui/ws`;
  const allMsgs = [];
  let a1, a2, r1, r2;
  const schemaMark = schemaInvalid.length;
  try {
    // ---- run 1: drive to the kill point
    a1 = new Agent({ bin: ctx.bin, fixture: ctx.fixture, db, port, pauseAt: point, logPath }).start();
    const pausedEarly = () => a1.pauseSeen.has(point);
    const h0 = await a1.waitHealthy(10000, pausedEarly);
    if (h0) { c.ok('health before crash: orders=0', h0.orders === 0, `orders=${h0.orders}`); c.ok('health before crash: resumed=false', h0.resumed === false, `resumed=${h0.resumed}`); }
    let surfaceId, preSessionId = h0?.sessionId, editCtx, fcid, preResp, submitFrame;
    if (!pausedEarly()) {
      r1 = await new Renderer(wsUrl).open();
      if (point === 'after_render') {
        // The pause may fire before or after the createSurface frame reaches us; either is a valid kill point.
        await Promise.race([r1.waitFor(isCreate, 5000, 0, 'createSurface').catch(() => null), a1.waitPause(point, 5000).catch(() => null)]);
      } else {
        const cs = (await r1.waitFor(isCreate, 5000, 0, 'createSurface (run 1)')).m.createSurface;
        surfaceId = cs.surfaceId;
        preSessionId ??= cs.dataModel?.session?.id;
        editCtx = pickEdit(cs.dataModel ?? {});
        const mark = r1.msgs.length;
        r1.send(editAction(surfaceId, editCtx));
        if (point === 'after_order_placed') {
          // Let the edit commit (echo) before submitting so the submit carries the edited ticket.
          await r1.waitFor(isTicketEcho, 3000, mark, 'ticket echo').catch(() => c.info('edit echo before submit', 'no /ticket echo within 3 s (continuing)'));
          fcid = randomUUID();
          submitFrame = submitCall(surfaceId, fcid, { symbol: cs.dataModel.ticket.symbol, ...editCtx });
          r1.send(submitFrame);
        }
      }
    }
    await a1.waitPause(point, 10000);
    c.ok(`PAUSE_POINT ${point} reached`, true, `${fmt(a1.pauseSeen.get(point) - a1.t0)} ms after spawn`);
    if (r1 && fcid) { const got = r1.msgs.find((x) => isResp(fcid)(x.m)); if (got) preResp = got.m.agentFunctionResponse; }
    c.info('response before kill', preResp ? JSON.stringify(preResp.value ?? preResp.error) : 'none (killed before reply)');
    const ex = await a1.kill9();
    c.ok('kill -9', ex.sig === 'SIGKILL', JSON.stringify(ex));
    if (r1) { allMsgs.push(...r1.msgs); c.invalid1 = r1.invalid; r1.close(); }

    // ---- run 2: restart without PAUSE_AT on the same DB, measure time to replayed createSurface
    const tRestart = now();
    a2 = new Agent({ bin: ctx.bin, fixture: ctx.fixture, db, port, pauseAt: null, logPath }).start();
    const deadline = tRestart + RESUME_BUDGET_MS + 5000; // keep trying past budget so we can report the real number
    r2 = await Renderer.connectRetry(wsUrl, deadline);
    const cs2msg = await r2.waitFor(isCreate, Math.max(100, deadline - now()), 0, 'replayed createSurface');
    const resumeMs = cs2msg.at - tRestart;
    c.ok(`resume <= ${RESUME_BUDGET_MS} ms (restart -> replayed createSurface)`, resumeMs <= RESUME_BUDGET_MS, `${fmt(resumeMs)} ms`);
    ctx.resumeTimes.push({ point, ms: resumeMs });
    const cs2 = cs2msg.m.createSurface;
    const ot = checkOrderTicket(cs2);
    c.ok('replayed createSurface is a full OrderTicket snapshot', !ot, ot ?? 'catalogId, root OrderTicket, @path bindings, dataModel');
    c.ok('one createSurface per surface on the new socket', r2.msgs.filter((x) => isCreate(x.m) && x.m.createSurface.surfaceId === cs2.surfaceId).length === 1, '');
    if (surfaceId) c.ok('same surfaceId after restart', cs2.surfaceId === surfaceId, `${surfaceId} -> ${cs2.surfaceId}`);
    surfaceId = cs2.surfaceId;

    const h1 = await a2.health();
    c.ok('health after restart: resumed=true', h1.resumed === true, `resumed=${h1.resumed}`);
    if (preSessionId) c.ok('same sessionId after restart', h1.sessionId === preSessionId, `${preSessionId} -> ${h1.sessionId}`);
    c.ok('health lists the surface', Array.isArray(h1.surfaces) && h1.surfaces.includes(surfaceId), JSON.stringify(h1.surfaces));
    c.ok('dataModel /session/resumed=true', cs2.dataModel?.session?.resumed === true, JSON.stringify(cs2.dataModel?.session));
    const t2 = cs2.dataModel?.ticket ?? {};
    if (editCtx) {
      const same = t2.side === editCtx.side && Number(t2.quantity) === editCtx.quantity && Math.abs(Number(t2.limitPrice) - editCtx.limitPrice) < 1e-9;
      c.ok('ticket edits restored', same, `want ${JSON.stringify(editCtx)} got ${JSON.stringify({ side: t2.side, quantity: t2.quantity, limitPrice: t2.limitPrice })}`);
    }

    if (point === 'after_order_placed') {
      c.ok('health after restart: orders=1', h1.orders === 1, `orders=${h1.orders}`);
      // Renderer behaviour from the contract: re-send the SAME functionCallId once after reconnect.
      const mark = r2.msgs.length;
      r2.send(submitFrame); // the identical frame, as web/src/a2ui/client.ts re-sends it
      const resp = (await r2.waitFor(isResp(fcid), 5000, mark, 'agentFunctionResponse for re-sent call')).m.agentFunctionResponse;
      const v = resp.value ?? {};
      c.ok('re-sent call answered with a value (no error)', !!resp.value, JSON.stringify(resp.error ?? ''));
      const sameAsBefore = preResp?.value && v.orderId === preResp.value.orderId && v.idempotencyKey === preResp.value.idempotencyKey;
      c.ok('re-sent call deduplicated (duplicate:true or same orderId/key)', v.duplicate === true || sameAsBefore, JSON.stringify(v));
      c.ok('idempotencyKey = <sessionId>:<frame>', typeof v.idempotencyKey === 'string' && v.idempotencyKey.startsWith(`${h1.sessionId}:`) && /^\d+$/.test(v.idempotencyKey.slice(h1.sessionId.length + 1)), v.idempotencyKey);
      if (t2.status?.orderId != null) c.ok('restored /ticket/status.orderId matches', t2.status.orderId === v.orderId, `${t2.status.orderId} vs ${v.orderId}`);
      else c.info('restored /ticket/status', JSON.stringify(t2.status));
      const h2 = await a2.health();
      c.ok('exactly one order after dedup replay', h2.orders === 1, `orders=${h2.orders}`);
    } else {
      c.ok('health after restart: orders=0', h1.orders === 0, `orders=${h1.orders}`);
      // Complete the flow on the resumed session.
      // Submit the (restored) ticket, re-priced to be marketable now: the paper adapter is IOC against the live quote.
      const ticket = { symbol: t2.symbol, side: 'buy', quantity: editCtx?.quantity ?? Number(t2.quantity), limitPrice: marketableLimit(r2, Number(t2.limitPrice)) };
      fcid = randomUUID();
      let mark = r2.msgs.length;
      const frame = submitCall(surfaceId, fcid, ticket);
      const ts = r2.send(frame);
      const got = await r2.waitFor(isResp(fcid), 5000, mark, 'agentFunctionResponse (submit after resume)');
      const resp = got.m.agentFunctionResponse;
      ctx.submitRtts.push(got.at - ts);
      c.ok('submit after resume returns an order', !!resp.value?.orderId && resp.value.duplicate === false, JSON.stringify(resp.value ?? resp.error));
      c.info('paper order outcome', `${resp.value?.state} (${resp.value?.message ?? ''}) limit=${ticket.limitPrice} ask=${latestMarket(r2).ask}`);
      const terminal = (m) => {
        const u = m.updateDataModel; if (!u) return false;
        const st = u.path === '/ticket/status' ? u.value : u.path === '/ticket' ? u.value?.status : null;
        return ['filled', 'partially_filled', 'rejected'].includes(st?.state) && st?.orderId === resp.value?.orderId;
      };
      const status = await r2.waitFor(terminal, 3000, mark, 'terminal /ticket/status').catch(() => null);
      c.ok('ticket shows the order result (/ticket/status)', !!status, status ? JSON.stringify(status.m.updateDataModel.value).slice(0, 120) : 'no terminal /ticket/status carrying the orderId');
      let h2 = await a2.health();
      c.ok('exactly one order after submit', h2.orders === 1, `orders=${h2.orders}`);
      // Double-click / reconnect resend of the same call must not place a second order.
      mark = r2.msgs.length;
      r2.send(frame);
      const dup = (await r2.waitFor(isResp(fcid), 5000, mark, 'agentFunctionResponse (repeat call)')).m.agentFunctionResponse;
      c.ok('repeat of same functionCallId is duplicate', dup.value?.duplicate === true && dup.value?.orderId === resp.value?.orderId, JSON.stringify(dup.value ?? dup.error));
      h2 = await a2.health();
      c.ok('still exactly one order', h2.orders === 1, `orders=${h2.orders}`);
    }
    await sleep(200);
    allMsgs.push(...r2.msgs);
    const invalid = [...(c.invalid1 ?? []), ...r2.invalid];
    c.ok(`all ${allMsgs.length} received frames have valid A2UI v1.0 shape`, invalid.length === 0, invalid.slice(0, 2).map((x) => `${x.reason} :: ${x.raw}`).join(' | '));
    const bad = schemaInvalid.slice(schemaMark);
    if (SCHEMA.a2r) c.ok(`every frame (in+out) valid against official v1.0 JSON schemas`, bad.length === 0, bad.length ? bad.slice(0, 2).map((x) => `[${x.dir}] ${x.reason} :: ${x.raw}`).join(' | ') : `${allMsgs.length} in, ajv draft 2020-12 + bothq.trading.v0`);
    else c.info('JSON-Schema validation', `skipped: ${SCHEMA.why}`);
    const leaks = allMsgs.flatMap((x) => findSecretKeys(x.m));
    c.ok('no secret/account-id keys in client-bound frames', leaks.length === 0, leaks.slice(0, 5).join(', '));
  } catch (e) {
    c.fail('flow', e?.message ?? String(e));
    for (const a of [a1, a2]) if (a) c.info(`agent stderr tail (${a.pauseAt ?? 'restart'})`, a.tail(15).replace(/\n/g, ' | '));
  } finally {
    r1?.close(); r2?.close();
    for (const a of [a1, a2]) if (a && !a.exited) await a.kill9();
  }
  c.logPath = logPath;
  return c;
}

// ---------------------------------------------------------------- latency
async function latency(ctx) {
  const dir = fs.mkdtempSync(path.join(ctx.tmp, 'latency-'));
  const port = await freePort();
  const a = new Agent({ bin: ctx.bin, fixture: ctx.fixture, db: path.join(dir, 'agent.sqlite'), port, pauseAt: null, logPath: path.join(dir, 'agent.log'), extra: ['--replay-interval-ms', REPLAY_MS] }).start();
  const out = { notes: [] };
  const latMark = schemaInvalid.length;
  let r;
  try {
    await a.waitHealthy(10000);
    r = await new Renderer(`ws://127.0.0.1:${port}/a2ui/ws`).open();
    const cs = (await r.waitFor(isCreate, 5000, 0, 'createSurface')).m.createSurface;
    const start = r.msgs.length;
    // Collect N /market updates.
    const isMarket = (m) => m.updateDataModel && /^\/market(\/|$)/.test(m.updateDataModel.path ?? '/') ;
    const t0 = now();
    let got = 0, idx = start;
    const market = [];
    while (got < SAMPLES) {
      const x = await r.waitFor(isMarket, Math.max(3000, 20 * Number(REPLAY_MS)), idx, `market update #${got + 1}`).catch((e) => { out.notes.push(e.message); return null; });
      if (!x) break;
      market.push(x); idx = x.idx + 1; got++;
    }
    out.marketN = market.length;
    out.marketSpanMs = market.length ? market[market.length - 1].at - t0 : 0;
    // Feed tick -> client receive: needs an emit/tick timestamp in the frame.
    const feedLat = [];
    const tsFields = new Set();
    let reason = '';
    for (const x of market) {
      const { path: p = '/', value } = x.m.updateDataModel;
      const mk = p === '/' ? value?.market : p === '/market' ? value : null;
      const cands = isObj(mk) ? Object.entries(mk).filter(([k, v]) => typeof v === 'string' && /(asOf|At|Time|Ts)$/i.test(k)) : (p === '/market/asOf' ? [['asOf', value]] : []);
      for (const [k, v] of cands) {
        const ms = Date.parse(v);
        if (!Number.isFinite(ms)) continue;
        tsFields.add(k);
        const subSecond = /\.\d{3,}/.test(v);
        const d = x.wall - ms;
        if (!subSecond) { reason ||= `${k} has whole-second resolution (${v})`; continue; }
        if (Math.abs(d) > 60000) { reason ||= `${k}=${v} is ${(d / 1000).toFixed(0)} s from wall clock: it is fixture/exchange time, not emit time`; continue; }
        feedLat.push(d);
        break;
      }
    }
    out.feed = stats(feedLat);
    out.feedFields = [...tsFields];
    out.feedReason = feedLat.length ? '' : (reason || 'no timestamp field in /market updates');
    const gaps = market.slice(1).map((x, i) => x.at - market[i].at);
    out.gaps = stats(gaps);
    // Submit RTT.
    const rtts = [...ctx.submitRtts];
    const tk = cs.dataModel?.ticket ?? {};
    for (let i = 0; i < SUBMITS; i++) {
      const id = randomUUID();
      const mark = r.msgs.length;
      const ts = r.send(submitCall(cs.surfaceId, id, { symbol: tk.symbol, side: 'buy', quantity: 1, limitPrice: marketableLimit(r, Number(tk.limitPrice ?? 0.5)) }));
      const x = await r.waitFor(isResp(id), 5000, mark, `submit #${i + 1}`).catch((e) => { out.notes.push(e.message); return null; });
      if (!x) break;
      rtts.push(x.at - ts);
    }
    out.rtt = stats(rtts);
    out.invalid = r.invalid.length;
    out.schemaBad = schemaInvalid.length - latMark;
  } catch (e) {
    out.notes.push(`latency run aborted: ${e.message}`);
    out.notes.push(a.tail(10).replace(/\n/g, ' | '));
  } finally {
    r?.close();
    await a.kill9();
  }
  return out;
}

// ---------------------------------------------------------------- main
const bin = findBinary();
const fixture = findFixture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui-e2e-'));
const ctx = { bin, fixture, tmp, resumeTimes: [], submitRtts: [] };
console.log(`a2ui-e2e: binary  ${path.relative(REPO, bin)}`);
console.log(`a2ui-e2e: fixture ${path.relative(REPO, fixture)}`);
console.log(`a2ui-e2e: schema  ${SCHEMA.a2r ? 'full JSON-Schema (ajv 2020-12) + shape checks' : `shape checks only (${SCHEMA.why})`}`);
console.log(`a2ui-e2e: workdir ${tmp}${KEEP ? ' (kept)' : ''}\n`);

let failed = false;
if (MODE !== 'latency') {
  const results = [];
  for (const p of POINTS) {
    process.stdout.write(`-- kill point ${p} ... `);
    const c = await crashCase(p, ctx);
    const bad = c.rows.filter((x) => x.pass === false).length;
    console.log(bad ? `FAIL (${bad})` : 'PASS');
    results.push(c);
  }
  const rows = results.flatMap((c) => c.rows);
  const w1 = Math.max(...rows.map((r) => r.point.length), 10), w2 = Math.max(...rows.map((r) => r.name.length), 5);
  console.log(`\n${'KILL POINT'.padEnd(w1)}  ${'CHECK'.padEnd(w2)}  RESULT  DETAIL`);
  console.log(`${'-'.repeat(w1)}  ${'-'.repeat(w2)}  ------  ${'-'.repeat(30)}`);
  for (const r of rows) console.log(`${r.point.padEnd(w1)}  ${r.name.padEnd(w2)}  ${r.pass === null ? 'info  ' : r.pass ? 'PASS  ' : 'FAIL  '}  ${r.detail.slice(0, 160)}`);
  console.log('\nSUMMARY');
  for (const c of results) {
    const bad = c.rows.filter((x) => x.pass === false).length;
    const rt = ctx.resumeTimes.find((x) => x.point === c.point);
    console.log(`  ${c.point.padEnd(20)} ${bad ? 'FAIL' : 'PASS'}  resume=${rt ? fmt(rt.ms) + ' ms' : '-'}  checks=${c.rows.filter((x) => x.pass !== null).length}${bad ? `  log: ${c.logPath}` : ''}`);
    if (bad) failed = true;
  }
}
if (MODE !== 'crash') {
  const L = await latency(ctx);
  console.log(`\nLATENCY (local, print-only; target < ${LATENCY_TARGET_MS} ms, not a gate)`);
  console.log(`  metric                                 n     p50     p95     max`);
  const line = (name, s) => console.log(`  ${name.padEnd(36)} ${String(s?.n ?? 0).padStart(4)} ${fmt(s?.p50).padStart(7)} ${fmt(s?.p95).padStart(7)} ${fmt(s?.max).padStart(7)}${Number.isFinite(s?.p95) ? (s.p95 < LATENCY_TARGET_MS ? '   (p95 under target)' : '   (p95 OVER target)') : ''}`);
  if (L.feed?.n) line('feed tick -> client receive (ms)', L.feed);
  else console.log(`  feed tick -> client receive          not measurable: ${L.feedReason ?? 'n/a'}${L.feedFields?.length ? ` [fields: ${L.feedFields}]` : ''}`);
  line('submit WS round trip (ms)', L.rtt);
  if (L.gaps) console.log(`  /market update inter-arrival (ms)    ${String(L.gaps.n).padStart(4)} ${fmt(L.gaps.p50).padStart(7)} ${fmt(L.gaps.p95).padStart(7)} ${fmt(L.gaps.max).padStart(7)}   (${L.marketN} updates in ${fmt(L.marketSpanMs)} ms; context only)`);
  if (L.invalid) console.log(`  WARNING: ${L.invalid} frames failed the shape check during the latency run`);
  if (L.schemaBad) console.log(`  WARNING: ${L.schemaBad} frames failed JSON-Schema validation during the latency run`);
  for (const n of L.notes) console.log(`  note: ${n}`);
}
if (!KEEP && !failed) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`\nartifacts kept in ${tmp}`);
process.exit(failed ? 1 : 0);
