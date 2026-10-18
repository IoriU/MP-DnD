import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeFov, hasLOS } from '../shared/grid.ts';
import { MONSTERS } from '../shared/rules.ts';
import { hitsArea, resolveAim, statsAt, type Element } from '../shared/skills.ts';
import {
  CLOUDS,
  COMBOS,
  EXPLOSION,
  GROUNDS,
  OIL_FIRE_TURNS,
  SHOCK_TURNS,
  aimFieldOps,
  applyField,
  cloneField,
  damageFactor,
  hazardAt,
  hazardsOn,
  immuneToStatus,
  planWalk,
  previewField,
  reactionSummary,
  resistance,
  safePath,
  selfFieldOps,
  tickField,
  tilesAround,
  type CloudId,
  type FieldElement,
  type FieldLike,
  type FieldOp,
  type FieldResult,
  type Ground,
  type GroundId,
  type PropId,
} from '../shared/surfaces.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, Pos } from '../shared/types.ts';
import { recalcHero, startingSkills } from '../server/progression.ts';

// ---------------------------------------------------------------- helpers

/** Parses a map: '#' wall, '.' floor, 'B' oil barrel and 'Z' brazier (props stand on wall tiles). */
function fromRows(rows: string[]): FieldLike {
  const width = rows[0].length;
  const props: FieldLike['props'] = {};
  let tiles = '';
  rows.forEach((row, y) => {
    assert.equal(row.length, width, 'ragged map');
    [...row].forEach((ch, x) => {
      if (ch === 'B' || ch === 'Z') props[y * width + x] = ch === 'B' ? 'barrel' : 'brazier';
      tiles += ch === 'B' || ch === 'Z' ? '#' : ch;
    });
  });
  return { width, height: rows.length, tiles, ground: {}, clouds: {}, props };
}

/** A walled room with open floor inside. */
function open(w = 11, h = 9): FieldLike {
  return fromRows(Array.from({ length: h }, (_, y) => (y === 0 || y === h - 1 ? '#'.repeat(w) : `#${'.'.repeat(w - 2)}#`)));
}

const at = (f: FieldLike, x: number, y: number) => y * f.width + x;
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const area = (f: FieldLike, x: number, y: number, r = 1) => sorted(tilesAround(f, { x, y }, r));

function put(f: FieldLike, x: number, y: number, id: GroundId, turns: number | null = 5, extra: Partial<Ground> = {}) {
  f.ground[at(f, x, y)] = { id, turns, ...extra };
}
function fog(f: FieldLike, x: number, y: number, id: CloudId, turns = 3, extra: { shock?: number; by?: string } = {}) {
  f.clouds[at(f, x, y)] = { id, turns, ...extra };
}
function prop(f: FieldLike, x: number, y: number, id: PropId) {
  const i = at(f, x, y);
  f.tiles = f.tiles.slice(0, i) + '#' + f.tiles.slice(i + 1);
  f.props[i] = id;
}

const run = (f: FieldLike, ops: FieldOp[], by?: string): FieldResult => applyField(f, ops, by);
const touch = (f: FieldLike, element: FieldElement, ...pts: [number, number][]) =>
  run(f, [{ kind: 'touch', tiles: pts.map(([x, y]) => at(f, x, y)), element }]);
const make = (f: FieldLike, id: GroundId, pts: [number, number][], turns?: number, by?: string) =>
  run(f, [{ kind: 'ground', tiles: pts.map(([x, y]) => at(f, x, y)), id, ...(turns ? { turns } : {}) }], by);
const hit = (f: FieldLike, x: number, y: number, element: Element = 'physical') => run(f, [{ kind: 'hit', tile: at(f, x, y), element }]);

const gid = (f: FieldLike, x: number, y: number) => f.ground[at(f, x, y)]?.id;
const cid = (f: FieldLike, x: number, y: number) => f.clouds[at(f, x, y)]?.id;
const kinds = (r: FieldResult) => r.reactions.map((x) => x.kind).sort();
const tilesOf = (r: FieldResult, kind: string) => sorted(r.reactions.find((x) => x.kind === kind)?.tiles ?? []);
const snapshot = (f: FieldLike) => structuredClone({ tiles: f.tiles, ground: f.ground, clouds: f.clouds, props: f.props });

const monster = (type: string, x: number, y: number, extra: Partial<MonsterEntity> = {}): MonsterEntity => ({
  id: `${type}-${x}-${y}`, kind: 'monster', type, name: MONSTERS[type].name, glyph: '', x, y, hp: MONSTERS[type].hp, maxHp: MONSTERS[type].hp,
  ac: MONSTERS[type].ac, speed: 6, statuses: [], boss: false, elite: false, dmgBy: {}, facing: { x: -1, y: 0 }, ...extra,
});

function hero(classId: ClassId, x: number, y: number, extra: Partial<PlayerEntity> & { skills?: OwnedSkill[] } = {}): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}-${x}-${y}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x, y,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], level: 1, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], facing: { x: 1, y: 0 },
  };
  recalcHero(p);
  return Object.assign(p, extra);
}

const wet = (e: Entity) => e.statuses.push({ id: 'wet', turns: 2 });
const OPEN_ALL = () => false;

// ---------------------------------------------------------------- the combo table

test('combo: water + fire = a steam cloud, and the water is gone', () => {
  const f = open();
  put(f, 4, 4, 'water');
  const r = touch(f, 'fire', [4, 4]);
  assert.equal(gid(f, 4, 4), undefined);
  assert.equal(cid(f, 4, 4), 'steam');
  assert.equal(f.clouds[at(f, 4, 4)]!.turns, CLOUDS.steam.turns);
  assert.deepEqual(kinds(r), ['steam']);
  assert.deepEqual(r.changed, [at(f, 4, 4)]);
  assert.deepEqual(r.blasts, []);
});

test('combo: water + cold = ice', () => {
  const f = open();
  put(f, 4, 4, 'water');
  const r = touch(f, 'cold', [4, 4]);
  assert.equal(gid(f, 4, 4), 'ice');
  assert.equal(f.ground[at(f, 4, 4)]!.turns, GROUNDS.ice.turns);
  assert.deepEqual(kinds(r), ['freeze']);
  assert.equal(cid(f, 4, 4), undefined, 'no steam from cold');
});

test('combo: water + lightning = electrified water across every connected tile (8-way), not a separate puddle', () => {
  const f = open();
  // A diagonal chain is one puddle (8-way connection); the one at (8,6) is separate.
  for (const [x, y] of [[2, 2], [3, 3], [4, 4], [4, 5]]) put(f, x, y, 'water', 5);
  put(f, 8, 6, 'water', 5);
  put(f, 6, 4, 'water', 5); // two tiles from the chain: not connected either
  const r = touch(f, 'lightning', [2, 2]);
  for (const [x, y] of [[2, 2], [3, 3], [4, 4], [4, 5]]) {
    assert.equal(f.ground[at(f, x, y)]!.shock, SHOCK_TURNS, `(${x},${y}) is electrified`);
    assert.equal(gid(f, x, y), 'water', 'still water');
  }
  assert.equal(f.ground[at(f, 8, 6)]!.shock, undefined, 'a separate puddle is untouched');
  assert.equal(f.ground[at(f, 6, 4)]!.shock, undefined, 'a puddle with a gap is untouched');
  assert.deepEqual(kinds(r), ['electrify']);
  assert.deepEqual(tilesOf(r, 'electrify'), sorted([[2, 2], [3, 3], [4, 4], [4, 5]].map(([x, y]) => at(f, x, y))));
  assert.deepEqual(sorted(r.changed), tilesOf(r, 'electrify'), 'everyone standing in the puddle is affected');
});

test('lightning on water that is already electrified starts nothing new', () => {
  const f = open();
  put(f, 4, 4, 'water', 5, { shock: 1 });
  const r = touch(f, 'lightning', [4, 4]);
  assert.deepEqual(r.reactions, []);
  assert.deepEqual(r.changed, []);
});

test('combo: oil + fire = burning oil (OIL_FIRE_TURNS) that spreads across all connected oil, and no further', () => {
  const f = open();
  for (const [x, y] of [[3, 4], [4, 4], [5, 5]]) put(f, x, y, 'oil', 6); // (4,4)-(5,5) touch diagonally
  put(f, 8, 2, 'oil', 6); // a separate slick
  const r = touch(f, 'fire', [3, 4]);
  for (const [x, y] of [[3, 4], [4, 4], [5, 5]]) {
    assert.equal(gid(f, x, y), 'fire', `(${x},${y}) burns`);
    assert.equal(f.ground[at(f, x, y)]!.turns, OIL_FIRE_TURNS);
  }
  assert.equal(gid(f, 8, 2), 'oil', 'the other slick is fine');
  assert.deepEqual(kinds(r), ['ignite']);
  assert.equal(tilesOf(r, 'ignite').length, 3);
  assert.deepEqual(r.blasts, [], 'oil burns but does not explode');
  assert.ok(OIL_FIRE_TURNS > GROUNDS.fire.turns, 'burning oil outlasts a plain fire');
});

