import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { applyPick, dealOffer, makeEliteOffer, recalcHero, startingSkills, validCard } from '../server/progression.ts';
import { makeRng } from '../server/rng.ts';
import { ITEMS, gearBonus, gearResist, statBlocks, type ItemId } from '../shared/items.ts';
import { ALLY_FIGHTS, MAX_ALLIES, TRAITS, auraOf, hasTrait, isAllyNpc, isFoe, sameSide, traitCount, traitResist, type TraitId } from '../shared/elites.ts';
import { dist } from '../shared/grid.ts';
import { LEVEL_CAP, MONSTERS } from '../shared/rules.ts';
import { resolveAim, statsAt, type AimCtx, type SkillId } from '../shared/skills.ts';
import { damageFactor, immuneToStatus, resistance } from '../shared/surfaces.ts';
import { isFlanking, turnsToFace } from '../shared/tactics.ts';
import type { AllyState, ClassId, MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Phase 7: elite traits, blessings, NPC allies and elite spoils. The rules are tested on their own, and the fights and
// rewards through the real Game class. Private members are reached with `any`, as in tests/items.test.ts. Checkpoints
// write saves, so they go to a temp folder.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-elites-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** Every die rolls its maximum (a d6 shows 6). */
const HIGH = 0.99;
function withRandom<T>(roll: number, fn: () => T): T {
  const real = Math.random;
  Math.random = () => roll;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

let seq = 0;

/** A monster built from its stat block, with only the fields the rules read. */
function mon(type: string, x = 0, y = 0, extra: Partial<MonsterEntity> = {}): MonsterEntity {
  const def = MONSTERS[type];
  return {
    id: `m${++seq}`, kind: 'monster', type, name: def.name, glyph: def.glyph, x, y, hp: def.hp, maxHp: def.hp, ac: def.ac,
    speed: def.speed, statuses: [], facing: { x: 1, y: 0 }, boss: false, elite: false, dmgBy: {}, ...extra,
  };
}

/** A hero standing on a tile, for geometry and aiming. */
function heroAt(x: number, y: number): PlayerEntity {
  return { id: `h${++seq}`, kind: 'player', x, y, statuses: [], facing: { x: 1, y: 0 }, downed: false, dead: false } as unknown as PlayerEntity;
}

/** A hero of a class at a level, the way the progression code builds one. */
function hero(classId: ClassId, level = 1): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}-${level}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x: 0, y: 0,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level, xp: 0, skills: startingSkills(classId), levelUps: 0,
    elitePicks: 0, offer: null, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [],
    kills: 0, steals: 0, slots: 0, maxSlots: 0, downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [],
  };
  recalcHero(p);
  return p;
}

const NAMES = ['Ann', 'Bob', 'Cid'];
const full = (): ItemId[] => Array.from({ length: 8 }, (): ItemId => 'padded_vest');
const brann = (fights = ALLY_FIGHTS): AllyState => ({ id: 'sellsword', name: 'Brann the Sellsword', fights });

/** A party on the map in act 1, nothing fighting yet. */
function camp(classes: ClassId[] = ['fighter', 'wizard']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'ELITE');
  games.push(g);
  const p = g as any;
  const pids = classes.map((c, i) => {
    const r = g.join(undefined, NAMES[i], c);
    assert.ok(r.ok);
    return r.playerId;
  });
  const heroes = pids.map((id) => p.makePlayer(p.players.find((x: PlayerInfo) => x.id === id), 1) as PlayerEntity);
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'map';
  return { g, p, heroes };
}

/** The party in a small walled room, in combat, heroes at 40 HP. `foe` and `npc` add monsters and NPC allies to the turn order. */
function battle(classes: ClassId[] = ['fighter', 'wizard']) {
  const c = camp(classes);
  const { g, p, heroes } = c;
  g.width = 12;
  g.height = 8;
  g.tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  g.ground = {};
  g.clouds = {};
  g.props = {};
  heroes.forEach((h, i) => {
    h.x = 2;
    h.y = 3 + i;
    h.hp = h.maxHp = 40;
  });
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, group: [heroes[0].id], acts: { [heroes[0].id]: { moves: 6, ap: 3 } } };
  const foe = (type: string, x: number, y: number, hp?: number): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    if (hp !== undefined) m.hp = m.maxHp = hp;
    p.turn.order.push(m.id);
    return m;
  };
  const npc = (state: AllyState, x: number, y: number): MonsterEntity => {
    const a = p.spawnAlly(state, { x, y }) as MonsterEntity;
    p.turn.order.push(a.id);
    return a;
  };
  return { ...c, foe, npc };
}

