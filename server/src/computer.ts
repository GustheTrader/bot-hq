import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { orgo, OrgoError, type OrgoScreen } from './orgo.js';
import { local } from './local.js';
import { cdpPortFor, dressScreen, resetScreen, undressScreen, type DeskBot } from './desk.js';
import { box } from './box.js';
import type { ComputerState } from './types.js';

/**
 * One Orgo computer for the whole team (ORGO_COMPUTER_ID), one screen per bot. The primary bot's
 * engine already lives on that computer's own desktop, so it keeps the default screen; every other
 * bot gets a screen of its own, dressed in its colour (see desk.ts). The computer is never created,
 * suspended or deleted from here: it is somebody's working machine.
 */

export interface BotScreen { computerId: string; screenId: string; width?: number; height?: number }

function computerId(): string {
  if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set, so there is no computer for the bots to use.');
  return env.orgoComputerId;
}

function rowFor(userId: string) {
  let r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId) as any;
  if (!r) {
    db.prepare("INSERT INTO computers(user_id,orgo_id,status,updated_at) VALUES (?, ?, 'starting', ?)").run(userId, env.orgoComputerId || null, now());
    r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId);
  }
  return r;
}

function setStatus(userId: string, status: ComputerState['status'], error: string | null = null) {
  rowFor(userId);
  db.prepare('UPDATE computers SET status=?, orgo_id=?, error=?, updated_at=? WHERE user_id=?').run(status, env.orgoComputerId || null, error, now(), userId);
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
}

export function computerState(userId: string): ComputerState {
  const r = rowFor(userId);
  const screens = (db.prepare('SELECT bot_id, screen_id, width, height FROM screens WHERE user_id=?').all(userId) as any[]).map((s) => ({
    botId: s.bot_id as string,
    screenId: s.screen_id as string,
    ...(s.width && s.height ? { width: s.width as number, height: s.height as number } : {}),
  }));
  return { status: r.status, orgoId: env.orgoComputerId || r.orgo_id, error: r.error, screens: screens.map((s) => (asleep.has(s.botId) ? { ...s, asleep: true } : s)), maxScreens: env.maxBots };
}

/** Bots whose screen is asleep right now (display stopped, lease and browser profile kept). */
const asleep = new Set<string>();

function mapStatus(s: string): ComputerState['status'] {
  if (s === 'running') return 'running';
  if (s === 'creating') return 'creating';
  if (s === 'suspended') return 'suspended';
  if (s === 'suspending') return 'suspending';
  if (s === 'resuming') return 'resuming';
  if (s === 'frozen' || s === 'stopped') return 'stopped';
  if (s === 'error') return 'error';
  return 'starting';
}

async function waitRunning(id: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await orgo.getComputer(id);
    if (c.status === 'running' && !c.asleep) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for the computer to start');
}

let checkedAt = 0;
let inflight: Promise<string> | null = null;

