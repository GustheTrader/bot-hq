import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

/**
 * Data plane, `fs` transport (docs/DATA-PLANE.md, phase 0).
 *
 * One URI namespace over allowlisted local roots:
 *   fs://workspace/<rel>   fs://cloud/<rel>   fs://pub/<rel>   fs://library/<botId>/<rel>
 * Every path is realpath-resolved before the prefix check, so symlinks cannot escape a root.
 * Read-only: writes stay with save_file.
 */

export interface DataConfig {
  roots: Record<string, string>;
  catalog: string;
  rg: string;
}

export function defaultConfig(libraryRoot: string): DataConfig {
  const fromEnv = process.env.DATA_ROOTS;
  const roots: Record<string, string> = fromEnv
    ? Object.fromEntries(fromEnv.split(',').map((p) => p.split('=') as [string, string]).filter(([k, v]) => k && v))
    : { workspace: '/home/workspace', cloud: '/mnt/cloud', pub: '/mnt/pub' };
  roots.library = libraryRoot;
  return {
    roots,
    catalog: process.env.DATA_CATALOG ?? '/home/workspace/Projects/dsh-envopt/bench/catalog.sqlite',
    rg: process.env.RG_BIN ?? 'rg',
  };
}

export class DataError extends Error {}

const SECRET = [
  /(^|\/)[^/]*\.env(\.[^/]*)?$/i, /(^|\/)\.env[^/]*$/i, /\.(token|pass|secret)$/i, /\.(pem|key|p12|pfx|kdbx)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|\/)auth\.json$/i, /(^|\/)endpoint_key$/i, /(^|\/)credentials(\.json)?$/i, /(^|\/)\.netrc$/i,
  /(^|\/)[^/]*secrets?[^/]*\.(json|ya?ml|env|txt)$/i, /(^|\/)\.git\//, /(^|\/)Trash(\/|$)/,
];
export const isSecretPath = (rel: string) => SECRET.some((r) => r.test(rel));

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', 'Trash', '.next', '.cache'];

export interface Resolved { uri: string; root: string; rootPath: string; rel: string; abs: string }

