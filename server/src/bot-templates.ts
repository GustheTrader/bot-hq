import { Cron } from 'croner';
import type { AvatarColor } from './types.js';
import type { HarnessId } from './harness.js';

/**
 * Bot templates: a ready-made role a new Bot can start from. A template fills in the Bot's name, label,
 * description and standing instructions, picks the agent program it runs on, and sets up its first routine.
 * Everything a template writes is ordinary Bot data afterwards, so the person can edit any of it later.
 *
 * This file is pure (no database), so the plan a template makes can be tested on its own; routes.ts applies it.
 */

export interface TemplateInput {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  /** Used when the person leaves the field empty. */
  default?: string;
}

export interface BotTemplate {
  id: string;
  title: string;
  category: string;
  blurb: string;
  /** Tools the template expects, shown to the person before they create it. */
  worksWith: string[];
  harness: HarnessId;
  defaults: { name: string; label: string; avatarColor: AvatarColor };
  inputs: TemplateInput[];
  describe: (v: Record<string, string>) => string;
  instructions: (v: Record<string, string>) => string;
  routine: (v: Record<string, string>) => { name: string; prompt: string; schedule: string };
}

/** What the browser sees: everything but the functions. */
export type PublicTemplate = Omit<BotTemplate, 'describe' | 'instructions' | 'routine'>;

export interface TemplatePlan {
  templateId: string;
  harness: HarnessId;
  bot: { name: string; label: string; description: string; instructions: string; avatarColor: AvatarColor };
  routine: { name: string; prompt: string; schedule: string; timezone: string };
}

/** Thrown for input the person can fix; the message is shown to them. */
export class TemplateError extends Error {}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL = 'software-factory';

const softwareFactory: BotTemplate = {
  id: 'software-factory',
  title: 'Software Factory',
  category: 'Engineering',
  blurb: 'Finds bugs, polish, performance and refactoring work in the product area you name, and opens one small pull request for each with proof that it works. Learns from what you merge and close.',
  worksWith: ['GitHub (gh signed in on the computer)'],
  harness: 'claude-code',
  defaults: { name: 'Software Factory', label: 'Engineering', avatarColor: 'orange' },
  inputs: [
    { key: 'repo', label: 'Repository', placeholder: 'owner/name', required: true, help: 'The GitHub repository it works in.' },
    { key: 'area', label: 'Product area', placeholder: 'e.g. the checkout flow, or web/src/components/revopt', required: true, help: 'Where it looks for work. A feature, a folder, or both.' },
    { key: 'maxOpen', label: 'Most open pull requests at once', default: '5', help: 'It stops opening new ones while this many are waiting for review.' },
    { key: 'schedule', label: 'When it runs', default: '0 9 * * 1-5', help: 'Cron: minute hour day month weekday. Default is weekdays at 9:00.' },
  ],
  describe: (v) => `Software Factory for ${v.repo}: finds and fixes small problems in ${v.area}, one pull request each.`,
  instructions: (v) => `You are a software factory for the repository ${v.repo}. Your area is: ${v.area}.

## What you do
Find small, real improvements in your area and ship each one as its own pull request:
- bugs (wrong behaviour, crashes, unhandled errors, broken edge cases),
- polish (confusing copy, layout glitches, missing empty or loading states),
- performance (slow queries, wasted renders, needless work in hot paths),
- refactors that make the next change easier, without changing behaviour.

## Rules for every pull request
1. One concern per pull request, small enough to review in a few minutes (aim for under ~200 changed lines).
2. Work on a new branch named \`factory/<short-slug>\`. Never push to the default branch and never merge anything yourself.
3. Show proof that it works in the description: the tests you added or ran and their output, a before/after measurement for performance work, or a screenshot for visible changes. If you cannot prove it, do not open it.
4. Add the label \`${LABEL}\` (create it if it does not exist) so your work is easy to find and so you can learn from it.
5. Explain in two or three plain sentences what was wrong, what you changed, and how a reviewer can check it.
6. Keep at most ${v.maxOpen} of your pull requests open at once. When that many are waiting, do not open more: say so and stop.

## Learning from reviews
At the start of each run, look at your earlier pull requests (\`gh pr list --repo ${v.repo} --label ${LABEL} --state all\`). For each one merged or closed since you last looked, note in your memory what kind of change it was and, for closed ones, why it was turned down (read the review comments). Prefer the kinds of change that get merged and stop proposing the kinds that get closed.

## Tools
Use git and the GitHub command line (\`gh\`) on your computer. If \`gh auth status\` says you are not signed in, ask the user to sign the computer in to GitHub from Bot HQ's settings, and stop until they have.

At the end of each run, reply with a short list: pull requests opened (with links), pull requests you learned from, and anything you skipped and why.`,
  routine: (v) => ({
    name: 'Software Factory run',
    schedule: v.schedule,
    prompt: `Run the software factory for ${v.repo} (area: ${v.area}). First learn from your merged and closed pull requests, then, if fewer than ${v.maxOpen} of yours are open, find the most valuable small improvements and open one pull request for each, with proof. Finish with the short summary.`,
  }),
};

export const TEMPLATES: BotTemplate[] = [softwareFactory];

export const publicTemplates = (): PublicTemplate[] =>
  TEMPLATES.map(({ describe: _d, instructions: _i, routine: _r, ...rest }) => rest);

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Checks the person's answers and turns a template into the Bot and routine to create. */
export function planFromTemplate(
  templateId: string,
  answers: Record<string, unknown> = {},
  opts: { name?: string; timezone?: string } = {},
): TemplatePlan {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new TemplateError('That template does not exist.');

  const v: Record<string, string> = {};
  for (const input of t.inputs) {
    const given = clean(answers[input.key], 300);
    const value = given || input.default || '';
    if (input.required && !value) throw new TemplateError(`${input.label} is required.`);
    v[input.key] = value;
  }

  if (t.id === 'software-factory') {
    if (!REPO.test(v.repo)) throw new TemplateError('Repository must look like owner/name.');
    const n = Number(v.maxOpen);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new TemplateError('Most open pull requests must be a whole number from 1 to 20.');
    v.maxOpen = String(n);
  }

  const timezone = clean(opts.timezone, 60) || 'UTC';
  const routine = t.routine(v);
  try { new Cron(routine.schedule, { paused: true, timezone }); }
  catch (e: any) { throw new TemplateError(`That schedule is not valid: ${e?.message ?? e}`); }

  return {
    templateId: t.id,
    harness: t.harness,
    bot: {
      name: clean(opts.name, 60) || t.defaults.name,
      label: t.defaults.label,
      description: t.describe(v),
      instructions: t.instructions(v),
      avatarColor: t.defaults.avatarColor,
    },
    routine: { ...routine, timezone },
  };
}
