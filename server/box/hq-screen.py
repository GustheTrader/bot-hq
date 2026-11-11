#!/usr/bin/env python3
"""hq-screen: makes X display :N look like one bot's own computer, and undoes it.

Called by the server (server/src/desk.ts) with one short command per action. Slow work runs in a
detached job; the caller gets `HQ_DONE {json}` when the job finishes within the wait, else
`HQ_RUNNING <job>` and asks again with `wait`.

  go N BASE STAMP FLAGS LOOK     dress screen N (FLAGS: letters r=restart Chrome, x=reset windows)
  wait JOB SECONDS               keep waiting for a job
  base-check BASE                is the one-time machine setup current?
  base BASE                      run the one-time machine setup (as a job)
  undress N BOT                  stop what we run on screen N
  terminal N CMD_B64 TITLE_B64   open a terminal window running a command
  launch N APP                   start an app on screen N (also: browser, terminal, files)
"""
import base64
import fcntl
import glob
import gzip
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import traceback
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hqlib  # noqa: E402
from hqlib import ROOT, JOBS, EXT, LOGS  # noqa: E402

POLICY_DIRS = ('/etc/opt/chrome/policies/managed', '/etc/chromium/policies/managed')
POLICY_NAME = 'hq.json'
GTK_SETTINGS = os.path.expanduser('~/.config/gtk-3.0/settings.ini')


class Fatal(Exception):
    """The screen would be unusable; the caller should hear about it."""


def log(*parts):
    os.makedirs(LOGS, exist_ok=True)
    with open(LOGS + '/screen.log', 'a') as f:
        f.write('%s [%d] %s\n' % (time.strftime('%F %T'), os.getpid(), ' '.join(str(p) for p in parts)))


# ---------------------------------------------------------------- jobs

def start_job(name, argv):
    os.makedirs(JOBS, exist_ok=True)
    now = time.time()
    for old in os.listdir(JOBS):
        full = os.path.join(JOBS, old)
        try:
            if old.endswith('.json') and now - os.path.getmtime(full) > 3600:
                os.unlink(full)
        except OSError:
            pass
    job = '%s-%d-%d' % (name, int(now * 1000), os.getpid())
    env = dict(os.environ)
    env.pop('HQ_SCREEN', None)
    os.makedirs(LOGS, exist_ok=True)
    out = open(LOGS + '/jobs.log', 'ab')
    subprocess.Popen([sys.executable, os.path.abspath(__file__), '_job', job, name] + argv, env=env,
                     stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True, close_fds=True)
    return job


def wait_job(job, seconds):
    path = '%s/%s.json' % (JOBS, job)
    end = time.time() + seconds
    while True:
        if os.path.exists(path):
            print('HQ_DONE ' + (hqlib.read_text(path) or '{}').strip())
            return
        if time.time() >= end:
            print('HQ_RUNNING ' + job)
            return
        time.sleep(0.15)


