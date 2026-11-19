// Must stay the first import: refuses to start on test-only switches or an unsafe bridge listener.
import './grok-guard.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { revoptApi } from './routes-revopt.js';
import { projectsApi } from './routes-projects.js';
import { launchApi } from './routes-launch.js';
import { enqueue, expireStaleApprovals } from './agent/loop.js';
import { restorePendingQuestions } from './store.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { startIdleWatcher } from './idle.js';
import { workspaceApi } from './routes-workspace.js';
import { startScreenSleeper } from './screen-sleep.js';
import { mcpApi } from './mcp.js';
import { initEngines } from './engine.js';
import { startGrokBridge } from './routes-grok.js';
import { recoverGrokJobs, startGrokSweep } from './grok-jobs.js';
import { startGrokCallbacks } from './grok-notify.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();
// Questions a bot asked (ask_user) stay answerable across a restart, so bring back their "needs you" state.
restorePendingQuestions();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes' }));
// Integrations never live on the main (publicly forwarded) port; the Grok bridge has its own loopback listener.
app.all('/api/integrations/*', (c) => c.json({ error: 'not found' }, 404));
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api/revopt', revoptApi);
app.route('/api/projects', projectsApi);
app.route('/api/launch', launchApi);
app.route('/api/workspace', workspaceApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port, hostname: process.env.HOST || undefined }, (info) => console.log(`[grokbot] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
startIdleWatcher();
startScreenSleeper();
initEngines();
recoverGrokJobs();
startGrokSweep();
startGrokCallbacks();
startGrokBridge();