/** `fs://workspace/a/b` (or a bare absolute path under a root) → resolved path inside its root. */
export function resolveUri(cfg: DataConfig, uri: string): Resolved {
  let u = String(uri ?? '').trim();
  if (!u) throw new DataError('Give a uri, e.g. fs://workspace/Projects/README.md');
  if (u.startsWith('/')) {
    const hit = Object.entries(cfg.roots).sort((a, b) => b[1].length - a[1].length).find(([, p]) => u === p || u.startsWith(p + '/'));
    if (!hit) throw new DataError(`${u} is not under an allowed root (${Object.keys(cfg.roots).map((r) => `fs://${r}`).join(', ')})`);
    u = `fs://${hit[0]}/${u.slice(hit[1].length + 1)}`;
  }
  const m = /^fs:\/\/([a-z0-9_-]+)\/?(.*)$/i.exec(u);
  if (!m) throw new DataError(`Unsupported uri "${uri}". Phase 0 serves fs:// only: ${Object.keys(cfg.roots).map((r) => `fs://${r}/`).join(', ')}`);
  const root = m[1].toLowerCase();
  const rootPath = cfg.roots[root];
  if (!rootPath) throw new DataError(`Unknown root fs://${root}. Roots: ${Object.keys(cfg.roots).join(', ')}`);
  const rel = path.posix.normalize(decodeURIComponent(m[2] ?? '')).replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
  if (rel.split('/').includes('..')) throw new DataError('Path escapes its root');
  let realRoot: string;
  try { realRoot = fs.realpathSync(rootPath); } catch { throw new DataError(`Root fs://${root} is not available on this machine`); }
  let abs: string;
  try { abs = fs.realpathSync(rel ? path.join(rootPath, rel) : rootPath); } catch { throw new DataError(`Not found: ${toUri(root, rel)}`); }
  if (abs !== realRoot && !abs.startsWith(realRoot + '/')) throw new DataError('Path escapes its root');
  const realRel = abs === realRoot ? '' : abs.slice(realRoot.length + 1);
  if (isSecretPath(realRel) || isSecretPath(rel)) throw new DataError('That file is withheld from the data tools (credentials or trash).');
  return { uri: toUri(root, realRel), root, rootPath: realRoot, rel: realRel, abs };
}

export const toUri = (root: string, rel: string) => `fs://${root}/${rel}`;

const sha256 = (b: Buffer | string) => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

function looksBinary(b: Buffer) {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

export interface Envelope {
  uri: string; source: 'fs'; bytes: number; mtime: string; hash: string; stale_seconds: number;
  truncated: boolean; content?: string; [k: string]: unknown;
}

const MAX_READ_BYTES = 20 * 1024 * 1024;

export function dataRead(cfg: DataConfig, a: { uri: string; start?: number; end?: number; max_tokens?: number }): Envelope {
  const r = resolveUri(cfg, a.uri);
  const st = fs.statSync(r.abs);
  if (st.isDirectory()) throw new DataError(`${r.uri} is a directory; use data_list`);
  if (st.size > MAX_READ_BYTES) throw new DataError(`${r.uri} is ${st.size} bytes; use data_grep on it instead of reading it whole`);
  const buf = fs.readFileSync(r.abs);
  const base = { uri: r.uri, source: 'fs' as const, bytes: st.size, mtime: iso(st.mtimeMs), hash: sha256(buf), stale_seconds: 0 };
  if (looksBinary(buf)) return { ...base, truncated: false, binary: true, content: '' };
  const lines = buf.toString('utf8').split('\n');
  const total = lines.length;
  const start = Math.max(1, Math.floor(Number(a.start) || 1));
  const end = Math.min(total, Math.floor(Number(a.end) || total));
  const budget = Math.max(200, Math.min(32000, Math.floor(Number(a.max_tokens) || 8000))) * 4;
  const out: string[] = [];
  let used = 0;
  let last = start - 1;
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1];
    if (used + line.length + 1 > budget && out.length) break;
    out.push(line.length > budget ? line.slice(0, budget) : line);
    used += line.length + 1;
    last = i;
  }
  const truncated = last < end;
  return {
    ...base, truncated, lines: `${start}-${last}`, total_lines: total,
    ...(truncated ? { next_start: last + 1 } : {}),
    content: out.join('\n'),
  };
}

export function dataList(cfg: DataConfig, a: { uri?: string; depth?: number; max_entries?: number }) {
  if (!a.uri || a.uri === 'fs://' || a.uri === 'fs:') {
    return { roots: Object.entries(cfg.roots).map(([k, p]) => ({ uri: `fs://${k}/`, available: fs.existsSync(p) })) };
  }
  const r = resolveUri(cfg, a.uri);
  const depth = Math.max(1, Math.min(4, Math.floor(Number(a.depth) || 1)));
  const cap = Math.max(1, Math.min(2000, Math.floor(Number(a.max_entries) || 300)));
  const st = fs.statSync(r.abs);
  if (!st.isDirectory()) return { uri: r.uri, entries: [{ uri: r.uri, type: 'file', bytes: st.size, mtime: iso(st.mtimeMs) }], truncated: false };
  const entries: object[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, d: number) => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    names.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of names) {
      if (entries.length >= cap) { truncated = true; return; }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isSecretPath(childRel) || (e.isDirectory() && SKIP_DIRS.includes(e.name))) continue;
      const full = path.join(dir, e.name);
      let s: fs.Stats;
      try { s = fs.statSync(full); } catch { continue; }
      const isDir = s.isDirectory();
      entries.push({ uri: toUri(r.root, childRel) + (isDir ? '/' : ''), type: isDir ? 'dir' : 'file', ...(isDir ? {} : { bytes: s.size }), mtime: iso(s.mtimeMs) });
      if (isDir && d < depth) walk(full, childRel, d + 1);
    }
  };
  walk(r.abs, r.rel, 1);
  return { uri: r.uri, depth, count: entries.length, truncated, entries };
}

interface GrepHit { uri: string; line: number; text: string }

