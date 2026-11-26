import { db, now } from './db.js';
import { looksLikeJobNumber } from './buildflow.js';

/**
 * The ontology for bot memory: what kinds of things the bots remember and how they relate. It is
 * the same vocabulary in three places:
 *
 * - Obsidian notes say what they are about with `type:` in their frontmatter (the vaults already use
 *   `type: decision | incident | service`) and how they relate with link fields (`works_at: [[Acme]]`);
 * - saving to Hindsight passes those as entity hints, and the relations as plain statements, so the
 *   facts come out with the right names;
 * - the Memory graph and the exported notes colour and file each entity by its type.
 *
 * It extends the unified-memory ontology v1 (Projects/unified-memory/ONTOLOGY.md on Zo, proposed, not
 * deployed): the same Bot, Team, Project and research-document types, bots named by their HQ id (which
 * is also their memory bank's id), and the same relation names (member_of, works_on, belongs_to,
 * authored_by, cites, supports, contradicts, supersedes, derived_from). The business types (person,
 * company, deal, job, …) are this app's addition. v1's evidence kinds (Hypothesis, Observation,
 * ValidatedLesson, …) and their review rules stay in Gnoesis; nothing here promotes or validates.
 *
 * Hindsight does not keep entity types itself, so the type of each named thing is kept here
 * (`memory_entity_types`, per account): from typed Obsidian notes (`source='note'`, re-derived on
 * every sync) and from the vault's Types.md (`source='user'`, which wins), in separate rows. On top of that, `entityTyper` knows the
 * account's own bots and teams by name, and a name shaped like a Build-flow job number is a job.
 */

export interface EntityType { id: string; label: string; plural: string; hindsight: string; color: string; about: string }

export const ENTITY_TYPES: EntityType[] = [
  { id: 'person', label: 'Person', plural: 'People', hindsight: 'PERSON', color: '#7aa2f7', about: 'A human: a client contact, a teammate, a lead.' },
  { id: 'company', label: 'Company', plural: 'Companies', hindsight: 'ORG', color: '#e0af68', about: 'A business or organisation: a client, a vendor, a partner.' },
  { id: 'deal', label: 'Deal', plural: 'Deals', hindsight: 'DEAL', color: '#9ece6a', about: 'A sale or renewal in progress, with a stage and a value.' },
  { id: 'project', label: 'Project', plural: 'Projects', hindsight: 'PROJECT', color: '#bb9af7', about: 'A piece of work with a goal: an internal build, a campaign.' },
  { id: 'job', label: 'Job', plural: 'Jobs', hindsight: 'JOB', color: '#ff9e64', about: 'A Build-flow construction job, named by its job number.' },
  { id: 'bot', label: 'Bot', plural: 'Bots', hindsight: 'AGENT', color: '#2ac3de', about: 'One AI agent on the team.' },
  { id: 'team', label: 'Team', plural: 'Teams', hindsight: 'TEAM', color: '#73daca', about: 'A team channel: bots and people pointed at one brief.' },
  { id: 'decision', label: 'Decision', plural: 'Decisions', hindsight: 'DECISION', color: '#f7768e', about: 'Something decided, with its context and who approved it.' },
  { id: 'task', label: 'Task', plural: 'Tasks', hindsight: 'TASK', color: '#c0caf5', about: 'A unit of work: a RevOpt task, a to-do a bot tracked.' },
  { id: 'service', label: 'Service', plural: 'Services', hindsight: 'SERVICE', color: '#a9b1d6', about: 'A running program on a server, with a port and a log.' },
  { id: 'incident', label: 'Incident', plural: 'Incidents', hindsight: 'INCIDENT', color: '#db4b4b', about: 'Something that broke, what it hit, and how it was fixed.' },
  { id: 'document', label: 'Document', plural: 'Documents', hindsight: 'DOCUMENT', color: '#b4f9f8', about: 'A research document or external reference, by its source (v1 ResearchDocument / ExternalReference).' },
];
/** Anything Hindsight found that no note or app record has typed yet. */
export const UNTYPED: EntityType = { id: 'entity', label: 'Entity', plural: 'Other', hindsight: 'CONCEPT', color: '#565f89', about: 'Not typed yet.' };

export interface RelationType { id: string; label: string; from: string[]; to: string[] }

