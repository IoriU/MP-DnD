import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barkLine, BARK_ODDS, LINES } from '../server/barks.ts';
import { canHitFrom, closestEnemy, hitChance, planMonster, squadFocus, squadPlan, upNow, walkMap, type MonsterPlan, type MonsterView, type SquadPlan } from '../server/monsterai.ts';
import { dist } from '../shared/grid.ts';
import { ACTS, CLASSES, COWARD_HP, COWARD_TURNS, DIFFICULTIES, DIFFICULTY_IDS, MONSTERS, ROLES, isDifficulty, maxHpFor, packsFor, roleOf, type MonsterDef } from '../shared/rules.ts';
import type { StatusId } from '../shared/skills.ts';
import { hazardAt, type CloudId, type FieldLike, type GroundId } from '../shared/surfaces.ts';
import type { ClassId, Entity, MonsterEntity, PlayerEntity, Pos, StatusInst } from '../shared/types.ts';

// The monster AI (Phase 9): hit odds, the squad's focus and packs, what one monster does on its turn, its walk, and the barks.
// Every board is hand-made and every roll is passed in (`rand`), so the tests are deterministic.

/** Above Normal's slip (0.15): the squad plays its plan. */
const SQUAD = () => 0.99;
/** Below Normal's slip: the monster goes for the closest enemy on instinct. */
const SLIP = () => 0;

let seq = 0;

/** The 12x8 room: a wall ring round an open floor. */
function room(): FieldLike {
  return grid(Array.from({ length: 8 }, (_, y) => Array.from({ length: 12 }, (_, x) => (x === 0 || y === 0 || x === 11 || y === 7 ? '#' : '.')).join('')));
}

/** A map from rows of text: '#' is a wall, anything else floor. */
function grid(rows: string[]): FieldLike {
  return { width: rows[0].length, height: rows.length, tiles: rows.join(''), ground: {}, clouds: {}, props: {} };
}

const at = (m: FieldLike, x: number, y: number) => y * m.width + x;

/** Paints permanent ground (fire, oil...) and poison gas clouds onto a map. */
function paint(m: FieldLike, ground: [number, number, GroundId][] = [], clouds: [number, number, CloudId][] = []): FieldLike {
  for (const [x, y, id] of ground) m.ground[at(m, x, y)] = { id, turns: null };
  for (const [x, y, id] of clouds) m.clouds[at(m, x, y)] = { id, turns: 3 };
  return m;
}

