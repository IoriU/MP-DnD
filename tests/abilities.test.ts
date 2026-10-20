import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { nextHeroIntent, type HeroIntent, type HeroView } from '../server/heroai.ts';
import { pickOrder, planMonster, trickValue, type MonsterPlan, type MonsterView } from '../server/monsterai.ts';
import { recalcHero, startingSkills } from '../server/progression.ts';
import { rng } from '../server/rng.ts';
import { dist } from '../shared/grid.ts';
import { CHARGE_MOVES, CLASSES, MONSTERS, ORDER_EVERY, ORDER_RANGE, maxHpFor } from '../shared/rules.ts';
import { CLEANSED, ROOTED, ownedSkill, resolveAim, skillBlockReason, statsAt, statsOf, type StatusId } from '../shared/skills.ts';
import { attackAdvantage } from '../shared/tactics.ts';
import type { FieldLike } from '../shared/surfaces.ts';
import type { ClassId, Entity, MonsterEntity, PlayerEntity, PlayerInfo, TurnView } from '../shared/types.ts';

/** The acting creature's share of the turn (movement and AP left); the tests start one creature's turn at a time. */
const mine = (p: any) => p.turn.acts[p.turn.group[0]];

// Phase 12: monster abilities. The advantage rules and the monster and hero AI are tested on hand-made boards, the fight
// effects through the real Game class (private members are reached with `any`, as in tests/elites.test.ts). Dice are
// controlled, so every test is deterministic.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-abilities-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

let seq = 0;
const status = (id: StatusId, turns = 2) => ({ id, turns });
const has = (e: Entity, id: StatusId) => e.statuses.some((s) => s.id === id);
const powerOf = (e: Entity, id: StatusId) => e.statuses.find((s) => s.id === id)?.power;
const ids = (...es: Entity[]) => es.map((e) => e.id);
const freshTurn = (): TurnView => ({ order: [], init: {}, index: 0, round: 1, group: [], acts: {}, movesLeft: 6, ap: 3 });

/** A hero of a class at a tile, level 1 (override with `extra`). */
function hero(classId: ClassId, x: number, y: number, extra: Partial<PlayerEntity> = {}): PlayerEntity {
  const hp = maxHpFor(classId, 1);
  return {
    id: `h${++seq}`, kind: 'player', playerId: `p${seq}`, classId, name: `${CLASSES[classId].name}${seq}`, glyph: '', color: '#fff', x, y,
    hp, maxHp: hp, ac: CLASSES[classId].ac, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level: 1, xp: 0, skills: startingSkills(classId), levelUps: 0,
    offer: null, elitePicks: 0, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [],
    kills: 0, steals: 0, slots: 2, maxSlots: 2, downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], ...extra,
  };
}

/** A monster from its stat block at a tile (override with `extra`). */
function monster(type: string, x: number, y: number, extra: Partial<MonsterEntity> = {}): MonsterEntity {
  const d = MONSTERS[type];
  return {
    id: `m${++seq}`, kind: 'monster', type, name: d.name, glyph: '', x, y, hp: d.hp, maxHp: d.hp, ac: d.ac, speed: d.speed,
    statuses: [], facing: { x: -1, y: 0 }, boss: false, elite: false, dmgBy: {}, ...extra,
  };
}

/** The 12x8 room: a wall ring round an open floor. */
function room(): FieldLike {
  const rows = Array.from({ length: 8 }, (_, y) => Array.from({ length: 12 }, (_, x) => (x === 0 || y === 0 || x === 11 || y === 7 ? '#' : '.')).join(''));
  return { width: 12, height: 8, tiles: rows.join(''), ground: {}, clouds: {}, props: {} };
}

/** Math.random comes up with these values in turn, then 0 (the lowest roll: a d20 shows 1). Callouts stay quiet. */
function dice<T>(rolls: number[], fn: () => T): T {
  const real = { random: Math.random, next: rng.next, pick: rng.pick };
  const queue = [...rolls];
  Math.random = () => queue.shift() ?? 0;
  rng.next = () => 0.99;
  rng.pick = (arr) => arr[0];
  try {
    return fn();
  } finally {
    Math.random = real.random;
    rng.next = real.next;
    rng.pick = real.pick;
  }
}
/** The Math.random value that makes a die show `n`. */
const showing = (n: number, sides = 20) => (n - 0.5) / sides;
const NAT20 = showing(20);

