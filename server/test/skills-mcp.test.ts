import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Three skill folders: Zo, Hermes, and a clone of Anthropic's skills.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-mcp-'));
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const zo = path.join(base, 'zo'), hermesHome = path.join(base, 'hermes'), anth = path.join(base, 'anthropic', 'skills');
write(path.join(zo, 'web-scraper/SKILL.md'), '---\nname: web-scraper\ndescription: Crawl and extract data from websites.\n---\nRun scripts/scraper.py.\n');
write(path.join(zo, 'web-scraper/scripts/scraper.py'), 'print(1)\n');
write(path.join(zo, 'web-scraper/.secret'), 'hidden');
write(path.join(hermesHome, 'skills/research/arxiv/SKILL.md'), '---\nname: arxiv\ndescription: Search papers.\n---\nUse the API.\n');
write(path.join(anth, 'pdf/SKILL.md'), '---\nname: pdf\ndescription: Read, fill and make PDF files.\nlicense: Complete terms in LICENSE.txt\n---\n# PDF\n' + 'Long. '.repeat(10_000));
write(path.join(anth, 'pdf/LICENSE.txt'), '\n                                 Apache License\n                           Version 2.0, January 2004\n');
write(path.join(anth, 'pdf/scripts/fill_form.py'), 'pass\n');
write(path.join(anth, 'mit-one/SKILL.md'), '---\nname: mit-one\ndescription: An MIT skill.\n---\nx\n');
write(path.join(anth, 'mit-one/LICENSE'), 'MIT License\n\nCopyright');
write(path.join(anth, 'closed/SKILL.md'), '---\nname: closed\ndescription: Source-available only.\n---\nx\n');
write(path.join(anth, 'closed/LICENSE.txt'), '© Anthropic. All rights reserved. Proprietary.');
write(path.join(anth, 'no-license/SKILL.md'), '---\nname: no-license\ndescription: No license file.\n---\nx\n');

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = path.join(base, 'test.db');
process.env.SKILLS_ZO_DIR = zo;
process.env.HERMES_HOME_PRIMARY = hermesHome;
process.env.SKILLS_ANTHROPIC_DIR = anth;

const { db, now } = await import('../src/db.js');
const L = await import('../src/skill-library.js');
const { toolMap } = await import('../src/agent/tools.js');
const { mcpApi, skillIdFor, skillUri } = await import('../src/mcp.js');
const { mcpToken } = await import('../src/engine.js');

const user = 'u-sk';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, `${user}@example.com`, user, now());
db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  .run('bot-sk', user, 'Sk', '', '', '', 'blob', 'blue', 'personal', now(), now());

async function rpc(method: string, params: unknown = {}) {
  const r = await mcpApi.request('/bot-sk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken('bot-sk')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()) as any;
}

test('Anthropic skills are listed only with an Apache or MIT license file', () => {
  const ids = L.scanSkills(L.defaultRoots()).map((s) => s.id);
  assert.ok(ids.includes('anthropic:pdf'));
  assert.ok(ids.includes('anthropic:mit-one'));
  assert.ok(!ids.includes('anthropic:closed'), 'a proprietary license is left out');
  assert.ok(!ids.includes('anthropic:no-license'), 'no license file is left out');
  assert.ok(ids.includes('zo:web-scraper') && ids.includes('hermes:research/arxiv'), 'Zo and Hermes skills need no license file');
  assert.throws(() => L.readLibrarySkill('anthropic:closed'), /Unknown skill/, 'and cannot be read by naming it');
});

test('the old two-folder roots still work (Anthropic folder optional)', () => {
  const ids = L.scanSkills({ zo, hermes: path.join(hermesHome, 'skills') }).map((s) => s.id);
  assert.ok(ids.includes('zo:web-scraper') && !ids.some((i) => i.startsWith('anthropic:')));
  assert.throws(() => L.readLibrarySkill('anthropic:pdf', { zo, hermes: path.join(hermesHome, 'skills') }), /Unknown skill/);
});

test('skills_list filters by words and by source', async () => {
  const all = await toolMap.get('skills_list')!.impl({}, {} as any);
  assert.match(all.output, /^4 skills\./);
  const pdf = await toolMap.get('skills_list')!.impl({ query: 'PDF files' }, {} as any);
  assert.match(pdf.output, /anthropic:pdf — pdf: Read, fill and make PDF files\./);
  assert.doesNotMatch(pdf.output, /web-scraper/);
  const zoOnly = await toolMap.get('skills_list')!.impl({ source: 'zo' }, {} as any);
  assert.match(zoOnly.output, /^1 skills\./);
  const none = await toolMap.get('skills_list')!.impl({ query: 'zzz' }, {} as any);
  assert.match(none.output, /No skill matches/);
});

test('skill_read gives the instructions, the folder and its files (no hidden ones)', async () => {
  const r = await toolMap.get('skill_read')!.impl({ id: 'zo:web-scraper' }, {} as any);
  assert.match(r.output, /^# web-scraper\nCrawl and extract data from websites\.\n\nRun scripts\/scraper\.py\./);
  assert.ok(r.output.includes(path.join(fs.realpathSync(zo), 'web-scraper', 'scripts', 'scraper.py')));
  assert.doesNotMatch(r.output, /\.secret/);
  assert.doesNotMatch(r.output, /SKILL\.md\n/, 'SKILL.md itself is not listed as a file');
  const long = await toolMap.get('skill_read')!.impl({ id: 'anthropic:pdf' }, {} as any);
  assert.match(long.output, /\[Cut: the instructions are longer/);
  await assert.rejects(toolMap.get('skill_read')!.impl({ id: 'zo:../../etc' }, {} as any), /Unknown skill/);
});

test('skill:// addresses map to ids and back', () => {
  assert.equal(skillUri('hermes:research/arxiv'), 'skill://hermes/research/arxiv');
  assert.equal(skillIdFor('skill://hermes/research/arxiv'), 'hermes:research/arxiv');
  assert.equal(skillIdFor('file:///etc/passwd'), null);
});

test('over MCP: resources are offered, listed and read; unknown ones are not found', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(init.result.capabilities.resources, { listChanged: false });
  const list = await rpc('resources/list');
  const pdf = list.result.resources.find((r: any) => r.uri === 'skill://anthropic/pdf');
  assert.equal(pdf.title, 'pdf');
  assert.equal(pdf.mimeType, 'text/markdown');
  assert.ok(!list.result.resources.some((r: any) => r.uri.includes('closed')));
  const read = await rpc('resources/read', { uri: 'skill://hermes/research/arxiv' });
  assert.match(read.result.contents[0].text, /^---\nname: arxiv\ndescription: "Search papers\."\n---\n\nUse the API\./);
  assert.equal((await rpc('resources/read', { uri: 'skill://anthropic/closed' })).error.code, -32002);
  assert.equal((await rpc('resources/read', { uri: 'skill://zo/../../x' })).error.code, -32002);
  const tpl = await rpc('resources/templates/list');
  assert.equal(tpl.result.resourceTemplates[0].uriTemplate, 'skill://{source}/{path}');
});

test('over MCP: the skill tools are callable like any other tool', async () => {
  const r = await rpc('tools/call', { name: 'skills_list', arguments: { query: 'arxiv' } });
  assert.match(r.result.content[0].text, /hermes:research\/arxiv/);
});