def run_job(job, name, argv):
    """Body of a detached job: one at a time per name, result written where the caller looks for it."""
    result = {'ok': True, 'warnings': []}
    started = time.time()
    lock = open('%s/%s.lock' % (JOBS, name), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if name == 'base':
            result.update(do_base(argv[0], result['warnings']))
        elif name.startswith('dress-'):
            result.update(do_dress(int(argv[0]), argv[1], argv[2], result['warnings']))
        else:
            raise Fatal('unknown job %s' % name)
    except Fatal as e:
        result.update(ok=False, error=str(e))
    except Exception as e:  # a bug or an odd machine: report it as a failure with the trace in the log
        log('job %s crashed:\n%s' % (job, traceback.format_exc()))
        result.update(ok=False, error='%s: %s' % (type(e).__name__, e))
    result['seconds'] = round(time.time() - started, 2)
    log('job %s finished: ok=%s %.1fs warnings=%s %s' % (job, result['ok'], result['seconds'], result['warnings'],
                                                      result.get('error', '')))
    hqlib.write_atomic('%s/%s.json' % (JOBS, job), json.dumps(result))


# ---------------------------------------------------------------- one-time machine setup

def home_alive():
    pid = hqlib.read_text(ROOT + '/home.pid', '').strip()
    return pid.isdigit() and hqlib.alive(int(pid)) and any('hq-home.py' in a for a in hqlib.cmdline(int(pid)))


def start_home(restart=False):
    if restart:
        hqlib.stop_pids([p for p in hqlib.all_pids() if any(a.endswith('hq-home.py') for a in hqlib.cmdline(p))], grace=2)
    elif home_alive():
        return True
    env = hqlib.base_env(99)
    for key in ('HQ_SCREEN', 'DISPLAY', 'GTK_THEME'):
        env.pop(key, None)
    hqlib.spawn([sys.executable, ROOT + '/hq-home.py'], env, 'home')
    end = time.time() + 8
    while time.time() < end:
        try:
            urllib.request.urlopen(hqlib.HOME_URL + '/health', timeout=1).read()
            return True
        except Exception:
            time.sleep(0.2)
    return False


def gtk_works():
    code, _ = hqlib.run([sys.executable, '-c',
                         "import gi; gi.require_version('Gtk','3.0'); gi.require_version('GdkPixbuf','2.0'); "
                         "from gi.repository import Gtk, Gdk, GdkPixbuf; import cairo"],
                        env={k: v for k, v in hqlib.base_env(99).items() if k not in ('DISPLAY', 'HQ_SCREEN')}, timeout=20)
    return code == 0


def missing_packages():
    want = []
    if not gtk_works():
        want += ['python3-gi', 'python3-gi-cairo', 'gir1.2-gtk-3.0']
    if not glob.glob('/usr/lib/*/gdk-pixbuf-2.0/*/loaders/libpixbufloader[-_]svg.so'):
        want.append('librsvg2-common')
    if not shutil.which('wmctrl'):
        want.append('wmctrl')
    if not shutil.which('xdotool'):
        want.append('xdotool')
    if not shutil.which('xprop') or not shutil.which('xdpyinfo'):
        want.append('x11-utils')
    if not shutil.which('xsetroot'):
        want.append('x11-xserver-utils')
    if not shutil.which('dbus-daemon'):
        want.append('dbus')
    if not shutil.which('openssl'):
        want.append('openssl')
    if not glob.glob('/usr/share/fonts/*/inter*') and not glob.glob('/usr/share/fonts/*/Inter*'):
        want.append('fonts-inter')
    return want


def install_packages(warnings):
    want = missing_packages()
    if not want:
        return []
    if not shutil.which('apt-get'):
        warnings.append('missing packages and no apt on this computer: %s' % ' '.join(want))
        return []
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='a')
    cmd = ['apt-get', 'install', '-y', '-qq', '--no-install-recommends', '-o', 'Dpkg::Use-Pty=0',
           '-o', 'DPkg::Lock::Timeout=60'] + want
    log('installing packages:', ' '.join(want))
    code, out = hqlib.run(cmd, env=env, timeout=300)
    if code != 0:
        hqlib.run(['apt-get', 'update', '-qq'], env=env, timeout=180)
        code, out = hqlib.run(cmd, env=env, timeout=300)
    if code != 0:
        # One bad package must not block the rest.
        for pkg in want:
            hqlib.run(cmd[:-len(want)] + [pkg], env=env, timeout=180)
    still = missing_packages()
    if still:
        warnings.append('could not install: %s (%s)' % (' '.join(still), out.strip().splitlines()[-1][:160] if out.strip() else 'apt failed'))
    if 'fonts-inter' in want and 'fonts-inter' not in still:
        hqlib.run(['fc-cache', '-f'], timeout=60)
    return [p for p in want if p not in still]


def _varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _field(number, data):
    return _varint((number << 3) | 2) + _varint(len(data)) + data