// ---------------------------------------------------------------- a fight in the real Game class

/** Heroes in a small walled room, in combat. `foe` adds plain monsters (no elite traits) to the turn order. */
function battle(classes: ClassId[] = ['fighter', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'POWERS');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  g.width = 12;
  g.height = 8;
  g.tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  g.ground = {};
  g.clouds = {};
  g.props = {};
  heroes.forEach((h, i) => Object.assign(h, { x: 4, y: 3 + i }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, group: [heroes[0].id], acts: { [heroes[0].id]: { moves: 6, ap: 3 } } };
  p.runMonster = async () => {}; // a monster's turn would be played on real timers: the tests drive the rules themselves
  const foe = (type: string, x: number, y: number): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    Object.assign(m, { traits: undefined, ward: 0, atkBonus: 0, dmgBonus: 0 });
    p.turn.order.push(m.id);
    return m;
  };
  foe('rat', 10, 6); // someone is always standing, so the fight does not end
  return { g, p, heroes, foe };
}

/** Starts this creature's turn (the way advanceTurn would). */
function startTurn(p: any, e: Entity) {
  p.turn.index = p.turn.order.indexOf(e.id);
  p.beginTurn([e.id]);
}

const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));
const movesLeft = (p: any): number => mine(p).moves;
/** A hero with plenty of HP, so a few Wight hits cannot take them down. */
function sturdy(h: PlayerEntity) {
  h.bonusHp = 100;
  recalcHero(h);
  h.hp = h.maxHp;
}

// ---------------------------------------------------------------- statuses: advantage and movement

test('netted: ranged attacks against it have advantage, melee ones do not', () => {
  const h = hero('fighter', 5, 3, { statuses: [status('netted')] });
  const archer = monster('archer', 9, 3);
  const goblin = monster('goblin', 6, 3);
  const ents: Entity[] = [h, archer, goblin];
  assert.ok(attackAdvantage(archer, h, ents).adv.includes('netted'));
  assert.ok(!attackAdvantage(goblin, h, ents).adv.includes('netted'), 'up close a net is no help');
  assert.ok(!attackAdvantage(archer, hero('fighter', 5, 4), ents).adv.includes('netted'), 'and a free hero is just a hero');
});

test('netted: it cannot move on its turn, and Cut Free on itself gives the movement back', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.statuses.push(status('netted'));
  startTurn(p, ann);
  assert.equal(movesLeft(p), 0);
  assert.equal((mine(p).held ?? 0), ann.speed, "the turn's movement is held back, not lost");
  assert.equal(p.handleSkill(ann.playerId, 'cut_free', ann.id), true);
  assert.ok(!has(ann, 'netted'));
  assert.equal(movesLeft(p), ann.speed);
  assert.equal(mine(p).ap, 2, 'Cut Free costs 1 AP');
  assert.equal((mine(p).held ?? 0), 0);
});

test('Cut Free is refused on someone who is not stuck, and works on a net or a web', () => {
  const caster = hero('fighter', 4, 3);
  const friend = hero('wizard', 5, 3);
  const ctx = { map: room(), entities: [caster, friend] as Entity[], inCombat: true };
  const cut = statsAt('cut_free');
  assert.equal(cut.ap, 1);
  assert.equal(resolveAim(cut, caster, friend.id, ctx), `${friend.name} isn't stuck.`);
  assert.equal(resolveAim(cut, caster, caster.id, ctx), "You aren't stuck.");
  for (const id of ROOTED) {
    friend.statuses = [status(id)];
    const res = resolveAim(cut, caster, friend.id, ctx);
    assert.ok(typeof res !== 'string' && res.friends[0] === friend, `${id}: cut free`);
  }
  assert.ok(ownedSkill(caster, 'cut_free'), 'every hero has it');
  assert.equal(skillBlockReason(caster, 'cut_free', true, { ...freshTurn(), ap: 0 }, true), 'Needs 1 AP (0 left)');
});

test('webbed: attacks against it have advantage and its own have disadvantage', () => {
  const h = hero('fighter', 5, 3, { statuses: [status('webbed', 3)] });
  const goblin = monster('goblin', 6, 3);
  assert.ok(attackAdvantage(goblin, h, [h, goblin]).adv.includes('webbed'));
  const own = attackAdvantage(h, goblin, [h, goblin]);
  assert.ok(own.dis.includes('webbed') && !own.adv.includes('webbed'));
});

