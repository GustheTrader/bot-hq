import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi, type EngineCheck, type HarnessOption } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';

/** The model list's "type your own" entry; no real model id looks like this. */
const CUSTOM = '__other_model_id__';
const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/**
 * "Engine" section of the details panel: which provider and model run this bot's agent, signing in to
 * a subscription, and the agent's status. Every call fails soft: if the engine endpoints are missing or
 * down, the section says so and the rest of the panel is unaffected.
 */
/** Display names for when the harness list has not loaded yet. */
const HARNESS_NAMES: Record<string, string> = { hermes: 'Hermes', codex: 'Codex', 'claude-code': 'Claude Code', pi: 'Pi', opencode: 'OpenCode' };

export function EngineSettings({ bot }: { bot: Bot }) {
  const viewerOpen = useStore((s) => s.viewerOpen);
  const set = useStore((s) => s.set);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'signin' | 'restart' | 'screen' | 'claude' | 'harness' | null>(null);
  /** Claude sign-in done here in the page: the link to open, and the code that page gives back. */
  const [claudeUrl, setClaudeUrl] = useState<string | null>(null);
  const [claudeCode, setClaudeCode] = useState('');
  const [harnesses, setHarnesses] = useState<HarnessOption[]>([]);
  useEffect(() => { configApi.harnesses().then((r) => setHarnesses(r.harnesses)).catch(() => {}); }, []);
  const [note, setNote] = useState<string | null>(null);
  /** The last settings check: running, or what it found. */
  const [check, setCheck] = useState<'running' | EngineCheck | null>(null);
  /** Typing a model id the provider does not list, instead of picking from its list. */
  const [customModel, setCustomModel] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const dirty = useRef(false);
  const botId = bot.id;
  /** The bot this panel shows right now; answers that come back for another bot are dropped. */
  const shown = useRef(botId);
  shown.current = botId;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine, quiet); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  /** One short real turn through what is saved now; the result stays under the settings. */
  const runCheck = useCallback(async () => {
    const id = botId;
    setCheck('running');
    try { const r = await configApi.checkEngine(id); if (shown.current === id) setCheck(r.check); }
    catch (e) { if (shown.current === id) setCheck({ ok: false, status: 0, ms: 0, via: '', error: (e as Error).message || 'the server did not answer' }); }
  }, [botId]);

  useEffect(() => { dirty.current = false; setEngine(null); setNote(null); setCheck(null); setCustomModel(false); setSigningIn(false); setClaudeUrl(null); setClaudeCode(''); setBusy(null); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  // Signing in happens on the bot's computer. Check while that view is open, and once more when it closes.
  useEffect(() => {
    if (!signingIn) return;
    if (!viewerOpen) { setSigningIn(false); load(true); return; }
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [signingIn, viewerOpen, load]);

  if (phase !== 'ok' || !engine) {
    return (
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? 'Checking…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const suggestions = selected?.models ?? [];
  // A saved model the provider no longer lists still shows, so the list never hides what is set.
  const modelChoices = model.trim() && !suggestions.includes(model.trim()) ? [model.trim(), ...suggestions] : suggestions;
  const typing = customModel || suggestions.length === 0;
  // Empty means the agent's own default, so going back to "Default" is a change like any other.
  const providerChanged = provider !== (engine.provider ?? '');
  const modelChanged = model.trim() !== (engine.model ?? '');
  const changed = providerChanged || modelChanged;
  const openSubscriptions = providers.filter((p) => p.kind === 'subscription' && !p.connected);
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected ? selected : null;
  const listId = `engine-models-${botId}`;

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id); setCustomModel(false);
    const next = providers.find((p) => p.id === id);
    // A model from another provider will not work here: start from this provider's first suggestion,
    // or its own default when it suggests none.
    if (!next?.models.includes(model.trim())) setModel(next?.models[0] ?? '');
  };

  const save = async () => {
    if (!changed || busy) return;
    setBusy('save'); setNote(null);
    // Provider and model go together, so the saved pair always matches.
    try {
      const r = await configApi.setEngine(botId, { provider: provider || null, model: model.trim() || null });
      if (shown.current !== botId) return;
      dirty.current = false; apply(r.engine);
      void runCheck();
    }
    catch (e) { if (shown.current === botId) setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { if (shown.current === botId) setBusy(null); }
  };

  const signIn = async () => {
    if (busy) return;
    setBusy('signin'); setNote(null);
    try {
      await configApi.engineLogin(botId, signInTo?.id);
      // The sign-in runs in a terminal on the bot's screen, so take the person there with the mouse and keyboard.
      set({ viewerOpen: true, viewerMode: 'control', viewerHint: `Finish signing in on ${bot.name}’s computer, then hand back.` });
      setSigningIn(true);
    } catch (e) { setNote(`Couldn’t start sign-in: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const claudeStart = async () => {
    if (busy) return;
    setBusy('claude'); setNote(null);
    try { const r = await configApi.claudeLoginStart(botId); if (shown.current !== botId) return; setClaudeCode(''); setClaudeUrl(r.url); }
    catch (e) { if (shown.current === botId) setNote(`Couldn’t start the Claude sign-in: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { if (shown.current === botId) setBusy(null); }
  };

  const claudeFinish = async () => {
    if (busy || !claudeCode.trim()) return;
    setBusy('claude'); setNote(null);
    try { const r = await configApi.claudeLoginFinish(botId, claudeCode.trim()); if (shown.current !== botId) return; setClaudeUrl(null); setClaudeCode(''); apply(r.engine, true); }
    catch (e) { if (shown.current === botId) { setClaudeUrl(null); setClaudeCode(''); setNote(`Claude sign-in didn’t finish: ${(e as Error).message || 'the engine did not answer'}`); } }
    finally { if (shown.current === botId) setBusy(null); }
  };

  const claudeCancel = () => { setClaudeUrl(null); setClaudeCode(''); void configApi.claudeLoginCancel(botId).catch(() => {}); };

  const harness = bot.harness ?? 'hermes';
  const harnessDef = harnesses.find((h) => h.id === harness);
  const pickHarness = async (id: string) => {
    if (busy || id === harness) return;
    setBusy('harness'); setNote(null);
    try {
      await configApi.setHarness(botId, id);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, harness: id } : b)) }));
      if (shown.current === botId) void runCheck();
    } catch (e) { if (shown.current === botId) setNote(`Couldn’t switch: ${(e as Error).message || 'the server did not answer'}`); }
    finally { if (shown.current === botId) setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t switch screens: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting">
        <span>Harness</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{busy === 'harness' ? 'Switching…' : harnessDef?.name ?? HARNESS_NAMES[harness] ?? harness}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          {/* Until the list loads, only the current harness is offered and the picker stays shut. */}
          <select aria-label="Harness" value={harness} disabled={busy === 'harness' || !harnesses.length} onChange={(e) => pickHarness(e.target.value)}>
            {(harnesses.length ? harnesses : [{ id: harness, name: HARNESS_NAMES[harness] ?? harness, subscription: '', installed: true }]).map((h) => (
              <option key={h.id} value={h.id} disabled={!h.installed}>{h.name}{h.installed ? '' : ' · Not installed'}</option>
            ))}
          </select>
        </span>
      </div>
      {harness !== 'hermes' && (
        <div className="engine__notice">
          <span>{harnessDef?.name ?? harness} runs this Bot’s turns with its own sign-in ({harnessDef?.subscription ?? 'its own'}). It keeps the app’s tools, but not Hermes’ memory, and the provider settings below apply to Hermes only.</span>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <span>Provider</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{selected?.name ?? (provider || 'Default')}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Provider" value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {!selected && <option value={provider}>{provider || 'Default'}</option>}
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND[p.kind]} · {p.connected ? 'Connected' : 'Not connected'}</option>)}
          </select>
        </span>
      </div>
      {selected && (
        <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
          <i aria-hidden />
          <span>{selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}</span>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <label htmlFor={`${listId}-input`}>Model</label>
        {typing ? (
          <input
            id={`${listId}-input`} className="engine__model" value={model} spellCheck={false} autoComplete="off"
            placeholder={suggestions[0] ?? 'Model id'}
            onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          />
        ) : (
          // Every model the provider offers, not only those matching what is typed.
          <span className="mini-select mini-select--native engine__select" title={model || 'Provider default'}>
            <span>{model.trim() || 'Provider default'}</span>
            <Icon name="chev_down" size={10} opacity={0.66} />
            <select
              id={`${listId}-input`} value={model.trim()}
              onChange={(e) => {
                setNote(null);
                if (e.target.value === CUSTOM) { setCustomModel(true); return; }
                dirty.current = true; setModel(e.target.value);
              }}
            >
              <option value="">Provider default</option>
              {modelChoices.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value={CUSTOM}>Other model ID…</option>
            </select>
          </span>
        )}
      </div>
      {selected && suggestions.length > 0 && (
        <div className="engine__conn">
          <span>{suggestions.length} model{suggestions.length === 1 ? '' : 's'} on {selected.name}</span>
          {customModel && <button type="button" className="link-btn link-btn--small" onClick={() => setCustomModel(false)}>Pick from the list</button>}
        </div>
      )}
      <div className="engine__actions">
        <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={!changed || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {changed && <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>Undo</button>}
        {!changed && <button type="button" className="link-btn link-btn--small" onClick={runCheck} disabled={check === 'running'}>{check === 'running' ? 'Testing…' : 'Test'}</button>}
      </div>
      {check && (
        <div className={`engine__check ${check === 'running' ? 'is-running' : check.ok ? 'is-ok' : 'is-bad'}`} role="status">
          {check === 'running' ? 'Sending a test message…' : check.ok
            ? `Works · ${check.status} · replied in ${(check.ms / 1000).toFixed(1)}s · ${check.via}`
            : `Failed${check.status ? ` · ${check.status}` : ''}${check.via ? ` · ${check.via}` : ''}: ${check.error ?? 'no reply'}`}
        </div>
      )}
      {(signInTo || openSubscriptions.length > 0) && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={busy === 'signin'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'signin' ? 'Opening sign-in…' : signInTo ? `Sign in to ${signInTo.name}…` : 'Sign in to a subscription…'}
        </button>
      )}
      {selected?.id === 'anthropic' && !claudeUrl && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={claudeStart} disabled={busy === 'claude'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'claude' ? 'Starting…' : 'Sign in with a Claude subscription here…'}
        </button>
      )}
      {claudeUrl && (
        <div className="engine__notice">
          <span>1. <a href={claudeUrl} target="_blank" rel="noopener noreferrer">Open Claude and approve</a>. 2. Paste the code it shows here.</span>
          <input
            className="engine__model" aria-label="Code from Claude" value={claudeCode} spellCheck={false} autoComplete="off" placeholder="Code from Claude"
            onChange={(e) => setClaudeCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') claudeFinish(); }}
          />
          <span>
            <button type="button" className="btn btn--sm btn--bot" onClick={claudeFinish} disabled={!claudeCode.trim() || busy === 'claude'}>{busy === 'claude' ? 'Signing in…' : 'Finish sign-in'}</button>
            {' '}
            <button type="button" className="link-btn link-btn--small" onClick={claudeCancel} disabled={busy === 'claude'}>Cancel</button>
          </span>
        </div>
      )}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{bot.name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Switching…' : 'Use this screen'}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
          <i aria-hidden />
          Hermes · profile {engine.profile} · {STATUS[engine.status] ?? engine.status}
        </span>
        {(engine.status === 'error' || engine.status === 'stopped') && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
  );
}
