import { Cron } from 'croner';
import type { AvatarColor } from './types.js';
import type { HarnessId } from './harness.js';
import { portraitPreset } from './portraits.js';

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

/**
 * technical: a software role that works in a code repository (like Devin's bot gallery).
 * domain: a business role for one kind of company (Home Service first), working in the team's business apps.
 */
export type TemplateKind = 'technical' | 'domain';

export interface BotTemplate {
  id: string;
  kind: TemplateKind;
  title: string;
  /** For technical templates the area (Engineering, Quality...); for domain templates the business domain. */
  category: string;
  blurb: string;
  /** Tools the template expects, shown to the person before they create it. */
  worksWith: string[];
  harness: HarnessId;
  defaults: { name: string; label: string; avatarColor: AvatarColor };
  /** Name of the preset portrait (portraits.ts) its bots start with. */
  portrait: string;
  inputs: TemplateInput[];
  describe: (v: Record<string, string>) => string;
  instructions: (v: Record<string, string>) => string;
  routine: (v: Record<string, string>) => { name: string; prompt: string; schedule: string };
  /** Extra checks on the answers; throws TemplateError. May normalise values in place. */
  validate?: (v: Record<string, string>) => void;
  /** App connections the bot cannot do its job without (their tools only exist while connected). */
  requires?: Requirement[];
}

export type Requirement = 'buildflow';
const REQUIREMENT_NAMES: Record<Requirement, string> = { buildflow: 'Build-flow' };

/** What the browser sees: everything but the functions. */
export type PublicTemplate = Omit<BotTemplate, 'describe' | 'instructions' | 'routine' | 'validate'> & {
  /** Names of required connections that are not set up here; the template cannot be used until they are. */
  missing: string[];
};

export interface TemplatePlan {
  templateId: string;
  harness: HarnessId;
  bot: { name: string; label: string; description: string; instructions: string; avatarColor: AvatarColor; avatarImage: string };
  routine: { name: string; prompt: string; schedule: string; timezone: string };
}

/** Thrown for input the person can fix; the message is shown to them. */
export class TemplateError extends Error {}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL = 'software-factory';

