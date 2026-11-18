import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skilllib-db-')), 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const L = await import('../src/skill-library.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skilllib-'));
const roots = { zo: path.join(base, 'zo'), hermes: path.join(base, 'hermes') };
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

write(path.join(roots.zo, 'ab-test-setup/SKILL.md'), '---\nname: ab-test-setup\ndescription: When the user wants to plan an A/B test.\nmetadata:\n  author: someone\n---\n\n# A/B tests\nStep one.\n');
write(path.join(roots.zo, 'folded/SKILL.md'), '---\nname: Folded one\ndescription: >-\n  First line\n  second line\n---\nBody here.\n');
write(path.join(roots.zo, 'no-header/SKILL.md'), 'Just instructions, no header.\n');
write(path.join(roots.zo, 'broken-header/SKILL.md'), '---\nname: [unclosed\n---\nStill readable.\n');
write(path.join(roots.zo, 'not-a-skill/README.md'), 'no SKILL.md here');
write(path.join(roots.zo, '.hidden/SKILL.md'), '---\nname: hidden\n---\nx');
write(path.join(roots.hermes, 'software-development/systematic-debugging/SKILL.md'), '---\nname: systematic-debugging\ndescription: Debug by hypothesis.\n---\nReproduce first.\n');
write(path.join(roots.hermes, 'productivity/docx/SKILL.md'), '---\nname: docx\ndescription: Word documents.\n---\nUse the docx tool.\n');
write(path.join(roots.zo, 'huge/SKILL.md'), '---\nname: huge\n---\n' + 'x'.repeat(300 * 1024));
write(path.join(base, 'outside-secret.md'), 'TOP SECRET, not a skill');

test('lists skills from both sources with their header fields, sorted', () => {
  const skills = L.scanSkills(roots);
  const byId = Object.fromEntries(skills.map((s) => [s.id, s]));

  assert.equal(byId['zo:ab-test-setup'].name, 'ab-test-setup');
  assert.equal(byId['zo:ab-test-setup'].description, 'When the user wants to plan an A/B test.');
  assert.equal(byId['zo:ab-test-setup'].category, '');
  assert.equal(byId['zo:folded'].name, 'Folded one');
  assert.equal(byId['zo:folded'].description, 'First line second line', 'a folded description becomes one line');
  assert.equal(byId['zo:no-header'].name, 'no-header', 'no header: the folder name is the name');
  assert.ok(byId['zo:broken-header'], 'a header that does not parse still lists the skill');
  assert.equal(byId['hermes:software-development/systematic-debugging'].category, 'software-development');
  assert.equal(byId['hermes:productivity/docx'].source, 'hermes');

  assert.ok(!byId['zo:not-a-skill'], 'a folder without SKILL.md is not a skill');
  assert.ok(!Object.keys(byId).some((k) => k.includes('.hidden')), 'hidden folders are skipped');
  assert.ok(!byId['zo:huge'], 'an oversized SKILL.md is not listed');
  assert.deepEqual(skills.map((s) => s.source), [...skills.map((s) => s.source)].sort(), 'zo before hermes');
});

test('a missing skills folder is just empty, not an error', () => {
  assert.deepEqual(L.scanSkills({ zo: path.join(base, 'nope'), hermes: path.join(base, 'nope2') }), []);
});

test('reads one skill by id: the instructions without the header', () => {
  const s = L.readLibrarySkill('zo:ab-test-setup', roots);
  assert.equal(s.name, 'ab-test-setup');
  assert.equal(s.description, 'When the user wants to plan an A/B test.');
  assert.equal(s.body, '# A/B tests\nStep one.');
  assert.equal(L.readLibrarySkill('hermes:productivity/docx', roots).body, 'Use the docx tool.');
  assert.equal(L.readLibrarySkill('zo:no-header', roots).body, 'Just instructions, no header.');
});

test('an id that is not a plain skill handle is refused, however it is dressed up', () => {
  for (const bad of ['', 'zo:', 'zo:../outside-secret.md', 'zo:ab-test-setup/../../outside-secret', 'zo:/etc/passwd', 'hermes:..', 'zo:.hidden', 'other:ab-test-setup', 'ab-test-setup', 'zo:a b', 'zo:a\\b', 'zo:ab-test-setup\0']) {
    assert.throws(() => L.readLibrarySkill(bad, roots), (e: any) => e.status === 400 || e.status === 404, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => L.readLibrarySkill(undefined as any, roots), (e: any) => e instanceof L.SkillError);
});

test('an id for a skill that does not exist, or is too big, is refused', () => {
  assert.throws(() => L.readLibrarySkill('zo:nothing-here', roots), (e: any) => e.status === 404);
  assert.throws(() => L.readLibrarySkill('zo:huge', roots), (e: any) => e.status === 400);
  assert.throws(() => L.readLibrarySkill('zo:not-a-skill', roots), (e: any) => e.status === 404);
});

test('a skill file that is a symlink out of the skills folder cannot be read', (t) => {
  fs.mkdirSync(path.join(roots.zo, 'evil'), { recursive: true });
  try { fs.symlinkSync(path.join(base, 'outside-secret.md'), path.join(roots.zo, 'evil/SKILL.md')); } catch { t.skip('symlinks are not permitted on this machine'); return; }
  assert.throws(() => L.readLibrarySkill('zo:evil', roots), (e: any) => e.status === 404);
});

test('a symlinked skill folder is not listed (and so cannot be reached through the listing)', (t) => {
  try { fs.symlinkSync(path.join(roots.zo, 'ab-test-setup'), path.join(roots.hermes, 'research-link'), 'dir'); } catch { t.skip('symlinks are not permitted on this machine'); return; }
  assert.ok(!L.scanSkills(roots).some((s) => s.id.includes('research-link')));
});

test('the instructions are capped so one skill cannot swamp a brief', () => {
  write(path.join(roots.zo, 'long/SKILL.md'), '---\nname: long\n---\n' + 'y'.repeat(L.MAX_BODY * 2));
  assert.equal(L.readLibrarySkill('zo:long', roots).body.length, L.MAX_BODY);
});