/** Rolls an elite of this type (its traits are random), then takes it back out of the fight. */
function rollElite(p: any, type: string): MonsterEntity {
  p.spawnMonster(type, { x: 9, y: 6 }, 1);
  return p.entities.pop() as MonsterEntity;
}

/** An elite hobgoblin with this trait, placed in the fight. Traits are random, so it rolls until one comes up. */
function placeElite(p: any, trait: TraitId, x: number, y: number): MonsterEntity {
  for (let i = 0; i < 500; i++) {
    p.spawnMonster('hobgoblin', { x, y }, 1);
    const m = p.entities.at(-1) as MonsterEntity;
    if (m.traits?.includes(trait)) return m;
    p.entities.pop();
  }
  assert.fail(`no ${trait} elite in 500 rolls`);
}

const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));

// ---------------------------------------------------------------- sides and traits

test('monsters that are not allies are the foes, and heroes and NPC allies share a side', () => {
  const h = heroAt(2, 2);
  const foe = mon('goblin', 5, 5);
  const ally = mon('sellsword', 4, 4, { ally: true });
  assert.equal(isFoe(h), false);
  assert.equal(isFoe(foe), true);
  assert.equal(isFoe(ally), false, 'an NPC ally is not an enemy');
  assert.equal(isAllyNpc(h), false);
  assert.equal(isAllyNpc(foe), false);
  assert.equal(isAllyNpc(ally), true);
  assert.equal(isFoe(undefined), false);
  assert.equal(sameSide(h, ally), true);
  assert.equal(sameSide(ally, foe), false);
  assert.equal(sameSide(foe, mon('kobold')), true, 'monsters fight together');
});

// ---------------------------------------------------------------- traits and auras (pure)

test('traitCount: one trait in act 1, one or two in acts 2 and 3 (by the roll)', () => {
  assert.equal(traitCount(1, 0), 1);
  assert.equal(traitCount(1, 0.99), 1);
  assert.equal(traitCount(2, 0.2), 1);
  assert.equal(traitCount(2, 0.5), 2);
  assert.equal(traitCount(2, 0.9), 2);
  assert.equal(traitCount(3, 0), 1);
  assert.equal(traitCount(3, 0.99), 2);
});

test('an aura is the element of a Burning, Frost or Storm elite, and makes it immune to that element only', () => {
  assert.equal(auraOf(mon('hobgoblin', 0, 0, { traits: ['burning', 'swift'] })), 'fire');
  assert.equal(auraOf(mon('hobgoblin', 0, 0, { traits: ['frost'] })), 'cold');
  assert.equal(auraOf(mon('hobgoblin', 0, 0, { traits: ['storm'] })), 'lightning');
  assert.equal(auraOf(mon('hobgoblin', 0, 0, { traits: ['shielded', 'enraged'] })), undefined);
  assert.equal(auraOf(mon('hobgoblin')), undefined);
  assert.equal(auraOf(heroAt(0, 0)), undefined);
  const burning = mon('hobgoblin', 0, 0, { traits: ['burning'] });
  assert.equal(traitResist(burning, 'fire'), 'immune');
  assert.equal(traitResist(burning, 'cold'), null);
  assert.equal(traitResist(heroAt(0, 0), 'fire'), null);
  assert.ok(hasTrait(mon('hobgoblin', 0, 0, { traits: ['vampiric'] }), 'vampiric'));
  assert.ok(!hasTrait(heroAt(0, 0), 'vampiric'));
});

// ---------------------------------------------------------------- resistances and immunities

test('a Burning elite is immune to fire and cannot be set alight, even a zombie (which is weak to fire)', () => {
  const z = mon('zombie', 0, 0, { traits: ['burning'] });
  assert.equal(resistance(z, 'fire'), 'immune');
  assert.equal(damageFactor(z, 'fire'), 0);
  assert.ok(immuneToStatus(z, 'burning'));
  assert.equal(resistance(z, 'poison'), 'immune', 'its stat block still applies');
});

