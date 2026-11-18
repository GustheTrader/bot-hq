"""Isolated end-to-end test of the Grok Bot bridge (round 2).

Real HQ server (built copy) + a loopback stub engine + a synthetic SQLite DB + headless Chromium.
No production data, no real model, no real webhook: callbacks go to a local file (test-only switch), the
server's outbound HTTP is forced through a dead proxy, and the browser may only reach the test server.
"""
import hashlib, hmac, json, os, pathlib, secrets, socket, sqlite3, subprocess, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'test-artifacts'
DATA.mkdir(exist_ok=True)
db_path = DATA / 'e2e.db'
for suffix in ('', '-wal', '-shm'):
    (DATA / ('e2e.db' + suffix)).unlink(missing_ok=True)
callback = DATA / 'callbacks.jsonl'; callback.unlink(missing_ok=True)
key = secrets.token_urlsafe(32)
SESSION_SECRET = 'test-only'
COOKIE = 'grokbot_session=test-session'

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
main_port, bridge_port = free_port(), free_port()
MAIN, BRIDGE = f'http://127.0.0.1:{main_port}', f'http://127.0.0.1:{bridge_port}'

def http(method, url, body=None, token=None, cookie=None, timeout=5):
    headers = {}
    data = None
    if body is not None: headers['Content-Type'] = 'application/json'; data = json.dumps(body).encode()
    if token: headers['Authorization'] = 'Bearer ' + token
    if cookie: headers['Cookie'] = cookie
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=timeout) as r:
            raw = r.read(); return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, None

def bridge(method, path, body=None, token=key):
    return http(method, BRIDGE + '/api/integrations/grok' + path, body, token)
def main(method, path, body=None):
    return http(method, MAIN + path, body, cookie=COOKIE)
def submit(title, brief='Synthetic brief', ref=None):
    s, b = bridge('POST', '/jobs', {'botId': 'bot-test', 'title': title, 'brief': brief, 'sourceRef': ref or title})
    assert s == 202, (s, b); return b['jobId']
def job(jid):
    s, b = bridge('GET', '/jobs/' + jid); assert s == 200, (s, b); return b
