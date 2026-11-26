import { db, now } from './db.js';

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
 * (`memory_entity_types`), learned from typed notes and from what the app already knows (its bots,
 * teams and Build-flow jobs).
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

let ready = false;
export function initOntology() {
  if (ready) return;
  ready = true;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_entity_types (
    name_key TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
}

const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Records what a named thing is. A typed note wins over a guess. */
export function setEntityType(name: string, type: string, source: 'note' | 'app' | 'user') {
  initOntology();
  const t = typeOf(type);
  const k = key(name);
  if (!t || !k || k.length > 200) return;
  db.prepare(`INSERT INTO memory_entity_types(name_key,name,type,source,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(name_key) DO UPDATE SET name=excluded.name, type=excluded.type, source=excluded.source, updated_at=excluded.updated_at
    WHERE memory_entity_types.source <> 'user' OR excluded.source = 'user'`).run(k, name.trim(), t.id, source, now());
}

const JOB_RE = /^(job\s*#?\s*)?\d{2,6}(-\d{1,4})?$/i;

/**
 * A lookup from entity name to type: typed notes first, then the app's own bots and teams, then
 * the shape of the name (a bare job number is a Build-flow job).
 */
export function entityTyper(): (name: string) => EntityType {
  initOntology();
  const known = new Map<string, string>();
  for (const r of db.prepare("SELECT name, COALESCE(kind,'agent') kind FROM bots").all() as any[]) known.set(key(r.name), r.kind === 'team' ? 'team' : 'bot');
  for (const r of db.prepare('SELECT name_key, type FROM memory_entity_types').all() as any[]) known.set(r.name_key, r.type);
  return (name: string) => {
    const t = known.get(key(name));
    if (t) return byId.get(t) ?? UNTYPED;
    return JOB_RE.test(name.trim()) ? byId.get('job')! : UNTYPED;
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