/** Make sure the shared computer is awake. Returns its Orgo id. */
export function ensureComputer(userId: string): Promise<string> {
  const id = computerId();
  if (Date.now() - checkedAt < 30_000) return Promise.resolve(id);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const c = await orgo.getComputer(id);
      if (c.status === 'running' && !c.asleep) {
        if (rowFor(userId).status !== 'running') setStatus(userId, 'running');
      } else if (c.status === 'suspended' || c.status === 'suspending' || c.asleep) {
        console.log(`[computer] waking ${id} (was ${c.status})`);
        setStatus(userId, 'resuming');
        for (let i = 0; i < 40 && (await orgo.getComputer(id)).status === 'suspending'; i++) await new Promise((res) => setTimeout(res, 3000));
        await orgo.resume(id);
        await waitRunning(id);
        setStatus(userId, 'running');
      } else if (c.status === 'frozen' || c.status === 'stopped' || c.status === 'error') {
        setStatus(userId, 'starting');
        await orgo.start(id);
        await waitRunning(id);
        setStatus(userId, 'running');
      } else {
        setStatus(userId, mapStatus(c.status));
        await waitRunning(id);
        setStatus(userId, 'running');
      }
      checkedAt = Date.now();
      return id;
    } catch (e: any) {
      const msg = e instanceof OrgoError && e.status === 404 ? 'The computer set in ORGO_COMPUTER_ID was not found with this Orgo key.' : String(e?.message ?? e);
      setStatus(userId, 'error', msg);
      throw new Error(msg);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function deskBot(botId: string): DeskBot | null {
  const b = db.prepare('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(botId) as any;
  return b ? { id: b.id, name: b.name, label: b.label ?? '', avatarShape: b.avatar_shape, avatarColor: b.avatar_color } : null;
}

const isPrimaryEngine = (botId: string) => (db.prepare('SELECT engine FROM bots WHERE id=?').get(botId) as any)?.engine === 'primary';

/** The primary bot's own Chrome (when PRIMARY_CDP_URL names one) is never started or stopped by us. */
const managesChrome = (botId: string) => !(isPrimaryEngine(botId) && env.primaryCdpUrl);

const verified = new Map<string, number>();
const leasing = new Map<string, Promise<BotScreen>>();
const dressing = new Map<string, Promise<void>>();
let screenQueue = Promise.resolve();

/** Checking reservations, provisioning a display and saving its lease must happen in order. */
function inScreenOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = screenQueue.then(work);
  screenQueue = next.then(() => undefined, () => undefined);
  return next;
}

function saveSize(botId: string, s: OrgoScreen | undefined) {
  if (s?.width && s?.height) db.prepare('UPDATE screens SET width=?, height=? WHERE bot_id=?').run(s.width, s.height, botId);
}

/** This bot's screen on the shared computer; leases one the first time. */
export function screenFor(userId: string, botId: string): Promise<BotScreen> {
  const running = leasing.get(botId);
  if (running) return running;
  const p = inScreenOrder(() => lease(userId, botId)).finally(() => leasing.delete(botId));
  leasing.set(botId, p);
  return p;
}

async function lease(userId: string, botId: string): Promise<BotScreen> {
  const id = await ensureComputer(userId);
  const mine = db.prepare(`
    SELECT screen_id, width, height,
      rowid = (SELECT MIN(rowid) FROM screens WHERE screen_id = lease.screen_id) AS first_lease
    FROM screens AS lease WHERE bot_id=?
  `).get(botId) as { screen_id: string; width: number | null; height: number | null; first_lease: number } | undefined;
  if (mine?.first_lease) {
    const fresh = Date.now() - (verified.get(botId) ?? 0) < 120_000;
    if (fresh || mine.screen_id === 'default') {
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId: id, screenId: mine.screen_id, width: mine.width ?? undefined, height: mine.height ?? undefined };
    }
    try {
      const s = await orgo.getScreen(id, mine.screen_id); // on a local computer this also starts a sleeping display
      verified.set(botId, Date.now());
      if (asleep.delete(botId)) {
        console.log(`[screen-sleep] woke ${mine.screen_id} for ${botId}`);
        hub.emit(userId, { type: 'computer', state: computerState(userId) });
      }
      saveSize(botId, s);
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId: id, screenId: mine.screen_id, width: s?.width ?? mine.width ?? undefined, height: s?.height ?? mine.height ?? undefined };
    } catch { /* The screen could not be recovered. Lease another below. */ }
  }
  if (mine) {
    // If two bots used the same screen, the first lease keeps it.
    db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    dressing.delete(botId);
    verified.delete(botId);
  }

  const taken = new Set((db.prepare('SELECT screen_id FROM screens').all() as any[]).map((r) => r.screen_id as string));
  const existing = await orgo.listScreens(id);
  let screen: OrgoScreen | undefined;
  if (isPrimaryEngine(botId)) {
    screen = existing.find((s) => s.id === 'default' || s.default) ?? ({ id: 'default', display: ':99', width: 0, height: 0, default: true } as OrgoScreen);
    screen = { ...screen, id: 'default' };
  } else {
    screen = existing.find((s) => s.id !== 'default' && !s.default && !taken.has(s.id));
    if (!screen) {
      if (existing.length >= env.maxBots) throw new Error(`Every screen on the computer is in use (${env.maxBots} at most). Remove a bot to free one.`);
      screen = env.computerProvider === 'local' ? await local.createScreen(id, taken) : await orgo.createScreen(id);
    }
  }
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,width,height) VALUES (?,?,?,?,?,?)').run(botId, userId, screen.id, now(), screen.width || null, screen.height || null);
  verified.set(botId, Date.now());
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
  return { computerId: id, screenId: screen.id, width: screen.width || undefined, height: screen.height || undefined };
}