test('webbed: fire burns the web away (and gives the movement back), other damage does not', () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes;
  const rat = foe('rat', 7, 3);
  ann.statuses.push(status('webbed', 3));
  startTurn(p, ann);
  p.damage(ann, 1, rat, 'physical');
  p.damage(ann, 1, rat, 'cold');
  assert.ok(has(ann, 'webbed'), 'a blade or a chill leaves it stuck');
  assert.equal(movesLeft(p), 0);
  p.damage(ann, 1, rat, 'fire');
  assert.ok(!has(ann, 'webbed'));
  assert.equal(movesLeft(p), ann.speed);
  assert.ok(logged(p, /web around .* burns away/));
});

test('webbed: Cut Free from an adjacent ally removes it, and one out of reach cannot', () => {
  const { p, heroes } = battle(['fighter', 'rogue']);
  const [ann, bob] = heroes;
  ann.statuses.push(status('webbed', 3));
  Object.assign(bob, { x: 8, y: 3 });
  startTurn(p, bob);
  assert.equal(p.handleSkill(bob.playerId, 'cut_free', ann.id), false, 'too far away');
  assert.ok(has(ann, 'webbed'));
  Object.assign(bob, { x: 5, y: 3 });
  assert.equal(p.handleSkill(bob.playerId, 'cut_free', ann.id), true);
  assert.ok(!has(ann, 'webbed'));
});

test('webbed and netted are cleansed by Purifying Touch, and a hero who cleanses themself can move again', () => {
  assert.ok(CLEANSED.includes('webbed') && CLEANSED.includes('netted'));
  const { p, heroes } = battle(['fighter', 'cleric']);
  const [ann, bob] = heroes;
  bob.skills = [{ id: 'healing_touch', tier: 3, branch: 'A', cd: 0 }];
  assert.equal(statsOf(bob.skills[0]).cleanse, true, 'Purifying Touch');
  ann.statuses.push(status('webbed', 3), status('netted'), status('burning'));
  bob.statuses.push(status('netted'));
  Object.assign(bob, { x: 5, y: 3 });
  startTurn(p, bob);
  assert.equal(p.handleSkill(bob.playerId, 'healing_touch', ann.id), true);
  assert.deepEqual(ann.statuses, []);
  assert.equal(movesLeft(p), 0, 'cleansing a friend does not free the caster');
  mine(p).ap = 3;
  bob.skills[0].cd = 0;
  assert.equal(p.handleSkill(bob.playerId, 'healing_touch', bob.id), true);
  assert.ok(!has(bob, 'netted'));
  assert.equal(movesLeft(p), bob.speed);
});

test('prone: melee attacks against it have advantage, ranged ones disadvantage', () => {
  const h = hero('fighter', 5, 3, { statuses: [status('prone', 1)] });
  const goblin = monster('goblin', 6, 3);
  const archer = monster('archer', 9, 3);
  const melee = attackAdvantage(goblin, h, [h, goblin, archer]);
  assert.ok(melee.adv.includes('prone') && !melee.dis.includes('prone'));
  const ranged = attackAdvantage(archer, h, [h, goblin, archer]);
  assert.ok(ranged.dis.includes('prone') && !ranged.adv.includes('prone'));
});

test('prone: it stands up at the start of its turn, which costs half its movement', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.statuses.push(status('prone', 1));
  startTurn(p, ann);
  assert.ok(!has(ann, 'prone'));
  assert.equal(movesLeft(p), Math.floor(ann.speed / 2));
  assert.ok(logged(p, /gets back up/));
});

test('distracted: the next attack from the other side has advantage, one from its own side does not', () => {
  const h = hero('fighter', 5, 3, { statuses: [status('distracted', 1)] });
  const friend = hero('rogue', 4, 3);
  const goblin = monster('goblin', 6, 3);
  assert.ok(attackAdvantage(goblin, h, [h, friend, goblin]).adv.includes('distracted'));
  assert.ok(!attackAdvantage(friend, h, [h, friend, goblin]).adv.includes('distracted'));
});

