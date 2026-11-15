/**
 * The written half of the Wiki (Settings → Wiki): what each harness and provider is, how it signs
 * in, what it is good for and what to watch out for. The measured half comes from
 * bench-results.json (server/src/bench.ts). Keep claims here to what the app does or what the task
 * tests showed; date anything that can change (plans, billing).
 */

export interface HarnessGuide {
  id: string;
  name: string;
  signIn: string;
  models: string;
  keeps: string;
  bestFor: string;
  watch: string;
}

export const HARNESS_GUIDE: HarnessGuide[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    signIn: 'Any provider set in the Engine panel: a subscription (ChatGPT, Claude, Copilot) or an API key (OpenRouter, xAI, …).',
    models: 'Every model the chosen provider offers; pick it in the Engine panel’s Model list.',
    keeps: 'Everything: the app’s tools, Hermes’ own tools (terminal, files, web, browser, computer use), memory, personas and messaging.',
    bestFor: 'The default for day-to-day Bots, and the only harness that switches providers per Bot. Use it when a Bot should remember, message or work the screen. Its setups were the fastest in the tests.',
    watch: 'A provider can list a model it then refuses (see the test results). Grok is signed in only on the Hermes Bot’s own engine.',
  },
  {
    id: 'codex',
    name: 'Codex',
    signIn: 'Your ChatGPT plan, from Codex’s own sign-in on the computer.',
    models: 'The few models Codex offers for the plan (gpt-6-astra by default); pick one in the Engine panel.',
    keeps: 'The app’s tools. Not Hermes’ memory, personas or messaging.',
    bestFor: 'Coding and shell work in the Bot’s folder, on the ChatGPT plan instead of an API bill. Both models tested passed 5/5.',
    watch: 'Slower per task than Hermes (it narrates before acting), and it shares the ChatGPT plan’s rate limit with Hermes’ ChatGPT Bots: run several at once and it answers 429. Runs in full-access mode, since its own sandbox cannot start inside the computer’s.',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    signIn: 'Your Claude subscription, from Claude Code’s own sign-in. The Claude organization must allow subscription use of Claude Code.',
    models: 'default, sonnet, opus and the other aliases Claude Code offers.',
    keeps: 'The app’s tools. Not Hermes’ memory, personas or messaging.',
    bestFor: 'Coding, file edits and multi-step work on the Claude plan. Its default model passed 5/5 and was the quickest harness tested.',
    watch: 'opus misread the reasoning task (added primes below 100). If the organization turns off subscription access, every turn is refused until it is back on or an API key is used.',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    signIn: 'Works without a sign-in on OpenCode’s free models; add providers in OpenCode itself for more.',
    models: 'OpenCode’s list (big-pickle by default, several free models).',
    keeps: 'The app’s tools. Not Hermes’ memory, personas or messaging.',
    bestFor: 'Trying a task at no cost, or a second opinion from a different model family. Both free models tested passed 5/5.',
    watch: 'The slowest setups tested; free models can change or slow down without notice.',
  },
  {
    id: 'pi',
    name: 'Pi',
    signIn: 'Pi’s own sign-in: run `pi` in the computer’s terminal and type /login.',
    models: 'The models of the providers Pi is signed in to.',
    keeps: 'The app’s tools. Not Hermes’ memory, personas or messaging.',
    bestFor: 'Running a Bot on providers only Pi is signed in to.',
    watch: 'Not in the tests yet: until Pi is signed in to a provider that answers, its turns end with “Pi ended the turn without replying”. Its current default model is on Ollama Cloud, whose payment is past due.',
  },
];

export interface ProviderNote { name: string; how: string; note: string; state: 'ok' | 'warn' | 'off' }

/** Hermes providers as found on the computer; `AS_OF` dates the billing states. */
export const AS_OF = '2026-11-15';
export const PROVIDER_NOTES: ProviderNote[] = [
  { name: 'ChatGPT (openai-codex)', how: 'Subscription (Plus)', note: 'gpt-6-luna passed 5/5; gpt-6.1-sol passed 4/5 (it used tools when told not to). The plan answers 429 when many requests run at once.', state: 'ok' },
  { name: 'Claude (Anthropic)', how: 'Subscription or API key', note: 'claude-fable-5.1, claude-sonnet-5-5 and claude-haiku-5-5 each passed 5/5.', state: 'ok' },
  { name: 'Grok (xai)', how: 'API key', note: 'grok-4.6 passed 5/5. Signed in on the Hermes Bot’s own engine only.', state: 'ok' },
  { name: 'OpenRouter', how: 'API key, pay per token', note: 'deepseek-v4.1-flash and kimi-k3 each passed 5/5 and were the fastest setups tested; every request is billed.', state: 'ok' },
  { name: 'Copilot', how: 'Subscription', note: 'Lists many models but rejects some: gemini-4-argon failed every task with “model not supported”. Test a Copilot model before relying on it.', state: 'warn' },
  { name: 'Modal Shared DeepSeek / Qwen', how: 'Modal, pay per token', note: 'Needs a payment method on Modal; plan credits do not cover shared endpoints (429).', state: 'off' },
  { name: 'DeepSeek via Ollama (Modal proxy)', how: 'Ollama Cloud behind a Modal proxy', note: 'Ollama subscription payment is past due (403).', state: 'off' },
  { name: 'Ollama Cloud', how: 'API key', note: 'Same past-due Ollama subscription.', state: 'off' },
];

export const TIPS: string[] = [
  'Press Test in the Engine panel after any change: it sends one real message and shows the status code. A 200 means the next chat turn will reach the model.',
  'Pick “Provider default” or “Default” when unsure; it is what the provider or harness would use on its own.',
  'Switching harness stops a running turn and resets the model to the new harness’s default. Changing only the model takes effect on the next turn.',
  'A model a harness does not offer fails the turn with a clear message instead of quietly using another one.',
  'Only Hermes keeps memory and personas. Move a Bot to another harness for a job, then back, if it needs to remember.',
  'New chat starts a fresh session on every harness.',
];

export const RERUN = 'cd /home/workspace/Projects/bot-hq/server && node --env-file=../.env dist/bench.js /tmp/bench-results.json 3';
