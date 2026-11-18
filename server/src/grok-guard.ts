/**
 * Start-up guard for the Grok Bot bridge. Imported first by index.ts and by every bridge module, so a bad
 * configuration stops the process before anything else loads.
 *
 * - Test switches only work under NODE_ENV=test. Set anywhere else, the server refuses to start rather than
 *   silently skipping screens, dispatch or real callback delivery.
 * - The bridge listener must be a specific loopback address (or an explicitly allowed specific address,
 *   never a wildcard) on its own port, so the public edge that forwards the main port can never reach it.
 */

const TEST_ONLY = ['GROK_TEST_NO_SCREEN', 'GROK_TEST_NO_DISPATCH', 'GROK_CALLBACK_LOG', 'GROK_NOTIFY_BIN', 'GROK_TEST_SWEEP_MS'] as const;
const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]', '*']);

export const isLoopbackAddress = (a: string) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost';

export function grokEnvProblems(e: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const test = e.NODE_ENV === 'test';
  if (!test) for (const k of TEST_ONLY) if (e[k]) problems.push(`${k} is a test-only switch (needs NODE_ENV=test) and must be unset`);
  if (e.GROK_CALLBACK_LOG && e.GROK_CALLBACK_ENABLED === '1') problems.push('GROK_CALLBACK_LOG and GROK_CALLBACK_ENABLED=1 are mutually exclusive');
  if (e.GROK_BRIDGE_PORT) {
    const host = (e.GROK_BRIDGE_HOST ?? '127.0.0.1').trim();
    if (!/^\d{2,5}$/.test(e.GROK_BRIDGE_PORT)) problems.push('GROK_BRIDGE_PORT must be a port number');
    if (WILDCARDS.has(host)) problems.push('GROK_BRIDGE_HOST must be a specific address, never a wildcard');
    else if (!isLoopbackAddress(host) && e.GROK_BRIDGE_ALLOW_NONLOOPBACK !== '1') problems.push('GROK_BRIDGE_HOST must be loopback unless GROK_BRIDGE_ALLOW_NONLOOPBACK=1');
    if (e.GROK_BRIDGE_PORT === (e.PORT ?? '8787')) problems.push('GROK_BRIDGE_PORT must differ from the main PORT');
  }
  return problems;
}

export const GROK_TEST_MODE = process.env.NODE_ENV === 'test';

/** A test switch is on only in test mode; elsewhere the guard below has already refused to start. */
export const testFlag = (name: (typeof TEST_ONLY)[number]) => process.env.NODE_ENV === 'test' && !!process.env[name] && process.env[name] !== '0';

const problems = grokEnvProblems(process.env);
if (problems.length) {
  console.error(`[grok bridge] refusing to start: ${problems.join('; ')}`);
  throw new Error(`grok bridge configuration refused: ${problems.join('; ')}`);
}
