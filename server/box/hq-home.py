#!/usr/bin/env python3
"""hq-home: the home screen every Chrome on this computer shows on a new tab.

One small server on 127.0.0.1 serves a different page to each screen. It works out who is asking
from the TCP connection: source port -> owning process -> that Chrome's profile folder (one per
bot) or, failing that, the X display the Chrome runs on.
"""
import html
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hqlib  # noqa: E402

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'home.html')

NEUTRAL = {
    'stamp': 'neutral',
    'bot': {'id': '', 'name': '', 'label': ''},
    'colors': {'accent': '#6b7280', 'ink': '#1f2430', 'wash': '#f1f2f4'},
    'avatarSvg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#fff"/>'
                 '<circle cx="24" cy="24" r="17" fill="#9aa1ad"/></svg>',
    'wallSvg': '<svg xmlns="http://www.w3.org/2000/svg" width="__W__" height="__H__"><defs>'
               '<linearGradient id="n" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6f7f8"/>'
               '<stop offset="1" stop-color="#e6e8ec"/></linearGradient></defs>'
               '<rect width="100%" height="100%" fill="url(#n)"/></svg>',
}

# ---------------------------------------------------------------- who is asking

_owner_cache = {}
_owner_lock = threading.Lock()


def _socket_inode(client_port):
    """Inode of the client end of a loopback connection to us, from the kernel's socket table."""
    for table, local_prefix in (('/proc/net/tcp', '0100007F'), ('/proc/net/tcp6', None)):
        try:
            with open(table) as f:
                next(f, None)
                for line in f:
                    parts = line.split()
                    if len(parts) < 10:
                        continue
                    local, remote = parts[1], parts[2]
                    try:
                        lport = int(local.rsplit(':', 1)[1], 16)
                        rport = int(remote.rsplit(':', 1)[1], 16)
                    except (IndexError, ValueError):
                        continue
                    if lport == client_port and rport == hqlib.HOME_PORT and parts[9] != '0':
                        return parts[9]
        except OSError:
            continue
    return None


def _holder_of(inode):
    """Pid of a process that holds this socket. Chrome's network process owns its sockets."""
    needle = 'socket:[%s]' % inode
    pids = hqlib.all_pids()
    browsers = [p for p in pids if 'chrom' in hqlib.comm(p).lower()]
    for group in (browsers, [p for p in pids if p not in browsers]):
        for pid in group:
            fd_dir = '/proc/%d/fd' % pid
            try:
                for fd in os.listdir(fd_dir):
                    try:
                        if os.readlink('%s/%s' % (fd_dir, fd)) == needle:
                            return pid
                    except OSError:
                        continue
            except OSError:
                continue
    return None


def _describe(pid):
    """(profile folder, display number) for the browser a process belongs to."""
    profile, display, main = None, None, None
    seen = 0
    while pid and pid > 1 and seen < 6:
        args = hqlib.cmdline(pid)
        if args and 'chrom' in os.path.basename(args[0]).lower() and not any(a.startswith('--type=') for a in args):
            main = pid
        if display is None:
            display = hqlib._marked_screen(args)
        if profile is None:
            for a in args:
                if a.startswith('--user-data-dir='):
                    profile = a.split('=', 1)[1].rstrip('/')
                    break
        if display is None:
            display = hqlib.display_number(hqlib.environ_of(pid).get('DISPLAY'))
        if profile is not None and display is not None:
            break
        pid = hqlib.ppid(pid)
        seen += 1
    if display is None and main:
        # Chrome wipes its environment; find the screen it has a window on (dressed screens only).
        display = hqlib.x_display_of(main, sorted(_screens()))
    return profile, display


def _screens():
    out = {}
    try:
        names = os.listdir(hqlib.SCREENS)
    except OSError:
        return out
    for name in names:
        if name.isdigit():
            look = hqlib.look_for(int(name))
            if look:
                out[int(name)] = look
    return out


