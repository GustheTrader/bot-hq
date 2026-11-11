import type { ActivityKind, LiveState, Row } from '@shared/types';

/** textKind → phrase table from docs/research/03-ui-design.md §2.4. Arrays rotate. */
const PHRASES: Record<string, string[]> = {
  thinking: ['Thinking it through', 'Mulling it over', 'Putting it together'],
  working: ['Getting it done', 'Making progress', 'Working on it', 'Handling it', 'Chipping away'],
  searching_web: ['Digging around'],
  reading_web: ['Doing some reading'],
  browsing_web: ['Clicking through pages'],
  reading_file: ['Reading the file'],
  drafting_file: ['Jotting it down'],
  organizing_files: ['Moving files over'],
  on_your_computer: ['Working on your computer'],
  on_its_computer: ['Clicking around'],
  running_commands: ['Running a few commands'],
  waiting_on_command: ['Waiting on results'],
  coding: ['Writing some code'],
  generating_photo: ['Sketching something up'],
  generating_video: ['Filming a clip'],
  messaging_assistant: ['Checking with another Bot'],
  messaging: ['Sending a message'],
  connecting_app: ['Working in a connected app'],
  waiting_for_you: ['Needs your input'],
  checking_usage: ['Checking your usage'],
  remembering: ['Making a note of it'],
};

const nice = (s?: string) => !!s && !/[_]/.test(s) && !/^[a-z0-9-]+$/.test(s);

/** Name of the bot being messaged: the running call's `bot_name` argument, else a readable `detail`. */
function messagedName(live: LiveState, rows: Row[]): string | null {
  const running = [...rows].reverse().find((r) => r.body.type === 'tool-call' && r.body.status === 'running');
  const args = running?.body.type === 'tool-call' ? (running.body.args as Record<string, unknown> | undefined) : undefined;
  if (typeof args?.bot_name === 'string') return args.bot_name;
  return nice(live.activity?.detail) ? live.activity!.detail! : null;
}

/** Phrase for the live caption when the server sent none. `tick` rotates multi-phrase kinds. */
export function activityPhrase(live: LiveState, rows: Row[], tick: number): string {
  const a = live.activity;
  if (!a) return live.awaiting ? 'Needs your input' : 'Working on it';
  const kind = a.kind as ActivityKind;
  if (kind === 'messaging_named') {
    const name = messagedName(live, rows);
    return name ? `Checking with ${name}` : 'Checking with another Bot';
  }
  if (kind === 'connecting_service') return nice(a.detail) ? `Working in ${a.detail}` : 'Working in a connected app';
  const list = PHRASES[kind] ?? PHRASES.working;
  return list[tick % list.length];
}

/** One or two words for the status pill under the bot's name. */
const STATUS: Record<ActivityKind, string> = {
  thinking: 'Thinking',
  working: 'Working',
  searching_web: 'Searching',
  reading_web: 'Reading',
  browsing_web: 'Browsing',
  on_its_computer: 'On its computer',
  running_commands: 'Running commands',
  waiting_on_command: 'Waiting on results',
  messaging_named: 'Checking in',
  connecting_service: 'Using an app',
  waiting_for_you: 'Needs you',
  drafting_file: 'Writing',
  remembering: 'Remembering',
};

/** True when the bot has stopped to wait for the person (approval, question, connect). */
export function isWaitingForYou(live: LiveState | undefined): boolean {
  return !!live && (!!live.awaiting || live.activity?.kind === 'waiting_for_you');
}

/** Short status word for the pill: "Thinking", "Browsing", "Working in Gmail", "Needs you". */
export function activityStatus(live: LiveState, rows: Row[]): string {
  if (isWaitingForYou(live)) return 'Needs you';
  const a = live.activity;
  if (!a) return 'Thinking';
  if (a.kind === 'messaging_named') {
    const name = messagedName(live, rows);
    return name ? `Checking with ${name}` : STATUS.messaging_named;
  }
  if (a.kind === 'connecting_service') return nice(a.detail) ? `Working in ${a.detail}` : STATUS.connecting_service;
  return STATUS[a.kind] ?? 'Working';
}