/** Link fields a note may carry in its frontmatter. `from`/`to` are what they usually join; they guide, they do not reject. */
export const RELATIONS: RelationType[] = [
  { id: 'works_at', label: 'works at', from: ['person'], to: ['company'] },
  { id: 'owns', label: 'owns', from: ['person', 'bot', 'team', 'company'], to: ['deal', 'project', 'job', 'task', 'service'] },
  { id: 'decided', label: 'decided', from: ['person', 'bot', 'team'], to: ['decision'] },
  { id: 'assigned_to', label: 'is assigned to', from: ['task', 'job', 'deal', 'project'], to: ['person', 'bot', 'team'] },
  { id: 'about', label: 'is about', from: ['decision', 'task', 'incident', 'deal'], to: ['company', 'person', 'project', 'job', 'service', 'deal'] },
  { id: 'part_of', label: 'is part of', from: ['task', 'job', 'project', 'service', 'bot', 'person'], to: ['project', 'company', 'team'] },
  { id: 'affects', label: 'affects', from: ['incident', 'decision'], to: ['service', 'project', 'job', 'company'] },
  // From unified-memory ontology v1.
  { id: 'member_of', label: 'is a member of', from: ['bot', 'person'], to: ['team'] },
  { id: 'works_on', label: 'works on', from: ['bot', 'team', 'person'], to: ['project', 'job', 'deal'] },
  { id: 'belongs_to', label: 'belongs to', from: ['document', 'decision', 'task', 'incident'], to: ['project'] },
  { id: 'authored_by', label: 'was written by', from: ['document', 'decision'], to: ['bot', 'person'] },
  { id: 'cites', label: 'cites', from: ['decision', 'document', 'task'], to: ['document'] },
  { id: 'supports', label: 'supports', from: ['document', 'decision'], to: [] },
  { id: 'contradicts', label: 'contradicts', from: ['document', 'decision'], to: [] },
  { id: 'supersedes', label: 'supersedes', from: ['decision', 'document'], to: ['decision', 'document'] },
  { id: 'derived_from', label: 'is derived from', from: ['document', 'decision'], to: ['document'] },
  { id: 'related_to', label: 'is related to', from: [], to: [] },
];

const byId = new Map(ENTITY_TYPES.map((t) => [t.id, t]));
/** The vaults' existing `type:` values that are not entities (an overview, a runbook) map to nothing. */
const ALIASES: Record<string, string> = { people: 'person', contact: 'person', org: 'company', organisation: 'company', organization: 'company', client: 'company', agent: 'bot', adr: 'decision', todo: 'task', researchdocument: 'document', research: 'document', reference: 'document', externalreference: 'document' };

export function typeOf(raw: unknown): EntityType | null {
  const k = String(raw ?? '').trim().toLowerCase();
  return byId.get(k) ?? byId.get(ALIASES[k] ?? '') ?? null;
}
export const relationOf = (raw: unknown) => RELATIONS.find((r) => r.id === String(raw ?? '').trim().toLowerCase()) ?? null;

// ---------- what each named thing is ----------

/**
 * One row per account, name and source: a note's type and the account's Types.md entry are kept
 * side by side, so changing one never loses the other, and Types.md wins on lookup. Rows belong to
 * the account whose vault they came from and type only that account's entities.
 */
