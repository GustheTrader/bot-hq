import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { sha256 } from './lib/ids.js';
import { SHARED, bankById, forgetDocument, retain, type Bank } from './memory-banks.js';
import { entityFacts, listBanks, memoryGraph } from './memory-graph.js';
import { ENTITY_TYPES, UNTYPED, entityTyper, initOntology, ontologyNote, relationOf, setEntityType, typeOf, type EntityType } from './ontology.js';

/**
 * Bot memory and an Obsidian vault, both ways (OBSIDIAN_VAULT, off when unset):
 *
 *   <vault>/workspace/            people write here; bots learn it
 *     Shared/…                    → the `shared` bank (every bot)
 *     Teams/<team name>/…         → that team's bank
 *     Bots/<bot name>/…           → that bot's own bank
 *   <vault>/Memory/               Bot HQ writes here; never read back
 *     Ontology.md
 *     Shared/, Teams/<team name>/, Bots/<bot name>/   each: 00 <name>.md + <type plural>/<entity>.md
 *
 * In: each changed note is saved to its bank as one document (its path's hash is the document id,
 * so an edit replaces the old version and a deleted note is forgotten). Its `type:` and link fields
 * (see ontology.ts) become entity hints and plain statements.
 *
 * Out: each bank's entity graph becomes one note per entity, filed by type, with its facts and
 * links to the entities it comes up with, so Obsidian's graph view shows what the bots know.
 * Generated notes carry `generated: bot-hq`; only those are ever overwritten or removed. The folder
 * is named `Memory` because the zo-vaults indexer already skips folders of that name.
 */

export const vaultPath = () => (process.env.OBSIDIAN_VAULT ?? '').trim() || null;
const MAX_NOTE = 256 * 1024;
const MAX_NOTES = 4000;
const LAYER_DIRS = { everyone: 'Shared', team: 'Teams', me: 'Bots' } as const;

export class ObsidianError extends Error {}

let ready = false;
export function initObsidian() {
  if (ready) return;
  ready = true;
  initOntology();
  db.exec(`CREATE TABLE IF NOT EXISTS obsidian_notes (
    path TEXT PRIMARY KEY, hash TEXT NOT NULL, bank TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL, synced_at INTEGER NOT NULL
  )`);
}

// ---------- reading notes ----------

export interface Note { title: string; type: EntityType | null; rawType: string | null; links: { rel: string; target: string }[]; body: string; tags: string[] }

