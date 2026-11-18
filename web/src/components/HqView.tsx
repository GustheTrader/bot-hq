import { useEffect, useState } from 'react';
import type { Bot, LiveState } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { activityStatus, isWaitingForYou } from '../lib/phrases';
import { relativeShort } from '../lib/time';
import { displayName, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { api } from '../lib/api';
import { LiveSignal } from './LiveSignal';

export type Tier = 'needs' | 'working' | 'idle';

function tierOf(live: LiveState | undefined): Tier {
  if (isWaitingForYou(live)) return 'needs';
  return live?.isRunning ? 'working' : 'idle';
}

/** Counts shown on the sidebar badge: bots that are working or waiting on the person. */
export function useActiveBotCount(): { working: number; needs: number } {
  const live = useStore((s) => s.live);
  let working = 0;
  let needs = 0;
  for (const l of Object.values(live)) {
    const t = tierOf(l);
    if (t === 'needs') needs += 1;
    else if (t === 'working') working += 1;
  }
  return { working, needs };
}

export function ActiveCard({ bot, live, tier }: { bot: Bot; live: LiveState; tier: Tier }) {
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = live.question ?? null;
  const open = () => {
    useStore.getState().selectBot(bot.id);
    useConfigUI.getState().setView('chat');
  };
  /** Answer the bot's question right here: same endpoint the chat card uses, so the bot gets it as its next message. */
  const answer = async (option: string) => {
    if (!q || sending) return;
    setSending(option);
    setError(null);
    try {
      await api.answer(bot.id, q.seq, option);
      // The server pushes the new state too; clear it here so the card never sits there looking unanswered.
      useStore.setState((s) =>
        s.live[bot.id]?.question?.seq === q.seq
          ? { live: { ...s.live, [bot.id]: { ...s.live[bot.id], question: null, awaiting: null, activity: null } } }
          : {},
      );
    } catch (e) {
      setError((e as Error).message || 'Could not send your answer');
    } finally {
      setSending(null);
    }
  };
  const steps = live.steps ?? 0;
  return (
    <div className={`hq-card${tier === 'needs' ? ' is-needs' : ''}${q ? ' has-question' : ''}`}>
      <button type="button" className="hq-card__main" onClick={open}>
        <span className="hq-card__avatar"><BotAvatarFor bot={bot} size={40} /></span>
        <span className="hq-card__body">
          <span className="hq-card__top">
            <span className="hq-card__name">{displayName(bot)}</span>
            {live.grokJobId && <span className="hq-card__steps">from Grok Bot</span>}
            <span className="hq-card__status">{activityStatus(live, [])}</span>
            {steps > 0 && <span className="hq-card__steps">{steps} {steps === 1 ? 'step' : 'steps'}</span>}
          </span>
          <LiveSignal botId={bot.id} className="hq-card__signal" />
        </span>
      </button>
      {q && (
        <div className="hq-question">
          {q.options.length > 0 && (
            <div className="hq-question__options" role="group" aria-label={`Answer ${bot.name}`}>
              {q.options.map((opt, i) => (
                <button key={`${i}:${opt}`} type="button" className={`hq-option${sending === opt ? ' is-sending' : ''}`} disabled={!!sending} onClick={() => answer(opt)}>
                  <span className="hq-option__key">{String.fromCharCode(65 + i)}</span>
                  <span className="hq-option__label">{opt}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="hq-question__chat" onClick={open}>Reply in your own words</button>
          {error && <div className="card__error" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * HQ activity board: every bot at a glance. Bots that need the person come first, then bots that are
 * working (with their live reasoning line and timer), then a quiet list of the idle ones. Click a card to
 * open that bot's chat.
 */
export function HqView() {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const real = bots.filter((b) => b.kind !== 'team');
  const rank = (b: Bot) => tierOf(live[b.id]);
  const needs = real.filter((b) => rank(b) === 'needs').sort((a, b) => (live[a.id]?.awaiting?.since ?? 0) - (live[b.id]?.awaiting?.since ?? 0));
  const working = real.filter((b) => rank(b) === 'working').sort((a, b) => (live[a.id]?.startedAt ?? now) - (live[b.id]?.startedAt ?? now));
  const idle = real.filter((b) => rank(b) === 'idle').sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const open = (id: string) => {
    useStore.getState().selectBot(id);
    useConfigUI.getState().setView('chat');
  };

  return (
    <main className="chat tasks-view hq-view">
      <header className="tasks-view__header">
        <h1 className="tasks-view__title">HQ activity</h1>
        <span className="hq-view__summary" aria-live="polite">
          {needs.length > 0 && <span className="hq-view__pill is-needs">{needs.length} need{needs.length === 1 ? 's' : ''} you</span>}
          {working.length > 0 && <span className="hq-view__pill is-working">{working.length} working</span>}
          {needs.length === 0 && working.length === 0 && <span className="hq-view__pill">All quiet</span>}
        </span>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {needs.length > 0 && (
            <section className="hq-section">
              <div className="section-label">Needs you</div>
              <div className="hq-grid">{needs.map((b) => <ActiveCard key={b.id} bot={b} live={live[b.id]} tier="needs" />)}</div>
            </section>
          )}
          {working.length > 0 && (
            <section className="hq-section">
              <div className="section-label">Working now</div>
              <div className="hq-grid">{working.map((b) => <ActiveCard key={b.id} bot={b} live={live[b.id]} tier="working" />)}</div>
            </section>
          )}
          {needs.length === 0 && working.length === 0 && (
            <div className="tasks-empty">
              <h2 className="tasks-empty__title">No bot is working right now</h2>
              <p className="tasks-empty__sub">When a bot starts a job you will see it here with what it is thinking, how long it has been at it, and any question it needs you to answer.</p>
            </div>
          )}
          {idle.length > 0 && (
            <section className="hq-section">
              <div className="section-label">Idle</div>
              <div className="hq-idle">
                {idle.map((b) => (
                  <button key={b.id} type="button" className="hq-idle__row" onClick={() => open(b.id)}>
                    <BotAvatarFor bot={b} size={24} />
                    <span className="hq-idle__name">{displayName(b)}</span>
                    <span className="hq-idle__when">{b.lastActivityAt ? `Active ${relativeShort(b.lastActivityAt)}` : 'No activity yet'}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