let ready = false;
export function initOntology() {
  if (ready) return;
  ready = true;
  const cols = (db.prepare("SELECT name FROM pragma_table_info('memory_entity_types')").all() as { name: string }[]).map((c) => c.name);
  // An earlier shape had one row per name for everyone. The rows are re-derived on every sync, so it is safe to start over.
  if (cols.length && !cols.includes('owner')) db.exec('DROP TABLE memory_entity_types');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_entity_types (
    owner TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, name_key, source)
  )`);
}

const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
type Source = 'note' | 'user';

/** Records what a named thing is for one account, from one source. */
export function setEntityType(owner: string, name: string, type: string, source: Source) {
  initOntology();
  const t = typeOf(type);
  const k = key(name);
  if (!t || !k || k.length > 200) return;
  db.prepare(`INSERT INTO memory_entity_types(owner,name_key,name,type,source,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(owner, name_key, source) DO UPDATE SET name=excluded.name, type=excluded.type, updated_at=excluded.updated_at`)
    .run(owner, k, name.trim(), t.id, source, now());
}

/** Replaces all of one account's types from one source (Types.md is the whole of the `user` typing). */
export function replaceTypes(owner: string, source: Source, entries: { name: string; type: string }[]) {
  initOntology();
  db.transaction(() => {
    db.prepare('DELETE FROM memory_entity_types WHERE owner=? AND source=?').run(owner, source);
    for (const e of entries) setEntityType(owner, e.name, e.type, source);
  })();
}

export interface TypeConflict { name: string; path: string; type: string; kept: string; keptFrom: string }

/**
 * Sets the account's note-derived types from what the notes say now, so a deleted or retyped note
 * stops typing its entity. When two notes give one name different types, the first by path wins and
 * the others are returned as conflicts (callers walk notes in sorted path order, so this is stable).
 * With `complete: false` (the scan stopped at the note cap) existing rows are kept and only the
 * scanned notes' types are written, so notes the scan never reached keep their types.
 */
export function replaceNoteTypes(owner: string, entries: { name: string; type: string; path: string }[], opts: { complete: boolean } = { complete: true }): TypeConflict[] {
  initOntology();
  const chosen = new Map<string, { name: string; type: string; path: string }>();
  const conflicts: TypeConflict[] = [];
  for (const e of entries) {
    const t = typeOf(e.type);
    const k = key(e.name);
    if (!t || !k || k.length > 200) continue;
    const prev = chosen.get(k);
    if (!prev) chosen.set(k, { name: e.name, type: t.id, path: e.path });
    else if (prev.type !== t.id) conflicts.push({ name: e.name, path: e.path, type: t.id, kept: prev.type, keptFrom: prev.path });
  }
  if (opts.complete) replaceTypes(owner, 'note', [...chosen.values()]);
  else db.transaction(() => { for (const c of chosen.values()) setEntityType(owner, c.name, c.type, 'note'); })();
  return conflicts;
}

/**
 * A lookup from entity name to type for one account: its Types.md, then its typed notes, then its
 * own bots and teams, then the shape of the name (a Build-flow job number, the same format
 * Build-flow accepts). Another account's rows never apply.
 */
export function entityTyper(owner: string): (name: string) => EntityType {
  initOntology();
  const known = new Map<string, string>();
  for (const r of db.prepare("SELECT name, COALESCE(kind,'agent') kind FROM bots WHERE user_id=?").all(owner) as any[]) known.set(key(r.name), r.kind === 'team' ? 'team' : 'bot');
  // Notes first, then Types.md, so the Types.md entry is the one left in the map.
  for (const r of db.prepare("SELECT name_key, type FROM memory_entity_types WHERE owner=? ORDER BY CASE source WHEN 'note' THEN 0 ELSE 1 END").all(owner) as any[]) known.set(r.name_key, r.type);
  return (name: string) => {
    const t = known.get(key(name));
    if (t) return byId.get(t) ?? UNTYPED;
    return looksLikeJobNumber(name) ? byId.get('job')! : UNTYPED;
  };
}

/** The ontology as an Obsidian note, so people editing the vault see the vocabulary. */
export function ontologyNote(): string {
  return [
    '---', 'type: ontology', 'generated: bot-hq', '---', '',
    '# Bot memory ontology', '',
    'Written by Bot HQ; edit `server/src/ontology.ts` to change it. Extends the unified-memory ontology v1 (`Projects/unified-memory/ONTOLOGY.md`): same Bot/Team/Project/document types and relation names, plus business types. Put `type:` in a note\'s frontmatter to say what it is about, and a link field to say how it relates (`works_at: "[[Acme]]"`). Bots read notes under `workspace/`; this `Memory/` folder is generated and never read back.', '',
    '## Types', '', '| type | what it is | Hindsight hint |', '|---|---|---|',
    ...ENTITY_TYPES.map((t) => `| \`${t.id}\` | ${t.about} | ${t.hindsight} |`), '',
    '## Link fields', '', '| field | meaning | usually from → to |', '|---|---|---|',
    ...RELATIONS.map((r) => `| \`${r.id}\` | ${r.label} | ${r.from.join(', ') || 'any'} → ${r.to.join(', ') || 'any'} |`), '',
  ].join('\n');
}
