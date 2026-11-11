/**
 * Dresses a few screens of the TEST computer for made-up bots and checks the result.
 *
 *   cd platform/server
 *   ORGO_COMPUTER_ID=<test computer id> npx tsx --env-file=../.env scripts/desk-test.ts
 *
 * What it does, in order:
 *   1. uses up to three extra screens (creates screens only when fewer than two exist)
 *   2. dresses each extra screen for its own bot with a managed Chrome, twice (first run and repeat)
 *   3. renames and recolours one bot and dresses again
 *   4. shrinks one Chrome so wallpaper and dock show, opens a terminal, then resets that screen
 *   5. default screen: managed Chrome once, undress, then with manageChrome:false (no Chrome of ours,
 *      any Chrome that is already there must keep running), terminal, reset
 *
 * It ends with every screen dressed. It never deletes a screen or the computer.
 *
 * Environment:
 *   DESK_SHOTS    folder for the screenshots (default: <tmp>/desk-test)
 *   DESK_SCREENS  how many extra screens to use, 1 to 3 (default: all that exist, at least 2)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../src/env.js';
import { orgo } from '../src/orgo.js';
import { box } from '../src/box.js';
import { cdpPortFor, dressScreen, ensureDeskBase, openTerminal, resetScreen, undressScreen, type DeskBot } from '../src/desk.js';

const SHOTS = process.env.DESK_SHOTS || path.join(os.tmpdir(), 'desk-test');
const EVAL = '/tmp/hq-desk-test-eval.py';

const EXTRA_BOTS: DeskBot[] = [
  { id: 'bot_mira', name: 'Mira', label: 'Research', avatarShape: 'flower', avatarColor: 'violet' },
  { id: 'bot_juno', name: 'Juno', label: 'Bookkeeping', avatarShape: 'cloud', avatarColor: 'orange' },
  { id: 'bot_otto', name: 'Otto', label: 'Inbox and calendar', avatarShape: 'star', avatarColor: 'green' },
];
const RENAMED: Partial<DeskBot> = { name: 'Otis', label: 'Support desk', avatarShape: 'gem', avatarColor: 'blue' };
const MAIN_BOT: DeskBot = { id: 'bot_ash', name: 'Ash', label: 'Chief of staff', avatarShape: 'blob', avatarColor: 'black' };

/** A tiny DevTools client for the box: evaluates one expression in the home page of the Chrome on a port. */
const EVAL_PY = String.raw`import base64, json, os, socket, struct, sys, urllib.request
port, expr = int(sys.argv[1]), sys.argv[2]
targets = json.load(urllib.request.urlopen('http://127.0.0.1:%d/json' % port, timeout=3))
home = [t for t in targets if t.get('url', '').startswith('http://127.0.0.1:7391/')]
if not home:
    print(json.dumps({'error': 'no home page', 'targets': [[t['type'], t['title'], t['url'][:60]] for t in targets]}))
    sys.exit(0)
ws_path = home[0]['webSocketDebuggerUrl'].split('/', 3)[3]
s = socket.create_connection(('127.0.0.1', port), timeout=5)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(('GET /%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
           'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (ws_path, port, key)).encode())
buf = b''
while b'\r\n\r\n' not in buf:
    buf += s.recv(4096)
buf = buf.split(b'\r\n\r\n', 1)[1]

def need(n):
    global buf
    while len(buf) < n:
        chunk = s.recv(65536)
        if not chunk:
            raise EOFError('socket closed')
        buf += chunk
    out, buf = buf[:n], buf[n:]
    return out

def send(obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    if len(data) < 126:
        head = bytes([0x81, 0x80 | len(data)])
    elif len(data) < 65536:
        head = bytes([0x81, 0x80 | 126]) + struct.pack('>H', len(data))
    else:
        head = bytes([0x81, 0x80 | 127]) + struct.pack('>Q', len(data))
    s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

def recv():
    data = b''
    while True:
        b0, b1 = need(2)
        n = b1 & 0x7f
        if n == 126:
            n = struct.unpack('>H', need(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', need(8))[0]
        payload = need(n)
        op = b0 & 0x0f
        if op == 8:
            raise EOFError('closed by Chrome')
        if op in (0, 1, 2):
            data += payload
            if b0 & 0x80:
                return json.loads(data)

send({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True}})
while True:
    msg = recv()
    if msg.get('id') == 1:
        print(json.dumps((msg.get('result') or {}).get('result', {}).get('value')))
        break
`;

// ---------- small helpers ----------

const timings: Record<string, number> = {};
let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => console.log(line);

