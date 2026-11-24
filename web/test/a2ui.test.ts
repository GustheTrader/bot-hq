/**
 * A2UI renderer core: store apply logic, reconnect/replay, function-call resolution and resend, and proof that
 * every frame the renderer sends validates against the official renderer_to_agent.json (A2UI v1.0).
 *
 * Run: npm test -w web   (tsx --test test/*.test.ts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { A2uiClient, BACKOFF_MAX_MS, BACKOFF_MIN_MS, EDIT_DEBOUNCE_MS, SENT_HISTORY, STABLE_OPEN_MS, type SocketLike } from '../src/a2ui/client';
import { actionFunctionCall, resolveFunctionCall, resolveValue } from '../src/a2ui/bindings';
import { actionMessage, callAgentFunctionMessage, uuidv4, validationErrorMessage } from '../src/a2ui/messages';
import { applyAt, getAt } from '../src/a2ui/pointer';
import { KNOWN_COMPONENTS, TRADING_CATALOG_ID } from '../src/a2ui/registry';
import { createA2uiStore, emptyCore, pruneCalls, reduce, type CallRecord } from '../src/a2ui/store';
import { isFunctionCall, type AgentMessage, type FunctionCall, type JsonObject, type WireComponent } from '../src/a2ui/types';

/* ---------- schemas ---------- */

const SCHEMA_DIR = new URL('../../agents/a2ui-durable/schemas/v1_0/', import.meta.url);
const readJson = (u: URL) => JSON.parse(readFileSync(fileURLToPath(u), 'utf8'));
const schema = (name: string) => readJson(new URL(name, SCHEMA_DIR));
// The official schemas reference catalog.json#/$defs/anyComponent|anyFunction. Substitute a catalog that defines
// OrderTicket + submitOrder, registered under the v1_0 catalog.json URL (the catalog substitution trick). The
// catalog is the agent's canonical one (agents/a2ui-durable/catalog/), loaded directly so the renderer tests can
// never drift from what the agent enforces; A2UI_TEST_CATALOG=<path> adds another to check against.
const CATALOG_ID_URL = 'https://a2ui.org/specification/v1_0/catalog.json';
const catalogSources: Array<{ label: string; json: Record<string, unknown> }> = [];
const agentCatalog = new URL('../../agents/a2ui-durable/catalog/bothq.trading.v0.json', import.meta.url);
assert.ok(existsSync(fileURLToPath(agentCatalog)), `canonical catalog missing: ${fileURLToPath(agentCatalog)}`);
const canonicalCatalog = readJson(agentCatalog) as Record<string, unknown>;
catalogSources.push({ label: 'agent catalog', json: canonicalCatalog });
if (process.env.A2UI_TEST_CATALOG) catalogSources.push({ label: process.env.A2UI_TEST_CATALOG, json: JSON.parse(readFileSync(process.env.A2UI_TEST_CATALOG, 'utf8')) });

type ValidateFn = ((d: unknown) => boolean) & { errors?: unknown };
type AjvLike = { addSchema(s: object): AjvLike; getSchema(id: string): ValidateFn | undefined };
const Ajv2020 = ((Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import) as new (o: object) => AjvLike;
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (a: AjvLike) => void;

const V1 = 'https://a2ui.org/specification/v1_0/';
const instances = catalogSources.map(({ label, json }) => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const catalog: Record<string, unknown> = { ...json, $id: CATALOG_ID_URL };
  for (const s of [schema('common_types.json'), catalog, schema('catalog_definition.json'), schema('agent_to_renderer.json'), schema('renderer_to_agent.json')]) ajv.addSchema(s);
  return { label, ajv, catalog };
});

function validator(name: string) {
  const fns = instances.map(({ label, ajv }) => {
    const v = ajv.getSchema(`${V1}${name}`);
    assert.ok(v, `schema ${name} loaded (${label})`);
    return { label, v };
  });
  return (data: unknown, what = 'message') => {
    for (const { label, v } of fns) {
      assert.ok(v(data), `${what} must validate against ${name} with the ${label}:\n${JSON.stringify(data)}\n${JSON.stringify(v.errors, null, 2)}`);
    }
  };
}
const assertRendererToAgent = validator('renderer_to_agent.json');
const assertAgentToRenderer = validator('agent_to_renderer.json');

/* ---------- contract fixtures (agent -> renderer) ---------- */