/** A hero of a class at a tile, with the HP and AC of a level 1 hero (override with `extra`). */
function hero(classId: ClassId, x: number, y: number, extra: Partial<PlayerEntity> = {}): PlayerEntity {
  const hp = maxHpFor(classId, 1);
  return {
    id: `h${++seq}`, kind: 'player', playerId: `p${seq}`, classId, name: CLASSES[classId].name, glyph: '', color: '#fff', x, y,
    hp, maxHp: hp, ac: CLASSES[classId].ac, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level: 1, xp: 0, skills: [], levelUps: 0,
    offer: null, elitePicks: 0, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 0, gear: {}, bag: [], relics: [], blessings: [],
    kills: 0, steals: 0, slots: 0, maxSlots: 0, downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], ...extra,
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

const status = (id: StatusId, turns = 2, by?: string): StatusInst => (by ? { id, turns, by } : { id, turns });

/** Plans one monster's turn on Normal's squad rolls, unless told otherwise. */
function plan(me: MonsterEntity, entities: Entity[], extra: Partial<MonsterView> = {}): MonsterPlan {
  return planMonster({ me, map: room(), entities, moves: 6, difficulty: 'normal', focus: null, rand: SQUAD, ...extra });
}

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------- hit odds

test('hit chance: a plain roll hits when bonus + 21 - AC is out of 20, with a 5% floor', () => {
  assert.equal(hitChance(4, 13), 0.6);
  assert.equal(hitChance(4, 13, 0), 0.6);
  assert.equal(hitChance(0, 21), 0.05);
});

test('hit chance is clamped to 5% and 95%', () => {
  assert.equal(hitChance(20, 1), 0.95);
  assert.equal(hitChance(-10, 20), 0.05);
});

test('hit chance with advantage (either of two rolls) or disadvantage (both)', () => {
  assert.ok(approx(hitChance(4, 13, 1), 0.84));
  assert.ok(approx(hitChance(4, 13, -1), 0.36));
  assert.ok(approx(hitChance(-10, 20, 1), 0.0975));
  assert.ok(approx(hitChance(20, 1, -1), 0.9025));
});

test('a monster at a tile can hit the hero from there: melee next to it, ranged in range and in sight', () => {
  const m = room();
  const goblin = monster('goblin', 1, 1);
  const archer = monster('archer', 1, 1);
  assert.equal(canHitFrom(m, goblin, { x: 4, y: 4 }, { x: 5, y: 4 }), true);
  assert.equal(canHitFrom(m, goblin, { x: 4, y: 4 }, { x: 6, y: 4 }), false);
  assert.equal(canHitFrom(m, archer, { x: 4, y: 4 }, { x: 9, y: 4 }), true);
  const walled = paint(room());
  walled.tiles = walled.tiles.slice(0, at(walled, 6, 4)) + '#' + walled.tiles.slice(at(walled, 6, 4) + 1);
  assert.equal(canHitFrom(walled, archer, { x: 4, y: 4 }, { x: 9, y: 4 }), false);
});

test('a monster is up while it lives; a hero is up until downed or dead', () => {
  assert.equal(upNow(monster('goblin', 1, 1, { hp: 0 })), true);
  assert.equal(upNow(hero('fighter', 1, 1)), true);
  assert.equal(upNow(hero('fighter', 1, 1, { downed: true })), false);
  assert.equal(upNow(hero('fighter', 1, 1, { dead: true })), false);
});

// ---------------------------------------------------------------- the squad's focus

test('squad focus picks the hero the squad can hurt most for its HP: a hurt wizard over a healthy fighter', () => {
  const fighter = hero('fighter', 3, 3);
  const wizard = hero('wizard', 8, 3, { hp: 3 });
  const squad = [monster('goblin', 5, 5), monster('goblin', 6, 6)];
  assert.equal(squadFocus([fighter, wizard, ...squad], 'foes', null), wizard.id);
});

test('squad focus is sticky: the current target stays while it is still at least 70% as good as the best', () => {
  const a = hero('fighter', 3, 3); // 12/12 HP
  const b = hero('fighter', 3, 4, { hp: 11 }); // 11/12: a touch better to hit
  const ents = [a, b, monster('goblin', 4, 5), monster('goblin', 4, 6)];
  assert.equal(squadFocus(ents, 'foes', null), b.id);
  assert.equal(squadFocus(ents, 'foes', a.id), a.id);
});

test('squad focus switches when the current target is much worse than the best', () => {
  const a = hero('fighter', 3, 3); // 12/12 HP
  const b = hero('fighter', 3, 4, { hp: 5 }); // hurt: a far better bite
  const ents = [a, b, monster('goblin', 4, 5), monster('goblin', 4, 6)];
  assert.equal(squadFocus(ents, 'foes', a.id), b.id);
});

test('squad focus switches when the current target has left the fight', () => {
  const a = hero('fighter', 3, 3);
  const b = hero('fighter', 3, 4);
  const goblins = [monster('goblin', 4, 5), monster('goblin', 4, 6)];
  assert.equal(squadFocus([b, ...goblins], 'foes', a.id), b.id, 'gone from the board');
  const downed = hero('fighter', 3, 3, { hp: 0, downed: true });
  assert.equal(squadFocus([downed, b, ...goblins], 'foes', downed.id), b.id, 'downed');
});

test('squad focus looks past hidden heroes while someone else is in the open', () => {
  const hidden = hero('wizard', 3, 3, { hp: 2, statuses: [status('hidden')] });
  const open = hero('fighter', 3, 4);
  const goblins = [monster('goblin', 4, 5), monster('goblin', 4, 6)];
  assert.equal(squadFocus([hidden, open, ...goblins], 'foes', null), open.id);
  assert.equal(squadFocus([hidden, open, ...goblins], 'foes', hidden.id), open.id);
  const alsoHidden = hero('fighter', 3, 4, { statuses: [status('hidden')] });
  assert.equal(squadFocus([hidden, alsoHidden, ...goblins], 'foes', null), hidden.id, 'everyone hidden: the squad picks among them');
});

// ---------------------------------------------------------------- squad packs

/** Heroes down the right-hand column (x 10, y 1..n), the first `hidden` of them out of sight. */
const column = (n: number, hidden = 0) => Array.from({ length: n }, (_, i) => hero('fighter', 10, i + 1, i < hidden ? { statuses: [status('hidden')] } : {}));
/** Goblins down the left-hand column (x 4, y 1..n). */
const goblins = (n: number) => Array.from({ length: n }, (_, i) => monster('goblin', 4, i + 1));
const packSizes = (plan: SquadPlan) => plan.targets.map((t) => Object.values(plan.assign).filter((v) => v === t).length);

/** Two heroes with the goblins between them, and a hurt wizard far off (the squad picks it, but no goblin is near it). */
function splitBoard() {
  const a = hero('fighter', 4, 2);
  const b = hero('fighter', 4, 5);
  const far = hero('wizard', 10, 4, { hp: 2 });
  const others = [hero('fighter', 10, 1), hero('fighter', 10, 2), hero('fighter', 10, 6)];
  const gs = [monster('goblin', 3, 2), monster('goblin', 3, 3), monster('goblin', 3, 4), monster('goblin', 3, 5)];
  return { a, b, far, ents: [a, b, far, ...others, ...gs] as Entity[] };
}

/** Every monster joins the nearest target that still has room (room = ceil(monsters / targets)). */
function assertNearestWithRoom(entities: Entity[], plan: SquadPlan) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const squad = entities.filter((e): e is MonsterEntity => e.kind === 'monster' && !e.ally);
  // Packs fill to their fair share first (floor), then take the leftovers: a nearer pack was only passed if it was full.
  const share = Math.floor(squad.length / plan.targets.length);
  const load = (t: string) => Object.values(plan.assign).filter((v) => v === t).length;
  for (const m of squad) {
    const t = plan.assign[m.id];
    assert.ok(t !== undefined, `${m.id} has no pack`);
    const d = dist(m, byId.get(t)!);
    for (const other of plan.targets) {
      if (other === t || dist(m, byId.get(other)!) >= d) continue;
      assert.ok(load(other) >= share, `${m.id} passed a nearer target, ${other}, that still had room`);
    }
  }
}

