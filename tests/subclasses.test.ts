import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { nextHeroIntent, type HeroView } from '../server/heroai.ts';
import { applyPick, dealOffer, makeOffer, recalcHero, startingSkills } from '../server/progression.ts';
import { makeRng } from '../server/rng.ts';
import { AP_GAIN } from '../shared/rules.ts';
import { SKILLS, blockOf, countKind, engineOf, hpCostOf, isSignature, limitFor, resolveAim, skillBlockReason, statsAt, type AimResult } from '../shared/skills.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, PlayerInfo, TurnState } from '../shared/types.ts';

// Subclasses, old style. Since 2026-10-19 there is no subclass pick (builds are engines, shared/engines.ts, tested in
// tests/engines.test.ts): levels and victories give skill cards, and no offer has a subclass card. What's left here is
// the rules for a save made before that change, where a hero still has `subclass` set: its signature skill is learned at
// once, takes no slot and can't be forgotten, and the subclass's own rules (Blood Price, Snare Trap, ...) still work.
// These tests drive those rules through the real Game class (private members reached with `any`, as in tests/block.test.ts)
// and the level-up offers on hand-made heroes (as in tests/progression.test.ts).

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-subclasses-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const own = (id: OwnedSkill['id'], tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B'): OwnedSkill => ({ id, tier, branch, cd: 0 });

/** Dice that all land in the middle (Math.random 0.5): a d6 shows 4. */
function middle<T>(fn: () => T): T {
  const real = Math.random;
  Math.random = () => 0.5;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/** Dice that show these numbers (Math.random values), the way tests/ap.test.ts does it. */
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
/** The Math.random value that makes a d20 (or any die with `sides`) show n. */
const showing = (n: number, sides = 20) => (n - 0.5) / sides;

/** Heroes in a 12x8 walled room, in combat, with a rat far away so the fight goes on. */
function battle(classes: ClassId[] = ['fighter', 'paladin', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'SUBCLASS');
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

/** A hand-made hero for the level-up picks (no Game needed), built the way tests/progression.test.ts does it. */
function progHero(classId: ClassId, level = 1): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x: 0, y: 0,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [], elitePicks: 0, kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [],
  };
  recalcHero(p);
  return p;
}

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[], turn: TurnState): HeroView {
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  const all = [...heroes, ...monsters];
  return {
    map: { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} }, hero: h, heroes, monsters, turn,
    occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)),
  };
}
const turn = (ap: number): TurnState => ({ order: [], init: {}, index: 0, round: 1, movesLeft: 0, ap });

// ---------------------------------------------------------------- picking a subclass

test('no subclass pick any more: a level-3 fighter\'s level-up pick is skill cards, never a subclass', () => {
  const f = progHero('fighter', 3);
  f.levelUps = 1;
  dealOffer(f, makeRng(1), 1);
  assert.equal(f.offerKind, 'level');
  assert.ok(f.offer && f.offer.length === 3, 'three cards');
  assert.deepEqual(
    f.offer?.map((c) => c.kind).filter((k) => k === 'subclass'),
    [],
    'no subclass card',
  );
});

test('a save from before engines: a hero with a subclass keeps its signature, which takes no slot and cannot be forgotten', () => {
  const f = progHero('fighter', 3);
  const plain = countKind(f, 'cantrip');
  f.subclass = 'weapon_master';
  f.skills.push(own('cleave'));
  assert.ok(isSignature(f, 'cleave'));
  assert.equal(countKind(f, 'cantrip'), plain, 'Cleave takes no slot on the cantrip bar');
  assert.equal(f.skills.filter((s) => SKILLS[s.id].kind === 'cantrip').length, plain + 1, 'but it is a cantrip');
  // It can't be forgotten to make room: with the bar full, only a plain cantrip can go.
  f.skills.push(own('heavy_strike'), own('battle_cry'));
  assert.equal(countKind(f, 'cantrip'), limitFor(f, 'cantrip'));
  f.levelUps = 1;
  f.offer = [{ kind: 'learn', skill: 'trip_attack' }];
  assert.equal(applyPick(f, { card: 0, forget: 'cleave' }, makeRng(1)).ok, false, 'the signature cannot be forgotten');
  assert.ok(f.skills.some((s) => s.id === 'cleave'));
});