def screen_for_client(client_port):
    """Which screen's home page this connection should get, or None."""
    inode = _socket_inode(client_port)
    if not inode:
        return None
    pid = _holder_of(inode)
    if not pid:
        return None
    now = time.time()
    with _owner_lock:
        hit = _owner_cache.get(pid)
        if hit and now - hit[0] < 5:
            profile, display = hit[1], hit[2]
        else:
            profile, display = _describe(pid)
            _owner_cache[pid] = (now, profile, display)
            for old in [k for k, v in _owner_cache.items() if now - v[0] > 60]:
                _owner_cache.pop(old, None)
    screens = _screens()
    if profile and profile.startswith(hqlib.PROFILES + '/'):
        bot_id = os.path.basename(profile)
        for n, look in screens.items():
            if (look.get('bot') or {}).get('id') == bot_id:
                return n
    if display is not None and display in screens:
        return display
    return None


# ---------------------------------------------------------------- icons

_icon_cache = {}
_ICON_SIZES = ('64x64', '48x48', 'scalable', '128x128', '96x96', '256x256', '32x32', '24x24')
_ICON_KINDS = ('apps', 'places', 'categories', 'devices', 'mimetypes', 'actions', 'legacy')


def find_icon(name):
    if not name:
        return None
    if name in _icon_cache:
        return _icon_cache[name]
    found = None
    if name.startswith('/'):
        found = name if os.path.isfile(name) else None
    else:
        themes = [hqlib.icon_theme(), 'Papirus', 'hicolor', 'Adwaita', 'gnome', 'elementary-xfce', 'Humanity']
        roots = ['/usr/share/icons', os.path.expanduser('~/.local/share/icons'), '/usr/local/share/icons']
        for root in roots:
            for theme in themes:
                base = '%s/%s' % (root, theme)
                if not os.path.isdir(base):
                    continue
                for size in _ICON_SIZES:
                    for kind in _ICON_KINDS:
                        for layout in ('%s/%s/%s' % (base, size, kind), '%s/%s/%s' % (base, kind, size.split('x')[0])):
                            for ext in ('svg', 'png'):
                                path = '%s/%s.%s' % (layout, name, ext)
                                if os.path.isfile(path):
                                    found = path
                                    break
                            if found:
                                break
                        if found:
                            break
                    if found:
                        break
                if found:
                    break
            if found:
                break
        if not found:
            for ext in ('svg', 'png', 'xpm'):
                path = '/usr/share/pixmaps/%s.%s' % (name, ext)
                if os.path.isfile(path) and ext != 'xpm':
                    found = path
                    break
    _icon_cache[name] = found
    return found


def letter_icon(label, accent):
    letter = html.escape((label or '?').strip()[:1].upper() or '?')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="6" width="52" height="52" rx="14" fill="%s"/>'
            '<text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="600" text-anchor="middle" fill="#fff">%s</text></svg>'
            % (accent, letter)).encode('utf-8')


# ---------------------------------------------------------------- pages

def render_home(look):
    template = hqlib.read_text(TEMPLATE)
    if not template:
        return '<!doctype html><title>Home</title><body style="font-family:sans-serif">Home</body>'
    colors = dict(NEUTRAL['colors'])
    colors.update(look.get('colors') or {})
    bot = look.get('bot') or {}
    name = (bot.get('name') or '').strip()
    backdrop = (look.get('wallSvg') or NEUTRAL['wallSvg']).replace('__W__', '100%').replace('__H__', '100%')
    values = {
        'ACCENT': colors['accent'], 'INK': colors['ink'], 'WASH': colors['wash'],
        'STAMP': html.escape(str(look.get('stamp') or ''), quote=True),
        'TITLE': 'Home',
        'GREETING': html.escape('Welcome back, %s' % name if name else 'Welcome back'),
        'LABEL': html.escape((bot.get('label') or '').strip()),
        'AVATAR_SVG': look.get('avatarSvg') or NEUTRAL['avatarSvg'],
        'BACKDROP_SVG': backdrop,
    }
    return re.sub(r'\{\{([A-Z_]+)\}\}', lambda m: values.get(m.group(1), ''), template)