test("squad packs: one pack per solo hero's worth of monsters, 3 at most, and every monster joins one", () => {
  const heroes = [hero('fighter', 2, 2), hero('fighter', 2, 5), hero('wizard', 9, 3)];
  const gs = [monster('goblin', 4, 2), monster('goblin', 4, 3), monster('goblin', 4, 4), monster('goblin', 5, 5)];
  const { targets, assign } = squadPlan([...heroes, ...gs]);
  assert.equal(targets.length, packsFor(3));
  assert.equal(targets.length, 2);
  assert.equal(Object.keys(assign).length, gs.length);
});

test('squad packs: as many targets as packs, capped by the monsters and by the heroes in sight', () => {
  assert.equal(squadPlan([...column(6), ...goblins(5)]).targets.length, 3, 'six heroes and five monsters: three packs');
  assert.equal(squadPlan([...column(6), ...goblins(2)]).targets.length, 2, 'two monsters: two packs at most');
  assert.equal(squadPlan([...column(1), ...goblins(3)]).targets.length, 1, 'a lone hero: one pack');
  const hs = column(6, 4);
  const plan = squadPlan([...hs, ...goblins(5)]);
  assert.equal(plan.targets.length, 2, 'four heroes hidden: only the two in the open can be targets');
  assert.ok(plan.targets.every((t) => hs.slice(4).some((h) => h.id === t)));
});

test('squad packs: every monster joins one of the targets', () => {
  const heroes = column(6);
  const gs = goblins(5);
  const { targets, assign } = squadPlan([...heroes, ...gs]);
  assert.deepEqual(Object.keys(assign).sort(), gs.map((g) => g.id).sort());
  assert.ok(Object.values(assign).every((t) => targets.includes(t)));
  assert.ok(targets.every((t) => heroes.some((h) => h.id === t)));
});

test('squad packs: packs of six heroes and five monsters come out within one of each other', () => {
  const sizes = packSizes(squadPlan([...column(6), ...goblins(5)]));
  assert.equal(sizes.length, 3);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `pack sizes ${sizes}`);
});

test('squad packs: the packs come out within one monster of each other, even with a hurt hero far off', () => {
  const sizes = packSizes(squadPlan(splitBoard().ents));
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `pack sizes ${sizes}`);
});

test('squad packs: each monster joins the nearest target that still has room', () => {
  const ents = [...column(6), ...goblins(5)];
  assertNearestWithRoom(ents, squadPlan(ents));
  const board = splitBoard();
  assertNearestWithRoom(board.ents, squadPlan(board.ents));
});

test('squad packs: a current target is kept while it is still 70% as good as the best', () => {
  const a = hero('fighter', 9, 1);
  const b = hero('fighter', 9, 4, { hp: 11 });
  const c = hero('fighter', 9, 6);
  const ents = [a, b, c, ...goblins(4)];
  assert.deepEqual(squadPlan(ents).targets, [b.id, a.id], 'best first, then the first of the tie');
  assert.deepEqual(squadPlan(ents, [c.id, b.id]).targets, [c.id, b.id], 'both still good enough: kept as they were');
});

test('squad packs: a current target much worse than the best is dropped', () => {
  const a = hero('fighter', 9, 1);
  const b = hero('fighter', 9, 4, { hp: 5 });
  const c = hero('fighter', 9, 6);
  const plan = squadPlan([a, b, c, ...goblins(4)], [c.id]);
  assert.ok(!plan.targets.includes(c.id));
  assert.deepEqual(plan.targets, [b.id, a.id]);
});

