import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { nextHeroIntent, type HeroView } from '../server/heroai.ts';
import { recalcHero } from '../server/progression.ts';
import { makeRng, rng } from '../server/rng.ts';
import {
  RARITIES, RARITY_ODDS, RARITY_PITY, RELICS, RELIC_IDS, RELIC_ODDS, nextPity, pickRarity, rarityOdds, rarityPool, rollRarity,
  type Rarity, type RelicId,
} from '../shared/items.ts';
import { HELP_UP_HP, INJURY_PCT, MAX_DOWNS, MAX_INJURIES } from '../shared/rules.ts';
import { COMMON_ACTIONS, atEdge, describeSkill, resolveAim, statsAt, type AimResult } from '../shared/skills.ts';
import type { ClassId, Entity, MonsterEntity, PlayerEntity, PlayerInfo, TurnState } from '../shared/types.ts';

// Revive rules (decided 2026-10-19, see shared/rules.ts): Help Up gets a downed friend up at a quarter of their max HP (2 AP,
// anyone). Healing spells, potions and scrolls revive too, cantrips don't, and every revive but your own death saves leaves
// you Groggy (you lose your next turn). A hero who dies is back after the fight with an Injury (-20% max HP, up to 3) until
// the next rest site or act. Fireball II's outer ring takes half. Rarity and relic rolls (shared/items.ts) are checked too.
// Rules run through the real Game class (private members reached with `any`, as in tests/block.test.ts), the hero AI on a
// hand-made board, and dice are fixed by stubbing Math.random, as the other tests do.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-revive-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** Dice that show these Math.random values in turn (then 0.5, a middle roll). */
function dice<T>(rolls: number[], fn: () => T): T {
  const real = Math.random;
  const queue = [...rolls];
  Math.random = () => queue.shift() ?? 0.5;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}
/** The Math.random value that makes a die with `sides` sides show n. */
const showing = (n: number, sides = 20) => (n - 0.5) / sides;

/** Runs fn with the game's own rng seeded, so rollRelics is the same every run. */
function seeded<T>(seed: number, fn: () => T): T {
  const real = { next: rng.next, pick: rng.pick };
  const r = makeRng(seed);
  rng.next = r.next;
  rng.pick = r.pick;
  try {
    return fn();
  } finally {
    rng.next = real.next;
    rng.pick = real.pick;
  }
}

/** Heroes in a 12x8 walled room, in combat, at (4,2), (4,3), (4,4), with a rat far away so the fight goes on. */
function battle(classes: ClassId[] = ['fighter', 'paladin', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'REVIVE');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  Object.assign(g, { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 4, y: 2 + i }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, movesLeft: 6, ap: 0 };
  p.turnOwner = heroes[0].id;
  p.runMonster = async () => {};
  const foe = (type: string, x: number, y: number, hp = 100): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    Object.assign(m, { traits: undefined, ward: 0, atkBonus: 0, dmgBonus: 0, hp, maxHp: hp });
    p.turn.order.push(m.id);
    return m;
  };
  foe('rat', 10, 6); // someone is always standing, so the fight does not end
  return { g, p, heroes, foe };
}

function startTurn(p: any, e: Entity) {
  p.turn.index = p.turn.order.indexOf(e.id);
  p.turnOwner = e.id;
  p.beginTurn();
}

const hasGroggy = (e: Entity) => e.statuses.some((s) => s.id === 'groggy');
/** Whether the game's log has a line matching re. */
const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));

// ---------------------------------------------------------------- data

