import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeMetrics } = await import('../src/revops-metrics.js');
const G = await import('../src/memory-graph.js');

const DAY = 86_400_000;
const now = Date.parse('2026-11-19T12:00:00Z');
const row = (o: Partial<import('../src/revops-metrics.js').QueueRow>) => ({ team_id: 'team_a', kind: 'email', status: 'todo' as const, priority: 'normal', created_at: now - DAY, updated_at: now - DAY, due_at: null, done_at: null, ...o });

test('computeMetrics: KPIs, throughput, breakdowns', () => {
  const queue = [
    row({ status: 'done', created_at: now - 3 * DAY, updated_at: now - 2 * DAY }), // 24 h cycle
    row({ status: 'done', created_at: now - 2 * DAY, updated_at: now - 2 * DAY + 2 * 3_600_000, team_id: 'team_b' }), // 2 h
    row({ status: 'running', priority: 'urgent', due_at: now - 3_600_000 }), // overdue
    row({ status: 'blocked', kind: 'crm' }),
    row({ status: 'done', created_at: now - 90 * DAY, updated_at: now - 80 * DAY }), // outside the window
  ];
  const bots = [
    { bot_id: 'b1', state: 'working', created_at: now, updated_at: now },
    { bot_id: 'b1', state: 'needs_input', created_at: now, updated_at: now },
    { bot_id: 'b2', state: 'done', created_at: now - DAY, updated_at: now - DAY },
  ];
  const m = computeMetrics(queue, bots, { teams: new Map([['team_a', 'Ops'], ['team_b', 'Research']]), bots: new Map([['b1', 'Sam'], ['b2', 'Thoth']]) }, now, 30);
  assert.equal(m.kpis.open, 2);
  assert.equal(m.kpis.doneInPeriod, 2);
  assert.equal(m.kpis.createdInPeriod, 4);
  assert.equal(m.kpis.overdue, 1);
  assert.equal(m.kpis.blocked, 1);
  assert.equal(m.kpis.avgCycleHours, 13);
  assert.equal(m.kpis.completionRate, 50);
  assert.equal(m.kpis.botTasksOpen, 2);
  assert.equal(m.kpis.botTasksDone, 1);
  assert.equal(m.byPriority.urgent, 1);
  assert.equal(m.byKind.crm, 1);
  assert.ok(m.throughput.length >= 30);
  assert.equal(m.throughput.reduce((s, d) => s + d.done, 0), 2);
  assert.deepEqual(m.byTeam.find((t) => t.id === 'team_a'), { id: 'team_a', name: 'Ops', open: 2, done: 1, overdue: 1 });
  assert.deepEqual(m.byBot[0], { id: 'b1', name: 'Sam', working: 1, waiting: 1, done: 0 });
});

test('toGraph flattens Hindsight items and drops edges to unknown or same nodes', () => {
  const g = G.toGraph({
    nodes: [{ data: { id: 'a', label: 'Grok Bot', mentionCount: 70 } }, { data: { id: 'b', label: 'user', mentionCount: 94 } }],
    edges: [{ data: { source: 'a', target: 'b', weight: 22, lastCooccurred: '2026-11-18' } }, { data: { source: 'a', target: 'zzz' } }, { data: { source: 'a', target: 'a' } }],
    total_entities: 240, total_edges: 1000,
  });
  assert.deepEqual(g.nodes, [{ id: 'a', label: 'Grok Bot', mentions: 70 }, { id: 'b', label: 'user', mentions: 94 }]);
  assert.deepEqual(g.edges, [{ source: 'a', target: 'b', weight: 22, lastAt: '2026-11-18' }]);
  assert.equal(g.totalEntities, 240);
});

test('memory graph calls only read endpoints, checks bank and entity ids, and explains an unreachable store', async () => {
  const urls: string[] = [];
  const ok = async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => (url.includes('/memories/list') ? { items: [{ id: 'm1', text: 'Grok Bot shipped', fact_type: 'world', date: '2026-11-18' }] } : url.endsWith('/stats') ? { total_nodes: 751 } : { id: 'e1', canonical_name: 'Grok Bot', mention_count: 70, nodes: [], edges: [] }) }; };
  const g = await G.memoryGraph('shared', '9999', ok as any);
  assert.equal(g.bank, 'shared');
  assert.ok(urls.some((u) => u.endsWith('/v1/default/banks/shared/entities/graph?limit=4800')));
  const f = await G.entityFacts('shared', 'e154d581-21b1-40cf', ok as any);
  assert.equal(f.entity.name, 'Grok Bot');
  assert.equal(f.facts[0].text, 'Grok Bot shipped');
  await assert.rejects(G.memoryGraph('../etc', 10, ok as any), /Unknown memory bank/);
  await assert.rejects(G.entityFacts('shared', 'a/../b', ok as any), /Unknown entity/);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(G.memoryGraph('shared', 10, down as any), /not answering/);
});

test('topEntities keeps the most-mentioned entities and the links among them', () => {
  const g = { nodes: [{ id: 'a', label: 'a', mentions: 1 }, { id: 'b', label: 'b', mentions: 9 }, { id: 'c', label: 'c', mentions: 5 }], edges: [{ source: 'a', target: 'b', weight: 1, lastAt: null }, { source: 'b', target: 'c', weight: 2, lastAt: null }], totalEntities: 3, totalEdges: 2 };
  const t = G.topEntities(g, 2);
  assert.deepEqual(t.nodes.map((n) => n.id), ['b', 'c']);
  assert.deepEqual(t.edges, [{ source: 'b', target: 'c', weight: 2, lastAt: null }]);
  assert.equal(G.topEntities(g, 5), g);
});