test('squad packs: a target that is down or dead is replaced', () => {
  // Four heroes, one of them gone: three still stand, so two packs.
  const variants: Partial<PlayerEntity>[] = [{ downed: true, hp: 0 }, { dead: true, hp: 0 }];
  for (const gone of variants) {
    const a = hero('fighter', 9, 1, gone);
    const b = hero('fighter', 9, 3);
    const c = hero('fighter', 9, 5);
    const d = hero('fighter', 9, 6);
    const plan = squadPlan([a, b, c, d, ...goblins(4)], [a.id, b.id]);
    assert.deepEqual(plan.targets, [b.id, c.id], JSON.stringify(gone));
  }
});

test('squad packs: with no monsters there is no plan', () => {
  assert.deepEqual(squadPlan([hero('fighter', 2, 2), hero('wizard', 3, 3)]), { targets: [], assign: {} });
  assert.deepEqual(squadPlan([]), { targets: [], assign: {} });
});

test('squad focus: NPC allies target monsters; with nobody to fight it is null', () => {
  const h = hero('fighter', 3, 3);
  const foe = monster('goblin', 6, 3);
  const acolyte = monster('acolyte', 4, 3, { ally: true, name: 'Brother Aldo' });
  assert.equal(squadFocus([h, foe, acolyte], 'allies', null), foe.id);
  assert.equal(squadFocus([h, foe], 'allies', null), null, 'no NPC allies: no squad');
  assert.equal(squadFocus([h, acolyte], 'allies', null), null, 'no monsters: nothing to target');
  assert.equal(squadFocus([h], 'foes', null), null, 'no monsters: no squad');
  assert.equal(squadFocus([hero('fighter', 3, 3, { downed: true, hp: 0 }), foe], 'foes', null), null, 'everyone down');
});

// ---------------------------------------------------------------- difficulty and instinct

test('story: no squad, each monster goes for the closest enemy on instinct', () => {
  const me = monster('goblin', 5, 4);
  const closest = hero('fighter', 6, 4);
  const hurtFar = hero('wizard', 9, 4, { hp: 2 });
  const p = plan(me, [closest, hurtFar, me], { difficulty: 'story', rand: SQUAD });
  assert.equal(p.instinct, true);
  assert.equal(p.target, closest.id);
});

test('normal: a slip (rand below 0.15) is instinct; a squad turn is not', () => {
  const me = monster('goblin', 5, 4);
  const closest = hero('fighter', 6, 4);
  const hurtFar = hero('wizard', 9, 4, { hp: 2 });
  const slipped = plan(me, [closest, hurtFar, me], { rand: SLIP });
  assert.equal(slipped.instinct, true);
  assert.equal(slipped.target, closest.id);
  const squadded = plan(me, [closest, hurtFar, me], { rand: SQUAD });
  assert.notEqual(squadded.instinct, true);
});

test('a taunted monster attacks its taunter, even with a closer and weaker hero next to it', () => {
  const taunter = hero('fighter', 9, 4);
  const weakClose = hero('wizard', 6, 4, { hp: 2 }); // next to it, and easy to finish
  const me = monster('goblin', 5, 4, { statuses: [status('taunted', 2, taunter.id)] });
  for (const difficulty of ['normal', 'story'] as const) {
    const p = plan(me, [weakClose, taunter, me], { difficulty });
    assert.equal(p.target, taunter.id, difficulty);
  }
  assert.equal(closestEnemy(me, [weakClose, taunter, me])?.id, taunter.id);
});

test("a squad walks toward its focus when the focus is farther off than a hero it can't reach this turn", () => {
  const near = hero('fighter', 5, 4);
  const focus = hero('fighter', 10, 4);
  const me = monster('goblin', 1, 4);
  const p = plan(me, [near, focus, me], { focus: focus.id, moves: 2 });
  assert.equal(p.target, focus.id);
});

// ---------------------------------------------------------------- shoves and kiting

test('brute shove: an orc shoves a hero that faces it into the fire behind the hero', () => {
  const h = hero('fighter', 5, 4, { facing: { x: -1, y: 0 } }); // faces the orc: no back attack
  const orc = monster('orc', 4, 4);
  const p = plan(orc, [h, orc], { map: paint(room(), [[6, 4, 'fire']]) });
  assert.equal(p.kind, 'shove');
  assert.equal(p.target, h.id);
});

test('brute shove: with no fire behind the hero the orc just attacks', () => {
  const h = hero('fighter', 5, 4, { facing: { x: -1, y: 0 } });
  const orc = monster('orc', 4, 4);
  const p = plan(orc, [h, orc]);
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, h.id);
});

