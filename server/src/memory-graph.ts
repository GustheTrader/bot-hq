/**
 * The bots' memory as a graph, from Hindsight (the shared memory store on this computer, HINDSIGHT_URL, default
 * http://127.0.0.1:8888): entities sized by how often they are mentioned, linked when they come up together, and
 * the facts behind any one entity. Read-only: only GET endpoints are called.
 */

const base = () => (process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8888').replace(/\/+$/, '');
const BANK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export class MemoryGraphError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 502 = 502) { super(message); }
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

async function get(path: string, fetchFn: Fetch): Promise<any> {
  let r;
  try { r = await fetchFn(`${base()}${path}`, { signal: AbortSignal.timeout(10_000) }); }
  catch { throw new MemoryGraphError('The memory store (Hindsight) is not answering on this computer.'); }
  if (r.status === 404) throw new MemoryGraphError('Not found in the memory store.', 404);
  if (!r.ok) throw new MemoryGraphError(`The memory store answered ${r.status}.`);
  return r.json();
}

export function checkBank(raw: unknown): string {
  const b = typeof raw === 'string' && raw ? raw : 'shared';
  if (!BANK_RE.test(b)) throw new MemoryGraphError('Unknown memory bank.', 400);
  return b;
}

export interface GraphNode { id: string; label: string; mentions: number }
export interface GraphEdge { source: string; target: string; weight: number; lastAt: string | null }

/** Hindsight's entity graph (Cytoscape-style `{data: …}` items) as plain nodes and edges. */
export function toGraph(raw: any): { nodes: GraphNode[]; edges: GraphEdge[]; totalEntities: number; totalEdges: number } {
  const nodes: GraphNode[] = (raw?.nodes ?? []).map((n: any) => n?.data ?? n).filter((d: any) => typeof d?.id === 'string')
    .map((d: any) => ({ id: d.id, label: String(d.label ?? '').slice(0, 80), mentions: Number(d.mentionCount ?? 1) || 1 }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = (raw?.edges ?? []).map((e: any) => e?.data ?? e)
    .filter((d: any) => ids.has(d?.source) && ids.has(d?.target) && d.source !== d.target)
    .map((d: any) => ({ source: d.source, target: d.target, weight: Number(d.weight ?? 1) || 1, lastAt: d.lastCooccurred ?? null }));
  return { nodes, edges, totalEntities: Number(raw?.total_entities ?? nodes.length), totalEdges: Number(raw?.total_edges ?? edges.length) };
}

export async function listBanks(fetchFn: Fetch = fetch as unknown as Fetch): Promise<{ id: string; facts: number; lastWriteAt: string | null }[]> {
  const d = await get('/v1/default/banks', fetchFn);
  return (d?.banks ?? []).map((b: any) => ({ id: String(b.bank_id), facts: Number(b.fact_count ?? 0), lastWriteAt: b.last_write_at ?? null }));
}

export async function memoryGraph(bankRaw: unknown, limitRaw: unknown, fetchFn: Fetch = fetch as unknown as Fetch) {
  const bank = checkBank(bankRaw);
  const limit = Math.min(400, Math.max(10, Number(limitRaw) || 150));
  const [graph, stats] = await Promise.all([
    get(`/v1/default/banks/${bank}/entities/graph?limit=${limit}`, fetchFn),
    get(`/v1/default/banks/${bank}/stats`, fetchFn).catch(() => null),
  ]);
  return {
    bank,
    ...toGraph(graph),
    stats: stats ? { facts: Number(stats.total_nodes ?? 0), links: Number(stats.total_links ?? 0), documents: Number(stats.total_documents ?? 0), byType: stats.nodes_by_fact_type ?? {} } : null,
  };
}

/** The facts that mention one entity, newest first. */
export async function entityFacts(bankRaw: unknown, entityId: unknown, fetchFn: Fetch = fetch as unknown as Fetch) {
  const bank = checkBank(bankRaw);
  if (typeof entityId !== 'string' || !ID_RE.test(entityId)) throw new MemoryGraphError('Unknown entity.', 400);
  const [entity, list] = await Promise.all([
    get(`/v1/default/banks/${bank}/entities/${entityId}`, fetchFn),
    get(`/v1/default/banks/${bank}/memories/list?entity_id=${entityId}&limit=25`, fetchFn),
  ]);
  return {
    entity: { id: String(entity.id), name: String(entity.canonical_name ?? ''), mentions: Number(entity.mention_count ?? 0), firstSeen: entity.first_seen ?? null, lastSeen: entity.last_seen ?? null },
    facts: (list?.items ?? []).map((m: any) => ({ id: String(m.id), text: String(m.text ?? ''), type: String(m.fact_type ?? ''), date: m.date ?? m.mentioned_at ?? null })),
  };
}