test('a Frost elite cannot be chilled or frozen, and a Storm elite cannot be shocked', () => {
  const frost = mon('goblin', 0, 0, { traits: ['frost'] });
  assert.equal(damageFactor(frost, 'cold'), 0);
  assert.ok(immuneToStatus(frost, 'chilled'));
  assert.ok(immuneToStatus(frost, 'frozen'));
  assert.ok(!immuneToStatus(frost, 'shocked'), 'the Frost aura says nothing about lightning');
  const storm = mon('goblin', 0, 0, { traits: ['storm'] });
  assert.equal(damageFactor(storm, 'lightning'), 0);
  assert.ok(immuneToStatus(storm, 'shocked'));
  assert.ok(!immuneToStatus(storm, 'chilled'));
});

test('a plain monster keeps its stat-block resistances', () => {
  assert.equal(resistance(mon('skeleton'), 'poison'), 'immune');
  assert.equal(damageFactor(mon('zombie'), 'fire'), 2, 'zombies are weak to fire');
  assert.equal(damageFactor(mon('spider'), 'poison'), 0.5, 'spiders resist poison');
  assert.ok(immuneToStatus(mon('skeleton'), 'poisoned'));
  assert.equal(resistance(mon('goblin'), 'fire'), null);
});

// ---------------------------------------------------------------- blessings and gear

test('each blessing adds its numbers to the bonuses it touches', () => {
  assert.equal(gearBonus({ blessings: ['valor'] }, 'hit'), 1);
  assert.equal(gearBonus({ blessings: ['valor'] }, 'dmg'), 1);
  assert.equal(gearBonus({ blessings: ['bulwark'] }, 'ac'), 1);
  assert.equal(gearBonus({ blessings: ['vigor'] }, 'hp'), 8);
  assert.equal(gearBonus({ blessings: ['arcana'] }, 'slots'), 1);
  assert.equal(gearBonus({ blessings: ['arcana'] }, 'power'), 1);
  assert.equal(gearBonus({ blessings: ['haste'] }, 'speed'), 1);
  assert.equal(gearBonus({ blessings: ['haste'] }, 'init'), 3);
  assert.equal(gearBonus({ blessings: ['fortune'] }, 'saves'), 2);
  assert.equal(gearBonus({ blessings: ['fortune'] }, 'lucky'), 1);
  assert.equal(gearBonus({ blessings: ['valor'] }, 'hp'), 0, 'and nothing else');
});

test('Warding resists fire, cold and lightning; Renewal is a hook with no numbers', () => {
  assert.equal(gearResist({ blessings: ['warding'] }, 'fire'), 'resist');
  assert.equal(gearResist({ blessings: ['warding'] }, 'cold'), 'resist');
  assert.equal(gearResist({ blessings: ['warding'] }, 'lightning'), 'resist');
  assert.equal(gearResist({ blessings: ['warding'] }, 'poison'), null);
  assert.deepEqual(statBlocks({ blessings: ['renewal'] }), []);
  assert.equal(gearResist({ gear: { armor: 'dragonscale' }, blessings: ['warding'] }, 'fire'), 'resist', 'two sources of resist are still one resist');
});

test('equipment, relics and blessings add up on the same hero', () => {
  const kit: Partial<PlayerEntity> = { gear: { weapon: 'fine_blade', armor: 'chain_shirt' }, relics: ['war_banner', 'crown_of_command'], blessings: ['bulwark', 'valor'] };
  assert.equal(gearBonus(kit, 'ac'), 2 + 1 + 1, 'chain shirt, war banner, bulwark');
  assert.equal(gearBonus(kit, 'hit'), 1 + 1 + 1, 'fine blade, crown of command, valor');
  assert.equal(gearBonus(kit, 'dmg'), 1 + 1, 'fine blade, valor');
  assert.equal(gearBonus(kit, 'saves'), 1, 'crown of command');
});

// ---------------------------------------------------------------- facing and flanking with NPC allies

test('a hero and an NPC ally on either side of a monster flank it, but an ally on the hero side does not flank for the monsters', () => {
  const ogre = mon('ogre', 5, 5);
  const h = heroAt(6, 5);
  const ally = mon('sellsword', 4, 5, { ally: true });
  assert.ok(isFlanking(h, ogre, [h, ogre, ally]), 'the hero and the ally are on either side of the ogre');

  const goblin = mon('goblin', 5, 5);
  const target = heroAt(6, 5);
  const heroSideAlly = mon('sellsword', 7, 5, { ally: true });
  assert.ok(!isFlanking(goblin, target, [goblin, target, heroSideAlly]), 'the ally is on the hero side, not the goblin side');
  assert.ok(isFlanking(goblin, target, [goblin, target, mon('goblin', 7, 5)]), 'a goblin on the far side does flank');
});