test('with the cantrip bar full, learning a cantrip cannot forget the signature (but forgetting another one works)', () => {
  const f = progHero('fighter', 3);
  f.subclass = 'weapon_master';
  f.skills.push(own('cleave'), own('heavy_strike'), own('battle_cry'));
  assert.equal(countKind(f, 'cantrip'), 3, 'Shield Bash, Heavy Strike and Battle Cry fill the bar');
  assert.equal(countKind(f, 'cantrip'), limitFor(f, 'cantrip'));
  f.levelUps = 1;
  f.offer = [{ kind: 'learn', skill: 'trip_attack' }];
  const refused = applyPick(f, { card: 0, forget: 'cleave' }, makeRng(1));
  assert.equal(refused.ok, false);
  assert.ok(f.skills.some((s) => s.id === 'cleave'), 'the signature is still there');
  assert.ok(!f.skills.some((s) => s.id === 'trip_attack'), 'and nothing was learned');
  assert.equal(f.levelUps, 1, 'the pick is still waiting');
  const ok = applyPick(f, { card: 0, forget: 'heavy_strike' }, makeRng(1));
  assert.equal(ok.ok, true, 'forgetting a plain cantrip is fine');
  assert.ok(f.skills.some((s) => s.id === 'trip_attack'));
  assert.ok(f.skills.some((s) => s.id === 'cleave'));
});

// ---------------------------------------------------------------- offers after the pick

test('a fighter with an old subclass is still offered only fighter and common skills, and its engine\'s cards come up', () => {
  const f = progHero('fighter', 4);
  f.subclass = 'guardian';
  f.skills.push(own('shield_wall'));
  let sawGuardian = false;
  for (let seed = 1; seed <= 200; seed++) {
    for (const card of makeOffer(f, makeRng(seed))) {
      if (card.kind !== 'learn' && card.kind !== 'upgrade') continue;
      const pool = SKILLS[card.skill].pool;
      assert.ok(pool === 'fighter' || pool === 'common', `seed ${seed}: offered ${card.skill}, which is ${pool}'s`);
      if (engineOf(card.skill) === 'guardian') sawGuardian = true;
    }
  }
  assert.ok(sawGuardian, 'a Guardian (engine) card shows up in some offer');
});

// ---------------------------------------------------------------- Berserker: Blood Price

test('Blood Price (Berserker): costs HP for 1 AP back, and only once per turn', () => {
  const { p, heroes } = battle(['barbarian', 'fighter']);
  const [ann] = heroes;
  ann.subclass = 'berserker';
  ann.skills.push(own('blood_price'));
  const cost = hpCostOf(ann, statsAt('blood_price'));
  assert.ok(cost > 0);
  startTurn(p, ann);
  assert.equal(p.turn.ap, AP_GAIN);
  const hp = ann.hp;
  assert.equal(p.handleSkill(ann.playerId, 'blood_price'), true);
  assert.equal(ann.hp, hp - cost, 'pays hpCostOf HP');
  assert.equal(p.turn.ap, 4, 'no AP spent, and 1 AP back');
  assert.equal(p.handleSkill(ann.playerId, 'blood_price'), false, 'a second use is refused');
  assert.equal(skillBlockReason(ann, 'blood_price', true, p.turn, true), 'Only once per turn');
  assert.equal(ann.hp, hp - cost, 'and it does not charge again');
  assert.equal(p.turn.ap, 4);
});

// ---------------------------------------------------------------- Order: Voice of Authority

test('Voice of Authority (Order cleric): a friend the cleric buffs starts their next turn with +1 AP, and the Emboldened is gone', () => {
  const { p, heroes } = battle();
  const [ann, , cleric] = heroes;
  cleric.subclass = 'order';
  cleric.skills.push(own('warding_light'), own('voice_of_authority'));
  startTurn(p, cleric);
  assert.equal(p.handleSkill(cleric.playerId, 'warding_light', ann.id), true);
  assert.ok(blockOf(ann) > 0, 'Warding Light put up Block');
  const bold = ann.statuses.find((s: { id: string }) => s.id === 'emboldened');
  assert.ok(bold, 'the friend is Emboldened');
  assert.equal(bold.power, 1);
  startTurn(p, ann);
  assert.equal(p.turn.ap, AP_GAIN + 1, '3 + 1');
  assert.equal(ann.statuses.some((s: { id: string }) => s.id === 'emboldened'), false, 'used up');
});

// ---------------------------------------------------------------- Trapper: Snare Trap

test('Snare Trap: refused on an occupied tile, and on an empty tile it waits in p.traps', () => {
  const { p, heroes } = battle(['ranger', 'fighter']);
  const [ranger, fighter] = heroes;
  ranger.subclass = 'trapper';
  ranger.skills.push(own('snare_trap'));
  startTurn(p, ranger);
  assert.equal(p.handleSkill(ranger.playerId, 'snare_trap', { x: fighter.x, y: fighter.y }), false, 'an occupied tile');
  assert.equal(p.traps.size, 0);
  assert.equal(p.handleSkill(ranger.playerId, 'snare_trap', { x: 7, y: 5 }), true, 'an empty tile');
  assert.ok(p.traps.has(5 * 12 + 7));
});

