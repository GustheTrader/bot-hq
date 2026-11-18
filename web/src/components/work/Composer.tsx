import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, LibrarySkill, Project } from '@shared/types';
import { configApi, type HarnessOption } from '../../lib/configApi';
import { displayName, useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { EnginePicker } from './EnginePicker';
import { engineLabel, errText } from './shared';

/** Matches the server's limit on skills per request. */
const MAX_SKILLS = 8;
const SOURCE_LABEL: Record<LibrarySkill['source'], string> = { zo: 'Zo', hermes: 'Hermes' };

// ---------- the skill library: fetched when first wanted, then shared ----------

let libraryCache: { at: number; skills: LibrarySkill[] } | null = null;
const fresh = () => (libraryCache && Date.now() - libraryCache.at < 60_000 ? libraryCache.skills : null);

function useSkillLibrary(wanted: boolean) {
  const [skills, setSkills] = useState<LibrarySkill[] | null>(fresh);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || skills) return;
    let alive = true;
    configApi.skillLibrary()
      .then((r) => { libraryCache = { at: Date.now(), skills: r.skills }; if (alive) setSkills(r.skills); })
      .catch((e) => { if (alive) setError(errText(e, 'Could not load skills')); });
    return () => { alive = false; };
  }, [wanted, skills]);
  return { skills, error };
}

/** The `/word` being typed right before the caret: a slash at the start or after a space. */
function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([^\s/]*)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

function matches(s: LibrarySkill, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return s.name.toLowerCase().includes(n) || s.id.toLowerCase().includes(n) || s.category.toLowerCase().includes(n) || s.description.toLowerCase().includes(n);
}

interface Props {
  harnesses: HarnessOption[] | null;
  /** Inside a project: the project is fixed. */
  project?: Project;
  /** On the launch page: the projects to choose from, and which is chosen ('' none, `__folder` a typed folder). */
  projects?: Project[];
  projectChoice?: string;
  onProjectChoice?: (v: string) => void;
  /**
   * Stay on this page after starting (GnoesisWork): the box clears for the next request and the bot's progress
   * shows on its Bot HQ page and its live card, instead of opening the chat.
   */
  stay?: boolean;
  onStarted?: (bot: Bot) => void;
}

/**
 * The launcher: say what the work is (type `/` to attach skills from Zo and Hermes), pick a bot, harness and model,
 * and go. If that is not the bot's current engine, starting sets it (the bot keeps it afterwards) and the page says
 * so before you press the button.
 */