test('distracted: the first attack against it has advantage and uses it up, the second is a plain roll', () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes;
  const goblin = foe('goblin', 5, 3);
  ann.statuses.push(status('distracted', 1));
  const attack = () => dice([0.1, 0.9, 0.5], () => p.monsterAttack(goblin, ann));
  attack();
  assert.ok(logged(p, /🎲\d+\|\d+→\d+ \(distracted\)/), 'two dice, with the reason');
  assert.ok(!has(ann, 'distracted'), 'spent');
  p.log.length = 0;
  attack();
  assert.ok(!logged(p, /distracted|🎲\d+\|\d+/), 'a single die');
});

test('charging: +3 movement at the start of its next turn, and not before', () => {
  const { p, heroes } = battle();
  const [ann, bob] = heroes;
  ann.statuses.push(status('charging', 1));
  startTurn(p, bob);
  assert.equal(movesLeft(p), bob.speed, "someone else's turn");
  startTurn(p, ann);
  assert.equal(movesLeft(p), ann.speed + CHARGE_MOVES);
});

test(
  'netted: a Dash does not get a netted hero moving (the extra movement waits until it is cut free)',
  () => {
    const { p, heroes } = battle(['rogue', 'fighter']);
    const [bob] = heroes;
    bob.skills = [...bob.skills, { id: 'cunning_dash', tier: 1, cd: 0 }];
    bob.statuses.push(status('netted'));
    startTurn(p, bob);
    assert.equal(p.handleSkill(bob.playerId, 'cunning_dash', undefined), true);
    assert.equal(movesLeft(p), 0, 'still stuck in the net');
    assert.equal(p.tryMove(bob, { x: bob.x + 1, y: bob.y }), false, 'and cannot take a step');
  },
);

// ---------------------------------------------------------------- riders: drained, prone, and the rallied stack

test('drained: each Wight hit takes 2 off the hero max HP, stacking to 10 at most', () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes;
  sturdy(ann);
  const base = ann.maxHp;
  const wight = foe('wight', 5, 3);
  const seen: number[] = [];
  for (let i = 0; i < 7; i++) {
    dice([NAT20, NAT20], () => p.monsterAttack(wight, ann)); // a natural 20 always hits
    seen.push(base - ann.maxHp);
    ann.hp = Math.min(ann.hp + 20, ann.maxHp);
  }
  assert.deepEqual(seen, [2, 4, 6, 8, 10, 10, 10]);
  assert.equal(powerOf(ann, 'drained'), 10);
});

test('drained: a miss does nothing, and a monster cannot be drained', () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes;
  const wight = foe('wight', 5, 3);
  const base = ann.maxHp;
  dice([showing(2), showing(2)], () => p.monsterAttack(wight, ann)); // 2 + 5 < AC 16
  assert.equal(ann.maxHp, base);
  assert.ok(!has(ann, 'drained'));
  const ogre = foe('ogre', 8, 3);
  p.applyStatus(ogre, { id: 'drained', turns: 99, power: 2, stack: 5 }, wight);
  assert.ok(!has(ogre, 'drained'));
});

test('drained: at the end of the fight max HP comes back, but the HP is not healed back', () => {
  const { p, heroes, foe } = battle(['fighter', 'fighter']);
  const [ann, bob] = heroes;
  heroes.forEach(sturdy);
  const base = ann.maxHp;
  const wight = foe('wight', 5, 3);
  for (let i = 0; i < 3; i++) dice([NAT20, NAT20], () => p.monsterAttack(wight, ann));
  assert.equal(ann.maxHp, base - 6);
  ann.hp = bob.hp = 20; // the same hurt, one of them drained
  p.endCombat();
  assert.equal(ann.maxHp, base, 'max HP is back');
  assert.ok(!has(ann, 'drained'));
  assert.equal(ann.hp, bob.hp, 'nobody got healed for the lost max HP: just the usual breather');
  assert.ok(ann.hp < base - 6, 'still hurt');
});

test('prone rider: a Wolf drags a hero down on a failed STR save (DC 11)', () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes; // STR +3
  sturdy(ann);
  const wolf = foe('wolf', 5, 3);
  const bite = (save: number) => dice([showing(15), showing(15), 0.5, 0.5, showing(save)], () => p.monsterAttack(wolf, ann));
  bite(8); // 8 + 3 = 11: saved
  assert.ok(!has(ann, 'prone'));
  bite(7); // 10: fails
  assert.ok(has(ann, 'prone'));
  assert.ok(logged(p, /drags .* to the ground/));
});

