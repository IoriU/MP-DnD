import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checks, coverage, poolCounts } from '../client/codex/checks.ts';
import { liveData, monsterUsage, usedAsFoe, type CodexData } from '../client/codex/data.ts';
import { ACTS } from '../shared/rules.ts';
import { SKILLS, type StatusId } from '../shared/skills.ts';

const errors = (d: CodexData) => checks(d).filter((c) => c.level === 'error');

test('the game data has no broken references (pool checks report no errors)', () => {
  const bad = errors(liveData());
  assert.deepEqual(bad, [], bad.map((c) => `${c.pool}: ${c.text}`).join('\n'));
});

test('checks come back errors first, then warnings, then info', () => {
  const order = { error: 0, warn: 1, info: 2 };
  const levels = checks(liveData()).map((c) => order[c.level]);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.ok(levels.includes(2), 'the coverage goals show up as info');
});

test('a bad encounter, escort, boss or ally monster id is an error', () => {
  const d = liveData();
  const acts = structuredClone(ACTS);
  acts[0].encounters.push({ name: 'Bad Nest', monsters: ['rat', 'no_such_rat'] });
  acts[0].escorts.hobgoblin.push('no_such_escort');
  acts[1].boss = 'no_such_boss';
  const bad = errors({ ...d, acts, allies: { ...d.allies, ghost: { monster: 'no_such_ally', desc: '', names: [] } } });
  const texts = bad.map((c) => c.text).join('\n');
  for (const id of ['no_such_rat', 'no_such_escort', 'no_such_boss', 'no_such_ally']) assert.match(texts, new RegExp(id));
  assert.equal(bad.length, 4);
});

test('an elite without an escorts entry is an error, and an unused monster is a warning', () => {
  const d = liveData();
  const acts = structuredClone(ACTS);
  delete acts[0].escorts.mimic;
  const bad = errors({ ...d, acts });
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /no escorts entry/);
  const lonely = { ...d, monsters: { ...d.monsters, lonely: { ...d.monsters.rat, name: 'Lonely Rat' } } };
  assert.ok(checks(lonely).some((c) => c.level === 'warn' && c.id === 'lonely' && /not used/.test(c.text)));
  assert.ok(checks(lonely).some((c) => c.level === 'warn' && c.id === 'lonely' && c.pool === 'sprites'));
});

test('skills: a branch without its twin, and a start skill from another class, are errors', () => {
  const d = liveData();
  const skills = structuredClone(SKILLS);
  delete skills.fire_bolt.b;
  const bad = errors({ ...d, skills });
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /III-A but no III-B/);

  const classes = structuredClone(d.classes);
  classes.fighter.start = ['longsword', 'fire_bolt', 'not_a_skill'] as typeof classes.fighter.start;
  const texts = errors({ ...d, classes }).map((c) => c.text).join('\n');
  assert.match(texts, /fire_bolt.*wizard pool/);
  assert.match(texts, /not_a_skill.*not in SKILLS/);
});

test('events: duplicate ids and acts outside 1-3 are errors', () => {
  const d = liveData();
  const bad = errors({ ...d, events: [...d.events, { ...d.events[0] }, { ...d.events[1], id: 'odd', acts: [0, 4] }] });
  assert.equal(bad.length, 3);
  assert.ok(bad.some((c) => /Duplicate event id/.test(c.text)));
  assert.equal(bad.filter((c) => /acts lists/.test(c.text)).length, 2);
});

test('a status nobody applies is a warning; tricks, riders, help and orders count as applying one', () => {
  const d = liveData();
  const statuses = { ...d.statuses, ghosted: { name: 'Ghosted', icon: '👻', good: false, desc: '' } };
  const warn = checks({ ...d, statuses }).find((c) => c.pool === 'statuses' && c.id === 'ghosted');
  assert.equal(warn?.level, 'warn');
  // A monster's trick or rider that applies it makes it used.
  for (const via of ['trick', 'rider'] as const) {
    const ghost = { id: 'ghosted' as StatusId, turns: 1 };
    const rat = via === 'trick' ? { ...d.monsters.rat, trick: { name: 'Boo', icon: '👻', verb: 'boos', range: 1, status: [ghost], cooldown: 1 } } : { ...d.monsters.rat, rider: { status: ghost, text: 'boos {target}' } };
    assert.ok(!checks({ ...d, statuses, monsters: { ...d.monsters, rat } }).some((c) => c.pool === 'statuses' && c.id === 'ghosted'), via);
  }
  // The real statuses: every one is applied by something (netted by the Kobold's trick, charging by leader orders, ...).
  assert.deepEqual(checks(d).filter((c) => c.pool === 'statuses'), []);
  // A status the game applies but doesn't define is an error.
  const noDef = { ...d.statuses } as Record<string, (typeof d.statuses)[string]>;
  delete noDef.netted;
  assert.ok(errors({ ...d, statuses: noDef }).some((c) => c.pool === 'statuses' && c.id === 'netted'));
});

test('monster usage covers pools, encounters, elites and allies; coverage counts events per act', () => {
  const d = liveData();
  const u = monsterUsage(d);
  assert.deepEqual(u.rat.pool, [1]);
  assert.ok(u.goblin.encounters.some((e) => e.name === 'Goblin Patrol' && e.count === 2));
  assert.deepEqual(u.hobgoblin.elite, [1]);
  assert.deepEqual(u.sellsword.ally, ['sellsword']);
  assert.ok(!usedAsFoe(u.sellsword));
  const events = coverage(d).filter((c) => c.pool === 'events');
  assert.equal(events.length, ACTS.length);
  assert.equal(events[0].have, d.events.filter((e) => !e.acts || e.acts.includes(1)).length);
  assert.ok(poolCounts(d, 'wizard').cantrip >= 3);
});
