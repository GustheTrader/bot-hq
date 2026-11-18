import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The store reads DB_PATH at import time, so point it at a scratch file before importing.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const P = await import('../src/projects.js');

function mkUser(): string {
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, now());
  return id;
}

test('a project round-trips and lists newest-changed first', () => {
  const u = mkUser();
  const a = P.createProject(u, { name: 'Pricing page', description: 'Rework seat tiers', folder: '/home/workspace/Projects/pricing', instructions: 'Keep copy short.', harness: 'claude-code', harnessModel: 'opus' });
  assert.equal(a.name, 'Pricing page');
  assert.equal(a.harness, 'claude-code');
  assert.equal(a.harnessModel, 'opus');
  assert.equal(a.skillCount, 0);
  const b = P.createProject(u, { name: 'Inbox triage' });
  assert.equal(b.harness, 'hermes', 'the default engine is Hermes');
  assert.equal(b.harnessModel, null);
  assert.equal(P.updateProject(u, a.id, { description: 'Reworked' }).description, 'Reworked');
  // Pin the change time well past the other project so the order does not depend on millisecond ties.
  db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now() + 60_000, a.id);
  assert.deepEqual(P.listProjects(u).map((p) => p.name), ['Pricing page', 'Inbox triage']);
});

test('projects belong to their owner: others cannot see, change or delete them', () => {
  const owner = mkUser();
  const other = mkUser();
  const p = P.createProject(owner, { name: 'Private' });
  const s = P.addProjectSkill(owner, p.id, { name: 'Tone', body: 'Be plain.' });

  assert.equal(P.getProject(other, p.id), null);
  assert.deepEqual(P.listProjects(other), []);
  assert.equal(P.listProjectSkills(other, p.id), null);
  assert.throws(() => P.updateProject(other, p.id, { name: 'Mine now' }), (e: any) => e.status === 404);
  assert.throws(() => P.addProjectSkill(other, p.id, { name: 'x', body: 'y' }), (e: any) => e.status === 404);
  assert.throws(() => P.updateProjectSkill(other, s.id, { name: 'Hijacked' }), (e: any) => e.status === 404);
  assert.equal(P.deleteProjectSkill(other, s.id), false);
  assert.equal(P.deleteProject(other, p.id), false);

  assert.equal(P.getProject(owner, p.id)?.name, 'Private', 'nothing changed');
  assert.equal(P.listProjectSkills(owner, p.id)?.[0].name, 'Tone');
});

test('names are required, single-line and trimmed; text is cleaned of control characters', () => {
  const u = mkUser();
  assert.throws(() => P.createProject(u, { name: '   ' }), (e: any) => e.status === 400);
  assert.throws(() => P.createProject(u, {}), (e: any) => e.status === 400);
  const p = P.createProject(u, { name: '  Big\nlaunch\u0000  ', folder: '/a/b\n/c', instructions: 'Line one\nLine two\u0007' });
  assert.equal(p.name, 'Big launch');
  assert.equal(p.folder, '/a/b /c');
  assert.equal(p.instructions, 'Line one\nLine two', 'newlines survive in notes, control characters do not');
  assert.equal(P.createProject(u, { name: 'x'.repeat(500) }).name.length, P.LIMITS.name);
  assert.throws(() => P.updateProject(u, p.id, { name: '' }), (e: any) => e.status === 400);
});

test('an empty harnessModel clears it; an omitted one leaves it alone', () => {
  const u = mkUser();
  const p = P.createProject(u, { name: 'Engines', harness: 'codex', harnessModel: 'gpt-x' });
  assert.equal(P.updateProject(u, p.id, { description: 'touch' }).harnessModel, 'gpt-x');
  assert.equal(P.updateProject(u, p.id, { harnessModel: '' }).harnessModel, null);
});

test('skills need a name and instructions, and are capped per project', () => {
  const u = mkUser();
  const p = P.createProject(u, { name: 'Skills' });
  assert.throws(() => P.addProjectSkill(u, p.id, { name: '', body: 'b' }), (e: any) => e.status === 400);
  assert.throws(() => P.addProjectSkill(u, p.id, { name: 'n', body: '  ' }), (e: any) => e.status === 400);
  for (let i = 0; i < P.LIMITS.skillsPerProject; i++) P.addProjectSkill(u, p.id, { name: `s${i}`, body: 'b' });
  assert.throws(() => P.addProjectSkill(u, p.id, { name: 'one too many', body: 'b' }), (e: any) => e.status === 409);
  assert.equal(P.getProject(u, p.id)?.skillCount, P.LIMITS.skillsPerProject);
});

test('deleting a project removes its skills; deleting one skill updates the count', () => {
  const u = mkUser();
  const p = P.createProject(u, { name: 'Cascade' });
  const a = P.addProjectSkill(u, p.id, { name: 'A', body: 'a' });
  P.addProjectSkill(u, p.id, { name: 'B', body: 'b' });
  assert.equal(P.deleteProjectSkill(u, a.id), true);
  assert.equal(P.getProject(u, p.id)?.skillCount, 1);
  assert.equal(P.deleteProject(u, p.id), true);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_skills WHERE project_id=?').get(p.id) as any).n, 0);
});

test('the brief carries the notes, the skills and the request, and omits empty parts', () => {
  const u = mkUser();
  const p = P.createProject(u, { name: 'Pricing page', folder: '/work/pricing', instructions: 'Keep copy short.' });
  const s = P.addProjectSkill(u, p.id, { name: 'Tone', description: 'How we sound', body: 'Plain and direct.' });
  const brief = P.buildProjectPrompt(p, [s], '  Draft the headline.  ');
  assert.match(brief, /project "Pricing page"/);
  assert.match(brief, /Folder: \/work\/pricing/);
  assert.match(brief, /Project notes:\nKeep copy short\./);
  assert.match(brief, /## Tone\nHow we sound\nPlain and direct\./);
  assert.match(brief, /Request:\nDraft the headline\.$/);
  assert.doesNotMatch(brief, /About:/, 'no description, no About line');

  const bare = P.buildProjectPrompt({ name: 'Bare', description: '', folder: '', instructions: '' }, [], 'Do it');
  assert.doesNotMatch(bare, /Project notes|Project skills|Folder:/);
  assert.match(bare, /Request:\nDo it$/);
});

test('the brief stays within budget: big skills fall back to name and description, the request always fits', () => {
  const u = mkUser();
  const p = P.createProject(u, { name: 'Big', instructions: 'x'.repeat(7000) });
  const small = P.addProjectSkill(u, p.id, { name: 'Small', body: 'tiny' });
  const bigA = P.addProjectSkill(u, p.id, { name: 'BigA', description: 'first big one', body: 'a'.repeat(P.LIMITS.skillBody) });
  const bigB = P.addProjectSkill(u, p.id, { name: 'BigB', description: 'second big one', body: 'b'.repeat(P.LIMITS.skillBody) });
  const brief = P.buildProjectPrompt(p, [small, bigA, bigB], 'Go.');

  assert.match(brief, /## Small\ntiny/);
  assert.ok(!brief.includes('a'.repeat(P.LIMITS.skillBody)), 'the oversized skill is not pasted in full');
  assert.match(brief, /More project skills[^\n]*\n- BigA: first big one\n- BigB: second big one/);
  assert.match(brief, /Request:\nGo\.$/);
  assert.ok(brief.length < P.LIMITS.brief + 500, `brief is ${brief.length} chars`);
});
