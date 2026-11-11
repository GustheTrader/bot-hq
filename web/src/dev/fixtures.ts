// Dev-only: `?fixtures` injects sample card/notice/event rows into the open transcript (client-side only)
// so every card state can be checked visually. Buttons hit the real API with fake ids and will show errors.
// It also adds a finished turn and a turn in progress (tool-call steps in every status) with a fake live
// state, so the thinking block and the steps chip can be seen:
//   ?fixtures          the bot is working: pulsing status, caption, timer, live steps chip
//   ?fixtures=waiting  the bot is waiting for the person: "Needs you"
//   ?fixtures=idle     no turn in progress: only the finished "Worked for …" chips
import type { LiveState, Row, RowBody, ToolCallBody } from '@shared/types';
import { useStore } from '../store';

export function injectFixtures() {
  const st = useStore.getState();
  const botId = st.selectedBotId;
  if (!botId) return;
  const gen = st.transcripts[botId]?.generation ?? 0;
  const now = Date.now();
  let seq = 900000;
  const variant = new URLSearchParams(location.search).get('fixtures') || 'working';
  const turnStart = now - 83_000;
  // The card samples sit ten minutes back so the two turns below come after them in time as well as order.
  const row = (kind: Row['kind'], body: RowBody, ago = 0): Row => ({ botId, generation: gen, seq: ++seq, updatedSeq: seq, kind, body, createdAt: now - 600_000 - ago });
  const at = (kind: Row['kind'], body: RowBody, ago: number): Row => ({ botId, generation: gen, seq: ++seq, updatedSeq: seq, kind, body, createdAt: now - ago });
  let call = 0;
  const step = (name: string, label: string, status: ToolCallBody['status'], ago: number, more: Partial<ToolCallBody> = {}): Row =>
    at('tool-call', { type: 'tool-call', callId: `fx_call_${++call}`, name, label, status, ...more }, ago);
  const rows: Row[] = [
    row('message', { type: 'message', role: 'assistant', text: 'Got it, fixing that line now.' }, 60_000),
    row('message', { type: 'message', role: 'assistant', text: 'Fixed. It now says the computers are VPSs with a full desktop. Want me to send it?' }, 59_000),
    row('card', { type: 'card', card: 'draft', channel: 'message', to: 'Alex Rivera', approvalId: 'fx_draft', status: 'pending', text: 'Hey Alex, quick question. Any plans to support more than 3 seats?\n\nRight now the seat cap is the only thing stopping us.' }, 58_000),
    row('message', { type: 'message', role: 'user', text: 'Awesome, send it.' }, 57_000),
    row('card', { type: 'card', card: 'approval', approvalId: 'fx_appr', title: 'Allow Quinn to send an email?', detail: 'To: alex@example.com\nSubject: Seat cap question', tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', args: {}, status: 'pending' }, 56_000),
    row('card', { type: 'card', card: 'approval', approvalId: 'fx_appr2', title: 'Allow Quinn to create a calendar event?', detail: '', tool: 'GOOGLECALENDAR_CREATE_EVENT', toolkit: 'googlecalendar', args: {}, status: 'always' }, 55_000),
    row('card', { type: 'card', card: 'question', question: 'Which posts should go up?', options: ['1. $12/hr remix', '2. One workflow original', '3. Wrong agent remix'], status: 'pending' }, 54_000),
    row('card', { type: 'card', card: 'question', question: 'Which inbox should I watch?', options: ['Work', 'Personal'], status: 'answered', answer: 'Work' }, 53_000),
    row('card', { type: 'card', card: 'connect', toolkit: 'slack', toolkitName: 'Slack', logo: 'https://logos.composio.dev/api/slack', reason: 'I need Slack to post the daily digest in #general.', status: 'pending' }, 52_000),
    row('event', { type: 'event', event: 'routine-created', text: 'Routine created: Daily digest · Weekdays at 9:00 AM' }, 51_000),
    row('notice', { type: 'notice', text: "You're at 80% of your weekly usage limit.", tone: 'warn' }, 50_000),
    row('message', { type: 'message', role: 'assistant', text: "The DM didn't go out. Here's the text to paste into a DM to **@alex**:\n\n```\nHey Alex, quick question. Any plans to support more than 3 seats?\n```\n\n> Tip: X only allows message requests from the app.\n\nInline `code` works too." }, 49_000),

    // A finished turn: seven steps between the request and the answer, 2m 10s apart.
    at('message', { type: 'message', role: 'user', text: 'Did Alex ever reply about the seat cap? Check my inbox and the shared pricing sheet.' }, 400_000),
    step('GMAIL_FETCH_EMAILS', 'Searching Gmail', 'done', 392_000, { args: { query: 'from:alex seat cap', max_results: 10 }, summary: '3 threads' }),
    step('GMAIL_GET_THREAD', 'Reading a thread', 'done', 380_000, { args: { thread_id: '18f2c0a1' }, summary: 'Re: Seat cap question' }),
    step('web_search', 'Searching the web', 'done', 361_000, { args: { query: 'Acme pricing seats per plan' }, summary: '8 results' }),
    step('browser_navigate', 'Opening acme.com/pricing', 'done', 344_000, { args: { url: 'https://acme.com/pricing' } }),
    step('browser_snapshot', 'Reading the page', 'done', 330_000, { summary: 'Team plan: up to 10 seats' }),
    step('GOOGLESHEETS_BATCH_GET', 'Opening the pricing sheet', 'done', 312_000, { args: { spreadsheet: 'Pricing 2026', ranges: ['Plans!A1:F20'] }, summary: '20 rows' }),
    step('memory', 'Saving a note', 'done', 290_000, { summary: 'Alex: seat cap lifts in January' }),
    at('message', { type: 'message', role: 'assistant', text: 'Yes. Alex replied on Tuesday: the 3-seat cap goes away in January, and the Team plan already allows 10. I saved that so I remember it.' }, 270_000),
  ];

  if (variant !== 'idle') {
    // A turn in progress, with a step in every status.
    rows.push(
      at('message', { type: 'message', role: 'user', text: 'Great. Draft a reply to Alex and put a reminder in my calendar for January 5.' }, 83_000),
      step('GMAIL_GET_THREAD', 'Reading the thread', 'done', 76_000, { args: { thread_id: '18f2c0a1' }, summary: '4 messages' }),
      step('terminal', 'Running a command', 'error', 61_000, { args: { command: 'python3 draft_reply.py --thread 18f2c0a1' }, summary: 'exit code 1: No module named "markdown"' }),
      step('terminal', 'Installing a package', 'done', 48_000, { args: { command: 'pip install markdown' }, summary: 'markdown 3.7' }),
      step('GMAIL_SEND_EMAIL', 'Sending an email', 'awaiting-approval', 30_000, { args: { to: 'alex@example.com', subject: 'Re: Seat cap question' } }),
      step('GOOGLECALENDAR_FIND_EVENT', 'Looking at your calendar', variant === 'waiting' ? 'done' : 'running', 9_000, { args: { time_min: '2027-01-05T00:00:00Z', time_max: '2027-01-06T00:00:00Z' } }),
    );
  }
  st.upsertRows(botId, gen, rows);

  if (variant === 'idle') return;
  const live: LiveState = variant === 'waiting'
    ? { botId, isRunning: true, activity: { kind: 'waiting_for_you', since: now - 30_000 }, awaiting: { reason: 'Waiting for your OK to send the email to Alex', since: now - 30_000 }, startedAt: turnStart, caption: null, steps: 5 }
    : { botId, isRunning: true, activity: { kind: 'connecting_service', detail: 'Google Calendar', since: now - 9_000 }, awaiting: null, startedAt: turnStart, caption: 'Checking January 5 for anything that clashes with a reminder', steps: 5 };
  useStore.setState((s) => ({ live: { ...s.live, [botId]: live } }));
  // The caption changes as the model thinks; swap it once so the cross-fade can be seen.
  if (variant === 'working') {
    setTimeout(() => {
      useStore.setState((s) => (s.live[botId]?.isRunning ? { live: { ...s.live, [botId]: { ...s.live[botId], caption: 'The morning is free, so 9:00 AM works for the reminder' } } } : {}));
    }, 6000);
  }
}