test('the data: Help Up is a common 2 AP action; cantrip heals refuse the downed, spells and potions revive', () => {
  const up = statsAt('help_up');
  assert.deepEqual([up.ap, up.target, up.range, up.helpUp], [2, 'ally', 1, true]);
  assert.ok(COMMON_ACTIONS.includes('help_up'), 'everyone has it');
  assert.equal(HELP_UP_HP, 0.25);
  assert.equal(statsAt('lay_on_hands').noRevive, true, 'a cantrip');
  assert.equal(statsAt('healing_touch').noRevive, true, 'a cantrip');
  assert.ok(!statsAt('healing_word').noRevive, 'a spell revives');
  assert.ok(!statsAt('potion').noRevive, 'a potion revives');
  assert.match(describeSkill('help_up'), /A downed ally next to you gets back up with 25% of their max HP, Groggy: they lose their next turn/);
  assert.match(describeSkill('lay_on_hands'), /Can't get the downed back up/);
  assert.match(describeSkill('healing_word'), /Gets the downed back up \(Groggy: they lose their next turn\)/);
});

// ---------------------------------------------------------------- Help Up

test('Help Up: an adjacent downed ally gets up at ceil(25% of max HP), Groggy, and the helper spends 2 AP', () => {
  const { p, heroes } = battle();
  const [ann, , cid] = heroes; // Cid is a cleric with 10 max HP: 25% is 2.5, which rounds up to 3
  Object.assign(cid, { x: 5, y: 3, hp: 0, downed: true });
  startTurn(p, ann);
  assert.equal(p.handleSkill(ann.playerId, 'help_up', cid.id), true);
  assert.equal(cid.maxHp, 10);
  assert.equal(cid.downed, false);
  assert.equal(cid.hp, Math.ceil(cid.maxHp * HELP_UP_HP));
  assert.equal(cid.hp, 3);
  assert.ok(hasGroggy(cid));
  assert.equal(p.turn.ap, 1, 'three AP, two spent');
  assert.ok(logged(p, /Ann hauls Cid back to their feet \(3 HP\)/));
});

test('Help Up is refused for a standing ally ("isn\'t down"), for yourself, and for a downed ally two tiles away', () => {
  const { g, p, heroes } = battle();
  const [ann, bob, cid] = heroes;
  Object.assign(cid, { x: 6, y: 2, hp: 0, downed: true }); // two tiles from Ann at (4,2)
  const ctx = { map: g as any, entities: p.entities, inCombat: true };
  const up = statsAt('help_up');
  assert.match(String(resolveAim(up, ann, bob.id, ctx)), /Bob isn't down\./);
  assert.match(String(resolveAim(up, ann, ann.id, ctx)), /Pick a downed ally next to you\./);
  assert.match(String(resolveAim(up, ann, cid.id, ctx)), /Out of range \(Help Up reaches 1 tile\)/);
  startTurn(p, ann);
  assert.equal(p.handleSkill(ann.playerId, 'help_up', cid.id), false, 'the game refuses it too');
  assert.equal(p.turn.ap, 3, 'and nothing is spent');
  Object.assign(cid, { x: 5, y: 2 }); // now next to Ann
  const ok = resolveAim(up, ann, cid.id, ctx) as AimResult;
  assert.equal(ok.main, cid);
  assert.deepEqual(ok.friends, [cid]);
});

// ---------------------------------------------------------------- Groggy

test('a Groggy hero loses their next turn ("still groggy" in the log), and Groggy is gone once that turn is over', () => {
  const { p, heroes } = battle();
  const [ann, bob] = heroes;
  Object.assign(ann, { hp: 0, downed: true });
  startTurn(p, bob);
  assert.equal(p.handleSkill(bob.playerId, 'help_up', ann.id), true);
  assert.equal(ann.downed, false, 'Bob got her up');
  startTurn(p, ann); // her turn comes round
  assert.ok(logged(p, /Ann is still groggy from going down and loses the turn\./));
  assert.equal(p.turn.ap, 0, 'no AP for a lost turn');
  assert.ok(hasGroggy(ann));
  p.advanceTurn(); // her turn ends: Groggy wears off (the timer that would skip her again finds the turn has moved on)
  assert.equal(hasGroggy(ann), false);
});

// ---------------------------------------------------------------- cantrips and spells

test('cantrips refuse a downed ally, even one next to them: Lay on Hands (paladin) and Healing Touch (cleric)', () => {
  const { g, p, heroes } = battle();
  const [ann, bob, cid] = heroes;
  Object.assign(ann, { hp: 0, downed: true }); // Ann at (4,2): Bob (the paladin) is next to her at (4,3)
  Object.assign(cid, { x: 5, y: 2 }); // and Cid, the cleric, is next to her too
  const ctx = { map: g as any, entities: p.entities, inCombat: true };
  const why = "A cantrip can't get Ann back up: Help Up (2 AP) or a healing spell can.";
  assert.equal(resolveAim(statsAt('lay_on_hands'), bob, ann.id, ctx), why);
  assert.equal(resolveAim(statsAt('healing_touch'), cid, ann.id, ctx), why);
  startTurn(p, bob);
  assert.equal(p.handleSkill(bob.playerId, 'lay_on_hands', ann.id), false, 'refused in the game too');
  assert.equal(p.turn.ap, 3, 'nothing spent');
  assert.equal(ann.downed, true);
  Object.assign(ann, { downed: false, hp: 5 });
  assert.equal(typeof resolveAim(statsAt('lay_on_hands'), bob, ann.id, ctx), 'object', 'a standing ally is a fine target');
});

test('Healing Word, a spell, gets a downed ally up from five tiles away, Groggy, and costs a slot', () => {
  const { p, heroes } = battle();
  const [ann, , cid] = heroes;
  Object.assign(ann, { x: 9, y: 2, hp: 0, downed: true });
  Object.assign(cid, { x: 4, y: 4 }); // five tiles from Ann
  cid.slots = cid.maxSlots;
  startTurn(p, cid);
  assert.equal(p.handleSkill(cid.playerId, 'healing_word', ann.id), true);
  assert.equal(ann.downed, false);
  assert.ok(ann.hp > 0);
  assert.ok(hasGroggy(ann), 'a revive: Groggy');
  assert.equal(cid.slots, cid.maxSlots - 1);
  assert.equal(p.turn.ap, 2, 'three AP, one spent');
});

test('a potion fed to a downed ally next to you gets them up, Groggy, and uses one of your potions', () => {
  const { p, heroes } = battle();
  const [ann, bob] = heroes;
  Object.assign(ann, { hp: 0, downed: true });
  startTurn(p, bob);
  assert.equal(p.handleSkill(bob.playerId, 'potion', ann.id), true);
  assert.equal(ann.downed, false);
  assert.ok(ann.hp > 0);
  assert.ok(hasGroggy(ann));
  assert.equal(bob.potions, 1);
});

test('a passive or an aura heals only the standing: healBy without a revive leaves a downed hero downed at 0 HP', () => {
  const { p, heroes } = battle();
  const [ann, , cid] = heroes;
  Object.assign(ann, { hp: 0, downed: true });
  assert.equal(p.healBy(null, ann, 5), 0);
  assert.equal(p.healBy(cid, ann, 5), 0, 'a cantrip-style heal gets the same answer');
  assert.equal(ann.downed, true);
  assert.equal(ann.hp, 0);
  assert.equal(hasGroggy(ann), false);
});

// ---------------------------------------------------------------- death saves

test('a natural 20 on a death save gets a hero up without Groggy, and they act that turn', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  Object.assign(ann, { hp: 0, downed: true });
  dice([showing(20)], () => startTurn(p, ann));
  assert.equal(ann.downed, false);
  assert.equal(ann.hp, 1);
  assert.equal(hasGroggy(ann), false);
  assert.equal(p.turn.ap, 3, 'a full turn, not a lost one');
  assert.ok(logged(p, /rolls a natural 20 on a death save/));
});

test('three death save successes stabilize at 1 HP, also without Groggy', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  Object.assign(ann, { hp: 0, downed: true, saves: { ok: 0, fail: 0 } });
  dice([showing(12), showing(12), showing(12)], () => {
    startTurn(p, ann); // success 1
    startTurn(p, ann); // success 2
    startTurn(p, ann); // success 3: up with 1 HP
  });
  assert.equal(ann.downed, false);
  assert.equal(ann.hp, 1);
  assert.equal(hasGroggy(ann), false);
  assert.equal(p.turn.ap, 3);
});

