import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from './env.js';

/**
 * The "local" computer: this server runs on the bots' machine itself (a Zo server, a VPS, a spare box)
 * and plays Orgo's part. Each screen is an Xvfb display with a window manager, an x11vnc server and a
 * websockify bridge in front of it, all on 127.0.0.1. Screen ids follow Orgo's: "default" is :99,
 * "screen-100" is :100, so the rest of the app (desk.ts, the CDP ports) cannot tell the difference.
 *
 *   display :N  ->  x11vnc on 5900+N  ->  websockify on 6900+N  ->  vnc.ts relay  ->  browser
 */

const DIR = env.localScreensDir;
const DEFAULT_DISPLAY = 99;
const [W, H] = env.localScreenSize.split('x').map(Number);

const idFor = (n: number) => (n === DEFAULT_DISPLAY ? 'default' : `screen-${n}`);
const numFor = (id?: string) => (!id || id === 'default' ? DEFAULT_DISPLAY : Number(id.replace('screen-', '')));
const vncPort = (n: number) => 5900 + n;
const wsPort = (n: number) => 6900 + n;

function sh(command: string, timeoutSec = 30, display?: number): Promise<{ output: string; exit_code: number }> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], {
      timeout: timeoutSec * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(display !== undefined ? { DISPLAY: `:${display}` } : {}) },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });

/** The VNC password (x11vnc keeps only 8 characters). Made once, kept in DIR, never sent to the browser. */
let pw: string | null = null;
async function password(): Promise<string> {
  if (pw) return pw;
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = `${DIR}/vnc.pass`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(6).toString('base64url').slice(0, 8), { mode: 0o600 });
  pw = fs.readFileSync(file, 'utf8').trim();
  if (!fs.existsSync(`${DIR}/vnc.rfbauth`)) await sh(`x11vnc -storepasswd ${pw} ${DIR}/vnc.rfbauth >/dev/null 2>&1`, 15);
  return pw;
}

const alive = async (n: number) => (await sh(`xdpyinfo -display :${n} >/dev/null 2>&1`, 10)).exit_code === 0;

/** Bring display :n up with everything a screen needs. Idempotent: running pieces are left alone. */
async function startDisplay(n: number): Promise<void> {
  await password();
  // Each piece is started detached and its pid kept in DIR/<piece>-N.pid; a live pid means "running".
  // (Matching command lines with pgrep -f would also match this very script, which names them.)
  // setsid makes each piece its own process group, so stopping one kills the group (xfwm4's D-Bus too).
  // xfwm4 needs a session bus for its settings (Xfconf), hence dbus-run-session.
  const script = `
set -u
cd ${DIR}
up() { [ -f "$1-${n}.pid" ] && kill -0 "$(cat "$1-${n}.pid")" 2>/dev/null; }
start() { local name=$1; shift; setsid nohup "$@" >"$name-${n}.log" 2>&1 & echo $! >"$name-${n}.pid"; }
if ! xdpyinfo -display :${n} >/dev/null 2>&1; then
  rm -f /tmp/.X${n}-lock /tmp/.X11-unix/X${n}
  start xvfb Xvfb :${n} -screen 0 ${W}x${H}x24 -nolisten tcp
  for i in $(seq 50); do xdpyinfo -display :${n} >/dev/null 2>&1 && break; sleep 0.1; done
fi
xdpyinfo -display :${n} >/dev/null 2>&1 || { echo "Xvfb :${n} did not start"; exit 1; }
if ! up wm; then
  if command -v xfwm4 >/dev/null; then NO_AT_BRIDGE=1 start wm dbus-run-session -- xfwm4 --display=:${n} --compositor=off --sm-client-disable
  elif command -v openbox >/dev/null; then start wm openbox --display :${n}
  fi
fi
up vnc || start vnc x11vnc -display :${n} -rfbport ${vncPort(n)} -localhost -rfbauth ${DIR}/vnc.rfbauth -forever -shared -noxdamage -quiet
up ws || start ws websockify 127.0.0.1:${wsPort(n)} 127.0.0.1:${vncPort(n)}
for i in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/${wsPort(n)}) 2>/dev/null && { echo ok; exit 0; }; sleep 0.1; done
echo "the VNC bridge for :${n} did not come up (see ${DIR})"; exit 1
`;
  const r = await sh(script, 40);
  if (r.exit_code !== 0) throw new Error(r.output.trim().slice(-300) || `could not start display :${n}`);
}

