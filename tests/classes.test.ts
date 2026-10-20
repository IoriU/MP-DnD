import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { nextHeroIntent, type HeroIntent, type HeroView } from '../server/heroai.ts';
import { recalcHero, startingSkills } from '../server/progression.ts';
import { rng } from '../server/rng.ts';
import { describeStats, gearAlert, gearBonus, gearResist, statBlocks } from '../shared/items.ts';
import { BREATHER, CLASSES, CLASS_IDS, MAX_CANTRIPS, MAX_SPELLS, MONSTERS, maxHpFor, passiveSlots } from '../shared/rules.ts';
import {
  SKILLS, SKILL_IDS, STATUSES, attackBonus, describeSkill, heroDc, ownedSkill, resolveAim, skillBlockReason, statsAt, statsOf,
  type SkillId, type SkillKind, type StatusId,
} from '../shared/skills.ts';
import { damageFactor, type FieldLike } from '../shared/surfaces.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, PlayerInfo, TurnView } from '../shared/types.ts';

/** The acting creature's share of the turn (movement and AP left); the tests start one creature's turn at a time. */
const mine = (p: any) => p.turn.acts[p.turn.group[0]];

// Phase 12: the Barbarian, Ranger, Paladin and Bard, and the passive perk system. Class data and perks are plain data checks,
// fight effects run through the real Game class (private members reached with `any`, as in tests/abilities.test.ts) with
// controlled dice, and the hero AI is tested on hand-made boards.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-classes-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const NEW_CLASSES: ClassId[] = ['barbarian', 'ranger', 'paladin', 'bard'];
const own = (id: SkillId, tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B'): OwnedSkill => ({ id, tier, branch, cd: 0 });
const pool = (c: ClassId, kind?: SkillKind) => SKILL_IDS.filter((id) => SKILLS[id].pool === c && (!kind || SKILLS[id].kind === kind));
const status = (id: StatusId, turns = 2, power?: number) => ({ id, turns, ...(power ? { power } : {}) });
const has = (e: Entity, id: StatusId) => e.statuses.some((s) => s.id === id);

let seq = 0;
/** A hero at a tile with full HP and slots (recalcHero fills them from level, class and passive perks). */
function hero(classId: ClassId, x = 2, y = 3, extra: Partial<PlayerEntity> = {}): PlayerEntity {
  const p: PlayerEntity = {
    id: `h${++seq}`, kind: 'player', playerId: `p${seq}`, classId, name: classId, glyph: '', color: '#fff', x, y, hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [],
    facing: { x: 1, y: 0 }, level: 1, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null, elitePicks: 0, bonusHp: 0, bonusAc: 0, bonusSlots: 0,
    tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [], kills: 0, steals: 0, slots: 0, maxSlots: 0, downed: false, dead: false,
    saves: { ok: 0, fail: 0 }, used: [], ...extra,
  };
  recalcHero(p);
  return p;
}
/** A hero of the class with these passives on top of the starting skills. */
const perked = (c: ClassId, ...passives: OwnedSkill[]) => hero(c, 2, 3, { skills: [...startingSkills(c), ...passives] });

function monster(type: string, x: number, y: number, extra: Partial<MonsterEntity> = {}): MonsterEntity {
  const d = MONSTERS[type];
  return {
    id: `m${++seq}`, kind: 'monster', type, name: d.name, glyph: '', x, y, hp: d.hp, maxHp: d.hp, ac: d.ac, speed: d.speed,
    statuses: [], facing: { x: -1, y: 0 }, boss: false, elite: false, dmgBy: {}, ...extra,
  };
}

/** Math.random comes up with these values in turn, then 0 (a d20 shows 1). Callouts stay quiet, rng.pick takes the first. */
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
const showing = (n: number, sides = 20) => (n - 0.5) / sides; // the Math.random value that makes a die show n

// ---------------------------------------------------------------- the class data

test('every class: start skills exist, are its own or common, fit the hotbar, and the pool is deep; every class has a role', () => {
  const roles = new Set<string>();
  for (const c of CLASS_IDS) {
    const def = CLASSES[c];
    const kinds = (k: SkillKind) => def.start.filter((id) => SKILLS[id].kind === k).length;
    assert.equal(new Set(def.start).size, def.start.length, `${c}: no skill twice`);
    for (const id of def.start) assert.ok(['common', c].includes(SKILLS[id].pool), `${c}: ${id} is its own or common`);
    assert.ok(kinds('cantrip') <= MAX_CANTRIPS && kinds('spell') <= MAX_SPELLS && kinds('passive') <= passiveSlots(1), `${c} starts within the limits`);
    assert.equal(SKILLS[def.start[0]].kind, 'basic', `${c}: the first hotbar slot is a basic attack`);
    assert.ok(pool(c, 'basic').length >= 1, `${c} has a basic attack`);
    for (const kind of ['cantrip', 'spell', 'passive'] as const) assert.ok(pool(c, kind).length >= 3, `${c} has 3+ ${kind}s`);
    assert.ok(def.roles.length > 0, `${c} brings something to a party`);
    def.roles.forEach((r) => roles.add(r));
  }
  assert.deepEqual([...roles].sort(), ['front', 'healer', 'ranged']);
  assert.deepEqual(NEW_CLASSES.map((c) => CLASSES[c].roles), [['front'], ['ranged'], ['front', 'healer'], ['healer', 'ranged']]);
});

/** What Phase 12 added: every skill of the new classes and the new content of the old ones. */
const ADDED: SkillId[] = [...NEW_CLASSES.flatMap((c) => pool(c)), 'fighting_style', 'trip_attack', 'nimble', 'arcane_focus', 'devout'];

test('every new skill describes at tiers I, II, III-A and III-B, and every upgradable one has both branches', () => {
  const caster = hero('wizard');
  for (const id of ADDED) {
    const def = SKILLS[id];
    const tiers: [1 | 2 | 3, 'A' | 'B' | undefined][] = def.t2 ? [[1, undefined], [2, undefined], [3, 'A'], [3, 'B']] : [[1, undefined]];
    if (def.t2) {
      assert.ok(def.a && def.b, `${id} has both III branches`);
      const [a, b] = [statsAt(id, 3, 'A').name, statsAt(id, 3, 'B').name];
      assert.ok(a !== b && a !== def.base.name && b !== def.base.name, `${id}: the branches have their own names`);
    } else assert.equal(def.kind, 'basic', `${id}: only basic attacks cannot be upgraded`);
    for (const [tier, branch] of tiers) {
      const at = `${id} ${tier}${branch ?? ''}`;
      for (const text of [describeSkill(id, tier, branch), describeSkill(id, tier, branch, caster)]) {
        assert.ok(text.split('\n')[0].length > 5 && !/undefined|NaN|\[object|null/.test(text), `${at}: ${text}`);
      }
      if (def.kind !== 'passive') continue;
      const s = statsAt(id, tier, branch);
      assert.ok(s.note || (s.perk && describeStats(s.perk)), `${at} says what it does (a note or a perk)`);
      if (s.value !== undefined) assert.ok(s.value > 0, `${at} has a number`);
    }
  }
});

test('Reckless Attack costs you a guard (Marked), Calculated Fury (III-B) takes that price away, and Raging is a good status', () => {
  assert.deepEqual(statsAt('reckless_attack').selfStatus?.map((s) => s.id), ['marked']);
  assert.ok(statsAt('reckless_attack').adv && statsAt('reckless_attack', 3, 'B').adv, 'both roll with advantage');
  assert.equal(statsAt('reckless_attack', 3, 'B').selfStatus, undefined);
  assert.ok(/Wide open/.test(describeSkill('reckless_attack')) && !/Wide open/.test(describeSkill('reckless_attack', 3, 'B')));
  assert.ok(STATUSES.raging.good);
});

// ---------------------------------------------------------------- passive perks

test('Thick Hide: tier I is +1 AC and +4 max HP once recalculated, the HP comes along, and forgetting it takes it away', () => {
  const plain = hero('barbarian');
  const tough = perked('barbarian', own('thick_hide'));
  assert.deepEqual([plain.ac, plain.maxHp], [14, maxHpFor('barbarian', 1)]);
  assert.deepEqual([tough.ac, tough.maxHp, tough.hp], [15, plain.maxHp + 4, plain.maxHp + 4]);
  assert.equal(gearBonus(tough, 'ac'), 1);
  tough.skills = tough.skills.filter((s) => s.id !== 'thick_hide');
  recalcHero(tough);
  assert.deepEqual([tough.ac, tough.maxHp, tough.hp], [14, plain.maxHp, plain.maxHp], 'the HP is clamped');
  const [stone, jugger] = [perked('barbarian', own('thick_hide', 3, 'A')), perked('barbarian', own('thick_hide', 3, 'B'))];
  assert.deepEqual([stone.ac, stone.maxHp - plain.maxHp], [16, 8], 'Stoneskin');
  assert.deepEqual([jugger.ac, jugger.maxHp - plain.maxHp], [15, 12], 'Juggernaut');
});

test('perks stack with each other and with gear, and reach speed and slots through recalcHero', () => {
  const r = perked('ranger', own('natural_explorer', 2), own('archery'));
  assert.equal(r.speed, 7, 'Natural Explorer II: +1 movement');
  assert.deepEqual([gearBonus(r, 'init'), gearBonus(r, 'hit'), gearBonus(r, 'stealth')], [3, 1, 3]);
  const tank = hero('barbarian', 2, 3, { skills: [...startingSkills('barbarian'), own('thick_hide')], gear: { armor: 'padded_vest' } });
  assert.equal(tank.ac, 14 + 1 + 1, 'class AC, Thick Hide and the vest');
  const [w, sage] = [hero('wizard'), perked('wizard', own('arcane_focus', 2))];
  assert.deepEqual([sage.maxSlots, sage.slots], [w.maxSlots + 1, w.slots + 1], 'Arcane Focus II: a slot more, and it starts full');
});

test('Juggernaut and Divine Health: poison resistance (immunity with Purity of Body) in gearResist and damageFactor', () => {
  assert.equal(gearResist(perked('barbarian', own('thick_hide')), 'poison'), null);
  const jugger = perked('barbarian', own('thick_hide', 3, 'B'));
  assert.deepEqual([gearResist(jugger, 'poison'), damageFactor(jugger, 'poison'), damageFactor(jugger, 'fire')], ['resist', 0.5, 1]);
  assert.equal(gearResist(perked('paladin', own('divine_health')), 'poison'), 'resist');
  const pure = perked('paladin', own('divine_health', 3, 'A'));
  assert.deepEqual([gearResist(pure, 'poison'), damageFactor(pure, 'poison')], ['immune', 0]);
});

test('Danger Sense III-A (Feral Instinct) and Ambusher make a hero alert, so they cannot be surprised', () => {
  assert.ok(!gearAlert(perked('barbarian', own('danger_sense'))));
  assert.ok(gearAlert(perked('barbarian', own('danger_sense', 3, 'A'))));
  assert.ok(gearAlert(perked('ranger', own('natural_explorer', 3, 'B'))));
  assert.ok(!gearAlert(perked('barbarian', own('danger_sense', 3, 'B'))), 'Evasive is not alert');
  const { p, heroes } = battle(['barbarian', 'fighter']);
  heroes[0].skills.push(own('danger_sense', 3, 'A'));
  heroes.forEach((h) => p.applyStatus(h, status('surprised')));
  assert.ok(!has(heroes[0], 'surprised') && has(heroes[1], 'surprised'));
});

test('Archery adds to attack rolls, Silver Tongue and Arcane Focus to the save DC (and to casting-stat attacks only)', () => {
  const bow = statsAt('longbow');
  const base = attackBonus(hero('ranger'), bow);
  assert.deepEqual([1, 2].map((tier) => attackBonus(perked('ranger', own('archery', tier as 1 | 2)), bow) - base), [1, 2]);
  assert.equal(gearBonus(perked('ranger', own('archery', 3, 'A')), 'dmg'), 2, 'Sharpshooter: basic attacks hit harder too');
  assert.deepEqual([hero('bard'), perked('bard', own('silver_tongue')), perked('bard', own('silver_tongue', 3, 'A'))].map(heroDc), [13, 14, 15]);
  const [plain, wiz] = [hero('wizard'), perked('wizard', own('arcane_focus'))];
  assert.equal(attackBonus(wiz, statsAt('fire_bolt')), attackBonus(plain, statsAt('fire_bolt')) + 1);
  assert.equal(attackBonus(wiz, statsAt('dagger')), attackBonus(plain, statsAt('dagger')), 'a Dexterity weapon is no spell');
  assert.equal(heroDc(wiz), heroDc(plain) + 1);
});

test('a perk-only passive is described by its perk, one with a note by its note, and old saves with unknown skills do not break', () => {
  assert.equal(describeSkill('thick_hide'), `${describeStats({ ac: 1, hp: 4 })}\nPassive · always on`);
  assert.match(describeSkill('thick_hide'), /^\+1 AC, \+4 max HP\./);
  assert.match(describeSkill('devout', 3, 'B'), /^\+1 AC, \+1 to attack rolls, \+2 to every heal\./);
  assert.match(describeSkill('favored_foe', 3, 'A'), /^\+4 damage against Marked targets, and \+1 movement\./, 'the note wins over the perk');
  const old = hero('fighter');
  old.skills.push({ id: 'removed_in_a_later_version' as SkillId, tier: 1, cd: 0 });
  assert.doesNotThrow(() => statBlocks(old));
  assert.deepEqual(statBlocks(perked('fighter', own('fighting_style', 3, 'A'))), [{ hit: 1, ac: 1, dmg: 2 }]);
});

// ---------------------------------------------------------------- fights in the real Game class: Rage, Favored Foe, auras, songs, bots, nets and trips

/** Heroes in a small walled room, in combat. `foe` adds plain monsters (no elite traits) to the turn order. */
function battle(classes: ClassId[] = ['fighter', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'CLASSES');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  Object.assign(g, { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 4, y: 3 + i }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, group: [heroes[0].id], acts: { [heroes[0].id]: { moves: 6, ap: 3 } } };
  p.runMonster = async () => {}; // a monster's turn would be played on real timers: the tests drive the rules themselves
  const foe = (type: string, x: number, y: number, hp?: number): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    Object.assign(m, { traits: undefined, ward: 0, atkBonus: 0, dmgBonus: 0 });
    if (hp) m.hp = m.maxHp = hp;
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

/** It is the hero's turn with 3 AP, the skill ready: they use it on a target with these dice (d20, d20,
 * then the damage dice). Returns the HP the target lost. */
function use(p: any, h: PlayerEntity, skill: SkillId, target: Entity | undefined, rolls: number[] = []): number {
  p.turn.index = p.turn.order.indexOf(h.id);
  p.turn.group = [h.id];
  p.turn.acts[h.id] = { moves: p.turn.acts[h.id]?.moves ?? 6, ap: 3 };
  h.skills.forEach((s) => s.id === skill && (s.cd = 0));
  const hp = target?.hp ?? 0;
  const said: string[] = [];
  p.whisper = (_: string, text: string) => said.push(text);
  assert.equal(dice(rolls, () => p.handleSkill(h.playerId, skill, target?.id)), true, `${skill} was refused: ${said}`);
  return hp - (target?.hp ?? 0);
}

/** HP a hero loses to this much damage. */
function lost(p: any, h: PlayerEntity, amount: number, element: 'physical' | 'fire' | 'poison' = 'physical') {
  h.hp = h.maxHp;
  p.damage(h, amount, undefined, element);
  return h.maxHp - h.hp;
}

const HIT = [showing(15), showing(15)]; // two d20s of 15: a hit on anything but a very armored target, never a crit

test('Rage: a Raging hero (power 2, 3 with tier II) adds the power to melee hits only', () => {
  const { p, heroes, foe } = battle(['barbarian', 'cleric']);
  const [ann] = heroes;
  assert.equal(use(p, ann, 'rage', undefined), 0);
  assert.equal(ann.statuses.find((s) => s.id === 'raging')?.power, 2);
  assert.equal(mine(p).ap, 2, 'Rage costs 1 AP');
  ann.statuses = [];
  ann.skills.find((s) => s.id === 'rage')!.tier = 2;
  use(p, ann, 'rage', undefined);
  assert.equal(ann.statuses.find((s) => s.id === 'raging')?.power, 3, 'tier II');
  const ogre = foe('ogre', 5, 3, 200);
  assert.equal(use(p, ann, 'greataxe', ogre, [...HIT, showing(4, 12)]), 4 + 3 + 3, '1d12 + STR + the 3 from Rage');
  ann.statuses = [];
  assert.equal(use(p, ann, 'greataxe', ogre, [...HIT, showing(4, 12)]), 4 + 3, 'without Rage');

  // A raging archer: the sword gets the bonus, the arrows do not.
  const r = battle(['ranger', 'cleric']);
  const target = r.foe('ogre', 5, 3, 200);
  r.p.applyStatus(r.heroes[0], status('raging', 3, 2), r.heroes[0]);
  assert.equal(use(r.p, r.heroes[0], 'shortsword', target, [...HIT, showing(3, 6)]), 3 + 3 + 2, 'adjacent: 1d6 + DEX + Rage');
  Object.assign(target, { x: 9, y: 3 });
  assert.equal(use(r.p, r.heroes[0], 'longbow', target, [...HIT, showing(3, 8)]), 3 + 3, 'at range: no Rage');
});

test('Rage: physical damage to a Raging hero is halved (at least 1), fire is not', () => {
  const { p, heroes } = battle(['barbarian', 'cleric']);
  const [ann, bob] = heroes;
  heroes.forEach((h) => Object.assign(h, { maxHp: 100 }));
  assert.deepEqual([lost(p, ann, 10), lost(p, ann, 10, 'fire')], [10, 10], 'not raging yet');
  ann.statuses.push(status('raging', 3, 2));
  assert.deepEqual([lost(p, ann, 10), lost(p, ann, 7), lost(p, ann, 1)], [5, 3, 1]);
  assert.deepEqual([lost(p, ann, 10, 'fire'), lost(p, ann, 10, 'poison')], [10, 10], 'only blows are halved');
  assert.equal(lost(p, bob, 10), 10, 'and only for the one raging');
  assert.equal(damageFactor(ann, 'physical'), 0.5);
});

test('Favored Foe adds its value (2, then 4) against Marked targets only, and only for the Ranger who has it', () => {
  const { p, heroes, foe } = battle(['ranger', 'cleric']);
  const [ann, bob] = heroes;
  ann.skills.push(own('favored_foe'));
  const ogre = foe('ogre', 6, 3, 200);
  assert.equal(p.bonusDamage(ann, ogre, 'physical'), 0, 'an unmarked target');
  assert.equal(use(p, ann, 'hunters_mark', ogre), 0);
  assert.ok(has(ogre, 'marked'), "Hunter's Mark: no roll, it always works");
  assert.deepEqual([p.bonusDamage(ann, ogre, 'physical'), p.bonusDamage(ann, ogre, 'fire'), p.bonusDamage(bob, ogre, 'physical')], [2, 2, 0]);
  assert.equal(use(p, ann, 'longbow', ogre, [...HIT, showing(3, 8)]), 3 + 3 + 2, '1d8 + DEX + Favored Foe');
  ann.skills.find((s) => s.id === 'favored_foe')!.tier = 2;
  assert.equal(p.bonusDamage(ann, ogre, 'physical'), 4);
  ogre.statuses = [];
  assert.equal(p.bonusDamage(ann, ogre, 'physical'), 0);
});

test('Aura of Protection: +value to saves for allies within 2 tiles (the Paladin too), not 3 away, 4 with Wide Aura, nothing if down', () => {
  const { p, heroes } = battle(['paladin', 'fighter', 'cleric']);
  const [pal, near, far] = heroes;
  const at = (h: PlayerEntity, x: number) => Object.assign(h, { x, y: 3 });
  const aura = () => heroes.map((h) => p.auraBonus(h));
  const save = (h: PlayerEntity, stat: 'dex' | 'wis') => dice([showing(10)], () => p.heroSave(h, stat)).total - 10;
  [pal, near, far].forEach((h, i) => at(h, [3, 5, 6][i]));
  assert.deepEqual(aura(), [0, 0, 0], 'no Paladin passive, no aura');
  const auraSkill = own('aura_of_protection');
  pal.skills.push(auraSkill);
  assert.deepEqual(aura(), [1, 1, 0], 'the Paladin, 2 tiles away, 3 tiles away');
  assert.equal(save(near, 'dex'), CLASSES.fighter.mods.dex + 1, 'it is in the saving throw');
  assert.equal(save(far, 'wis'), CLASSES.cleric.mods.wis, 'nothing for the one out of reach');
  Object.assign(auraSkill, { tier: 3, branch: 'A' });
  assert.deepEqual(aura(), [3, 3, 0], 'Aura of Devotion: 3');
  Object.assign(auraSkill, { tier: 3, branch: 'B' });
  assert.deepEqual(aura(), [2, 2, 2], 'Wide Aura: +2 out to 4 tiles');
  at(far, 8);
  assert.equal(p.auraBonus(far), 0, '5 tiles is too far');
  at(far, 7);
  pal.downed = true;
  assert.deepEqual(aura(), [0, 0, 0], 'a downed Paladin gives nothing');
  Object.assign(pal, { downed: false, dead: true });
  assert.deepEqual(aura(), [0, 0, 0], 'nor a dead one');
});

/** A fight where every hero has 44 max HP and 1 HP and no slots, with these Song of Rest tiers (one per hero); after endCombat. */
function afterFight(classes: ClassId[], songs: [1 | 2 | 3, ('A' | 'B')?][], maxHp = 44) {
  const { p, heroes } = battle(classes);
  heroes.forEach((h, i) => {
    if (songs[i]) h.skills.push(own('song_of_rest', songs[i][0], songs[i][1]));
    Object.assign(h, { maxHp, hp: 1, slots: 0 });
  });
  p.endCombat();
  return { p, heroes, hp: heroes.map((h) => h.hp), slots: heroes.map((h) => h.slots) };
}

/** HP after the fight from 1 HP: the breather (BREATHER.heal) plus a song's share, of 44 max HP. */
const healedTo = (song: number, maxHp = 44) => 1 + Math.ceil(maxHp * (BREATHER.heal + song) - 1e-9);

test('Song of Rest: the post-fight heal grows by 5, 10 or 15 percent of max HP, for the whole party, best song only', () => {
  assert.deepEqual(afterFight(['fighter', 'cleric'], []).hp, [healedTo(0), healedTo(0)], 'the usual breather');
  assert.deepEqual(afterFight(['bard', 'fighter'], [[1]]).hp, [healedTo(0.05), healedTo(0.05)], '+5%');
  assert.deepEqual(afterFight(['bard', 'fighter'], [[2]]).hp, [healedTo(0.1), healedTo(0.1)], '+10%');
  assert.deepEqual(afterFight(['bard', 'fighter'], [[3, 'A']]).hp, [healedTo(0.15), healedTo(0.15)], '+15%');
  const two = afterFight(['bard', 'bard'], [[1], [2]]);
  assert.deepEqual(two.hp, [healedTo(0.1), healedTo(0.1)], 'two bards: they do not add up');
  const pct = Math.round((BREATHER.heal + 0.1) * 100);
  assert.ok(two.p.log.some((l: { text: string }) => l.text.includes(`heals ${pct}% of their max HP`)));
});

test('Encore (Song of Rest III-B) gives the Bard a slot back after the fight (up to the maximum), the plain song does not', () => {
  const encore = afterFight(['bard', 'fighter'], [[3, 'B']]);
  assert.deepEqual([encore.slots, encore.hp], [[1, 0], [healedTo(0.1), healedTo(0.1)]], 'only the Bard, one slot, and the song still heals 10%');
  assert.deepEqual(afterFight(['bard', 'fighter'], [[2]]).slots, [0, 0]);
  const full = battle(['bard', 'fighter']);
  full.heroes[0].skills.push(own('song_of_rest', 3, 'B'));
  full.p.endCombat();
  assert.equal(full.heroes[0].slots, full.heroes[0].maxSlots, 'full stays full');
});

// A float away from passing: 0.2 + 0.1 is 0.30000000000000004, and ceil(40 * that) is 13 (not 12).
test('Song of Rest at 10% heals exactly 10% more, whatever the max HP', () => {
  for (const heal of [0.2, BREATHER.heal]) {
    const was = BREATHER.heal;
    BREATHER.heal = heal;
    try {
      assert.equal(afterFight(['bard', 'fighter'], [[2]], 40).hp[0], 1 + Math.round(40 * (heal + 0.1)), `breather ${heal}`);
    } finally {
      BREATHER.heal = was;
    }
  }
});

function lobby(host: ClassId) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'ROLES');
  games.push(g);
  const ann = g.join(undefined, 'Ann', host);
  assert.ok(ann.ok);
  const players = (): PlayerInfo[] => (g as any).players;
  return {
    g, p: g as any, host: ann.playerId, classes: () => players().map((x) => x.classId),
    reset: () => players().filter((x) => x.bot).forEach((b) => g.removeBot(ann.playerId, b.id)),
  };
}

test("a solo Fighter's two bots cover the healer and the ranged role, and never repeat a class", () => {
  const { p, classes, reset } = lobby('fighter');
  const pairs = new Set<string>();
  for (let i = 0; i < 150; i++) {
    p.fillParty();
    const party = classes();
    assert.equal(new Set(party).size, 3, `three different classes: ${party}`);
    const roles = new Set(party.flatMap((c) => CLASSES[c].roles));
    assert.ok(roles.has('healer') && roles.has('ranged'), `${party} covers a healer and a ranged hero`);
    pairs.add(party.slice(1).sort().join());
    reset();
  }
  assert.ok(pairs.size > 3, `the picks vary (${pairs.size} different pairs)`);
});

test('addBot takes a class that fills a gap, and once every role is covered any class not in the party yet', () => {
  const fighter = lobby('fighter');
  dice([], () => fighter.p.fillParty()); // (the dice always pick the first)
  assert.deepEqual(fighter.classes(), ['fighter', 'rogue', 'cleric'], 'ranged first, then the healer');
  dice([], () => fighter.g.addBot(fighter.host));
  assert.equal(fighter.classes()[3], 'wizard', 'nothing is missing');
  const bard = lobby('bard'); // a healer and a ranged hero: the party lacks a front line
  dice([], () => bard.g.addBot(bard.host));
  assert.deepEqual(bard.classes(), ['bard', 'fighter']);
  const barb = lobby('barbarian'); // a front line, but no healer
  dice([], () => barb.p.fillParty());
  assert.deepEqual(barb.classes(), ['barbarian', 'rogue', 'cleric']);
});

test("the host picks a bot's class in the tavern; nobody else can, and a saved run's bots keep theirs", () => {
  const { g, p, host, classes } = lobby('fighter');
  g.addBot(host);
  const bot = p.players[1] as PlayerInfo;
  g.setBotClass(host, bot.id, 'bard');
  assert.equal(bot.classId, 'bard');
  const bob = g.join(undefined, 'Bob', 'rogue');
  assert.ok(bob.ok);
  g.setBotClass(bob.playerId, bot.id, 'wizard');
  assert.equal(bot.classId, 'bard', 'only the host');
  g.setBotClass(host, host, 'wizard');
  assert.equal(classes()[0], 'fighter', 'a person picks their own class');
  g.setBotClass(host, bot.id, 'necromancer');
  assert.equal(bot.classId, 'bard', 'not a class');
  assert.equal(p.makePlayer(bot, 1).classId, 'bard', 'its hero is built from it');
  p.phase = 'map';
  g.setBotClass(host, bot.id, 'cleric');
  assert.equal(bot.classId, 'bard', 'not once the run has started');
  p.savedHero = (id: string) => id === bot.id;
  p.phase = 'lobby';
  g.setBotClass(host, bot.id, 'cleric');
  assert.equal(bot.classId, 'bard', "a saved run's bot keeps its hero");
});

test('a monster hit by Ensnaring Shot cannot move on its turn, and a miss leaves it free', () => {
  const { p, heroes, foe } = battle(['ranger', 'cleric']);
  const [ann] = heroes;
  ann.skills.push(own('ensnaring_shot'));
  const ogre = foe('ogre', 8, 3, 200);
  assert.equal(use(p, ann, 'ensnaring_shot', ogre, [showing(1), showing(1)]), 0, 'a natural 1');
  startTurn(p, ogre);
  assert.equal(mine(p).moves, ogre.speed, 'free to walk');
  assert.ok(use(p, ann, 'ensnaring_shot', ogre, [...HIT, showing(3, 8)]) > 0);
  assert.ok(has(ogre, 'netted'));
  startTurn(p, ogre);
  assert.equal(mine(p).moves, 0, 'netted: no movement');
  assert.equal((mine(p).held ?? 0), ogre.speed, 'the movement is held back, not lost (Cut Free gives it back)');
  assert.equal(p.tryMove(ogre, { x: ogre.x + 1, y: ogre.y }), false);
});

test('Trip Attack knocks a monster Prone, and it spends half its movement getting up on its turn', () => {
  const { p, heroes, foe } = battle(['fighter', 'cleric']);
  const [ann] = heroes;
  ann.skills.push(own('trip_attack'));
  const ogre = foe('ogre', 5, 3, 200);
  use(p, ann, 'trip_attack', ogre, [...HIT, showing(4, 8)]);
  assert.ok(has(ogre, 'prone'));
  startTurn(p, ogre);
  assert.ok(!has(ogre, 'prone'));
  assert.equal(mine(p).moves, Math.floor(ogre.speed / 2));
  assert.ok(p.log.some((l: { text: string }) => /gets back up/.test(l.text)));
  use(p, ann, 'trip_attack', ogre, [showing(1), showing(1)]);
  assert.ok(!has(ogre, 'prone'), 'a miss trips nobody');
});

// ---------------------------------------------------------------- the hero AI

const map = ((): FieldLike => {
  const tiles = Array.from({ length: 12 * 8 }, (_, i) => (i % 12 === 0 || i < 12 || i % 12 === 11 || i >= 84 ? '#' : '.')).join('');
  return { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} };
})();
const freshTurn = (): TurnView => ({ order: [], init: {}, index: 0, round: 1, group: [], acts: {}, movesLeft: 6, ap: 3 });
/** The turn after the hero's action is spent (so only the bonus action is left). */
const acted = (): TurnView => ({ ...freshTurn(), ap: 1 });

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[], turn = freshTurn()): HeroView {
  const all = [...heroes, ...monsters];
  return { map, hero: h, heroes, monsters, turn, occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)) };
}