test('combo: oil + water = washed away into water', () => {
  const f = open();
  put(f, 4, 4, 'oil', 6);
  const r = make(f, 'water', [[4, 4]]);
  assert.equal(gid(f, 4, 4), 'water');
  assert.equal(f.ground[at(f, 4, 4)]!.turns, GROUNDS.water.turns);
  assert.deepEqual(kinds(r), ['wash']);
});

test('combo: poison + fire = an explosion over the tile and its open neighbors, plus fire on the tile', () => {
  const f = open();
  put(f, 5, 4, 'poison', 3);
  const r = touch(f, 'fire', [5, 4]);
  assert.equal(gid(f, 5, 4), 'fire');
  assert.equal(f.ground[at(f, 5, 4)]!.turns, GROUNDS.fire.turns);
  assert.deepEqual(kinds(r), ['explode']);
  assert.deepEqual(sorted(r.blasts), area(f, 5, 4), 'blasts = the tile + its 8 neighbors');
  assert.ok(r.changed.includes(at(f, 5, 4)));
});

test('an explosion never reaches into a wall', () => {
  const f = open();
  put(f, 1, 1, 'poison', 3);
  const r = touch(f, 'fire', [1, 1]);
  assert.deepEqual(sorted(r.blasts), sorted([at(f, 1, 1), at(f, 2, 1), at(f, 1, 2), at(f, 2, 2)]));
  for (const i of r.blasts) assert.equal(f.tiles[i], '.', 'only open floor is blasted');
});

test('combo: connected poison explodes together; a separate puddle does not', () => {
  const f = open();
  put(f, 3, 4, 'poison');
  put(f, 4, 4, 'poison');
  put(f, 5, 5, 'poison'); // diagonal to (4,4)
  put(f, 9, 2, 'poison'); // far away
  const r = touch(f, 'fire', [3, 4]);
  for (const [x, y] of [[3, 4], [4, 4], [5, 5]]) assert.equal(gid(f, x, y), 'fire', `(${x},${y}) went up`);
  assert.equal(gid(f, 9, 2), 'poison');
  assert.equal(tilesOf(r, 'explode').length, 3);
  const expected = new Set<number>();
  for (const [x, y] of [[3, 4], [4, 4], [5, 5]]) for (const i of area(f, x, y)) expected.add(i);
  assert.deepEqual(sorted(r.blasts), sorted([...expected]), 'the union of three blasts, each tile once');
  assert.ok(!r.blasts.includes(at(f, 9, 2)));
});

test('combo: poison + water = washed away into water', () => {
  const f = open();
  put(f, 4, 4, 'poison');
  const r = make(f, 'water', [[4, 4]]);
  assert.equal(gid(f, 4, 4), 'water');
  assert.deepEqual(kinds(r), ['wash']);
  assert.deepEqual(r.blasts, []);
});

test('combo: ice + fire = melts into water', () => {
  const f = open();
  put(f, 4, 4, 'ice', 3);
  const r = touch(f, 'fire', [4, 4]);
  assert.equal(gid(f, 4, 4), 'water');
  assert.equal(f.ground[at(f, 4, 4)]!.turns, GROUNDS.water.turns);
  assert.deepEqual(kinds(r), ['melt']);
});

test('combo: fire + cold = put out into water; fire + water = put out into steam', () => {
  const f = open();
  put(f, 3, 4, 'fire', 2);
  put(f, 6, 4, 'fire', 2);
  const cold = touch(f, 'cold', [3, 4]);
  assert.equal(gid(f, 3, 4), 'water');
  assert.equal(cid(f, 3, 4), undefined);
  assert.deepEqual(kinds(cold), ['douse']);
  const wetter = touch(f, 'water', [6, 4]);
  assert.equal(gid(f, 6, 4), undefined);
  assert.equal(cid(f, 6, 4), 'steam');
  assert.deepEqual(kinds(wetter), ['douse']);
});

test('combo: steam + lightning = electrified steam, through all connected steam only', () => {
  const f = open();
  for (const [x, y] of [[4, 4], [5, 4], [6, 5]]) fog(f, x, y, 'steam', 2);
  fog(f, 9, 2, 'steam', 2);
  const r = touch(f, 'lightning', [4, 4]);
  for (const [x, y] of [[4, 4], [5, 4], [6, 5]]) assert.equal(f.clouds[at(f, x, y)]!.shock, SHOCK_TURNS, `(${x},${y})`);
  assert.equal(f.clouds[at(f, 9, 2)]!.shock, undefined);
  assert.deepEqual(kinds(r), ['electrify']);
  assert.equal(tilesOf(r, 'electrify').length, 3);
  assert.deepEqual(sorted(r.changed), sorted([at(f, 4, 4), at(f, 5, 4), at(f, 6, 5)]));
});

test('combo: poison gas + fire = an explosion, and the gas is used up', () => {
  const f = open();
  fog(f, 5, 4, 'gas', 2);
  const r = touch(f, 'fire', [5, 4]);
  assert.equal(cid(f, 5, 4), undefined);
  assert.deepEqual(kinds(r), ['explode']);
  assert.deepEqual(sorted(r.blasts), area(f, 5, 4));
});

test('combo: connected poison gas explodes together; a separate cloud does not', () => {
  const f = open();
  for (const [x, y] of [[3, 4], [4, 4], [5, 5]]) fog(f, x, y, 'gas', 2);
  fog(f, 9, 2, 'gas', 2);
  const r = touch(f, 'fire', [3, 4]);
  for (const [x, y] of [[3, 4], [4, 4], [5, 5]]) assert.equal(cid(f, x, y), undefined, `(${x},${y}) went up`);
  assert.equal(cid(f, 9, 2), 'gas');
  assert.equal(tilesOf(r, 'explode').length, 3);
  assert.ok(!r.blasts.includes(at(f, 9, 2)));
});

test('combo: oil barrel + fire = it explodes: the tile opens up, blasts around it, burning oil around it', () => {
  const f = open();
  prop(f, 5, 4, 'barrel');
  const r = touch(f, 'fire', [5, 4]);
  assert.equal(f.tiles[at(f, 5, 4)], '.', 'the barrel tile becomes floor');
  assert.equal(f.props[at(f, 5, 4)], undefined);
  assert.deepEqual(sorted(r.blasts), area(f, 5, 4));
  for (const i of area(f, 5, 4)) {
    assert.equal(f.ground[i]?.id, 'fire', `tile ${i} burns`);
    assert.equal(f.ground[i]!.turns, OIL_FIRE_TURNS, 'it is burning oil');
  }
  assert.ok(kinds(r).includes('explode') && kinds(r).includes('ignite'));
});

test('a barrel next to a wall blasts only its open neighbors', () => {
  const f = open();
  prop(f, 1, 1, 'barrel');
  const r = touch(f, 'fire', [1, 1]);
  assert.deepEqual(sorted(r.blasts), sorted([at(f, 1, 1), at(f, 2, 1), at(f, 1, 2), at(f, 2, 2)]));
  assert.equal(f.tiles[at(f, 0, 0)], '#');
});

test('exploding barrels set off the barrels next to them', () => {
  const f = open();
  prop(f, 4, 4, 'barrel');
  prop(f, 5, 4, 'barrel');
  prop(f, 9, 6, 'barrel'); // far away: stays
  const r = touch(f, 'fire', [4, 4]);
  assert.equal(f.props[at(f, 4, 4)], undefined);
  assert.equal(f.props[at(f, 5, 4)], undefined, 'the neighbor blew too');
  assert.equal(f.props[at(f, 9, 6)], 'barrel');
  assert.equal(tilesOf(r, 'explode').length, 2);
});

test('barrel + a non-fire hit spills oil around it (and the tile opens up); a fire hit explodes it', () => {
  for (const element of ['physical', 'cold', 'lightning'] as const) {
    const f = open();
    prop(f, 5, 4, 'barrel');
    const r = hit(f, 5, 4, element);
    assert.equal(f.tiles[at(f, 5, 4)], '.', element);
    assert.equal(f.props[at(f, 5, 4)], undefined, element);
    for (const i of area(f, 5, 4)) {
      assert.equal(f.ground[i]?.id, 'oil', `${element}: tile ${i} is oily`);
      assert.equal(f.ground[i]!.turns, GROUNDS.oil.turns);
    }
    assert.deepEqual(kinds(r), ['spill'], element);
    assert.deepEqual(r.blasts, [], 'a spill is not an explosion');
  }
  const f = open();
  prop(f, 5, 4, 'barrel');
  const r = hit(f, 5, 4, 'fire');
  assert.ok(kinds(r).includes('explode'));
  assert.equal(f.props[at(f, 5, 4)], undefined);
  assert.equal(gid(f, 5, 4), 'fire');
});

