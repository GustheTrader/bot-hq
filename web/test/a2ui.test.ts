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
import { A2uiClient, BACKOFF_MAX_MS, BACKOFF_MIN_MS, EDIT_DEBOUNCE_MS, type SocketLike } from '../src/a2ui/client';
import { actionFunctionCall, resolveFunctionCall } from '../src/a2ui/bindings';
import { actionMessage, callAgentFunctionMessage, uuidv4, validationErrorMessage } from '../src/a2ui/messages';
import { applyAt, getAt } from '../src/a2ui/pointer';
import { createA2uiStore, emptyCore, reduce } from '../src/a2ui/store';
import type { AgentMessage, JsonObject, WireComponent } from '../src/a2ui/types';

/* ---------- schemas ---------- */

const SCHEMA_DIR = new URL('../../agents/a2ui-durable/schemas/v1_0/', import.meta.url);
const readJson = (u: URL) => JSON.parse(readFileSync(fileURLToPath(u), 'utf8'));
const schema = (name: string) => readJson(new URL(name, SCHEMA_DIR));
// The official schemas reference catalog.json#/$defs/anyComponent|anyFunction. Substitute a catalog that defines
// OrderTicket + submitOrder, registered under the v1_0 catalog.json URL (the catalog substitution trick). Every
// check runs against each catalog found: the agent's own (agents/a2ui-durable/catalog/, the source of truth once
// it exists), this renderer's contract fixture, and A2UI_TEST_CATALOG=<path> if set.
const CATALOG_ID_URL = 'https://a2ui.org/specification/v1_0/catalog.json';
const catalogSources: Array<{ label: string; json: Record<string, unknown> }> = [];
const agentCatalog = new URL('../../agents/a2ui-durable/catalog/bothq.trading.v0.json', import.meta.url);
if (existsSync(fileURLToPath(agentCatalog))) catalogSources.push({ label: 'agent catalog', json: readJson(agentCatalog) });
catalogSources.push({ label: 'renderer fixture catalog', json: readJson(new URL('./fixtures/bothq.trading.v0.catalog.json', import.meta.url)) });
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
  assert.equal(Object.keys(h.client.store.getState().surfaces).length, 0, 'dropped on reconnect, before any replay');
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
  // A good connection resets the backoff.
  h.last().open();
  h.last().drop();
  assert.deepEqual(h.runTimers(), [BACKOFF_MIN_MS]);
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

test('submit: uuid v4 id, pending until response, re-sent ONCE with the same id after a drop', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface());
  const s = h.client.store.getState().surfaces[SURFACE];
  const fc = resolveFunctionCall(actionFunctionCall(s.components.root.submit)!, s.dataModel);
  const id = h.client.callAgentFunction(SURFACE, fc);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.client.store.getState().calls[id].state, 'pending');
  const first = h.last().sent.at(-1)!;
  assertRendererToAgent(JSON.parse(first), 'callAgentFunction');

  // Socket drops before the response: the same frame (same functionCallId) goes out once on the new socket.
  h.last().drop(); h.runTimers(); h.last().open();
  assert.deepEqual(h.last().sent, [first]);
  assert.equal(h.client.store.getState().calls[id].resends, 1);

  // Drops again: not re-sent a second time; the call is marked unconfirmed instead.
  h.last().drop(); h.runTimers(); h.last().open();
  assert.deepEqual(h.last().sent, []);
  assert.equal(h.client.store.getState().calls[id].state, 'unconfirmed');
  h.client.stop();
});

test('submit: a response clears pending and nothing is re-sent after reconnect', () => {
  const h = harness();
  h.client.start();
  h.last().open();
  h.last().deliver(createSurface());
  const s = h.client.store.getState().surfaces[SURFACE];
  const id = h.client.callAgentFunction(SURFACE, resolveFunctionCall(actionFunctionCall(s.components.root.submit)!, s.dataModel));
  h.last().deliver({ version: '1.0', agentFunctionResponse: { functionCallId: id, value: { orderId: 'p-1', state: 'filled', filledQty: 1, avgPrice: 0.5, idempotencyKey: 'sess-1:13', duplicate: false } } });
  assert.equal(h.client.store.getState().calls[id].state, 'done');
  h.last().drop(); h.runTimers(); h.last().open();
  assert.deepEqual(h.last().sent, []);
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
