import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { sha256 } from './lib/ids.js';
import { SHARED, bankById, forgetDocument, retain, type Bank } from './memory-banks.js';
import { entityFacts, listBanks, memoryGraph } from './memory-graph.js';
import { ENTITY_TYPES, UNTYPED, entityTyper, initOntology, ontologyNote, relationOf, replaceNoteTypes, replaceTypes, typeOf, type EntityType } from './ontology.js';

/**
 * Bot memory and an Obsidian vault, both ways (OBSIDIAN_VAULT, off when unset):
 *
 *   <vault>/workspace/            people write here; bots learn it
 *     Shared/…                    → the `shared` bank (every bot in General)
 *     Workspaces/<workspace name>/… → that workspace's bank (matched by name, not id)
 *     Teams/<team name>/…         → that team's bank
 *     Bots/<bot name>/…           → that bot's own bank
 *   <vault>/Memory/               Bot HQ writes here; never read back
 *     Ontology.md
 *     Shared/, Workspaces/<workspace name>/, Teams/<team name>/, Bots/<bot name>/
 *                                 each: 00 <name>.md + <type plural>/<entity>.md
 *
 * In: each changed note is saved to its bank as one document (its path's hash is the document id,
 * so an edit replaces the old version and a deleted note is forgotten). Its `type:` and link fields
 * (see ontology.ts) become entity hints and plain statements.
 *
 * Out: each bank's entity graph becomes one note per entity, filed by type, with its facts and
 * links to the entities it comes up with, so Obsidian's graph view shows what the bots know.
 * Generated notes carry `generated: bot-hq`; only those are ever overwritten or removed. The folder
 * is named `Memory` because the zo-vaults indexer already skips folders of that name.
 *
 * The vault belongs to one workspace (OBSIDIAN_WORKSPACE: an account id or email; by default the
 * only account that has bots). Only that account's bots, teams, workspaces and `shared` are synced, and only
 * that account (or its workspace members) can see the sync or start it.
 */

export const vaultPath = () => (process.env.OBSIDIAN_VAULT ?? '').trim() || null;
const MAX_NOTE = 256 * 1024;
const MAX_NOTES = 4000;
/** The longest note text sent to Hindsight as one document. */
const MAX_NOTE_TEXT = 60_000;
const LAYER_DIRS = { everyone: 'Shared', team: 'Teams', me: 'Bots' } as const;

export class ObsidianError extends Error {}

/** The account the vault belongs to, or why there is none. */
export function vaultOwner(): { id: string } | { error: string } {
  const want = (process.env.OBSIDIAN_WORKSPACE ?? '').trim();
  if (want) {
    const u = db.prepare('SELECT id FROM users WHERE id=? OR lower(email)=lower(?)').get(want, want) as { id: string } | undefined;
    return u ? { id: u.id } : { error: `OBSIDIAN_WORKSPACE names no account (${want}).` };
  }
  const owners = db.prepare("SELECT DISTINCT user_id FROM bots WHERE COALESCE(hidden,0)=0").all() as { user_id: string }[];
  if (owners.length === 1) return { id: owners[0].user_id };
  return { error: owners.length ? 'More than one account has bots: set OBSIDIAN_WORKSPACE to the account the vault belongs to.' : 'No account has bots yet.' };
}

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

/** The vault folder (`Workspaces/<name>`) holding this account's notes for a workspace of that name, if there is one. */
export function workspaceFolder(userId: string, name: string): string | null {
  const vault = vaultPath();
  const owner = vaultOwner();
  if (!vault || !('id' in owner) || owner.id !== userId) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(vault, 'workspace', 'Workspaces'), { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.isDirectory() && e.name.trim().toLowerCase() === name.toLowerCase());
  return hit ? `workspace/Workspaces/${hit.name}` : null;
}

function bankByName(userId: string, kind: 'team' | 'agent', name: string): Bank | null | 'ambiguous' {
  const rows = db.prepare("SELECT id FROM bots WHERE user_id=? AND lower(name)=lower(?) AND COALESCE(kind,'agent')=? AND COALESCE(hidden,0)=0").all(userId, name.trim(), kind) as any[];
  if (rows.length > 1) return 'ambiguous';
  return rows.length ? bankById(userId, rows[0].id) : null;
}

