import { useState } from 'react';
import type { Bot, Task } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { duration } from '../../lib/time';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { ActiveCard } from '../HqView';
import { Glyph } from '../config/glyphs';
import { useAttention } from './attention';

const openChat = (botId: string) => {
  useStore.getState().selectBot(botId);
  useConfigUI.getState().openChat();
};

/** One stalled task: what it was, how long it has been quiet, and the two things you can do about it. */
function StalledRow({ task, bot }: { task: Task; bot?: Bot }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const quiet = duration(Date.now() - task.updatedAt);

  const nudge = async () => {
    if (!bot || state !== 'idle') return;
    setState('sending');
    setError(null);
    try {
      await api.send(bot.id, `Quick check on "${task.title}": it has been quiet for ${quiet}. Where are you on it? If you are stuck, tell me what you need from me.`);
      setState('sent');
    } catch (e) {
      setError((e as Error).message || 'Could not send that');
      setState('idle');
    }
  };

  return (
    <div className="attn-row">
      <span className="attn-row__icon is-stalled" aria-hidden><Glyph name="tasks" size={16} /></span>
      <span className="attn-row__text">
        <span className="attn-row__title">{task.title}</span>
        {task.note && <span className="attn-row__note">{task.note}</span>}
        <span className="attn-row__meta">
          {bot && <><BotAvatarFor bot={bot} size={14} /><span>{bot.name}</span><span aria-hidden>·</span></>}
          <span>No update for {quiet}</span>
        </span>
        {error && <span className="card__error" role="alert">{error}</span>}
      </span>
      <span className="attn-row__actions">
        {bot && <button type="button" className="btn btn--secondary btn--sm" onClick={() => openChat(bot.id)}>Open chat</button>}
        {bot && (
          <button type="button" className="btn btn--primary btn--sm" disabled={state !== 'idle'} onClick={nudge}>
            {state === 'sending' ? 'Asking…' : state === 'sent' ? 'Asked' : 'Ask for an update'}
          </button>
        )}
      </span>
    </div>
  );
}

/** A task the bot marked as waiting on the person (and that has no live question of its own to answer). */
function WaitingRow({ task, bot }: { task: Task; bot?: Bot }) {
  return (
    <button type="button" className="attn-row attn-row--button" onClick={() => bot && openChat(bot.id)} disabled={!bot}>
      <span className="attn-row__icon is-waiting" aria-hidden><Glyph name="tasks" size={16} /></span>
      <span className="attn-row__text">
        <span className="attn-row__title">{task.title}</span>
        {task.note && <span className="attn-row__note">{task.note}</span>}
        <span className="attn-row__meta">
          {bot && <><BotAvatarFor bot={bot} size={14} /><span>{bot.name}</span><span aria-hidden>·</span></>}
          <span>Waiting on you for {duration(Date.now() - task.updatedAt)}</span>
        </span>
      </span>
      <span className="task-chip is-needs_input">Waiting on you</span>
    </button>
  );
}

/**
 * Work → Needs attention. Everything stuck on the person, most-overdue first: questions bots asked (answer
 * them right here), approvals, tasks waiting on a reply, and work that has gone quiet.
 */
export function NeedsAttention() {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const a = useAttention();
  const byId = new Map(bots.map((b) => [b.id, b]));

  if (a.total === 0) {
    return (
      <div className="tasks-empty">
        <Glyph name="check_circle" size={28} opacity={0.35} />
        <div className="tasks-empty__title">Nothing needs you</div>
        <div className="tasks-empty__sub">A bot waiting on an answer, a task waiting on your reply, or work that has gone quiet will show up here.</div>
      </div>
    );
  }

  const waiting = [...a.questions, ...a.approvals];
  return (
    <>
      {waiting.length > 0 && (
        <section className="attn-section">
          <div className="section-label">Waiting on you · {waiting.length}</div>
          <div className="hq-grid">
            {waiting.map((b) => <ActiveCard key={b.id} bot={b} live={live[b.id]} tier="needs" />)}
          </div>
        </section>
      )}
      {a.waitingTasks.length > 0 && (
        <section className="attn-section">
          <div className="section-label">Tasks waiting on you · {a.waitingTasks.length}</div>
          <div className="attn-list">{a.waitingTasks.map((t) => <WaitingRow key={t.id} task={t} bot={byId.get(t.botId)} />)}</div>
        </section>
      )}
      {a.stalled.length > 0 && (
        <section className="attn-section">
          <div className="section-label">Stalled · {a.stalled.length}</div>
          <div className="attn-list">{a.stalled.map((t) => <StalledRow key={t.id} task={t} bot={byId.get(t.botId)} />)}</div>
        </section>
      )}
    </>
  );
}
