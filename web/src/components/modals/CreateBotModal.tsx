import { useCallback, useEffect, useState } from 'react';
import type { AvatarColor, Bot } from '@shared/types';
import { portraitPreset } from '@shared/portraits';
import { BotAvatarFor, PortraitPresets } from '../../avatar/BotAvatar';
import { api, type PublicTemplate } from '../../lib/api';
import { COLOR_ORDER, palette } from '../../lib/colors';
import { newSpaceId, shownSpace, useStore } from '../../store';
import { SpaceSelect } from '../Spaces';
import { Icon } from '../Icon';
import { Modal } from './Modal';

const COLOR_ROWS = [COLOR_ORDER.slice(0, 6), COLOR_ORDER.slice(6)];

export function CreateBotModal() {
  const setModal = useStore((s) => s.setModal);
  const peerCount = useStore((s) => s.bots.filter((bot) => bot.kind !== 'team' && !bot.isPrimary).length);
  const [name, setName] = useState('');
  const [avatarImage, setAvatarImage] = useState(() => `preset:${1 + peerCount % 5}`);
  const [color, setColor] = useState<AvatarColor>('orange');
  const [mode, setMode] = useState<Bot['mode']>('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PublicTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [spaceId, setSpaceId] = useState<string | null>(() => newSpaceId(shownSpace(useStore.getState())));
  const spaces = useStore((s) => s.spaces);
  const blankPortrait = `preset:${1 + peerCount % 5}`;
  const close = useCallback(() => setModal(null), [setModal]);
  const template = templates.find((t) => t.id === templateId) ?? null;
  // Technical roles first, then one group per business domain.
  const groups = templates.reduce<[string, PublicTemplate[]][]>((acc, t) => {
    const group = t.kind === 'technical' ? 'Technical' : `Domain · ${t.category}`;
    const found = acc.find(([g]) => g === group);
    if (found) found[1].push(t); else acc.push([group, [t]]);
    return acc;
  }, []);

  useEffect(() => {
    api.botTemplates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  /** A business template asks for the business name: the chosen business workspace already has it. */
  const prefill = (t: PublicTemplate | null, id: string | null): Record<string, string> => {
    const space = spaces.find((s) => s.id === id && s.kind === 'business');
    return space && t?.inputs.some((i) => i.key === 'company') ? { company: space.name } : {};
  };

  const pickTemplate = (t: PublicTemplate | null) => {
    // Picking what is already picked must not undo a portrait, colour or answers chosen since.
    if ((t?.id ?? null) === templateId) return;
    setTemplateId(t?.id ?? null);
    setInputs(prefill(t, spaceId));
    setError(null);
    if (t) setColor(t.defaults.avatarColor);
    setAvatarImage(t ? portraitPreset(t.portrait) : blankPortrait);
  };

  const pickSpace = (id: string | null) => {
    // Replace a name that was filled in for the old workspace; keep one the person typed.
    const old = prefill(template, spaceId).company;
    setInputs((v) => (!v.company || v.company === old ? { ...v, company: prefill(template, id).company ?? '' } : v));
    setSpaceId(id);
  };

  const missing = template ? template.inputs.filter((i) => i.required && !(inputs[i.key] ?? '').trim()) : [];
  const canCreate = (template ? missing.length === 0 : name.trim().length > 0) && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const base = { name: name.trim(), avatarShape: 'heart' as const, avatarColor: color, avatarImage, mode, spaceId };
      const { bot } = await api.createBot(template
        ? { ...base, template: template.id, inputs, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : base);
      const st = useStore.getState();
      st.set({ bots: st.bots.some((b) => b.id === bot.id) ? st.bots : [...st.bots, bot] });
      st.selectBot(bot.id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} className="create-modal" label="Create New Bot">
      <form onSubmit={(e) => { e.preventDefault(); create(); }}>
        <div className="modal__header">
          <div className="modal__title">Create New Bot</div>
          <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
        </div>
        <div className="create-modal__body">
          <label className="template-pick">
            <span className="template-form__label">Workspace</span>
            <SpaceSelect value={spaceId} onChange={pickSpace} />
          </label>
          {templates.length > 0 && (
            <div className="template-gallery" role="radiogroup" aria-label="Start from">
              <button type="button" role="radio" aria-checked={!templateId} className={`template-card template-card--blank${templateId ? '' : ' is-active'}`} onClick={() => pickTemplate(null)}>
                Blank: give it a job yourself
              </button>
              {groups.map(([group, list]) => (
                <div key={group} className="template-gallery__group">
                  <span className="template-form__label">{group}</span>
                  <div className="template-gallery__grid">
                    {list.map((t) => (
                      <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} disabled={t.missing.length > 0} className={`template-card${templateId === t.id ? ' is-active' : ''}`} onClick={() => pickTemplate(t)}>
                        <BotAvatarFor bot={{ name: t.title, avatarShape: 'heart', avatarColor: t.defaults.avatarColor, avatarImage: portraitPreset(t.portrait) }} size={44} />
                        <span className="template-card__title">{t.title}</span>
                        {t.missing.length > 0 && <span className="template-card__missing">Needs {t.missing.join(', ')}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <BotAvatarFor bot={{ name, avatarShape: 'heart', avatarColor: color, avatarImage }} size={96} className="create-modal__preview" />
          <input
            className="text-input create-modal__name"
            placeholder={template ? template.defaults.name : 'Give your Bot a name'}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            aria-label="Bot name"
          />
          {template && (
            <div className="template-form">
              <p className="template-form__blurb">{template.blurb}</p>
              <p className="template-form__meta">Runs on {template.harness === 'claude-code' ? 'Claude Code' : template.harness} · Works with {template.worksWith.join(', ')}</p>
              {template.inputs.map((i) => (
                <label key={i.key} className="template-form__field">
                  <span className="template-form__label">{i.label}{i.required ? '' : ' (optional)'}</span>
                  <input
                    className="text-input"
                    placeholder={i.placeholder ?? i.default ?? ''}
                    value={inputs[i.key] ?? ''}
                    maxLength={300}
                    onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                    aria-label={i.label}
                  />
                  {i.help && <span className="template-form__help">{i.help}</span>}
                </label>
              ))}
            </div>
          )}
          <PortraitPresets value={avatarImage} onSelect={setAvatarImage} />
          <div className="swatches" role="radiogroup" aria-label="Accent color">
            {COLOR_ROWS.map((row, i) => (
              <div key={i} className="swatches__row">
                {row.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className="swatch-cell" onClick={() => setColor(c)}>
                    <span className={`swatch${color === c ? ' is-selected' : ''}`} style={{ background: palette(c).fill }} />
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="mode-pick" role="radiogroup" aria-label="Bot type">
            <button type="button" role="radio" aria-checked={mode === 'personal'} className={`mode-pick__opt${mode === 'personal' ? ' is-active' : ''}`} onClick={() => setMode('personal')}>
              <span className="mode-pick__title">Personal assistant</span>
              <span className="mode-pick__sub">Works for you, with your apps</span>
            </button>
            <button type="button" role="radio" aria-checked={mode === 'teammate'} className={`mode-pick__opt${mode === 'teammate' ? ' is-active' : ''}`} onClick={() => setMode('teammate')}>
              <span className="mode-pick__title">Teammate</span>
              <span className="mode-pick__sub">Works with your whole team</span>
            </button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="link-btn link-btn--small" style={{ marginRight: 'auto' }} onClick={() => setModal('group')}>New group chat instead</button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!canCreate}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}
