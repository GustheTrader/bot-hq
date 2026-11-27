import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getBotRow } from './store.js';
import { composioTools } from './composio.js';
import { mcpToken, primaryBotId } from './engine.js';
import { claimToolRow, enqueueBotMessage, markSilent, noteToolOutcome, requestApproval, turnDepth } from './agent/loop.js';
import { policyFor, runComposioTool, toolMap, TOOLS, type ToolCtx } from './agent/tools.js';
import { listLibrarySkills, readLibrarySkill, SkillError } from './skill-library.js';
import { codeModeOn, noteInnerCall, RUN_CODE, runCode, runCodeTool, runForToken, splitTools, typesFor, type McpTool } from './codemode.js';

/**
 * The app's tools, served to the Hermes engines over MCP (streamable HTTP, JSON answers only).
 *
 *   POST /mcp/<botId>     one bot's engine; the bearer token is derived from the bot id
 *   POST /mcp/primary     the primary engine, whichever bot it is bound to (so that agent's config
 *                         can be written before the bot exists)
 *
 * Every call is stateless: the URL says which bot is calling. Besides the app's own tools the list
 * carries the user's Composio tools, so connected apps (and the approvals around them) work the
 * same for every engine.
 */

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this (they sent a new message or did not answer in time). Do not retry unless they ask.';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface CallResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): CallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which bot a request is for, or null when the token does not fit the URL. `botId` is null for /mcp/primary before a bot is bound to it. */
function caller(slug: string, auth: string | undefined): { botId: string | null } | null {
  const given = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return null;
  if (slug === 'primary') return { botId: primaryBotId() };
  return getBotRow(slug) ? { botId: slug } : null;
}

/** Every tool the bot could call, before Code Mode decides which ones it sees directly. */
async function allTools(botId: string | null): Promise<McpTool[]> {
  const own = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
  const bot = botId ? getBotRow(botId) : null;
  if (!bot) return own;
  const apps = (await composioTools(bot.user_id))
    .filter((t: any) => t?.type === 'function' && typeof t.name === 'string' && !toolMap.has(t.name))
    .map((t: any) => ({ name: t.name as string, description: String(t.description ?? ''), inputSchema: t.parameters ?? { type: 'object', properties: {} } }));
  return [...own, ...apps];
}

/** What tools/list shows: every tool, or (Code Mode) run_code plus the tools that must stay direct. */
async function listTools(botId: string | null): Promise<McpTool[]> {
  const tools = await allTools(botId);
  if (!codeModeOn(botId)) return tools;
  const { direct, scripted } = splitTools(tools);
  try {
    return [runCodeTool(await typesFor(scripted)), ...direct];
  } catch (e: any) {
    // Executor down: fall back to plain tools rather than leave the bot without any.
    console.warn('[codemode] types failed, listing plain tools:', e?.message ?? e);
    return tools;
  }
}

async function callTool(botId: string | null, rawName: string, args: any): Promise<CallResult> {
  const bot = botId ? getBotRow(botId) : null;
  if (!botId || !bot) return text('The team app has no bot for this agent yet. Ask the user to open the app once, then try again.', true);
  const userId: string = bot.user_id;
  const name = [...toolMap.keys()].find((k) => k.toLowerCase() === rawName.toLowerCase()) ?? rawName;
  const rowSeq = await claimToolRow(botId, name);
  if (name === RUN_CODE && codeModeOn(botId)) {
    const { scripted } = splitTools(await allTools(botId));
    const r = await runCode(botId, rowSeq, String(args?.code ?? ''), scripted);
    noteToolOutcome(botId, rowSeq, { status: r.isError ? 'error' : 'done', summary: r.summary });
    return text(r.output, r.isError);
  }
  if (name === RUN_CODE) return text('Code Mode is off for this agent: call the tools directly.', true);
  return runTool(botId, userId, name, args, rowSeq, false);
}

/**
 * Run one tool for a bot. `inner` = called from a Code Mode script: there is no row of its own
 * (the run_code row sums the calls up) and nothing may wait on the user's approval mid-script.
 */