const SURFACE = 'ticket-main';
const ticketComponent = (): WireComponent => ({
  id: 'root',
  component: 'OrderTicket',
  symbol: { '@path': '/ticket/symbol' },
  side: { '@path': '/ticket/side' },
  quantity: { '@path': '/ticket/quantity' },
  limitPrice: { '@path': '/ticket/limitPrice' },
  livePrice: { '@path': '/market/lastPrice' },
  buyingPower: { '@path': '/account/buyingPower' },
  position: { '@path': '/account/position' },
  status: { '@path': '/ticket/status' },
  submit: {
    functionCall: {
      '@call': 'submitOrder',
      args: {
        symbol: { '@path': '/ticket/symbol' },
        side: { '@path': '/ticket/side' },
        quantity: { '@path': '/ticket/quantity' },
        limitPrice: { '@path': '/ticket/limitPrice' },
      },
    },
  },
});
const dataModel = (over: { lastPrice?: number; frame?: number; resumed?: boolean } = {}): JsonObject => ({
  ticket: { symbol: 'KXBTCD-26NOV24-T97000', side: 'buy', quantity: 1, limitPrice: 0.5, status: { state: 'idle', message: '', orderId: null } },
  market: { lastPrice: over.lastPrice ?? 0.51, bid: 0.5, ask: 0.52, asOf: '2026-11-24T10:00:00Z', source: 'kalshi' },
  account: { buyingPower: 1000.0, position: 0 },
  session: { id: 'sess-1', resumed: over.resumed ?? false, frame: over.frame ?? 12 },
});
const createSurface = (dm: JsonObject = dataModel()): AgentMessage =>
  ({ version: '1.0', createSurface: { surfaceId: SURFACE, catalogId: 'bothq.trading.v0', components: [ticketComponent()], dataModel: dm } }) as AgentMessage;
const updateDataModel = (path: string | undefined, value: unknown): AgentMessage =>
  ({ version: '1.0', updateDataModel: { surfaceId: SURFACE, ...(path === undefined ? {} : { path }), value } }) as AgentMessage;

/** What OrderTicket.onSubmit adds to every submit from the trusted click (CONTRACT.md). */
const ACTIVATION = { type: 'click', isTrusted: true, timestamp: '2026-11-24T10:00:05.000Z' };
/** The submit call exactly as OrderTicket builds it: bound args resolved, then userActivation attached. */
function submitWithActivation(client: A2uiClient): FunctionCall {
  const s = client.store.getState().surfaces[SURFACE];
  const call = resolveFunctionCall(actionFunctionCall(s.components.root.submit)!, s.dataModel);
  call.args = { ...call.args, userActivation: ACTIVATION };
  return call;
}

/* ---------- fake socket + timers ---------- */

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  onmessage: SocketLike['onmessage'] = null;
  constructor(readonly url: string) {}
  send(d: string) { assert.equal(this.readyState, 1, 'send only on an open socket'); this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  drop() { this.readyState = 3; this.onclose?.({}); }
  deliver(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; done: boolean }> = [];
  const client = new A2uiClient({
    url: () => 'ws://test/a2ui/ws',
    socket: (u) => { const s = new FakeSocket(u); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { done: boolean }).done = true; },
    log: () => {},
  });
  const runTimers = () => {
    const due = timers.filter((t) => !t.done);
    for (const t of due) { t.done = true; t.fn(); }
    return due.map((t) => t.ms);
  };
  const last = () => sockets[sockets.length - 1];
  return { client, sockets, timers, runTimers, last };
}

/* ---------- tests ---------- */

test('substitute catalogs are valid A2UI v1.0 catalog definitions', () => {
  assert.ok(instances.length >= 1);
  for (const { label, ajv, catalog } of instances) {
    const v = ajv.getSchema(`${V1}catalog_definition.json`)!;
    assert.ok(v(catalog), `${label} must be a valid catalog definition: ${JSON.stringify(v.errors, null, 2)}`);
    assert.equal(catalog.catalogId, 'bothq.trading.v0');
  }
});

