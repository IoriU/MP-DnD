import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checks, coverage, engineCards, enginesIn, looseCards, poolCounts } from '../client/codex/checks.ts';
import { liveData, monsterUsage, usedAsFoe, type CodexData } from '../client/codex/data.ts';
import { ENGINES } from '../shared/engines.ts';
import { ACTS } from '../shared/rules.ts';
import { SKILLS, type SkillId, type StatusId } from '../shared/skills.ts';
import { classLabel, stacksShown } from '../client/util.ts';

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

test('engines: a card that is not a skill, one in the wrong class pool, and one in two engines are errors', () => {
  const d = liveData();
  const engines = structuredClone(ENGINES);
  engines.guardian.cards.common!.push('not_a_skill' as never); // not a skill
  engines.guardian.cards.uncommon!.push('shield'); // a wizard card on a fighter engine
  engines.duelist.cards.common!.push(engines.guardian.cards.rare![0]); // already in Guardian
  const bad = errors({ ...d, engines });
  const texts = bad.map((c) => c.text).join('\n');
  assert.match(texts, /not_a_skill.*not in SKILLS/);
  assert.match(texts, /Shield.*wizard pool, not fighter/);
  assert.match(texts, /Spiked Shield is a card of both Guardian and Duelist/);
  assert.equal(bad.length, 3);
  assert.ok(bad.every((c) => c.pool === 'engines' && c.id));
});

test('engines: no epic capstone, and a class without exactly 3 engines, are errors', () => {
  const d = liveData();
  const engines = structuredClone(ENGINES);
  delete engines.shadow.cards.epic;
  const noCap = errors({ ...d, engines });
  assert.equal(noCap.length, 1);
  assert.match(noCap[0].text, /Shadow has no epic capstone/);
  assert.equal(noCap[0].id, 'shadow');

  const four = { ...d.engines, extra: { ...ENGINES.shadow, name: 'Extra', cards: { epic: ['death_blossom' as const] } } };
  const tooMany = errors({ ...d, engines: four });
  assert.ok(tooMany.some((c) => c.pool === 'classes' && c.id === 'rogue' && /4 build engines, not 3/.test(c.text)));

  const { crescendo: _gone, ...two } = d.engines;
  const tooFew = errors({ ...d, engines: two });
  assert.deepEqual(tooFew.map((c) => c.text), ['Bard has 2 build engines, not 3']);
});

test('engines: every class has 3, each with an epic capstone, and class cards in no engine are listed as info', () => {
  const d = liveData();
  for (const id of Object.keys(d.classes)) {
    const own = enginesIn(d, id);
    assert.equal(own.length, 3, id);
    for (const [eid, e] of own) assert.ok(e.cards.epic?.length, eid);
  }
  assert.equal(engineCards(ENGINES.wrecker).length, 6); // no rare cards, and that is fine
  const loose = checks(d).filter((c) => c.level === 'info' && c.pool === 'engines');
  assert.ok(loose.length > 0 && loose.every((c) => c.id && d.classes[c.id]));
  assert.ok(looseCards(d, 'wizard').includes('shield'));
  assert.ok(!looseCards(d, 'wizard').includes('fireball'));
  // An engine card of the pool that nobody lists shows up in the class's info line.
  const engines = structuredClone(ENGINES);
  engines.evoker.cards.uncommon = engines.evoker.cards.uncommon!.filter((s) => s !== 'fireball');
  const line = checks({ ...d, engines }).find((c) => c.level === 'info' && c.pool === 'engines' && c.id === 'wizard');
  assert.match(line!.text, /Fireball/);
  assert.equal(poolCounts({ ...d, engines }, 'wizard').engine, poolCounts(d, 'wizard').engine - 1);
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

test('the party card label is "Class · Engine" once two cards lean one way, with the old subclass as a fallback', () => {
  const own = (...ids: SkillId[]) => ({ classId: 'fighter' as const, skills: ids.map((id) => ({ id, tier: 1 as const, cd: 0 })) });
  assert.equal(classLabel(own('longsword')), 'Fighter');
  assert.equal(classLabel(own('longsword', 'heavy_strike')), 'Fighter', 'one card is not an engine yet');
  assert.equal(classLabel(own('longsword', 'shield_bash', 'shield_wall')), 'Fighter · Guardian');
  assert.equal(classLabel({ ...own('longsword'), subclass: 'weapon_master' }), 'Fighter · Weapon Master');
  assert.equal(classLabel({ ...own('shield_bash', 'shield_wall'), subclass: 'weapon_master' }), 'Fighter · Guardian', 'the engine wins');
});

test('status icons show a stack count for stacking statuses with a power above 1, and nothing else', () => {
  assert.equal(stacksShown({ id: 'poisoned', power: 5 }), 5);
  assert.equal(stacksShown({ id: 'charged', power: 3 }), 3);
  assert.equal(stacksShown({ id: 'poisoned', power: 1 }), 0);
  assert.equal(stacksShown({ id: 'poisoned' }), 0);
  assert.equal(stacksShown({ id: 'shielded', power: 4 }), 0, 'AC bonuses are not stacks');
});
