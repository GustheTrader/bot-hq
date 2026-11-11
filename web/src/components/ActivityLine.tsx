import { useEffect, useRef, useState } from 'react';
import type { Bot, LiveState, Row } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { activityPhrase, activityStatus, isWaitingForYou } from '../lib/phrases';
import { duration } from '../lib/time';

const CAPTION_FADE_MS = 320;

/** A small glowing bulb that sits beside the mascot while the bot is thinking. */
function IdeaBulb() {
  return (
    <svg className="thinking__idea" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path className="thinking__idea-glass" d="M12 2.5a6.6 6.6 0 0 0-4.1 11.8c.7.55 1.1 1.3 1.1 2.1v.6h6v-.6c0-.8.4-1.55 1.1-2.1A6.6 6.6 0 0 0 12 2.5Z" />
      <path className="thinking__idea-base" d="M9.6 18.4h4.8a.8.8 0 0 1 0 1.6H9.6a.8.8 0 0 1 0-1.6Zm.9 2.5h3a.8.8 0 0 1 0 1.6h-3a.8.8 0 0 1 0-1.6Z" />
    </svg>
  );
}

/** One line of live reasoning. When the text changes, the old line fades out under the new one. */
function Caption({ text }: { text: string }) {
  const last = useRef(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const old = last.current;
    last.current = text;
    if (old === text) return;
    setLeaving(old);
    const t = setTimeout(() => setLeaving(null), CAPTION_FADE_MS);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span className="thinking__caption">
      <span key={text} className="thinking__caption-line is-in">{text}</span>
      {leaving !== null && leaving !== text && <span key={`out:${leaving}`} className="thinking__caption-line is-out" aria-hidden>{leaving}</span>}
    </span>
  );
}

interface Props {
  bot: Bot;
  live: LiveState;
  rows: Row[];
  /** Step count to show beside the timer. Leave out when a steps chip above already shows it. */
  steps?: number;
}

/**
 * The live status block at the end of the transcript while a turn runs: the bot's mascot sitting on a
 * dark pill with its name and a pulsing status word, a one-line caption of what it is doing, and a
 * running timer. When the bot is waiting for the person, the pill reads "Needs you" and stops pulsing.
 */
export function ThinkingBlock({ bot, live, rows, steps = 0 }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const waiting = isWaitingForYou(live);
  const status = activityStatus(live, rows);
  const since = live.startedAt ?? live.activity?.since ?? live.awaiting?.since ?? now;
  const tick = Math.floor((now - (live.activity?.since ?? since)) / 6000);
  const caption = waiting
    ? live.awaiting?.reason || 'Waiting for your answer'
    : live.caption?.trim() || activityPhrase(live, rows, tick);
  const timer = waiting
    ? live.awaiting && now - live.awaiting.since >= 1000 ? `Waiting for ${duration(now - live.awaiting.since)}` : null
    : now - since >= 1000 ? `Working for ${duration(now - since)}` : null;

  return (
    <div className={`thinking${waiting ? ' is-waiting' : ''}`}>
      <div className="thinking__badge">
        <span className="thinking__mascot"><BotAvatarFor bot={bot} size={36} /></span>
        {waiting ? <span className="thinking__alert" aria-hidden /> : <IdeaBulb />}
        <div className="thinking__pill" role="status" aria-live="polite">
          <span className="thinking__name">{bot.name}</span>
          <span className="thinking__status" key={status}>{status}</span>
        </div>
      </div>
      <div className="thinking__side">
        <Caption text={caption} />
        {(timer || steps > 0) && (
          <span className="thinking__meta">
            {timer}
            {timer && steps > 0 && ' · '}
            {steps > 0 && `${steps} ${steps === 1 ? 'step' : 'steps'}`}
          </span>
        )}
      </div>
    </div>
  );
}

/** Kept for existing importers: the activity line is now the thinking block. */
export const ActivityLine = ThinkingBlock;
