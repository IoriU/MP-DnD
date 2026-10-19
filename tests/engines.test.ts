// Build engines (decided 2026-10-19, in place of the level-3 subclass pick; shared/engines.ts): every class has three, and
// a hero's build is whichever engine its picks lean into. These tests cover the data (every card belongs to one engine of
// its class), the offers (no subclass, epic capstones gated, engines you own come up more often, act 1 is mostly common,
// Quick Stab), and the engine rules themselves, run through the real Game class (private members reached with `any`, as in
// tests/block.test.ts) with dice fixed by stubbing Math.random, as the other tests do.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { applyPick, dealOffer, makeEliteOffer, makeOffer, makeRewardOffer, recalcHero, startingSkills } from '../server/progression.ts';
import { makeRng } from '../server/rng.ts';
import { CLASSES, CLASS_IDS, MAX_CANTRIPS } from '../shared/rules.ts';
import { CARD_RARITIES, ENGINES, ENGINE_IDS, enginesOf, type EngineId } from '../shared/engines.ts';
import { apOf, blockOf, cardRarity, countKind, engineOf, isSkillId, limitFor, SKILLS, stacksOf, statsAt, type SkillId } from '../shared/skills.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, PlayerInfo } from '../shared/types.ts';

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-engines-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const own = (id: SkillId, tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B'): OwnedSkill => ({ id, tier, branch, cd: 0 });

/** The cards an engine lists, every rarity. */
const engineCards = (e: EngineId): SkillId[] => Object.values(ENGINES[e].cards).flat() as SkillId[];

/** A hero for the offer functions (no Game). `ids` replaces the starting kit, so the engine cards it owns are exactly these. */
function bare(classId: ClassId, level = 3, ids?: SkillId[]): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x: 0, y: 0,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level, xp: 0, skills: ids ? ids.map((id) => own(id)) : startingSkills(classId),
    levelUps: 0, offer: null, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [],
    elitePicks: 0, kills: 0, steals: 0, slots: 0, maxSlots: 0, downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [],
  };
  recalcHero(p);
  return p;
}

