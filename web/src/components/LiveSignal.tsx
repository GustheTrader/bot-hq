import { useEffect, useState } from 'react';
import { activityPhrase, isWaitingForYou } from '../lib/phrases';
import { duration } from '../lib/time';
import { useStore } from '../store';

/** One shared 1s clock, only ticking while at least one signal on screen is active. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * The "working signal" for one bot: moving equalizer bars, the bot's live reasoning line, and a running
 * timer. When the bot has stopped to ask the person something, the bars become a steady attention dot and
 * the line shows the question. Renders nothing for an idle bot, so it is safe to drop in anywhere a bot is
 * listed: the sidebar roster, team rosters and the HQ activity board.
 *
 * It subscribes to the bot's live state itself, so a memoised parent row does not need to re-render when
 * the reasoning line changes.
 */
export function LiveSignal({ botId, showTime = true, className = '' }: { botId: string; showTime?: boolean; className?: string }) {
  const live = useStore((s) => s.live[botId]);
  const waiting = isWaitingForYou(live);
  const active = !!live && (live.isRunning || waiting);
  const now = useNow(active);
  if (!live || !active) return null;

  const since = waiting ? live.awaiting?.since ?? live.activity?.since : live.startedAt ?? live.activity?.since;
  const tick = Math.floor((now - (live.activity?.since ?? since ?? now)) / 6000);
  const text = waiting
    ? live.awaiting?.reason || 'Needs your input'
    : live.caption?.trim() || activityPhrase(live, [], tick);
  const elapsed = since && now - since >= 1000 ? duration(now - since) : null;

  return (
    <span className={`live-signal ${waiting ? 'is-waiting' : 'is-working'} ${className}`.trim()} role="status" aria-live="off">
      {waiting ? (
        <span className="live-signal__dot" aria-hidden />
      ) : (
        <span className="live-signal__bars" aria-hidden><i /><i /><i /></span>
      )}
      <span className="live-signal__text">
        <span key={text} className="live-signal__line">{text}</span>
      </span>
      {showTime && elapsed && <span className="live-signal__time">{elapsed}</span>}
    </span>
  );
}
