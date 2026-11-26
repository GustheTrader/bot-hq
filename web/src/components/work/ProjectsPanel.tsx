import { useCallback, useEffect, useState } from 'react';
import type { Project, ProjectSkill } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { Glyph } from '../config/glyphs';
import { Composer } from './Composer';
import { EnginePicker } from './EnginePicker';
import { engineLabel, errText, t3Url, useHarnesses } from './shared';
import { inSpace, newSpaceId, useStore } from '../../store';
import { SpaceSelect, SpaceSwitcher, SpaceTag } from '../Spaces';

function SkillForm({ initial, onSave, onCancel, onDelete }: {
  initial?: ProjectSkill;
  onSave: (s: { name: string; description: string; body: string }) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errText(e, 'Could not save')); setBusy(false); }
  };
  return (
    <div className="proj-skill-form">
      <input className="text-input" placeholder="Skill name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Skill name" />
      <input className="text-input" placeholder="When to use it (one line)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="When to use this skill" />
      <textarea className="text-input proj-skill-form__body" placeholder="What the bot should do, step by step" value={body} rows={6} onChange={(e) => setBody(e.target.value)} aria-label="Skill instructions" />
      <div className="proj-skill-form__foot">
        {onDelete && <button type="button" className="btn btn--secondary btn--sm proj-danger" disabled={busy} onClick={() => run(onDelete)}>Delete</button>}
        <span className="proj-spacer" />
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" disabled={busy || !name.trim() || !body.trim()} onClick={() => run(() => onSave({ name, description, body }))}>{busy ? 'Saving…' : 'Save skill'}</button>
      </div>
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}

function ProjectDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const harnesses = useHarnesses();
  const t3 = t3Url();
  const [project, setProject] = useState<Project | null>(null);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [instructions, setInstructions] = useState('');
  const [form, setForm] = useState({ name: '', description: '', folder: '', harness: 'hermes', harnessModel: null as string | null });
  const [saving, setSaving] = useState<'notes' | 'settings' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [code, setCode] = useState<'idle' | 'adding' | 'ready'>('idle');

  const load = useCallback(async () => {
    try {
      const r = await configApi.project(id);
      setProject(r.project);
      setSkills(r.skills);
      setInstructions(r.project.instructions);
      setForm({ name: r.project.name, description: r.project.description, folder: r.project.folder, harness: r.project.harness, harnessModel: r.project.harnessModel });
      setError(null);
    } catch (e) { setError(errText(e, 'Could not load the project')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const save = async (which: 'notes' | 'settings', patch: Partial<Parameters<typeof configApi.updateProject>[1]>) => {
    setSaving(which);
    setError(null);
    try {
      const r = await configApi.updateProject(id, patch);
      setProject(r.project);
      if (which === 'settings') { setForm({ name: r.project.name, description: r.project.description, folder: r.project.folder, harness: r.project.harness, harnessModel: r.project.harnessModel }); setCode('idle'); }
    } catch (e) { setError(errText(e, 'Could not save')); }
    finally { setSaving(null); }
  };

  /** Registers the folder with the Code workspace (T3), which has real terminals, then opens it. */
  const openInCode = async () => {
    setCode('adding');
    setError(null);
    try {
      await configApi.openProjectInCode(id);
      setCode('ready');
      if (t3) window.open(t3, '_blank', 'noopener');
    } catch (e) {
      setCode('idle');
      setError(errText(e, 'Could not open in Code'));
    }
  };

  if (!project) return <div className="cfg-empty">{error ?? 'Loading…'}</div>;

  const notesDirty = instructions.trim() !== project.instructions;
  const settingsDirty = form.name.trim() !== project.name || form.description !== project.description || form.folder !== project.folder || form.harness !== project.harness || (form.harnessModel ?? null) !== (project.harnessModel ?? null);

  return (
    <div className="proj-detail">
      <button type="button" className="link-btn proj-back" onClick={onBack}>&larr; All projects</button>
      <div className="proj-detail__head">
        <h2 className="proj-detail__name">{project.name}</h2>
        <span className="proj-chip">{engineLabel(harnesses, project.harness, project.harnessModel)}</span>
      </div>
      <label className="proj-space">
        <span className="section-label">Workspace</span>
        <SpaceSelect value={project.spaceId ?? null} onChange={(spaceId) => { void save('settings', { spaceId }); }} />
      </label>
      {project.description && <p className="proj-detail__desc">{project.description}</p>}
      {project.folder && <p className="proj-detail__folder">{project.folder}</p>}

      <div className="proj-code">
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!project.folder || !t3 || code === 'adding'}
          onClick={openInCode}
          title={!project.folder ? 'Add a folder in the project settings first' : !t3 ? 'The Code workspace address is not set up for this site' : 'Open this folder in the Code workspace, which has a terminal'}
        >
          {code === 'adding' ? 'Adding to Code…' : 'Open in Code'}
        </button>
        {code === 'ready' && t3 && <a className="proj-code__link" href={t3} target="_blank" rel="noopener noreferrer">Added. Open the Code workspace &rarr;</a>}
        {!project.folder && <span className="proj-hint">Add a folder in settings to open it in Code.</span>}
        {project.folder && code === 'idle' && <span className="proj-hint">A terminal and coding agent in this folder.</span>}
      </div>

      <Composer key={project.id} project={project} harnesses={harnesses} />

      <div className="section-label">Project notes</div>
      <div className="panel-card proj-notes">
        <textarea className="proj-notes__text" placeholder="Standing context every bot reads when work starts here: the goal, the rules, what done looks like." value={instructions} rows={5} onChange={(e) => setInstructions(e.target.value)} aria-label="Project notes" />
        <div className="proj-notes__foot">
          <span className="proj-hint">{notesDirty ? 'Unsaved changes' : 'Sent to the bot with every request'}</span>
          <button type="button" className="btn btn--primary btn--sm" disabled={!notesDirty || saving === 'notes'} onClick={() => save('notes', { instructions })}>{saving === 'notes' ? 'Saving…' : 'Save notes'}</button>
        </div>
      </div>

      <div className="section-label section-label--row">
        <span>Skills · {skills.length}</span>
        {editing !== 'new' && <button type="button" className="link-btn link-btn--small" onClick={() => setEditing('new')}>Add skill</button>}
      </div>
      <div className="panel-card proj-skills">
        {editing === 'new' && (
          <SkillForm
            onCancel={() => setEditing(null)}
            onSave={async (s) => { await configApi.addProjectSkill(id, s); setEditing(null); await load(); }}
          />
        )}
        {skills.length === 0 && editing !== 'new' && <div className="panel-empty">No skills yet. A skill is a how-to every bot in this project follows, like &ldquo;how we write release notes&rdquo;. To use one from Zo or Hermes just for one request, type / in the box above.</div>}
        {skills.map((s) => (
          editing === s.id ? (
            <SkillForm
              key={s.id}
              initial={s}
              onCancel={() => setEditing(null)}
              onSave={async (v) => { await configApi.updateProjectSkill(s.id, v); setEditing(null); await load(); }}
              onDelete={async () => { await configApi.deleteProjectSkill(s.id); setEditing(null); await load(); }}
            />
          ) : (
            <button key={s.id} type="button" className="proj-skill" onClick={() => setEditing(s.id)}>
              <span className="proj-skill__name">{s.name}</span>
              {s.description && <span className="proj-skill__desc">{s.description}</span>}
            </button>
          )
        ))}
      </div>

      <div className="section-label">Project settings</div>
      <div className="panel-card proj-settings">
        <label className="proj-field">
          <span className="proj-field__label">Name</span>
          <input className="text-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Project name" />
        </label>
        <label className="proj-field">
          <span className="proj-field__label">About</span>
          <input className="text-input" value={form.description} placeholder="One line" onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label="Project description" />
        </label>
        <label className="proj-field">
          <span className="proj-field__label">Folder</span>
          <input className="text-input" value={form.folder} placeholder="/home/workspace/Projects/…  (told to the bots; Open in Code adds it to the Code workspace)" onChange={(e) => setForm({ ...form, folder: e.target.value })} aria-label="Project folder" />
        </label>
        <div className="proj-field__label">Default engine for new work</div>
        <EnginePicker harnesses={harnesses} harness={form.harness} model={form.harnessModel} onChange={(h, m) => setForm({ ...form, harness: h, harnessModel: m })} />
        <div className="proj-settings__foot">
          {confirmDelete ? (
            <>
              <span className="proj-hint">Delete this project and its {skills.length} {skills.length === 1 ? 'skill' : 'skills'}?</span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button type="button" className="btn btn--secondary btn--sm proj-danger" onClick={async () => { try { await configApi.deleteProject(id); onBack(); } catch (e) { setError(errText(e, 'Could not delete')); } }}>Delete project</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--secondary btn--sm proj-danger" onClick={() => setConfirmDelete(true)}>Delete project</button>
              <span className="proj-spacer" />
              <button type="button" className="btn btn--primary btn--sm" disabled={!settingsDirty || !form.name.trim() || saving === 'settings'} onClick={() => save('settings', { name: form.name, description: form.description, folder: form.folder, harness: form.harness, harnessModel: form.harnessModel })}>
                {saving === 'settings' ? 'Saving…' : 'Save settings'}
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}

/** Work → Projects: your projects, each with notes, skills and a default engine, and a launcher to start work in one. */
export function ProjectsPanel() {
  const harnesses = useHarnesses();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', folder: '', description: '' });
  const [busy, setBusy] = useState(false);
  const activeSpace = useStore((s) => s.activeSpace);

  const load = useCallback(() => {
    configApi.projects().then((r) => { setProjects(r.projects); setError(null); }).catch((e) => setError(errText(e, 'Could not load projects')));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await configApi.createProject({ name: draft.name, folder: draft.folder, description: draft.description, instructions: '', harness: 'hermes', harnessModel: null, spaceId: newSpaceId(activeSpace) });
      setDraft({ name: '', folder: '', description: '' });
      setCreating(false);
      setOpenId(r.project.id);
    } catch (e) { setError(errText(e, 'Could not create the project')); }
    finally { setBusy(false); }
  };

  if (openId) return <ProjectDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;
  if (projects === null && !error) return <div className="cfg-empty">Loading…</div>;
  const shown = projects?.filter((p) => inSpace(p, activeSpace)) ?? null;

  return (
    <>
      <div className="section-label section-label--row">
        <span>Projects{shown && shown.length > 0 ? ` · ${shown.length}` : ''}</span>
        {!creating && <button type="button" className="link-btn link-btn--small" onClick={() => setCreating(true)}>New project</button>}
      </div>
      <SpaceSwitcher />
      {creating && (
        <div className="panel-card proj-new">
          <input className="text-input" placeholder="Project name" value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} aria-label="Project name" />
          <input className="text-input" placeholder="Folder on the server (optional)" value={draft.folder} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} aria-label="Project folder" />
          <input className="text-input" placeholder="What it is, in one line (optional)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Project description" />
          <div className="proj-new__foot">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setCreating(false); setError(null); }}>Cancel</button>
            <button type="button" className="btn btn--primary btn--sm" disabled={!draft.name.trim() || busy} onClick={create}>{busy ? 'Creating…' : 'Create project'}</button>
          </div>
        </div>
      )}
      {error && <div className="card__error" role="alert">{error}</div>}
      {shown && shown.length === 0 && !creating ? (
        <div className="tasks-empty">
          <Glyph name="tasks" size={28} opacity={0.35} />
          <div className="tasks-empty__title">No projects yet</div>
          <div className="tasks-empty__sub">A project holds the notes, skills and engine for a piece of ongoing work, so you can start any bot on it in one step.</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>New project</button>
        </div>
      ) : (
        <div className="proj-grid">
          {shown?.map((p) => (
            <button key={p.id} type="button" className="proj-card" onClick={() => setOpenId(p.id)}>
              <span className="proj-card__top">
                <span className="proj-card__name">{p.name}</span>
                <span className="proj-chip">{engineLabel(harnesses, p.harness, p.harnessModel)}</span>
              </span>
              {activeSpace === 'all' && <SpaceTag spaceId={p.spaceId} />}
              {p.description && <span className="proj-card__desc">{p.description}</span>}
              <span className="proj-card__meta">
                {p.skillCount} {p.skillCount === 1 ? 'skill' : 'skills'}
                <span aria-hidden> · </span>
                Updated {relativeShort(p.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
