import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { box, displayFor } from './box.js';

/**
 * The desk: what makes one screen of the shared computer look like one bot's own tidy computer.
 * A soft wallpaper in the bot's colour, no taskbar, a small dock, a light maximized Chrome, and a
 * home screen (the bot's avatar, a clock, the computer's apps) as Chrome's new tab page.
 *
 * The work on the computer is done by the scripts in server/box/, which this file installs under
 * /opt/hq and then calls with one short command per action. Only `box.*` is used to reach the
 * computer, so it works the same through Orgo's API and with HQ_LOCAL=1.
 */

export interface DeskBot { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

const ROOT = '/opt/hq';
const SCRIPT = `${ROOT}/hq-screen.py`;
/** Source file under server/box/ -> where it lives under /opt/hq on the computer. */
const BOX_FILES: Record<string, string> = {
  'hqlib.py': 'hqlib.py',
  'hq-screen.py': 'hq-screen.py',
  'hq-shell.py': 'hq-shell.py',
  'hq-home.py': 'hq-home.py',
  'home.html': 'home.html',
  'ext/manifest.json': 'ext/src/manifest.json',
  'ext/newtab.html': 'ext/src/newtab.html',
  'ext/newtab.js': 'ext/src/newtab.js',
};

const warn = (message: string) => console.warn(`[desk] ${message}`);
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const displayNumber = (screenId: string) => Number(displayFor(screenId).slice(1));

/** DevTools port of the Chrome we run on a screen: 9200 + display number (default screen → 9299). */
export function cdpPortFor(screenId: string): number {
  return 9200 + displayNumber(screenId);
}

// ---------------------------------------------------------------- the files that go on the computer

interface Bundle { files: Record<string, string>; hash: string }
let bundleCache: Bundle | null = null;

/** server/box/ sits next to both src/ (tsx) and dist/ (after tsc). */
function bundle(): Bundle {
  if (bundleCache) return bundleCache;
  const files: Record<string, string> = {};
  const h = createHash('sha256');
  for (const [src, dest] of Object.entries(BOX_FILES)) {
    const text = fs.readFileSync(new URL(`../box/${src}`, import.meta.url), 'utf8');
    files[dest] = text;
    h.update(`${dest}\0${sha(text)}\n`);
  }
  bundleCache = { files, hash: h.digest('hex').slice(0, 20) };
  return bundleCache;
}

// ---------------------------------------------------------------- talking to the box-side script

interface Reply { kind: 'OK' | 'DONE' | 'RUNNING' | 'NOBASE' | 'BASE_OK' | 'NONE'; rest: string; raw: string }

function parseReply(output: string): Reply {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^HQ_(OK|DONE|RUNNING|NOBASE|BASE_OK)\b ?(.*)$/.exec(lines[i]);
    if (m) return { kind: m[1] as Reply['kind'], rest: m[2], raw: output };
  }
  return { kind: 'NONE', rest: '', raw: output };
}

/**
 * The distribution's own Python when there is one: apt installs GTK's Python bindings for it, and on
 * machines with a second Python earlier in PATH (Zo has one in /usr/local/bin) `python3` cannot load them.
 */
const PY = '"$( [ -x /usr/bin/python3 ] && echo /usr/bin/python3 || echo python3 )"';

/** One call to hq-screen.py. A missing or failing script answers NOBASE so the caller can install it. */
async function script(args: string[], screenId?: string, timeoutSec = 60): Promise<Reply> {
  const cmd = `[ -f ${SCRIPT} ] && ${PY} ${SCRIPT} ${args.map(box.quote).join(' ')} 2>&1 || echo HQ_NOBASE`;
  const r = await box.bash(cmd, timeoutSec, screenId);
  return parseReply(r.output);
}

interface JobResult { ok?: boolean; error?: string; warnings?: string[]; [k: string]: unknown }