test('rallied: +1 per application, up to 3, as one status', () => {
  const { p, heroes, foe } = battle();
  const goblin = foe('goblin', 8, 3);
  const seen: (number | undefined)[] = [];
  for (let i = 0; i < 5; i++) {
    p.applyStatus(goblin, { id: 'rallied', turns: 3, power: 1, stack: 3 }, heroes[0]);
    seen.push(powerOf(goblin, 'rallied'));
  }
  assert.deepEqual(seen, [1, 2, 3, 3, 3]);
  assert.equal(goblin.statuses.filter((s) => s.id === 'rallied').length, 1);
});

test('rallied: the stack adds to the attack roll and to the damage', () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes; // AC 16
  const goblin = foe('goblin', 5, 3); // +4 to hit, 1d6+2 damage
  const strike = () => {
    const hp = ann.hp;
    dice([showing(10), showing(10), showing(1, 6)], () => p.monsterAttack(goblin, ann)); // a 10 on the d20, a 1 on the d6
    return hp - ann.hp;
  };
  assert.equal(strike(), 0, '10 + 4 = 14 misses AC 16');
  for (let i = 0; i < 3; i++) p.applyStatus(goblin, { id: 'rallied', turns: 3, power: 1, stack: 3 }, heroes[0]);
  assert.equal(strike(), 1 + 2 + 3, '10 + 4 + 3 = 17 hits: the d6 (1) + 2 + 3 rallied');
  assert.ok(logged(p, /\+7=17 vs AC 16/));
});

// ---------------------------------------------------------------- tricks and orders

test("a kobold's Net is once a fight: the cooldown ticks down from 99 and never gets near ready", () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes;
  const kobold = foe('kobold', 6, 3);
  dice([NAT20, NAT20], () => p.useTrick(kobold, ann));
  assert.ok(has(ann, 'netted'), 'a natural 20 lands the net');
  assert.equal(kobold.trickCd, 99);
  for (let i = 0; i < 6; i++) startTurn(p, kobold);
  assert.equal(kobold.trickCd, 93);
});

test("a goblin's Dirty Trick comes back after its cooldown: trickCd ticks down at the start of its turns", () => {
  const { p, heroes, foe } = battle();
  const [ann] = heroes;
  const goblin = foe('goblin', 5, 3);
  dice([], () => p.useTrick(goblin, ann)); // a DEX save of 1 + 1 against DC 12
  assert.ok(has(ann, 'blinded'));
  assert.equal(goblin.trickCd, MONSTERS.goblin.trick!.cooldown);
  const seen: (number | undefined)[] = [];
  for (let i = 0; i < 4; i++) {
    startTurn(p, goblin);
    seen.push(goblin.trickCd);
  }
  assert.deepEqual(seen, [2, 1, 0, 0], 'ready again on its third turn, and it stays ready');
});

test('Hold the line! shields the friends within ORDER_RANGE and nobody farther, and starts the cooldown', () => {
  const { p, heroes, foe } = battle();
  const leader = foe('hobgoblin', 1, 1);
  const near = foe('goblin', 1 + ORDER_RANGE, 1);
  const far = foe('goblin', 2 + ORDER_RANGE, 1);
  assert.equal(dist(leader, near), ORDER_RANGE);
  p.turn.group = [leader.id];
  p.giveOrder(leader, { id: 'hold' });
  for (const f of [leader, near]) assert.equal(powerOf(f, 'shielded'), 2, `${f.name} is shielded`);
  assert.ok(!has(far, 'shielded'), 'one tile too far');
  heroes.forEach((h) => assert.deepEqual(h.statuses, [], 'not on its side'));
  assert.equal(leader.orderCd, ORDER_EVERY);
  const seen: (number | undefined)[] = [];
  for (let i = 0; i < ORDER_EVERY; i++) {
    startTurn(p, leader);
    seen.push(leader.orderCd);
  }
  assert.deepEqual(seen, [2, 1, 0], 'it can shout again ORDER_EVERY turns later');
});