test('only monsters with shove shove: a goblin never does, even with fire behind the hero', () => {
  const h = hero('fighter', 5, 4, { facing: { x: -1, y: 0 } });
  const goblin = monster('goblin', 4, 4);
  const p = plan(goblin, [h, goblin], { map: paint(room(), [[6, 4, 'fire']]) });
  assert.notEqual(p.kind, 'shove');
  assert.equal(p.target, h.id);
});

test('an archer next to a fighter steps back out of melee and still shoots', () => {
  // A one-tile corridor, so the only way back is straight back (in the open it would walk round behind the fighter).
  const m = grid(['#########', '#.......#', '#########']);
  const f = hero('fighter', 3, 1, { facing: { x: 1, y: 0 } }); // facing the archer
  const archer = monster('archer', 4, 1);
  const p = plan(archer, [f, archer], { map: m });
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, f.id);
  assert.ok(p.path.length > 0, 'it moves first');
  const end = p.path.at(-1) as Pos;
  assert.ok(dist(end, f) >= 2, `ends ${dist(end, f)} tiles away`);
});

// ---------------------------------------------------------------- cowards

test('a coward below its nerve runs while the rest of its side still fights', () => {
  const f = hero('fighter', 5, 4);
  const rat = monster('rat', 6, 4, { hp: 2 });
  const goblin = monster('goblin', 9, 6);
  assert.ok(rat.hp < rat.maxHp * COWARD_HP);
  const p = plan(rat, [f, rat, goblin]);
  assert.equal(p.kind, 'flee');
  assert.equal(p.cornered, undefined);
  const end = p.path.at(-1) as Pos;
  assert.ok(dist(end, f) > dist(rat, f), `ends ${dist(end, f)} tiles from the hero`);
});

test('a coward on its own (the last one standing) fights', () => {
  const f = hero('fighter', 5, 4);
  const rat = monster('rat', 6, 4, { hp: 2 });
  const p = plan(rat, [f, rat]);
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, f.id);
});

test('a coward that has run for its turns already fights', () => {
  const f = hero('fighter', 5, 4);
  const rat = monster('rat', 6, 4, { hp: 2, fled: COWARD_TURNS });
  const goblin = monster('goblin', 9, 6);
  const p = plan(rat, [f, rat, goblin]);
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, f.id);
});

test('a cornered coward has no tile farther off than one from the hero, so it fights and is marked cornered', () => {
  // A one-tile-high corridor: the hero stands in it, so the rat can only stay where it is.
  const m = grid(['##########', '#........#', '##########']);
  const f = hero('fighter', 2, 1, { facing: { x: -1, y: 0 } });
  const rat = monster('rat', 1, 1, { hp: 1 });
  const goblin = monster('goblin', 8, 1);
  const p = plan(rat, [f, rat, goblin], { map: m });
  assert.equal(p.cornered, true);
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, f.id);
});

// ---------------------------------------------------------------- supports

test('a shaman mends a hurt goblin in range rather than attacking', () => {
  const f = hero('fighter', 5, 4);
  const goblin = monster('goblin', 6, 4, { hp: 3 });
  const shaman = monster('shaman', 10, 4);
  const p = plan(shaman, [f, goblin, shaman]);
  assert.equal(p.kind, 'heal');
  assert.equal(p.target, goblin.id);
});

test('a shaman rallies a healthy hobgoblin that is fighting next to a hero', () => {
  const f = hero('fighter', 5, 4);
  const hob = monster('hobgoblin', 6, 4);
  const shaman = monster('shaman', 9, 4);
  const p = plan(shaman, [f, hob, shaman]);
  assert.equal(p.kind, 'buff');
  assert.equal(p.target, hob.id);
  assert.equal(MONSTERS.shaman.support?.buff.id, 'rallied');
});

test('a necromancer shields a healthy skeleton that two heroes are cutting into', () => {
  const h1 = hero('fighter', 5, 3);
  const h2 = hero('fighter', 5, 5);
  const skeleton = monster('skeleton', 6, 4);
  const necro = monster('necromancer', 10, 4);
  const p = plan(necro, [h1, h2, skeleton, necro]);
  assert.equal(p.kind, 'buff');
  assert.equal(p.target, skeleton.id);
  assert.deepEqual(MONSTERS.necromancer.support?.buff, { id: 'shielded', turns: 2, power: 2 });
});

test("an NPC acolyte heals the hero it's standing near, even one who is down", () => {
  const down = hero('fighter', 6, 4, { hp: 0, downed: true });
  const acolyte = monster('acolyte', 4, 4, { ally: true, name: 'Brother Aldo' });
  const foe = monster('goblin', 9, 4);
  const p = plan(acolyte, [down, acolyte, foe]);
  assert.equal(p.kind, 'heal');
  assert.equal(p.target, down.id);
});

// ---------------------------------------------------------------- the ground and the gas

