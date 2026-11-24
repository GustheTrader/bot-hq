import { createStore, type StoreApi } from 'zustand/vanilla';
import { applyAt } from './pointer';
import { isKnownCatalog, isKnownComponent } from './registry';
import { isObject, type AgentMessage, type FunctionResponse, type JsonObject, type Json, type WireComponent } from './types';

/**
 * The A2UI surface store. `reduce` is a pure function over {surfaces, calls} so the node tests drive exactly the
 * logic the app runs; the zustand store wraps it with connection state and the local-edit helper.
 */

export interface Problem { path: string; message: string }

export interface Surface {
  surfaceId: string;
  catalogId?: string;
  components: Record<string, WireComponent>;
  dataModel: JsonObject;
  /** Catalog problems keyed by component id ('$surface' for the surface itself). Rendered as an error box. */
  problems: Record<string, Problem>;
}

export type CallState = 'pending' | 'done' | 'unconfirmed';
export interface CallRecord {
  functionCallId: string;
  surfaceId: string;
  /** The exact frame sent, so a resend after reconnect is byte-identical (same functionCallId). */
  frame: string;
  state: CallState;
  /** Connection epoch the frame was last sent on. */
  sentEpoch: number;
  resends: number;
  response?: FunctionResponse;
  startedAt: number;
}

export interface CoreState {
  surfaces: Record<string, Surface>;
  calls: Record<string, CallRecord>;
}

export interface Reduced { state: CoreState; problems: Array<Problem & { surfaceId: string }>; ignored?: string }

export const emptyCore = (): CoreState => ({ surfaces: {}, calls: {} });

function checkComponent(surfaceCatalog: string | undefined, c: WireComponent, index: number): Problem | null {
  const own = typeof c['@catalogId'] === 'string' ? (c['@catalogId'] as string) : undefined;
  const catalogId = own ?? surfaceCatalog;
  if (!isKnownCatalog(catalogId)) {
    return {
      path: own ? `/components/${index}/@catalogId` : '/catalogId',
      message: catalogId ? `Unknown catalog "${catalogId}" for component "${c.id}".` : `Component "${c.id}" has no catalogId and the surface has no default catalog.`,
    };
  }
  if (!isKnownComponent(catalogId, c.component)) {
    return { path: `/components/${index}/component`, message: `Catalog "${catalogId}" has no component "${c.component}".` };
  }
  return null;
}

function validComponents(list: unknown): list is WireComponent[] {
  return Array.isArray(list) && list.every((c) => isObject(c) && typeof c.id === 'string' && typeof c.component === 'string');
}