test('a hero stepping up to an NPC ally does not make it turn, but an enemy turns to face the party', () => {
  const ally = mon('sellsword', 5, 5, { ally: true, facing: { x: -1, y: 0 } });
  const h = heroAt(3, 5);
  assert.equal(turnsToFace(ally, h, { x: 4, y: 5 }), false, 'friends do not turn');
  const goblin = mon('goblin', 5, 5, { facing: { x: -1, y: 0 } });
  assert.equal(turnsToFace(goblin, h, { x: 4, y: 5 }), true, 'an enemy stepping next to it does turn');
  assert.equal(turnsToFace(goblin, ally, { x: 4, y: 5 }), true, 'an NPC ally stepping next to a monster does turn');
});

// ---------------------------------------------------------------- who a skill can hit

const open = { width: 12, height: 8, tiles: '.'.repeat(96), props: {} };

test('aiming an enemy skill at an NPC ally says it is on your side', () => {
  const caster = heroAt(2, 3);
  const ally = mon('sellsword', 4, 3, { ally: true, name: 'Brann the Sellsword' });
  const ctx: AimCtx = { map: open, entities: [caster, ally], inCombat: true };
  assert.equal(resolveAim(statsAt('fire_bolt', 1), caster, ally.id, ctx), 'Brann the Sellsword is on your side.');
});

test('a fireball that lands next to an NPC ally catches the ally, and the ally is not one of the foes', () => {
  const caster = heroAt(2, 3);
  const ally = mon('sellsword', 7, 3, { ally: true });
  const foe = mon('goblin', 8, 3);
  const ctx: AimCtx = { map: open, entities: [caster, ally, foe], inCombat: true };
  const res = resolveAim(statsAt('fireball', 1), caster, { x: 8, y: 3 }, ctx);
  if (typeof res === 'string') assert.fail(res);
  assert.deepEqual(res.caught?.map((e) => e.id), [ally.id]);
  assert.deepEqual(res.foes.map((e) => e.id), [foe.id]);
});

test('a whirlwind hits the monsters around its user, and never an NPC ally next to them', () => {
  const caster = heroAt(4, 3);
  const ally = mon('sellsword', 5, 3, { ally: true });
  const foe = mon('goblin', 3, 4);
  const ctx: AimCtx = { map: open, entities: [caster, ally, foe], inCombat: true };
  const res = resolveAim(statsAt('whirlwind', 1), caster, undefined, ctx);
  if (typeof res === 'string') assert.fail(res);
  assert.deepEqual(res.foes.map((e) => e.id), [foe.id]);
  assert.equal(res.caught, undefined, 'an around skill catches nobody else');
});

// ---------------------------------------------------------------- elite spoils and the bag

test('an elite offer has three cards: an upgrade or a learn, one act gear piece the hero is not wearing, and a boon', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const h = hero('fighter', 2);
    h.gear.weapon = 'venom_edge'; // worn: it must not be offered again
    recalcHero(h);
    const offer = makeEliteOffer(h, makeRng(seed), 1);
    assert.equal(offer.length, 3, `seed ${seed}`);
    assert.ok(['learn', 'upgrade'].includes(offer[0].kind), `seed ${seed}: first card is a skill`);
    const gear = offer.flatMap((c) => (c.kind === 'gear' ? [c.item] : []));
    assert.equal(gear.length, 1, `seed ${seed}: one gear card`);
    assert.notEqual(ITEMS[gear[0]].rarity, 'common', `seed ${seed}: ${gear[0]}: elites never drop commons`);
    assert.notEqual(gear[0], 'venom_edge', `seed ${seed}: not the gear already worn`);
  }
});

test('with nothing to upgrade, an elite offer offers a new class skill to learn', () => {
  const h = hero('wizard', 2);
  h.skills = [];
  const offer = makeEliteOffer(h, makeRng(3), 1);
  assert.equal(offer[0].kind, 'learn');
  assert.equal(offer.filter((c) => c.kind === 'upgrade').length, 0);
  assert.equal(offer.length, 3);
});