/** Follow a detached job on the computer to its end. Its warnings are logged; a failure throws. */
async function finish(first: Reply, what: string, maxSec: number): Promise<JobResult> {
  let reply = first;
  const end = Date.now() + maxSec * 1000;
  while (reply.kind === 'RUNNING') {
    if (Date.now() > end) throw new Error(`${what} is taking too long (still running after ${maxSec}s)`);
    reply = await script(['wait', reply.rest.trim(), '25']);
  }
  if (reply.kind === 'OK') return { ok: true };
  if (reply.kind !== 'DONE') throw new Error(`${what} failed: ${reply.raw.trim().slice(-300) || 'no answer from the computer'}`);
  let result: JobResult = {};
  try { result = JSON.parse(reply.rest) as JobResult; } catch { /* treated as plain success */ }
  for (const w of result.warnings ?? []) warn(w);
  if (result.ok === false) throw new Error(`${what} failed: ${result.error ?? 'unknown error'}`);
  return result;
}

// ---------------------------------------------------------------- one-time machine setup

let basePromise: Promise<void> | null = null;

async function setupBase(): Promise<void> {
  const b = bundle();
  const check = await script(['base-check', b.hash]);
  if (check.kind === 'BASE_OK') return;
  // The scripts are missing or changed: send them over in one piece and unpack.
  const packed = gzipSync(Buffer.from(JSON.stringify({ files: b.files }), 'utf8'));
  await box.writeFile(`${ROOT}/bundle.json.gz`, packed);
  const unpack = [
    'import gzip, json, os',
    `root = ${JSON.stringify(ROOT)}`,
    "files = json.load(gzip.open(root + '/bundle.json.gz', 'rt', encoding='utf-8'))['files']",
    'for rel, text in files.items():',
    '    path = os.path.join(root, rel)',
    '    os.makedirs(os.path.dirname(path), exist_ok=True)',
    "    with open(path + '.new', 'w', encoding='utf-8') as f:",
    '        f.write(text)',
    "    os.chmod(path + '.new', 0o755 if rel.endswith('.py') else 0o644)",
    "    os.replace(path + '.new', path)",
    "src = root + '/ext/src'",
    'for name in os.listdir(src):',
    "    if 'ext/src/' + name not in files:",
    '        os.unlink(os.path.join(src, name))',
    "os.unlink(root + '/bundle.json.gz')",
    "print('HQ_UNPACKED')",
  ].join('\n');
  const r = await box.bash(`${PY} -c ${box.quote(unpack)} 2>&1`, 60);
  if (!r.output.includes('HQ_UNPACKED')) {
    throw new Error(`could not install the desktop scripts on the computer (python3 is needed): ${r.output.trim().slice(-300)}`);
  }
  // Package installs can take a while on a fresh computer.
  await finish(await script(['base', b.hash]), 'computer setup', 900);
}

/** One-time machine setup (packages, scripts, home server, Chrome policy/extension). Idempotent, memoised per process, cheap when already done. */
export function ensureDeskBase(): Promise<void> {
  if (!basePromise) {
    basePromise = setupBase().catch((e) => { basePromise = null; throw e; });
  }
  return basePromise;
}

// ---------------------------------------------------------------- colours

type Rgb = [number, number, number];

const COLOR_HEX: Record<string, string> = {
  black: '#000000', brown: '#A06B39', red: '#FB2B3E', orange: '#FD690F', yellow: '#F59312', green: '#14C16F',
  cyan: '#13B7A2', blue: '#1E86FC', violet: '#8F59F9', magenta: '#F93498', gray: '#959595',
};

