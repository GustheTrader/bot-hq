import { useEffect, useMemo, useState } from 'react';
import type { Bot, LiveState, Task } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { isWaitingForYou } from '../../lib/phrases';
import { useVersion } from '../../configStore';
import { useStore } from '../../store';

/** A task still marked "working", whose bot is not running, with no update for this long, counts as stalled. */
export const STALL_MS = 30 * 60_000;

/** Tasks for everyone (or one bot), refetched whenever the server says tasks changed. `null` while loading. */
export function useTasks(botId?: string): Task[] | null {
  const v = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => { if (alive) setTasks(r.tasks); }).catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [botId, v]);
  return tasks;
}

export interface Attention {
  /** Bots that asked a multiple-choice question and are waiting for the answer. */
  questions: Bot[];
  /** Bots waiting on the person for something else (an approval, connecting an app). */
  approvals: Bot[];
  /** Tasks marked "waiting on you" whose bot is not already listed above. */
  waitingTasks: Task[];
  /** Tasks that say they are being worked on but have gone quiet. */
  stalled: Task[];
  total: number;
}

/**
 * Everything that needs the person: questions, approvals, tasks waiting on them, and work that has stalled.
 * A bot that is waiting shows up once, as itself, rather than again as its own waiting task.
 */
export function deriveAttention(tasks: Task[] | null, bots: Bot[], live: Record<string, LiveState>, now: number): Attention {
  const agents = bots.filter((b) => b.kind !== 'team');
  const since = (b: Bot) => live[b.id]?.awaiting?.since ?? 0;
  const questions = agents.filter((b) => !!live[b.id]?.question).sort((a, b) => since(a) - since(b));
  const approvals = agents.filter((b) => isWaitingForYou(live[b.id]) && !live[b.id]?.question).sort((a, b) => since(a) - since(b));
  const listed = new Set([...questions, ...approvals].map((b) => b.id));
  const all = tasks ?? [];
  const waitingTasks = all.filter((t) => t.state === 'needs_input' && !listed.has(t.botId)).sort((a, b) => a.updatedAt - b.updatedAt);
  const stalled = all
    .filter((t) => t.state === 'working' && !live[t.botId]?.isRunning && !isWaitingForYou(live[t.botId]) && now - t.updatedAt >= STALL_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  return { questions, approvals, waitingTasks, stalled, total: questions.length + approvals.length + waitingTasks.length + stalled.length };
}

/** Live version of deriveAttention. The clock ticks once a minute so a task can turn "stalled" while the page is open. */
export function useAttention(): Attention {
  const tasks = useTasks();
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => deriveAttention(tasks, bots, live, now), [tasks, bots, live, now]);
}