test('oil spilled from a barrel is the same oil that burns later', () => {
  const f = open();
  prop(f, 5, 4, 'barrel');
  hit(f, 5, 4, 'physical');
  const r = touch(f, 'fire', [4, 3]); // a spark at the edge of the slick
  assert.equal(tilesOf(r, 'ignite').length, 9, 'the whole spill goes up');
  assert.equal(gid(f, 5, 4), 'fire');
});

test('brazier + a hit knocks it over: fire around it, tile opens up; oil nearby catches', () => {
  const f = open();
  prop(f, 5, 4, 'brazier');
  put(f, 8, 4, 'oil', 6);
  put(f, 6, 3, 'oil', 6); // next to the brazier's tile: burns with the coals
  const r = hit(f, 5, 4, 'physical');
  assert.equal(f.tiles[at(f, 5, 4)], '.');
  assert.equal(f.props[at(f, 5, 4)], undefined);
  assert.deepEqual(kinds(r).filter((k) => k !== 'ignite'), ['topple']);
  for (const [x, y] of [[5, 4], [4, 3], [6, 5], [4, 5]]) {
    assert.equal(gid(f, x, y), 'fire', `(${x},${y})`);
    assert.equal(f.ground[at(f, x, y)]!.turns, GROUNDS.fire.turns);
  }
  assert.equal(gid(f, 6, 3), 'fire', 'the oil next to the brazier ignited');
  assert.equal(f.ground[at(f, 6, 3)]!.turns, OIL_FIRE_TURNS);
  assert.equal(gid(f, 8, 4), 'oil', 'not touching: the oil three tiles away is fine');
  assert.deepEqual(r.blasts, []);
});

test('a brazier falls to any kind of hit, and a plain floor tile or an unrelated element does nothing to props', () => {
  for (const element of ['cold', 'lightning', 'fire'] as const) {
    const f = open();
    prop(f, 5, 4, 'brazier');
    hit(f, 5, 4, element);
    assert.equal(f.props[at(f, 5, 4)], undefined, element);
  }
  const f = open();
  prop(f, 5, 4, 'barrel');
  const before = snapshot(f);
  assert.deepEqual(touch(f, 'lightning', [5, 4]).reactions, []);
  assert.deepEqual(touch(f, 'cold', [5, 4]).reactions, []);
  assert.deepEqual(hit(f, 2, 2, 'fire').reactions, [], 'hitting bare floor');
  assert.deepEqual(snapshot(f), before);
});

// ---------------------------------------------------------------- ground and cloud ops

test("'ground' ops: creating fire on oil ignites it; creating water on fire makes steam; creating ice on water freezes it", () => {
  const f = open();
  put(f, 3, 3, 'oil', 6);
  put(f, 4, 3, 'oil', 6);
  const fire = make(f, 'fire', [[3, 3]]);
  assert.equal(gid(f, 3, 3), 'fire');
  assert.equal(gid(f, 4, 3), 'fire', 'it spread');
  assert.equal(f.ground[at(f, 3, 3)]!.turns, OIL_FIRE_TURNS);
  assert.deepEqual(kinds(fire), ['ignite']);

  put(f, 7, 5, 'fire', 2);
  const steam = make(f, 'water', [[7, 5]]);
  assert.equal(gid(f, 7, 5), undefined);
  assert.equal(cid(f, 7, 5), 'steam');
  assert.deepEqual(kinds(steam), ['douse']);

  put(f, 2, 6, 'water', 4);
  const ice = make(f, 'ice', [[2, 6]]);
  assert.equal(gid(f, 2, 6), 'ice');
  assert.deepEqual(kinds(ice), ['freeze']);
});

test("'ground' ops on bare floor create the surface with its default (or the given) duration", () => {
  const f = open();
  for (const id of ['water', 'ice', 'fire', 'oil', 'poison'] as const) {
    make(f, id, [[4, 4]]);
    // clean up so the next creation lands on bare floor
    assert.equal(gid(f, 4, 4), id, id);
    assert.equal(f.ground[at(f, 4, 4)]!.turns, GROUNDS[id].turns, `${id} default turns`);
    delete f.ground[at(f, 4, 4)];
  }
  make(f, 'oil', [[4, 4]], 10);
  assert.equal(f.ground[at(f, 4, 4)]!.turns, 10, 'an explicit duration wins');
  make(f, 'fire', [[6, 6]], 5);
  assert.equal(f.ground[at(f, 6, 6)]!.turns, 5);
  const lava = make(f, 'lava', [[7, 7]]);
  assert.deepEqual(lava.reactions, []);
  assert.equal(f.ground[at(f, 7, 7)]!.turns, null, 'lava is permanent');
});

test("creating a surface that is already there only extends it, never shortens it", () => {
  const f = open();
  put(f, 4, 4, 'oil', 2);
  make(f, 'oil', [[4, 4]], 10);
  assert.equal(f.ground[at(f, 4, 4)]!.turns, 10);
  make(f, 'oil', [[4, 4]], 3);
  assert.equal(f.ground[at(f, 4, 4)]!.turns, 10);
  put(f, 6, 4, 'water', null);
  make(f, 'water', [[6, 4]], 4);
  assert.equal(f.ground[at(f, 6, 4)]!.turns, null, 'permanent stays permanent');
});

test('pouring oil or poison onto a fire sets it off (poison explodes)', () => {
  const f = open();
  put(f, 3, 4, 'fire', 2);
  const oil = make(f, 'oil', [[3, 4]]);
  assert.equal(gid(f, 3, 4), 'fire');
  assert.equal(f.ground[at(f, 3, 4)]!.turns, OIL_FIRE_TURNS);
  assert.deepEqual(kinds(oil), ['ignite']);
  put(f, 7, 4, 'fire', 2);
  const poison = make(f, 'poison', [[7, 4]]);
  assert.ok(kinds(poison).includes('explode'));
  assert.ok(poison.blasts.includes(at(f, 7, 4)));
});

test('lava never changes: nothing sticks to it, nothing puts it out', () => {
  const f = open();
  put(f, 4, 4, 'lava', null);
  const before = snapshot(f);
  for (const id of ['water', 'ice', 'oil', 'poison', 'fire'] as const) make(f, id, [[4, 4]]);
  for (const el of ['fire', 'cold', 'lightning', 'water'] as const) touch(f, el, [4, 4]);
  assert.deepEqual(snapshot(f).ground, before.ground);
  assert.equal(gid(f, 4, 4), 'lava');
});

test('creating on a wall does nothing; neither does a tile outside the room', () => {
  const f = open();
  const before = snapshot(f);
  const wall = at(f, 0, 0);
  const r = run(f, [
    { kind: 'ground', tiles: [wall, at(f, 0, 4), -1, f.width * f.height + 3], id: 'fire' },
    { kind: 'ground', tiles: [wall], id: 'oil' },
    { kind: 'cloud', tiles: [wall, -5], id: 'smoke' },
    { kind: 'touch', tiles: [wall], element: 'lightning' },
  ]);
  assert.deepEqual(r, { reactions: [], changed: [], blasts: [] });
  assert.deepEqual(snapshot(f), before);
  // ...and a prop's tile counts as a wall for surfaces
  prop(f, 5, 4, 'barrel');
  make(f, 'oil', [[5, 4]]);
  assert.equal(f.ground[at(f, 5, 4)], undefined);
});

test("cloud ops: default and explicit durations; gas dropped on fire or lava explodes", () => {
  const f = open();
  run(f, [{ kind: 'cloud', tiles: [at(f, 3, 3), at(f, 4, 3)], id: 'smoke' }, { kind: 'cloud', tiles: [at(f, 6, 3)], id: 'steam', turns: 7 }]);
  assert.equal(f.clouds[at(f, 3, 3)]!.turns, CLOUDS.smoke.turns);
  assert.equal(f.clouds[at(f, 6, 3)]!.turns, 7);
  put(f, 5, 6, 'fire', 2);
  const boom = run(f, [{ kind: 'cloud', tiles: [at(f, 5, 6)], id: 'gas' }]);
  assert.ok(kinds(boom).includes('explode'), 'gas meeting a fire');
  assert.equal(cid(f, 5, 6), undefined);
  put(f, 8, 6, 'lava', null);
  const lava = run(f, [{ kind: 'cloud', tiles: [at(f, 8, 6)], id: 'gas' }]);
  assert.ok(kinds(lava).includes('explode'), 'gas over lava');
  assert.equal(gid(f, 8, 6), 'lava');
});