const softwareFactory: BotTemplate = {
  id: 'software-factory',
  kind: 'technical',
  title: 'Software Factory',
  category: 'Engineering',
  blurb: 'Finds bugs, polish, performance and refactoring work in the product area you name, and opens one small pull request for each with proof that it works. Learns from what you merge and close.',
  worksWith: ['GitHub (gh signed in on the computer)'],
  harness: 'claude-code',
  defaults: { name: 'Software Factory', label: 'Engineering', avatarColor: 'orange' },
  portrait: 'Android Composer',
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
2. Work on a new branch named \`bot/${LABEL}/<short-slug>\`. Never push to the default branch and never merge anything yourself.
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
  validate: (v) => {
    if (!REPO.test(v.repo)) throw new TemplateError('Repository must look like owner/name.');
    const n = Number(v.maxOpen);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new TemplateError('Most open pull requests must be a whole number from 1 to 20.');
    v.maxOpen = String(n);
  },
};

// ---------- Technical: software roles that work in one GitHub repository through git and gh ----------

const ENG_INPUTS: TemplateInput[] = [
  { key: 'repo', label: 'Repository', placeholder: 'owner/name', required: true, help: 'The GitHub repository it works in.' },
];

const engBase = (v: Record<string, string>, role: string, label: string) => `You are the ${role} for the repository ${v.repo}.

Use git and the GitHub command line (\`gh\`) on your computer. If \`gh auth status\` says you are not signed in, ask the user to sign the computer in to GitHub from Bot HQ's settings, and stop until they have.

Rules for every pull request you open:
- Work on a new branch named \`bot/${label}/<short-slug>\`. Never push to the default branch and never merge anything yourself.
- One concern per pull request, small enough to review in a few minutes.
- Show proof in the description: the tests you added or ran and their output, a measurement, or a screenshot. If you cannot prove it, do not open it.
- Add the label \`${label}\` (create it if it does not exist).
- Say in two or three plain sentences what was wrong, what you changed, and how a reviewer can check it.

End each run with a short list: what you opened or commented on (with links), and anything you skipped and why.`;

type EngSpec = Omit<BotTemplate, 'kind' | 'harness' | 'inputs' | 'worksWith' | 'validate'> & { extraInputs?: TemplateInput[]; worksWith?: string[] };

const engTemplate = ({ extraInputs = [], worksWith = ['GitHub (gh signed in on the computer)'], ...rest }: EngSpec): BotTemplate => ({
  ...rest, kind: 'technical', harness: 'claude-code', worksWith, inputs: [...ENG_INPUTS, ...extraInputs],
  validate: (v) => { if (!REPO.test(v.repo)) throw new TemplateError('Repository must look like owner/name.'); },
});

const scheduleInput = (def: string, what: string): TemplateInput => ({ key: 'schedule', label: 'When it runs', default: def, help: `Cron: minute hour day month weekday. Default is ${what}.` });

const productEngineer = engTemplate({
  id: 'product-engineer',
  portrait: 'Neon Hacker',
  title: 'Product Engineer',
  category: 'Engineering',
  blurb: 'Builds features and fixes bugs from GitHub issues you label for it, taking each one all the way to a tested pull request and seeing it through review.',
  defaults: { name: 'Product Engineer', label: 'Engineering', avatarColor: 'violet' },
  extraInputs: [
    { key: 'issueLabel', label: 'Issue label it picks up', default: 'bot:product', help: 'Label an issue with this to hand it over.' },
    scheduleInput('0 9-17/2 * * 1-5', 'every two hours on weekdays, 9:00 to 17:00'),
  ],
  describe: (v) => `Product engineer for ${v.repo}: takes issues labelled ${v.issueLabel} to tested pull requests.`,
  instructions: (v) => `${engBase(v, 'product engineer', 'product-engineer')}

## Each run
1. Answer review comments on your open pull requests first: push fixes, reply to each comment, and re-request review.
2. Then take the oldest open issue labelled \`${v.issueLabel}\` that has no linked pull request. Comment on it that you are starting.
3. If the issue is unclear, ask one precise question on the issue and move to the next one.
4. Build it with tests, run the full test suite, and open a pull request that closes the issue.`,
  routine: (v) => ({ name: 'Product engineering run', schedule: v.schedule, prompt: `Work ${v.repo}: answer review comments on your open pull requests, then take the oldest issue labelled ${v.issueLabel} to a tested pull request.` }),
});

const qaEngineer = engTemplate({
  id: 'qa-engineer',
  portrait: 'Tokyo Detective',
  title: 'QA Engineer',
  category: 'Quality',
  blurb: 'Tests each new pull request: runs the suite and walks the changed screens in a real browser on its computer, then posts pass or fail on the pull request with the steps and screenshots.',
  defaults: { name: 'QA Engineer', label: 'Quality', avatarColor: 'red' },
  extraInputs: [
    { key: 'runApp', label: 'How to run the app', default: 'npm install && npm run dev', help: 'The command that starts the app locally for testing.' },
    scheduleInput('0 * * * 1-5', 'every hour on weekdays'),
  ],
  describe: (v) => `QA for ${v.repo}: tests each new pull request and reports pass or fail on it.`,
  instructions: (v) => `${engBase(v, 'QA engineer', 'qa-checked')}

## Each run
1. Find open pull requests in ${v.repo} updated since you last reviewed them (skip drafts and your own).
2. Check out each one in a scratch folder, run the test suite, and start the app with \`${v.runApp}\`.
3. Read the diff and the description, then use the browser on your screen to walk through every screen or flow the change touches, plus one nearby flow that could break. Take screenshots.
4. Comment on the pull request: PASS or FAIL first, then the steps you took, what you saw, and screenshots. For a failure, give exact steps to reproduce.
5. Add the label \`qa-checked\`. You do not open pull requests yourself.`,
  routine: (v) => ({ name: 'QA pass', schedule: v.schedule, prompt: `Test every open ${v.repo} pull request updated since your last pass: run the suite, walk the changed flows in the browser, and post PASS or FAIL with steps and screenshots.` }),
});

const codeReaper = engTemplate({
  id: 'code-reaper',
  portrait: 'Chrome Skull',
  title: 'Code Reaper',
  category: 'Quality',
  blurb: 'Finds code nothing uses any more (dead files, unused exports, stale scripts) and removes it in small, safe pull requests, once a week.',
  defaults: { name: 'Code Reaper', label: 'Quality', avatarColor: 'gray' },
  extraInputs: [scheduleInput('0 10 * * 2', 'Tuesdays at 10:00')],
  describe: (v) => `Removes unused code from ${v.repo} in small, safe pull requests each week.`,
  instructions: (v) => `${engBase(v, 'code reaper', 'code-reaper')}

## Each run
1. Find code that nothing uses: unreferenced files, unused exports and functions, dead feature branches in code, scripts no workflow calls. Prove each with a search for every way it could be reached (imports, dynamic requires, config, routes, tests, docs).
2. Leave alone anything public (a package export, an API route, a CLI command) unless you can show it is unused outside the repo too.
3. Remove one coherent group per pull request, run the build and the full test suite, and list the searches that prove it is unused.
4. Open at most three pull requests per run.`,
  routine: (v) => ({ name: 'Weekly dead code sweep', schedule: v.schedule, prompt: `Find unused code in ${v.repo} and remove it in up to three small pull requests, each with the searches that prove it is unused and a passing build and test run.` }),
});

const latencyOptimizer = engTemplate({
  id: 'latency-optimizer',
  portrait: 'Racing Engineer',
  title: 'Latency Optimizer',
  category: 'Quality',
  blurb: 'Finds the slowest endpoints, jobs and queries, and each week tries a fix for the worst one, opening a pull request with before and after timings.',
  defaults: { name: 'Latency Optimizer', label: 'Quality', avatarColor: 'yellow' },
  extraInputs: [scheduleInput('0 10 * * 3', 'Wednesdays at 10:00')],
  describe: (v) => `Speeds up the slowest path in ${v.repo} each week, with before and after timings.`,
  instructions: (v) => `${engBase(v, 'latency optimizer', 'latency')}

## Each run
1. Find the slowest paths: read logs or traces if the repo has them, otherwise benchmark the main endpoints, jobs and database queries locally. Look for N+1 queries, missing indexes, repeated work in loops, and blocking calls.
2. Pick the single worst one you can fix safely. Measure it before (several runs, report the median).
3. Fix it, measure again the same way, and run the full test suite.
4. Open one pull request with the before and after numbers, how you measured, and why behaviour is unchanged. If nothing improves by at least 20%, open nothing and report what you tried.`,
  routine: (v) => ({ name: 'Weekly latency fix', schedule: v.schedule, prompt: `Find the slowest endpoint, job or query in ${v.repo}, measure it, fix it, and open one pull request with before and after timings (only if it improves by 20% or more).` }),
});

const codeHealth = engTemplate({
  id: 'code-health',
  portrait: 'Arcane Scientist',
  title: 'Code Health Engineer',
  category: 'Quality',
  blurb: 'Once a month: patches known vulnerabilities, updates old dependencies and removes stale feature flags, in small pull requests that each say why the change is safe.',
  defaults: { name: 'Code Health', label: 'Quality', avatarColor: 'green' },
  extraInputs: [scheduleInput('0 10 1 * *', 'the 1st of each month at 10:00')],
  describe: (v) => `Monthly dependency updates, vulnerability patches and flag clean-up for ${v.repo}.`,
  instructions: (v) => `${engBase(v, 'code health engineer', 'code-health')}

## Each run
1. Vulnerabilities first: run the ecosystem's audit (\`npm audit\`, \`pip-audit\`, etc.) and patch what has a fix, one pull request per advisory or tight group.
2. Then dependencies: update patch and minor versions in one pull request; give each major upgrade its own pull request with the changelog notes that matter.
3. Then stale feature flags: flags fully on (or off) everywhere for a long time. Remove the flag and the dead branch.
4. For each pull request say why it is safe: changelog read, tests run, what you checked by hand.`,
  routine: (v) => ({ name: 'Monthly code health', schedule: v.schedule, prompt: `Run monthly code health on ${v.repo}: patch vulnerabilities, update dependencies (majors separately), and remove stale feature flags, each in a small pull request that says why it is safe.` }),
});

const technicalWriter = engTemplate({
  id: 'technical-writer',
  portrait: 'Lime Archivist',
  title: 'Technical Writer',
  category: 'Knowledge',
  blurb: "Keeps the repo's README, docs and diagrams in step with main: after merges that change behaviour, it opens a pull request updating the docs.",
  defaults: { name: 'Technical Writer', label: 'Knowledge', avatarColor: 'brown' },
  extraInputs: [
    { key: 'docs', label: 'Where the docs live', default: 'README.md and docs/', help: 'Files or folders it keeps up to date.' },
    scheduleInput('0 17 * * 1-5', 'weekdays at 17:00'),
  ],
  describe: (v) => `Keeps ${v.docs} in ${v.repo} up to date with what merges.`,
  instructions: (v) => `${engBase(v, 'technical writer', 'docs')}

## Each run
1. List pull requests merged into the default branch since your last run.
2. For each one that changes behaviour, setup, configuration or an API, check ${v.docs}. Note anything now wrong or missing.
3. Open one pull request with all the doc updates for the day, linking each change to the pull request that caused it. Keep the existing voice; plain words, short sentences.
4. If nothing needs changing, open nothing and say so.`,
  routine: (v) => ({ name: 'Docs catch-up', schedule: v.schedule, prompt: `Check today's merges into ${v.repo} and open one pull request updating ${v.docs} for anything they changed.` }),
});

const migrationEngineer = engTemplate({
  id: 'migration-engineer',
  portrait: 'Fox Scout',
  title: 'Migration Engineer',
  category: 'Engineering',
  blurb: 'Owns one big migration and ships it as small, tracked pull requests, keeping one tracking issue current with progress and what is stuck.',
  defaults: { name: 'Migration Engineer', label: 'Engineering', avatarColor: 'cyan' },
  extraInputs: [
    { key: 'goal', label: 'The migration', placeholder: 'e.g. move from Express to Hono, or JavaScript to TypeScript', required: true },
    scheduleInput('0 10 * * 1-5', 'weekdays at 10:00'),
  ],
  describe: (v) => `Migration in ${v.repo}: ${v.goal}, as small tracked pull requests.`,
  instructions: (v) => `${engBase(v, 'migration engineer', 'migration')}

The migration you own: ${v.goal}.

## How you work
1. Keep one tracking issue titled "Migration: ${v.goal}". On the first run, create it with a checklist of every piece of work, in an order where each step leaves the app working.
2. Each run: take the next unchecked item, ship it as one small pull request linked from the issue, and tick it when it merges.
3. Update the tracking issue at the end of each run: done, in review, next, and anything blocked and who can unblock it.
4. Never leave the default branch half-migrated: every pull request must build and pass the tests on its own.`,
  routine: (v) => ({ name: 'Migration step', schedule: v.schedule, prompt: `Advance the migration in ${v.repo} (${v.goal}): ship the next item on the tracking issue as one small pull request, then update the issue.` }),
});

// ---------- Home Service: a residential service business run out of Build-flow ----------
// Jobs with written estimates (budget), schedules, daily logs, change orders (written add-ons) and a leads pipeline
// are all Build-flow; these bots read and write them through the app's buildflow_* tools.

const HOME_INPUTS: TemplateInput[] = [
  { key: 'company', label: 'Business name', placeholder: 'e.g. Sierra Home Pros', required: true },
  { key: 'areas', label: 'Service area', placeholder: 'e.g. Reno–Sparks, Carson City, Lake Tahoe', required: true, help: 'The towns or regions your crews cover. Used for weather and routing.' },
  { key: 'services', label: 'Services', default: 'handyman repairs, painting, smart-home installs, maintenance plans, senior safety upgrades', help: 'What you sell, in a few words.' },
];

const homeBase = (v: Record<string, string>, role: string) => `You are the ${role} for ${v.company}, a residential home-service business. Services: ${v.services}. Service area: ${v.areas}.

Jobs, written estimates (each job's budget), schedules, daily logs, change orders and the sales pipeline live in Build-flow. Use the buildflow_* tools for them (buildflow_jobs, buildflow_job, buildflow_add_daily_log, buildflow_add_schedule_item, buildflow_update_schedule_item, buildflow_draft_change_order, buildflow_leads, buildflow_update_lead).

House rules:
- Upfront pricing: no extra work starts without a written price. Extra scope becomes a draft change order; a person sends it to the homeowner from Build-flow.
- You never contact homeowners yourself and never send anything to a customer. You draft; people send.
- Use real numbers from Build-flow. If something is missing, say what is missing instead of guessing.
- Keep replies short: what needs a person today first, then the rest.`;

type HomeSpec = Omit<BotTemplate, 'kind' | 'category' | 'harness' | 'inputs' | 'worksWith'> & { extraInputs?: TemplateInput[] };

const homeTemplate = ({ extraInputs = [], ...rest }: HomeSpec): BotTemplate => ({
  ...rest, kind: 'domain', category: 'Home Service', harness: 'claude-code', worksWith: ['Build-flow'], requires: ['buildflow'], inputs: [...HOME_INPUTS, ...extraInputs],
});

const wholeNumber = (v: Record<string, string>, key: string, label: string, min: number, max: number) => {
  const n = Number(v[key]);
  if (!Number.isInteger(n) || n < min || n > max) throw new TemplateError(`${label} must be a whole number from ${min} to ${max}.`);
  v[key] = String(n);
};

const dispatchLead = homeTemplate({
  id: 'home-dispatch-lead',
  portrait: 'Scarlet Pilot',
  title: 'Dispatch Lead',
  blurb: "Runs the morning dispatch huddle: ranks today's jobs by risk (cost pace vs. progress, weather, schedule slips), writes a crew checklist for each, and flags what needs a person before vans roll.",
  defaults: { name: 'Dispatch Lead', label: 'Home Service', avatarColor: 'blue' },
  extraInputs: [{ key: 'schedule', label: 'Huddle time', default: '30 6 * * 1-5', help: 'Cron. Default is weekdays at 6:30.' }],
  describe: (v) => `Morning dispatch huddle for ${v.company}: today's top job risks and crew checklists.`,
  instructions: (v) => `${homeBase(v, 'dispatch lead')}

## Each morning
1. List active jobs and open each one scheduled today or overdue.
2. Rank the top 3 by risk. Risk rises when budget used runs ahead of work completed (e.g. 90% of the estimate spent at 78% done), when a schedule item has slipped, and when weather threatens exterior work (painting, stain, ladders) in ${v.areas}. Look up today's forecast for the job's town.
3. For each of the top 3: one line on why it is at risk, the one decision that protects the margin or the date, and a 3-item crew checklist (materials to load, the quality check, what to tell the homeowner about the arrival window).
4. If exterior work should be held for weather, say which job and propose the new date; move the schedule item only if a person agrees.
5. End with anything that needs a person before 8 AM.`,
  routine: (v) => ({ name: 'Morning dispatch huddle', schedule: v.schedule, prompt: `Run today's morning dispatch huddle for ${v.company}: top 3 job risks with a crew checklist each, weather holds for exterior work in ${v.areas}, and what needs a person before 8 AM.` }),
});

const marginWatch = homeTemplate({
  id: 'home-margin-watch',
  portrait: 'Gold Monocle',
  title: 'Estimate & Margin Watch',
  blurb: "Compares every active job's spend against its written estimate, flags jobs whose cost is running ahead of progress, and drafts written add-on change orders for extra scope so no work starts unpriced.",
  defaults: { name: 'Margin Watch', label: 'Home Service', avatarColor: 'green' },
  extraInputs: [
    { key: 'target', label: 'Target gross margin %', default: '30', help: 'Jobs projected below this are flagged.' },
    { key: 'schedule', label: 'When it checks', default: '0 12 * * 1-5', help: 'Cron. Default is weekdays at noon.' },
  ],
  describe: (v) => `Job costing for ${v.company}: spend vs. written estimate, margin below ${v.target}%, and draft add-ons for extra scope.`,
  instructions: (v) => `${homeBase(v, 'estimate and margin watcher')}

## Each check
1. For every active job, compare budget used with work completed. Flag a job when cost pace runs more than 10 points ahead of progress, or when its projected gross margin falls below ${v.target}%.
2. For each flagged job: the numbers (cost / estimate, % used vs % done, dollars left), the likely cause from its daily logs, and one concrete fix (pair crews for the final coat, consolidate visits, order materials once).
3. When daily logs mention work outside the written estimate (an extra door, more drywall, a second room), draft a change order with buildflow_draft_change_order: priced lines with markup and any schedule impact. Say it is a draft waiting for a person to send.
4. Finish with a one-line portfolio view: total estimates, total spend, and the jobs most at risk.`,
  routine: (v) => ({ name: 'Estimate vs. cost check', schedule: v.schedule, prompt: `Check every active ${v.company} job against its written estimate: flag cost running ahead of progress or margin under ${v.target}%, draft add-on change orders for unpriced extra scope, and give the portfolio view.` }),
  validate: (v) => wholeNumber(v, 'target', 'Target gross margin', 1, 99),
});

const leadFollowUp = homeTemplate({
  id: 'home-lead-follow-up',
  portrait: 'Indigo Strategist',
  title: 'Lead Follow-up',
  blurb: 'Works the sales pipeline: finds leads that have gone quiet, moves stages, adds notes, and drafts the next message and the written estimate for a person to send.',
  defaults: { name: 'Lead Follow-up', label: 'Home Service', avatarColor: 'violet' },
  extraInputs: [
    { key: 'staleDays', label: 'Follow up after (days)', default: '2', help: 'A lead with no activity this long gets a follow-up.' },
    { key: 'schedule', label: 'When it runs', default: '0 9,15 * * 1-5', help: 'Cron. Default is weekdays at 9:00 and 15:00.' },
  ],
  describe: (v) => `Sales pipeline for ${v.company}: follows up leads quiet for ${v.staleDays}+ days and drafts estimates.`,
  instructions: (v) => `${homeBase(v, 'lead follow-up coordinator')}

## Each run
1. Read the pipeline with buildflow_leads.
2. For each open lead with no activity in ${v.staleDays} days or more: decide the next step (call back, book a site visit, send the written estimate, check in after the estimate). Add a note with buildflow_update_lead saying what you recommend and why, and move the stage only when the history shows it already happened.
3. Draft the follow-up message for a person to send: two or three friendly sentences in the business's voice, with the clear next step (a visit time window, or the estimate total and what it covers).
4. For leads ready for an estimate, outline it: the line items, a price range from similar past jobs if you can see them, and what to confirm on site.
5. Finish with: leads touched, the drafts waiting to be sent, and pipeline value by stage.`,
  routine: (v) => ({ name: 'Lead follow-up', schedule: v.schedule, prompt: `Work ${v.company}'s sales pipeline: follow up every lead quiet for ${v.staleDays}+ days with a note and a drafted message, outline estimates for leads ready for one, and report pipeline value by stage.` }),
  validate: (v) => wholeNumber(v, 'staleDays', 'Follow up after', 1, 60),
});

const maintenancePlans = homeTemplate({
  id: 'home-maintenance-plans',
  portrait: 'Volt Mechanic',
  title: 'Maintenance Plans',
  blurb: 'Keeps recurring maintenance-plan members on schedule: books seasonal visits, batches nearby homes onto one van day to cut drive time, and flags renewals coming due.',
  defaults: { name: 'Maintenance Plans', label: 'Home Service', avatarColor: 'cyan' },
  extraInputs: [{ key: 'schedule', label: 'When it plans', default: '0 7 * * 1', help: 'Cron. Default is Mondays at 7:00.' }],
  describe: (v) => `Maintenance-plan scheduling for ${v.company}: seasonal visits, batched van days and renewals.`,
  instructions: (v) => `${homeBase(v, 'maintenance plan coordinator')}

## Each week
1. Find maintenance-plan jobs in Build-flow (their name or client notes say maintenance plan) and what each plan covers this season (for winter in ${v.areas}: irrigation blow-out and hose bibs, furnace filter, smoke and CO detectors, gutters, weather-stripping).
2. Propose this week's and next week's visits, batching homes in the same town onto the same van day to save drive time. Say roughly how much drive time the batching saves.
3. Add the agreed visits as schedule items with buildflow_add_schedule_item only after a person approves the plan; until then, list them as a proposal.
4. Flag plans whose renewal is due within 30 days and draft a short renewal note for a person to send.
5. Finish with: visits proposed, visits booked, renewals due, and member count.`,
  routine: (v) => ({ name: 'Weekly maintenance plan schedule', schedule: v.schedule, prompt: `Plan this week's and next week's ${v.company} maintenance-plan visits, batched by town in ${v.areas}; list renewals due within 30 days with draft notes; book visits only after approval.` }),
});

export const TEMPLATES: BotTemplate[] = [
  // technical
  softwareFactory, productEngineer, qaEngineer, codeReaper, latencyOptimizer, codeHealth, technicalWriter, migrationEngineer,
  // domain: Home Service
  dispatchLead, marginWatch, leadFollowUp, maintenancePlans,
];

const missingFor = (t: BotTemplate, available: ReadonlySet<Requirement>) =>
  (t.requires ?? []).filter((r) => !available.has(r)).map((r) => REQUIREMENT_NAMES[r]);

/** `available`: the connections set up on this server (e.g. Build-flow). */
export const publicTemplates = (available: ReadonlySet<Requirement> = new Set()): PublicTemplate[] =>
  TEMPLATES.map((t) => {
    const { describe: _d, instructions: _i, routine: _r, validate: _v, ...rest } = t;
    return { ...rest, missing: missingFor(t, available) };
  });

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Checks the person's answers and turns a template into the Bot and routine to create. */
export function planFromTemplate(
  templateId: string,
  answers: Record<string, unknown> = {},
  opts: { name?: string; timezone?: string; available?: ReadonlySet<Requirement> } = {},
): TemplatePlan {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new TemplateError('That template does not exist.');
  const missing = missingFor(t, opts.available ?? new Set());
  if (missing.length) throw new TemplateError(`${t.title} needs ${missing.join(' and ')} connected to this Bot HQ first.`);

  const v: Record<string, string> = {};
  for (const input of t.inputs) {
    const given = clean(answers[input.key], 300);
    const value = given || input.default || '';
    if (input.required && !value) throw new TemplateError(`${input.label} is required.`);
    v[input.key] = value;
  }

  t.validate?.(v);

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
      avatarImage: portraitPreset(t.portrait),
    },
    routine: { ...routine, timezone },
  };
}