// ---------------------------------------------------------------- Injuries

test('worn down: each time a hero goes down again in a fight, the death saves start one failure worse; the 4th time kills', () => {
  const { p, heroes, foe } = battle();
  const [, bob] = heroes;
  const gob = foe('goblin', 9, 6, 12);
  const knock = () => {
    Object.assign(bob, { hp: 5, downed: false });
    p.damage(bob, 50, gob);
  };
  knock();
  assert.deepEqual([bob.downed, bob.saves.fail], [true, 0], 'the first time: a clean slate');
  knock();
  assert.deepEqual([bob.downed, bob.saves.fail], [true, 1]);
  assert.ok(logged(p, /Bob falls unconscious again! Worn down: their death saves start with 1 failure\./));
  knock();
  assert.deepEqual([bob.downed, bob.saves.fail], [true, 2]);
  knock();
  assert.equal(MAX_DOWNS, 4);
  assert.deepEqual([bob.downed, bob.dead], [false, true], 'the 4th time: dead');
  assert.ok(!p.turn.order.includes(bob.id), 'and out of the turn order');
  assert.ok(logged(p, /Bob has died/));
  p.endCombat();
  assert.equal(bob.injuries, 1, 'an Injury after the fight, like any death');
  Object.assign(bob, { hp: 5 });
  p.prepareForFight(bob);
  p.damage(bob, 50, gob);
  assert.equal(bob.saves.fail, 0, 'the next fight starts fresh');
});