/** `Shared/…` → shared, `Teams/<name>/…` → that team, `Bots/<name>/…` → that bot, all in the vault's account. Anything else is not synced. */
export function routeNote(userId: string, rel: string): Bank | { skip: string } {
  const parts = rel.split('/');
  if (parts[0] === 'Shared' && parts.length > 1) return bankById(userId, SHARED)!;
  if (parts[0] === 'Workspaces' && parts.length > 2) {
    const s = db.prepare('SELECT id FROM spaces WHERE user_id=? AND lower(name)=lower(?)').get(userId, parts[1].trim()) as { id: string } | undefined;
    return (s && bankById(userId, s.id)) || { skip: `no workspace named "${parts[1]}"` };
  }
  if ((parts[0] === 'Teams' || parts[0] === 'Bots') && parts.length > 2) {
    const b = bankByName(userId, parts[0] === 'Teams' ? 'team' : 'agent', parts[1]);
    if (b === 'ambiguous') return { skip: `more than one ${parts[0] === 'Teams' ? 'team' : 'bot'} is named "${parts[1]}"` };
    return b ?? { skip: `no ${parts[0] === 'Teams' ? 'team' : 'bot'} named "${parts[1]}"` };
  }
  return { skip: 'not under Shared/, Workspaces/<workspace>/, Teams/<team>/ or Bots/<bot>/' };
}

/**
 * Every note under `root`, in sorted path order. A folder that cannot be read stops the sync (it
 * must not look like its notes were deleted). Hitting MAX_NOTES sets `truncated`, telling the
 * caller the list is incomplete, so nothing missing from it may be forgotten.
 */