function colorHex(color: string): string {
  const c = (color ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`.toUpperCase();
  return COLOR_HEX[c.toLowerCase()] ?? COLOR_HEX.gray;
}

const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexOf = (rgb: Rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, t: number) => { const x = rgbOf(a), y = rgbOf(b); return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb); };

function hslOf(hex: string): Rgb {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

interface Palette { accent: string; ink: string; wash: string; washDeep: string; washLight: string; glow: string; glow2: string; line: string }

/** Soft tints of the bot's colour. Black and gray get a calm blue-gray instead of a muddy wash. */
function paletteFor(avatarHex: string): Palette {
  const [h, s] = hslOf(avatarHex);
  const base = s < 0.15 ? '#7A869A' : avatarHex;
  const hue = s < 0.15 ? 218 : h;
  const sat = s < 0.15 ? 0.3 : Math.max(0.55, Math.min(0.9, s));
  return {
    accent: base,
    ink: mix(base, '#14171F', 0.8),
    wash: hslHex(hue, sat, 0.925),
    washLight: hslHex(hue - 12, sat * 0.9, 0.965),
    washDeep: hslHex(hue + 10, sat, 0.865),
    glow: hslHex(hue + 28, Math.min(1, sat + 0.1), 0.84),
    glow2: hslHex(hue - 30, sat, 0.84),
    line: hslHex(hue, sat * 0.85, 0.68),
  };
}

// ---------------------------------------------------------------- wallpaper

/** Our own small line drawings, each on a 24 x 24 grid. */
const DOODLES: string[] = [
  'M4 12.5l5 5L20 6.5',                                                                                   // check
  'M12 3c.6 4.6 2.4 6.4 9 9-6.6 2.6-8.4 4.4-9 9-.6-4.6-2.4-6.4-9-9 6.6-2.6 8.4-4.4 9-9z',                 // spark
  'M5 19C5 10 10 5 19 5c0 9-5 14-14 14zM5 19l9-9',                                                        // leaf
  'M3 11l18-7-7 18-3-8-8-3zM11 14L21 4',                                                                  // paper plane
  'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',                    // chat bubble
  'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.3l6.1-.7z',                                  // star
  'M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',                                                                    // squiggle
  'M19 14.5A8 8 0 1 1 9.5 5a6.5 6.5 0 0 0 9.5 9.5z',                                                      // moon
  'M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6-1A4.5 4.5 0 0 1 17 18z',                                       // cloud
  'M13 3L5 13.5h6L10 21l8-10.5h-6z',                                                                      // bolt
  'M4 20l1-4.5L16.5 4 20 7.5 8.5 19zM14 6.5l3.5 3.5',                                                     // pencil
  'M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.3 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z',               // heart
  'M12 5v14M5 12h14',                                                                                     // plus
  'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',                                                                 // ring
  'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', // music note
  'M4 8h16M4 12h10M4 16h13',                                                                              // list
];

/** Where doodles may sit, in percent of the screen (top-left corner of each). Edges only: the middle and the dock stay clear. */
const SLOTS: Array<[number, number]> = [
  [3.5, 7], [10, 27], [3, 47], [9.5, 67], [4, 86],
  [91, 6], [85, 25], [92, 45], [86, 65], [91.5, 85],
  [20, 4.5], [74, 5.5], [21, 88], [73, 89],
];

/** Small repeatable random numbers, so a bot keeps its own arrangement. */
function rng(seed: string): () => number {
  let a = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The wallpaper as an SVG that fills whatever size it is given (__W__ and __H__ are filled in on the computer). */
function wallpaperSvg(p: Palette, seed: string): string {
  const rand = rng(seed);
  const order = DOODLES.map((d, i) => ({ d, k: rand(), i })).sort((a, b) => a.k - b.k);
  const doodles = SLOTS.map(([x, y], i) => {
    const d = order[i % order.length].d;
    const size = Math.round(38 + rand() * 26);
    const turn = Math.round((rand() - 0.5) * 50);
    const px = (x + (rand() - 0.5) * 2.4).toFixed(2), py = (y + (rand() - 0.5) * 2.4).toFixed(2);
    const opacity = (0.34 + rand() * 0.26).toFixed(2);
    return `<svg x="${px}%" y="${py}%" width="${size}" height="${size}" viewBox="0 0 24 24" overflow="visible"><path transform="rotate(${turn} 12 12)" d="${d}" fill="none" stroke="${p.line}" stroke-opacity="${opacity}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="__W__" height="__H__">`
    + `<defs>`
    + `<linearGradient id="hqw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.washLight}"/><stop offset="0.5" stop-color="${p.wash}"/><stop offset="1" stop-color="${p.washDeep}"/></linearGradient>`
    + `<radialGradient id="hqa"><stop offset="0" stop-color="${p.glow}" stop-opacity="0.6"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="hqb"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="hqc"><stop offset="0" stop-color="${p.glow2}" stop-opacity="0.65"/><stop offset="1" stop-color="${p.glow2}" stop-opacity="0"/></radialGradient>`
    + `</defs>`
    + `<rect width="100%" height="100%" fill="url(#hqw)"/>`
    + `<ellipse cx="12%" cy="6%" rx="46%" ry="52%" fill="url(#hqb)"/>`
    + `<ellipse cx="90%" cy="98%" rx="50%" ry="58%" fill="url(#hqa)"/>`
    + `<ellipse cx="82%" cy="12%" rx="30%" ry="36%" fill="url(#hqc)"/>`
    + `<ellipse cx="6%" cy="96%" rx="30%" ry="34%" fill="url(#hqc)"/>`
    + doodles
    + `</svg>`;
}

// ---------------------------------------------------------------- avatar

interface ShapeDef { viewBox: string; d: string; outline: string }
/** Older shape names the web app also maps onto the drawn set. */
const SHAPE_FALLBACK: Record<string, string> = {
  bean: 'teardrop', squircle: 'square', capsule: 'tablet', cylinder: 'tablet', gem: 'hex', crystal: 'hex',
  shield: 'house', dome: 'house', arch: 'house', leaf: 'teardrop',
};
let shapesCache: Record<string, ShapeDef> | null = null;

/** The avatar art lives in the web app; read it as text so the server needs no build step for it. */
function shapes(): Record<string, ShapeDef> {
  if (shapesCache) return shapesCache;
  shapesCache = {};
  try {
    const text = fs.readFileSync(new URL('../../web/src/avatar/shapes.gen.ts', import.meta.url), 'utf8');
    const start = text.indexOf('{', text.indexOf('SHAPES'));
    const end = text.lastIndexOf('}');
    if (start > 0 && end > start) shapesCache = JSON.parse(text.slice(start, end + 1)) as Record<string, ShapeDef>;
  } catch {
    warn('avatar shapes not found, using a plain circle');
  }
  return shapesCache;
}

function avatarSvg(shape: string, fill: string): string {
  const all = shapes();
  const def = all[shape] ?? all[SHAPE_FALLBACK[shape] ?? 'blob'] ?? all.blob;
  const safe = (s: string) => /^[\w\s.,\-+]*$/.test(s);
  if (!def || !safe(def.d) || !safe(def.outline) || !safe(def.viewBox)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#fff"/><circle cx="24" cy="24" r="19" fill="${fill}"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${def.viewBox}"><path d="${def.outline}" fill="#fff"/><path d="${def.d}" fill="${fill}" fill-rule="evenodd"/></svg>`;
}

// ---------------------------------------------------------------- the look of one screen

function lookFor(bot: DeskBot, manageChrome: boolean): { stamp: string; payload: string } {
  const hex = colorHex(bot.avatarColor);
  const p = paletteFor(hex);
  const look = {
    manageChrome,
    bot: { id: bot.id, name: bot.name, label: bot.label ?? '', avatarShape: bot.avatarShape, avatarColor: bot.avatarColor },
    colors: { accent: p.accent, ink: p.ink, wash: p.wash, washDeep: p.washDeep },
    avatarSvg: avatarSvg(bot.avatarShape, hex),
    wallSvg: wallpaperSvg(p, bot.id),
  };
  const stamp = sha(`${bundle().hash}\n${JSON.stringify(look)}`).slice(0, 20);
  return { stamp, payload: gzipSync(Buffer.from(JSON.stringify({ stamp, ...look }), 'utf8')).toString('base64') };
}

/** Calls for one screen run one after another, so a rename and a reset cannot trip over each other. */
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(screenId: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(screenId) ?? Promise.resolve()).then(work, work);
  const tail = next.catch(() => undefined);
  queues.set(screenId, tail);
  void tail.then(() => { if (queues.get(screenId) === tail) queues.delete(screenId); });
  return next;
}

async function dress(bot: DeskBot, screenId: string, manageChrome: boolean, flags: string, what: string): Promise<void> {
  if (!/^[\w.-]+$/.test(bot.id)) throw new Error(`bot id ${JSON.stringify(bot.id)} cannot be used as a folder name`);
  const n = displayNumber(screenId);
  if (!Number.isInteger(n)) throw new Error(`unknown screen ${screenId}`);
  const { stamp, payload } = lookFor(bot, manageChrome);
  const args = ['go', String(n), bundle().hash, stamp, flags || '-', payload];
  let reply = await script(args, screenId);
  if (reply.kind === 'NOBASE' || reply.kind === 'NONE') {
    basePromise = null;                 // whatever we knew about the computer is out of date
    await ensureDeskBase();
    reply = await script(args, screenId);
    if (reply.kind === 'NOBASE') throw new Error(`${what} failed: the desktop scripts on the computer do not run (${reply.raw.trim().slice(-200)})`);
  }
  await finish(reply, what, 240);
}

/** Make `screenId` look like `bot`'s computer. Idempotent and quick when nothing changed (keep a stamp on the box of what was applied so a repeat call is ~1 bash call). Options:
 *  - manageChrome (default true): start this bot's Chrome (own profile, own DevTools port, maximized, on its home screen) if it isn't running.
 *    false = this screen already has someone else's Chrome that must NEVER be started, killed or restarted by us (the primary bot's live browser); still do wallpaper, dock, hidden panel, light theme.
 *  - restartChrome (default false): restart our Chrome so it picks up a new look. Ignored when manageChrome is false. */
export function dressScreen(bot: DeskBot, screenId: string, opts?: { manageChrome?: boolean; restartChrome?: boolean }): Promise<void> {
  const manage = opts?.manageChrome !== false;
  return inTurn(screenId, () => dress(bot, screenId, manage, manage && opts?.restartChrome ? 'r' : '', `dressing screen ${screenId}`));
}

/** Back to a clean start: close every app window on the screen except the desktop pieces, then (if manageChrome) bring Chrome back on the home screen. Logins in the profile stay. */
export function resetScreen(bot: DeskBot, screenId: string, opts?: { manageChrome?: boolean }): Promise<void> {
  return inTurn(screenId, () => dress(bot, screenId, opts?.manageChrome !== false, 'x', `resetting screen ${screenId}`));
}

/** The bot is gone: stop its Chrome, dock and anything else we started for that screen (do not delete the Orgo screen itself, and leave the profile dir). */
export function undressScreen(botId: string, screenId: string): Promise<void> {
  return inTurn(screenId, async () => {
    if (botId && !/^[\w.-]+$/.test(botId)) throw new Error(`bot id ${JSON.stringify(botId)} cannot be used as a folder name`);
    const reply = await script(['undress', String(displayNumber(screenId)), botId], screenId, 90);
    // No scripts on the computer means nothing of ours runs there either.
    if (reply.kind === 'NOBASE' && !reply.raw.includes('Traceback')) return;
    if (reply.kind !== 'DONE') throw new Error(`undressing screen ${screenId} failed: ${reply.raw.trim().slice(-300)}`);
  });
}

/** Open a visible terminal window on that screen running `command` (window stays open after it exits, titled `title`). Used for sign-in flows the user completes by taking control of the screen. */
export async function openTerminal(screenId: string, command: string, title?: string): Promise<void> {
  await ensureDeskBase();
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const reply = await script(['terminal', String(displayNumber(screenId)), b64(command), title ? b64(title) : '-'], screenId);
  if (reply.kind !== 'DONE') throw new Error(`could not open a terminal on screen ${screenId}: ${reply.raw.trim().slice(-300)}`);
  await finish(reply, `opening a terminal on screen ${screenId}`, 30);
}