async function stopDisplay(n: number): Promise<void> {
  if (n === DEFAULT_DISPLAY) return; // the main screen stays
  await sh(`cd ${DIR} && for p in ws vnc wm xvfb; do [ -f $p-${n}.pid ] && kill -- -$(cat $p-${n}.pid) 2>/dev/null; rm -f $p-${n}.pid; done; true`, 15);
}

const screen = (n: number) => ({ id: idFor(n), display: `:${n}`, width: W, height: H, default: n === DEFAULT_DISPLAY });

/** The last display a screen may use: one per bot, the default screen included. */
const lastDisplay = () => DEFAULT_DISPLAY + Math.max(1, env.maxBots) - 1;

async function computer() {
  await startDisplay(DEFAULT_DISPLAY);
  return { id: env.orgoComputerId, status: 'running', name: 'local', resolution: `${W}x${H}`, asleep: null };
}

async function listScreens() {
  const out = [];
  for (let n = DEFAULT_DISPLAY; n <= lastDisplay(); n++) if (await alive(n)) out.push(screen(n));
  return out;
}

const xdo = (n: number, args: string) => sh(`xdotool ${args}`, 15, n).then(() => ({ ok: true }));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Same shape as the Orgo client in orgo.ts, so either can stand behind `orgo`. */
export const local = {
  workspaces: async () => ({ workspaces: [{ id: 'local', name: 'local' }] }),

  getComputer: (_id: string) => computer(),
  start: (_id: string) => computer(),
  resume: (_id: string) => computer(),
  suspend: async (_id: string) => ({ ok: true }),
  vncPassword: async (_id: string) => ({ password: await password(), desktop_api_token: '' }),
  /** Where vnc.ts connects for this screen's RFB stream. */
  vncUrl: (_id: string, screenId: string, _password: string) => `ws://127.0.0.1:${wsPort(numFor(screenId))}`,

  listScreens: (_id: string) => listScreens(),
  createScreen: async (_id: string) => {
    for (let n = DEFAULT_DISPLAY + 1; n <= lastDisplay(); n++) {
      if (await alive(n)) continue;
      await startDisplay(n);
      return screen(n);
    }
    throw new Error(`every display from :${DEFAULT_DISPLAY + 1} to :${lastDisplay()} is in use`);
  },
  getScreen: async (_id: string, screenId: string) => {
    const n = numFor(screenId);
    if (!(await alive(n))) throw notFound(`screen ${screenId}`);
    await startDisplay(n); // the display is up; make sure its VNC pieces are too
    return screen(n);
  },
  deleteScreen: async (_id: string, screenId: string) => { await stopDisplay(numFor(screenId)); },

  screenshot: async (_id: string, screenId?: string) => {
    const n = numFor(screenId);
    const r = await sh(`import -display :${n} -window root -quality 75 jpeg:- | base64 -w0`, 30);
    if (r.exit_code !== 0 || !r.output) throw new Error(`screenshot of :${n} failed`);
    return { image: r.output.trim(), mime_type: 'image/jpeg', width: W, height: H };
  },
  click: (_id: string, s: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) =>
    xdo(numFor(s), `mousemove ${b.x} ${b.y} click ${b.double ? '--repeat 2 ' : ''}${b.button === 'right' ? 3 : b.button === 'middle' ? 2 : 1}`),
  move: (_id: string, s: string | undefined, b: { x: number; y: number }) => xdo(numFor(s), `mousemove ${b.x} ${b.y}`),
  drag: (_id: string, s: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) =>
    xdo(numFor(s), `mousemove ${b.start_x} ${b.start_y} mousedown 1 mousemove ${b.end_x} ${b.end_y} mouseup 1`),
  type: (_id: string, s: string | undefined, text: string) => xdo(numFor(s), `type -- ${q(text)}`),
  key: (_id: string, s: string | undefined, key: string) => xdo(numFor(s), `key -- ${q(key)}`),
  scroll: (_id: string, s: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) =>
    xdo(numFor(s), `mousemove ${b.x} ${b.y} click --repeat ${Math.max(1, b.amount)} ${b.direction === 'up' ? 4 : 5}`),
  bash: async (_id: string, s: string | undefined, command: string, timeout = 120) => {
    const r = await sh(command, timeout, numFor(s));
    return { success: r.exit_code === 0, output: r.output, exit_code: r.exit_code };
  },
  /** Not needed locally: the Library serves files straight from disk when the box is local. */
  exportFile: async (_id: string, _path: string): Promise<{ url?: string; file?: { id: string; url?: string; filename?: string }; [k: string]: unknown }> => {
    throw new Error('file export is served from disk on a local computer');
  },
};