def build_extension(warnings):
    """Pack the new-tab extension as a signed CRX3 with a key that never leaves this computer."""
    src = EXT + '/src'
    key = EXT + '/key.pem'
    state_path = EXT + '/state.json'
    state = hqlib.read_json(state_path) or {}
    if not shutil.which('openssl'):
        warnings.append('openssl is missing, so the home screen extension cannot be packed')
        return state
    if not os.path.exists(key):
        code, out = hqlib.run(['openssl', 'genrsa', '-out', key, '2048'], timeout=60)
        if code != 0:
            warnings.append('could not create the extension key: %s' % out.strip()[:120])
            return state
        os.chmod(key, 0o600)
    der = subprocess.run(['openssl', 'rsa', '-in', key, '-pubout', '-outform', 'DER'], stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout
    if not der:
        warnings.append('could not read the extension key')
        return state
    digest = hashlib.sha256(der).digest()
    ext_id = ''.join(chr(97 + (b >> 4)) + chr(97 + (b & 15)) for b in digest[:16])
    names = sorted(os.listdir(src))
    content = hashlib.sha256()
    for name in names:
        content.update(name.encode() + b'\0' + open(os.path.join(src, name), 'rb').read() + b'\0')
    src_hash = content.hexdigest()
    if state.get('hash') == src_hash and state.get('id') == ext_id and os.path.exists(EXT + '/home.crx'):
        return state
    build = int(state.get('build') or 0) + 1
    version = '1.0.%d' % build
    packed = io.BytesIO()
    with zipfile.ZipFile(packed, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in names:
            data = open(os.path.join(src, name), 'rb').read()
            if name == 'manifest.json':
                manifest = json.loads(data.decode('utf-8'))
                manifest['version'] = version
                data = json.dumps(manifest, indent=2).encode('utf-8')
            z.writestr(zipfile.ZipInfo(name, (2024, 1, 1, 0, 0, 0)), data)
    archive = packed.getvalue()
    signed_data = _field(1, digest[:16])
    to_sign = b'CRX3 SignedData\x00' + struct.pack('<I', len(signed_data)) + signed_data + archive
    signature = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key], input=to_sign, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=30).stdout
    if not signature:
        warnings.append('could not sign the home screen extension')
        return state
    header = _field(2, _field(1, der) + _field(2, signature)) + _field(10000, signed_data)
    hqlib.write_atomic(EXT + '/home.crx', b'Cr24' + struct.pack('<II', 3, len(header)) + header + archive)
    hqlib.write_atomic(EXT + '/updates.xml', (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n    <updatecheck codebase='%s/ext/home.crx' version='%s' />\n  </app>\n</gupdate>\n"
        % (ext_id, hqlib.HOME_URL, version)))
    state = {'id': ext_id, 'hash': src_hash, 'build': build, 'version': version}
    hqlib.write_json(state_path, state)
    log('packed extension', ext_id, version)
    return state


def write_policy(ext_id, warnings):
    """Machine-wide: every Chrome on this computer gets the home screen extension."""
    policy = {
        'ExtensionInstallForcelist': ['%s;%s/ext/updates.xml' % (ext_id, hqlib.HOME_URL)],
        'NTPFooterExtensionAttributionEnabled': False,
        'NTPFooterManagementNoticeEnabled': False,
        'CommandLineFlagSecurityWarningsEnabled': False,
        # 1 = DevTools may attach everywhere. Without it Chrome refuses to let a DevTools client
        # (the bot's browser driver) talk to a tab that shows a policy-installed extension page,
        # which is exactly what the home screen is: the tab accepts the connection and never answers.
        'DeveloperToolsAvailability': 1,
    }
    text = json.dumps(policy, indent=2) + '\n'
    wrote = []
    for folder in POLICY_DIRS:
        if folder != POLICY_DIRS[0] and not os.path.isdir(os.path.dirname(os.path.dirname(folder))):
            continue
        path = os.path.join(folder, POLICY_NAME)
        try:
            if hqlib.read_text(path) != text:
                hqlib.write_atomic(path, text)
            wrote.append(path)
        except OSError as e:
            warnings.append('could not write Chrome policy %s: %s' % (path, e))
    return wrote


def write_gtk_settings(warnings):
    """Machine-wide (for this user): GTK apps start light instead of dark."""
    wanted = {
        'gtk-theme-name': hqlib.light_theme(),
        'gtk-icon-theme-name': hqlib.icon_theme(),
        'gtk-application-prefer-dark-theme': '0',
    }
    try:
        lines = (hqlib.read_text(GTK_SETTINGS) or '[Settings]\n').splitlines()
        if not os.path.exists(GTK_SETTINGS + '.before-hq') and os.path.exists(GTK_SETTINGS):
            shutil.copy2(GTK_SETTINGS, GTK_SETTINGS + '.before-hq')
        out, seen = [], set()
        for line in lines:
            key = line.split('=', 1)[0].strip()
            if key in wanted:
                out.append('%s=%s' % (key, wanted[key]))
                seen.add(key)
            else:
                out.append(line)
        if not any(l.strip() == '[Settings]' for l in out):
            out.insert(0, '[Settings]')
        out += ['%s=%s' % (k, v) for k, v in wanted.items() if k not in seen]
        text = '\n'.join(out) + '\n'
        if hqlib.read_text(GTK_SETTINGS) != text:
            hqlib.write_atomic(GTK_SETTINGS, text)
    except OSError as e:
        warnings.append('could not write %s: %s' % (GTK_SETTINGS, e))


