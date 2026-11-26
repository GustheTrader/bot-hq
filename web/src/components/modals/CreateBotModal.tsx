import { useCallback, useEffect, useState } from 'react';
import type { AvatarColor, Bot } from '@shared/types';
import { BotAvatarFor, PortraitPresets } from '../../avatar/BotAvatar';
import { api, type PublicTemplate } from '../../lib/api';
import { COLOR_ORDER, palette } from '../../lib/colors';
import { useStore } from '../../store';
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

  const pickTemplate = (t: PublicTemplate | null) => {
    setTemplateId(t?.id ?? null);
    setInputs({});
    setError(null);
    if (t) setColor(t.defaults.avatarColor);
  };

  const missing = template ? template.inputs.filter((i) => i.required && !(inputs[i.key] ?? '').trim()) : [];
  const canCreate = (template ? missing.length === 0 : name.trim().length > 0) && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const base = { name: name.trim(), avatarShape: 'heart' as const, avatarColor: color, avatarImage, mode };
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
          {templates.length > 0 && (
            <label className="template-pick">
              <span className="template-form__label">Start from</span>
              <select className="text-input" value={templateId ?? ''} onChange={(e) => pickTemplate(templates.find((t) => t.id === e.target.value) ?? null)} aria-label="Start from">
                <option value="">Blank: give it a job yourself</option>
                {groups.map(([group, list]) => (
                  <optgroup key={group} label={group}>
                    {list.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.category}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
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
