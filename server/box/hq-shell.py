#!/usr/bin/env python3
"""hq-shell N: the desktop pieces of screen N. One process per X display.

It paints the wallpaper described in /opt/hq/screens/N/look.json (through xfdesktop where that runs,
in a desktop window of its own on a bare display) and shows a small dock with Browser, Terminal and
Files. The dock lives in the layer below normal windows, so a maximized window simply covers it.
It follows changes to look.json and to the screen size on its own, and exits when the look is removed.
"""
import math
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hqlib  # noqa: E402

import gi  # noqa: E402
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402
import cairo  # noqa: E402

N = int(sys.argv[1])
DIR = hqlib.screen_dir(N)
LOOK = DIR + '/look.json'

ICON = 44          # dock icon size
CELL = 58          # one dock slot
PAD = 9            # inside the pill
MARGIN = 18        # room around the pill for its shadow
BOTTOM_GAP = 8     # pill to screen edge

DOCK_ITEMS = (
    ('browser', 'Browser', ('google-chrome', 'chromium', 'chromium-browser', 'web-browser', 'internet-web-browser')),
    ('terminal', 'Terminal', ('utilities-terminal', 'org.xfce.terminal', 'terminal', 'xterm')),
    ('files', 'Files', ('system-file-manager', 'org.xfce.thunar', 'file-manager', 'folder')),
)


def log(*parts):
    sys.stderr.write('%s [shell %d] %s\n' % (time.strftime('%F %T'), N, ' '.join(str(p) for p in parts)))
    sys.stderr.flush()


def hex_rgb(value, fallback=(0.94, 0.94, 0.95)):
    try:
        value = value.lstrip('#')
        return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except (AttributeError, ValueError, IndexError):
        return fallback


def rounded(cr, x, y, w, h, r):
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


