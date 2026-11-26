import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const { initRooms, createTeam } = await import('../src/agent/rooms.js');
const { initSubagents } = await import('../src/agent/subagents.js');
const O = await import('../src/obsidian.js');
const T = await import('../src/ontology.js');
const { bankById } = await import('../src/memory-banks.js');

initRooms();
initSubagents();
O.initObsidian();

const user = (() => {
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, now());
  return id;
})();
const mkBot = (name: string) => {
  const id = newId('bot');
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, user, name, '', '', '', 'blob', 'blue', 'personal', now(), now());
  return id;
};
const scout = mkBot('Scout');
const team = createTeam(user, 'Sales', { botIds: [scout, mkBot('Closer')] });

function write(vault: string, rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
}

/** A fake Hindsight that records writes and deletes. */
function store() {
  const calls: { method: string; url: string; body: any }[] = [];
  const fn = async (url: string, init: any = {}) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ operation_id: 'op' }), text: async () => '' };
  };
  return { calls, fn: fn as any, posts: () => calls.filter((c) => c.method === 'POST'), deletes: () => calls.filter((c) => c.method === 'DELETE') };
}

test('frontmatter: scalars, inline lists, dash lists and wikilink values', () => {
  const { data, body } = O.parseFrontmatter('---\ntype: person\ntags: [client, "vip"]\nworks_at: "[[Acme Corp]]"\nowns:\n  - "[[Deal 7]]"\n  - Roof job\n---\n# Dana\nHello');
  assert.equal(data.type, 'person');
  assert.deepEqual(data.tags, ['client', 'vip']);
  assert.equal(data.works_at, '[[Acme Corp]]');
  assert.deepEqual(data.owns, ['[[Deal 7]]', 'Roof job']);
  assert.equal(body, '# Dana\nHello');
  assert.deepEqual(O.parseFrontmatter('no frontmatter').data, {});
});

test('a typed note becomes a statement with its relations, links turned into plain names', () => {
  const n = O.readNote('Shared/Dana.md', '---\ntype: contact\nworks_at: "[[Acme Corp]]"\nunknown_field: x\n---\n# Dana Lee\nMet at [[Expo 2026|the expo]].');
  assert.equal(n.title, 'Dana Lee');
  assert.equal(n.type?.id, 'person', 'contact is an alias of person');
  assert.deepEqual(n.links, [{ rel: 'works_at', target: 'Acme Corp' }]);
  assert.equal(O.noteText(n), '# Dana Lee\nDana Lee is a person.\nDana Lee works at Acme Corp.\n\nMet at the expo.');
});

test('notes go to the bank their folder names; anything else is skipped with a reason', () => {
  assert.equal((O.routeNote('Shared/x.md') as any).id, 'shared');
  assert.equal((O.routeNote('Teams/sales/Pricing.md') as any).id, team);
  assert.equal((O.routeNote('Bots/Scout/notes/a.md') as any).id, scout);
  assert.match((O.routeNote('Teams/Legal/a.md') as any).skip, /no team named "Legal"/);
  assert.match((O.routeNote('Bots/Scout.md') as any).skip, /not under/);
  assert.match((O.routeNote('Inbox.md') as any).skip, /not under/);
});

test('ingest saves changed notes once, replaces edits by document id, and forgets deleted or moved notes', async () => {
  const vault = fs.mkdtempSync(path.join(dir, 'vault-'));
  write(vault, 'workspace/Shared/Acme.md', '---\ntype: company\n---\n# Acme Corp\nRoofing client since 2024.');
  write(vault, 'workspace/Teams/Sales/Pricing.md', '---\ntype: decision\nabout: "[[Acme Corp]]"\n---\nWe hold 2026 prices.');
  write(vault, 'workspace/Inbox.md', 'loose note');
  write(vault, 'workspace/.hidden/x.md', 'never');
  write(vault, 'workspace/Shared/my-secrets.md', 'never');

  const s1 = store();
  const r1 = await O.ingestVault(vault, s1.fn);
  assert.deepEqual(r1.saved.sort(), ['Shared/Acme.md', 'Teams/Sales/Pricing.md']);
  assert.deepEqual(r1.skipped.map((x) => x.path), ['Inbox.md']);
  const pricing = s1.posts().find((c) => c.url.includes(`/banks/${team}/memories`))!;
  const item = pricing.body.items[0];
  assert.match(item.document_id, /^obsidian-[0-9a-f]{24}$/);
  assert.equal(item.update_mode, 'replace');
  assert.match(item.content, /Pricing is a decision\.\nPricing is about Acme Corp\./);
  assert.deepEqual(item.entities, [{ text: 'Pricing', type: 'DECISION' }, { text: 'Acme Corp', type: 'ORG' }], 'Acme was typed by its own note');
  assert.ok(item.tags.includes('type:decision'));
  assert.equal(T.entityTyper()('acme corp').id, 'company');
  const acmeDoc = s1.posts().find((c) => c.url.includes('/banks/shared/'))!.body.items[0].document_id;

  const s2 = store();
  const r2 = await O.ingestVault(vault, s2.fn);
  assert.equal(r2.saved.length, 0);
  assert.equal(r2.unchanged, 2);
  assert.equal(s2.posts().length, 0, 'nothing unchanged is sent again');

  // Edit one note, move one to another bank, and delete nothing yet.
  write(vault, 'workspace/Shared/Acme.md', '---\ntype: company\n---\n# Acme Corp\nRoofing client since 2023.');
  fs.mkdirSync(path.join(vault, 'workspace/Bots/Scout'), { recursive: true });
  fs.renameSync(path.join(vault, 'workspace/Teams/Sales/Pricing.md'), path.join(vault, 'workspace/Bots/Scout/Pricing.md'));
  const s3 = store();
  const r3 = await O.ingestVault(vault, s3.fn);
  assert.deepEqual(r3.saved.sort(), ['Bots/Scout/Pricing.md', 'Shared/Acme.md']);
  assert.equal(s3.posts().find((c) => c.url.includes('/banks/shared/'))!.body.items[0].document_id, acmeDoc, 'an edit keeps the document id, so Hindsight replaces the old version');
  assert.deepEqual(r3.forgotten, ['Teams/Sales/Pricing.md']);
  assert.ok(s3.deletes().some((c) => c.url.includes(`/banks/${team}/documents/${item.document_id}`)), 'the old copy in the team bank is removed');

  fs.unlinkSync(path.join(vault, 'workspace/Shared/Acme.md'));
  const s4 = store();
  const r4 = await O.ingestVault(vault, s4.fn);
  assert.deepEqual(r4.forgotten, ['Shared/Acme.md']);
  assert.ok(s4.deletes().some((c) => c.url.includes('/banks/shared/documents/obsidian-')));
});