/** Dice that all land in the middle (Math.random 0.5): a d4 shows 3, a d6 shows 4, a d8 shows 5. */
function middle<T>(fn: () => T): T {
  const real = Math.random;
  Math.random = () => 0.5;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/** Dice that show these Math.random values in turn (then 0.5), the way tests/revive.test.ts does it. */
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

/** Heroes in a 12x8 walled room, in combat, at (4,2), (4,3), (4,4), and a rat far away so the fight goes on. */
function battle(classes: ClassId[] = ['fighter', 'paladin', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'ENGINES');
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
  p.turn.ap = Math.max(p.turn.ap, 9); // plenty of AP for the test's casts; the cost rules have their own tests
}

/** Effects that wait on a timer (Crushing Force's hurt) are collected, and `flush()` runs them now. */
function deferLater(p: any): () => void {
  const queue: (() => void)[] = [];
  p.later = (_token: number, _ms: number, fn: () => void) => queue.push(fn);
  return () => queue.splice(0).forEach((fn) => fn());
}

const offersOf = (p: PlayerEntity, seed: number, act = 1) => [...makeOffer(p, makeRng(seed)), ...makeRewardOffer(p, makeRng(seed + 7919), act), ...makeEliteOffer(p, makeRng(seed + 15485), act)];

// ---------------------------------------------------------------- the data

test('every engine card is a real skill in its engine\'s class pool', () => {
  for (const e of ENGINE_IDS) {
    for (const c of engineCards(e)) {
      assert.ok(isSkillId(c), `${c} (${e}) is not a skill`);
      assert.equal(SKILLS[c].pool, ENGINES[e].classId, `${c} is in ${e} but its pool is ${SKILLS[c].pool}`);
    }
  }
});

test('no card is in two engines', () => {
  const owner = new Map<string, EngineId>();
  for (const e of ENGINE_IDS) {
    for (const c of engineCards(e)) {
      assert.equal(owner.has(c), false, `${c} is in ${owner.get(c)} and ${e}`);
      owner.set(c, e);
    }
  }
});

test('three engines per class, 24 in all, and every engine has an epic capstone', () => {
  assert.equal(ENGINE_IDS.length, 24);
  for (const c of CLASS_IDS) assert.equal(enginesOf(c).length, 3, `${c} has three engines`);
  for (const e of ENGINE_IDS) assert.ok((ENGINES[e].cards.epic?.length ?? 0) >= 1, `${e} has an epic`);
});

test('a card has the rarity its engine lists it under, and a card outside the engines is common', () => {
  for (const e of ENGINE_IDS) {
    for (const r of CARD_RARITIES) for (const c of ENGINES[e].cards[r] ?? []) assert.equal(cardRarity(c), r, `${c} in ${e}`);
  }
  assert.equal(engineOf('tough'), undefined, 'Tough is not an engine card');
  assert.equal(cardRarity('tough'), 'common');
});

test('every engine card except Quick Stab (a basic attack) has tier II, III-A and III-B', () => {
  for (const e of ENGINE_IDS) {
    for (const c of engineCards(e)) {
      if (SKILLS[c].kind === 'basic') {
        assert.equal(c, 'quick_stab', `only Quick Stab is a basic attack among the cards, found ${c}`);
        continue;
      }
      assert.ok(SKILLS[c].t2 && SKILLS[c].a && SKILLS[c].b, `${c} needs tiers II, III-A and III-B`);
    }
  }
});

// ---------------------------------------------------------------- the offers

test('no subclass is offered at level 3, and no level-up pick is owed for it', () => {
  for (const c of CLASS_IDS) {
    for (let s = 1; s <= 40; s++) {
      const p = bare(c, 3);
      for (const card of offersOf(p, s, 1 + (s % 3))) assert.notEqual(card.kind, 'subclass', `${c} seed ${s}`);
    }
  }
  const p = bare('fighter', 3);
  p.levelUps = 0;
  dealOffer(p, makeRng(1), 1);
  assert.equal(p.offer, null, 'with nothing owed, nothing is dealt');
});

test('an epic capstone is never offered to a hero owning fewer than 2 cards of its engine', () => {
  for (const e of ENGINE_IDS) {
    const epic = ENGINES[e].cards.epic![0];
    const others = engineCards(e).filter((c) => c !== epic);
    for (const owned of [0, 1]) {
      const p = bare(ENGINES[e].classId, 3, others.slice(0, owned));
      for (let s = 1; s <= 120; s++) {
        const got = offersOf(p, s, 3);
        assert.ok(!got.some((c) => c.kind === 'learn' && c.skill === epic), `${e}: ${epic} offered with ${owned} card(s) of it`);
      }
    }
  }
});

test('with two picked cards of an engine (starting cards do not count), its epic capstone can be offered', () => {
  const never: string[] = [];
  for (const e of ENGINE_IDS) {
    const epic = ENGINES[e].cards.epic![0];
    const others = engineCards(e).filter((c) => c !== epic && !CLASSES[ENGINES[e].classId].start.includes(c));
    const p = bare(ENGINES[e].classId, 3, others.slice(0, 2));
    let seen = false;
    for (let s = 1; s <= 400 && !seen; s++) seen = offersOf(p, s, 3).some((c) => c.kind === 'learn' && c.skill === epic);
    if (!seen) never.push(e);
  }
  assert.deepEqual(never, [], 'engines whose epic was never offered with two of their cards');
});

test('the more of an engine you own, the likelier its cards come up: two cards clearly beat none', () => {
  const share = (owned: SkillId[]) => {
    const p = bare('rogue', 3, owned);
    let n = 0;
    for (let s = 1; s <= 1500; s++) if (makeOffer(p, makeRng(s)).some((c) => (c.kind === 'learn' || c.kind === 'upgrade') && engineOf(c.skill) === 'assassin')) n++;
    return n / 1500;
  };
  const none = share([]);
  const two = share(['envenom', 'hail_of_arrows']);
  assert.ok(two > none * 1.4, `assassin cards in ${(two * 100).toFixed(1)}% of offers with two, ${(none * 100).toFixed(1)}% with none`);
});

test('in act 1 most of the new-skill cards offered are common', () => {
  let common = 0;
  let all = 0;
  for (const c of CLASS_IDS) {
    const p = bare(c, 3);
    for (let s = 1; s <= 200; s++) {
      for (const card of makeRewardOffer(p, makeRng(s), 1)) {
        if (card.kind !== 'learn') continue;
        all++;
        if (cardRarity(card.skill) === 'common') common++;
      }
    }
  }
  assert.ok(common / all > 0.5, `${common} of ${all} act 1 learn cards are common`);
});

test('Quick Stab is a card a rogue can be offered, and it is learned without a slot even with the cantrip bar full', () => {
  let offered = false;
  for (let s = 1; s <= 300 && !offered; s++) offered = makeOffer(bare('rogue', 3, []), makeRng(s)).some((c) => c.kind === 'learn' && c.skill === 'quick_stab');
  assert.ok(offered, 'Quick Stab is offered to a rogue');
  const p = bare('rogue', 3, ['envenom', 'toxic_catalyst', 'rupture']);
  assert.equal(countKind(p, 'cantrip'), limitFor(p, 'cantrip'), 'the cantrip bar is full');
  p.levelUps = 1;
  p.offer = [{ kind: 'learn', skill: 'quick_stab' }];
  p.offerKind = 'level';
  assert.equal(applyPick(p, { card: 0 }, makeRng(1)).ok, true);
  assert.ok(p.skills.some((s) => s.id === 'quick_stab'));
  assert.equal(countKind(p, 'cantrip'), MAX_CANTRIPS, 'nothing was forgotten');
});

// ---------------------------------------------------------------- the rules

test('Poison from a hero stacks: two applications add up, and it caps at 10', () => {
  const { p, heroes, foe } = battle(['rogue']);
  const goblin = foe('goblin', 5, 2);
  p.applyStatus(goblin, { id: 'poisoned', turns: 2, power: 2 }, heroes[0]);
  p.applyStatus(goblin, { id: 'poisoned', turns: 2, power: 2 }, heroes[0]);
  assert.equal(stacksOf(goblin, 'poisoned'), 4);
  for (let i = 0; i < 5; i++) p.applyStatus(goblin, { id: 'poisoned', turns: 2, power: 2 }, heroes[0]);
  assert.equal(stacksOf(goblin, 'poisoned'), 10, 'POISON_CAP');
});

test('Toxic Catalyst doubles the Poison on a monster', () => {
  const { p, heroes, foe } = battle(['rogue']);
  const [rogue] = heroes;
  rogue.skills.push(own('toxic_catalyst'));
  const goblin = foe('goblin', 5, 2);
  p.applyStatus(goblin, { id: 'poisoned', turns: 2, power: 3 }, rogue);
  startTurn(p, rogue);
  assert.equal(p.handleSkill(rogue.playerId, 'toxic_catalyst', goblin.id), true);
  assert.equal(stacksOf(goblin, 'poisoned'), 6);
});

test('Rupture deals 3 more per Poison on the target', () => {
  const { p, heroes, foe } = battle(['rogue']);
  const [rogue] = heroes;
  rogue.skills.push(own('rupture'));
  const goblin = foe('goblin', 5, 2);
  p.applyStatus(goblin, { id: 'poisoned', turns: 2, power: 2 }, rogue);
  startTurn(p, rogue);
  const before = goblin.hp;
  assert.equal(middle(() => p.handleSkill(rogue.playerId, 'rupture', goblin.id)), true);
  assert.equal(before - goblin.hp, 3 + 2 * 3, '1d4 (a 3 under middle()) plus 3 for each of the 2 Poison');
});

test('Virulence: the Poison ticks d6s and never wears off; without it, d4s and it runs out', () => {
  const plain = battle(['rogue']);
  const goblin = plain.foe('goblin', 5, 2);
  plain.p.applyStatus(goblin, { id: 'poisoned', turns: 2, power: 2 }, plain.heroes[0]);
  const hp0 = goblin.hp;
  middle(() => plain.p.tickStatuses(goblin));
  assert.equal(hp0 - goblin.hp, 2 * 3, 'two d4s at 3');
  plain.p.endOfTurn(goblin);
  plain.p.endOfTurn(goblin);
  assert.equal(stacksOf(goblin, 'poisoned'), 0, 'gone after two turns');

  const { p, heroes, foe } = battle(['rogue']);
  const [rogue] = heroes;
  rogue.skills.push(own('virulence'));
  const goblin2 = foe('goblin', 5, 2);
  p.applyStatus(goblin2, { id: 'poisoned', turns: 2, power: 2 }, rogue);
  const hp = goblin2.hp;
  middle(() => p.tickStatuses(goblin2));
  assert.equal(hp - goblin2.hp, 2 * 4, 'two d6s at 4');
  for (let i = 0; i < 3; i++) p.endOfTurn(goblin2);
  assert.equal(stacksOf(goblin2, 'poisoned'), 2, 'still Poisoned after three turns');
});

test('Keen Edge: attacks crit on a 19, and a 19 in a real attack is a critical hit', () => {
  const { p, heroes, foe } = battle(['fighter']);
  const [fighter] = heroes;
  fighter.skills.push(own('keen_edge'));
  const goblin = foe('goblin', 5, 2);
  assert.equal(p.critRangeOf(fighter, goblin), 19);
  fighter.skills = fighter.skills.filter((s) => s.id !== 'keen_edge');
  assert.equal(p.critRangeOf(fighter, goblin), 20, 'without it, only a natural 20');
  fighter.skills.push(own('keen_edge'));
  startTurn(p, fighter);
  dice([showing(19), showing(19)], () => p.handleSkill(fighter.playerId, 'longsword', goblin.id));
  assert.ok(p.log.some((l: { text: string }) => /CRITICAL HIT/.test(l.text) && /Goblin/.test(l.text)), 'the 19 is a crit');
});

test('Devastating Blows: a crit rolls one more set of damage dice (and +3 at tier II)', () => {
  const { p, heroes, foe } = battle(['fighter']);
  const [fighter] = heroes;
  const goblin = foe('goblin', 5, 2);
  const d8 = { n: 1, d: 8 };
  assert.equal(p.critExtra(fighter, goblin, d8, null), 0, 'no crit bonus without the passive');
  fighter.skills.push(own('devastating_blows', 1));
  assert.equal(middle(() => p.critExtra(fighter, goblin, d8, null)), 5, 'one d8 (a 5 under middle())');
  fighter.skills = fighter.skills.map((s) => (s.id === 'devastating_blows' ? own('devastating_blows', 2) : s));
  assert.equal(middle(() => p.critExtra(fighter, goblin, d8, null)), 5 + 3, 'and +3 damage at tier II');
});

test('Flurry: each hit after the first in a turn deals one more than the hit before it (+1, then +2 over the first)', () => {
  const { p, heroes, foe } = battle(['rogue']);
  const [rogue] = heroes;
  rogue.skills.push(own('flurry'));
  const goblin = foe('goblin', 5, 2);
  startTurn(p, rogue);
  const hp = [goblin.hp];
  // 0.9 shows a 19 on the d20: a hit against AC 15 that does not crit.
  const real = Math.random;
  Math.random = () => 0.9;
  try {
    for (let i = 0; i < 3; i++) {
      p.handleSkill(rogue.playerId, 'rapier', goblin.id);
      hp.push(goblin.hp);
    }
  } finally {
    Math.random = real;
  }
  const dealt = [hp[0] - hp[1], hp[1] - hp[2], hp[2] - hp[3]];
  assert.equal(dealt[1] - dealt[0], 1, `hit 2 is 1 more than hit 1 (${dealt})`);
  assert.equal(dealt[2] - dealt[1], 1, `hit 3 is 1 more than hit 2, so 2 more than hit 1 (${dealt})`);
});

test('Arcane Charge: a spell adds a Charge, and each Charge adds 1 to the next spell\'s damage', () => {
  const { p, heroes, foe } = battle(['wizard']);
  const [wiz] = heroes;
  wiz.skills.push(own('arcane_charge'));
  const goblin = foe('goblin', 5, 2);
  startTurn(p, wiz);
  const first = goblin.hp;
  middle(() => p.handleSkill(wiz.playerId, 'magic_missile', goblin.id));
  assert.equal(stacksOf(wiz, 'charged'), 1, 'the spell gave a Charge');
  const once = first - goblin.hp;
  const second = goblin.hp;
  middle(() => p.handleSkill(wiz.playerId, 'magic_missile', goblin.id));
  assert.equal(stacksOf(wiz, 'charged'), 2);
  assert.equal(second - goblin.hp - once, 3, 'one Charge: +1 on each of the 3 darts');
});

test('Unleash: the Charges become Unleashed, and the next spell spends them', () => {
  const { p, heroes, foe } = battle(['wizard']);
  const [wiz] = heroes;
  wiz.skills.push(own('unleash'));
  const goblin = foe('goblin', 5, 2);
  startTurn(p, wiz);
  wiz.statuses.push({ id: 'charged', turns: 99, power: 3, by: wiz.id });
  assert.equal(p.handleSkill(wiz.playerId, 'unleash'), true);
  assert.equal(stacksOf(wiz, 'charged'), 0, 'the Charges are spent');
  assert.equal(stacksOf(wiz, 'unleashed'), 3, 'and held for the next spell');
  assert.equal(p.handleSkill(wiz.playerId, 'magic_missile', goblin.id), true);
  assert.equal(stacksOf(wiz, 'unleashed'), 0, 'the spell used it up');
});

// Found while writing these tests (fixed): autoHit calls bonusDamage once per dart, and the Unleash dice used to come
// with every dart.
test('Unleash adds its dice once per target: 3 Charges on a goblin hit by Magic Missile add 3d6 (12 under middle()), not 9d6', () => {
    const dealt = (unleashed: number) => {
      const { p, heroes, foe } = battle(['wizard']);
      const [wiz] = heroes;
      wiz.skills.push(own('magic_missile'));
      const goblin = foe('goblin', 5, 2);
      if (unleashed) wiz.statuses.push({ id: 'unleashed', turns: 99, power: unleashed, by: wiz.id });
      startTurn(p, wiz);
      const hp = goblin.hp;
      middle(() => p.handleSkill(wiz.playerId, 'magic_missile', goblin.id));
      return hp - goblin.hp;
    };
    assert.equal(dealt(3) - dealt(0), 3 * 4, 'three d6 (4 each under middle())');
  });

test('Archmage: with 3 Charges a 3-AP spell costs 2 AP, and with 2 it still costs 3', () => {
  const { heroes } = battle(['wizard']);
  const [wiz] = heroes;
  wiz.skills.push(own('archmage'));
  const fireball = statsAt('fireball');
  assert.equal(apOf(wiz, 'fireball', fireball), 3);
  wiz.statuses.push({ id: 'charged', turns: 99, power: 2, by: wiz.id });
  assert.equal(apOf(wiz, 'fireball', fireball), 3, 'two Charges are not enough');
  wiz.statuses = [{ id: 'charged', turns: 99, power: 3, by: wiz.id }];
  assert.equal(apOf(wiz, 'fireball', fireball), 2);
  assert.equal(apOf(wiz, 'magic_missile', statsAt('magic_missile')), 2, 'a 2-AP spell is unchanged');
});

test('Shield Slam adds your Block to the damage, and does not spend it', () => {
  /** One swing at a goblin with `block` Block on the fighter (the same dice both times: a 18 to hit, a 3 on the d4). */
  const swing = (block: number) => {
    const { p, heroes, foe } = battle(['fighter']);
    const [fighter] = heroes;
    fighter.skills.push(own('shield_slam'));
    const goblin = foe('goblin', 5, 2);
    startTurn(p, fighter); // a creature's own Block runs out when its turn starts, so the Block goes on after this
    if (block) fighter.block = { [fighter.id]: block };
    const hp = goblin.hp;
    dice([showing(18), showing(18)], () => p.handleSkill(fighter.playerId, 'shield_slam', goblin.id));
    return { dealt: hp - goblin.hp, blockLeft: blockOf(fighter) };
  };
  const without = swing(0);
  const withBlock = swing(4);
  assert.ok(without.dealt > 0, 'the swing hits');
  assert.equal(withBlock.dealt - without.dealt, 4, 'the 4 Block adds 4');
  assert.equal(withBlock.blockLeft, 4, 'Shield Slam does not spend the Block');
});

test('Entrench doubles the Block you gave yourself', () => {
  const { p, heroes } = battle(['fighter']);
  const [fighter] = heroes;
  fighter.skills.push(own('entrench'));
  startTurn(p, fighter); // a creature's own Block runs out when its turn starts, so the Block goes on after this
  fighter.block = { [fighter.id]: 3 };
  assert.equal(p.handleSkill(fighter.playerId, 'entrench'), true);
  assert.equal(blockOf(fighter), 6);
});

test('Fortress keeps half your own Block at the start of your turn, three quarters at tier II', () => {
  const { p, heroes } = battle(['fighter']);
  const [fighter] = heroes;
  fighter.skills.push(own('fortress', 1));
  fighter.block = { [fighter.id]: 4 };
  p.expireBlock(fighter);
  assert.equal(fighter.block?.[fighter.id], 2, 'half of 4');
  fighter.skills = fighter.skills.map((s) => (s.id === 'fortress' ? own('fortress', 2) : s));
  fighter.block = { [fighter.id]: 4 };
  p.expireBlock(fighter);
  assert.equal(fighter.block?.[fighter.id], 3, 'three quarters of 4');
});

test('Unbreakable Oath keeps the Block you gave through one more turn of yours', () => {
  const { p, heroes } = battle(['paladin', 'fighter']);
  const [paladin, ann] = heroes;
  paladin.skills.push(own('unbreakable_oath'));
  ann.block = { [paladin.id]: 4 };
  p.expireBlock(paladin);
  assert.equal(blockOf(ann), 4, 'still there after the paladin\'s next turn starts');
  p.expireBlock(paladin);
  assert.equal(blockOf(ann), 0, 'and gone after the one after');
});

test('Overflowing Grace turns the healing past full HP into Block on the friend', () => {
  // The healing amount, from a friend far below full HP (no overflow, no grace).
  const plain = battle(['cleric', 'fighter']);
  plain.heroes[1].hp = 1;
  startTurn(plain.p, plain.heroes[0]);
  middle(() => plain.p.handleSkill(plain.heroes[0].playerId, 'healing_word', plain.heroes[1].id));
  const healed = plain.heroes[1].hp - 1;
  assert.ok(healed >= 2, `healing word heals ${healed}`);

  const { p, heroes } = battle(['cleric', 'fighter']);
  const [cleric, fighter] = heroes;
  cleric.skills.push(own('overflowing_grace'));
  fighter.hp = fighter.maxHp - 1;
  startTurn(p, cleric);
  middle(() => p.handleSkill(cleric.playerId, 'healing_word', fighter.id));
  assert.equal(fighter.hp, fighter.maxHp, 'healed to full');
  assert.equal(blockOf(fighter), healed - 1, 'the rest of the healing is Block');
  assert.equal(fighter.tempHp, 0, 'and not temporary HP');
});

test('Soul Link: the cleric\'s heals on anyone else also heal the linked hero for half', () => {
  const { p, heroes } = battle(['cleric', 'fighter', 'paladin']);
  const [cleric, fighter, paladin] = heroes;
  cleric.skills.push(own('soul_link'));
  fighter.hp = fighter.maxHp - 10;
  paladin.hp = 1;
  startTurn(p, cleric);
  assert.equal(p.handleSkill(cleric.playerId, 'soul_link', fighter.id), true);
  assert.ok(fighter.statuses.some((s: { id: string }) => s.id === 'linked'), 'the fighter is linked');
  const before = { fighter: fighter.hp, paladin: paladin.hp };
  middle(() => p.handleSkill(cleric.playerId, 'healing_word', paladin.id));
  const healed = paladin.hp - before.paladin;
  assert.ok(healed >= 2, `the paladin is healed ${healed}`);
  assert.equal(fighter.hp - before.fighter, Math.floor((healed * 50) / 100), 'the fighter gets half of it');
});

test('Raise Cover puts low cover on the empty tile you aim at', () => {
  const { p, heroes } = battle(['wizard']);
  const [wiz] = heroes;
  wiz.skills.push(own('raise_cover'));
  startTurn(p, wiz);
  const i = 5 * 12 + 7;
  assert.equal(p.tiles[i], '.');
  assert.equal(p.handleSkill(wiz.playerId, 'raise_cover', { x: 7, y: 5 }), true);
  assert.equal(p.tiles[i], 'o', 'low cover (shared/grid.ts LOW_COVER)');
});

test('Wall of Stone: a wall stands for its 3 rounds, then turns back into floor', () => {
  const { p, heroes } = battle(['wizard']);
  const [wiz] = heroes;
  wiz.skills.push(own('wall_of_stone'));
  startTurn(p, wiz);
  const i = 5 * 12 + 7;
  assert.equal(p.handleSkill(wiz.playerId, 'wall_of_stone', { x: 7, y: 5 }), true);
  assert.equal(p.tiles[i], '#');
  p.tickRaised();
  p.tickRaised();
  assert.equal(p.tiles[i], '#', 'still standing after 2 rounds');
  p.tickRaised();
  assert.equal(p.tiles[i], '.', 'gone after 3');
});

test('Crushing Force: a push into a wall hurts the monster for 1d6 per tile it could not move', () => {
  const { p, heroes, foe } = battle(['wizard']);
  const [wiz] = heroes;
  wiz.skills.push(own('crushing_force'));
  const goblin = foe('goblin', 10, 3); // the wall is at x=11
  const flush = deferLater(p);
  const hp = goblin.hp;
  middle(() => p.push(goblin, { x: 9, y: 3 }, 2, wiz));
  assert.equal(goblin.hp, hp, 'the hurt waits for its timer');
  middle(() => flush());
  assert.equal(hp - goblin.hp, 2 * 4, 'two d6 (4 each under middle())');
});

test('Patience: a turn without moving gives 1 Focus, up to 3; a turn that moved gives none', () => {
  const { p, heroes } = battle(['ranger']);
  const [ranger] = heroes;
  ranger.skills.push(own('patience'));
  ranger.used = ['turn:moved'];
  p.endOfTurn(ranger);
  assert.equal(stacksOf(ranger, 'aiming'), 0, 'it moved');
  for (let i = 0; i < 4; i++) {
    ranger.used = [];
    p.endOfTurn(ranger);
  }
  assert.equal(stacksOf(ranger, 'aiming'), 3, 'four quiet turns: capped at 3');
});

test('Finale heals and gives Block for each Verse, and spends them; Magnum Opus keeps the first ones', () => {
  const { p, heroes } = battle(['bard', 'fighter']);
  const [bard, fighter] = heroes;
  bard.skills.push(own('finale'), own('magnum_opus'));
  fighter.hp = fighter.maxHp - 10;
  bard.statuses.push({ id: 'verse', turns: 99, power: 2, by: bard.id });
  startTurn(p, bard);
  const hp = fighter.hp;
  assert.equal(p.handleSkill(bard.playerId, 'finale'), true);
  assert.equal(fighter.hp - hp, 4, '2 HP per Verse, 2 Verses');
  assert.equal(blockOf(fighter), 4, '2 Block per Verse');
  assert.equal(stacksOf(bard, 'verse'), 2, 'the first Finale keeps its Verses (Magnum Opus)');
  assert.equal(p.handleSkill(bard.playerId, 'finale'), true);
  assert.equal(stacksOf(bard, 'verse'), 0, 'the second spends them');
});

test('Madness: a monster with 3 of a bard\'s debuffs attacks another monster next to it; with 2, it does not', () => {
  const { p, heroes, foe } = battle(['bard']);
  const [bard] = heroes;
  bard.skills.push(own('madness'));
  const goblin = foe('goblin', 6, 3);
  const friend = foe('goblin', 7, 3);
  p.applyStatus(goblin, { id: 'dazed', turns: 3 }, bard);
  p.applyStatus(goblin, { id: 'blinded', turns: 3 }, bard);
  assert.equal(p.madness(goblin), false, 'two debuffs: not mad yet');
  p.applyStatus(goblin, { id: 'marked', turns: 3 }, bard);
  assert.equal(p.madness(goblin), true, 'three debuffs: mad');
  assert.ok(p.log.some((l: { text: string }) => /goes mad and turns on/.test(l.text) && l.text.includes(friend.name)), 'it turned on its friend');
});

test('Unkillable: a raging barbarian stays at 1 HP; without Rage, the same hit drops them', () => {
  const { p, heroes } = battle(['barbarian']);
  const [barb] = heroes;
  barb.skills.push(own('unkillable'));
  barb.hp = 5;
  barb.statuses.push({ id: 'raging', turns: 3, power: 2, by: barb.id });
  p.damage(barb, 50);
  assert.equal(barb.hp, 1, 'kept at 1 HP');
  assert.equal(barb.downed, false);
  barb.statuses = [];
  barb.hp = 5;
  p.damage(barb, 50);
  assert.equal(barb.downed, true, 'no Rage: down');
});

test('Shared Burden: when a paladin\'s Block soaks a hit on a friend, the paladin heals half of what it soaked', () => {
  const { p, heroes } = battle(['paladin', 'fighter']);
  const [paladin, ann] = heroes;
  paladin.skills.push(own('shared_burden'));
  paladin.hp = paladin.maxHp - 5;
  ann.block = { [paladin.id]: 4 };
  const annHp = ann.hp;
  p.damage(ann, 4);
  assert.equal(ann.hp, annHp, 'the Block took the whole hit');
  assert.equal(paladin.hp, paladin.maxHp - 5 + 2, 'half of the 4 soaked');
});

test('Haunting Refrain: a bard\'s debuffs on monsters last a turn longer; its buffs do not change', () => {
  const { p, heroes, foe } = battle(['bard']);
  const [bard] = heroes;
  bard.skills.push(own('haunting_refrain'));
  const goblin = foe('goblin', 5, 2);
  p.applyStatus(goblin, { id: 'dazed', turns: 2 }, bard);
  assert.equal(goblin.statuses.find((s: { id: string }) => s.id === 'dazed')?.turns, 3);
  p.applyStatus(goblin, { id: 'rallied', turns: 2 }, bard);
  assert.equal(goblin.statuses.find((s: { id: string }) => s.id === 'rallied')?.turns, 2);
});

test('Pile Driver: a won Shove knocks the target Prone, and the first Shove each turn costs no AP', () => {
  const { p, heroes, foe } = battle(['barbarian']);
  const [barb] = heroes;
  barb.skills.push(own('pile_driver', 2));
  const goblin = foe('goblin', 5, 2);
  startTurn(p, barb);
  assert.equal(apOf(barb, 'shove', statsAt('shove')), 0, 'free before it is used');
  dice([showing(20), showing(1)], () => p.handleSkill(barb.playerId, 'shove', goblin.id));
  assert.ok(goblin.statuses.some((s: { id: string }) => s.id === 'prone'), 'the Shove knocked it Prone');
  assert.equal(apOf(barb, 'shove', statsAt('shove')), 1, 'the second Shove this turn costs 1 AP');
});