test('contract fixtures are valid agent_to_renderer messages', () => {
  assertAgentToRenderer(createSurface(), 'createSurface');
  assertAgentToRenderer(updateDataModel('/market/lastPrice', 0.53), 'updateDataModel');
  assertAgentToRenderer(updateDataModel('/ticket/status/orderId', null), 'updateDataModel delete');
  assertAgentToRenderer({ version: '1.0', updateComponents: { surfaceId: SURFACE, components: [ticketComponent()] } }, 'updateComponents');
  assertAgentToRenderer({ version: '1.0', deleteSurface: { surfaceId: SURFACE } }, 'deleteSurface');
  assertAgentToRenderer({ version: '1.0', agentFunctionResponse: { functionCallId: uuidv4(), value: { orderId: 'p-1', state: 'filled', filledQty: 1, avgPrice: 0.5, idempotencyKey: 'sess-1:13', duplicate: false } } }, 'agentFunctionResponse');
  assertAgentToRenderer({ version: '1.0', agentFunctionResponse: { functionCallId: uuidv4(), error: { code: 'REJECTED', message: 'insufficient buying power' } } }, 'agentFunctionResponse error');
});

test('createSurface stores components and the inline data model', () => {
  const r = reduce(emptyCore(), createSurface());
  assert.equal(r.ignored, undefined);
  assert.deepEqual(r.problems, []);
  const s = r.state.surfaces[SURFACE];
  assert.equal(s.catalogId, 'bothq.trading.v0');
  assert.equal(s.components.root.component, 'OrderTicket');
  assert.equal(getAt(s.dataModel, '/market/lastPrice'), 0.51);
  assert.equal(getAt(s.dataModel, '/ticket/status/state'), 'idle');
});

test('updateDataModel sets a nested path without rebuilding the surface', () => {
  const s0 = reduce(emptyCore(), createSurface()).state;
  const s1 = reduce(s0, updateDataModel('/market/lastPrice', 0.55)).state;
  const before = s0.surfaces[SURFACE];
  const after = s1.surfaces[SURFACE];
  assert.equal(getAt(after.dataModel, '/market/lastPrice'), 0.55);
  assert.equal(getAt(before.dataModel, '/market/lastPrice'), 0.51, 'previous state untouched');
  assert.equal(after.components, before.components, 'components keep identity (no rebuild)');
  assert.equal(after.dataModel.account, before.dataModel.account, 'untouched branches keep identity');
  // Creates missing intermediate objects.
  const s2 = reduce(s1, updateDataModel('/market/depth/top', 3)).state;
  assert.equal(getAt(s2.surfaces[SURFACE].dataModel, '/market/depth/top'), 3);
  // Whole-object replace at a subtree.
  const s3 = reduce(s2, updateDataModel('/account', { buyingPower: 999.5, position: 2 })).state;
  assert.deepEqual(s3.surfaces[SURFACE].dataModel.account, { buyingPower: 999.5, position: 2 });
});

test('updateDataModel with value null deletes the key; root path replaces / resets', () => {
  const s0 = reduce(emptyCore(), createSurface()).state;
  const s1 = reduce(s0, updateDataModel('/ticket/status/orderId', null)).state;
  const status = getAt(s1.surfaces[SURFACE].dataModel, '/ticket/status') as JsonObject;
  assert.equal('orderId' in status, false);
  assert.equal(status.state, 'idle');
  // Deleting under a missing branch is a no-op, not a phantom object.
  const s2 = reduce(s1, updateDataModel('/nope/deeper', null)).state;
  assert.equal('nope' in s2.surfaces[SURFACE].dataModel, false);
  const s3 = reduce(s2, updateDataModel('/', { only: 1 })).state;
  assert.deepEqual(s3.surfaces[SURFACE].dataModel, { only: 1 });
  const s4 = reduce(s3, updateDataModel(undefined, null)).state;
  assert.deepEqual(s4.surfaces[SURFACE].dataModel, {});
});

test('JSON Pointer escapes and array semantics', () => {
  const m = applyAt({}, '/a~1b/c~0d', 1);
  assert.deepEqual(m, { 'a/b': { 'c~d': 1 } });
  const arr = applyAt({ xs: [1, 2, 3] }, '/xs/1', null);
  assert.deepEqual(arr, { xs: [1, 3] });
  assert.deepEqual(applyAt({ xs: [1] }, '/xs/-', 2), { xs: [1, 2] });
});

test('updates for unknown surfaces and malformed messages are ignored', () => {
  const s0 = emptyCore();
  assert.ok(reduce(s0, updateDataModel('/x', 1)).ignored);
  assert.ok(reduce(s0, { version: '0.9' } as unknown as AgentMessage).ignored);
  assert.equal(reduce(s0, updateDataModel('/x', 1)).state, s0);
});