test('`by` is recorded on whatever a call creates, and carried through reactions', () => {
  const f = open();
  make(f, 'oil', [[4, 4], [5, 4]], undefined, 'hero-1');
  assert.equal(f.ground[at(f, 4, 4)]!.by, 'hero-1');
  assert.equal(f.ground[at(f, 5, 4)]!.by, 'hero-1');

  const g = open();
  put(g, 4, 4, 'oil', 6);
  put(g, 5, 4, 'oil', 6);
  applyField(g, [{ kind: 'touch', tiles: [at(g, 4, 4)], element: 'fire' }], 'hero-2');
  assert.equal(g.ground[at(g, 4, 4)]!.by, 'hero-2');
  assert.equal(g.ground[at(g, 5, 4)]!.by, 'hero-2', 'spread fire is credited too');

  const h = open();
  put(h, 4, 4, 'water');
  put(h, 5, 4, 'water');
  applyField(h, [{ kind: 'touch', tiles: [at(h, 4, 4)], element: 'lightning' }], 'hero-3');
  assert.equal(h.ground[at(h, 5, 4)]!.by, 'hero-3', 'electrified water is credited');

  const i = open();
  const none = make(i, 'fire', [[4, 4]]);
  assert.ok(!('by' in i.ground[at(i, 4, 4)]!), 'no `by` unless somebody is credited');
  assert.deepEqual(none.blasts, []);

  const j = open();
  applyField(j, [{ kind: 'cloud', tiles: [at(j, 4, 4)], id: 'smoke' }], 'hero-4');
  assert.equal(j.clouds[at(j, 4, 4)]!.by, 'hero-4');
});

test('chain reaction: fire on an oil slick touching a poison puddle next to water ignites, explodes and steams in one call', () => {
  const f = open();
  put(f, 2, 4, 'oil', 6);
  put(f, 3, 4, 'oil', 6);
  put(f, 4, 4, 'poison', 3);
  put(f, 5, 4, 'water', 4);
  const r = touch(f, 'fire', [2, 4]);
  assert.deepEqual(kinds(r), ['explode', 'ignite', 'steam']);
  assert.deepEqual(tilesOf(r, 'ignite'), sorted([at(f, 2, 4), at(f, 3, 4)]));
  assert.deepEqual(tilesOf(r, 'explode'), [at(f, 4, 4)]);
  assert.deepEqual(tilesOf(r, 'steam'), [at(f, 5, 4)]);
  assert.equal(gid(f, 2, 4), 'fire');
  assert.equal(gid(f, 3, 4), 'fire');
  assert.equal(gid(f, 4, 4), 'fire');
  assert.equal(gid(f, 5, 4), undefined, 'the water boiled away');
  assert.equal(cid(f, 5, 4), 'steam');
  for (const i of area(f, 4, 4)) assert.ok(r.blasts.includes(i), `blast covers ${i}`);
  assert.ok(r.changed.includes(at(f, 5, 4)));
});

test('an explosion lights the oil around it and sets off neighboring barrels and gas', () => {
  const f = open();
  put(f, 5, 4, 'poison');
  put(f, 6, 3, 'oil', 6);
  prop(f, 4, 5, 'barrel');
  fog(f, 6, 5, 'gas', 2);
  const r = touch(f, 'fire', [5, 4]);
  assert.equal(gid(f, 6, 3), 'fire', 'oil in the blast ignites');
  assert.equal(f.props[at(f, 4, 5)], undefined, 'the barrel blew');
  assert.equal(cid(f, 6, 5), undefined, 'the gas blew');
  assert.ok(tilesOf(r, 'explode').length >= 3);
});

// ---------------------------------------------------------------- rounds

test('tickField: durations drop each round; fire and steam vanish at 0; permanent surfaces stay', () => {
  const f = open();
  put(f, 3, 3, 'fire', 2);
  put(f, 4, 3, 'oil', 6);
  put(f, 5, 3, 'water', null);
  put(f, 6, 3, 'lava', null);
  put(f, 7, 3, 'poison', 1);
  fog(f, 3, 5, 'steam', 2);
  fog(f, 4, 5, 'smoke', 3);
  fog(f, 5, 5, 'gas', 1);

  const first = tickField(f);
  assert.equal(f.ground[at(f, 3, 3)]!.turns, 1);
  assert.equal(f.ground[at(f, 4, 3)]!.turns, 5);
  assert.equal(f.ground[at(f, 5, 3)]!.turns, null);
  assert.equal(gid(f, 7, 3), undefined, 'poison with 1 turn is gone');
  assert.equal(f.clouds[at(f, 3, 5)]!.turns, 1);
  assert.equal(f.clouds[at(f, 4, 5)]!.turns, 2);
  assert.equal(cid(f, 5, 5), undefined, 'gas with 1 turn is gone');
  assert.deepEqual(sorted(first), sorted([at(f, 7, 3), at(f, 5, 5)]), 'only tiles that became something else are reported');

  const second = tickField(f);
  assert.equal(gid(f, 3, 3), undefined, 'the fire went out');
  assert.equal(cid(f, 3, 5), undefined, 'the steam is gone');
  assert.deepEqual(sorted(second), sorted([at(f, 3, 3), at(f, 3, 5)]));
  for (let i = 0; i < 20; i++) tickField(f);
  assert.equal(f.ground[at(f, 5, 3)]!.turns, null, 'puddles stay');
  assert.equal(gid(f, 6, 3), 'lava');
  assert.equal(gid(f, 4, 3), undefined, 'oil dried up eventually');
});

test('tickField: ice melts into water (keeping who made it) when it runs out', () => {
  const f = open();
  put(f, 4, 4, 'ice', 2, { by: 'h1' });
  assert.deepEqual(tickField(f), []);
  assert.equal(gid(f, 4, 4), 'ice');
  const changed = tickField(f);
  assert.deepEqual(changed, [at(f, 4, 4)]);
  assert.equal(gid(f, 4, 4), 'water');
  assert.equal(f.ground[at(f, 4, 4)]!.turns, GROUNDS.water.turns);
  assert.equal(f.ground[at(f, 4, 4)]!.by, 'h1');
});

test('tickField: electricity fades after SHOCK_TURNS, in water and in steam', () => {
  const f = open();
  put(f, 4, 4, 'water', 4);
  fog(f, 6, 4, 'steam', 3);
  touch(f, 'lightning', [4, 4], [6, 4]);
  assert.equal(f.ground[at(f, 4, 4)]!.shock, SHOCK_TURNS);
  assert.equal(f.clouds[at(f, 6, 4)]!.shock, SHOCK_TURNS);
  for (let i = 0; i < SHOCK_TURNS; i++) tickField(f);
  assert.equal(f.ground[at(f, 4, 4)]!.shock, undefined);
  assert.equal(f.clouds[at(f, 6, 4)]!.shock, undefined);
  assert.equal(gid(f, 4, 4), 'water');
  assert.equal(hazardAt(f, at(f, 4, 4)), 0, 'safe again');
  // and the water can be electrified again
  const again = touch(f, 'lightning', [4, 4]);
  assert.deepEqual(kinds(again), ['electrify']);
});

// ---------------------------------------------------------------- previews

test('cloneField gives containers that can be scribbled on without touching the original', () => {
  const f = open();
  put(f, 4, 4, 'oil', 6);
  fog(f, 5, 4, 'steam', 2);
  prop(f, 7, 4, 'barrel');
  const before = snapshot(f);
  const copy = cloneField(f);
  assert.notEqual(copy.ground, f.ground);
  assert.notEqual(copy.clouds, f.clouds);
  assert.notEqual(copy.props, f.props);
  applyField(copy, [{ kind: 'touch', tiles: [at(f, 4, 4), at(f, 7, 4)], element: 'fire' }, { kind: 'touch', tiles: [at(f, 5, 4)], element: 'lightning' }]);
  assert.equal(copy.ground[at(f, 4, 4)]?.id, 'fire');
  assert.equal(copy.props[at(f, 7, 4)], undefined);
  assert.equal(copy.tiles[at(f, 7, 4)], '.');
  assert.deepEqual(snapshot(f), before, 'the original is exactly as it was');
});