const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** Just the YAML a note's frontmatter needs: `key: value`, `key: [a, b]`, and `- item` lists. */
export function parseFrontmatter(src: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string | string[]> = {};
  let last: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && last) {
      const cur = data[last];
      data[last] = [...(Array.isArray(cur) ? cur : cur ? [cur] : []), unquote(item[1])];
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    last = kv[1].toLowerCase();
    const v = kv[2].trim();
    data[last] = /^\[.*\]$/.test(v) && !/^\[\[/.test(v) ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : unquote(v);
  }
  return { data, body: src.slice(m[0].length) };
}

export function readNote(file: string, src: string): Note {
  const { data, body } = parseFrontmatter(src);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = (typeof data.title === 'string' && data.title) || heading || path.basename(file, '.md');
  const rawType = typeof data.type === 'string' ? data.type : null;
  const links: Note['links'] = [];
  for (const [k, v] of Object.entries(data)) {
    const rel = relationOf(k);
    if (!rel) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      const targets = [...String(one).matchAll(WIKI)].map((x) => x[1].trim());
      for (const t of targets.length ? targets : [String(one).trim()]) if (t) links.push({ rel: rel.id, target: t });
    }
  }
  const tags = (Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' ? [data.tags] : []).map((t) => t.replace(/^#/, '')).filter(Boolean);
  return { title, type: typeOf(rawType), rawType, links, body, tags };
}

/** A note as the text Hindsight reads: title, what it is, how it relates, then the body with links as plain names. */
export function noteText(n: Note): string {
  const rel = (id: string) => relationOf(id)?.label ?? id;
  const head = [
    `# ${n.title}`,
    n.type ? `${n.title} is a ${n.type.label.toLowerCase()}.` : n.rawType ? `Note type: ${n.rawType}.` : '',
    ...n.links.map((l) => `${n.title} ${rel(l.rel)} ${l.target}.`),
  ].filter(Boolean);
  // The body usually repeats the title as its first heading; drop that so it is not said twice.
  const body = n.body.replace(WIKI, (_m, target, alias) => (alias ?? target).trim()).trim().replace(new RegExp(`^#\\s+${n.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`), '');
  return [...head, '', body.trim()].join('\n').trim();
}

// ---------- which bank a note goes to ----------

function bankByName(kind: 'team' | 'agent', name: string): Bank | null | 'ambiguous' {
  const rows = db.prepare("SELECT id FROM bots WHERE lower(name)=lower(?) AND COALESCE(kind,'agent')=? AND COALESCE(hidden,0)=0").all(name.trim(), kind) as any[];
  if (rows.length > 1) return 'ambiguous';
  return rows.length ? bankById(rows[0].id) : null;
}

/** `Shared/…` → shared, `Teams/<name>/…` → that team, `Bots/<name>/…` → that bot. Anything else is not synced. */
export function routeNote(rel: string): Bank | { skip: string } {
  const parts = rel.split('/');
  if (parts[0] === 'Shared' && parts.length > 1) return bankById(SHARED)!;
  if ((parts[0] === 'Teams' || parts[0] === 'Bots') && parts.length > 2) {
    const b = bankByName(parts[0] === 'Teams' ? 'team' : 'agent', parts[1]);
    if (b === 'ambiguous') return { skip: `more than one ${parts[0] === 'Teams' ? 'team' : 'bot'} is named "${parts[1]}"` };
    return b ?? { skip: `no ${parts[0] === 'Teams' ? 'team' : 'bot'} named "${parts[1]}"` };
  }
  return { skip: 'not under Shared/, Teams/<team>/ or Bots/<bot>/' };
}

function walk(root: string, dir = '', out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_NOTES) break;
    if (e.name.startsWith('.') || /secret/i.test(e.name)) continue; // the zo-vaults rules: no hidden entries, nothing named "secret"
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

// ---------- in: notes → banks ----------

export interface IngestResult { saved: string[]; unchanged: number; forgotten: string[]; skipped: { path: string; why: string }[] }

export async function ingestVault(vault: string, fetchFn?: Parameters<typeof retain>[3]): Promise<IngestResult> {
  initObsidian();
  const root = path.join(vault, 'workspace');
  const res: IngestResult = { saved: [], unchanged: 0, forgotten: [], skipped: [] };
  const seen = new Set<string>();
  const rows = new Map((db.prepare('SELECT * FROM obsidian_notes').all() as any[]).map((r) => [r.path, r]));

  for (const rel of walk(root)) {
    const file = path.join(root, rel);
    const size = fs.statSync(file).size;
    if (size > MAX_NOTE) { res.skipped.push({ path: rel, why: 'larger than 256 KB' }); continue; }
    const route = routeNote(rel);
    if ('skip' in route) { res.skipped.push({ path: rel, why: route.skip }); continue; }
    seen.add(rel);
    const src = fs.readFileSync(file, 'utf8');
    const hash = sha256(`${route.id}\n${src}`);
    const prev = rows.get(rel);
    const note = readNote(rel, src);
    if (note.type) setEntityType(note.title, note.type.id, 'note');
    if (prev?.hash === hash) { res.unchanged++; continue; }

    const documentId = `obsidian-${sha256(rel).slice(0, 24)}`;
    if (prev && prev.bank !== route.id) await forgetDocument(prev.bank, prev.document_id, fetchFn as any); // the note moved to another bank
    const typer = entityTyper();
    const entities = [{ text: note.title, type: note.type?.hindsight }, ...note.links.map((l) => ({ text: l.target, type: typer(l.target) === UNTYPED ? undefined : typer(l.target).hindsight }))];
    await retain(route, noteText(note), {
      by: 'Obsidian', context: `Obsidian note workspace/${rel}`, documentId, entities, maxChars: 60_000,
      tags: ['obsidian', ...(note.type ? [`type:${note.type.id}`] : []), ...note.tags].slice(0, 12),
    }, fetchFn);
    db.prepare(`INSERT INTO obsidian_notes(path,hash,bank,document_id,title,synced_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, bank=excluded.bank, document_id=excluded.document_id, title=excluded.title, synced_at=excluded.synced_at`)
      .run(rel, hash, route.id, documentId, note.title, now());
    res.saved.push(rel);
  }

  // A note that was deleted (or moved out of a synced folder) is forgotten, so bots stop recalling it.
  for (const [rel, r] of rows) {
    if (seen.has(rel) || res.skipped.some((s) => s.path === rel)) continue;
    await forgetDocument(r.bank, r.document_id, fetchFn as any);
    db.prepare('DELETE FROM obsidian_notes WHERE path=?').run(rel);
    res.forgotten.push(rel);
  }
  return res;
}

// ---------- out: banks → notes ----------

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 120) || 'untitled';
const yamlStr = (s: string) => JSON.stringify(s);