test('deleteSurface removes the surface; agentFunctionResponse records the result', () => {
  const s0 = reduce(emptyCore(), createSurface()).state;
  const id = uuidv4();
  const s1 = reduce(s0, { version: '1.0', agentFunctionResponse: { functionCallId: id, value: { orderId: 'p-1' } } } as AgentMessage).state;
  assert.equal(s1.calls[id].state, 'done');
  const s2 = reduce(s1, { version: '1.0', deleteSurface: { surfaceId: SURFACE } } as AgentMessage).state;
  assert.deepEqual(Object.keys(s2.surfaces), []);
});

test('reconnect drops surfaces before the replay: exactly one ticket, with the replayed state', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface(dataModel({ lastPrice: 0.51, frame: 12 })));
  h.last().deliver(updateDataModel('/market/lastPrice', 0.52));
  // Locally held extra state must not survive the replay either.
  h.client.store.getState().setLocal(SURFACE, '/ticket/quantity', 7);
  assert.equal(Object.keys(h.client.store.getState().surfaces).length, 1);

  h.last().drop();
  assert.equal(h.client.store.getState().conn, 'reconnecting');
  assert.equal(Object.keys(h.client.store.getState().surfaces).length, 1, 'last state stays visible while offline');
  h.runTimers();
  h.last().open();
  // Open alone proves nothing (the relay accepts before dialling the agent): the stale ticket stays.
  assert.equal(Object.keys(h.client.store.getState().surfaces).length, 1, 'kept until the agent is proven reachable');
  assert.notEqual(h.client.store.getState().conn, 'connected');
  h.last().deliver(createSurface(dataModel({ lastPrice: 0.6, frame: 20, resumed: true })));
  const st = h.client.store.getState();
  assert.equal(Object.keys(st.surfaces).length, 1);
  assert.equal(getAt(st.surfaces[SURFACE].dataModel, '/market/lastPrice'), 0.6);
  assert.equal(getAt(st.surfaces[SURFACE].dataModel, '/ticket/quantity'), 1);
  assert.equal(getAt(st.surfaces[SURFACE].dataModel, '/session/resumed'), true);
  // Replaying the snapshot twice on one socket still yields one surface.
  h.last().deliver(createSurface(dataModel({ frame: 20, resumed: true })));
  assert.equal(Object.keys(h.client.store.getState().surfaces).length, 1);
  h.client.stop();
});

test('reconnect backoff starts at 250 ms, doubles, caps at 2 s, and retries forever', () => {
  const h = harness();
  h.client.start();
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) { h.last().drop(); delays.push(...h.runTimers()); }
  assert.deepEqual(delays, [BACKOFF_MIN_MS, 500, 1000, BACKOFF_MAX_MS, 2000, 2000, 2000]);
  assert.equal(h.sockets.length, 8);
  // A good connection (the agent's first frame) resets the backoff.
  h.last().open();
  h.last().deliver(createSurface());
  h.last().drop();
  assert.deepEqual(h.runTimers(), [BACKOFF_MIN_MS]);
  // So does a socket that stays open STABLE_OPEN_MS without a frame.
  for (let i = 0; i < 3; i++) { h.last().drop(); h.runTimers(); }
  h.last().open();
  assert.deepEqual(h.runTimers(), [STABLE_OPEN_MS]);
  assert.equal(h.client.store.getState().conn, 'connected');
  h.last().drop();
  assert.deepEqual(h.runTimers(), [BACKOFF_MIN_MS]);
  h.client.stop();
});

test('open-then-immediately-close (relay up, agent down) does NOT reset the backoff', () => {
  const h = harness();
  h.client.start();
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) { h.last().open(); h.last().drop(); delays.push(...h.runTimers()); }
  assert.deepEqual(delays, [BACKOFF_MIN_MS, 500, 1000, BACKOFF_MAX_MS, 2000, 2000]);
  assert.equal(h.client.store.getState().attempts, 6, 'attempts keep counting');
  assert.notEqual(h.client.store.getState().conn, 'connected');
  h.client.stop();
});

test('functionCall args resolve from the data model (local edits included)', () => {
  const s = reduce(emptyCore(), createSurface()).state.surfaces[SURFACE];
  const fc = actionFunctionCall(s.components.root.submit);
  assert.ok(fc);
  const model = applyAt(applyAt(s.dataModel, '/ticket/quantity', 3), '/ticket/side', 'sell');
  const resolved = resolveFunctionCall(fc, model);
  assert.deepEqual(resolved, { '@call': 'submitOrder', args: { symbol: 'KXBTCD-26NOV24-T97000', side: 'sell', quantity: 3, limitPrice: 0.5 } });
  assertRendererToAgent(callAgentFunctionMessage(SURFACE, uuidv4(), resolved), 'resolved callAgentFunction');
  // A hole in the order is an error, never a partial call.
  assert.throws(() => resolveFunctionCall(fc, applyAt(model, '/ticket/limitPrice', null)), /limitPrice/);
});