/**
 * The bot's screen, dressed as its own computer (wallpaper, dock, its Chrome on its home screen).
 * Dressing happens once per server run per bot, and again when `redress` is set (rename, new colour).
 */
export async function readyScreen(userId: string, botId: string, opts: { redress?: boolean } = {}): Promise<BotScreen> {
  const s = await screenFor(userId, botId);
  if (opts.redress) dressing.delete(botId);
  let d = dressing.get(botId);
  if (!d) {
    const bot = deskBot(botId);
    d = bot
      ? dressScreen(bot, s.screenId, { manageChrome: managesChrome(botId) }).catch((e) => {
          console.warn(`[computer] could not dress ${s.screenId} for ${botId}: ${e?.message ?? e}`);
          dressing.delete(botId);
        })
      : Promise.resolve();
    dressing.set(botId, d);
  }
  await d;
  return s;
}

/** DevTools address of the Chrome on this bot's screen (for Hermes' browser tools). */
export function cdpUrlFor(botId: string, screenId: string): string {
  if (isPrimaryEngine(botId) && env.primaryCdpUrl) return env.primaryCdpUrl;
  return `http://127.0.0.1:${cdpPortFor(screenId)}`;
}

/**
 * Called before a bot starts working: its screen is leased and dressed, and the browser we run for it
 * answers. Without this a bot's first turn finds no browser and goes off to start one of its own.
 */
