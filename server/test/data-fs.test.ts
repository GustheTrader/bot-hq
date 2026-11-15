import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataGrep, dataList, dataRead, dataSearch, rrf, resolveUri, type DataConfig } from '../src/dataplane/fs.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dataplane-'));
const ws = path.join(tmp, 'ws');
const lib = path.join(tmp, 'lib');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(ws, 'proj/sub'), { recursive: true });
fs.mkdirSync(path.join(ws, 'proj/node_modules/x'), { recursive: true });
fs.mkdirSync(path.join(lib, 'bot1'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(ws, 'proj/README.md'), Array.from({ length: 50 }, (_, i) => `line ${i + 1} kalshi bias note`).join('\n'));
fs.writeFileSync(path.join(ws, 'proj/sub/a.ts'), 'export const ORNN_TICKER = "KXH100MS";\n');
fs.writeFileSync(path.join(ws, 'proj/node_modules/x/a.ts'), 'ORNN_TICKER inside node_modules\n');
fs.writeFileSync(path.join(ws, 'proj/.env'), 'SECRET=1\n');
fs.writeFileSync(path.join(lib, 'bot1/brief.md'), 'Weekly brief: the ornn model is biased toward YES.\n');
fs.writeFileSync(path.join(outside, 'x.txt'), 'nope');
fs.symlinkSync(outside, path.join(ws, 'proj/escape'));

const cfg: DataConfig = { roots: { workspace: ws, library: lib }, catalog: path.join(tmp, 'missing.sqlite'), rg: 'rg' };

test('resolveUri: fs:// and absolute paths map to the same uri', () => {
  assert.equal(resolveUri(cfg, 'fs://workspace/proj/README.md').uri, 'fs://workspace/proj/README.md');
  assert.equal(resolveUri(cfg, path.join(ws, 'proj/README.md')).uri, 'fs://workspace/proj/README.md');
});

test('resolveUri: refuses traversal, symlink escape, secrets, unknown roots', () => {
  assert.throws(() => resolveUri(cfg, 'fs://workspace/../outside/x.txt'), /escapes/);
  assert.throws(() => resolveUri(cfg, 'fs://workspace/proj/escape/x.txt'), /escapes/);
  assert.throws(() => resolveUri(cfg, 'fs://workspace/proj/.env'), /withheld/);
  assert.throws(() => resolveUri(cfg, 'fs://nope/a'), /Unknown root/);
  assert.throws(() => resolveUri(cfg, '/etc/passwd'), /not under an allowed root/);
  assert.throws(() => resolveUri(cfg, 'mcp://odds_api/x'), /fs:\/\/ only/);
});

test('dataRead: envelope, line range, truncation with next_start', () => {
  const r = dataRead(cfg, { uri: 'fs://workspace/proj/README.md', start: 10, end: 12 });
  assert.equal(r.content, 'line 10 kalshi bias note\nline 11 kalshi bias note\nline 12 kalshi bias note');
  assert.match(r.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.truncated, false);
  const t = dataRead(cfg, { uri: 'fs://workspace/proj/README.md', max_tokens: 200 });
  assert.equal(t.truncated, true);
  assert.ok(Number(t.next_start) > 1);
});

test('dataList: skips node_modules and secrets', () => {
  const l: any = dataList(cfg, { uri: 'fs://workspace/proj/', depth: 2 });
  const uris = l.entries.map((e: any) => e.uri);
  assert.ok(uris.includes('fs://workspace/proj/sub/a.ts'));
  assert.ok(!uris.some((u: string) => u.includes('node_modules') || u.endsWith('.env')));
  assert.deepEqual((dataList(cfg, {}) as any).roots.map((r: any) => r.uri), ['fs://workspace/', 'fs://library/']);
});

test('dataGrep: finds literal, skips node_modules, refuses whole-workspace root', async () => {
  const g = await dataGrep(cfg, { pattern: 'ORNN_TICKER', uri: 'fs://workspace/proj/', literal: true });
  assert.deepEqual(g.hits.map((h) => h.uri), ['fs://workspace/proj/sub/a.ts']);
  assert.equal(g.hits[0].line, 1);
  await assert.rejects(() => dataGrep(cfg, { pattern: 'x', uri: 'fs://workspace/' }), /Narrow the uri/);
});

test('dataSearch: library is searched live; missing catalog degrades with a warning', () => {
  const s: any = dataSearch(cfg, 'bot1', { query: 'ornn model bias' });
  assert.equal(s.results[0].uri, 'fs://library/bot1/brief.md');
  assert.match(s.warning, /missing/);
});

test('rrf: an item ranked by two engines beats one ranked first by one', () => {
  const mk = (key: string, engine: string) => ({ key, uri: key, abs: key, engine });
  const out = rrf([[mk('a', 'x'), mk('b', 'x')], [mk('b', 'y'), mk('c', 'y')]], 3);
  assert.equal(out[0].r.key, 'b');
  assert.deepEqual([...out[0].engines].sort(), ['x', 'y']);
});

test('secret patterns: dotted env files, tokens, key material', async () => {
  const { isSecretPath } = await import('../src/dataplane/fs.js');
  for (const p of ['a/.picks.env', '.env', '.env.local', 'x/prod.env', 'pg.pass', 'a/id_rsa', 'k.pem', 'auth.json']) assert.ok(isSecretPath(p), p);
  for (const p of ['README.md', 'env.ts', 'src/environment.md', 'docs/envelope.json']) assert.ok(!isSecretPath(p), p);
});
