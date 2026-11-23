import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** A secret from NAME, or from the file named by NAME_FILE (so keys need not sit in .env). */
function secret(name: string): string {
  const direct = process.env[name];
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  throw new Error(`Missing env ${name} (or ${name}_FILE)`);
}

/** Where the bots' screens come from: an Orgo cloud computer, or this machine itself. */
const computerProvider = process.env.COMPUTER_PROVIDER === 'local' ? 'local' : 'orgo';

const configuredMaxBots = Number(process.env.MAX_BOTS ?? 4);
const hermesHome = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /**
   * Public wss:// address of this server, for when the web app is served from another host that cannot
   * pass WebSockets on (e.g. Vercel). The screen viewer then connects here directly with a short-lived ticket.
   */
  publicWsUrl: (process.env.PUBLIC_WS_URL ?? '').replace(/\/+$/, ''),
  xaiKey: req('XAI_API_KEY'),
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  composioKey: req('COMPOSIO_API_KEY'),
  computerProvider,
  orgoKey: computerProvider === 'orgo' ? secret('ORGO_API_KEY') : (process.env.ORGO_API_KEY ?? ''),
  sessionSecret: req('SESSION_SECRET'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Where each extra bot's own Hermes home lives. Must be outside ~/.hermes so it is a separate tenant. */
  enginesDir: process.env.ENGINES_DIR ?? new URL('../../data/engines', import.meta.url).pathname,
  /** Macro (macro.com) MCP server every bot gets, e.g. https://mcp-server.macro.com/mcp. Empty = off. */
  macroMcpUrl: process.env.MACRO_MCP_URL ?? '',
  /** The Hermes home that holds the one shared Macro sign-in (its mcp-tokens/ is linked into every bot's home). */
  macroAuthHome: process.env.MACRO_AUTH_HOME ?? new URL('../../data/macro-auth', import.meta.url).pathname,
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Doug',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  // ---- the one shared computer ----
  /** The Orgo computer every bot works on (one screen each). Empty = legacy one-box-per-user mode is not supported. */
  orgoComputerId: process.env.ORGO_COMPUTER_ID || (computerProvider === 'local' ? 'local' : ''),
  /** This server runs on that computer, so shell commands run locally instead of through Orgo's API. */
  localBox: process.env.HQ_LOCAL === '1' || computerProvider === 'local',
  /** COMPUTER_PROVIDER=local: where the screens keep their VNC password and logs, and their size. */
  localScreensDir: process.env.LOCAL_SCREENS_DIR ?? '/root/grokbot/local-screens',
  localScreenSize: /^\d+x\d+$/.test(process.env.LOCAL_SCREEN_SIZE ?? '') ? process.env.LOCAL_SCREEN_SIZE! : '1440x900',
  /**
   * DevTools URL of a Chrome that already runs on the default screen and belongs to the primary bot
   * (e.g. http://127.0.0.1:9333). When set, we never start or stop that screen's Chrome ourselves.
   */
  primaryCdpUrl: process.env.PRIMARY_CDP_URL ?? '',
  /** Bot and screen capacity. Orgo limits a Linux computer to four screens. */
  maxBots: computerProvider === 'local' ? configuredMaxBots : Math.min(configuredMaxBots, 4),
  /** Comma-separated emails allowed to sign in; empty = anyone who can reach the app. */  /** RevOpt Admin: the Macro desktop frontend to embed beside the task catalog, if it is reachable. */
  macroTeamUrl: process.env.MACRO_TEAM_URL ?? process.env.VITE_MACRO_TEAM_URL ?? '',
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};
