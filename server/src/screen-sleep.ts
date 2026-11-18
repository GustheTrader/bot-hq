import { env } from './env.js';
import { sleepBotScreen, sleepCandidates } from './computer.js';
import { isTurnActive } from './agent/loop.js';

/**
 * Per-screen sleep, for a local computer (the bots' screens run on this machine). A bot's screen that has had no
 * turn and nobody watching for SCREEN_SLEEP_MIN minutes (default 20; 0 turns it off) is put to sleep: its browser
 * and display stop, its lease and browser profile stay. The next turn or viewer wakes it. The main screen (the
 * primary bot's) never sleeps. Screenshots and thumbnails do not wake a screen.
 */

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const screenSleepConfig = {
  idleMin: num(process.env.SCREEN_SLEEP_MIN, 20),
  sweepSec: num(process.env.SCREEN_SLEEP_SWEEP_SEC, 60),
};

// ---------- who is watching which bot's screen (vnc.ts) ----------

const watching = new Map<string, number>();
const watchedAt = new Map<string, number>();

export function screenViewerOpened(botId: string) {
  watching.set(botId, (watching.get(botId) ?? 0) + 1);
  watchedAt.set(botId, Date.now());
}

export function screenViewerClosed(botId: string) {
  const n = Math.max(0, (watching.get(botId) ?? 1) - 1);
  if (n) watching.set(botId, n); else watching.delete(botId);
  watchedAt.set(botId, Date.now());
}

// ---------- the decision (pure, unit-tested) ----------

export interface SleepScreen { botId: string; lastUsedAt: number; asleep: boolean }
export interface SleepInputs {
  now: number;
  idleMs: number;
  /** When this server started: a screen is never put to sleep sooner than idleMs after a restart. */
  startedAt: number;
  turnActive(botId: string): boolean;
  viewers(botId: string): number;
  lastWatched(botId: string): number;
}

/** The bots whose screen should go to sleep now. */
export function screensToSleep(screens: SleepScreen[], i: SleepInputs): string[] {
  if (i.idleMs <= 0) return [];
  return screens
    .filter((s) => !s.asleep && !i.turnActive(s.botId) && i.viewers(s.botId) === 0)
    .filter((s) => i.now - Math.max(s.lastUsedAt, i.lastWatched(s.botId), i.startedAt) >= i.idleMs)
    .map((s) => s.botId);
}

// ---------- the sweep ----------

export function startScreenSleeper(): void {
  const { idleMin, sweepSec } = screenSleepConfig;
  if (env.computerProvider !== 'local') return;
  if (idleMin <= 0) { console.log('[screen-sleep] off (SCREEN_SLEEP_MIN=0)'); return; }
  const startedAt = Date.now();
  const idleMs = idleMin * 60_000;
  const inputs = (): SleepInputs => ({
    now: Date.now(), idleMs, startedAt,
    turnActive: isTurnActive,
    viewers: (id) => watching.get(id) ?? 0,
    lastWatched: (id) => watchedAt.get(id) ?? 0,
  });
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      for (const botId of screensToSleep(sleepCandidates(), inputs())) {
        // Checked again inside the screen queue, right before the display stops.
        await sleepBotScreen(botId, () => screensToSleep(sleepCandidates().filter((s) => s.botId === botId), inputs()).length === 1)
          .catch((e) => console.warn(`[screen-sleep] could not put ${botId}'s screen to sleep: ${e?.message ?? e}`));
      }
    } finally { running = false; }
  };
  setInterval(() => { void sweep(); }, Math.max(15, sweepSec) * 1000).unref();
  console.log(`[screen-sleep] screens sleep after ${idleMin} min unused`);
}
