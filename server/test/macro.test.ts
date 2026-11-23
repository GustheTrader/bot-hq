import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-'));
process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.MACRO_MCP_URL ='https://mcp.example/mcp';
process.env.MACRO_AUTH_HOME = path.join(tmp, 'auth');
const M = await import('../src/macro.js');

test('parseCallback accepts only a loopback callback with a code (or error) and a state', () => {
  assert.equal(M.parseCallback('http://127.0.0.1:27890/callback?code=abc&state=xyz'), '?code=abc&state=xyz');
  assert.equal(M.parseCallback('  ?code=abc&state=xyz '), '?code=abc&state=xyz');
  assert.equal(M.parseCallback('http://127.0.0.1:27890/callback?error=access_denied&state=xyz'), '?error=access_denied&state=xyz');
  assert.equal(M.parseCallback('http://127.0.0.1:27890/callback?code=abc'), null); // no state (a cut-off copy)
  assert.equal(M.parseCallback('https://evil.example/callback?code=abc&state=x'), null);
  assert.equal(M.parseCallback('not a url'), null);
});

test('macroServerConfig asks Hermes for OAuth with a 30-minute sign-in window', () => {
  assert.deepEqual(M.macroServerConfig(), { url: 'https://mcp.example/mcp', auth: 'oauth', oauth: { timeout: 1800 } });
});

test('linkMacroTokens links a bot home to the shared sign-in, and never removes a folder with files', { skip: process.platform === 'win32' }, () => {
  const bot = path.join(tmp, 'bot1');
  fs.mkdirSync(bot);
  assert.equal(M.linkMacroTokens(bot), true);
  assert.equal(fs.realpathSync(path.join(bot, 'mcp-tokens')), fs.realpathSync(path.join(tmp, 'auth', 'mcp-tokens')));
  assert.equal(M.linkMacroTokens(bot), true); // idempotent

  const other = path.join(tmp, 'bot2');
  fs.mkdirSync(path.join(other, 'mcp-tokens'), { recursive: true });
  fs.writeFileSync(path.join(other, 'mcp-tokens', 'figma.json'), '{}');
  assert.equal(M.linkMacroTokens(other), false);
  assert.ok(fs.existsSync(path.join(other, 'mcp-tokens', 'figma.json')));
});

test('macroStatus reads the shared token file', () => {
  fs.mkdirSync(path.join(tmp, 'auth', 'mcp-tokens'), { recursive: true });
  assert.equal(M.macroStatus().signedIn, false);
  fs.writeFileSync(path.join(tmp, 'auth', 'mcp-tokens', 'macro.json'), JSON.stringify({ refresh_token: 'r', expires_at: 2_000_000_000 }));
  const s = M.macroStatus();
  assert.equal(s.signedIn, true);
  assert.equal(s.expiresAt, 2_000_000_000_000);
});