test('submit: uuid v4 id, userActivation carried, pending until response, re-sent ONCE with the same id after a drop', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface());
  const fc = submitWithActivation(h.client);
  const id = h.client.callAgentFunction(SURFACE, fc);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.client.store.getState().calls[id].state, 'pending');
  const first = h.last().sent.at(-1)!;
  const firstMsg = JSON.parse(first);
  assertRendererToAgent(firstMsg, 'callAgentFunction');
  assert.deepEqual(firstMsg.callAgentFunction.callFunction.args.userActivation, ACTIVATION, 'initial send carries userActivation');

  // A socket that opens and dies at once (relay up, agent down) must not burn the one re-send.
  h.last().drop(); h.runTimers(); h.last().open();
  assert.deepEqual(h.last().sent, [], 'nothing re-sent before the agent is reachable');
  h.last().drop(); h.runTimers();
  assert.equal(h.client.store.getState().calls[id].resends, 0);

  // Socket drops before the response: the same frame (same functionCallId) goes out once on the new socket.
  h.last().open(); h.last().deliver(createSurface());
  assert.deepEqual(h.last().sent, [first], 'byte-identical re-send');
  assert.deepEqual(JSON.parse(h.last().sent[0]).callAgentFunction.callFunction.args.userActivation, ACTIVATION, 'resend preserves userActivation');
  assert.equal(h.client.store.getState().calls[id].resends, 1);

  // Drops again: not re-sent a second time; the call is marked unconfirmed instead.
  h.last().drop(); h.runTimers(); h.last().open(); h.last().deliver(createSurface());
  assert.deepEqual(h.last().sent, []);
  assert.equal(h.client.store.getState().calls[id].state, 'unconfirmed');

  // Check status: the user re-asks; the byte-identical frame (same id, so the agent dedups) goes out once more.
  h.client.recheckCall(id);
  assert.deepEqual(h.last().sent, [first]);
  assert.equal(h.client.store.getState().calls[id].state, 'pending');
  h.client.stop();
});

test('submit: a response clears pending and nothing is re-sent after reconnect', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface());
  const id = h.client.callAgentFunction(SURFACE, submitWithActivation(h.client));
  h.last().deliver({ version: '1.0', agentFunctionResponse: { functionCallId: id, value: { orderId: 'p-1', state: 'filled', filledQty: 1, avgPrice: 0.5, idempotencyKey: 'sess-1:13', duplicate: false } } });
  assert.equal(h.client.store.getState().calls[id].state, 'done');
  h.last().drop(); h.runTimers(); h.last().open(); h.last().deliver(createSurface());
  assert.deepEqual(h.last().sent, []);
  h.client.stop();
});

test('ORDER_IN_FLIGHT (server rejects a second call while one is in flight) is recorded as an error answer', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface());
  const id = h.client.callAgentFunction(SURFACE, submitWithActivation(h.client));
  const resp = { version: '1.0', agentFunctionResponse: { functionCallId: id, error: { code: 'ORDER_IN_FLIGHT', message: 'an order for this surface is in flight' } } };
  assertAgentToRenderer(resp, 'ORDER_IN_FLIGHT response');
  h.last().deliver(resp);
  const rec = h.client.store.getState().calls[id];
  assert.equal(rec.state, 'done');
  assert.equal(rec.response?.error?.code, 'ORDER_IN_FLIGHT');
  h.client.stop();
});

test('submit refuses to queue behind a dead socket', () => {
  const h = harness();
  h.client.start();
  assert.throws(() => h.client.callAgentFunction(SURFACE, { '@call': 'submitOrder', args: { symbol: 'X', side: 'buy', quantity: 1, limitPrice: 0.5 } }), /Not connected/);
  assert.deepEqual(h.client.store.getState().calls, {});
  h.client.stop();
});