export async function dataGrep(cfg: DataConfig, a: { pattern: string; uri: string; glob?: string; max_hits?: number; literal?: boolean; case_sensitive?: boolean; timeout_ms?: number }) {
  const pattern = String(a.pattern ?? '');
  if (!pattern) throw new DataError('Give a pattern');
  const r = resolveUri(cfg, a.uri);
  if (!r.rel && (r.root === 'workspace' || r.root === 'cloud')) {
    throw new DataError(`Grepping all of fs://${r.root}/ takes over a minute on this filesystem. Narrow the uri (e.g. fs://${r.root}/Projects/<name>/) or use data_search to find where to look.`);
  }
  const max = Math.max(1, Math.min(500, Math.floor(Number(a.max_hits) || 50)));
  const args = ['--json', '--no-ignore-vcs', '--no-ignore-parent', '--max-filesize', '2M', '--max-columns', '400', '--max-columns-preview'];
  if (a.literal) args.push('-F');
  if (!a.case_sensitive) args.push('-S');
  for (const d of SKIP_DIRS) args.push('-g', `!${d}`);
  args.push('-g', '!.env*', '-g', '!*.pem', '-g', '!*.key');
  if (a.glob) args.push('-g', String(a.glob));
  args.push('-e', pattern, r.abs);
  const hits: GrepHit[] = [];
  let timedOut = false;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cfg.rg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, Math.max(1000, Math.min(60000, Number(a.timeout_ms) || 20000)));
    let buf = '';
    let err = '';
    p.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (hits.length >= max) continue;
        try {
          const m = JSON.parse(line);
          if (m.type !== 'match') continue;
          const file: string = m.data.path.text ?? '';
          const rel = file === r.rootPath ? '' : file.slice(r.rootPath.length + 1);
          if (isSecretPath(rel)) continue;
          hits.push({ uri: toUri(r.root, rel), line: m.data.line_number, text: String(m.data.lines.text ?? '').replace(/\n$/, '').slice(0, 400) });
          if (hits.length >= max) p.kill('SIGTERM');
        } catch { /* partial json from a killed process */ }
      }
    });
    p.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(timer); reject(new DataError(`ripgrep is not available: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2 && !hits.length && !timedOut && /regex parse error/i.test(err)) reject(new DataError(`Bad pattern: ${err.split('\n').slice(0, 3).join(' ')}`));
      else resolve();
    });
  });
  return { uri: r.uri, pattern, count: hits.length, truncated: hits.length >= max, timed_out: timedOut, hits };
}

/* ---------- search: catalog FTS (content) + catalog paths + live library, merged with RRF ---------- */

const STOP = new Set('a an and are as at be by did do does for from has have how in into is it its of on or that the their there these this to was we were what when where which who why with you your about our us'.split(' '));
export const queryTokens = (q: string) => [...new Set((q.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((t) => !STOP.has(t)))].slice(0, 12);

interface Ranked { key: string; uri: string; title?: string; snippet?: string; abs: string; engine: string }

let cached: { path: string; mtime: number; db: Database.Database } | null = null;
/** One read-only handle, reopened when the catalog is rebuilt (its mtime moves). */
function openCatalog(cfg: DataConfig): Database.Database | null {
  let mtime: number;
  try { mtime = fs.statSync(cfg.catalog).mtimeMs; } catch { return null; }
  if (cached && cached.path === cfg.catalog && cached.mtime === mtime) return cached.db;
  try { cached?.db.close(); } catch { /* already closed */ }
  try {
    const db = new Database(cfg.catalog, { readonly: true, fileMustExist: true });
    cached = { path: cfg.catalog, mtime, db };
    return db;
  } catch { cached = null; return null; }
}

function catalogDocs(db: Database.Database, toks: string[], k: number, workspace: string): Ranked[] {
  if (!toks.length) return [];
  const fts = toks.map((t) => `"${t}"`).join(' OR ');
  const rows = db.prepare(
    "SELECT d.path AS path, d.title AS title, snippet(docs_fts, 2, '«', '»', '…', 24) AS snip, bm25(docs_fts, 2.0, 1.5, 1.0) AS score " +
    'FROM docs_fts JOIN docs d ON d.path = docs_fts.path WHERE docs_fts MATCH ? ORDER BY score LIMIT ?',
  ).all(fts, k * 6) as any[];
  return rows.filter((r) => !isNoise(r.path)).map((r) => ({ key: path.join(workspace, r.path), uri: `fs://workspace/${r.path}`, title: r.title, snippet: r.snip, abs: path.join(workspace, r.path), engine: 'catalog' }));
}

function catalogPaths(db: Database.Database, toks: string[], k: number, workspace: string): Ranked[] {
  const useful = toks.filter((t) => t.length >= 3);
  if (!useful.length) return [];
  const rows = db.prepare('SELECT path, bm25(file_fts) AS score FROM file_fts WHERE file_fts MATCH ? ORDER BY score LIMIT ?')
    .all(useful.map((t) => `"${t}"`).join(' OR '), k * 6) as any[];
  return rows
    .filter((r) => !isNoise(r.path) && /\.(md|txt|py|ts|tsx|rs|ya?ml|toml|json|sql|ipynb|csv)$/i.test(r.path))
    .map((r) => ({ key: path.join(workspace, r.path), uri: `fs://workspace/${r.path}`, abs: path.join(workspace, r.path), engine: 'paths' }));
}

/** Live scan of one bot's Library (small, never in the catalog). */
function libraryHits(cfg: DataConfig, botId: string, toks: string[], k: number): Ranked[] {
  const dir = path.join(cfg.roots.library, botId);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const scored: { r: Ranked; n: number }[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(abs, 'utf8').toLowerCase();
      const n = toks.filter((t) => text.includes(t) || name.toLowerCase().includes(t)).length;
      if (!n) continue;
      const first = toks.map((t) => text.indexOf(t)).filter((i) => i >= 0).sort((x, y) => x - y)[0] ?? 0;
      scored.push({ n, r: { key: abs, uri: `fs://library/${botId}/${name}`, title: name, snippet: text.slice(Math.max(0, first - 80), first + 160).replace(/\s+/g, ' '), abs, engine: 'library' } });
    } catch { /* unreadable */ }
  }
  return scored.sort((x, y) => y.n - x.n).slice(0, k).map((s) => s.r);
}