test('a cultist that cannot move sets the poison gas round two heroes alight', () => {
  // The heroes stand clear of the gas, with the cloud on every free tile round them. (A hero standing in the gas gets
  // hit, and so sets off the gas under it: that's a plain attack, tested by the hero-in-oil case below.)
  const m = room();
  const a = hero('fighter', 7, 3);
  const b = hero('fighter', 7, 5);
  for (let x = 6; x <= 8; x++) for (let y = 2; y <= 6; y++) if (!(x === 7 && (y === 3 || y === 5))) paint(m, [], [[x, y, 'gas']]);
  const cultist = monster('cultist', 2, 4);
  const p = plan(cultist, [a, b, cultist], { map: m, moves: 0, focus: a.id });
  assert.equal(p.kind, 'ignite');
  assert.ok(p.tile, 'it names the tile it hits');
  assert.ok(p.path.length === 0, 'it cannot move');
  const tile = p.tile as Pos;
  assert.ok(m.clouds[at(m, tile.x, tile.y)], 'the tile is in the gas');
  assert.ok([a, b].every((h) => h.x !== tile.x || h.y !== tile.y), 'the tile is free');
  assert.ok([a, b].some((h) => dist(h, tile) <= 1), 'next to a hero');
});

test('a cultist goes for the hero standing in oil over a closer hero on dry ground', () => {
  const m = room();
  for (let x = 7; x <= 9; x++) for (let y = 3; y <= 5; y++) paint(m, [[x, y, 'oil']]);
  const dry = hero('fighter', 4, 4, { name: 'Dry' });
  const oily = hero('fighter', 8, 4, { name: 'Oily' });
  const cultist = monster('cultist', 2, 4);
  const p = plan(cultist, [dry, oily, cultist], { map: m, focus: dry.id });
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, oily.id);
});

test('a monster does not end its move on fire when a safe tile is just as good', () => {
  const h = hero('fighter', 6, 4, { facing: { x: -1, y: 0 } });
  const goblin = monster('goblin', 3, 4);
  const m = paint(room(), [[5, 4, 'fire']]);
  const p = plan(goblin, [h, goblin], { map: m, moves: 2 });
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, h.id);
  const end = p.path.at(-1) as Pos;
  assert.equal(hazardAt(m, at(m, end.x, end.y), goblin), 0, `ends on a safe tile (${end.x},${end.y})`);
  assert.equal(dist(end, h), 1);
});

test('a fire-immune drake stands in the fire to hit a hero', () => {
  // A one-tile corridor: the fire is the only tile the drake can hit the hero from.
  const m = paint(grid(['#########', '#.......#', '#########']), [[6, 1, 'fire']]);
  const h = hero('fighter', 7, 1, { facing: { x: -1, y: 0 } });
  const drake = monster('drake', 3, 1);
  const p = plan(drake, [h, drake], { map: m, moves: 3 });
  assert.equal(p.kind, 'attack');
  assert.equal(p.target, h.id);
  assert.deepEqual(p.path.at(-1), { x: 6, y: 1 });
});

test('a goblin in the same corridor does not walk into the fire to reach the hero', () => {
  const m = paint(grid(['#########', '#.......#', '#########']), [[6, 1, 'fire']]);
  const h = hero('fighter', 7, 1, { facing: { x: -1, y: 0 } });
  const goblin = monster('goblin', 3, 1);
  const p = plan(goblin, [h, goblin], { map: m, moves: 3 });
  const end = p.path.at(-1) ?? { x: goblin.x, y: goblin.y };
  assert.notDeepEqual(end, { x: 6, y: 1 });
});

// ---------------------------------------------------------------- hunts

test('a war hound ally runs down the archer over the closer goblin', () => {
  const hound = monster('war_hound', 5, 4, { ally: true, name: 'Biscuit' });
  const goblin = monster('goblin', 6, 4);
  const archer = monster('archer', 8, 4);
  const ents: Entity[] = [hound, goblin, archer];
  assert.equal(closestEnemy(hound, ents)?.id, archer.id, 'closest shooter');
  assert.equal(plan(hound, ents, { difficulty: 'story' }).target, archer.id, 'instinct');
  assert.equal(plan(hound, ents, { difficulty: 'normal' }).target, archer.id, 'squad');
});

test('a war hound on a squad turn weighs shooters up: the cultist over the zombie it can hit more easily', () => {
  // Without the hunt bonus the zombie (AC 8) is the better bite; with it the cultist (a caster) is worth more.
  const hound = monster('war_hound', 5, 4, { ally: true, name: 'Biscuit' });
  const zombie = monster('zombie', 6, 4);
  const cultist = monster('cultist', 9, 4);
  const p = plan(hound, [hound, zombie, cultist], { moves: 8 });
  assert.equal(p.target, cultist.id);
});

// ---------------------------------------------------------------- walking

