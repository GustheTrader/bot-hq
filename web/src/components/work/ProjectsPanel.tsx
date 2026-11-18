import { useCallback, useEffect, useState } from 'react';
import type { Project, ProjectSkill } from '@shared/types';
import { configApi, type HarnessModels, type HarnessOption } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { displayName, useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { Glyph } from '../config/glyphs';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** "Claude Code · opus", or just "Hermes" when the harness's own default model is used. */
function engineLabel(harnesses: HarnessOption[] | null, harness: string, model: string | null): string {
  const name = harnesses?.find((h) => h.id === harness)?.name ?? harness;
  return model ? `${name} · ${model}` : name;
}

function useHarnesses(): HarnessOption[] | null {
  const [list, setList] = useState<HarnessOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    configApi.harnesses().then((r) => { if (alive) setList(r.harnesses); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, []);
  return list;
}

/**
 * Pick any harness, then any model that harness offers with its sign-in on the computer. Hermes takes its model
 * from the bot's own Engine settings, so it has no model list here. A harness that is not installed is shown but
 * cannot be picked.
 */
function EnginePicker({ harnesses, harness, model, onChange }: {
  harnesses: HarnessOption[] | null;
  harness: string;
  model: string | null;
  onChange: (harness: string, model: string | null) => void;
}) {
  const [models, setModels] = useState<HarnessModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setModels(null);
    setError(null);
    if (harness === 'hermes') return;
    let alive = true;
    configApi.harnessModels(harness).then((m) => { if (alive) setModels(m); }).catch((e) => { if (alive) setError(errText(e, 'Could not load models')); });
    return () => { alive = false; };
  }, [harness]);

  const options = harnesses && harnesses.length > 0 ? harnesses : [{ id: harness, name: harness, subscription: '', installed: true }];
  const known = !model || models?.models.some((m) => m.value === model);
  return (
    <div className="proj-engine">
      <label className="proj-field">
        <span className="proj-field__label">Harness</span>
        <select className="text-input" value={harness} onChange={(e) => onChange(e.target.value, null)}>
          {options.map((h) => (
            <option key={h.id} value={h.id} disabled={!h.installed && h.id !== harness}>{h.name}{h.installed ? '' : ' (not installed)'}</option>
          ))}
        </select>
      </label>
      <label className="proj-field">
        <span className="proj-field__label">Model</span>
        {harness === 'hermes' ? (
          <span className="proj-hint">Set in the bot&rsquo;s Engine settings</span>
        ) : (
          <select className="text-input" value={model ?? ''} disabled={!models && !error} onChange={(e) => onChange(harness, e.target.value || null)}>
            <option value="">Default{models?.current ? ` (${models.current})` : ''}</option>
            {!known && model && <option value={model}>{model}</option>}
            {models?.models.map((m) => <option key={m.value} value={m.value}>{m.name}</option>)}
          </select>
        )}
      </label>
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}

/**
 * The launcher: say what the work is, pick a bot, harness and model, and go. If that is not the bot's current
 * engine, starting sets it (the bot keeps it afterwards) and the page says so before you press the button.
 */
function StartWork({ project, harnesses }: { project: Project; harnesses: HarnessOption[] | null }) {
  const allBots = useStore((s) => s.bots);
  const bots = allBots.filter((b) => b.kind !== 'team');
  const [botId, setBotId] = useState(() => bots.find((b) => b.isPrimary)?.id ?? bots[0]?.id ?? '');
  const [harness, setHarness] = useState(project.harness);
  const [model, setModel] = useState<string | null>(project.harnessModel);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bot = bots.find((b) => b.id === botId);
  const botHarness = bot?.harness ?? 'hermes';
  const switching = !!bot && (harness !== botHarness || (harness !== 'hermes' && (model ?? null) !== (bot.harnessModel ?? null)));

  const start = async () => {
    if (!bot || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (switching) await configApi.setHarness(bot.id, harness, harness === 'hermes' ? null : model);
      await configApi.startProject(project.id, bot.id, prompt.trim());
      await useStore.getState().loadBots().catch(() => {});
      useStore.getState().selectBot(bot.id);
      useConfigUI.getState().setView('chat');
    } catch (e) {
      setError(errText(e, 'Could not start the work'));
      setBusy(false);
    }
  };

  return (
    <section className="proj-composer panel-card">
      <textarea
        className="proj-composer__text"
        placeholder={`What should we work on in ${project.name}?`}
        value={prompt}
        rows={3}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); } }}
        aria-label="What should we work on"
      />
      <div className="proj-composer__row">
        <label className="proj-field">
          <span className="proj-field__label">Bot</span>
          <select className="text-input" value={botId} onChange={(e) => setBotId(e.target.value)} disabled={bots.length === 0}>
            {bots.map((b) => <option key={b.id} value={b.id}>{displayName(b)}</option>)}
          </select>
        </label>
        <EnginePicker harnesses={harnesses} harness={harness} model={model} onChange={(h, m) => { setHarness(h); setModel(m); }} />
      </div>
      {switching && bot && (
        <div className="proj-note" role="note">
          {bot.name} runs on {engineLabel(harnesses, botHarness, bot.harnessModel ?? null)} now. Starting will switch it to {engineLabel(harnesses, harness, harness === 'hermes' ? null : model)}, and it keeps that afterwards.
        </div>
      )}
      <div className="proj-composer__foot">
        <span className="proj-hint">{bot ? <><BotAvatarFor bot={bot} size={14} /> {bot.name} gets this project&rsquo;s notes and skills with your request.</> : 'Create a bot first.'}</span>
        <button type="button" className="btn btn--primary btn--sm" disabled={!bot || !prompt.trim() || busy} onClick={start}>
          {busy ? 'Starting…' : 'Start work'}
        </button>
      </div>
      {error && <div className="card__error" role="alert">{error}</div>}
    </section>
  );
}

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
  const [project, setProject] = useState<Project | null>(null);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [instructions, setInstructions] = useState('');
  const [form, setForm] = useState({ name: '', description: '', folder: '', harness: 'hermes', harnessModel: null as string | null });
  const [saving, setSaving] = useState<'notes' | 'settings' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      if (which === 'settings') setForm({ name: r.project.name, description: r.project.description, folder: r.project.folder, harness: r.project.harness, harnessModel: r.project.harnessModel });
    } catch (e) { setError(errText(e, 'Could not save')); }
    finally { setSaving(null); }
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
      {project.description && <p className="proj-detail__desc">{project.description}</p>}
      {project.folder && <p className="proj-detail__folder">{project.folder}</p>}

      <StartWork key={project.id} project={project} harnesses={harnesses} />

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
        {skills.length === 0 && editing !== 'new' && <div className="panel-empty">No skills yet. A skill is a how-to every bot in this project follows, like &ldquo;how we write release notes&rdquo;.</div>}
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
          <input className="text-input" value={form.folder} placeholder="/home/workspace/Projects/…  (told to the bot; the app never opens it)" onChange={(e) => setForm({ ...form, folder: e.target.value })} aria-label="Project folder" />
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

  const load = useCallback(() => {
    configApi.projects().then((r) => { setProjects(r.projects); setError(null); }).catch((e) => setError(errText(e, 'Could not load projects')));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await configApi.createProject({ name: draft.name, folder: draft.folder, description: draft.description, instructions: '', harness: 'hermes', harnessModel: null });
      setDraft({ name: '', folder: '', description: '' });
      setCreating(false);
      setOpenId(r.project.id);
    } catch (e) { setError(errText(e, 'Could not create the project')); }
    finally { setBusy(false); }
  };

  if (openId) return <ProjectDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;
  if (projects === null && !error) return <div className="cfg-empty">Loading…</div>;

  return (
    <>
      <div className="section-label section-label--row">
        <span>Projects{projects && projects.length > 0 ? ` · ${projects.length}` : ''}</span>
        {!creating && <button type="button" className="link-btn link-btn--small" onClick={() => setCreating(true)}>New project</button>}
      </div>
      {creating && (
        <div className="panel-card proj-new">
          <input className="text-input" placeholder="Project name" value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} aria-label="Project name" />
          <input className="text-input" placeholder="Folder on the bot's computer (optional)" value={draft.folder} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} aria-label="Project folder" />
          <input className="text-input" placeholder="What it is, in one line (optional)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Project description" />
          <div className="proj-new__foot">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setCreating(false); setError(null); }}>Cancel</button>
            <button type="button" className="btn btn--primary btn--sm" disabled={!draft.name.trim() || busy} onClick={create}>{busy ? 'Creating…' : 'Create project'}</button>
          </div>
        </div>
      )}
      {error && <div className="card__error" role="alert">{error}</div>}
      {projects && projects.length === 0 && !creating ? (
        <div className="tasks-empty">
          <Glyph name="tasks" size={28} opacity={0.35} />
          <div className="tasks-empty__title">No projects yet</div>
          <div className="tasks-empty__sub">A project holds the notes, skills and engine for a piece of ongoing work, so you can start any bot on it in one step.</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>New project</button>
        </div>
      ) : (
        <div className="proj-grid">
          {projects?.map((p) => (
            <button key={p.id} type="button" className="proj-card" onClick={() => setOpenId(p.id)}>
              <span className="proj-card__top">
                <span className="proj-card__name">{p.name}</span>
                <span className="proj-chip">{engineLabel(harnesses, p.harness, p.harnessModel)}</span>
              </span>
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