test('Snare Trap springs when a monster steps on it: the snare is gone, the monster is Netted and takes 1d6', () => {
  const { p, heroes, foe } = battle(['ranger', 'fighter']);
  const [ranger] = heroes;
  ranger.subclass = 'trapper';
  ranger.skills.push(own('snare_trap'));
  startTurn(p, ranger);
  assert.equal(p.handleSkill(ranger.playerId, 'snare_trap', { x: 7, y: 5 }), true);
  const goblin = foe('goblin', 9, 5);
  goblin.x = 7;
  goblin.y = 5;
  const stuck = middle(() => p.standIn(goblin, 'step'));
  assert.equal(stuck, true, 'it is stopped in its tracks');
  assert.equal(p.traps.has(5 * 12 + 7), false, 'the snare is used up');
  assert.ok(goblin.statuses.some((s: { id: string }) => s.id === 'netted'));
  assert.equal(goblin.hp, goblin.maxHp - 4, '1d6 (a 4 under middle())');
});

test('an NPC ally that steps on a snare does not spring it', () => {
  const { p, heroes, foe } = battle(['ranger', 'fighter']);
  const [ranger] = heroes;
  p.setTraps(ranger, statsAt('snare_trap'), { x: 7, y: 2 });
  assert.ok(p.traps.has(2 * 12 + 7));
  const ally = foe('goblin', 9, 2);
  ally.ally = true;
  ally.x = 7;
  ally.y = 2;
  const hp = ally.hp;
  const stuck = middle(() => p.standIn(ally, 'step'));
  assert.equal(stuck, false);
  assert.equal(p.traps.has(2 * 12 + 7), true, 'the snare is still there');
  assert.equal(ally.statuses.some((s: { id: string }) => s.id === 'netted'), false);
  assert.equal(ally.hp, hp);
});

// ---------------------------------------------------------------- Guardian: Spiked Shield

test('Spiked Shield (tier II): the Block that soaks a melee hit hurts the goblin for the same amount', () => {
  const { p, heroes, foe } = battle(['fighter', 'cleric']);
  const [ann] = heroes;
  ann.subclass = 'guardian';
  ann.skills.push(own('spiked_shield', 2));
  const goblin = foe('goblin', 5, 2);
  ann.block = { [ann.id]: 5 };
  const hp = ann.hp;
  p.damage(ann, 4, goblin);
  assert.equal(blockOf(ann), 1, 'Block soaked 4');
  assert.equal(ann.hp, hp);
  assert.equal(goblin.hp, goblin.maxHp - 4, 'the goblin takes the 4 it soaked');
});

test('Spiked Shield (tier I): the goblin takes half of what the Block soaked', () => {
  const { p, heroes, foe } = battle(['fighter', 'cleric']);
  const [ann] = heroes;
  ann.subclass = 'guardian';
  ann.skills.push(own('spiked_shield', 1));
  const goblin = foe('goblin', 5, 2);
  ann.block = { [ann.id]: 5 };
  p.damage(ann, 4, goblin);
  assert.equal(goblin.hp, goblin.maxHp - 2);
});

test('Spiked Shield does nothing against a goblin three tiles away', () => {
  const { p, heroes, foe } = battle(['fighter', 'cleric']);
  const [ann] = heroes;
  ann.subclass = 'guardian';
  ann.skills.push(own('spiked_shield', 2));
  const far = foe('goblin', 7, 2);
  ann.block = { [ann.id]: 5 };
  p.damage(ann, 4, far);
  assert.equal(blockOf(ann), 1, 'the Block still soaked the hit');
  assert.equal(far.hp, far.maxHp, 'but the goblin is not hurt back');
});

// ---------------------------------------------------------------- Juggernaut: Blood Drinker and Unstoppable

test("Blood Drinker (Juggernaut): a hurt barbarian's melee hit heals a quarter of the damage dealt", () => {
  const { p, heroes, foe } = battle(['barbarian', 'cleric']);
  const [ann] = heroes;
  ann.subclass = 'juggernaut';
  ann.skills.push(own('blood_drinker'));
  ann.hp = Math.floor(ann.maxHp / 2);
  const hurt = ann.hp;
  const goblin = foe('goblin', 5, 2);
  p.damage(goblin, 8, ann);
  assert.equal(ann.hp, hurt + 2, '8 dealt, a quarter of it back');
  const far = foe('goblin', 8, 2);
  const hp = ann.hp;
  p.damage(far, 8, ann);
  assert.equal(ann.hp, hp, 'a hit from 4 tiles away heals nothing');
});