def do_base(base_hash, warnings):
    os.makedirs(ROOT + '/screens', exist_ok=True)
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(hqlib.PROFILES, exist_ok=True)
    installed = install_packages(warnings)
    shell_ok = gtk_works()
    if not shell_ok:
        warnings.append('GTK for Python is not available, so screens get a plain colour and no dock')
    state = build_extension(warnings)
    policy_files = write_policy(state['id'], warnings) if state.get('id') else []
    write_gtk_settings(warnings)
    if not start_home(restart=True):
        warnings.append('the home screen server did not start (see %s/home.log)' % LOGS)
    # Desktop pieces that are already up run the old code; bring them back on the new one.
    for pid in [p for p in hqlib.all_pids() if any(a.endswith('hq-shell.py') for a in hqlib.cmdline(p))]:
        args = hqlib.cmdline(pid)
        hqlib.stop_pids([pid], grace=2)
        if shell_ok and args[-1].isdigit() and hqlib.look_for(int(args[-1])):
            hqlib.spawn([sys.executable, ROOT + '/hq-shell.py', args[-1]], hqlib.screen_env(int(args[-1])), 'shell-' + args[-1])
    hqlib.write_json(ROOT + '/base.json', {'hash': base_hash, 'shell': shell_ok, 'extension': state.get('id'),
                                           'policy': policy_files, 'installed': installed, 'at': int(time.time())})
    return {'installed': installed, 'policy': policy_files, 'extension': state.get('id'), 'shell': shell_ok}


def base_current(base_hash):
    return (hqlib.read_json(ROOT + '/base.json') or {}).get('hash') == base_hash


# ---------------------------------------------------------------- dressing a screen

def shell_pids(n):
    return [p for p in hqlib.all_pids() if hqlib.cmdline(p)[-2:] == [ROOT + '/hq-shell.py', str(n)]]


def ensure_shell(n, stamp, warnings):
    if not (hqlib.read_json(ROOT + '/base.json') or {}).get('shell'):
        return False
    state_path = hqlib.screen_dir(n) + '/shell.json'
    pids = shell_pids(n)
    if len(pids) > 1:
        hqlib.stop_pids(pids[1:], grace=2)
        pids = pids[:1]
    if not pids:
        try:
            os.unlink(state_path)
        except OSError:
            pass
        hqlib.spawn([sys.executable, ROOT + '/hq-shell.py', str(n)], hqlib.screen_env(n), 'shell-%d' % n)
    end = time.time() + 12
    while time.time() < end:
        state = hqlib.read_json(state_path) or {}
        if state.get('stamp') == stamp and hqlib.alive(state.get('pid')):
            return True
        time.sleep(0.15)
    warnings.append('the wallpaper and dock did not come up on screen %d (see %s/shell-%d.log)' % (n, LOGS, n))
    return False


THEME_PROPS = ('/Net/ThemeName', '/Net/IconThemeName')


def light_session(n, env, warnings):
    """Where a settings daemon runs, switch its theme to light so every GTK app follows.
    What was set before is kept in theme.json so undressing can put it back."""
    if not hqlib.display_procs(n, ('xfsettingsd',)) or not shutil.which('xfconf-query'):
        return
    saved_path = hqlib.screen_dir(n) + '/theme.json'
    before = {}
    for prop, value in zip(THEME_PROPS, (hqlib.light_theme(), hqlib.icon_theme())):
        code, current = hqlib.run(['xfconf-query', '-c', 'xsettings', '-p', prop], env=env)
        before[prop] = current.strip() if code == 0 else None
        if code != 0 or current.strip() != value:
            c, out = hqlib.run(['xfconf-query', '-c', 'xsettings', '-p', prop, '-n', '-t', 'string', '-s', value], env=env)
            if c != 0:
                warnings.append('could not switch %s to %s on screen %d: %s' % (prop, value, n, out.strip()[:100]))
    if hqlib.read_json(saved_path) is None:
        hqlib.write_json(saved_path, before)