test('a bot does not haul up a friend who would just go down again while groggy, unless they are close to dying', () => {
  const { heroes, foe } = battle(['fighter', 'cleric']);
  const [ann, cid] = heroes;
  Object.assign(ann, { x: 4, y: 3, potions: 0 }); // no heals: Help Up is the only way to get her up
  Object.assign(cid, { x: 5, y: 3, hp: 0, downed: true });
  const ogre = foe('ogre', 6, 3, 80); // next to the downed cleric: it would put her down again while she's groggy
  Object.assign(ogre, { dmgBonus: 10 });
  const gob = foe('goblin', 3, 3, 7); // and a goblin to cut down instead
  const pick = () => nextHeroIntent(view(ann, heroes, [ogre, gob], turn(3)));
  assert.notDeepEqual(pick(), { kind: 'act', skill: 'help_up', target: cid.id });
  cid.saves = { ok: 0, fail: 2 };
  assert.deepEqual(pick(), { kind: 'act', skill: 'help_up', target: cid.id }, 'one failure from dying: get her up anyway');
});

test('a hero who dies in a fight is back after it with 1 Injury: max HP down by 20%', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  assert.equal(ann.maxHp, 12, 'a fighter at level 1');
  Object.assign(ann, { hp: 0, downed: false, dead: true });
  p.endCombat();
  assert.equal(ann.dead, false);
  assert.equal(ann.injuries, 1);
  assert.equal(ann.maxHp, 10, '12 at -20%');
  assert.equal(ann.maxHp, Math.round(12 * (1 - INJURY_PCT)));
  assert.ok(ann.hp >= 1 && ann.hp <= ann.maxHp);
  assert.ok(logged(p, /Ann is back, but injured: -20% max HP/));
});

test('each death is one more Injury, up to 3: max HP steps down 20%, 40%, 60% and then stays there', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  const maxHps: number[] = [];
  for (let death = 1; death <= 4; death++) {
    Object.assign(ann, { hp: 0, downed: false, dead: true });
    p.endCombat();
    maxHps.push(ann.maxHp);
    p.phase = 'combat'; // the next fight
    p.roomKind = 'combat';
  }
  assert.deepEqual(maxHps, [10, 7, 5, 5], '12 max HP at -20%, -40%, -60%, and the cap');
  assert.equal(ann.injuries, MAX_INJURIES);
});