/** Writes a file only when its text changed (keeps the vault's git history quiet). */
function put(file: string, text: string, written: Set<string>) {
  written.add(path.resolve(file));
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/** Removes generated notes this run did not write, and the folders that leaves empty. Hand-written files are never touched. */
function prune(dir: string, written: Set<string>): number {
  let n = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      n += prune(p, written);
      try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* not empty */ }
    } else if (e.name.endsWith('.md') && !written.has(path.resolve(p)) && /^---[\s\S]*?\ngenerated: bot-hq\n[\s\S]*?---/.test(fs.readFileSync(p, 'utf8').slice(0, 2000))) {
      fs.unlinkSync(p);
      n++;
    }
  }
  return n;
}

async function inPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export interface ExportResult { banks: { bank: string; label: string; entities: number; changed: number }[]; removed: number }

export async function exportBanks(vault: string, banks: Bank[], opts: { limit?: number; fetchFn?: any } = {}): Promise<ExportResult> {
  initObsidian();
  const root = path.join(vault, 'Memory');
  const written = new Set<string>();
  const typer = entityTyper();
  const sources = new Map((db.prepare('SELECT path, title FROM obsidian_notes').all() as any[]).map((r) => [r.title.toLowerCase(), r.path as string]));
  const res: ExportResult = { banks: [], removed: 0 };
  put(path.join(root, 'Ontology.md'), ontologyNote(), written);

  for (const bank of banks) {
    // Same names as the workspace folders: Memory/Shared, Memory/Teams/<team>, Memory/Bots/<bot>.
    const label = bank.layer === 'everyone' ? 'Shared' : bank.label.replace(/ \(own\)$/, '').replace(/^Team /, '');
    const folder = bank.layer === 'everyone' ? 'Memory/Shared' : `Memory/${LAYER_DIRS[bank.layer]}/${safeName(label)}`;
    const g = await memoryGraph(bank.id, opts.limit ?? 250, opts.fetchFn);
    const facts = await inPool(g.nodes, 6, (n) => entityFacts(bank.id, n.id, opts.fetchFn).catch(() => ({ entity: null, facts: [] as any[] })));
    const typed = g.nodes.map((n, i) => ({ ...n, type: typer(n.label), facts: facts[i].facts as { text: string; date: string | null }[], entity: facts[i].entity as any }));
    const link = new Map(typed.map((n) => [n.id, `[[${folder}/${n.type.plural}/${safeName(n.label)}|${n.label}]]`]));
    let changed = 0;
    for (const n of typed) {
      const near = g.edges.filter((e) => e.source === n.id || e.target === n.id).sort((a, b) => b.weight - a.weight).slice(0, 25);
      const src = sources.get(n.label.toLowerCase());
      const text = [
        '---', `type: ${n.type.id}`, `bank: ${yamlStr(bank.label)}`, `mentions: ${n.mentions}`,
        ...(n.entity?.firstSeen ? [`first_seen: ${n.entity.firstSeen.slice(0, 10)}`] : []),
        ...(n.entity?.lastSeen ? [`last_seen: ${n.entity.lastSeen.slice(0, 10)}`] : []),
        'generated: bot-hq', '---', '',
        `# ${n.label}`, '',
        `${n.type === UNTYPED ? 'Untyped entity' : n.type.label} in ${bank.label}'s memory, mentioned ${n.mentions} time${n.mentions === 1 ? '' : 's'}.${src ? ` Source note: [[workspace/${src.replace(/\.md$/, '')}|${n.label}]].` : ''}`, '',
        '## Facts', '',
        ...(n.facts.length ? n.facts.map((f) => `- ${f.text.replace(/\n+/g, ' ')}${f.date ? ` (${String(f.date).slice(0, 10)})` : ''}`) : ['- (none listed yet)']), '',
        ...(near.length ? ['## Comes up with', '', ...near.map((e) => `- ${link.get(e.source === n.id ? e.target : e.source)} · ${e.weight}×`), ''] : []),
      ].join('\n');
      if (put(path.join(vault, folder, n.type.plural, `${safeName(n.label)}.md`), text, written)) changed++;
    }
    const byType = [...ENTITY_TYPES, UNTYPED].map((t) => ({ t, list: typed.filter((n) => n.type.id === t.id).sort((a, b) => b.mentions - a.mentions) })).filter((x) => x.list.length);
    const index = [
      '---', 'type: memory-bank', `bank: ${yamlStr(bank.label)}`, `bank_id: ${bank.id}`, `layer: ${bank.layer}`, `entities: ${typed.length}`, `total_entities: ${g.totalEntities}`, 'generated: bot-hq', '---', '',
      `# ${bank.label}`, '',
      `What the bots remember in this bank: the ${typed.length} most-mentioned of ${g.totalEntities} entities${g.stats ? `, drawn from ${g.stats.facts} facts` : ''}. Generated by Bot HQ; edits here are overwritten. To teach the bots, write a note under \`workspace/\`. Vocabulary: [[Memory/Ontology|Ontology]].`, '',
      ...byType.flatMap(({ t, list }) => [`## ${t.plural} (${list.length})`, '', ...list.slice(0, 40).map((n) => `- ${link.get(n.id)} · ${n.mentions}`), '']),
    ].join('\n');
    if (put(path.join(vault, folder, `00 ${safeName(label)}.md`), index, written)) changed++;
    res.banks.push({ bank: bank.id, label: bank.label, entities: typed.length, changed });
  }
  res.removed = prune(root, written);
  return res;
}