test('the next pick is elite spoils before level-ups, and nothing once both are used up', () => {
  const r = makeRng(9);
  const h = hero('cleric', 2);
  h.elitePicks = 1;
  h.levelUps = 1;
  dealOffer(h, r, 1);
  assert.equal(h.offerKind, 'elite');
  h.elitePicks = 0;
  dealOffer(h, r, 1);
  assert.equal(h.offerKind, 'level');
  h.levelUps = 0;
  dealOffer(h, r, 1);
  assert.equal(h.offer, null);
  assert.equal(h.offerKind, undefined);
});

test('taking a gear card puts the item in the bag and uses an elite pick, not a level-up', () => {
  const h = hero('rogue', 2);
  h.elitePicks = 1;
  h.levelUps = 2;
  h.offer = [{ kind: 'gear', item: 'chain_shirt' }, { kind: 'boon', boon: 'hp' }, { kind: 'boon', boon: 'potions' }];
  h.offerKind = 'elite';
  const res = applyPick(h, { card: 0 }, makeRng(4), 1);
  assert.equal(res.ok, true);
  assert.deepEqual(h.bag, ['chain_shirt']);
  assert.equal(h.elitePicks, 0);
  assert.equal(h.levelUps, 2, 'the level-ups are untouched');
  assert.equal(h.offerKind, 'level', 'and they are dealt next');
});

test('a full bag refuses a gear card, and the pick stays open', () => {
  const h = hero('rogue', 2);
  h.bag = full();
  h.elitePicks = 1;
  h.offer = [{ kind: 'gear', item: 'chain_shirt' }, { kind: 'boon', boon: 'hp' }, { kind: 'boon', boon: 'potions' }];
  h.offerKind = 'elite';
  const offer = h.offer;
  const res = applyPick(h, { card: 0 }, makeRng(4), 1);
  assert.ok(!res.ok && /bag is full/.test(res.error));
  assert.deepEqual(h.bag, full());
  assert.equal(h.elitePicks, 1);
  assert.equal(h.offer, offer);
});

test('a saved offer card is valid while its skill, boon or gear still exists', () => {
  assert.equal(validCard({ kind: 'learn', skill: 'fire_bolt' }), true);
  assert.equal(validCard({ kind: 'learn', skill: 'no_such_skill' as SkillId }), false);
  assert.equal(validCard({ kind: 'boon', boon: 'hp' }), true);
  assert.equal(validCard({ kind: 'gear', item: 'chain_shirt' }), true);
  assert.equal(validCard({ kind: 'gear', item: 'fire_bomb' }), false, 'a consumable is not gear');
  assert.equal(validCard({ kind: 'gear', item: 'no_such_item' as ItemId }), false);
});

// ---------------------------------------------------------------- elites in the room

test('an elite rolls one trait in act 1 and one or two in act 3, never two auras, and is named for its first trait', () => {
  const c = battle();
  for (const act of [1, 3]) {
    c.p.run.act = act;
    const counts = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const m = rollElite(c.p, 'hobgoblin');
      const traits = m.traits ?? [];
      counts.add(traits.length);
      assert.ok(act === 1 ? traits.length === 1 : traits.length === 1 || traits.length === 2, `act ${act}: ${traits.length}`);
      assert.equal(new Set(traits).size, traits.length, 'no trait twice');
      assert.ok(traits.filter((t) => TRAITS[t].aura).length <= 1, 'never two auras');
      assert.ok(m.name.startsWith(`${TRAITS[traits[0]].name} `), m.name);
    }
    if (act === 3) assert.deepEqual([...counts].sort(), [1, 2], 'both counts come up in 40 rolls');
  }
});

test('Swift adds 3 movement, 1 AC and 5 initiative', () => {
  const c = battle();
  const m = placeElite(c.p, 'swift', 6, 5);
  assert.equal(m.speed, MONSTERS.hobgoblin.speed + 3);
  assert.equal(m.ac, MONSTERS.hobgoblin.ac + 1);
  assert.equal(c.p.initBonus(m), MONSTERS.hobgoblin.dex + 5);
});

test('a Shielded elite starts with a ward of a quarter of its max HP, and the broken ward re-forms once, on a 3rd round', () => {
  const c = battle();
  const m = placeElite(c.p, 'shielded', 6, 5);
  assert.equal(m.ward, Math.round(m.maxHp / 4));
  m.ward = 5;
  c.p.turn.round = 3;
  c.p.eliteTurnStart(m);
  assert.equal(m.ward, 5, 'not topped up while it holds');
  m.ward = 0;
  c.p.turn.round = 5;
  c.p.eliteTurnStart(m);
  assert.equal(m.ward, 0, 'not on round 5');
  c.p.turn.round = 6;
  c.p.eliteTurnStart(m);
  assert.equal(m.ward, Math.round(m.maxHp / 4), 're-formed on round 6');
  m.ward = 0;
  c.p.turn.round = 9;
  c.p.eliteTurnStart(m);
  assert.equal(m.ward, 0, 'only once a fight');
});