test('Kill that one! marks the target (advantage for everyone) and starts the cooldown', () => {
  const { p, heroes, foe } = battle();
  const [ann, bob] = heroes;
  const leader = foe('hobgoblin', 1, 1);
  const goblin = foe('goblin', 6, 3);
  p.turn.group = [leader.id];
  p.giveOrder(leader, { id: 'kill', target: ann.id });
  assert.equal(ann.statuses.find((s) => s.id === 'marked')?.turns, 2);
  assert.ok(!has(bob, 'marked'));
  assert.ok(attackAdvantage(goblin, ann, p.entities).adv.includes('marked'));
  assert.ok(!attackAdvantage(goblin, bob, p.entities).adv.includes('marked'));
  assert.equal(leader.orderCd, ORDER_EVERY);
});

test('Charge! gives friends in range +3 movement and a stack of Rallied, and stacks', () => {
  const { p, foe } = battle();
  const leader = foe('hobgoblin', 1, 1);
  const goblin = foe('goblin', 4, 1);
  p.turn.group = [leader.id];
  p.giveOrder(leader, { id: 'charge' });
  for (const f of [leader, goblin]) assert.ok(has(f, 'charging') && powerOf(f, 'rallied') === 1);
  p.giveOrder(leader, { id: 'charge' });
  assert.equal(powerOf(goblin, 'rallied'), 2);
});

// ---------------------------------------------------------------- the monster AI

const viewOf = (me: MonsterEntity, entities: Entity[], extra: Partial<MonsterView> = {}): MonsterView =>
  ({ me, map: room(), entities, moves: 6, difficulty: 'normal', focus: null, rand: () => 0.99, ...extra });
/** Plans one monster's turn on Normal's squad rolls. */
const plan = (me: MonsterEntity, entities: Entity[], extra: Partial<MonsterView> = {}): MonsterPlan => planMonster(viewOf(me, entities, extra));

test('a kobold nets a melee hero that goblin archers (acting before it) can then shoot', () => {
  const h = hero('fighter', 5, 3);
  const kobold = monster('kobold', 6, 3);
  const archers = [monster('archer', 9, 2), monster('archer', 9, 3), monster('archer', 9, 4)];
  const ents: Entity[] = [h, kobold, ...archers];
  const order = ids(kobold, ...archers, h);
  const netting = plan(kobold, ents, { order });
  assert.equal(netting.kind, 'trick');
  assert.equal(netting.target, h.id);
  assert.notEqual(plan({ ...kobold, trickCd: 99 }, ents, { order }).kind, 'trick', 'a net that has been thrown is not thrown again');
  h.statuses.push(status('netted'));
  assert.notEqual(plan(kobold, ents, { order }).kind, 'trick', 'nor is a hero who is already stuck netted twice');
});

test('a net is worth more with archers to shoot the netted hero than without', () => {
  const h = hero('fighter', 5, 3);
  const kobold = monster('kobold', 6, 3);
  const archers = [monster('archer', 9, 2), monster('archer', 9, 3)];
  const net = { id: 'netted', turns: 2 } as const;
  const value = (order?: string[]) => trickValue(viewOf(kobold, [h, kobold, ...archers], { order }), net, h);
  const alone = trickValue(viewOf(kobold, [h, kobold]), net, h);
  assert.ok(value(ids(kobold, ...archers, h)) > alone);
  assert.equal(value(ids(kobold, h, ...archers)), alone, 'archers that act after the hero add nothing');
  const brawlers = [monster('goblin', 7, 3), monster('goblin', 7, 4)];
  assert.equal(trickValue(viewOf(kobold, [h, kobold, ...brawlers], { order: ids(kobold, ...brawlers, h) }), net, h), alone, 'melee friends gain nothing from a net');
});

// An armoured hero (the ogre needs the help to hit), a small monster next to it and an Ogre on the other side.
for (const [small, extra] of [['rat', {}], ['kobold', { trickCd: 99 }]] as const) {
  test(`a ${small} next to a hero gets in its face (Help) when an ogre next to the hero acts before the hero`, () => {
    const h = hero('fighter', 5, 3, { ac: 18 });
    const sidekick = monster(small, 4, 3, extra);
    const ogre = monster('ogre', 6, 3, { dmgBonus: 4 });
    const helps = plan(sidekick, [h, sidekick, ogre], { order: ids(sidekick, ogre, h) });
    assert.equal(helps.kind, 'help');
    assert.equal(helps.target, h.id);
    const late = plan(sidekick, [h, sidekick, ogre], { order: ids(sidekick, h, ogre) });
    assert.equal(late.kind, 'attack', 'the ogre swings after the hero has had its turn: nothing to set up');
  });
}

