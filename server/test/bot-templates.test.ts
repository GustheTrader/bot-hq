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
