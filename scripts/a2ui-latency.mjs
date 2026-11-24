#!/usr/bin/env node
// Latency measurement only (print-only, never fails on numbers). Same options as a2ui-crash-e2e.mjs.
//   node scripts/a2ui-latency.mjs [--samples 50] [--submits 20] [--bin <path>] [--fixture <jsonl>]
process.argv.push('--mode', 'latency');
await import('./a2ui-crash-e2e.mjs');