def restore_session(n, env):
    saved_path = hqlib.screen_dir(n) + '/theme.json'
    saved = hqlib.read_json(saved_path)
    if saved is None:
        return
    if hqlib.display_procs(n, ('xfsettingsd',)) and shutil.which('xfconf-query'):
        for prop, value in saved.items():
            if value:
                hqlib.run(['xfconf-query', '-c', 'xsettings', '-p', prop, '-n', '-t', 'string', '-s', value], env=env)
    try:
        os.unlink(saved_path)
    except OSError:
        pass


def close_windows(n, keep_browsers):
    """Close every app window on the screen. Desktop pieces stay; so do browsers when they are not ours."""
    env = hqlib.base_env(n)

    def targets():
        wins = [w for w in hqlib.windows(n) if not hqlib.is_desktop_piece(w)]
        return [w for w in wins if not (keep_browsers and hqlib.is_browser_window(w))]

    wins = targets()
    for w in wins:
        if shutil.which('wmctrl'):
            hqlib.run(['wmctrl', '-i', '-c', w['id']], env=env, timeout=5)
    end = time.time() + 2.5
    while wins and time.time() < end:
        time.sleep(0.25)
        wins = targets()
    protected = {os.getpid(), os.getppid(), 1}
    for w in wins:      # did not close when asked nicely
        pid = w['pid']
        if pid > 1 and pid not in protected and hqlib.display_number(hqlib.environ_of(pid).get('DISPLAY')) == n:
            hqlib.stop_pids([pid], grace=1.5)
        else:
            hqlib.run(['xdotool', 'windowkill', str(int(w['id'], 16))], env=env, timeout=5)
    return len(targets())


def do_dress(n, flags, look_b64, warnings):
    look = json.loads(gzip.decompress(base64.b64decode(look_b64)).decode('utf-8'))
    stamp = look['stamp']
    bot = look['bot']
    manage = bool(look.get('manageChrome'))
    restart, reset = 'r' in flags, 'x' in flags
    folder = hqlib.screen_dir(n)
    timings = {}
    t = time.time()

    def lap(name):
        nonlocal t
        timings[name] = round(time.time() - t, 2)
        t = time.time()

    if not reset and not restart and screen_ok(n, stamp, manage, bot['id']):
        return {'already': True}
    size = hqlib.geometry(n)
    if not size:
        raise Fatal('screen %d does not answer (X display :%d is not running)' % (n, n))
    os.makedirs(folder, exist_ok=True)
    previous = hqlib.look_for(n)
    if previous and previous.get('manageChrome') and (previous.get('bot') or {}).get('id') not in (None, bot['id']):
        hqlib.stop_browser(previous['bot']['id'])
    try:
        os.unlink(folder + '/stamp.json')
    except OSError:
        pass
    hqlib.write_json(folder + '/look.json', look)
    env = hqlib.screen_env(n)
    colors = look.get('colors') or {}
    if shutil.which('xsetroot'):
        hqlib.run(['xsetroot', '-solid', colors.get('wash', '#eef0f3')], env=env, timeout=5)
    lap('prepare')
    hqlib.hide_panels(n, env, size, warnings)
    lap('panel')
    light_session(n, env, warnings)
    lap('theme')
    shell = ensure_shell(n, stamp, warnings)
    lap('shell')
    if not start_home():
        warnings.append('the home screen server is not running (see %s/home.log)' % LOGS)
    if reset:
        if manage:
            hqlib.stop_browser(bot['id'])
        left = close_windows(n, keep_browsers=not manage)
        if left:
            warnings.append('%d window(s) on screen %d would not close' % (left, n))
        lap('reset')
    chrome = None
    if manage:
        try:
            chrome = hqlib.start_browser(n, bot['id'], colors.get('accent'), restart=restart and not reset, log=log)
        except RuntimeError as e:
            raise Fatal(str(e))
        warnings.extend(chrome['warnings'])
        lap('chrome')
    hqlib.write_json(folder + '/stamp.json', {'stamp': stamp, 'shell': shell, 'at': int(time.time())})
    return {'timings': timings, 'size': list(size), 'chromeStarted': bool(chrome and chrome['started'])}


def screen_ok(n, stamp, manage, bot_id):
    """Cheap check that the screen still wears this exact look and its pieces are alive."""
    folder = hqlib.screen_dir(n)
    applied = hqlib.read_json(folder + '/stamp.json') or {}
    if applied.get('stamp') != stamp or (hqlib.look_for(n) or {}).get('stamp') != stamp:
        return False
    if applied.get('shell'):
        state = hqlib.read_json(folder + '/shell.json') or {}
        if not hqlib.alive(state.get('pid')) or state.get('stamp') != stamp:
            return False
    if not home_alive():
        return False
    if manage and not any(disp == n for _pid, disp in hqlib.our_browser(bot_id)):
        return False
    return True