test('previewField reports what would happen without changing the battlefield', () => {
  const f = open();
  for (const [x, y] of [[4, 4], [5, 4]]) put(f, x, y, 'oil', 6);
  const onOil = monster('goblin', 4, 4);
  const beside = monster('goblin', 5, 5, { id: 'beside' });
  const drake = monster('drake', 5, 4);
  const downed = hero('wizard', 4, 4, { downed: true, hp: 0 });
  const before = snapshot(f);
  const p = previewField(f, [{ kind: 'touch', tiles: [at(f, 4, 4)], element: 'fire' }], [onOil, beside, drake, downed]);
  assert.deepEqual(snapshot(f), before);
  assert.notEqual(p.field, f);
  assert.equal(p.field.ground[at(f, 4, 4)]?.id, 'fire', 'the preview shows the burning oil');
  assert.deepEqual(kinds(p.result), ['ignite']);
  assert.deepEqual(p.exposed.map((e) => e.id), [onOil.id], 'the goblin on the oil is exposed; the one beside it, the fire-proof drake and a downed hero are not');
  assert.deepEqual(p.blasted, []);
});

test('previewField lists who is caught in an explosion', () => {
  const f = open();
  put(f, 5, 4, 'poison');
  const onIt = monster('goblin', 5, 4, { id: 'on' });
  const next = monster('goblin', 6, 5, { id: 'next' });
  const far = monster('goblin', 9, 4, { id: 'far' });
  const down = hero('fighter', 4, 3, { downed: true });
  const dead = hero('rogue', 6, 3, { dead: true });
  const p = previewField(f, [{ kind: 'touch', tiles: [at(f, 5, 4)], element: 'fire' }], [onIt, next, far, down, dead]);
  assert.deepEqual(p.blasted.map((e) => e.id).sort(), ['next', 'on']);
  assert.deepEqual(p.exposed.map((e) => e.id), ['on'], 'only the one standing in the new fire is "exposed" on top of that');
  assert.deepEqual(sorted(p.result.blasts), area(f, 5, 4));
});

// ---------------------------------------------------------------- hazards, paths and sight

test('hazardAt: 0 on safe tiles, positive on fire, poison, lava, electrified water and gas', () => {
  const f = open();
  put(f, 2, 2, 'fire');
  put(f, 3, 2, 'poison');
  put(f, 4, 2, 'lava', null);
  put(f, 5, 2, 'water', 4, { shock: 1 });
  fog(f, 6, 2, 'gas');
  fog(f, 7, 2, 'steam', 2, { shock: 1 });
  put(f, 2, 4, 'water');
  put(f, 3, 4, 'oil');
  put(f, 4, 4, 'ice');
  fog(f, 5, 4, 'smoke');
  fog(f, 6, 4, 'steam');
  for (const x of [2, 3, 4, 5, 6, 7]) assert.ok(hazardAt(f, at(f, x, 2)) > 0, `row 2, x=${x} hurts`);
  assert.equal(hazardAt(f, at(f, 8, 8)), 0, 'bare floor');
  assert.equal(hazardAt(f, at(f, 2, 4)), 0, 'plain water is harmless');
  assert.equal(hazardAt(f, at(f, 3, 4)), 0, 'oil is harmless until lit');
  assert.equal(hazardAt(f, at(f, 5, 4)), 0, 'smoke is harmless');
  assert.equal(hazardAt(f, at(f, 6, 4)), 0, 'plain steam is harmless');
  assert.ok(hazardAt(f, at(f, 4, 4)) > 0, 'ice is slippery (a small hazard)');
  assert.ok(hazardAt(f, at(f, 4, 2)) > hazardAt(f, at(f, 2, 2)), 'lava is worse than a fire');
});

test('hazardAt: fire does not worry a fire-immune creature; poison does not worry the undead', () => {
  const f = open();
  put(f, 2, 2, 'fire');
  put(f, 3, 2, 'lava', null);
  put(f, 4, 2, 'poison');
  fog(f, 5, 2, 'gas');
  const drake = monster('drake', 2, 2);
  const imp = monster('imp', 2, 2);
  const skeleton = monster('skeleton', 2, 2);
  const zombie = monster('zombie', 2, 2);
  const attuned = hero('wizard', 2, 2, { skills: [{ id: 'elemental_affinity', tier: 3, branch: 'B', cd: 0 }] });
  const plain = hero('wizard', 2, 2);
  assert.equal(hazardAt(f, at(f, 2, 2), drake), 0);
  assert.equal(hazardAt(f, at(f, 3, 2), drake), 0, 'lava too');
  assert.equal(hazardAt(f, at(f, 2, 2), imp), 0, 'a fire-eater');
  assert.equal(hazardAt(f, at(f, 2, 2), attuned), 0, 'Attunement: fire on the ground does not hurt');
  assert.ok(hazardAt(f, at(f, 2, 2), plain) > 0);
  assert.ok(hazardAt(f, at(f, 2, 2), zombie) > 0, 'a zombie fears fire');
  assert.ok(hazardAt(f, at(f, 4, 2), drake) > 0, 'the drake does mind poison');
  assert.equal(hazardAt(f, at(f, 4, 2), skeleton), 0);
  assert.equal(hazardAt(f, at(f, 5, 2), zombie), 0, 'and poison gas');
  assert.ok(hazardAt(f, at(f, 4, 2), plain) > 0);
});

test('planWalk goes around fire when the detour fits in the moves, and straight through (reporting the tiles) when it does not', () => {
  const f = fromRows([
    '#########',
    '#.......#',
    '#.#####.#',
    '#.......#',
    '#.#####.#',
    '#.......#',
    '#########',
  ]);
  put(f, 4, 3, 'fire');
  const from = { x: 1, y: 3 };
  const to = { x: 7, y: 3 };
  const fire = at(f, 4, 3);

  const around = planWalk(f, from, to, 12, OPEN_ALL)!;
  assert.ok(around.path.length > 6 && around.path.length <= 12, `detour of ${around.path.length}`);
  assert.deepEqual(around.hazards, []);
  assert.ok(around.path.every((p) => at(f, p.x, p.y) !== fire));
  assert.deepEqual(around.path.at(-1), to);

  const through = planWalk(f, from, to, 9, OPEN_ALL)!;
  assert.equal(through.path.length, 6, 'the straight line');
  assert.deepEqual(through.hazards, [{ x: 4, y: 3 }]);
  assert.deepEqual(through.path.at(-1), to);

  // Too far to get there this turn by either route: head that way the safe way, as far as the moves go.
  const short = planWalk(f, from, to, 4, OPEN_ALL)!;
  assert.equal(short.path.length, 4, 'as far as the moves go');
  assert.deepEqual(short.hazards, []);
  assert.ok(short.path.every((p) => at(f, p.x, p.y) !== fire), 'without wandering into the fire');
  assert.deepEqual(short.path, around.path.slice(0, 4), 'the first leg of the safe route');

  // A drake does not mind: straight through, nothing to report.
  const drake = monster('drake', 1, 3);
  const calm = planWalk(f, from, to, 9, OPEN_ALL, drake)!;
  assert.equal(calm.path.length, 6);
  assert.deepEqual(calm.hazards, []);
});

test('planWalk to a burning tile still goes, avoiding every other hazard on the way', () => {
  const f = open();
  put(f, 5, 4, 'fire');
  put(f, 8, 4, 'fire');
  const plan = planWalk(f, { x: 2, y: 4 }, { x: 8, y: 4 }, 10, OPEN_ALL)!;
  assert.deepEqual(plan.path.at(-1), { x: 8, y: 4 });
  assert.deepEqual(plan.hazards, [{ x: 8, y: 4 }], 'only the destination');
  assert.ok(plan.path.every((p) => !(p.x === 5 && p.y === 4)));
});

test('planWalk respects blockers and returns null when there is no way', () => {
  const f = open();
  assert.equal(planWalk(f, { x: 2, y: 4 }, { x: 0, y: 0 }, 10, OPEN_ALL), null, 'into a wall');
  const blocked = planWalk(f, { x: 2, y: 4 }, { x: 4, y: 4 }, 10, (x, y) => x === 3 && y === 4)!;
  assert.equal(blocked.path.length, 2, 'around the creature in the way');
  assert.ok(blocked.path.every((p) => !(p.x === 3 && p.y === 4)));
  const walled = fromRows(['#####', '#.#.#', '#####']);
  assert.equal(planWalk(walled, { x: 1, y: 1 }, { x: 3, y: 1 }, 10, OPEN_ALL), null, 'no route');
});

test('safePath and hazardsOn: around hazards, or nothing if the hazard blocks the only way', () => {
  const corridor = fromRows(['#######', '#.....#', '#######']);
  put(corridor, 3, 1, 'fire');
  const goal = (x: number, y: number) => x === 5 && y === 1;
  assert.equal(safePath(corridor, { x: 1, y: 1 }, OPEN_ALL, goal), null, 'the fire plugs the corridor');
  assert.ok(safePath(corridor, { x: 1, y: 1 }, OPEN_ALL, goal, monster('drake', 1, 1)), 'a drake walks right through');
  const f = open();
  put(f, 4, 4, 'poison');
  const detour = safePath(f, { x: 2, y: 4 }, OPEN_ALL, (x, y) => x === 6 && y === 4)!;
  assert.ok(detour.length >= 4 && detour.every((p) => !(p.x === 4 && p.y === 4)));
  assert.deepEqual(hazardsOn(f, [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }]), [{ x: 4, y: 4 }]);
});