class Handler(BaseHTTPRequestHandler):
    server_version = 'hq-home'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # quiet: one line per error only
        if args and str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
            sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def _send(self, code, body, ctype, cache='no-store'):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj), 'application/json')

    def _screen(self, query):
        forced = (query.get('screen') or [''])[0]
        if forced.isdigit() and self.command == 'GET':
            return int(forced)
        return screen_for_client(self.client_address[1])

    def _look(self, query):
        n = self._screen(query)
        look = hqlib.look_for(n) if n is not None else None
        return n, (look or NEUTRAL)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        path = url.path
        try:
            if path in ('/', '/home'):
                _, look = self._look(query)
                self._send(200, render_home(look), 'text/html; charset=utf-8')
            elif path == '/stamp':
                n, look = self._look(query)
                self._json(200, {'stamp': str(look.get('stamp') or ''), 'screen': n})
            elif path == '/apps':
                apps = [{'id': a['id'], 'name': a['name'], 'kind': a['kind']} for a in hqlib.list_apps()]
                self._json(200, {'apps': apps})
            elif path == '/icon':
                app = hqlib.find_app((query.get('id') or [''])[0])
                icon = find_icon(app['icon']) if app else None
                if icon:
                    with open(icon, 'rb') as f:
                        data = f.read()
                    self._send(200, data, 'image/svg+xml' if icon.endswith('.svg') else 'image/png', 'max-age=300')
                else:
                    _, look = self._look(query)
                    accent = (look.get('colors') or {}).get('accent', '#6b7280')
                    self._send(200, letter_icon(app['name'] if app else '?', accent), 'image/svg+xml', 'max-age=60')
            elif path == '/favicon.svg' or path == '/favicon.ico':
                _, look = self._look(query)
                self._send(200, look.get('avatarSvg') or NEUTRAL['avatarSvg'], 'image/svg+xml', 'max-age=60')
            elif path == '/ext/updates.xml':
                data = hqlib.read_text(hqlib.EXT + '/updates.xml')
                if data is None:
                    self._send(404, 'not built', 'text/plain')
                else:
                    self._send(200, data, 'application/xml')
            elif path == '/ext/home.crx':
                try:
                    with open(hqlib.EXT + '/home.crx', 'rb') as f:
                        self._send(200, f.read(), 'application/x-chrome-extension')
                except OSError:
                    self._send(404, 'not built', 'text/plain')
            elif path == '/health':
                self._json(200, {'ok': True, 'pid': os.getpid()})
            else:
                self._send(404, 'Not found', 'text/plain')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # never let one bad request take the server down
            sys.stderr.write('error on %s: %r\n' % (self.path, e))
            try:
                self._send(500, 'error', 'text/plain')
            except Exception:
                pass

    do_HEAD = do_GET

    def do_POST(self):
        url = urlparse(self.path)
        length = min(int(self.headers.get('Content-Length') or 0), 4096)
        raw = self.rfile.read(length) if length else b''
        if url.path != '/launch':
            self._send(404, 'Not found', 'text/plain')
            return
        # Only our own page may launch apps: a same-origin fetch that carries our custom header.
        site = self.headers.get('Sec-Fetch-Site')
        origin = self.headers.get('Origin')
        if self.headers.get('X-HQ') != '1' or (site and site != 'same-origin') or (origin and origin != hqlib.HOME_URL):
            self._json(403, {'ok': False, 'error': 'forbidden'})
            return
        try:
            app_id = str(json.loads(raw.decode('utf-8') or '{}').get('id') or '')
        except ValueError:
            app_id = ''
        n = screen_for_client(self.client_address[1])
        if n is None or not hqlib.find_app(app_id):
            self._json(404, {'ok': False, 'error': 'unknown app or screen'})
            return
        try:
            hqlib.launch_app(n, app_id)
            self._json(200, {'ok': True})
        except Exception as e:
            sys.stderr.write('launch %s on %s failed: %r\n' % (app_id, n, e))
            self._json(500, {'ok': False, 'error': 'could not start'})


def main():
    server = ThreadingHTTPServer(('127.0.0.1', hqlib.HOME_PORT), Handler)
    server.daemon_threads = True
    hqlib.write_atomic(hqlib.ROOT + '/home.pid', str(os.getpid()))
    sys.stderr.write('%s hq-home listening on %s\n' % (time.strftime('%F %T'), hqlib.HOME_URL))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == '__main__':
    main()