test('walks respect the moves left', () => {
  const m = room();
  const me = monster('goblin', 2, 4);
  const walks = walkMap(m, me, [me], 2);
  assert.equal(walks.get(at(m, 4, 4))?.steps, 2);
  assert.equal(walks.has(at(m, 5, 4)), false, 'three tiles away is out of reach');
  assert.equal(walkMap(m, me, [me], 0).size, 1, 'no moves: only where it stands');
});

test('walks never enter a tile with a living creature on it, but a dead hero is walked over', () => {
  const m = grid(['#########', '#.......#', '#########']);
  const me = monster('goblin', 1, 1);
  const blocker = hero('fighter', 3, 1);
  const blocked = walkMap(m, me, [me, blocker], 6);
  assert.equal(blocked.has(at(m, 2, 1)), true);
  assert.equal(blocked.has(at(m, 3, 1)), false);
  assert.equal(blocked.has(at(m, 4, 1)), false, 'cannot get past the hero');
  const grave = hero('fighter', 3, 1, { dead: true, hp: 0 });
  const walked = walkMap(m, me, [me, grave], 6);
  assert.equal(walked.get(at(m, 3, 1))?.steps, 2, 'over the grave');
  assert.equal(walked.get(at(m, 4, 1))?.steps, 3);
});

test('walks take the way with the least hazard to each tile', () => {
  const m = paint(room(), [[3, 4, 'fire']]);
  const me = monster('goblin', 2, 4);
  const walks = walkMap(m, me, [me], 3);
  const beyond = walks.get(at(m, 4, 4));
  assert.ok(beyond);
  assert.equal(beyond.harm, 0);
  assert.equal(beyond.steps, 2);
  assert.ok(!beyond.path.some((p) => p.x === 3 && p.y === 4), 'goes round the fire');
  const through = walks.get(at(m, 3, 4));
  assert.equal(through?.steps, 1);
  assert.equal(through?.harm, 5, 'stepping in the fire costs its harm');
});

test('a monster behind its friend in a one-tile corridor goes round by the open route instead of standing still', () => {
  // Left room (x 1-2), a corridor along y=3 and an unblocked route round the top (y=1), right room (x 9-10).
  const rows = Array.from({ length: 7 }, () => Array<string>(12).fill('#'));
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 2; x++) rows[y][x] = '.';
  for (let x = 3; x <= 8; x++) {
    rows[3][x] = '.';
    rows[1][x] = '.';
  }
  for (let y = 1; y <= 5; y++) for (let x = 9; x <= 10; x++) rows[y][x] = '.';
  const m = grid(rows.map((r) => r.join('')));
  const h = hero('fighter', 9, 2, { facing: { x: -1, y: 0 } });
  const friend = monster('goblin', 3, 3);
  const back = monster('goblin', 2, 3);
  const p = plan(back, [h, friend, back], { map: m, moves: 5 });
  assert.equal(p.kind, 'move');
  assert.deepEqual(p.path[0], { x: 2, y: 2 }, 'the first step goes the other way, round the top');
  // With the friend out of the way the corridor is the shorter road, so it heads straight in.
  const alone = plan(back, [h, back], { map: m, moves: 5 });
  assert.deepEqual(alone.path[0], { x: 3, y: 3 });
});

// ---------------------------------------------------------------- barks

test('barks: speech is "<name>: \\"<line>\\"" with the target and class filled in', () => {
  const ann = hero('fighter', 1, 1, { name: 'Ann' });
  const goblin = monster('goblin', 1, 2);
  assert.equal(barkLine(goblin, 'focus', ann, 0), '💬 Goblin: "Stick the Fighter!"');
  const orc = monster('orc', 1, 2);
  assert.equal(barkLine(orc, 'focus', ann, 0.5), '💬 Orc: "Ann is mine!"');
  assert.equal(barkLine(goblin, 'focus', monster('rat', 3, 3), 0), '💬 Goblin: "Stick the Giant Rat!"', 'a monster target: its kind');
  assert.equal(barkLine(goblin, 'focus', undefined, 0), '💬 Goblin: "Stick the enemy!"', 'no target');
});

test('barks: beasts and the mindless dead do things rather than say them, with "The" in front', () => {
  const ann = hero('fighter', 1, 1, { name: 'Ann' });
  assert.equal(barkLine(monster('rat', 1, 2), 'focus', ann, 0), '💬 The Giant Rat fixes its eyes on Ann.');
  assert.equal(barkLine(monster('wolf', 1, 2), 'focus', ann, 0), '💬 The Wolf fixes its eyes on Ann.');
  assert.equal(barkLine(monster('skeleton', 1, 2), 'focus', ann, 0.99), '💬 The Skeleton lurches toward Ann.');
});