test('pickOrder: Charge! when friends are just out of reach', () => {
  const h = hero('fighter', 10, 3);
  const leader = monster('hobgoblin', 1, 6);
  const goblins = [monster('goblin', 2, 2), monster('goblin', 2, 3), monster('goblin', 2, 4)]; // 8 tiles away: one step past their reach
  assert.deepEqual(pickOrder(viewOf(leader, [h, leader, ...goblins])), { id: 'charge' });
});

test('pickOrder: Hold the line! when the friends in melee are hurt', () => {
  const heroes = [hero('fighter', 5, 3), hero('fighter', 5, 4)];
  const leader = monster('hobgoblin', 1, 6);
  const goblins = [[4, 3], [4, 4], [6, 3], [6, 4]].map(([x, y]) => monster('goblin', x, y, { hp: 2 }));
  assert.deepEqual(pickOrder(viewOf(leader, [...heroes, leader, ...goblins])), { id: 'hold' });
});

test('pickOrder: Kill that one! on the hero that several friends can reach', () => {
  const target = hero('wizard', 6, 3);
  const other = hero('fighter', 10, 6); // out of the ogres' reach
  const leader = monster('hobgoblin', 1, 6);
  const ogres = [monster('ogre', 2, 2), monster('ogre', 2, 3), monster('ogre', 2, 4)];
  assert.deepEqual(pickOrder(viewOf(leader, [target, other, leader, ...ogres])), { id: 'kill', target: target.id });
});

test('a spider webs a hero its pack can reach, when its web is ready', () => {
  const h = hero('fighter', 3, 3);
  const spider = monster('spider', 7, 3);
  const pack = [monster('goblin', 6, 2), monster('goblin', 6, 4), monster('goblin', 6, 5), monster('wolf', 8, 5)];
  const ents: Entity[] = [h, spider, ...pack];
  const order = ids(spider, ...pack, h);
  const webbing = plan(spider, ents, { order });
  assert.equal(webbing.kind, 'trick');
  assert.equal(webbing.target, h.id);
  assert.notEqual(plan({ ...spider, trickCd: 2 }, ents, { order }).kind, 'trick', 'its web is not ready yet');
  assert.equal(plan({ ...spider, trickCd: 0 }, ents, { order }).kind, 'trick');
  assert.notEqual(plan(spider, [h, spider], { order: ids(spider, h) }).kind, 'trick', 'a web for nobody to take advantage of');
});

// ---------------------------------------------------------------- the hero AI

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[]): HeroView {
  const all = [...heroes, ...monsters];
  return {
    map: room(), hero: h, heroes, monsters, turn: freshTurn(),
    occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)),
  };
}

/** Null if the game would accept this act (the same checks as a human click), else why not. */
function whyNot(v: HeroView, intent: HeroIntent): string | null {
  if (intent.kind !== 'act') return 'not an act';
  const blocked = skillBlockReason(v.hero, intent.skill, true, v.turn, true);
  if (blocked) return blocked;
  const res = resolveAim(statsOf(ownedSkill(v.hero, intent.skill)!), v.hero, intent.target, { map: v.map, entities: [...v.heroes, ...v.monsters], inCombat: true });
  return typeof res === 'string' ? res : null;
}

test('a webbed hero cuts themself free first', () => {
  const h = hero('fighter', 5, 3, { statuses: [status('webbed', 3)] });
  const v = view(h, [h], [monster('spider', 6, 3)]);
  const intent = nextHeroIntent(v);
  assert.deepEqual(intent, { kind: 'act', skill: 'cut_free', target: h.id });
  assert.equal(whyNot(v, intent), null);
});

test('a hero next to a netted friend cuts them free, and never reaches for Cut Free when nobody is stuck', () => {
  const fighter = hero('fighter', 5, 3);
  const wizard = hero('wizard', 4, 3, { statuses: [status('netted')] });
  const v = view(fighter, [fighter, wizard], [monster('kobold', 8, 3)]);
  const intent = nextHeroIntent(v);
  assert.deepEqual(intent, { kind: 'act', skill: 'cut_free', target: wizard.id });
  assert.equal(whyNot(v, intent), null);
  wizard.statuses = [];
  const free = nextHeroIntent(v);
  assert.ok(!(free.kind === 'act' && free.skill === 'cut_free'));
});