export function Composer({ harnesses, project, projects, projectChoice = '', onProjectChoice, stay = false, onStarted }: Props) {
  const allBots = useStore((s) => s.bots);
  const bots = useMemo(() => allBots.filter((b) => b.kind !== 'team'), [allBots]);
  const active = project ?? projects?.find((p) => p.id === projectChoice) ?? null;
  const folderMode = !project && projectChoice === '__folder';

  const [prompt, setPrompt] = useState('');
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<LibrarySkill[]>([]);
  const [botId, setBotId] = useState('');
  const [harness, setHarness] = useState(active?.harness ?? 'hermes');
  const [model, setModel] = useState<string | null>(active?.harnessModel ?? null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [wantLibrary, setWantLibrary] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const { skills, error: libError } = useSkillLibrary(wantLibrary);

  // Default bot: the primary one, else the first. Set once bots have loaded.
  // In GnoesisWork (`stay`) its own bot comes first when it exists.
  useEffect(() => {
    if (botId || !bots.length) return;
    const own = stay ? bots.find((b) => b.name.trim().toLowerCase() === 'gnoesiswork') : undefined;
    setBotId(own?.id ?? bots.find((b) => b.isPrimary)?.id ?? bots[0].id);
  }, [bots, botId, stay]);
  // The engine starts as the project's, or, with no project, as the chosen bot's own, so starting work never changes
  // a bot's engine unless the person picks a different one. Re-runs only when the bot or project changes, never on a
  // roster refresh, so a hand-picked engine is kept.
  useEffect(() => {
    if (active) { setHarness(active.harness); setModel(active.harnessModel); return; }
    const b = useStore.getState().bots.find((x) => x.id === botId);
    if (b) { setHarness(b.harness ?? 'hermes'); setModel(b.harness && b.harness !== 'hermes' ? b.harnessModel ?? null : null); }
  }, [active?.id, botId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Put the caret where a pick or the Skills button left it, once React has written the new text.
  useEffect(() => {
    if (pendingCaret.current !== null && taRef.current) { taRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current); pendingCaret.current = null; }
  }, [prompt]);

  const token = slashToken(prompt, caret);
  useEffect(() => { if (token) setWantLibrary(true); else setClosedAt(null); }, [token?.start]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuOpen = !!token && token.start !== closedAt;
  const list = useMemo(
    () => (skills ?? []).filter((s) => matches(s, token?.query ?? '') && !picked.some((p) => p.id === s.id)).slice(0, 60),
    [skills, token?.query, picked],
  );
  useEffect(() => { setActiveIdx(0); }, [token?.query]);
  useEffect(() => { menuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [activeIdx, menuOpen]);

  const bot = bots.find((b) => b.id === botId);
  const botHarness = bot?.harness ?? 'hermes';
  const switching = !!bot && (harness !== botHarness || (harness !== 'hermes' && (model ?? null) !== (bot.harnessModel ?? null)));

  const pick = (s: LibrarySkill) => {
    if (!token) return;
    if (picked.length >= MAX_SKILLS) { setError(`You can attach up to ${MAX_SKILLS} skills.`); return; }
    let start = token.start;
    let end = caret;
    if (start > 0 && /\s/.test(prompt[start - 1]) && /\s/.test(prompt[end] ?? ' ')) start -= 1; // do not leave a double space behind
    setPrompt(prompt.slice(0, start) + prompt.slice(end));
    pendingCaret.current = start;
    setCaret(start);
    setPicked((p) => [...p, s]);
    setError(null);
    taRef.current?.focus();
  };

  const openMenu = () => {
    const ta = taRef.current;
    const pos = ta?.selectionStart ?? prompt.length;
    const ins = (pos > 0 && !/\s/.test(prompt[pos - 1]) ? ' ' : '') + '/';
    setPrompt(prompt.slice(0, pos) + ins + prompt.slice(pos));
    pendingCaret.current = pos + ins.length;
    setCaret(pos + ins.length);
    setClosedAt(null);
    ta?.focus();
  };

  const start = async () => {
    if (!bot || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (switching) await configApi.setHarness(bot.id, harness, harness === 'hermes' ? null : model);
      await configApi.launch({
        botId: bot.id,
        prompt: prompt.trim(),
        projectId: active?.id ?? null,
        folder: folderMode ? folder.trim() : undefined,
        skills: picked.map((s) => s.id),
      });
      await useStore.getState().loadBots().catch(() => {});
      if (stay) {
        setPrompt(''); setCaret(0); setPicked([]); setBusy(false);
        onStarted?.(bot);
        taRef.current?.focus();
        return;
      }
      useStore.getState().selectBot(bot.id);
      useConfigUI.getState().openChat();
    } catch (e) {
      setError(errText(e, 'Could not start the work'));
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && list.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => (i + 1) % list.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => (i - 1 + list.length) % list.length); return; }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); pick(list[Math.min(activeIdx, list.length - 1)]); return; }
    }
    if (menuOpen && e.key === 'Escape') { e.preventDefault(); setClosedAt(token!.start); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); }
  };

  let lastSource = '';
  return (
    <section className={`proj-composer panel-card workbox${project ? '' : ' workbox--launch'}`}>
      {picked.length > 0 && (
        <div className="skill-chips" aria-label="Attached skills">
          {picked.map((s) => (
            <span key={s.id} className="skill-chip" title={s.description || s.name}>
              <span className="skill-chip__src">{SOURCE_LABEL[s.source]}</span>
              {s.name}
              <button type="button" aria-label={`Remove ${s.name}`} onClick={() => setPicked((p) => p.filter((x) => x.id !== s.id))}>&times;</button>
            </span>
          ))}
        </div>
      )}

      <div className="workbox__input">
        <textarea
          ref={taRef}
          className="proj-composer__text"
          placeholder={project ? `What should we work on in ${project.name}?  Type / for skills` : 'What should we work on?  Type / for skills'}
          value={prompt}
          rows={project ? 3 : 4}
          onChange={(e) => { setPrompt(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          aria-label="What should we work on"
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
        />
        {menuOpen && (
          <div className="skill-menu" role="listbox" aria-label="Skills" ref={menuRef}>
            {!skills && !libError && <div className="skill-menu__note">Loading skills…</div>}
            {libError && <div className="skill-menu__note" role="alert">{libError}</div>}
            {skills && list.length === 0 && <div className="skill-menu__note">{token?.query ? `No skill matches “${token.query}”.` : 'No skills found.'}</div>}
            {list.map((s, i) => {
              const heading = s.source !== lastSource ? SOURCE_LABEL[s.source] + ' skills' : null;
              lastSource = s.source;
              return (
                <div key={s.id}>
                  {heading && <div className="skill-menu__heading">{heading}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIdx}
                    data-active={i === activeIdx}
                    className="skill-menu__item"
                    onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    <span className="skill-menu__name">{s.name}{s.category && <span className="skill-menu__cat">{s.category}</span>}</span>
                    {s.description && <span className="skill-menu__desc">{s.description}</span>}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="proj-composer__row">
        {!project && projects && (
          <label className="proj-field">
            <span className="proj-field__label">Project or folder</span>
            <select className="text-input" value={projectChoice} onChange={(e) => onProjectChoice?.(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="__folder">A folder…</option>
            </select>
          </label>
        )}
        {folderMode && (
          <label className="proj-field proj-field--wide">
            <span className="proj-field__label">Folder</span>
            <input className="text-input" value={folder} placeholder="/home/workspace/Projects/…" onChange={(e) => setFolder(e.target.value)} aria-label="Folder" />
          </label>
        )}
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
        <span className="proj-hint">{bot ? <><BotAvatarFor bot={bot} size={14} /> {bot.name} gets your request{active ? ` with ${active.name}’s notes and skills` : ''}{picked.length ? `, and ${picked.length === 1 ? 'the skill' : `${picked.length} skills`} you attached` : ''}.</> : 'Create a bot first.'}</span>
        <span className="workbox__buttons">
          <button type="button" className="btn btn--secondary btn--sm" onClick={openMenu} disabled={picked.length >= MAX_SKILLS} title="Attach a skill (or type /)">/ Skills</button>
          <button type="button" className="btn btn--primary btn--sm" disabled={!bot || !prompt.trim() || busy} onClick={start}>{busy ? 'Starting…' : 'Start work'}</button>
        </span>
      </div>
      {error && <div className="card__error" role="alert">{error}</div>}
    </section>
  );
}