/** Reciprocal rank fusion. Each engine's list contributes 1/(K + rank). */
export function rrf(lists: Ranked[][], k: number, K = 60) {
  const acc = new Map<string, { r: Ranked; score: number; engines: Set<string> }>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((r, i) => {
      if (seen.has(r.key)) return;
      seen.add(r.key);
      const cur = acc.get(r.key) ?? { r, score: 0, engines: new Set<string>() };
      cur.score += 1 / (K + i + 1);
      cur.engines.add(r.engine);
      if (!cur.r.snippet && r.snippet) cur.r = { ...cur.r, snippet: r.snippet, title: r.title ?? cur.r.title };
      acc.set(r.key, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

const nearDup = (a: string, b: string) => {
  const pa = a.split('/'); const pb = b.split('/');
  if (pa.at(-1) !== pb.at(-1)) return false;
  let j = 0;
  while (j < Math.min(pa.length, pb.length) - 1 && pa[j] === pb[j]) j++;
  return j >= 4;
};

/** Vendored copies, engine homes and build output: indexed, but never the answer to "where is X". */
const NOISE = /(^|\/)(node_modules|dist|build|target|\.venv|venv|site-packages|vendor|\.git|cache|data\/engines|__pycache__)(\/|$)/;
const isNoise = (p: string) => NOISE.test(p);

/**
 * Curated paths are the workspace's own index: the root AGENTS.md, Documents/*.md, a project's
 * README/AGENTS, its docs/, a skill's SKILL.md. A hit there is worth more than the same words in
 * a vendored copy, which is what the 20-question eval showed (top-3 0.5 before this prior).
 */
const sizeOf = (abs: string) => { try { return fs.statSync(abs).size; } catch { return 0; } };

const CANON = [
  /^AGENTS\.md$/, /^SOUL\.md$/, /^Documents\/[^/]+\.md$/, /^Projects\/[^/]+\/(README|AGENTS)\.md$/,
  /^Projects\/[^/]+\/docs\/[^/]+\.md$/, /^Skills\/[^/]+\/SKILL\.md$/, /^Projects\/[^/]+\/[A-Z][A-Z0-9_-]+\.md$/,
];
const canonWeight = (p: string) => (CANON.some((r) => r.test(p)) ? 1.35 : 1);

export function dataSearch(cfg: DataConfig, botId: string, a: { query: string; k?: number; sources?: string[] }) {
  const q = String(a.query ?? '').trim();
  if (!q) throw new DataError('Give a query');
  const k = Math.max(1, Math.min(25, Math.floor(Number(a.k) || 8)));
  const toks = queryTokens(q);
  if (!toks.length) throw new DataError('The query has no searchable words');
  const want = new Set((a.sources?.length ? a.sources : ['catalog', 'paths', 'library']).map((s) => String(s).toLowerCase()));
  const t0 = Date.now();
  const db = openCatalog(cfg);
  const lists: Ranked[][] = [];
  let catalogAge: number | null = null;
  const workspace = cfg.roots.workspace ?? '/home/workspace';
  if (db) {
    try {
      catalogAge = Math.round((Date.now() - fs.statSync(cfg.catalog).mtimeMs) / 1000);
      if (want.has('catalog')) lists.push(catalogDocs(db, toks, k, workspace));
      if (want.has('paths')) lists.push(catalogPaths(db, toks, k, workspace));
    } catch { /* catalog mid-rebuild: fall back to the Library */ }
  }
  if (want.has('library')) lists.push(libraryHits(cfg, botId, toks, k));
  const merged = rrf(lists, k * 3)
    .map((m) => ({ ...m, score: m.score * canonWeight(m.r.uri.replace(/^fs:\/\/[a-z0-9_-]+\//i, '')) }))
    .sort((x, y) => y.score - x.score);
  const kept: typeof merged = [];
  const seen = new Set<string>();
  const perDir = new Map<string, number>();
  const dirOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));
  const take = (m: (typeof merged)[number], cap: number) => {
    if (kept.length >= k) return;
    if (kept.some((x) => nearDup(x.r.uri, m.r.uri))) return;
    if (isSecretPath(m.r.uri)) return;
    const sig = `${path.basename(m.r.uri)}:${sizeOf(m.r.abs)}`;
    if (seen.has(sig)) return;
    const d = dirOf(m.r.uri);
    if ((perDir.get(d) ?? 0) >= cap) return;
    seen.add(sig);
    perDir.set(d, (perDir.get(d) ?? 0) + 1);
    kept.push(m);
  };
  // Two passes: at most 2 hits per directory first, so one blog folder cannot fill the list,
  // then fill any remaining slots without the cap.
  for (const m of merged) take(m, 2);
  for (const m of merged) take(m, Infinity);  const catalogMtime = db && cached ? cached.mtime : 0;
  const results = kept.map((m) => {
    let mtime: string | null = null; let bytes: number | null = null; let stale = 0; let missing = false;
    try {
      const st = fs.statSync(m.r.abs);
      mtime = iso(st.mtimeMs); bytes = st.size;
      if (m.r.engine !== 'library' && st.mtimeMs > catalogMtime) stale = Math.round((st.mtimeMs - catalogMtime) / 1000);
    } catch { missing = true; }
    const snippet = (m.r.snippet ?? '').replace(/\s+/g, ' ').slice(0, 300);
    const hay = `${m.r.uri} ${snippet}`.toLowerCase();
    return {
      uri: m.r.uri, source: 'fs', title: m.r.title ?? path.basename(m.r.uri), score: Number(m.score.toFixed(5)),
      engines: [...m.engines], snippet, bytes, mtime,
      coverage: Number((toks.filter((t) => hay.includes(t)).length / toks.length).toFixed(2)),
      stale_seconds: stale, ...(missing ? { missing: true } : {}),
    };
  });
  // RRF score is not a confidence signal: on the 20-question eval the answerable and unanswerable halves
  // overlap (0.019-0.039 vs 0.016-0.032). Term coverage is: an unanswerable question misses its own words.
  const bestCoverage = results.reduce((m, r) => Math.max(m, r.coverage), 0);
  const confidence = bestCoverage >= 0.75 ? 'strong' : bestCoverage >= 0.5 ? 'weak' : 'none';
  return {
    query: q, tokens: toks, took_ms: Date.now() - t0, catalog_age_seconds: catalogAge, confidence,
    ...(confidence === 'none' ? { hint: 'Nothing here contains most of your terms. Say you do not know rather than guessing from a weak hit.' } : {}),
    ...(db ? {} : { warning: `Catalog ${cfg.catalog} is missing; only the Library was searched.` }),
    ...(catalogAge !== null && catalogAge > 36 * 3600
      ? { warning: `Catalog is ${Math.round(catalogAge / 3600)} h old (nightly rebuild is data-catalog-nightly); files newer than that are ranked from paths only.` }
      : {}),
    note: 'Ranked by RRF over the workspace catalog, file paths and your Library. data_read the uri to quote it. stale_seconds > 0 means the file changed after the catalog was built.',
    results,
  };
}

/** Open the catalog and touch its FTS pages so the first bot query does not pay the cold read (~6 s on 9p). */
export function warmCatalog(cfg: DataConfig) {
  try { dataSearch(cfg, '__warmup__', { query: 'readme project decision', k: 3, sources: ['catalog', 'paths'] }); } catch { /* catalog missing */ }
}