test('hasLOS is blocked by smoke or steam anywhere on the line, but never between adjacent tiles', () => {
  const f = open();
  const a = { x: 1, y: 4 };
  const b = { x: 9, y: 4 };
  assert.ok(hasLOS(f, a, b), 'clear room');
  fog(f, 5, 4, 'smoke');
  assert.ok(!hasLOS(f, a, b), 'smoke in the middle');
  assert.ok(!hasLOS(f, b, a), 'symmetric');
  delete f.clouds[at(f, 5, 4)];
  fog(f, 5, 4, 'steam');
  assert.ok(!hasLOS(f, a, b), 'steam too');
  delete f.clouds[at(f, 5, 4)];
  fog(f, 5, 4, 'gas');
  assert.ok(hasLOS(f, a, b), 'poison gas is see-through');
  delete f.clouds[at(f, 5, 4)];
  fog(f, 5, 1, 'smoke');
  assert.ok(hasLOS(f, a, b), 'smoke off to the side does not matter');
  delete f.clouds[at(f, 5, 1)];

  fog(f, 9, 4, 'smoke');
  assert.ok(!hasLOS(f, a, b), 'you cannot see into a cloud');
  delete f.clouds[at(f, 9, 4)];
  fog(f, 1, 4, 'smoke');
  assert.ok(!hasLOS(f, a, b), 'or out of one');
  delete f.clouds[at(f, 1, 4)];

  fog(f, 4, 4, 'smoke');
  assert.ok(hasLOS(f, { x: 3, y: 4 }, { x: 4, y: 4 }), 'next to each other you always see');
  assert.ok(hasLOS(f, { x: 3, y: 3 }, { x: 4, y: 4 }), 'diagonally adjacent too');
  assert.ok(hasLOS(f, { x: 4, y: 4 }, { x: 4, y: 4 }), 'and yourself');
  assert.ok(!hasLOS(f, { x: 3, y: 4 }, { x: 5, y: 4 }), 'but two tiles with smoke between them: no');
});

test('computeFov: smoke hides the tiles in it and behind it', () => {
  const f = open();
  const origin = { x: 1, y: 4 };
  const clear = computeFov(f, [origin], 7);
  assert.ok(clear.has(at(f, 6, 4)));
  fog(f, 4, 4, 'smoke');
  const fogged = computeFov(f, [origin], 7);
  assert.ok(fogged.has(at(f, 3, 4)), 'in front of the smoke');
  assert.ok(!fogged.has(at(f, 4, 4)), 'the smoke itself');
  assert.ok(!fogged.has(at(f, 6, 4)), 'behind the smoke');
  assert.ok(fogged.has(at(f, 6, 1)), 'off to the side');
});

test('tilesAround: open tiles (and props) within a radius, clipped to the room', () => {
  const f = open();
  assert.deepEqual(area(f, 5, 4, 0), [at(f, 5, 4)]);
  assert.equal(area(f, 5, 4, 1).length, 9);
  assert.equal(area(f, 5, 4, 2).length, 25);
  assert.equal(area(f, 1, 1, 1).length, 4, 'a corner: walls are not tiles');
  assert.equal(area(f, 0, 0, 1).length, 1, 'a wall center still has its one open neighbor');
  const edge = tilesAround(f, { x: 9, y: 7 }, 3);
  assert.ok(edge.every((i) => f.tiles[i] === '.'));
  prop(f, 6, 4, 'barrel');
  assert.ok(tilesAround(f, { x: 5, y: 4 }, 1).includes(at(f, 6, 4)), 'a prop is part of the area so fire can set it off');
  const wall = fromRows(['#####', '#.#.#', '#####']);
  assert.ok(!tilesAround(wall, { x: 2, y: 1 }, 1).includes(at(wall, 2, 1)), 'a plain wall is not');
});

// ---------------------------------------------------------------- creatures and elements

test('resistance and damageFactor: drake, imp, skeleton, zombie, and Wet', () => {
  const drake = monster('drake', 1, 1);
  assert.equal(resistance(drake, 'fire'), 'immune');
  assert.equal(damageFactor(drake, 'fire'), 0);
  assert.equal(damageFactor(drake, 'cold'), 1);
  assert.equal(damageFactor(drake, 'physical'), 1);

  const imp = monster('imp', 1, 1);
  assert.equal(resistance(imp, 'fire'), 'absorb');
  assert.equal(damageFactor(imp, 'fire'), -1, 'it heals');
  assert.equal(damageFactor(imp, 'cold'), 2, 'weak to cold');
  assert.equal(damageFactor(imp, 'lightning'), 1);

  const skeleton = monster('skeleton', 1, 1);
  assert.equal(damageFactor(skeleton, 'poison'), 0);
  assert.equal(damageFactor(skeleton, 'fire'), 1);

  const zombie = monster('zombie', 1, 1);
  assert.equal(damageFactor(zombie, 'fire'), 2, 'zombies burn');
  assert.equal(damageFactor(zombie, 'poison'), 0);

  const cultist = monster('cultist', 1, 1);
  assert.equal(damageFactor(cultist, 'fire'), 0.5);

  const goblin = monster('goblin', 1, 1);
  assert.equal(resistance(goblin, 'fire'), null);
  assert.equal(damageFactor(goblin, 'fire'), 1);
  wet(goblin);
  assert.equal(damageFactor(goblin, 'fire'), 0.5, 'Wet halves fire');
  assert.equal(damageFactor(goblin, 'cold'), 1, 'but only fire');
  assert.equal(damageFactor(goblin, 'lightning'), 1);

  const wetCultist = monster('cultist', 1, 1);
  wet(wetCultist);
  assert.equal(damageFactor(wetCultist, 'fire'), 0.25, 'resist and Wet stack');
  const wetImp = monster('imp', 1, 1);
  wet(wetImp);
  assert.equal(damageFactor(wetImp, 'fire'), -1, 'still heals');
  const wetDrake = monster('drake', 1, 1);
  wet(wetDrake);
  assert.equal(damageFactor(wetDrake, 'fire'), 0);
  const wetZombie = monster('zombie', 1, 1);
  wet(wetZombie);
  assert.equal(damageFactor(wetZombie, 'fire'), 1, 'weak (x2) and Wet (x0.5) cancel');
});

test('heroes: no resistances by default; Attunement (Elemental Affinity III-B) resists fire and is not set alight', () => {
  const plain = hero('wizard', 1, 1);
  assert.equal(resistance(plain, 'fire'), null);
  assert.equal(damageFactor(plain, 'fire'), 1);
  assert.equal(damageFactor(plain, 'poison'), 1);
  wet(plain);
  assert.equal(damageFactor(plain, 'fire'), 0.5);

  for (const [tier, branch] of [[1, undefined], [2, undefined], [3, 'A']] as const) {
    const w = hero('wizard', 1, 1, { skills: [{ id: 'elemental_affinity', tier, branch, cd: 0 }] });
    assert.equal(damageFactor(w, 'fire'), 1, `tier ${tier}${branch ?? ''} is not Attunement`);
    assert.equal(immuneToStatus(w, 'burning'), false);
  }
  const attuned = hero('wizard', 1, 1, { skills: [{ id: 'elemental_affinity', tier: 3, branch: 'B', cd: 0 }] });
  assert.equal(resistance(attuned, 'fire'), 'resist');
  assert.equal(damageFactor(attuned, 'fire'), 0.5);
  assert.equal(damageFactor(attuned, 'cold'), 1);
  assert.equal(immuneToStatus(attuned, 'burning'), true);
  wet(attuned);
  assert.equal(damageFactor(attuned, 'fire'), 0.25);
});

test('immuneToStatus: Burning for the fire-proof, Poisoned for the undead, nothing else', () => {
  const goblin = monster('goblin', 1, 1);
  assert.equal(immuneToStatus(monster('drake', 1, 1), 'burning'), true);
  assert.equal(immuneToStatus(monster('imp', 1, 1), 'burning'), true, 'fire heals an imp, it cannot burn');
  assert.equal(immuneToStatus(monster('zombie', 1, 1), 'burning'), false);
  assert.equal(immuneToStatus(monster('cultist', 1, 1), 'burning'), false, 'resist is not immune');
  assert.equal(immuneToStatus(goblin, 'burning'), false);
  assert.equal(immuneToStatus(monster('skeleton', 1, 1), 'poisoned'), true);
  assert.equal(immuneToStatus(monster('bloated', 1, 1), 'poisoned'), true);
  assert.equal(immuneToStatus(monster('spider', 1, 1), 'poisoned'), false, 'a spider only resists');
  assert.equal(immuneToStatus(goblin, 'poisoned'), false);
  for (const id of ['stunned', 'wet', 'frozen', 'shocked', 'chilled'] as const) assert.equal(immuneToStatus(monster('drake', 1, 1), id), false, id);
});