def wait_status(jid, statuses, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        j = job(jid)
        if j['status'] in statuses: return j
        time.sleep(0.2)
    raise AssertionError(f'{jid} stuck at {job(jid)["status"]}, wanted {statuses}')
def await_callback(jid, event, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if callback.exists():
            for line in callback.read_text().splitlines():
                rec = json.loads(line)
                if rec['task'].startswith(f'{jid}:{event}:'): return rec
        time.sleep(0.1)
    raise AssertionError(f'missing callback {event} for {jid}')
def q(sql, *args):
    c = sqlite3.connect(db_path); c.row_factory = sqlite3.Row
    try: return [dict(r) for r in c.execute(sql, args)]
    finally: c.close()

mcp_results = {}
class Stub(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        inp = request.get('input', '')
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        def send(event, data):
            self.wfile.write(('event: ' + event + '\ndata: ' + json.dumps(data) + '\n\n').encode()); self.wfile.flush()
        token = hmac.new(SESSION_SECRET.encode(), b'mcp:bot-test', hashlib.sha256).hexdigest()
        def mcp(name, args, timeout=5):
            s, b = http('POST', MAIN + '/mcp/bot-test', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}, token, timeout=timeout)
            assert s == 200 and 'result' in b, (s, b); return b['result']
        if 'Ask user smoke' in inp:
            send('response.output_item.added', {'item': {'type': 'function_call', 'name': 'mcp__hq__ask_user', 'call_id': 'ask1', 'arguments': '{}'}})
            mcp('ask_user', {'question': 'Choose a test option?', 'options': ['A', 'B']})
            send('response.output_item.done', {'item': {'type': 'function_call_output', 'call_id': 'ask1', 'output': 'ok'}})
            self.close_connection = True; return
        if 'Approval smoke' in inp:
            send('response.output_item.added', {'item': {'type': 'function_call', 'name': 'mcp__hq__COMPOSIO_MULTI_EXECUTE_TOOL', 'call_id': 'w1', 'arguments': '{}'}})
            time.sleep(0.5)
            res = mcp('COMPOSIO_MULTI_EXECUTE_TOOL', {'tools': [{'tool_slug': 'GMAIL_SEND_EMAIL', 'arguments': {'to': 'nobody@example.invalid', 'subject': 'synthetic'}}]}, timeout=120)
            mcp_results['approval'] = res['content'][0]['text']
            send('response.output_item.done', {'item': {'type': 'function_call_output', 'call_id': 'w1', 'output': 'declined'}})
            send('response.output_text.delta', {'delta': 'Approval handled.'})
            send('response.output_item.done', {'item': {'type': 'message', 'content': [{'text': 'Approval handled.'}]}})
            self.close_connection = True; return
        delay = 5 if 'Prototype smoke test' in inp else 8 if 'Long turn' in inp else 2
        send('response.output_item.added', {'item': {'type': 'function_call', 'name': 'test_probe', 'call_id': 'call1', 'arguments': '{}'}})
        time.sleep(delay)
        send('response.output_item.done', {'item': {'type': 'function_call_output', 'call_id': 'call1', 'output': 'ok'}})
        send('response.output_text.delta', {'delta': 'Stub test completed.'})
        send('response.output_item.done', {'item': {'type': 'message', 'content': [{'text': 'Stub test completed.'}]}})
        self.close_connection = True

stub = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=stub.serve_forever, daemon=True).start()
env = {'PATH': os.environ['PATH'], 'HOME': str(DATA / 'home'), 'TMPDIR': os.environ['TMPDIR'], 'NODE_ENV': 'test',
       'HOST': '127.0.0.1', 'PORT': str(main_port), 'APP_URL': MAIN, 'SERVER_URL': MAIN,
       'GROK_BRIDGE_PORT': str(bridge_port), 'GROK_BRIDGE_HOST': '127.0.0.1',
       'DB_PATH': str(db_path), 'ENGINES_DIR': str(DATA / 'engines'), 'HERMES_HOME_PRIMARY': str(DATA / 'home'),
       'LOCAL_SCREENS_DIR': str(DATA / 'screens'), 'HERMES_URL': f'http://127.0.0.1:{stub.server_port}',
       'HERMES_KEY': 'stub-key', 'XAI_API_KEY': 'test-only', 'COMPOSIO_API_KEY': 'test-only', 'SESSION_SECRET': SESSION_SECRET,
       'COMPUTER_PROVIDER': 'local', 'GROKBOT_NO_SCHEDULER': '1', 'GROK_TEST_NO_SCREEN': '1', 'GROK_TEST_SWEEP_MS': '1000',
       'GROK_CALLBACK_LOG': str(callback), 'GROK_INTEGRATION_USER_ID': 'test-user', 'GROK_INTEGRATION_BOT_IDS': 'bot-test',
       'GROK_INTEGRATION_KEY_SHA256': hashlib.sha256(key.encode()).hexdigest(),
       'GROK_MAX_OPEN_PER_BOT': '3', 'GROK_RATE_GET_PER_MIN': '100000', 'GROK_RATE_POST_PER_MIN': '1000',
       # Hermetic: Node's fetch honours these with NODE_USE_ENV_PROXY=1, so any non-loopback call fails fast.
       'NODE_USE_ENV_PROXY': '1', 'HTTP_PROXY': 'http://127.0.0.1:1', 'HTTPS_PROXY': 'http://127.0.0.1:1', 'NO_PROXY': '127.0.0.1,localhost'}
log = (DATA / 'server.log').open('w')
proc = None
def start():
    global proc
    proc = subprocess.Popen(['node', 'server/dist/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(200):
        try:
            if http('GET', MAIN + '/api/health')[0] == 200 and http('GET', BRIDGE + '/nope')[0] == 404: return
        except Exception: pass
        if proc.poll() is not None: raise RuntimeError('server exited; see server.log')
        time.sleep(0.1)
    raise RuntimeError('server failed to start')
def kill():
    proc.kill(); proc.wait(timeout=5)

results = {}
try:
    start()
    t = int(time.time() * 1000)
    conn = sqlite3.connect(db_path)
    conn.execute('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)', ('test-user', 'test@example.invalid', 'Test Owner', t))
    conn.execute('INSERT INTO bots(id,user_id,name,label,is_primary,engine,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ('bot-test', 'test-user', 'Test Bot', 'Stub', 1, 'primary', t, t))
    conn.execute('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)', ('test-session', 'test-user', t, t + 3600000))
    conn.commit(); conn.close()

    # --- 1. Scope: the key works only on the bridge listener, a session only on the main app.
    tcp = pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:]
    bound = [l.split()[1] for l in tcp if l.split()[3] == '0A' and int(l.split()[1].split(':')[1], 16) == bridge_port]
    assert bound == [f'0100007F:{bridge_port:04X}'], bound  # 127.0.0.1 only
    scope = {
        'main /api/integrations with key': http('GET', MAIN + '/api/integrations/grok/jobs/x', token=key)[0],
        'main POST /api/integrations with key': http('POST', MAIN + '/api/integrations/grok/jobs', {}, token=key)[0],
        'main /api/bots with key': http('GET', MAIN + '/api/bots', token=key)[0],
        'main /api/bots with session': http('GET', MAIN + '/api/bots', cookie=COOKIE)[0],
        'bridge job with session only': http('GET', BRIDGE + '/api/integrations/grok/jobs/x', cookie=COOKIE)[0],
        'bridge /api/bots with key': http('GET', BRIDGE + '/api/bots', token=key)[0],
    }
    assert scope == {'main /api/integrations with key': 404, 'main POST /api/integrations with key': 404, 'main /api/bots with key': 401,
                     'main /api/bots with session': 200, 'bridge job with session only': 401, 'bridge /api/bots with key': 404}, scope
    results['scope'] = scope

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
        ctx.add_cookies([{'name': 'grokbot_session', 'value': 'test-session', 'url': MAIN}])
        page = ctx.new_page()
        external = []
        def route(r):
            u = r.request.url
            if not u.startswith(MAIN + '/'): external.append(u); return r.abort()
            if '/api/computer' in u or '/api/apps' in u: return r.abort()
            return r.continue_()
        page.route('**/*', route)
        page.goto(MAIN, wait_until='domcontentloaded')
        page.get_by_role('button', name='HQ activity', exact=False).first.click(timeout=15000)
        page.wait_for_timeout(1500)  # let the app's event stream connect

        # --- 2. A job shows on the live board with badge, steps and timer, then completes with a callback.
        first = submit('Prototype smoke test', 'Run the stub demonstration.')
        card = page.locator('.hq-card')
        card.get_by_text('from Grok Bot', exact=True).wait_for(timeout=15000)
        card.get_by_text('1 step', exact=True).wait_for(timeout=10000)
        card.locator('.live-signal__time').wait_for(timeout=5000)
        page.screenshot(path=str(DATA / 'live-view.png'))
        assert job(first)['status'] == 'running'
        done = wait_status(first, ['completed'])
        assert done['finalReply'] == 'Stub test completed.'
        cb = await_callback(first, 'completed')
        assert 'untrusted_excerpt="Stub test completed."' in cb['message'], cb
        results['completed'] = done

        # --- 3. Bridge reply to a question; a queued job waits for it instead of consuming it.
        asked = submit('Ask user smoke', ref='ask-bridge')
        assert wait_status(asked, ['needs_input'])['question']['question'] == 'Choose a test option?'
        await_callback(asked, 'needs_input')
        card.get_by_text('Choose a test option?', exact=False).first.wait_for(timeout=5000)
        page.screenshot(path=str(DATA / 'live-question.png'))
        waiting = submit('Waiting behind question')
        time.sleep(1.5)
        assert job(waiting)['status'] == 'queued' and job(asked)['status'] == 'needs_input'
        assert bridge('POST', f'/jobs/{asked}/reply', {'answer': 'A'})[0] == 202
        assert bridge('POST', f'/jobs/{asked}/reply', {'answer': 'A'})[0] == 409
        wait_status(asked, ['completed']); await_callback(asked, 'completed')
        wait_status(waiting, ['completed'])
        results['bridge_reply'] = 'completed'
        browser.close()
        assert not external, external

    # --- 4. Answer clicked in HQ completes the bridge job.
    asked = submit('Ask user smoke', ref='ask-ui-answer')
    seq = wait_status(asked, ['needs_input'])['question']['seq']
    assert main('POST', f'/api/bots/bot-test/cards/{seq}/answer', {'answer': 'B'})[0] == 200
    assert wait_status(asked, ['completed'])['finalReply'] == 'Stub test completed.'
    await_callback(asked, 'completed')
    results['ui_answer'] = 'completed'

    # --- 5. A typed chat reply answers the question and completes the bridge job.
    asked = submit('Ask user smoke', ref='ask-typed')
    wait_status(asked, ['needs_input'])
    assert main('POST', '/api/bots/bot-test/messages', {'text': 'A please'})[0] == 200
    wait_status(asked, ['completed']); await_callback(asked, 'completed')
    results['typed_reply'] = 'completed'

    # --- 6. Dismissing the question cancels the job and lets the queue move on.
    asked = submit('Ask user smoke', ref='ask-dismiss')
    seq = wait_status(asked, ['needs_input'])['question']['seq']
    behind = submit('Queued behind dismissed question')
    time.sleep(1)
    assert job(behind)['status'] == 'queued'
    assert main('POST', f'/api/bots/bot-test/cards/{seq}/dismiss')[0] == 200
    assert wait_status(asked, ['cancelled'])['endReason'] == 'question dismissed in HQ'
    await_callback(asked, 'cancelled')
    wait_status(behind, ['completed'])
    results['ui_dismiss'] = 'cancelled, queue resumed'

    # --- 7. A write tool on a bridge job raises an approval card and does not run until decided.
    appr = submit('Approval smoke', ref='approval')
    pending = []
    for _ in range(100):
        pending = q("SELECT id,row_seq,tool,status FROM approvals WHERE bot_id='bot-test' AND status='pending'")
        if pending: break
        time.sleep(0.1)
    assert pending and pending[0]['tool'] == 'GMAIL_SEND_EMAIL', pending
    tool_rows = q("SELECT json_extract(body,'$.status') s FROM rows WHERE bot_id='bot-test' AND kind='tool-call' AND json_extract(body,'$.name')='COMPOSIO_MULTI_EXECUTE_TOOL' ORDER BY seq DESC LIMIT 1")
    assert tool_rows[0]['s'] == 'awaiting-approval', tool_rows
    assert job(appr)['status'] == 'running'
    assert 'approval' not in mcp_results, 'tool must not return before a decision'
    assert main('POST', f"/api/approvals/{pending[0]['id']}", {'decision': 'deny'})[0] == 200
    wait_status(appr, ['completed'])
    assert 'declined' in mcp_results['approval'].lower(), mcp_results
    tool_rows = q("SELECT json_extract(body,'$.status') s FROM rows WHERE bot_id='bot-test' AND kind='tool-call' AND json_extract(body,'$.name')='COMPOSIO_MULTI_EXECUTE_TOOL' ORDER BY seq DESC LIMIT 1")
    assert tool_rows[0]['s'] == 'denied', tool_rows
    results['approval'] = 'card shown, tool held, denied, job completed'

    # --- 8a. Restart mid-turn: the running job is interrupted (not replayed); queued work recovers.
    running = submit('Long turn', ref='restart-running')
    wait_status(running, ['running'])
    queued = submit('Queued before restart')
    assert job(queued)['status'] == 'queued'
    kill(); start()
    assert job(running)['status'] == 'interrupted'
    await_callback(running, 'interrupted')
    wait_status(queued, ['completed'])
    results['restart_running'] = 'interrupted; queued completed'

    # --- 8b. Restart while a job waits on a question: the question survives and can still be answered.
    asked = submit('Ask user smoke', ref='ask-restart')
    wait_status(asked, ['needs_input'])
    kill(); start()
    after = job(asked)
    assert after['status'] == 'needs_input' and after['question'] and after['question']['question'] == 'Choose a test option?', after
    assert bridge('POST', f'/jobs/{asked}/reply', {'answer': 'B'})[0] == 202
    wait_status(asked, ['completed'])
    results['restart_needs_input'] = 'question restored; reply completed job'

    # --- 9. A conversation reset closes open jobs with callbacks; new jobs use the new thread.
    asked = submit('Ask user smoke', ref='ask-reset')
    wait_status(asked, ['needs_input'])
    behind = submit('Queued before reset')
    assert main('POST', '/api/bots/bot-test/fresh')[0] == 200
    for jid in (asked, behind):
        assert job(jid)['status'] == 'interrupted', job(jid)
        await_callback(jid, 'interrupted')
    fresh = submit('After reset')
    assert job(fresh)['threadId'] == 'hq-bot-test-g2'
    wait_status(fresh, ['completed'])
    results['reset'] = 'both interrupted; new thread g2 works'

    # --- 10. Engine down: the job fails with a callback.
    stub.shutdown(); stub.server_close()
    down = submit('Engine down')
    wait_status(down, ['failed']); await_callback(down, 'failed')
    results['engine_down'] = 'failed'

    # --- 11. Evidence hygiene: the key is not in the DB, log or callbacks; every callback carries a task id.
    blobs = [db_path.read_bytes(), (DATA / 'server.log').read_bytes(), callback.read_bytes()]
    for wal in (DATA / 'e2e.db-wal',):
        if wal.exists(): blobs.append(wal.read_bytes())
    assert all(key.encode() not in b for b in blobs)
    recs = [json.loads(l) for l in callback.read_text().splitlines()]
    assert all(len(r['task'].split(':')) == 3 for r in recs)
    results['callbacks'] = len(recs)
    results['audit_rows'] = q('SELECT COUNT(*) n FROM grok_audit')[0]['n']
    log_text = (DATA / 'server.log').read_text()
    assert 'HTTP 400' not in log_text, 'an outbound call reached a real API'
    print(json.dumps(results, indent=2))
finally:
    if proc and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    try: stub.shutdown()
    except Exception: pass
    log.close()