test('barks: an NPC ally says or does it under its own name', () => {
  const ann = hero('fighter', 1, 1, { name: 'Ann' });
  const hound = monster('war_hound', 1, 2, { ally: true, name: 'Biscuit' });
  assert.equal(barkLine(hound, 'focus', ann, 0), '💬 Biscuit growls at Ann.');
  const acolyte = monster('acolyte', 1, 2, { ally: true, name: 'Brother Aldo' });
  assert.equal(barkLine(acolyte, 'heal', ann, 0), '💬 Brother Aldo: "Hold still, Ann."');
});

test('barks: a voice with no line for the event says nothing (a skeleton does not heal)', () => {
  const ann = hero('fighter', 1, 1, { name: 'Ann' });
  assert.equal(barkLine(monster('skeleton', 1, 2), 'heal', ann, 0), null);
  assert.equal(barkLine(monster('zombie', 1, 2), 'cornered', ann, 0), null);
});

test('barks: every line is non-empty and only uses known placeholders; the odds are chances', () => {
  const known = new Set(['me', 'target', 'class']);
  for (const [voice, events] of Object.entries(LINES)) {
    for (const [ev, lines] of Object.entries(events)) {
      assert.ok(lines && lines.length > 0, `${voice}.${ev} has lines`);
      for (const line of lines ?? []) {
        assert.ok(line.trim().length > 0, `${voice}.${ev}: "${line}" is empty`);
        for (const [, name] of line.matchAll(/\{(\w+)\}/g)) assert.ok(known.has(name), `${voice}.${ev}: unknown {${name}} in "${line}"`);
      }
    }
  }
  for (const [ev, odds] of Object.entries(BARK_ODDS)) assert.ok(odds > 0 && odds <= 1, `${ev} odds ${odds}`);
});

// ---------------------------------------------------------------- the rules data

test('rules: every support monster has its spells, and roleOf defaults to archer for ranged and brute for melee', () => {
  for (const [id, d] of Object.entries(MONSTERS)) {
    if (d.role === 'support') assert.ok(d.support, `${id} is a support without spells`);
    if (d.role !== undefined) assert.ok(Object.hasOwn(ROLES, d.role), `${id} has an unknown role ${d.role}`);
  }
  const plain = (over: Partial<MonsterDef>): MonsterDef => ({ ...MONSTERS.orc, ...over });
  assert.equal(roleOf(plain({ range: 1, role: undefined })), 'brute');
  assert.equal(roleOf(plain({ range: 4, role: undefined })), 'archer');
  assert.equal(roleOf(plain({ range: 1, role: 'coward' })), 'coward', 'an explicit role wins');
  assert.equal(roleOf(MONSTERS.archer), 'archer');
  assert.equal(roleOf(MONSTERS.orc), 'brute');
});

test('rules: difficulty: story has no squad; hard is tougher than normal, which is at least as tough as story', () => {
  assert.equal(DIFFICULTIES.story.squad, false);
  assert.equal(DIFFICULTIES.normal.squad, true);
  assert.equal(DIFFICULTIES.hard.squad, true);
  assert.ok(DIFFICULTIES.hard.hp > DIFFICULTIES.normal.hp);
  assert.ok(DIFFICULTIES.normal.hp >= DIFFICULTIES.story.hp);
  assert.deepEqual([...DIFFICULTY_IDS].sort(), ['hard', 'normal', 'story']);
});

test('rules: packs: one for one or two heroes, two for three or four, three for five or six', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => packsFor(n)), [1, 1, 2, 2, 3, 3]);
});

test('rules: isDifficulty accepts the three levels and rejects anything else', () => {
  for (const id of ['story', 'normal', 'hard']) assert.equal(isDifficulty(id), true, id);
  for (const junk of ['nightmare', 'Normal', '', 'toString', 'constructor', '__proto__', null, undefined, 1, {}]) {
    assert.equal(isDifficulty(junk), false, String(junk));
  }
});

test('rules: every act only uses monsters that exist, and each new support appears in its act', () => {
  for (const act of ACTS) {
    const names = [...act.pool, ...act.elites, ...act.minions, act.boss, ...act.encounters.flatMap((e) => e.monsters), ...Object.values(act.escorts).flat(), ...Object.keys(act.escorts)];
    for (const id of names) assert.ok(Object.hasOwn(MONSTERS, id), `${act.name} uses unknown monster ${id}`);
  }
  const supports: [number, string][] = [[0, 'shaman'], [1, 'necromancer'], [2, 'priest']];
  for (const [i, id] of supports) {
    assert.ok(ACTS[i].encounters.some((e) => e.monsters.includes(id)), `${id} is in an encounter of ${ACTS[i].name}`);
    assert.ok(ACTS[i].pool.includes(id), `${id} is in the pool of ${ACTS[i].name}`);
  }
});