/** Apply one agent -> renderer message. Unknown / malformed messages leave the state untouched. */
export function reduce(s: CoreState, msg: AgentMessage): Reduced {
  const raw: unknown = msg;
  if (!isObject(raw) || raw.version !== '1.0') return { state: s, problems: [], ignored: 'not an A2UI v1.0 message' };

  if ('createSurface' in msg) {
    const m = msg.createSurface;
    if (!m || typeof m.surfaceId !== 'string') return { state: s, problems: [], ignored: 'createSurface without surfaceId' };
    const comps = m.components ?? [];
    if (!validComponents(comps)) return { state: s, problems: [], ignored: 'createSurface with malformed components' };
    const components: Record<string, WireComponent> = {};
    const problems: Record<string, Problem> = {};
    if (!isKnownCatalog(m.catalogId) && comps.length === 0) {
      problems.$surface = { path: '/catalogId', message: m.catalogId ? `Unknown catalog "${m.catalogId}".` : 'Surface has no catalogId.' };
    }
    comps.forEach((c, i) => {
      components[c.id] = c;
      const p = checkComponent(m.catalogId, c, i);
      if (p) problems[c.id] = p;
    });
    // A createSurface for an id we already hold replaces it: after a reconnect the agent's snapshot is the truth.
    const surface: Surface = { surfaceId: m.surfaceId, catalogId: m.catalogId, components, dataModel: isObject(m.dataModel) ? m.dataModel : {}, problems };
    return {
      state: { ...s, surfaces: { ...s.surfaces, [m.surfaceId]: surface } },
      problems: Object.values(problems).map((p) => ({ ...p, surfaceId: m.surfaceId })),
    };
  }

  if ('updateComponents' in msg) {
    const m = msg.updateComponents;
    const cur = m && s.surfaces[m.surfaceId];
    if (!cur) return { state: s, problems: [], ignored: 'updateComponents for an unknown surface' };
    if (!validComponents(m.components)) return { state: s, problems: [], ignored: 'updateComponents with malformed components' };
    const components = { ...cur.components };
    const problems = { ...cur.problems };
    delete problems.$surface;
    const fresh: Array<Problem & { surfaceId: string }> = [];
    m.components.forEach((c, i) => {
      components[c.id] = c;
      const p = checkComponent(cur.catalogId, c, i);
      if (p) { problems[c.id] = p; fresh.push({ ...p, surfaceId: cur.surfaceId }); }
      else delete problems[c.id];
    });
    return { state: { ...s, surfaces: { ...s.surfaces, [cur.surfaceId]: { ...cur, components, problems } } }, problems: fresh };
  }

  if ('updateDataModel' in msg) {
    const m = msg.updateDataModel;
    const cur = m && s.surfaces[m.surfaceId];
    if (!cur) return { state: s, problems: [], ignored: 'updateDataModel for an unknown surface' };
    if (!('value' in m)) return { state: s, problems: [], ignored: 'updateDataModel without value' };
    let dataModel: JsonObject;
    try { dataModel = applyAt(cur.dataModel, m.path, m.value as Json); }
    catch { return { state: s, problems: [], ignored: `bad path ${String(m.path)}` }; }
    return { state: { ...s, surfaces: { ...s.surfaces, [cur.surfaceId]: { ...cur, dataModel } } }, problems: [] };
  }

  if ('deleteSurface' in msg) {
    const id = msg.deleteSurface?.surfaceId;
    if (!id || !s.surfaces[id]) return { state: s, problems: [], ignored: 'deleteSurface for an unknown surface' };
    const surfaces = { ...s.surfaces };
    delete surfaces[id];
    return { state: { ...s, surfaces }, problems: [] };
  }

  if ('agentFunctionResponse' in msg) {
    const r = msg.agentFunctionResponse;
    if (!r || typeof r.functionCallId !== 'string') return { state: s, problems: [], ignored: 'agentFunctionResponse without functionCallId' };
    const prev = s.calls[r.functionCallId];
    const rec: CallRecord = prev
      ? { ...prev, state: 'done', response: r }
      : { functionCallId: r.functionCallId, surfaceId: '', frame: '', state: 'done', sentEpoch: 0, resends: 0, response: r, startedAt: Date.now() };
    return { state: { ...s, calls: { ...s.calls, [r.functionCallId]: rec } }, problems: [] };
  }

  return { state: s, problems: [], ignored: 'unsupported message type' };
}

/* ---------- zustand store ---------- */

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface A2uiState extends CoreState {
  conn: ConnState;
  /** Increments on every successful socket open. */
  epoch: number;
  /** Consecutive failed attempts since the last good connection. */
  attempts: number;
  apply: (msg: AgentMessage) => Reduced;
  /** Drop every surface: run on each (re)connect, before the new socket's snapshot is applied. */
  dropSurfaces: () => void;
  /** Renderer-local data-model write (field edits), same set/delete semantics as updateDataModel. */
  setLocal: (surfaceId: string, path: string, value: Json) => void;
  putCall: (rec: CallRecord) => void;
  setConn: (p: Partial<Pick<A2uiState, 'conn' | 'epoch' | 'attempts'>>) => void;
}

export type A2uiStore = StoreApi<A2uiState>;

export function createA2uiStore(): A2uiStore {
  return createStore<A2uiState>((set, get) => ({
    ...emptyCore(),
    conn: 'idle',
    epoch: 0,
    attempts: 0,
    apply: (msg) => {
      const { surfaces, calls } = get();
      const r = reduce({ surfaces, calls }, msg);
      if (r.state.surfaces !== surfaces || r.state.calls !== calls) set({ surfaces: r.state.surfaces, calls: r.state.calls });
      return r;
    },
    dropSurfaces: () => set({ surfaces: {} }),
    setLocal: (surfaceId, path, value) => {
      const cur = get().surfaces[surfaceId];
      if (!cur) return;
      set({ surfaces: { ...get().surfaces, [surfaceId]: { ...cur, dataModel: applyAt(cur.dataModel, path, value) } } });
    },
    putCall: (rec) => set({ calls: { ...get().calls, [rec.functionCallId]: rec } }),
    setConn: (p) => set(p),
  }));
}