/** Null if the game would accept this act (the same checks as a human click), else why not. */
function whyNot(v: HeroView, intent: HeroIntent): string | null {
  if (intent.kind !== 'act') return `not an act: ${JSON.stringify(intent)}`;
  const blocked = skillBlockReason(v.hero, intent.skill, true, v.turn, true);
  if (blocked) return blocked;
  const res = resolveAim(statsOf(ownedSkill(v.hero, intent.skill)!), v.hero, intent.target, { map: v.map, entities: [...v.heroes, ...v.monsters], inCombat: true });
  return typeof res === 'string' ? res : null;
}

/** Swaps the hero's cantrips and spells (basic attacks are kept). */
function learns(h: PlayerEntity, ...ids: SkillId[]) {
  h.skills = [...h.skills.filter((s) => SKILLS[s.id].kind === 'basic'), ...ids.map((id) => own(id))];
  return h;
}

test('a Barbarian that has already swung still rages (a bonus action), but not while it is already Raging', () => {
  const b = learns(hero('barbarian', 3, 3), 'rage');
  const g = monster('goblin', 4, 3, { hp: 30, maxHp: 30 });
  const v = view(b, [b], [g], acted());
  const rage = nextHeroIntent(v);
  assert.deepEqual(rage, { kind: 'act', skill: 'rage' });
  assert.equal(whyNot(v, rage), null);
  b.statuses.push(status('raging', 3, 2));
  b.skills.find((s) => s.id === 'rage')!.cd = 5;
  const after = nextHeroIntent(view(b, [b], [g], acted()));
  assert.ok(after.kind !== 'act' || after.skill !== 'rage', 'no Rage on top of Rage (Brace is fine)');
  const again = learns(hero('barbarian', 3, 3, { statuses: [status('raging', 3, 2)] }), 'rage');
  assert.deepEqual(nextHeroIntent(view(again, [again], [g])), { kind: 'act', skill: 'greataxe', target: g.id }, 'no second Rage while it lasts');
});