def do_undress(n, bot_id):
    folder = hqlib.screen_dir(n)
    look = hqlib.look_for(n) or {}
    env = hqlib.screen_env(n) if os.path.isdir(folder) else hqlib.base_env(n)
    their = (look.get('bot') or {}).get('id')
    if their and look.get('manageChrome'):
        hqlib.stop_browser(their)
    if bot_id and bot_id != their:
        hqlib.stop_browser(bot_id, started_by_us=True)
    elif bot_id and not look.get('manageChrome'):
        # This screen's browser belongs to someone else. Only a Chrome we started ourselves may go.
        hqlib.stop_browser(bot_id, started_by_us=True)
    # Taking the look away makes the desktop pieces leave and the home server forget this screen.
    for name in ('look.json', 'stamp.json', 'shell.json'):
        try:
            os.unlink('%s/%s' % (folder, name))
        except OSError:
            pass
    saved = hqlib.read_json(folder + '/backdrop.json')
    if saved and shutil.which('xfconf-query'):
        for prop, value in saved.items():
            hqlib.run(['xfconf-query', '-c', 'xfce4-desktop', '-p', prop, '-n', '-t', 'string', '-s', value], env=env)
        os.unlink(folder + '/backdrop.json')
    hqlib.restore_panels(n, env)
    restore_session(n, env)
    hqlib.stop_pids(shell_pids(n), grace=2)
    hqlib.stop_pids(hqlib.marked_pids(n), grace=3)
    try:
        os.unlink(folder + '/bus.json')
    except OSError:
        pass
    if shutil.which('xsetroot') and hqlib.geometry(n):
        hqlib.run(['xsetroot', '-solid', '#eceef1'], env=hqlib.base_env(n), timeout=5)
    for old in glob.glob(folder + '/wall-*.png'):
        try:
            os.unlink(old)
        except OSError:
            pass


# ---------------------------------------------------------------- command line

def main(argv):
    cmd = argv[0] if argv else ''
    if cmd == '_job':
        run_job(argv[1], argv[2], argv[3:])
    elif cmd == 'go':
        n, base_hash, stamp, flags, look_b64 = int(argv[1]), argv[2], argv[3], argv[4].strip('-'), argv[5]
        if not base_current(base_hash):
            print('HQ_NOBASE')
            return
        look = json.loads(gzip.decompress(base64.b64decode(look_b64)).decode('utf-8'))
        if not flags and screen_ok(n, stamp, bool(look.get('manageChrome')), look['bot']['id']):
            print('HQ_OK')
            return
        wait_job(start_job('dress-%d' % n, [str(n), flags or '-', look_b64]), 25)
    elif cmd == 'wait':
        wait_job(argv[1], float(argv[2]) if len(argv) > 2 else 25)
    elif cmd == 'base-check':
        if base_current(argv[1]) and start_home():
            print('HQ_BASE_OK ' + json.dumps(hqlib.read_json(ROOT + '/base.json') or {}))
        else:
            print('HQ_NOBASE')
    elif cmd == 'base':
        wait_job(start_job('base', [argv[1]]), 25)
    elif cmd == 'undress':
        do_undress(int(argv[1]), argv[2] if len(argv) > 2 else '')
        print('HQ_DONE {"ok": true}')
    elif cmd == 'terminal':
        command = base64.b64decode(argv[2]).decode('utf-8')
        title = base64.b64decode(argv[3]).decode('utf-8') if len(argv) > 3 and argv[3] != '-' else None
        if not hqlib.geometry(int(argv[1])):
            print('HQ_DONE ' + json.dumps({'ok': False, 'error': 'screen %s does not answer' % argv[1]}))
            return
        try:
            hqlib.open_terminal(int(argv[1]), command, title)
            print('HQ_DONE {"ok": true}')
        except Exception as e:
            print('HQ_DONE ' + json.dumps({'ok': False, 'error': str(e)}))
    elif cmd == 'launch':
        hqlib.launch_app(int(argv[1]), argv[2])
        print('HQ_DONE {"ok": true}')
    else:
        sys.stderr.write(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main(sys.argv[1:])