// ---------------------------------------------------------------- skills on the field

const wizardAt = (x = 2, y = 4) => hero('wizard', x, y);

function aim(f: FieldLike, skill: ReturnType<typeof statsAt>, caster: PlayerEntity, target: string | Pos | null, entities: Entity[]) {
  const res = resolveAim(skill, caster, target, { map: f, entities: [caster, ...entities], inCombat: true });
  assert.ok(typeof res === 'object', `aim failed: ${res}`);
  return res;
}

test('aimFieldOps: Fire Bolt at a monster touches its tile with fire; Splitting Bolt touches both targets', () => {
  const f = open();
  const w = wizardAt();
  const g1 = monster('goblin', 6, 4);
  const g2 = monster('goblin', 6, 5);
  const bolt = statsAt('fire_bolt');
  assert.deepEqual(aimFieldOps(bolt, w, aim(f, bolt, w, g1.id, [g1, g2]), f), [{ kind: 'touch', tiles: [at(f, 6, 4)], element: 'fire' }]);
  const split = statsAt('fire_bolt', 3, 'B');
  const ops = aimFieldOps(split, w, aim(f, split, w, g1.id, [g1, g2]), f);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].kind === 'touch' && sorted(ops[0].tiles), sorted([at(f, 6, 4), at(f, 6, 5)]));
});

test('aimFieldOps: Inferno (Fire Bolt III-A) touches the target and leaves fire on its tile', () => {
  const f = open();
  const w = wizardAt();
  const g = monster('goblin', 6, 4);
  const inferno = statsAt('fire_bolt', 3, 'A');
  const ops = aimFieldOps(inferno, w, aim(f, inferno, w, g.id, [g]), f);
  assert.deepEqual(ops, [
    { kind: 'touch', tiles: [at(f, 6, 4)], element: 'fire' },
    { kind: 'ground', tiles: [at(f, 6, 4)], id: 'fire' },
  ]);
});

test('aimFieldOps: Fireball touches every tile in its radius (walls excluded); Meteor also leaves fire there', () => {
  const f = open();
  const w = wizardAt();
  const ball = statsAt('fireball');
  const small = aimFieldOps(ball, w, aim(f, ball, w, { x: 6, y: 4 }, []), f);
  assert.equal(small.length, 1);
  assert.equal(small[0].kind === 'touch' && small[0].element, 'fire');
  assert.deepEqual(small[0].kind === 'touch' && sorted(small[0].tiles), area(f, 6, 4, 1));
  const big = statsAt('fireball', 2);
  const bigOps = aimFieldOps(big, w, aim(f, big, w, { x: 6, y: 4 }, []), f);
  assert.equal(bigOps.length, 1);
  assert.deepEqual(bigOps[0].kind === 'touch' && sorted(bigOps[0].tiles), area(f, 6, 4, 2), 'tier II has radius 2');
  const edge = aimFieldOps(ball, w, aim(f, ball, w, { x: 1, y: 1 }, []), f);
  assert.equal(edge[0].kind === 'touch' && edge[0].tiles.length, 4, 'next to the corner: only floor tiles');
  const meteor = statsAt('fireball', 3, 'A');
  const m = aimFieldOps(meteor, w, aim(f, meteor, w, { x: 6, y: 4 }, []), f);
  assert.equal(m.length, 2);
  assert.equal(m[0].kind, 'touch');
  assert.equal(m[1].kind, 'ground');
  assert.deepEqual(m[1].kind === 'ground' && [m[1].id, sorted(m[1].tiles)], ['fire', area(f, 6, 4, 2)]);
});

test('aimFieldOps: Fireball on a barrel in its radius touches the barrel too (so it blows)', () => {
  const f = open();
  prop(f, 7, 4, 'barrel');
  const w = wizardAt();
  const ball = statsAt('fireball');
  const ops = aimFieldOps(ball, w, aim(f, ball, w, { x: 6, y: 4 }, []), f);
  assert.ok(ops[0].kind === 'touch' && ops[0].tiles.includes(at(f, 7, 4)));
  applyField(f, ops);
  assert.equal(f.props[at(f, 7, 4)], undefined);
});

test('aimFieldOps: Grease leaves oil over the area and touches nothing; Slick lasts longer', () => {
  const f = open();
  const w = wizardAt();
  const grease = statsAt('grease');
  assert.deepEqual(aimFieldOps(grease, w, aim(f, grease, w, { x: 6, y: 4 }, []), f), [{ kind: 'ground', tiles: area(f, 6, 4, 1), id: 'oil' }]);
  const wide = statsAt('grease', 2);
  const wideOps = aimFieldOps(wide, w, aim(f, wide, w, { x: 6, y: 4 }, []), f);
  assert.equal(wideOps.length, 1);
  assert.equal(wideOps[0].kind === 'ground' && wideOps[0].tiles.length, 25);
  const slick = statsAt('grease', 3, 'B');
  const slickOps = aimFieldOps(slick, w, aim(f, slick, w, { x: 6, y: 4 }, []), f);
  assert.equal(slickOps[0].kind === 'ground' && slickOps[0].turns, 10);
  applyField(f, aimFieldOps(grease, w, aim(f, grease, w, { x: 6, y: 4 }, []), f));
  assert.equal(gid(f, 6, 4), 'oil');
  assert.equal(f.ground[at(f, 6, 4)]!.turns, GROUNDS.oil.turns);
});

test('aimFieldOps: Create Water, Ray of Frost, Glacial Ray, Thunderclap and the elements that do nothing to the field', () => {
  const f = open();
  const w = wizardAt();
  const cleric = hero('cleric', 2, 4);
  const g = monster('goblin', 6, 4);

  const water = statsAt('create_water');
  assert.deepEqual(aimFieldOps(water, cleric, aim(f, water, cleric, { x: 6, y: 4 }, []), f), [{ kind: 'ground', tiles: area(f, 6, 4, 1), id: 'water' }]);
  const downpour = statsAt('create_water', 3, 'A');
  const dp = aimFieldOps(downpour, cleric, aim(f, downpour, cleric, { x: 6, y: 4 }, []), f);
  assert.equal(dp[0].kind === 'ground' && dp[0].tiles.length, 49, 'Downpour has radius 3');

  const frost = statsAt('ray_of_frost');
  assert.deepEqual(aimFieldOps(frost, w, aim(f, frost, w, g.id, [g]), f), [{ kind: 'touch', tiles: [at(f, 6, 4)], element: 'cold' }]);
  const glacial = statsAt('ray_of_frost', 3, 'B');
  const gl = aimFieldOps(glacial, w, aim(f, glacial, w, g.id, [g]), f);
  assert.equal(gl.length, 2);
  assert.deepEqual(gl[1].kind === 'ground' && [gl[1].id, sorted(gl[1].tiles)], ['ice', area(f, 6, 4, 1)], 'ice around the target');
  const deep = statsAt('ray_of_frost', 3, 'A');
  assert.equal(aimFieldOps(deep, w, aim(f, deep, w, g.id, [g]), f).length, 1, 'Deep Freeze only touches');

  const grasp = statsAt('shocking_grasp');
  const adj = monster('goblin', 3, 4);
  assert.deepEqual(aimFieldOps(grasp, w, aim(f, grasp, w, adj.id, [adj]), f), [{ kind: 'touch', tiles: [at(f, 3, 4)], element: 'lightning' }]);
  const clap = statsAt('shocking_grasp', 3, 'A');
  const ops = aimFieldOps(clap, w, aim(f, clap, w, null, [adj]), f);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].kind === 'touch' && [ops[0].element, sorted(ops[0].tiles)], ['lightning', sorted(area(f, 2, 4, 1).filter((i) => i !== at(f, 2, 4)))], 'around you, not on your own tile');

  for (const id of ['magic_missile', 'sacred_flame', 'longsword', 'dagger'] as const) {
    const s = statsAt(id);
    const caster = id === 'sacred_flame' ? cleric : w;
    const target = id === 'longsword' ? monster('goblin', 3, 4) : g;
    assert.deepEqual(aimFieldOps(s, caster, aim(f, s, caster, target.id, [target]), f), [], `${id} does nothing to the battlefield`);
  }
});