test('a rest site or a new act heals every Injury, and the max HP comes back', () => {
  const { p, heroes } = battle();
  const [ann, bob] = heroes;
  ann.injuries = 2;
  recalcHero(ann);
  assert.equal(ann.maxHp, 7, '12 at -40%');
  p.startRest();
  p.resolveRest();
  assert.equal(ann.injuries, 0);
  assert.equal(ann.maxHp, 12);
  assert.ok(logged(p, /Ann's injuries heal by the fire\./));
  bob.injuries = 3;
  recalcHero(bob);
  assert.equal(bob.maxHp, 5, '12 at -60%');
  p.finishAct();
  assert.equal(p.run.act, 2);
  assert.equal(bob.injuries, 0);
  assert.equal(bob.maxHp, 12 + (p.run.relics.includes('dragon_heart') ? 10 : 0), 'the boss relic may be the Dragon Heart (+10)');
});

// ---------------------------------------------------------------- Fireball falloff

test('Fireball falloff: only a radius-2 blast has an outer ring (Fireball II), and only that ring takes half', () => {
  const c = { x: 5, y: 3 };
  const f1 = statsAt('fireball');
  const f2 = statsAt('fireball', 2);
  assert.equal(f1.radius, 1);
  assert.equal(f2.radius, 2);
  assert.equal(atEdge(f1, c, { x: 6, y: 3 }), false, 'Fireball I: one ring, no falloff');
  assert.equal(atEdge(f2, c, { x: 5, y: 3 }), false, 'the centre');
  assert.equal(atEdge(f2, c, { x: 6, y: 4 }), false, 'the inner ring, diagonal');
  assert.equal(atEdge(f2, c, { x: 7, y: 3 }), true, 'the outer ring');
  assert.equal(atEdge(f2, c, { x: 3, y: 5 }), true, 'the outer ring, diagonal');
  assert.match(describeSkill('fireball', 2), /The outer ring of the blast takes half/);
  assert.doesNotMatch(describeSkill('fireball'), /outer ring/);
});

test('an outer-ring target of Fireball II that fails its save takes half (fixed rolls: a 1 on the save, 4d6 of sixes)', () => {
  const { p, heroes, foe } = battle(['wizard', 'fighter', 'cleric']);
  const [wiz] = heroes;
  const s = statsAt('fireball', 2);
  const center = { x: 8, y: 4 };
  const inner = foe('goblin', 7, 4); // one tile from the centre
  const outer = foe('goblin', 10, 4); // two tiles from it
  const failAndSix = [showing(1), showing(6, 6), showing(6, 6), showing(6, 6), showing(6, 6)];
  dice(failAndSix, () => p.saveHit(wiz, inner, s, 'Fireball II', '#ff0000', atEdge(s, center, inner)));
  dice(failAndSix, () => p.saveHit(wiz, outer, s, 'Fireball II', '#ff0000', atEdge(s, center, outer)));
  assert.equal(100 - inner.hp, 24, 'the inner ring takes all of 4d6');
  assert.equal(100 - outer.hp, 12, 'the outer ring takes half');
  assert.ok(logged(p, /edge of the blast/));
});

test('Meteor (the Evoker spell) has the outer-ring falloff too', () => {
  assert.equal(atEdge(statsAt('meteor'), { x: 5, y: 3 }, { x: 7, y: 3 }), true);
});

// ---------------------------------------------------------------- rarity

test('act 1 rarity rolls match RARITY_ODDS over many seeded rolls (within 2 points)', () => {
  const N = 20_000;
  const r = makeRng(42);
  const counts: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  for (let i = 0; i < N; i++) counts[rollRarity(r.next(), 1)]++;
  assert.deepEqual(rarityOdds(1), RARITY_ODDS[1]);
  for (const k of RARITIES) {
    const got = (counts[k] / N) * 100;
    assert.ok(Math.abs(got - RARITY_ODDS[1][k]) <= 2, `${k}: ${got.toFixed(2)}% against ${RARITY_ODDS[1][k]}%`);
  }
  assert.equal(counts.legendary, 0, 'act 1 has no legendaries');
  assert.equal(pickRarity(0, RARITY_ODDS[1]), 'common');
  assert.equal(pickRarity(0.995, RARITY_ODDS[1]), 'epic');
});

test("an elite never drops a common, pity or no pity, and rolls on the next act's odds", () => {
  for (let i = 0; i <= 1000; i++) {
    const roll = i / 1001;
    for (const act of [1, 2, 3]) {
      assert.notEqual(rollRarity(roll, act, { elite: true }), 'common', `roll ${roll}, act ${act}`);
      assert.notEqual(rollRarity(roll, act, { elite: true, pity: 10 }), 'common', `roll ${roll}, act ${act}, with pity`);
    }
  }
  assert.deepEqual(rarityOdds(1, { elite: true }), { common: 0, uncommon: 81, rare: 14, epic: 4, legendary: 1 }, 'act 2 odds, the commons folded into uncommon');
});

test('pity moves points from common to rare, up to the commons there are', () => {
  assert.deepEqual(rarityOdds(1, { pity: 10 }), { common: 55, uncommon: 28, rare: 16, epic: 1, legendary: 0 });
  assert.deepEqual(rarityOdds(1, { pity: 200 }), { common: 0, uncommon: 28, rare: 71, epic: 1, legendary: 0 });
  assert.equal(rollRarity(0.62, 1), 'common');
  assert.equal(rollRarity(0.62, 1, { pity: 10 }), 'uncommon', 'the roll that was common is now uncommon');
  assert.equal(rollRarity(0.9, 1), 'uncommon');
  assert.equal(rollRarity(0.9, 1, { pity: 10 }), 'rare', 'and this one is rare');
  assert.equal(RARITY_PITY, 2);
});

test('rarityPool: the wanted rarity, else the nearest worse one, else the nearest better one', () => {
  const pool = (have: Rarity[], want: Rarity) => rarityPool(have.map((r) => ({ r })), (x) => x.r, want).map((x) => x.r);
  assert.deepEqual(pool(['uncommon', 'rare', 'epic'], 'rare'), ['rare']);
  assert.deepEqual(pool(['common', 'epic'], 'rare'), ['common'], 'no rare: the worse one, common, is nearer than epic');
  assert.deepEqual(pool(['uncommon', 'epic'], 'rare'), ['uncommon']);
  assert.deepEqual(pool(['legendary', 'epic'], 'rare'), ['epic'], 'nothing worse than rare: the nearest better');
  assert.deepEqual(pool(['common'], 'legendary'), ['common'], 'nothing better: the nearest worse');
  assert.deepEqual(pool(['uncommon', 'epic'], 'legendary'), ['epic']);
  assert.deepEqual(pool([], 'rare'), []);
});

test('nextPity: a rare or better resets the pity, anything below adds RARITY_PITY', () => {
  assert.equal(nextPity(undefined, 'common'), RARITY_PITY);
  assert.equal(nextPity(4, 'uncommon'), 4 + RARITY_PITY);
  assert.equal(nextPity(4, 'rare'), 0);
  assert.equal(nextPity(4, 'epic'), 0);
  assert.equal(nextPity(4, 'legendary'), 0);
});

// ---------------------------------------------------------------- relics

test('rollRelics(3): three different relics the party does not own, never a boss relic; nothing left when they own them all', () => {
  const { p } = battle();
  p.run.relics = ['whetstone', 'war_banner'];
  for (let seed = 1; seed <= 300; seed++) {
    const got: RelicId[] = seeded(seed, () => p.rollRelics(3));
    assert.equal(got.length, 3, `seed ${seed}`);
    assert.equal(new Set(got).size, 3, `seed ${seed}: ${got.join(', ')}`);
    for (const id of got) {
      assert.notEqual(RELICS[id].rarity, 'boss', id);
      assert.ok(!p.run.relics.includes(id), `${id} is not owned`);
    }
  }
  p.run.relics = RELIC_IDS.filter((id) => RELICS[id].rarity !== 'boss');
  assert.deepEqual(seeded(1, () => p.rollRelics(3)), []);
});

test('a chest: common relics come up more often than rare ones (RELIC_ODDS 50 / 33 / 17)', () => {
  const { p } = battle();
  p.run.relics = [];
  const count = { common: 0, uncommon: 0, rare: 0 };
  const N = 3000;
  for (let seed = 1; seed <= N; seed++) {
    const [id]: RelicId[] = seeded(seed, () => p.rollRelics(1));
    count[RELICS[id].rarity as 'common' | 'uncommon' | 'rare']++;
  }
  assert.ok(count.common > count.rare * 2, JSON.stringify(count));
  for (const k of ['common', 'uncommon', 'rare'] as const) {
    const got = (count[k] / N) * 100;
    assert.ok(Math.abs(got - RELIC_ODDS[k]) <= 3, `${k}: ${got.toFixed(1)}%`);
  }
});

// ---------------------------------------------------------------- the hero AI

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[], turnState: TurnState): HeroView {
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  const all: Entity[] = [...heroes, ...monsters];
  return {
    map: { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} }, hero: h, heroes, monsters, turn: turnState,
    occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)),
  };
}
const turn = (ap: number): TurnState => ({ order: [], init: {}, index: 0, round: 1, movesLeft: 0, ap });

test('a bot next to a downed friend chooses Help Up (with no potions, the only way to get them up)', () => {
  const { heroes, foe } = battle(['fighter', 'cleric']);
  const [ann, cid] = heroes;
  Object.assign(ann, { x: 4, y: 3, potions: 0 }); // with potions it would drink one instead: 1 AP, and a bit more HP
  Object.assign(cid, { x: 5, y: 3, hp: 0, downed: true });
  const gob = foe('goblin', 9, 6, 12);
  const intent = nextHeroIntent(view(ann, heroes, [gob], turn(3)));
  assert.deepEqual(intent, { kind: 'act', skill: 'help_up', target: cid.id }, JSON.stringify(intent));
});