test('ticketEdited is debounced to one action with the latest values, and is schema-valid', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface());
  h.client.queueAction(SURFACE, 'ticketEdited', 'root', { side: 'buy', quantity: 1, limitPrice: 0.5 });
  h.client.queueAction(SURFACE, 'ticketEdited', 'root', { side: 'buy', quantity: 12, limitPrice: 0.5 });
  h.client.queueAction(SURFACE, 'ticketEdited', 'root', { side: 'sell', quantity: 12, limitPrice: 0.47 });
  assert.equal(h.last().sent.length, 0, 'nothing before the debounce fires');
  assert.deepEqual(h.runTimers(), [EDIT_DEBOUNCE_MS]);
  assert.equal(h.last().sent.length, 1);
  const msg = JSON.parse(h.last().sent[0]);
  assertRendererToAgent(msg, 'ticketEdited action');
  assert.equal(msg.action.name, 'ticketEdited');
  assert.equal(msg.action.sourceComponentId, 'root');
  assert.deepEqual(msg.action.context, { side: 'sell', quantity: 12, limitPrice: 0.47 });
  // flushActions sends a pending edit immediately (used right before submit).
  h.client.queueAction(SURFACE, 'ticketEdited', 'root', { side: 'sell', quantity: 2, limitPrice: 0.47 });
  h.client.flushActions(SURFACE);
  assert.equal(h.last().sent.length, 2);
  assert.deepEqual(h.runTimers(), [], 'flushed edit is not sent twice');
  h.client.stop();
});

test('unknown component / unknown catalog: problems recorded and VALIDATION_FAILED sent, schema-valid', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver({ version: '1.0', createSurface: { surfaceId: 'bad-1', catalogId: 'bothq.trading.v0', components: [{ id: 'root', component: 'Mystery' }], dataModel: {} } });
  h.last().deliver({ version: '1.0', createSurface: { surfaceId: 'bad-2', catalogId: 'example.com:other', components: [{ id: 'root', component: 'OrderTicket' }] } });
  h.last().deliver({ version: '1.0', createSurface: { surfaceId: 'bad-3', catalogId: 'example.com:other' } });
  const st = h.client.store.getState();
  assert.equal(st.surfaces['bad-1'].problems.root.path, '/components/0/component');
  assert.equal(st.surfaces['bad-2'].problems.root.path, '/catalogId');
  assert.ok(st.surfaces['bad-3'].problems.$surface);
  const errors = h.last().sent.map((f) => JSON.parse(f));
  assert.equal(errors.length, 3);
  for (const e of errors) {
    assertRendererToAgent(e, 'error');
    assert.equal(e.error.code, 'VALIDATION_FAILED');
  }
  assert.deepEqual(errors.map((e) => e.error.surfaceId), ['bad-1', 'bad-2', 'bad-3']);
  h.client.stop();
});

test('every builder output is a valid renderer_to_agent message', () => {
  assertRendererToAgent(actionMessage({ name: 'ticketEdited', surfaceId: SURFACE, sourceComponentId: 'root', context: { side: 'buy', quantity: 1, limitPrice: 0.5 } }));
  assertRendererToAgent(callAgentFunctionMessage(SURFACE, uuidv4(), { '@call': 'submitOrder', args: { symbol: 'KX', side: 'sell', quantity: 2, limitPrice: 0.99 } }));
  assertRendererToAgent(callAgentFunctionMessage(SURFACE, uuidv4(), { '@call': 'submitOrder', args: { symbol: 'KX', side: 'sell', quantity: 2, limitPrice: 0.99, userActivation: ACTIVATION } }), 'submit with userActivation');
  assertRendererToAgent(validationErrorMessage(SURFACE, '/components/0/component', 'Unknown component.'));
  // And the schema really is strict about the shapes we rely on.
  for (const { ajv } of instances) {
    const v = ajv.getSchema(`${V1}renderer_to_agent.json`)!;
    assert.equal(v({ version: '1.0', callAgentFunction: { surfaceId: SURFACE, functionCallId: 'x', callFunction: { '@call': 'notInCatalog' } } }), false);
    assert.equal(v({ version: '1.0', error: { code: 'VALIDATION_FAILED', surfaceId: SURFACE, message: 'missing path' } }), false);
    assert.equal(v({ version: '1.0', action: { name: 'ticketEdited', surfaceId: SURFACE, sourceComponentId: 'root', timestamp: 'not-a-date', context: {} } }), false);
  }
});