test('aimFieldOps: attacking a barrel is a hit op with the skill element', () => {
  const f = open();
  prop(f, 6, 4, 'barrel');
  const w = wizardAt();
  const barrel = at(f, 6, 4);
  const bolt = statsAt('fire_bolt');
  const res = aim(f, bolt, w, { x: 6, y: 4 }, []);
  assert.equal(res.prop, barrel);
  assert.deepEqual(res.foes, []);
  const from = (p: { x: number; y: number }) => at(f, p.x, p.y); // the attacker's tile: a toppled brazier spares it
  assert.deepEqual(aimFieldOps(bolt, w, res, f), [{ kind: 'hit', tile: barrel, element: 'fire', from: from(w) }]);
  const dagger = statsAt('dagger');
  const near = wizardAt(4, 4);
  assert.deepEqual(aimFieldOps(dagger, near, aim(f, dagger, near, { x: 6, y: 4 }, []), f), [{ kind: 'hit', tile: barrel, element: 'physical', from: from(near) }]);
  const frost = statsAt('ray_of_frost');
  assert.deepEqual(aimFieldOps(frost, w, aim(f, frost, w, { x: 6, y: 4 }, []), f), [{ kind: 'hit', tile: barrel, element: 'cold', from: from(w) }]);
  const inferno = statsAt('fire_bolt', 3, 'A');
  const ops = aimFieldOps(inferno, w, aim(f, inferno, w, { x: 6, y: 4 }, []), f);
  assert.deepEqual(ops[0], { kind: 'hit', tile: barrel, element: 'fire', from: from(w) });
  assert.equal(ops[1].kind, 'ground', 'its surface goes where the barrel was');
  // run it: the barrel explodes and the floor burns
  applyField(f, aimFieldOps(bolt, w, res, f));
  assert.equal(f.props[barrel], undefined);
  assert.equal(f.tiles[barrel], '.');
});

test('resolveAim: props can be aimed at with attacks, saves and auto-hits, in combat, in range and sight, but not shoved or teleported to', () => {
  const f = open();
  prop(f, 7, 4, 'brazier');
  const w = wizardAt();
  const ctx = (inCombat = true) => ({ map: f, entities: [w], inCombat });
  const tile = { x: 7, y: 4 };
  const fire = resolveAim(statsAt('fire_bolt'), w, tile, ctx());
  assert.ok(typeof fire === 'object' && fire.prop === at(f, 7, 4) && fire.main === undefined && fire.foes.length === 0);
  assert.ok(typeof resolveAim(statsAt('magic_missile'), w, tile, ctx()) === 'object', 'auto-hit');
  assert.match(resolveAim(statsAt('fire_bolt'), w, { x: 5, y: 4 }, ctx()) as string, /Pick a target/, 'bare floor is not a target');
  assert.match(resolveAim(statsAt('dagger'), w, tile, ctx()) as string, /Out of range/, 'a dagger reaches 4 tiles');
  assert.match(resolveAim(statsAt('fire_bolt'), w, tile, ctx(false)) as string, /combat/);
  assert.match(resolveAim(statsAt('shove'), w, tile, ctx()) as string, /Pick a target/, 'no shoving a brazier');
  assert.match(resolveAim(statsAt('shadow_step'), w, tile, ctx()) as string, /Pick a target/, 'no teleporting to one');
  assert.match(resolveAim(statsAt('feint'), w, tile, ctx()) as string, /Pick a target/, 'no roll, no smashing');
  fog(f, 4, 4, 'smoke');
  assert.match(resolveAim(statsAt('fire_bolt'), w, tile, ctx()) as string, /line of sight/, 'smoke in the way');
});

test('resolveAim: an area spell may be centered on a prop but not on a plain wall', () => {
  const f = open();
  prop(f, 6, 4, 'barrel');
  const w = wizardAt();
  const ball = statsAt('fireball');
  const ctx = { map: f, entities: [w], inCombat: true };
  assert.ok(typeof resolveAim(ball, w, { x: 6, y: 4 }, ctx) === 'object');
  assert.match(resolveAim(ball, w, { x: 0, y: 4 }, ctx) as string, /open spot|room/);
});

test('resolveAim: area attacks catch heroes in the blast (friendly fire), but not the downed, the far or a spell that only makes a surface', () => {
  const f = open();
  const w = wizardAt(2, 4);
  const near = hero('fighter', 7, 4);
  const far = hero('rogue', 9, 4);
  const downed = hero('cleric', 6, 5, { downed: true });
  const g = monster('goblin', 6, 4);
  const entities = [w, near, far, downed, g];
  const ctx = { map: f, entities, inCombat: true };
  const ball = resolveAim(statsAt('fireball'), w, { x: 6, y: 4 }, ctx);
  assert.ok(typeof ball === 'object');
  assert.deepEqual(ball.caught?.map((h) => h.id), [near.id]);
  assert.deepEqual(ball.foes.map((m) => m.id), [g.id]);
  assert.equal(hitsArea(statsAt('fireball')), true);

  const grease = resolveAim(statsAt('grease'), w, { x: 6, y: 4 }, ctx);
  assert.ok(typeof grease === 'object');
  assert.deepEqual(grease.caught, [], 'plain Grease hurts nobody');
  assert.equal(hitsArea(statsAt('grease')), false);
  const slick = statsAt('grease', 3, 'B');
  assert.equal(hitsArea(slick), true, 'Slick dazes, so it hits heroes in it');
  assert.equal((resolveAim(slick, w, { x: 6, y: 4 }, ctx) as { caught: PlayerEntity[] }).caught.length, 1);
  assert.equal(hitsArea(statsAt('create_water')), false);
  assert.equal(hitsArea(statsAt('create_water', 3, 'B')), true, 'Tidal Wave pushes');

  // The caster is in the blast too when the center is within the radius of them.
  const closeBy = resolveAim(statsAt('fireball'), w, { x: 3, y: 4 }, { ...ctx, entities: [w] });
  assert.ok(typeof closeBy === 'object' && closeBy.caught?.[0] === w);
  // Single-target skills never have friendly fire.
  const bolt = resolveAim(statsAt('fire_bolt'), w, g.id, ctx);
  assert.ok(typeof bolt === 'object' && bolt.caught === undefined);
});

test('selfFieldOps: Smoke Bomb leaves smoke around you (not around the target); other skills leave nothing', () => {
  const f = open();
  const rogue = hero('rogue', 5, 4);
  const bomb = statsAt('shadow_step', 3, 'B');
  const ops = selfFieldOps(bomb, rogue, f);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].kind === 'cloud' && [ops[0].id, sorted(ops[0].tiles)], ['smoke', area(f, 5, 4, 1)]);
  const g = monster('goblin', 8, 4);
  assert.deepEqual(aimFieldOps(bomb, rogue, aim(f, bomb, rogue, g.id, [g]), f), [], 'nothing on the target');
  assert.deepEqual(selfFieldOps(statsAt('fire_bolt', 3, 'A'), rogue, f), []);
  assert.deepEqual(selfFieldOps(statsAt('shadow_step'), rogue, f), []);
  applyField(f, ops);
  assert.equal(cid(f, 5, 4), 'smoke');
  assert.equal(f.clouds[at(f, 5, 4)]!.turns, CLOUDS.smoke.turns);
  assert.ok(!hasLOS(f, { x: 1, y: 4 }, { x: 9, y: 4 }), 'it blocks sight');
});

// ---------------------------------------------------------------- data

test('the rules as data: every surface is described, the numbers the plan names hold', () => {
  for (const [id, info] of Object.entries(GROUNDS)) {
    assert.ok(info.name && info.icon && info.desc && /^#[0-9a-f]{6}$/i.test(info.color), id);
    assert.ok(Number.isInteger(info.turns) && info.turns >= 0, id);
  }
  for (const [id, info] of Object.entries(CLOUDS)) {
    assert.ok(info.name && info.icon && info.desc && info.turns > 0, id);
  }
  assert.deepEqual(EXPLOSION, { n: 2, d: 6 });
  assert.equal(SHOCK_TURNS, 1);
  assert.equal(GROUNDS.lava.turns, 0, 'never made by skills');
  assert.ok(COMBOS.length >= 8, 'the rules screen lists the table');
  for (const row of COMBOS) assert.ok(Object.keys(row).length >= 2, row.on);
});

test('reactionSummary: one line per reaction, with a tile count when it is more than one', () => {
  const f = open();
  put(f, 3, 4, 'water');
  put(f, 4, 4, 'water');
  put(f, 5, 4, 'water');
  assert.deepEqual(reactionSummary(touch(f, 'lightning', [3, 4])), ['⚡ Electrified! (3 tiles)']);
  const g = open();
  put(g, 3, 4, 'ice');
  assert.deepEqual(reactionSummary(touch(g, 'fire', [3, 4])), ['💧 Melted!']);
  assert.deepEqual(reactionSummary({ reactions: [], changed: [], blasts: [] }), []);
});