test('Unstoppable (Juggernaut, tier I): Prone lands when not Raging, and Raging shrugs off Prone and Netted', () => {
  const { p, heroes } = battle(['barbarian', 'cleric']);
  const [ann] = heroes;
  ann.subclass = 'juggernaut';
  ann.skills.push(own('unstoppable'));
  p.applyStatus(ann, { id: 'prone', turns: 1 });
  assert.ok(ann.statuses.some((s: { id: string }) => s.id === 'prone'), 'not Raging: Prone lands');
  ann.statuses = [];
  p.applyStatus(ann, { id: 'netted', turns: 1 });
  assert.ok(ann.statuses.some((s: { id: string }) => s.id === 'netted'), 'not Raging: Netted lands');
  ann.statuses = [{ id: 'raging', turns: 3, power: 2 }];
  p.applyStatus(ann, { id: 'prone', turns: 1 });
  p.applyStatus(ann, { id: 'netted', turns: 1 });
  assert.deepEqual(ann.statuses.map((s: { id: string }) => s.id), ['raging'], 'Raging: neither lands');
});

// ---------------------------------------------------------------- Protection: Intercept and Aura of Warding

test('Intercept (Protection paladin): a monster going for the wizard next to the paladin hits the paladin, once per round', () => {
  const { p, heroes, foe } = battle(['paladin', 'wizard']);
  const [paladin, wizard] = heroes;
  paladin.subclass = 'protection';
  paladin.skills.push(own('intercept'));
  Object.assign(wizard, { hp: 30, maxHp: 30 }); // room to take a second hit in the test
  const goblin = foe('goblin', 5, 3);
  const wizHp = wizard.hp;
  const palHp = paladin.hp;
  dice([showing(15), showing(15)], () => p.monsterAttack(goblin, wizard));
  assert.equal(wizard.hp, wizHp, 'the wizard is untouched');
  assert.ok(paladin.hp < palHp, 'the paladin took the hit');
  dice([showing(15), showing(15)], () => p.monsterAttack(goblin, wizard));
  assert.ok(wizard.hp < wizHp, 'the paladin already intercepted this round: the wizard takes this one');
});

test('Aura of Warding (Protection): at the start of the paladin turn, the friend next to them gets 2 Block, one 3 tiles away gets none', () => {
  const { p, heroes } = battle(['paladin', 'fighter', 'cleric']);
  const [paladin, fighter, cleric] = heroes;
  paladin.subclass = 'protection';
  paladin.skills.push(own('aura_of_warding'));
  cleric.y = 5; // three tiles from the paladin
  startTurn(p, paladin);
  assert.equal(blockOf(fighter), 2, 'next to the paladin');
  assert.equal(blockOf(cleric), 0, 'three tiles away');
  assert.equal(blockOf(paladin), 0, 'a tier I aura does not Block the paladin itself');
});

// ---------------------------------------------------------------- Evoker: Sculpt Spells

test('Sculpt Spells (Evoker): a Fireball centred on a friend catches the friend without the passive, and not with it', () => {
  const { g, p, heroes } = battle(['wizard', 'fighter', 'cleric']);
  const [wiz, fighter] = heroes;
  wiz.subclass = 'evoker';
  const ctx = { map: g as any, entities: p.entities, inCombat: true };
  const aim = { x: fighter.x, y: fighter.y };
  const before = resolveAim(statsAt('fireball'), wiz, aim, ctx) as AimResult;
  assert.ok(before.caught?.includes(fighter), 'without Sculpt Spells the friend is caught');
  wiz.skills.push(own('sculpt_spells'));
  const after = resolveAim(statsAt('fireball'), wiz, aim, ctx) as AimResult;
  assert.deepEqual(after.caught, [], 'with Sculpt Spells no friend is caught');
});

// ---------------------------------------------------------------- Trapper: the hero AI

test('the hero AI (Trapper, 1 AP) lays a snare on the way of a melee goblin walking to a friend', () => {
  const { heroes, foe } = battle(['ranger', 'fighter']);
  const [ranger, fighter] = heroes;
  ranger.subclass = 'trapper';
  ranger.skills = [own('snare_trap')];
  Object.assign(fighter, { x: 4, y: 3 });
  const goblin = foe('goblin', 7, 3, 12); // three tiles from the fighter, walking toward them
  const intent = nextHeroIntent(view(ranger, heroes, [goblin], turn(1)));
  assert.ok(intent.kind === 'act' && intent.skill === 'snare_trap', JSON.stringify(intent));
});
