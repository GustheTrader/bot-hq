import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, TemplateError, planFromTemplate, publicTemplates } from '../src/bot-templates.js';

const answers = { repo: 'acme/shop', area: 'the checkout flow' };

test('software factory makes a Claude Code bot with its instructions and a weekday routine', () => {
  const plan = planFromTemplate('software-factory', answers, { timezone: 'America/New_York' });
  assert.equal(plan.harness, 'claude-code');
  assert.equal(plan.bot.name, 'Software Factory');
  assert.match(plan.bot.description, /acme\/shop/);
  assert.match(plan.bot.instructions, /the checkout flow/);
  assert.match(plan.bot.instructions, /--label software-factory/);
  assert.match(plan.bot.instructions, /at most 5 of your pull requests/);
  assert.equal(plan.routine.schedule, '0 9 * * 1-5');
  assert.equal(plan.routine.timezone, 'America/New_York');
  assert.match(plan.routine.prompt, /acme\/shop/);
});

test('a name, open-PR limit and schedule given by the person win over the defaults', () => {
  const plan = planFromTemplate('software-factory', { ...answers, maxOpen: '3', schedule: '30 7 * * 1' }, { name: 'Forge' });
  assert.equal(plan.bot.name, 'Forge');
  assert.match(plan.bot.instructions, /at most 3 of your pull requests/);
  assert.equal(plan.routine.schedule, '30 7 * * 1');
  assert.equal(plan.routine.timezone, 'UTC');
});

test('bad answers are refused with a message the person can act on', () => {
  assert.throws(() => planFromTemplate('nope', answers), TemplateError);
  assert.throws(() => planFromTemplate('software-factory', { area: 'x' }), /Repository is required/);
  assert.throws(() => planFromTemplate('software-factory', { ...answers, repo: 'not a repo' }), /owner\/name/);
  assert.throws(() => planFromTemplate('software-factory', { ...answers, maxOpen: '0' }), /1 to 20/);
  assert.throws(() => planFromTemplate('software-factory', { ...answers, schedule: 'every day' }), /schedule is not valid/);
});

test('the browser gets the template without its functions', () => {
  const [pub] = publicTemplates();
  assert.equal(pub.id, TEMPLATES[0].id);
  assert.equal(JSON.stringify(pub).includes('"instructions"'), false);
  assert.equal(typeof (pub as any).routine, 'undefined');
});

const home = { company: 'Sierra Home Pros', areas: 'Reno–Sparks, Carson City, Lake Tahoe' };

test('every Home Service template makes a Claude Code bot that works through Build-flow and never contacts customers', () => {
  for (const id of ['home-dispatch-lead', 'home-margin-watch', 'home-lead-follow-up', 'home-maintenance-plans']) {
    const plan = planFromTemplate(id, home);
    assert.equal(plan.harness, 'claude-code', id);
    assert.match(plan.bot.instructions, /Sierra Home Pros/, id);
    assert.match(plan.bot.instructions, /buildflow_jobs/, id);
    assert.match(plan.bot.instructions, /never contact homeowners/, id);
    assert.match(plan.routine.prompt, /Sierra Home Pros/, id);
  }
  assert.equal(planFromTemplate('home-dispatch-lead', home).routine.schedule, '30 6 * * 1-5');
  assert.match(planFromTemplate('home-margin-watch', { ...home, target: '35' }).bot.instructions, /below 35%/);
  assert.match(planFromTemplate('home-lead-follow-up', { ...home, staleDays: '3' }).bot.instructions, /in 3 days or more/);
});

test('Home Service answers are checked', () => {
  assert.throws(() => planFromTemplate('home-dispatch-lead', { areas: 'Reno' }), /Business name is required/);
  assert.throws(() => planFromTemplate('home-margin-watch', { ...home, target: '150' }), /1 to 99/);
  assert.throws(() => planFromTemplate('home-lead-follow-up', { ...home, staleDays: '1.5' }), /1 to 60/);
  const pub = publicTemplates().find((t) => t.id === 'home-lead-follow-up')!;
  assert.equal(pub.category, 'Home Service');
  assert.equal(typeof (pub as any).validate, 'undefined');
});

test('templates come in two kinds: technical roles in a repo, and domain roles for a business', () => {
  const kinds = new Map(publicTemplates().map((t) => [t.id, t.kind]));
  for (const id of ['software-factory', 'product-engineer', 'qa-engineer', 'code-reaper', 'latency-optimizer', 'code-health', 'technical-writer', 'migration-engineer']) {
    assert.equal(kinds.get(id), 'technical', id);
    const plan = planFromTemplate(id, { repo: 'acme/shop', area: 'checkout', goal: 'move to TypeScript' });
    assert.equal(plan.harness, 'claude-code', id);
    assert.match(plan.bot.instructions, /acme\/shop/, id);
    assert.match(plan.bot.instructions, /never merge/i, id);
    assert.throws(() => planFromTemplate(id, { repo: 'nope', area: 'x', goal: 'y' }), /owner\/name/, id);
  }
  for (const id of ['home-dispatch-lead', 'home-margin-watch', 'home-lead-follow-up', 'home-maintenance-plans']) assert.equal(kinds.get(id), 'domain', id);
  assert.equal(new Set(publicTemplates().map((t) => t.id)).size, TEMPLATES.length, 'ids are unique');
  assert.throws(() => planFromTemplate('migration-engineer', { repo: 'acme/shop' }), /The migration is required/);
  assert.match(planFromTemplate('product-engineer', { repo: 'acme/shop' }).bot.instructions, /labelled `bot:product`/);
});