export async function screenForWork(userId: string, botId: string): Promise<void> {
  if (!env.orgoComputerId) return;
  if (!managesChrome(botId)) {
    // It brings its own browser, so nothing it needs depends on the dressing: don't make it wait.
    void readyScreen(userId, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    return;
  }
  const s = await readyScreen(userId, botId);
  if (!env.localBox) return;
  const alive = await fetch(`${cdpUrlFor(botId, s.screenId)}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!alive) await readyScreen(userId, botId, { redress: true });
}

/** Close everything on the bot's screen and bring its browser back to the home screen. Logins stay. */
export async function resetBotScreen(userId: string, botId: string): Promise<void> {
  const s = await screenFor(userId, botId);
  const bot = deskBot(botId);
  if (bot) await resetScreen(bot, s.screenId, { manageChrome: managesChrome(botId) });
}

/** The bot is gone: stop what we ran on its screen and free the screen for the next bot. */
export function releaseScreen(botId: string): Promise<void> {
  return inScreenOrder(async () => {
    const mine = db.prepare('SELECT screen_id, user_id FROM screens WHERE bot_id=?').get(botId) as { screen_id: string; user_id: string } | undefined;
    if (!mine) return;
    db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    dressing.delete(botId);
    verified.delete(botId);
    asleep.delete(botId);
    const stillLeased = db.prepare('SELECT 1 FROM screens WHERE screen_id=? LIMIT 1').get(mine.screen_id);
    if (mine.screen_id !== 'default' && !stillLeased) {
      try { await undressScreen(botId, mine.screen_id); } catch (e: any) { console.warn(`[computer] undress failed: ${e?.message ?? e}`); }
    }
    hub.emit(mine.user_id, { type: 'computer', state: computerState(mine.user_id) });
  });
}

/** Marks the bot's screen as just used (a turn ended, a viewer closed), so it is not put to sleep straight away. */
export function touchScreen(botId: string): void {
  db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
}

/** The leases a sleep sweep looks at: every screen except the main one (which never sleeps). */
export function sleepCandidates(): { botId: string; userId: string; screenId: string; lastUsedAt: number; asleep: boolean }[] {
  return (db.prepare("SELECT bot_id, user_id, screen_id, last_used_at FROM screens WHERE screen_id <> 'default'").all() as any[])
    .map((r) => ({ botId: r.bot_id, userId: r.user_id, screenId: r.screen_id, lastUsedAt: Number(r.last_used_at) || 0, asleep: asleep.has(r.bot_id) }));
}

/**
 * Puts one bot's screen to sleep: what we run there stops (its browser and desktop pieces) and the display goes
 * down, but the lease and the browser profile stay, so the bot keeps its screen number and its sign-ins. The next
 * turn or viewer wakes it (lease → getScreen starts the display, readyScreen dresses it again).
 * `stillIdle` is checked again inside the screen queue, so a turn that started meanwhile wins.
 */
export function sleepBotScreen(botId: string, stillIdle: () => boolean): Promise<boolean> {
  return inScreenOrder(async () => {
    if (env.computerProvider !== 'local' || asleep.has(botId) || leasing.has(botId) || !stillIdle()) return false;
    const mine = db.prepare('SELECT screen_id, user_id FROM screens WHERE bot_id=?').get(botId) as { screen_id: string; user_id: string } | undefined;
    if (!mine || mine.screen_id === 'default') return false;
    const shared = db.prepare('SELECT COUNT(*) AS n FROM screens WHERE screen_id=?').get(mine.screen_id) as { n: number };
    if (shared.n > 1) return false; // two leases on one display: leave it alone
    try { await undressScreen(botId, mine.screen_id); } catch (e: any) { console.warn(`[screen-sleep] undress ${mine.screen_id} failed: ${e?.message ?? e}`); }
    await local.deleteScreen(env.orgoComputerId, mine.screen_id);
    dressing.delete(botId);
    verified.delete(botId);
    asleep.add(botId);
    console.log(`[screen-sleep] ${mine.screen_id} asleep (${botId})`);
    hub.emit(mine.user_id, { type: 'computer', state: computerState(mine.user_id) });
    return true;
  });
}

/**
 * After a restart the list of sleeping screens is empty, though screens put to sleep before it are still stopped.
 * This marks every leased screen whose display is down as asleep, so the app shows it truthfully. Waking needs no
 * help: after a restart the first lease checks the screen and starts its display anyway.
 */
export async function markSleepingScreens(isAlive: (screenId: string) => Promise<boolean> = local.screenAlive): Promise<string[]> {
  if (env.computerProvider !== 'local') return [];
  const marked: string[] = [];
  const users = new Set<string>();
  for (const s of sleepCandidates()) {
    if (s.asleep || leasing.has(s.botId)) continue;
    if (await isAlive(s.screenId).catch(() => true)) continue;
    asleep.add(s.botId);
    marked.push(s.botId);
    users.add(s.userId);
  }
  for (const u of users) hub.emit(u, { type: 'computer', state: computerState(u) });
  if (marked.length) console.log(`[screen-sleep] ${marked.length} screen(s) were already asleep at startup`);
  return marked;
}

/** A deleted bot leaves nothing behind on the computer: its browser profile and its Library folder go. */
export async function forgetBotFiles(botId: string): Promise<void> {
  if (!/^bot_[\w-]+$/.test(botId)) return;
  await box.bash(`rm -rf -- /root/grokbot/profiles/${botId} /root/grokbot/files/${botId}`, 60);
}

/** The shared computer is never suspended from the app (other things live on it). */
export async function suspendComputer(_userId: string, _reason = 'manual'): Promise<void> {}

/** Refresh status and screen sizes from Orgo (cheap; used when the UI opens). */
export async function refreshComputer(userId: string): Promise<ComputerState> {
  if (!env.orgoComputerId) {
    setStatus(userId, 'error', 'ORGO_COMPUTER_ID is not set.');
    return computerState(userId);
  }
  try {
    const c = await orgo.getComputer(env.orgoComputerId);
    const s = mapStatus(c.asleep ? 'suspended' : c.status);
    const r = rowFor(userId);
    if (s !== r.status || r.error) setStatus(userId, s);
    if (s === 'running') {
      const screens = await orgo.listScreens(env.orgoComputerId);
      const byId = new Map(screens.map((x) => [x.default ? 'default' : x.id, x]));
      for (const row of db.prepare('SELECT bot_id, screen_id FROM screens WHERE user_id=?').all(userId) as any[]) saveSize(row.bot_id, byId.get(row.screen_id));
    }
  } catch (e: any) {
    setStatus(userId, 'error', e instanceof OrgoError && e.status === 404 ? 'The computer was not found with this Orgo key.' : String(e?.message ?? e));
  }
  return computerState(userId);
}