// ---------- the sync ----------

export interface SyncStatus {
  enabled: boolean;
  vault: string | null;
  everyMinutes: number;
  running: boolean;
  last: null | { at: number; ms: number; ingest?: IngestResult; export?: ExportResult; error?: string };
}

let running = false;
let last: SyncStatus['last'] = null;
const every = () => Math.max(0, Number(process.env.OBSIDIAN_SYNC_MINUTES) || 0);

export function syncStatus(): SyncStatus {
  return { enabled: !!vaultPath(), vault: vaultPath(), everyMinutes: every(), running, last };
}

/** Every bank worth exporting: shared plus each bot's and team's that has facts. */
async function exportable(): Promise<Bank[]> {
  const live = new Map((await listBanks()).map((b) => [b.id, b.facts]));
  const ids = [SHARED, ...(db.prepare("SELECT id FROM bots WHERE COALESCE(hidden,0)=0 ORDER BY created_at").all() as any[]).map((r) => r.id as string)];
  return ids.filter((id) => (live.get(id) ?? 0) > 0).map((id) => bankById(id)).filter((b): b is Bank => !!b);
}

export async function syncVault(): Promise<SyncStatus['last']> {
  const vault = vaultPath();
  if (!vault) throw new ObsidianError('Obsidian sync is off: set OBSIDIAN_VAULT to the vault folder.');
  if (!fs.existsSync(vault)) throw new ObsidianError(`The vault folder ${vault} does not exist.`);
  if (running) throw new ObsidianError('A sync is already running.');
  running = true;
  const t0 = Date.now();
  try {
    fs.mkdirSync(path.join(vault, 'workspace', 'Shared'), { recursive: true });
    const ingest = await ingestVault(vault);
    const exp = await exportBanks(vault, await exportable());
    last = { at: now(), ms: Date.now() - t0, ingest, export: exp };
  } catch (e) {
    last = { at: now(), ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
    throw e;
  } finally {
    running = false;
  }
  return last;
}

/** The background sync, only when OBSIDIAN_SYNC_MINUTES is set. */
export function startObsidianSync() {
  initObsidian();
  const m = every();
  if (!vaultPath() || !m) return;
  const t = setInterval(() => { if (!running) syncVault().catch((e) => console.warn(`[obsidian] sync failed: ${e instanceof Error ? e.message : e}`)); }, m * 60_000);
  t.unref();
}