test('damage to a Shielded elite goes into its ward before its HP', () => {
  const c = battle();
  const m = placeElite(c.p, 'shielded', 6, 5);
  const ward = m.ward ?? 0;
  const hp = m.hp;
  c.p.damage(m, ward - 2, c.heroes[0]);
  assert.equal(m.ward, 2);
  assert.equal(m.hp, hp, 'the ward took it all');
  c.p.damage(m, 5, c.heroes[0]);
  assert.equal(m.ward, 0);
  assert.equal(m.hp, hp - 3, 'what the ward could not soak gets through');
  assert.ok(logged(c.p, /ward shatters/));
});

test('a Burning elite scorches the hero next to it at the start of its turn, with 1d6 fire', () => {
  const c = battle(['fighter', 'wizard']);
  const [fighter, wizard] = c.heroes;
  wizard.x = 9;
  wizard.y = 6; // out of the aura
  const m = placeElite(c.p, 'burning', 3, 3); // the fighter stands at 2,3
  withRandom(HIGH, () => c.p.eliteTurnStart(m));
  assert.equal(fighter.hp, 34, 'a 6 on the d6');
  assert.equal(wizard.hp, 40);
});

// ---------------------------------------------------------------- NPC allies in a fight

test('an NPC ally at 0 HP leaves the fight and the run, and the fight goes on while a monster is standing', () => {
  const c = battle();
  const { p } = c;
  const state = brann();
  p.run.allies = [state];
  const ally = c.npc(state, 4, 5);
  const foe = c.foe('goblin', 7, 3, 100);
  p.damage(ally, ally.hp, foe);
  assert.ok(!p.entities.includes(ally));
  assert.deepEqual(p.run.allies, []);
  assert.ok(logged(p, /won't be fighting/));
  assert.equal(p.checkEnd(), false, 'the goblin is still standing');
  assert.equal(c.g.phase, 'combat');
});

test('once only heroes and NPC allies are left standing, the fight is over and the ally carries on', () => {
  const c = battle();
  const { p, g, heroes } = c;
  const state = brann();
  p.run.allies = [state];
  c.npc(state, 4, 5);
  const foe = c.foe('goblin', 7, 3, 7);
  p.damage(foe, foe.hp, heroes[0]);
  assert.equal(p.checkEnd(), true);
  assert.equal(g.phase, 'map');
  assert.equal(p.run.allies[0].fights, ALLY_FIGHTS - 1, 'an ally that survives the fight has one fight fewer to go');
});

test('a finished fight ticks every ally down, and an ally on its last fight heads home', () => {
  const c = battle();
  const { p } = c;
  p.run.allies = [brann(3), { id: 'ranger', name: 'Lark the Ranger', fights: 1 }];
  p.endCombat();
  assert.deepEqual(p.run.allies, [{ id: 'sellsword', name: 'Brann the Sellsword', fights: 2 }]);
  assert.ok(logged(p, /heads home/));
});

// ---------------------------------------------------------------- winning an elite, and the vote

/**
 * Kills the elite in the battle with one blow from the first hero. Heroes sit at the level cap so the kill gives no XP
 * and no level-up competes with the spoils. Returns the choices the party is then offered.
 */
function winElite(c: ReturnType<typeof battle>) {
  const { p, heroes } = c;
  for (const h of heroes) {
    h.level = LEVEL_CAP;
    recalcHero(h);
  }
  p.roomKind = 'elite';
  const m = c.foe('hobgoblin', 6, 3);
  m.ward = 0;
  p.damage(m, m.hp, heroes[0]);
  p.checkEnd();
  return p.event.choices as { id: string }[];
}

test('winning an elite fight gives every hero an elite pick, and the party votes on 2 blessings and an ally', () => {
  const c = battle();
  const choices = winElite(c);
  assert.equal(c.g.phase, 'event');
  assert.equal(c.p.savePoint.kind, 'reward');
  for (const h of c.heroes) {
    assert.equal(h.elitePicks, 1);
    assert.equal(h.offerKind, 'elite');
    assert.equal(h.offer?.length, 3);
  }
  const ids = choices.map((x) => x.id);
  assert.equal(ids.filter((id) => id.startsWith('blessing:')).length, 2);
  assert.equal(ids.filter((id) => id.startsWith('ally:')).length, 1);
  assert.equal(new Set(ids).size, 3);
  assert.equal(c.heroes[0].bag.length, 1, 'the elite gear goes to the hero who landed the killing blow');
  assert.notEqual(ITEMS[c.heroes[0].bag[0]].rarity, 'common', 'elites never drop commons');
});

test('the spoils vote never offers a blessing the party already holds', () => {
  const c = battle();
  c.p.run.blessings = ['valor', 'bulwark', 'vigor', 'arcana', 'haste', 'fortune'];
  const ids = winElite(c).map((x) => x.id);
  assert.deepEqual(ids.filter((id) => id.startsWith('blessing:')).sort(), ['blessing:renewal', 'blessing:warding']);
});

// ---------------------------------------------------------------- blessings, allies and acts

test('a blessing adds to the whole party until the end of the act, and a second copy does nothing', () => {
  const c = camp();
  const before = c.heroes.map((h) => h.maxHp);
  c.p.applyEffect({ kind: 'blessing', id: 'vigor' });
  assert.deepEqual(c.p.run.blessings, ['vigor']);
  c.heroes.forEach((h, i) => {
    assert.deepEqual(h.blessings, ['vigor']);
    assert.equal(h.maxHp, before[i] + 8, 'Vigor: +8 max HP');
  });
  c.p.applyEffect({ kind: 'blessing', id: 'vigor' });
  assert.deepEqual(c.p.run.blessings, ['vigor']);
  c.heroes.forEach((h, i) => assert.equal(h.maxHp, before[i] + 8));
});

test('an ally joins for 3 fights, and with two already along the one closest to leaving makes way', () => {
  const c = camp();
  c.p.applyEffect({ kind: 'ally', id: 'acolyte' });
  assert.equal(c.p.run.allies.length, 1);
  assert.equal(c.p.run.allies[0].id, 'acolyte');
  assert.equal(c.p.run.allies[0].fights, ALLY_FIGHTS);
  assert.match(c.p.run.allies[0].name, / the Acolyte$/);

  c.p.run.allies = [{ id: 'ranger', name: 'Lark the Ranger', fights: 3 }, brann(1)]; // the one leaving is not first
  c.p.applyEffect({ kind: 'ally', id: 'hound' });
  const names: string[] = c.p.run.allies.map((a: AllyState) => a.name);
  assert.equal(names.length, MAX_ALLIES);
  assert.ok(names.includes('Lark the Ranger'));
  assert.ok(!names.includes('Brann the Sellsword'), 'the ally closest to leaving goes');
  assert.equal(c.p.run.allies.find((a: AllyState) => a.id === 'hound')?.fights, ALLY_FIGHTS);
});

test("finishing an act fades the party's blessings, and Vigor's HP goes with them", () => {
  const c = camp();
  const [h] = c.heroes;
  const base = h.maxHp;
  c.p.applyEffect({ kind: 'blessing', id: 'vigor' });
  assert.equal(h.maxHp, base + 8);
  c.p.finishAct();
  assert.equal(c.p.run.act, 2);
  assert.deepEqual(c.p.run.blessings, []);
  assert.deepEqual(h.blessings, []);
  // The act's boss relic can be Dragon Heart (+10 max HP), granted as the act ends.
  assert.equal(h.maxHp, base + (c.p.run.relics.includes('dragon_heart') ? 10 : 0));
  assert.equal(h.hp, h.maxHp);
  assert.match(c.p.notice.text, /blessings fade/);
});

// ---------------------------------------------------------------- hunting allies

test(
  'a War Hound runs down enemy archers and casters, before the nearest foe',
  async () => {
    const c = battle(['fighter', 'wizard']);
    const { p } = c;
    const state: AllyState = { id: 'hound', name: 'Biscuit the War Hound', fights: ALLY_FIGHTS };
    p.run.allies = [state];
    const hound = c.npc(state, 5, 3);
    c.foe('goblin', 6, 3, 100); // right next to the hound
    const archer = c.foe('archer', 5, 7, 100); // a few tiles off, but an archer
    await p.runMonster(hound, p.turnToken);
    assert.ok(dist(hound, archer) <= 1, 'it ran down the archer');
  },
);