test('store wrapper: apply / setLocal / dropSurfaces', () => {
  const store = createA2uiStore();
  store.getState().apply(createSurface());
  store.getState().setLocal(SURFACE, '/ticket/limitPrice', 0.42);
  assert.equal(getAt(store.getState().surfaces[SURFACE].dataModel, '/ticket/limitPrice'), 0.42);
  store.getState().dropSurfaces();
  assert.deepEqual(store.getState().surfaces, {});
});

test('the canonical catalog constrains what the renderer may accept (Side / Quantity / Price / userActivation)', () => {
  const bad = (patch: Record<string, unknown>) =>
    ({ version: '1.0', createSurface: { surfaceId: SURFACE, catalogId: 'bothq.trading.v0', components: [{ ...ticketComponent(), ...patch }] } });
  for (const { ajv, label } of instances) {
    const a2r = ajv.getSchema(`${V1}agent_to_renderer.json`)!;
    assert.equal(a2r(bad({ side: 'hold' })), false, `side enum (${label})`);
    assert.equal(a2r(bad({ quantity: 0 })), false, `quantity >= 1 (${label})`);
    assert.equal(a2r(bad({ quantity: 1.5 })), false, `quantity integer (${label})`);
    assert.equal(a2r(bad({ limitPrice: 1.5 })), false, `price <= 0.99 (${label})`);
    const r2a = ajv.getSchema(`${V1}renderer_to_agent.json`)!;
    const call = (args: JsonObject) => ({ version: '1.0', callAgentFunction: { surfaceId: SURFACE, functionCallId: uuidv4(), callFunction: { '@call': 'submitOrder', args } } });
    const ok = { symbol: 'KX', side: 'buy', quantity: 1, limitPrice: 0.5 };
    assert.equal(r2a(call({ ...ok, userActivation: ACTIVATION })), true, `userActivation accepted (${label})`);
    assert.equal(r2a(call({ ...ok, userActivation: { type: 'hover', isTrusted: true, timestamp: ACTIVATION.timestamp } })), false, `activation type enum (${label})`);
    assert.equal(r2a(call({ ...ok, idempotencyKey: 'x' })), false, `no extra args (${label})`);
  }
});

test('registry.ts, catalogs.tsx and the canonical catalog name the same components', async () => {
  const { CATALOGS } = await import('../src/a2ui/catalogs');
  assert.deepEqual(Object.keys(CATALOGS).sort(), Object.keys(KNOWN_COMPONENTS).sort());
  for (const [id, names] of Object.entries(KNOWN_COMPONENTS)) assert.deepEqual(Object.keys(CATALOGS[id]).sort(), [...names].sort(), id);
  assert.equal(canonicalCatalog.catalogId, TRADING_CATALOG_ID);
  assert.deepEqual(Object.keys(canonicalCatalog.components as object).sort(), [...KNOWN_COMPONENTS[TRADING_CATALOG_ID]].sort());
});

test('pointer: past-the-end indexes are not addressable; deleting under a missing element is a no-op', () => {
  const m = { xs: [1, 2] };
  assert.equal(applyAt(m, '/xs/5', 9), m, 'no null padding');
  assert.equal(applyAt(m, '/xs/99999999', 9), m, 'no huge sparse array');
  assert.deepEqual(applyAt(m, '/xs/2', 3), { xs: [1, 2, 3] }, 'index == length appends');
  assert.equal(applyAt(m, '/xs/2/a', null), m, 'no phantom {} on delete');
  assert.equal(applyAt(m, '/xs/7/a/b', null), m);
  assert.deepEqual(applyAt({ xs: [{ a: 1, b: 2 }] }, '/xs/0/a', null), { xs: [{ b: 2 }] });
});

test('nested function calls in data props resolve to undefined (no render crash), and submit rejects them', () => {
  const nested = { '@call': 'formatCurrency', args: { v: 1 } };
  assert.equal(resolveValue(nested, {}), undefined);
  assert.deepEqual(resolveValue({ a: nested, b: 1 }, {}), { b: 1 });
  assert.throws(() => resolveFunctionCall({ '@call': 'submitOrder', args: { symbol: nested } }, {}), /symbol/);
});

test('isFunctionCall checks args and catalogId shapes', () => {
  assert.equal(isFunctionCall({ '@call': 'f' }), true);
  assert.equal(isFunctionCall({ '@call': 'f', args: {}, catalogId: 'c' }), true);
  assert.equal(isFunctionCall({ '@call': 'f', args: 'x' }), false);
  assert.equal(isFunctionCall({ '@call': 'f', args: [1] }), false);
  assert.equal(isFunctionCall({ '@call': 'f', catalogId: 3 }), false);
});