test('export writes typed entity notes with path links, never touches hand-written files, and prunes stale generated ones', async () => {
  const vault = fs.mkdtempSync(path.join(dir, 'vault-'));
  T.setEntityType('Dana Lee', 'person', 'note');
  const graph = {
    nodes: [{ data: { id: 'e1', label: 'Dana Lee', mentionCount: 9 } }, { data: { id: 'e2', label: 'Scout', mentionCount: 4 } }, { data: { id: 'e3', label: '2041', mentionCount: 2 } }, { data: { id: 'e4', label: 'blue: sky?', mentionCount: 1 } }],
    edges: [{ data: { source: 'e1', target: 'e2', weight: 3 } }],
    total_entities: 40,
  };
  const fetchFn = (async (url: string) => {
    const json = url.includes('/entities/graph') ? graph
      : url.includes('/stats') ? { total_nodes: 120, total_links: 30, total_documents: 5 }
      : url.includes('/memories/list') ? { items: url.includes('e1') ? [{ id: 'f1', text: 'Dana signed the 2026 renewal.', date: '2026-11-20T00:00:00Z' }] : [] }
      : { id: url.split('/entities/')[1]?.split('?')[0], canonical_name: 'x', mention_count: 1, first_seen: '2026-11-01T00:00:00Z', last_seen: '2026-11-21T00:00:00Z' };
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  }) as any;
  write(vault, 'Memory/Teams/Sales/People/My own note.md', '# hand-written, keep');
  write(vault, 'Memory/Teams/Sales/People/Old Person.md', '---\ntype: person\ngenerated: bot-hq\n---\n# gone');

  const r = await O.exportBanks(vault, [bankById(team)!], { fetchFn });
  assert.equal(r.banks[0].entities, 4);
  assert.equal(r.removed, 1);
  const base = path.join(vault, 'Memory/Teams/Sales');
  const dana = fs.readFileSync(path.join(base, 'People/Dana Lee.md'), 'utf8');
  assert.match(dana, /^---\ntype: person\nbank: "Team Sales"\nmentions: 9\nfirst_seen: 2026-11-01\nlast_seen: 2026-11-21\ngenerated: bot-hq\n---/);
  assert.match(dana, /- Dana signed the 2026 renewal\. \(2026-11-20\)/);
  assert.match(dana, /- \[\[Memory\/Teams\/Sales\/Bots\/Scout\|Scout\]\] · 3×/);
  assert.ok(fs.existsSync(path.join(base, 'Bots/Scout.md')), 'a bot name is typed as a bot');
  assert.ok(fs.existsSync(path.join(base, 'Jobs/2041.md')), 'a bare job number is a Build-flow job');
  assert.ok(fs.existsSync(path.join(base, 'Other/blue- sky-.md')), 'unsafe characters are replaced');
  assert.ok(fs.existsSync(path.join(base, 'People/My own note.md')), 'hand-written files are never removed');
  assert.ok(!fs.existsSync(path.join(base, 'People/Old Person.md')));
  assert.match(fs.readFileSync(path.join(base, '00 Sales.md'), 'utf8'), /## People \(1\)\n\n- \[\[Memory\/Teams\/Sales\/People\/Dana Lee\|Dana Lee\]\] · 9/);
  assert.match(fs.readFileSync(path.join(vault, 'Memory/Ontology.md'), 'utf8'), /\| `works_at` \| works at \|/);

  const again = await O.exportBanks(vault, [bankById(team)!], { fetchFn });
  assert.equal(again.banks[0].changed, 0, 'an unchanged bank rewrites nothing');
});

test('sync refuses to run without a vault', async () => {
  delete process.env.OBSIDIAN_VAULT;
  assert.equal(O.syncStatus().enabled, false);
  await assert.rejects(O.syncVault(), /OBSIDIAN_VAULT/);
});

test('Types.md types and hides names, replaces earlier typing, and the export colours the graph once', async () => {
  const vault = fs.mkdtempSync(path.join(dir, 'vault-'));
  write(vault, 'Types.md', '---\ntype: types\n---\n# Types\n\n## People\n- Doug\n- [[Gus the Trader]]  # the owner\n\n## service\n- Hindsight\n\n## not-a-type\n- Nobody\n\n## ignore\n- user\n- Assistant\n');
  const t = O.readTypesNote(vault);
  assert.deepEqual([...t.types], [['Doug', 'person'], ['Gus the Trader', 'person'], ['Hindsight', 'service']]);
  assert.deepEqual([...t.ignore], ['user', 'assistant']);

  const graph = {
    nodes: [{ data: { id: 'a', label: 'user', mentionCount: 90 } }, { data: { id: 'b', label: 'Hindsight', mentionCount: 11 } }, { data: { id: 'c', label: 'Doug', mentionCount: 9 } }],
    edges: [{ data: { source: 'a', target: 'b', weight: 5 } }, { data: { source: 'b', target: 'c', weight: 2 } }],
    total_entities: 3,
  };
  const facts: Record<string, string[]> = {
    b: ['Hindsight runs on port 8888.', 'The key is sk-abcdef1234567890XYZ for the store.'],
    c: ['Doug reviewed the plan.', 'Login at https://doug:hunter2@example.com/x', 'Hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 recorded.'],
  };
  const fetchFn = (async (url: string) => {
    const id = /entity_id=([^&]+)/.exec(url)?.[1] ?? url.split('/entities/')[1]?.split('?')[0];
    const json = url.includes('/entities/graph') ? graph : url.includes('/stats') ? null
      : url.includes('/memories/list') ? { items: (facts[id!] ?? []).map((text, i) => ({ id: `${id}${i}`, text })) } : { id, canonical_name: id, mention_count: 1 };
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  }) as any;

  const r = await O.exportBanks(vault, [bankById('shared')!], { fetchFn });
  assert.equal(r.banks[0].entities, 2, '"user" is left out');
  assert.equal(r.banks[0].withheld, 3);
  const base = path.join(vault, 'Memory/Shared');
  assert.ok(!fs.existsSync(path.join(base, 'Other/user.md')));
  const hs = fs.readFileSync(path.join(base, 'Services/Hindsight.md'), 'utf8');
  assert.match(hs, /- Hindsight runs on port 8888\./);
  assert.doesNotMatch(hs, /sk-abc/);
  assert.match(hs, /1 fact withheld/);
  assert.doesNotMatch(hs, /\[\[Memory\/Shared\/Other\/user/, 'no link to an ignored entity');
  const doug = fs.readFileSync(path.join(base, 'People/Doug.md'), 'utf8');
  assert.match(doug, /Doug reviewed the plan/);
  assert.doesNotMatch(doug, /hunter2|9f86d081/);
  assert.equal(T.entityTyper()('gus the trader').id, 'person');

  const graphCfg = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian/graph.json'), 'utf8'));
  assert.deepEqual(graphCfg.colorGroups.find((g: any) => g.query === '[type:person]').color, { a: 1, rgb: 0x7aa2f7 });
  fs.writeFileSync(path.join(vault, '.obsidian/graph.json'), '{"mine":true}');
  assert.equal(O.ensureGraphConfig(vault), false);
  assert.equal(fs.readFileSync(path.join(vault, '.obsidian/graph.json'), 'utf8'), '{"mine":true}', 'the person\'s own graph settings are kept');

  // Taking a name out of Types.md untypes it on the next sync.
  write(vault, 'Types.md', '## People\n- Doug\n');
  await O.exportBanks(vault, [bankById('shared')!], { fetchFn });
  assert.equal(T.entityTyper()('gus the trader').id, 'entity');
  assert.ok(fs.existsSync(path.join(base, 'Other/Hindsight.md')) && !fs.existsSync(path.join(base, 'Services/Hindsight.md')), 'a retyped entity moves folder and the old note is pruned');
});

test('the secret check catches keys, tokens and password URLs but not ordinary text', () => {
  for (const s of ['zo_sk_live1234567890abcd', 'ghp_ABCDEFGHijklmnop1234', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw', 'postgres://u:p4ss@db:5432/x', '-----BEGIN RSA PRIVATE KEY-----']) assert.ok(O.looksSecret(s), s);
  for (const s of ['Hindsight runs on 127.0.0.1:8888', 'See /home/workspace/Projects/unified-memory/ONTOLOGY.md', 'GROK_INTEGRATION_KEY_SHA256_FILE names the key file', 'Phase B spent about $0.11']) assert.ok(!O.looksSecret(s), s);
});