// Rage is played early (heroai scorePlan), so the swing that follows gets its +2.
test('a Barbarian next to monsters rages before it swings', () => {
  const b = learns(hero('barbarian', 3, 3), 'rage');
  const g = monster('goblin', 4, 3, { hp: 30, maxHp: 30 });
  assert.deepEqual(nextHeroIntent(view(b, [b], [g])), { kind: 'act', skill: 'rage' });
});

test("a Ranger with Hunter's Mark marks its target (the whole party gets advantage), and not one that is already Marked", () => {
  const r = learns(hero('ranger', 2, 3), 'hunters_mark');
  const g = monster('goblin', 7, 3, { hp: 30, maxHp: 30 });
  assert.deepEqual(nextHeroIntent(view(r, [r], [g])), { kind: 'act', skill: 'longbow', target: g.id }, 'the shot first');
  const v = view(r, [r], [g], acted());
  const mark = nextHeroIntent(v);
  assert.deepEqual(mark, { kind: 'act', skill: 'hunters_mark', target: g.id });
  assert.equal(whyNot(v, mark), null);
  g.statuses.push(status('marked', 2));
  const after = nextHeroIntent(view(r, [r], [g], acted()));
  assert.ok(after.kind !== 'act' || after.skill !== 'hunters_mark', 'no second mark');
  assert.equal(nextHeroIntent(view(r, [r], [g])).kind, 'act', 'and the shot is still on');
});

test('a Bard with Bardic Inspiration inspires an ally next to the enemy (its own attack covered), not one already Focused', () => {
  const bard = learns(hero('bard', 2, 3, { statuses: [status('focused', 2)] }), 'inspiration');
  const fighter = hero('fighter', 4, 3);
  const g = monster('goblin', 5, 3, { hp: 30, maxHp: 30 });
  const v = view(bard, [bard, fighter], [g], acted());
  const intent = nextHeroIntent(v);
  assert.deepEqual(intent, { kind: 'act', skill: 'inspiration', target: fighter.id });
  assert.equal(whyNot(v, intent), null);
  fighter.statuses.push(status('focused', 2));
  assert.equal(nextHeroIntent(view(bard, [bard, fighter], [g], acted())).kind, 'end', 'nobody left to inspire');
});