function check(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try { return await fn(); } finally {
    timings[name] = Date.now() - t;
    say(`  .... ${name}: ${timings[name]} ms`);
  }
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, every = 500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

async function shot(screenId: string, name: string): Promise<string> {
  const r = await orgo.screenshot(env.orgoComputerId, screenId);
  const file = path.join(SHOTS, `${name}.${(r.mime_type ?? 'image/jpeg').includes('png') ? 'png' : 'jpg'}`);
  fs.writeFileSync(file, Buffer.from(r.image, 'base64'));
  say(`  shot ${file}  (${r.width}x${r.height})`);
  return file;
}

async function sh(command: string, screenId?: string, timeout = 30): Promise<string> {
  return (await box.bash(command, timeout, screenId)).output;
}

interface Browser { pid: number; profile: string; port: number; ours: boolean }

/** Every Chrome main process on the box (helpers such as renderers left out). */
async function browsers(): Promise<Browser[]> {
  const out = await sh(`for p in $(pgrep -x chrome); do c=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null); case "$c" in *--type=*) ;; *) echo "$p $c";; esac; done; true`);
  return out.split('\n').filter((l) => /^\d+ /.test(l)).map((l) => ({
    pid: Number(l.split(' ')[0]),
    profile: /--user-data-dir=(\S+)/.exec(l)?.[1] ?? '',
    port: Number(/--remote-debugging-port=(\d+)/.exec(l)?.[1] ?? 0),
    ours: l.includes('--hq-screen='),
  }));
}
const browserOf = (list: Browser[], botId: string) => list.find((b) => b.profile === `/root/grokbot/profiles/${botId}`);
const foreignPids = (list: Browser[]) => list.filter((b) => !b.ours).map((b) => b.pid).sort().join(',');

/** What the home page in the Chrome on `port` says. */
async function homePage(port: number): Promise<{ h1?: string; role?: string; apps?: number; error?: string } | null> {
  const expr = `({ h1: (document.querySelector('h1') || {}).innerText, role: (document.querySelector('.role') || {}).innerText, apps: document.querySelectorAll('#apps > *').length })`;
  const out = (await sh(`python3 ${EVAL} ${port} ${box.quote(expr)} 2>&1 | tail -1`)).trim();
  try { return JSON.parse(out); } catch { return { error: out.slice(-200) }; }
}
const greets = (port: number, name: string) => until(async () => ((await homePage(port))?.h1 === `Welcome back, ${name}` ? true : null), 12_000);

const windows = (screenId: string) => sh('wmctrl -l 2>/dev/null; true', screenId);
const look = async (screenId: string) => {
  const n = screenId === 'default' ? 99 : Number(screenId.replace('screen-', ''));
  const raw = await box.readFile(`/opt/hq/screens/${n}/look.json`);
  try { return raw ? JSON.parse(raw.toString('utf8')) : null; } catch { return null; }
};

// ---------- the run ----------

async function extraScreens(): Promise<string[]> {
  let screens = await orgo.listScreens(env.orgoComputerId);
  say(`screens now: ${screens.map((s) => `${s.id} ${s.width}x${s.height}`).join(', ')}`);
  const asked = Number(process.env.DESK_SCREENS || 0);
  const want = Math.min(3, Math.max(1, asked || Math.max(2, screens.filter((s) => !s.default).length)));
  while (screens.filter((s) => !s.default).length < want) {
    try {
      const made = await orgo.createScreen(env.orgoComputerId);
      say(`created ${made.id} (${made.width}x${made.height})`);
    } catch (e: any) {
      say(`could not create another screen: ${e?.message ?? e}`);
      break;
    }
    screens = await orgo.listScreens(env.orgoComputerId);
  }
  return screens.filter((s) => !s.default).map((s) => s.id).slice(0, want);
}

async function testExtras(ids: string[]): Promise<void> {
  const pairs = ids.map((id, i) => ({ id, bot: EXTRA_BOTS[i] }));

  say('\n== extra screens: clean start, then dress (Chrome start included)');
  await Promise.all(pairs.map((p) => undressScreen(p.bot.id, p.id)));
  await Promise.all(pairs.map((p) => timed(`first dress ${p.id} (${p.bot.name})`, () => dressScreen(p.bot, p.id))));
  let list = await browsers();
  const pids: Record<string, number> = {};
  for (const p of pairs) {
    const b = browserOf(list, p.bot.id);
    pids[p.id] = b?.pid ?? 0;
    check(!!b && b.port === cdpPortFor(p.id), `${p.id}: Chrome runs with ${p.bot.name}'s profile on port ${cdpPortFor(p.id)}`, b ? `pid ${b.pid}` : 'not running');
    check(!!(await greets(cdpPortFor(p.id), p.bot.name)), `${p.id}: home page greets ${p.bot.name}`, JSON.stringify(await homePage(cdpPortFor(p.id))));
    check((await look(p.id))?.bot?.name === p.bot.name, `${p.id}: recorded look is ${p.bot.name}'s`);
    await shot(p.id, `${p.id}-home-${p.bot.name.toLowerCase()}`);
  }

  say('\n== extra screens: dress again, nothing changed');
  for (const p of pairs) await timed(`repeat dress ${p.id}`, () => dressScreen(p.bot, p.id));
  list = await browsers();
  for (const p of pairs) {
    check(timings[`repeat dress ${p.id}`] < 3000, `${p.id}: repeat dress under 3 s`, `${timings[`repeat dress ${p.id}`]} ms`);
    check(browserOf(list, p.bot.id)?.pid === pids[p.id], `${p.id}: same Chrome as before`);
  }

  const last = pairs[pairs.length - 1];
  const again: DeskBot = { ...last.bot, ...RENAMED };
  say(`\n== ${last.id}: ${last.bot.name} becomes ${again.name} (${again.avatarColor} ${again.avatarShape})`);
  await timed(`redress ${last.id} after rename`, () => dressScreen(again, last.id));
  check(!!(await greets(cdpPortFor(last.id), again.name)), `${last.id}: open home page now greets ${again.name}`, JSON.stringify(await homePage(cdpPortFor(last.id))));
  check((await look(last.id))?.colors?.accent?.toUpperCase() === '#1E86FC', `${last.id}: colour is now blue`);
  await timed(`restart Chrome ${last.id}`, () => dressScreen(again, last.id, { restartChrome: true }));
  const fresh = browserOf(await browsers(), again.id);
  check(!!fresh && fresh.pid !== pids[last.id], `${last.id}: restartChrome gave a new Chrome`);
  check(!!(await greets(cdpPortFor(last.id), again.name)), `${last.id}: restarted Chrome greets ${again.name}`);
  await shot(last.id, `${last.id}-home-${again.name.toLowerCase()}-after-rename`);

  const first = pairs[0];
  say(`\n== ${first.id}: wallpaper and dock, terminal, reset`);
  await sh(`w=$(xdotool search --onlyvisible --class HQBrowser | head -1); wmctrl -i -r $w -b remove,maximized_vert,maximized_horz; sleep 0.4; xdotool windowsize $w 700 440 windowmove $w 300 70`, first.id);
  await sleep(1200);
  await shot(first.id, `${first.id}-wallpaper-and-dock`);
  await timed(`openTerminal ${first.id}`, () => openTerminal(first.id, `echo "Hello from ${first.bot.name}'s computer"; uname -sr; date`, 'Sign in'));
  check(!!(await until(async () => (await windows(first.id)).includes('Sign in'), 6000)), `${first.id}: terminal window "Sign in" is open`);
  await sleep(800);
  await shot(first.id, `${first.id}-terminal`);
  await timed(`reset ${first.id}`, () => resetScreen(first.bot, first.id));
  check(!(await windows(first.id)).includes('Sign in'), `${first.id}: reset closed the terminal`);
  check(!!(await greets(cdpPortFor(first.id), first.bot.name)), `${first.id}: Chrome is back on the home screen`);
  await sleep(800);
  await shot(first.id, `${first.id}-after-reset`);

  say('\n== screens do not share state');
  list = await browsers();
  const profiles = pairs.map((p) => browserOf(list, p.bot.id)?.profile).filter(Boolean);
  check(new Set(profiles).size === pairs.length, 'every screen has its own Chrome profile', profiles.join(' '));
  for (const p of pairs) {
    const name = p === last ? again.name : p.bot.name;
    check((await homePage(cdpPortFor(p.id)))?.h1 === `Welcome back, ${name}`, `${p.id} still greets ${name}`);
  }
}

async function testDefault(): Promise<void> {
  const before = await browsers();
  const others = foreignPids(before);
  say(`\n== default screen with a managed Chrome  (Chromes that are not ours: ${others || 'none'})`);
  await undressScreen(MAIN_BOT.id, 'default');
  await sleep(500);
  await shot('default', 'default-undressed');
  await timed('first dress default (managed)', () => dressScreen(MAIN_BOT, 'default', { manageChrome: true }));
  const mine = browserOf(await browsers(), MAIN_BOT.id);
  check(!!mine && mine.port === cdpPortFor('default'), `default: Chrome runs with ${MAIN_BOT.name}'s profile on port ${cdpPortFor('default')}`);
  check(!!(await greets(cdpPortFor('default'), MAIN_BOT.name)), `default: home page greets ${MAIN_BOT.name}`);
  await sh('w=$(xdotool search --onlyvisible --class HQBrowser | head -1); [ -n "$w" ] && xdotool windowactivate $w; true', 'default');
  await sleep(800);
  await shot('default', 'default-managed-home');
  check(foreignPids(await browsers()) === others, 'default: Chromes that are not ours were left alone');

  say('\n== default screen undressed: the original desktop is back');
  await timed('undress default', () => undressScreen(MAIN_BOT.id, 'default'));
  check(!browserOf(await browsers(), MAIN_BOT.id), 'default: our Chrome is gone');
  check((await look('default')) === null, 'default: nothing recorded for the screen');
  await sleep(1000);
  await shot('default', 'default-after-undress');

  say('\n== default screen with manageChrome:false');
  await timed('first dress default (not managed)', () => dressScreen(MAIN_BOT, 'default', { manageChrome: false }));
  await timed('repeat dress default (not managed)', () => dressScreen(MAIN_BOT, 'default', { manageChrome: false }));
  let now = await browsers();
  check(!browserOf(now, MAIN_BOT.id), 'default: no Chrome of ours was started');
  check(foreignPids(now) === others, 'default: Chromes that are not ours were left alone', foreignPids(now) || 'none');
  const guest = now.find((b) => !b.ours && b.port);
  let guestTab = '';
  if (guest) {
    // A Chrome we do not own gets this screen's page because of the display it runs on.
    const made = await sh(`curl -s -m 5 -X PUT 'http://127.0.0.1:${guest.port}/json/new?chrome://newtab/'; true`);
    try { guestTab = String(JSON.parse(made).id ?? ''); } catch { /* shown by the check below */ }
    check(!!(await greets(guest.port, MAIN_BOT.name)), `default: the other Chrome (port ${guest.port}) shows ${MAIN_BOT.name}'s home page in a new tab`, JSON.stringify(await homePage(guest.port)));
  }
  await sleep(800);
  await shot('default', 'default-unmanaged');
  if (guest && /^[0-9A-F]+$/i.test(guestTab)) await sh(`curl -s -m 5 'http://127.0.0.1:${guest.port}/json/close/${guestTab}' >/dev/null; true`);
  await sh('for w in $(xdotool search --onlyvisible --class chrome 2>/dev/null); do xdotool windowminimize $w; done; true', 'default');
  await sleep(1000);
  await shot('default', 'default-wallpaper-and-dock');
  await timed('openTerminal default', () => openTerminal('default', 'echo "Sign in here"; uname -sr', 'Sign in'));
  check(!!(await until(async () => (await windows('default')).includes('Sign in'), 6000)), 'default: terminal window "Sign in" is open');
  await sleep(800);
  await shot('default', 'default-terminal');
  await timed('reset default (not managed)', () => resetScreen(MAIN_BOT, 'default', { manageChrome: false }));
  now = await browsers();
  check(!(await windows('default')).includes('Sign in'), 'default: reset closed the terminal');
  check(foreignPids(now) === others, 'default: reset left the other Chromes running', foreignPids(now) || 'none');
  check(!browserOf(now, MAIN_BOT.id), 'default: reset did not start a Chrome');
  await sh('for w in $(xdotool search --class chrome 2>/dev/null); do xdotool windowactivate $w 2>/dev/null; done; true', 'default');
  await sleep(1000);
  await shot('default', 'default-after-reset');
}

async function main(): Promise<void> {
  if (box.local) throw new Error('this test drives a remote test computer through Orgo; run it without HQ_LOCAL');
  if (!env.orgoComputerId) throw new Error('set ORGO_COMPUTER_ID to the test computer');
  fs.mkdirSync(SHOTS, { recursive: true });
  say(`test computer ${env.orgoComputerId}, screenshots in ${SHOTS}`);

  const ids = await extraScreens();
  if (!ids.length) throw new Error('no extra screen to work with');
  await timed('ensureDeskBase', () => ensureDeskBase());
  await timed('ensureDeskBase again', () => ensureDeskBase());
  await box.writeFile(EVAL, EVAL_PY);

  await testExtras(ids);
  await testDefault();

  say('\n== timings (ms)');
  for (const [k, v] of Object.entries(timings)) say(`  ${String(v).padStart(6)}  ${k}`);
  say(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(`desk-test stopped: ${e?.stack ?? e}`); process.exit(2); });