function walk(root: string, dir = '', acc = { files: [] as string[], truncated: false }): { files: string[]; truncated: boolean } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch (e) {
    throw new ObsidianError(`Could not read the vault folder workspace/${dir}: ${e instanceof Error ? e.message : e}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (acc.files.length >= MAX_NOTES) { acc.truncated = true; break; }
    if (e.name.startsWith('.') || /secret/i.test(e.name)) continue; // the zo-vaults rules: no hidden entries, nothing named "secret"
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, acc);
    else if (e.isFile() && e.name.endsWith('.md')) acc.files.push(rel);
  }
  return acc;
}

// ---------- in: notes → banks ----------

export interface IngestResult {
  saved: string[];
  unchanged: number;
  forgotten: string[];
  skipped: { path: string; why: string }[];
  /** Names two notes typed differently: the first by path wins. */
  typeConflicts: { name: string; path: string; type: string; kept: string; keptFrom: string }[];
  /** The vault has more than MAX_NOTES notes: the rest were not read, and nothing was forgotten. */
  truncated: boolean;
}

export async function ingestVault(vault: string, userId: string, fetchFn?: Parameters<typeof retain>[3]): Promise<IngestResult> {
  initObsidian();
  const root = path.join(vault, 'workspace');
  const res: IngestResult = { saved: [], unchanged: 0, forgotten: [], skipped: [], typeConflicts: [], truncated: false };
  const rows = new Map((db.prepare('SELECT * FROM obsidian_notes').all() as any[]).map((r) => [r.path, r]));
  if (!fs.existsSync(root)) {
    if (rows.size) throw new ObsidianError('The vault has no workspace/ folder, but notes were synced from it before. Not forgetting them; check the vault path.');
    return res;
  }
  const scan = walk(root);
  res.truncated = scan.truncated;

  /** Drops what an earlier version of a note left in memory, when the note can no longer be synced. */
  const forget = async (rel: string, why: string) => {
    res.skipped.push({ path: rel, why });
    const prev = rows.get(rel);
    if (!prev) return;
    await forgetDocument(prev.bank, prev.document_id, fetchFn as any);
    db.prepare('DELETE FROM obsidian_notes WHERE path=?').run(rel);
    res.forgotten.push(rel);
  };

  // Read every note first, so types come from all of them (changed or not) before anything is sent.
  const notes: { rel: string; route: Bank; src: string; note: Note }[] = [];
  const seen = new Set<string>();
  for (const rel of scan.files) {
    seen.add(rel);
    const file = path.join(root, rel);
    if (fs.statSync(file).size > MAX_NOTE) { await forget(rel, 'larger than 256 KB'); continue; }
    const route = routeNote(userId, rel);
    if ('skip' in route) { res.skipped.push({ path: rel, why: route.skip }); continue; }
    const src = fs.readFileSync(file, 'utf8');
    notes.push({ rel, route, src, note: readNote(rel, src) });
  }
  res.typeConflicts = replaceNoteTypes(userId, notes.filter((n) => n.note.type).map((n) => ({ name: n.note.title, type: n.note.type!.id, path: n.rel })), { complete: !scan.truncated });

  const typer = entityTyper(userId);
  const hint = (name: string) => { const t = typer(name); return t === UNTYPED ? undefined : t.hindsight; };
  for (const { rel, route, src, note } of notes) {
    const hash = sha256(`${route.id}\n${src}`);
    const prev = rows.get(rel);
    if (prev?.hash === hash) { res.unchanged++; continue; }
    const text = noteText(note);
    if (text.length > MAX_NOTE_TEXT) { await forget(rel, `longer than ${MAX_NOTE_TEXT.toLocaleString('en-US')} characters`); continue; }

    const documentId = `obsidian-${sha256(rel).slice(0, 24)}`;
    if (prev && prev.bank !== route.id) await forgetDocument(prev.bank, prev.document_id, fetchFn as any); // the note moved to another bank
    const entities = [{ text: note.title, type: note.type?.hindsight ?? hint(note.title) }, ...note.links.map((l) => ({ text: l.target, type: hint(l.target) }))];
    await retain(route, text, {
      by: 'Obsidian', context: `Obsidian note workspace/${rel}`, documentId, entities, maxChars: MAX_NOTE_TEXT,
      tags: ['obsidian', ...(note.type ? [`type:${note.type.id}`] : []), ...note.tags].slice(0, 12),
    }, fetchFn);
    db.prepare(`INSERT INTO obsidian_notes(path,hash,bank,document_id,title,synced_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, bank=excluded.bank, document_id=excluded.document_id, title=excluded.title, synced_at=excluded.synced_at`)
      .run(rel, hash, route.id, documentId, note.title, now());
    res.saved.push(rel);
  }

  // A note that was deleted is forgotten, so bots stop recalling it. Not when the scan was cut short:
  // a note it never reached is not a deleted note. A note moved into a folder that is not synced
  // keeps its memory until it is deleted.
  if (!res.truncated) {
    for (const [rel, r] of rows) {
      if (seen.has(rel)) continue;
      await forgetDocument(r.bank, r.document_id, fetchFn as any);
      db.prepare('DELETE FROM obsidian_notes WHERE path=?').run(rel);
      res.forgotten.push(rel);
    }
  }
  return res;
}

// ---------- out: banks → notes ----------

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 120) || 'untitled';
const yamlStr = (s: string) => JSON.stringify(s);

const GENERATED = /^---[\s\S]*?\ngenerated: bot-hq\n[\s\S]*?---/;
const isGenerated = (text: string) => GENERATED.test(text.slice(0, 2000));

/**
 * Writes a generated file, only when its text changed (keeps the vault's git history quiet). A file
 * already there without the `generated: bot-hq` marker is somebody's own: it is left alone and
 * 'kept' is returned.
 */
function put(file: string, text: string, written: Set<string>): 'changed' | 'same' | 'kept' {
  let old: string | null = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  if (old !== null && !isGenerated(old)) return 'kept';
  written.add(path.resolve(file));
  if (old === text) return 'same';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return 'changed';
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
    } else if (e.name.endsWith('.md') && !written.has(path.resolve(p)) && isGenerated(fs.readFileSync(p, 'utf8'))) {
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

// ---------- Types.md: the person's own typing, edited in Obsidian ----------

/**
 * `<vault>/Types.md` (outside workspace/, so it is never sent into memory): one `## <type>` heading
 * per ontology type with `- name` lines under it, and `## ignore` for names to leave out of the
 * graph (Hindsight's "user", "assistant"). It is the whole of the person's typing: on every sync
 * its entries replace the previous ones, so taking a name out of the note untypes it again.
 */
export function readTypesNote(vault: string): { types: Map<string, string>; ignore: Set<string> } {
  const types = new Map<string, string>();
  const ignore = new Set<string>();
  let src = '';
  try { src = fs.readFileSync(path.join(vault, 'Types.md'), 'utf8'); } catch { return { types, ignore }; }
  const label = new Map(ENTITY_TYPES.flatMap((t) => [[t.plural.toLowerCase(), t.id], [t.label.toLowerCase(), t.id]] as [string, string][]));
  let current: string | null = null;
  for (const line of parseFrontmatter(src).body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const k = h[1].toLowerCase();
      current = k === 'ignore' ? 'ignore' : typeOf(k)?.id ?? label.get(k) ?? null;
      continue;
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!item || !current) continue;
    const name = item[1].replace(WIKI, (_m, t, a) => (a ?? t)).replace(/\s+#.*$/, '').trim(); // "- Gus  # the person" keeps a comment
    if (!name) continue;
    if (current === 'ignore') ignore.add(name.toLowerCase());
    else types.set(name, current);
  }
  return { types, ignore };
}

function applyTypesNote(vault: string, owner: string) {
  const { types, ignore } = readTypesNote(vault);
  replaceTypes(owner, 'user', [...types].map(([name, type]) => ({ name, type })));
  return ignore;
}

/** Facts that look like a key, token, password URL or private key are not written to the vault. */
const SECRET_RES = [
  /\b(sk|ak|pk|rk|zo_sk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|AKIA)[-_][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A long run of letters and digits with no slash or space: an API key, a hash, a base64 blob (paths have slashes).
  /(?<![\w/+-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/])/,
];
export const looksSecret = (s: string) => SECRET_RES.some((re) => re.test(s));

/** Colours Obsidian's graph by ontology type. Only when the vault has no graph settings yet: never overwrites the person's own. */
export function ensureGraphConfig(vault: string): boolean {
  const file = path.join(vault, '.obsidian', 'graph.json');
  if (fs.existsSync(file)) return false;
  const colorGroups = ENTITY_TYPES.map((t) => ({ query: `[type:${t.id}]`, color: { a: 1, rgb: parseInt(t.color.slice(1), 16) } }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ search: 'path:Memory', showTags: false, showAttachments: false, hideUnresolved: true, showOrphans: true, colorGroups, showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1.2, lineSizeMultiplier: 1, linkDistance: 160, repelStrength: 12 }, null, 2));
  return true;
}

export interface ExportResult {
  banks: { bank: string; label: string; entities: number; changed: number; withheld: number; unreadable: number }[];
  removed: number;
  /** Files at a generated path that are somebody's own (no `generated: bot-hq`): left as they were. */
  kept: string[];
}

/**
 * One file name per entity within its type folder. Labels that clean up to the same name (or differ
 * only in case, which some file systems treat as one) get a short piece of the entity id, the most
 * mentioned keeping the plain name, so no entity's note overwrites another's.
 */
function fileNames<T extends { id: string; label: string; mentions: number; type: EntityType }>(nodes: T[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const n of [...nodes].sort((a, b) => b.mentions - a.mentions || (a.id < b.id ? -1 : 1))) {
    const plain = safeName(n.label);
    let name = plain;
    if (used.has(`${n.type.plural}/${name}`.toLowerCase())) name = `${plain.slice(0, 108)} (${n.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)})`;
    used.add(`${n.type.plural}/${name}`.toLowerCase());
    out.set(n.id, name);
  }
  return out;
}

export async function exportBanks(vault: string, userId: string, banks: Bank[], opts: { limit?: number; fetchFn?: any } = {}): Promise<ExportResult> {
  initObsidian();
  const root = path.join(vault, 'Memory');
  const written = new Set<string>();
  const ignore = applyTypesNote(vault, userId);
  ensureGraphConfig(vault);
  const typer = entityTyper(userId);
  const sources = new Map((db.prepare('SELECT path, title FROM obsidian_notes').all() as any[]).map((r) => [r.title.toLowerCase(), r.path as string]));
  const res: ExportResult = { banks: [], removed: 0, kept: [] };
  const write = (file: string, text: string) => {
    const r = put(file, text, written);
    if (r === 'kept') res.kept.push(path.relative(vault, file).split(path.sep).join('/'));
    return r === 'changed';
  };
  write(path.join(root, 'Ontology.md'), ontologyNote());

  for (const bank of banks) {
    // Same names as the workspace folders: Memory/Shared, Memory/Teams/<team>, Memory/Bots/<bot>.
    const ofSpace = bank.layer === 'everyone' && bank.id !== SHARED;
    const label = ofSpace ? bank.label.replace(/^Everyone at /, '') : bank.layer === 'everyone' ? 'Shared' : bank.label.replace(/ \(own\)$/, '').replace(/^Team /, '');
    const folder = ofSpace ? `Memory/Workspaces/${safeName(label)}` : bank.layer === 'everyone' ? 'Memory/Shared' : `Memory/${LAYER_DIRS[bank.layer]}/${safeName(label)}`;
    const raw = await memoryGraph(bank.id, opts.limit ?? 250, opts.fetchFn);
    const kept = raw.nodes.filter((n) => !ignore.has(n.label.toLowerCase()));
    const keep = new Set(kept.map((n) => n.id));
    const g = { ...raw, nodes: kept, edges: raw.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
    let withheld = 0;
    let unreadable = 0;
    // A lookup that fails is null, not "no facts": the entity's existing note is then left as it was.
    const facts = await inPool(g.nodes, 6, (n) => entityFacts(bank.id, n.id, opts.fetchFn).catch(() => null));
    const typed = g.nodes.map((n, i) => {
      const f = facts[i];
      const all = (f?.facts ?? []) as { text: string; date: string | null }[];
      const safe = all.filter((x) => !looksSecret(x.text));
      withheld += all.length - safe.length;
      return { ...n, type: typer(n.label), facts: safe, hidden: all.length - safe.length, entity: (f?.entity ?? null) as any, failed: !f };
    });
    const names = fileNames(typed);
    const fileOf = (n: (typeof typed)[number]) => `${folder}/${n.type.plural}/${names.get(n.id)}`;
    const link = new Map(typed.map((n) => [n.id, `[[${fileOf(n)}|${n.label}]]`]));
    let changed = 0;
    for (const n of typed) {
      const file = path.join(vault, `${fileOf(n)}.md`);
      if (n.failed) {
        unreadable++;
        if (fs.existsSync(file)) { written.add(path.resolve(file)); continue; } // keep what it said last time
      }
      const near = g.edges.filter((e) => e.source === n.id || e.target === n.id).sort((a, b) => b.weight - a.weight).slice(0, 25);
      const src = sources.get(n.label.toLowerCase());
      const factLines = n.failed
        ? ['- (the facts could not be read this sync; they will be filled in on the next one)']
        : [
          ...(n.facts.length ? n.facts.map((f) => `- ${f.text.replace(/\n+/g, ' ')}${f.date ? ` (${String(f.date).slice(0, 10)})` : ''}`) : ['- (none listed yet)']),
          ...(n.hidden ? [`- (${n.hidden} fact${n.hidden === 1 ? '' : 's'} withheld: looked like a key or token; see it in the Memory graph)`] : []),
        ];
      const text = [
        '---', `type: ${n.type.id}`, `bank: ${yamlStr(bank.label)}`, `mentions: ${n.mentions}`,
        ...(n.entity?.firstSeen ? [`first_seen: ${n.entity.firstSeen.slice(0, 10)}`] : []),
        ...(n.entity?.lastSeen ? [`last_seen: ${n.entity.lastSeen.slice(0, 10)}`] : []),
        'generated: bot-hq', '---', '',
        `# ${n.label}`, '',
        `${n.type === UNTYPED ? 'Untyped entity' : n.type.label} in ${bank.label}'s memory, mentioned ${n.mentions} time${n.mentions === 1 ? '' : 's'}.${src ? ` Source note: [[workspace/${src.replace(/\.md$/, '')}|${n.label}]].` : ''}`, '',
        '## Facts', '', ...factLines, '',
        ...(near.length ? ['## Comes up with', '', ...near.map((e) => `- ${link.get(e.source === n.id ? e.target : e.source)} · ${e.weight}×`), ''] : []),
      ].join('\n');
      if (write(file, text)) changed++;
    }
    const byType = [...ENTITY_TYPES, UNTYPED].map((t) => ({ t, list: typed.filter((n) => n.type.id === t.id).sort((a, b) => b.mentions - a.mentions) })).filter((x) => x.list.length);
    const index = [
      '---', 'type: memory-bank', `bank: ${yamlStr(bank.label)}`, `bank_id: ${bank.id}`, `layer: ${bank.layer}`, `entities: ${typed.length}`, `total_entities: ${g.totalEntities}`, 'generated: bot-hq', '---', '',
      `# ${bank.label}`, '',
      `What the bots remember in this bank: the ${typed.length} most-mentioned of ${g.totalEntities} entities${g.stats ? `, drawn from ${g.stats.facts} facts` : ''}. Generated by Bot HQ; edits here are overwritten. To teach the bots, write a note under \`workspace/\`. Vocabulary: [[Memory/Ontology|Ontology]].`, '',
      ...byType.flatMap(({ t, list }) => [`## ${t.plural} (${list.length})`, '', ...list.slice(0, 40).map((n) => `- ${link.get(n.id)} · ${n.mentions}`), '']),
    ].join('\n');
    if (write(path.join(vault, folder, `00 ${safeName(label)}.md`), index)) changed++;
    res.banks.push({ bank: bank.id, label: bank.label, entities: typed.length, changed, withheld, unreadable });
  }
  res.removed = prune(root, written);
  return res;
}

// ---------- the sync ----------

export interface SyncStatus {
  enabled: boolean;
  /** Whether the asking account is the one the vault belongs to. Others see no details. */
  mine: boolean;
  vault: string | null;
  everyMinutes: number;
  running: boolean;
  /** Why the sync cannot run (no owner account, missing folder), when it cannot. */
  problem: string | null;
  last: null | { at: number; ms: number; ingest?: IngestResult; export?: ExportResult; error?: string };
}

let running = false;
let last: SyncStatus['last'] = null;
const every = () => Math.max(0, Number(process.env.OBSIDIAN_SYNC_MINUTES) || 0);

/** What is wrong before a sync could even start, or null when it can. */
export function syncProblem(): string | null {
  const vault = vaultPath();
  if (!vault) return 'Obsidian sync is off: set OBSIDIAN_VAULT on the server to the vault folder.';
  if (!fs.existsSync(vault)) return `The vault folder ${vault} does not exist on the server.`;
  const owner = vaultOwner();
  return 'error' in owner ? owner.error : null;
}

/** The sync's state as one account may see it: full for the vault's own account, bare for anyone else. */
export function syncStatus(userId: string): SyncStatus {
  const owner = vaultOwner();
  const mine = 'id' in owner && owner.id === userId;
  const enabled = !!vaultPath();
  if (!mine) return { enabled, mine: false, vault: null, everyMinutes: 0, running: false, problem: enabled ? 'The Obsidian vault belongs to another workspace.' : syncProblem(), last: null };
  return { enabled, mine, vault: vaultPath(), everyMinutes: every(), running, problem: syncProblem(), last };
}

/** Shared plus each of the account's bots and teams whose bank has facts. */
async function exportable(userId: string): Promise<Bank[]> {
  const live = new Map((await listBanks()).map((b) => [b.id, b.facts]));
  const spaces = (db.prepare('SELECT id FROM spaces WHERE user_id=? ORDER BY created_at').all(userId) as any[]).map((r) => r.id as string);
  const ids = [SHARED, ...spaces, ...(db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 ORDER BY created_at").all(userId) as any[]).map((r) => r.id as string)];
  return ids.filter((id) => (live.get(id) ?? 0) > 0).map((id) => bankById(userId, id)).filter((b): b is Bank => !!b);
}

export async function syncVault(): Promise<SyncStatus['last']> {
  if (running) throw new ObsidianError('A sync is already running.');
  running = true;
  const t0 = Date.now();
  try {
    const problem = syncProblem();
    if (problem) throw new ObsidianError(problem);
    const vault = vaultPath()!;
    const owner = (vaultOwner() as { id: string }).id;
    fs.mkdirSync(path.join(vault, 'workspace', 'Shared'), { recursive: true });
    const ingest = await ingestVault(vault, owner);
    const exp = await exportBanks(vault, owner, await exportable(owner));
    last = { at: now(), ms: Date.now() - t0, ingest, export: exp };
  } catch (e) {
    last = { at: now(), ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
    throw e;
  } finally {
    running = false;
  }
  return last;
}

/**
 * The background sync, only when OBSIDIAN_SYNC_MINUTES is set. The server starts it with the other
 * schedulers, so GROKBOT_NO_SCHEDULER=1 (a second server on a copy of the database) leaves it off.
 */
export function startObsidianSync() {
  initObsidian();
  const m = every();
  if (!vaultPath() || !m) return;
  const t = setInterval(() => { if (!running) syncVault().catch((e) => console.warn(`[obsidian] sync failed: ${e instanceof Error ? e.message : e}`)); }, m * 60_000);
  t.unref();
}