test('surface / call ids naming Object.prototype members are unknown, not inherited', () => {
  const s0 = reduce(emptyCore(), createSurface()).state;
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = reduce(s0, { version: '1.0', updateDataModel: { surfaceId: id, path: '/x', value: 1 } } as AgentMessage);
    assert.ok(r.ignored, id);
    assert.equal(r.state, s0);
    assert.ok(reduce(s0, { version: '1.0', updateComponents: { surfaceId: id, components: [] } } as AgentMessage).ignored, id);
    assert.ok(reduce(s0, { version: '1.0', deleteSurface: { surfaceId: id } } as AgentMessage).ignored, id);
  }
  const r = reduce(s0, { version: '1.0', agentFunctionResponse: { functionCallId: 'constructor', value: 1 } } as AgentMessage);
  const rec = Object.getOwnPropertyDescriptor(r.state.calls, 'constructor')?.value as CallRecord;
  assert.equal(rec.state, 'done');
  assert.equal(rec.surfaceId, '');
});

test('call records are bounded: only unfinished calls plus the newest per surface are kept', () => {
  const rec = (id: string, surfaceId: string, state: CallRecord['state'], startedAt: number): CallRecord =>
    ({ functionCallId: id, surfaceId, frame: '', state, sentEpoch: 1, resends: 0, startedAt });
  const calls = { a: rec('a', 'S', 'done', 1), b: rec('b', 'S', 'unconfirmed', 2), c: rec('c', 'S', 'done', 3), d: rec('d', 'T', 'done', 1) };
  assert.deepEqual(Object.keys(pruneCalls(calls)).sort(), ['b', 'c', 'd']);
  const kept = { b: calls.b, c: calls.c };
  assert.equal(pruneCalls(kept), kept, 'identity kept when nothing is evicted');
  // Through the client: 50 answered submits leave one record behind.
  const h = harness();
  h.client.start(); h.last().open(); h.last().deliver(createSurface());
  let last = '';
  for (let i = 0; i < 50; i++) {
    last = h.client.callAgentFunction(SURFACE, submitWithActivation(h.client));
    h.last().deliver({ version: '1.0', agentFunctionResponse: { functionCallId: last, value: { orderId: `p-${i}` } } });
  }
  assert.deepEqual(Object.keys(h.client.store.getState().calls), [last]);
  h.client.stop();
});

test('outbound history is bounded', () => {
  const h = harness();
  h.client.start(); h.last().open(); h.last().deliver(createSurface());
  for (let i = 0; i < SENT_HISTORY * 3; i++) h.client.send(validationErrorMessage(SURFACE, '/x', `m${i}`));
  assert.equal(h.client.sent.length, SENT_HISTORY);
  assert.equal(JSON.parse(h.client.sent.at(-1)!).error.message, `m${SENT_HISTORY * 3 - 1}`);
  h.client.stop();
});

test('lostAt lives in the shared store: set when a good connection drops, kept across flaps, cleared on reconnect', () => {
  const h = harness();
  h.client.start();
  assert.equal(h.client.store.getState().lostAt, null);
  h.last().open(); h.last().deliver(createSurface());
  const before = Date.now();
  h.last().drop();
  const lost = h.client.store.getState().lostAt;
  assert.ok(lost !== null && lost >= before);
  h.runTimers(); h.last().open(); h.last().drop();
  assert.equal(h.client.store.getState().lostAt, lost, 'a failed open does not move it');
  h.runTimers(); h.last().open(); h.last().deliver(createSurface());
  assert.equal(h.client.store.getState().lostAt, null);
  h.client.stop();
});

test('a debounced edit is timestamped when it happened, not when it is flushed', () => {
  const h = harness();
  h.client.start(); h.last().open(); h.last().deliver(createSurface());
  const t0 = Date.now();
  h.client.queueAction(SURFACE, 'ticketEdited', 'root', { side: 'buy', quantity: 1, limitPrice: 0.5 });
  const t1 = Date.now();
  while (Date.now() < t1 + 25) { /* the flush happens visibly later */ }
  h.runTimers();
  const ts = Date.parse(JSON.parse(h.last().sent.at(-1)!).action.timestamp);
  assert.ok(ts >= t0 && ts <= t1, `timestamp ${ts} is the edit time [${t0}, ${t1}]`);
  h.client.stop();
});