class Shell:
    def __init__(self):
        self.screen = Gdk.Screen.get_default()
        self.look = None
        self.look_mtime = 0.0
        self.wall = None              # GdkPixbuf of the wallpaper at screen size
        self.size = (0, 0)
        self.uses_xfdesktop = False
        self.wall_win = None
        self.dock = None
        self.hover = -1
        self.pressed = -1
        self.icons = []
        self.load_icons()
        self.screen.connect('size-changed', lambda *_: self.refresh(force=True))
        self.screen.connect('monitors-changed', lambda *_: self.refresh(force=True))
        self.screen.connect('composited-changed', lambda *_: self.rebuild_dock())
        GLib.timeout_add(1200, self.watch)
        GLib.timeout_add_seconds(15, self.guard)
        if not self.refresh(force=True):
            log('no look to show; leaving')
            sys.exit(0)

    # ------------------------------------------------------------ look

    def screen_size(self):
        display = Gdk.Display.get_default()
        w = h = 0
        for i in range(display.get_n_monitors()):
            g = display.get_monitor(i).get_geometry()
            w, h = max(w, g.x + g.width), max(h, g.y + g.height)
        if not w or not h:
            geo = hqlib.geometry(N)
            w, h = geo if geo else (1280, 720)
        return w, h

    def watch(self):
        try:
            if not os.path.exists(LOOK):
                log('look removed; leaving')
                Gtk.main_quit()
                return False
            if os.path.getmtime(LOOK) != self.look_mtime:
                self.refresh()
        except Exception as e:  # keep the desktop alive whatever happens
            log('watch failed:', repr(e))
        return True

    def guard(self):
        try:
            hqlib_hide_panel_strips()
        except Exception as e:
            log('guard failed:', repr(e))
        return True

    def refresh(self, force=False):
        look = hqlib.look_for(N)
        if not look:
            return False
        try:
            self.look_mtime = os.path.getmtime(LOOK)
        except OSError:
            pass
        size = self.screen_size()
        changed = force or not self.look or look.get('stamp') != self.look.get('stamp') or size != self.size
        self.look, self.size = look, size
        if changed:
            started = time.time()
            self.wall = self.render_wall()
            self.show_wall()
            self.rebuild_dock()
            log('applied look %s at %dx%d in %.2fs' % (str(look.get('stamp'))[:10], size[0], size[1], time.time() - started))
        hqlib.write_json(DIR + '/shell.json', {
            'pid': os.getpid(), 'stamp': look.get('stamp'), 'width': size[0], 'height': size[1],
            'wallpaper': 'xfdesktop' if self.uses_xfdesktop else 'window',
            'composited': bool(self.screen.is_composited()),
        })
        return True

    def render_wall(self):
        w, h = self.size
        svg = (self.look.get('wallSvg') or '').replace('__W__', str(w)).replace('__H__', str(h))
        if svg:
            try:
                loader = GdkPixbuf.PixbufLoader.new_with_type('svg')
                loader.set_size(w, h)
                loader.write(svg.encode('utf-8'))
                loader.close()
                pix = loader.get_pixbuf()
                if pix and pix.get_width() == w and pix.get_height() == h:
                    return pix
                if pix:
                    return pix.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR)
            except Exception as e:
                log('could not render the wallpaper drawing, using a plain wash:', repr(e))
        # Plain two-tone wash when the drawing cannot be rendered (no SVG loader on this computer).
        colors = self.look.get('colors') or {}
        surface = cairo.ImageSurface(cairo.FORMAT_RGB24, w, h)
        cr = cairo.Context(surface)
        grad = cairo.LinearGradient(0, 0, w, h)
        grad.add_color_stop_rgb(0, *hex_rgb(colors.get('wash')))
        grad.add_color_stop_rgb(1, *hex_rgb(colors.get('washDeep') or colors.get('wash')))
        cr.set_source(grad)
        cr.paint()
        return Gdk.pixbuf_get_from_surface(surface, 0, 0, w, h)

    # ------------------------------------------------------------ wallpaper

    def show_wall(self):
        self.uses_xfdesktop = bool(hqlib.display_procs(N, ('xfdesktop',)))
        if self.uses_xfdesktop:
            if self.wall_win:
                self.wall_win.destroy()
                self.wall_win = None
            threading.Thread(target=self.hand_to_xfdesktop, args=(self.wall, self.size, str(self.look.get('stamp'))),
                             daemon=True).start()
            return
        w, h = self.size
        if not self.wall_win:
            win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
            win.set_title('Desktop')
            win.set_wmclass('hq-shell', hqlib.SHELL_CLASS)
            win.set_type_hint(Gdk.WindowTypeHint.DESKTOP)
            win.set_decorated(False)
            win.set_accept_focus(False)
            win.set_skip_taskbar_hint(True)
            win.set_skip_pager_hint(True)
            win.set_app_paintable(True)
            win.stick()
            win.connect('draw', self.draw_wall)
            win.connect('delete-event', lambda *_: True)
            self.wall_win = win
        self.wall_win.set_default_size(w, h)
        self.wall_win.resize(w, h)
        self.wall_win.move(0, 0)
        self.wall_win.show_all()
        self.wall_win.get_window().lower()
        self.wall_win.queue_draw()

    def draw_wall(self, _widget, cr):
        if self.wall:
            Gdk.cairo_set_source_pixbuf(cr, self.wall, 0, 0)
            cr.paint()
        return True

    def hand_to_xfdesktop(self, pixbuf, size, stamp):
        """xfdesktop owns the root window here, so give it our picture instead of covering it."""
        try:
            env = hqlib.screen_env(N)
            name = 'wall-%s-%dx%d.png' % (stamp[:12], size[0], size[1])
            path = '%s/%s' % (DIR, name)
            pixbuf.savev(path + '.tmp', 'png', ['compression'], ['3'])
            os.replace(path + '.tmp', path)
            code, out = hqlib.run(['xfconf-query', '-c', 'xfce4-desktop', '-l'], env=env)
            props = [p.strip() for p in out.splitlines() if p.strip().startswith('/backdrop/')] if code == 0 else []
            images = [p for p in props if p.endswith('/last-image')]
            if not images:
                images = ['/backdrop/screen0/monitor0/workspace0/last-image']
            saved_path = DIR + '/backdrop.json'
            saved = hqlib.read_json(saved_path)
            if saved is None:
                saved = {}
                for prop in images:
                    c, v = hqlib.run(['xfconf-query', '-c', 'xfce4-desktop', '-p', prop], env=env)
                    if c == 0 and DIR not in v:
                        saved[prop] = v.strip()
                hqlib.write_json(saved_path, saved)
            for prop in images:
                hqlib.run(['xfconf-query', '-c', 'xfce4-desktop', '-p', prop, '-n', '-t', 'string', '-s', path], env=env)
                style = prop[:-len('last-image')] + 'image-style'
                hqlib.run(['xfconf-query', '-c', 'xfce4-desktop', '-p', style, '-n', '-t', 'int', '-s', '3'], env=env)
            for old in os.listdir(DIR):
                if old.startswith('wall-') and old.endswith('.png') and old != name:
                    try:
                        os.unlink(os.path.join(DIR, old))
                    except OSError:
                        pass
        except Exception as e:
            log('could not hand the wallpaper to xfdesktop:', repr(e))

    # ------------------------------------------------------------ dock

    def load_icons(self):
        theme = Gtk.IconTheme()
        theme.set_custom_theme(hqlib.icon_theme())
        fallback = Gtk.IconTheme.get_default()
        self.icons = []
        for _action, _label, names in DOCK_ITEMS:
            pix = None
            for source in (theme, fallback):
                for name in names:
                    try:
                        if source.has_icon(name):
                            pix = source.load_icon(name, ICON, Gtk.IconLookupFlags.FORCE_SIZE)
                            break
                    except GLib.Error:
                        continue
                if pix:
                    break
            self.icons.append(pix)

    def dock_geometry(self):
        pill_w = PAD * 2 + CELL * len(DOCK_ITEMS)
        pill_h = PAD * 2 + CELL - 6
        return pill_w + MARGIN * 2, pill_h + MARGIN * 2, pill_w, pill_h

    def rebuild_dock(self):
        if self.dock:
            self.dock.destroy()
            self.dock = None
        win_w, win_h, pill_w, pill_h = self.dock_geometry()
        win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        win.set_title('Dock')
        win.set_wmclass('hq-shell', hqlib.SHELL_CLASS)
        win.set_type_hint(Gdk.WindowTypeHint.DOCK)
        win.set_decorated(False)
        win.set_resizable(False)
        win.set_accept_focus(False)
        win.set_skip_taskbar_hint(True)
        win.set_skip_pager_hint(True)
        win.set_keep_below(True)
        win.set_app_paintable(True)
        win.stick()
        self.glass = bool(self.screen.is_composited() and self.screen.get_rgba_visual())
        if self.glass:
            win.set_visual(self.screen.get_rgba_visual())
        win.set_default_size(win_w, win_h)
        win.set_size_request(win_w, win_h)
        win.add_events(Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.BUTTON_PRESS_MASK |
                       Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        win.connect('draw', self.draw_dock)
        win.connect('motion-notify-event', self.on_motion)
        win.connect('leave-notify-event', self.on_leave)
        win.connect('button-press-event', self.on_press)
        win.connect('button-release-event', self.on_release)
        win.connect('delete-event', lambda *_: True)
        self.dock_pos = ((self.size[0] - win_w) // 2, self.size[1] - win_h + MARGIN - BOTTOM_GAP)
        win.move(*self.dock_pos)
        win.show_all()
        win.move(*self.dock_pos)
        # Only the pill takes clicks; the shadow margin lets them through to whatever is behind.
        region = cairo.Region(cairo.RectangleInt(MARGIN, MARGIN, pill_w, pill_h))
        win.input_shape_combine_region(region)
        win.get_window().lower()
        if self.wall_win and self.wall_win.get_window():
            self.wall_win.get_window().lower()
        self.dock = win

    def draw_dock(self, _widget, cr):
        win_w, win_h, pill_w, pill_h = self.dock_geometry()
        cr.set_operator(cairo.OPERATOR_SOURCE)
        if self.glass:
            cr.set_source_rgba(0, 0, 0, 0)
            cr.paint()
        elif self.wall:
            Gdk.cairo_set_source_pixbuf(cr, self.wall, -self.dock_pos[0], -self.dock_pos[1])
            cr.paint()
        else:
            cr.set_source_rgb(*hex_rgb((self.look.get('colors') or {}).get('wash')))
            cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        x, y, r = MARGIN, MARGIN, 20
        ink = hex_rgb((self.look.get('colors') or {}).get('ink'), (0.1, 0.12, 0.16))
        for i in range(8, 0, -1):          # soft shadow
            cr.set_source_rgba(ink[0], ink[1], ink[2], 0.016)
            rounded(cr, x - i, y - i + 4, pill_w + 2 * i, pill_h + 2 * i, r + i)
            cr.fill()
        rounded(cr, x, y, pill_w, pill_h, r)   # frosted body
        cr.set_source_rgba(1, 1, 1, 0.58)
        cr.fill()
        glow = cairo.LinearGradient(0, y, 0, y + pill_h)
        glow.add_color_stop_rgba(0, 1, 1, 1, 0.38)
        glow.add_color_stop_rgba(0.55, 1, 1, 1, 0.0)
        rounded(cr, x, y, pill_w, pill_h, r)
        cr.set_source(glow)
        cr.fill()
        rounded(cr, x + 0.5, y + 0.5, pill_w - 1, pill_h - 1, r - 0.5)
        cr.set_source_rgba(1, 1, 1, 0.9)
        cr.set_line_width(1)
        cr.stroke()
        for i, pix in enumerate(self.icons):
            cx = x + PAD + CELL * i
            cy = y + PAD - 3
            if i == self.hover:
                rounded(cr, cx + 2, cy + 2, CELL - 4, CELL - 4, 14)
                cr.set_source_rgba(1, 1, 1, 0.78 if i != self.pressed else 0.5)
                cr.fill()
            ix = cx + (CELL - ICON) / 2
            iy = cy + (CELL - ICON) / 2 + (1 if i == self.pressed else 0)
            if pix:
                Gdk.cairo_set_source_pixbuf(cr, pix, ix, iy)
                cr.paint()
            else:
                rounded(cr, ix, iy, ICON, ICON, 12)
                cr.set_source_rgba(ink[0], ink[1], ink[2], 0.35)
                cr.fill()
        return True

    def slot_at(self, x, y):
        _, _, pill_w, pill_h = self.dock_geometry()
        if not (MARGIN <= x < MARGIN + pill_w and MARGIN <= y < MARGIN + pill_h):
            return -1
        i = int((x - MARGIN - PAD) // CELL)
        return i if 0 <= i < len(DOCK_ITEMS) else -1

    def on_motion(self, _w, event):
        slot = self.slot_at(event.x, event.y)
        if slot != self.hover:
            self.hover = slot
            self.dock.queue_draw()
        return True

    def on_leave(self, _w, _event):
        self.hover, self.pressed = -1, -1
        self.dock.queue_draw()
        return True

    def on_press(self, _w, event):
        if event.button == 1:
            self.pressed = self.slot_at(event.x, event.y)
            self.dock.queue_draw()
        return True

    def on_release(self, _w, event):
        slot = self.slot_at(event.x, event.y)
        hit = event.button == 1 and slot >= 0 and slot == self.pressed
        self.pressed = -1
        self.dock.queue_draw()
        if hit:
            action = DOCK_ITEMS[slot][0]
            threading.Thread(target=self.launch, args=(action,), daemon=True).start()
        return True

    def launch(self, action):
        try:
            hqlib.launch_app(N, action)
            log('opened', action)
        except Exception as e:
            log('could not open %s:' % action, repr(e))


def hqlib_hide_panel_strips():
    hqlib.hide_panel_strips(N)


def main():
    GLib.set_prgname('hq-shell')
    Gdk.set_program_class(hqlib.SHELL_CLASS)
    settings = Gtk.Settings.get_default()
    if settings:
        settings.set_property('gtk-application-prefer-dark-theme', False)
    Shell()
    log('running, pid', os.getpid())
    Gtk.main()


if __name__ == '__main__':
    main()
