#!/usr/bin/env node
// Latency measurement only (print-only, never fails on numbers). Same options as a2ui-crash-e2e.mjs.
//   node scripts/a2ui-latency.mjs [--samples 50] [--submits 20] [--bin <path>] [--fixture <jsonl>]
// Inserted FIRST: the parser takes the first --mode, so this wins over any --mode the caller passes.
process.argv.splice(2, 0, '--mode', 'latency');
await import('./a2ui-crash-e2e.mjs');