async function runTool(botId: string, userId: string, name: string, args: any, rowSeq: number | null, inner: boolean): Promise<CallResult> {
  const ctx: ToolCtx = { userId, botId, enqueueBotMessage, depth: turnDepth(botId) };
  try {
    const own = toolMap.get(name);
    if (own) {
      const r = await own.impl(args, ctx);
      if (r.endTurn) markSilent(botId);
      noteToolOutcome(botId, rowSeq, { status: 'done', summary: r.summary });
      return text(r.output);
    }

    const pol = policyFor(userId, name, args);
    if (pol.decision === 'block') {
      noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Not allowed' });
      return text(DECLINED);
    }
    if (pol.decision === 'ask' && inner) {
      return text(`This action needs the user's approval (${pol.title}). Make this ${name} call as a normal tool call, not from run_code.`, true);
    }
    if (pol.decision === 'ask') {
      const answer = await requestApproval({ userId, botId }, pol, args, rowSeq);
      if (answer !== 'allow') return text(answer === 'deny' ? DECLINED : SKIPPED);
    }
    const r = await runComposioTool(ctx, name, args);
    noteToolOutcome(botId, rowSeq, { status: r.summary === 'failed' ? 'error' : 'done', summary: r.summary === 'failed' ? 'Failed' : undefined });
    return text(r.output);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    noteToolOutcome(botId, rowSeq, { status: 'error', summary: msg.slice(0, 200) });
    return text(`Tool error: ${msg}`, true);
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** skill://<source>/<path> for a library skill id <source>:<path>, and back. */
export const skillUri = (skillId: string) => `skill://${skillId.replace(':', '/')}`;
export function skillIdFor(uri: string): string | null {
  const m = /^skill:\/\/(zo|hermes|anthropic)\/(.+)$/.exec(uri);
  return m ? `${m[1]}:${m[2]}` : null;
}
function skillResources() {
  return listLibrarySkills().map((s) => ({ uri: skillUri(s.id), name: s.id, title: s.name, description: s.description || undefined, mimeType: 'text/markdown' }));
}

/** Answer one JSON-RPC message; null for notifications (they get no answer). */
async function handle(msg: any, botId: string | null): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response to something we never asked; nothing to do with it.
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null;
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: 'hq', title: 'Team app', version: '1.0.0' },
          instructions: 'Tools of the team app: connected apps, files for the user, tasks, routines, other agents on the team. Skills (ready-made instructions for common jobs) are listed by skills_list and loaded by skill_read, and are also resources at skill://<source>/<path>.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: await listTools(botId) } };
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !name) return rpcError(id, -32602, 'Missing tool name');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      return { jsonrpc: '2.0', id, result: await callTool(botId, name, args) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: skillResources() } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [{ uriTemplate: 'skill://{source}/{+path}', name: 'skill', title: 'A skill', description: 'The instructions of one skill. source is zo, hermes or anthropic.', mimeType: 'text/markdown' }] } };
    case 'resources/read': {
      const uri = String(params?.uri ?? '');
      const skillId = skillIdFor(uri);
      if (!skillId) return rpcError(id, -32002, `Resource not found: ${uri.slice(0, 120)}`);
      try {
        // The whole skill: SKILL.md files over 256 KiB are never listed, so that already bounds it.
        const sk = readLibrarySkill(skillId, undefined, Infinity);
        const text = `---\nname: ${sk.name}\ndescription: ${JSON.stringify(sk.description)}\n---\n\n${sk.body}`;
        return { jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/markdown', text }] } };
      } catch (e) {
        // Unknown, or unreadable / removed since it was listed: either way it is not there to read.
        if (!(e instanceof SkillError)) console.warn('[mcp] skill read failed', skillId, (e as Error)?.message ?? e);
        return rpcError(id, -32002, `Resource not found: ${uri.slice(0, 120)}`);
      }
    }
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const mcpApi = new Hono();

mcpApi.post('/:bot', async (c) => {
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handle(m, who.botId)))).filter(Boolean);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handle(body, who.botId);
  return answer ? c.json(answer) : c.body(null, 202);
});

/**
 * A tool call from inside a Code Mode script (the codemode/ Worker calls this). The bearer is the
 * short-lived run token minted for that script, never the bot's MCP token.
 */
mcpApi.post('/:bot/inner', async (c) => {
  const botId = c.req.param('bot');
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const run = token ? runForToken(botId, token) : null;
  if (!run) return c.json({ error: 'Unauthorized' }, 401);
  const bot = getBotRow(botId);
  if (!bot) return c.json({ error: 'No such bot' }, 404);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Bad JSON' }, 400); }
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!run.allowed.has(name)) return c.json({ error: `No tool named ${name || '(none)'} is available to scripts.` }, 400);
  noteInnerCall(run.runId, name);
  const args = body?.args && typeof body.args === 'object' ? body.args : {};
  const r = await runTool(botId, bot.user_id, name, args, null, true);
  return c.json({ output: r.content.map((p) => p.text).join('\n'), isError: !!r.isError });
});

// No server-to-client stream and no sessions to end.
mcpApi.all('/:bot', (c) => c.body(null, 405, { Allow: 'POST' }));
