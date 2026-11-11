#!/usr/bin/env python3
"""Give the main Hermes agent the app's tools: add the `hq` MCP server to its config.yaml.

Run on the computer, after install-on-computer.sh:
    python3 add-hq-to-hermes.py [--config /root/.hermes/config.yaml] [--entry /opt/hq/data/hermes-mcp-hq.yaml] [--remove]

The edit is plain text (the file's comments and layout stay as they are), a dated copy of the file
is kept next to it, and the result is checked before it replaces the original: every other setting
must read back exactly as before. Hermes notices the change by itself; no restart.
"""
import argparse, os, re, shutil, sys, time

p = argparse.ArgumentParser()
p.add_argument('--config', default='/root/.hermes/config.yaml')
p.add_argument('--entry', default='/opt/hq/data/hermes-mcp-hq.yaml')
p.add_argument('--remove', action='store_true')
a = p.parse_args()

try:
    import yaml
except ImportError:
    sys.exit('PyYAML is needed for the safety check; run this with the Python that Hermes uses.')

old = open(a.config, encoding='utf-8').read()
lines = old.split('\n')
block = [l for l in open(a.entry, encoding='utf-8').read().split('\n') if l.strip() and not l.lstrip().startswith('#')]

def section():
    """Line range (start, end) of the top-level mcp_servers mapping, or None."""
    for i, l in enumerate(lines):
        if re.match(r'^mcp_servers:\s*(#.*)?$', l):
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or lines[j][0] in ' \t#'):
                j += 1
            return i, j
    return None

def hq_range(s, e):
    """Line range of an existing `hq:` entry inside the section, or None."""
    for i in range(s + 1, e):
        if re.match(r'^  hq:\s*(#.*)?$', lines[i]):
            j = i + 1
            while j < e and (not lines[j].strip() or re.match(r'^(   +|\t)', lines[j])):
                j += 1
            while j > i + 1 and not lines[j - 1].strip():
                j -= 1
            return i, j
    return None

sec = section()
if sec:
    had = hq_range(*sec)
    if had:
        del lines[had[0]:had[1]]
    if not a.remove:
        lines[sec[0] + 1:sec[0] + 1] = block
elif not a.remove:
    if re.search(r'^mcp_servers:', old, re.M):
        sys.exit('mcp_servers is written in a form this script does not edit; add the entry by hand.')
    if lines and lines[-1].strip():
        lines.append('')
    lines += ['mcp_servers:'] + block + ['']
new = '\n'.join(lines)
if new == old:
    print('nothing to change'); sys.exit(0)

before, after = yaml.safe_load(old) or {}, yaml.safe_load(new) or {}
b_servers, a_servers = dict(before.get('mcp_servers') or {}), dict(after.get('mcp_servers') or {})
b_servers.pop('hq', None); hq = a_servers.pop('hq', None)
rest = lambda d: {k: v for k, v in d.items() if k != 'mcp_servers'}
if rest(before) != rest(after) or b_servers != a_servers:
    sys.exit('refusing: the edit would change other settings')
if a.remove and hq is not None:
    sys.exit('refusing: hq is still there')
if not a.remove and not (isinstance(hq, dict) and str(hq.get('url', '')).startswith('http') and 'Authorization' in (hq.get('headers') or {})):
    sys.exit('refusing: the hq entry did not read back correctly')

backup = f"{a.config}.before-hq-{time.strftime('%Y%m%d-%H%M%S')}"
shutil.copy2(a.config, backup)
tmp = a.config + '.hq-tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(new)
shutil.copymode(a.config, tmp)
st = os.stat(a.config); os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, a.config)
print(('removed hq' if a.remove else 'added hq') + f'; previous file kept as {backup}')
