import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { makeRng, rng } from '../server/rng.ts';
import { generateRoom, pickDeployment, type Deployment, type Plan, type RoomLayout } from '../server/room.ts';
import { LOW_COVER, canStep, dist, hasLOS, isBlocked, isWall, reachable, type MapLike } from '../shared/grid.ts';
import { FULL_COVER, HALF_COVER, MONSTERS } from '../shared/rules.ts';
import { heroDc, statsAt } from '../shared/skills.ts';
import type { PropId, PropMap } from '../shared/surfaces.ts';
import { coverFrom, coverWord } from '../shared/tactics.ts';
import type { ClassId, MonsterEntity, PlayerEntity, PlayerInfo, Pos } from '../shared/types.ts';

// Battlefield (2026-10-19 playtest): every fight room is walled and connected, low cover (o) stops steps but not sight, and
// where everyone starts depends on how the fight began (the line, scattered, pincer, surrounded or their camp). Cover adds to
// AC on attacks (a wall +5, low cover +2, nothing when you come round the side) and to DEX saves from the blast's origin.
// Room generation and the grid helpers are called directly; attacks, saves and the start of a fight run through the real Game
// class (private members reached with `any`, as in tests/revive.test.ts). Dice are fixed by stubbing Math.random, and the room
// rng (server/rng.ts) is seeded per test so every run builds the same rooms.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-battlefield-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const KINDS = ['combat', 'elite', 'boss'] as const;
// Since playtest 1 (2026-10-21) rooms are bigger and shaped; the fight starts in an old-size engagement zone.
const SIZE: Record<(typeof KINDS)[number], [number, number]> = { combat: [36, 24], elite: [46, 30], boss: [50, 32] };
const DEPLOYMENTS: Deployment[] = ['line', 'scattered', 'pincer', 'surrounded', 'camp'];
const ALL_PLANS: Plan[] = ['rocks', 'pillars', 'chokepoint', 'halls', 'ruins', 'cavern', 'chambers'];
const ACTS = [1, 2, 3];
const SEEDS = 40;

const floor = (room: RoomLayout, x: number, y: number) => room.tiles[y * room.width + x] === '.';

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

/** Runs fn with the shared room rng (what generateRoom and startRoom use) seeded, so the rooms are the same every run. */
function seeded<T>(seed: number, fn: () => T): T {
  const real = { next: rng.next, int: rng.int, pick: rng.pick, shuffle: rng.shuffle, chance: rng.chance };
  Object.assign(rng, makeRng(seed));
  try {
    return fn();
  } finally {
    Object.assign(rng, real);
  }
}

/** Heroes in a 12x8 walled room, in combat, at (4,2), (4,3), (4,4), with a rat far away so the fight goes on. */
function battle(classes: ClassId[] = ['fighter', 'paladin', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'FIELD');
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
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, group: [heroes[0].id], acts: { [heroes[0].id]: { moves: 6, ap: 0 } } };
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

/** Sets one tile of the battle room (its string is index = y * width + x). */
function setTile(p: any, x: number, y: number, c: string) {
  const i = y * p.width + x;
  p.tiles = p.tiles.slice(0, i) + c + p.tiles.slice(i + 1);
}

/** Whether the game's log has a line matching re. */
const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));
/** The unit step from a toward b. */
const toward = (a: Pos, b: Pos): Pos => ({ x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) });
/** Whether e is turned to face the way of target (one of the 8 steps). */
const facesTo = (e: { facing?: Pos }, target: Pos, from: Pos) => e.facing?.x === toward(from, target).x && e.facing?.y === toward(from, target).y;

/** A small hand-made map from rows of tiles (all rows the same length). */
const grid = (rows: string[]): MapLike => ({ width: rows[0].length, height: rows.length, tiles: rows.join('') });

/** A 9x9 yard, walled all round. `cells` ('x,y' -> tile) changes tiles; `props` ('x,y' -> prop) puts props on them. */
function yard(cells: Record<string, string>, props: Record<string, PropId> = {}): MapLike & { props: PropMap } {
  const width = 9;
  const height = 9;
  const tiles: string[] = Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    return x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : '.';
  });
  const at = (k: string) => {
    const [x, y] = k.split(',').map(Number);
    return y * width + x;
  };
  for (const [k, c] of Object.entries(cells)) tiles[at(k)] = c;
  const propMap: PropMap = {};
  for (const [k, id] of Object.entries(props)) propMap[at(k)] = id;
  return { width, height, tiles: tiles.join(''), props: propMap };
}

/** Walls on every border, nothing but '#', '.' and low cover, and every open tile reachable from every other. */
function checkShape(room: RoomLayout, where: string) {
  const { width, height, tiles } = room;
  assert.equal(tiles.length, width * height, where);
  assert.match(tiles, /^[#.ov]+$/, where);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) assert.equal(tiles[y * width + x], '#', `${where}: open border at ${x},${y}`);
    }
  }
  const open = [...tiles].filter((t) => t === '.').length;
  const start = tiles.indexOf('.');
  const seen = reachable(room, { x: start % width, y: Math.floor(start / width) }, width * height, () => false);
  assert.equal(seen.size, open, `${where}: ${open - seen.size} open tiles cut off`);
}

/** No monster among the first 8 spawns within 3 tiles of any of the first 6 heroes. */
function checkApart(room: RoomLayout, where: string) {
  for (const e of room.enemySpawns.slice(0, 8)) {
    for (const h of room.partySpawns.slice(0, 6)) assert.ok(dist(e, h) > 3, `${where}: monster ${e.x},${e.y} within 3 of hero ${h.x},${h.y}`);
  }
}

// ---------------------------------------------------------------- rooms

test('act 1-3 rooms of every kind and deployment are walled, use only # . o v, and every open tile is reachable', () => {
  for (const act of ACTS) {
    for (const kind of KINDS) {
      for (const dep of DEPLOYMENTS) {
        for (let seed = 0; seed < SEEDS; seed++) {
          const where = `act ${act} ${kind} ${dep} seed ${seed}`;
          const room = generateRoom(kind, makeRng(seed), act, dep);
          assert.deepEqual([room.width, room.height], SIZE[kind], where);
          assert.equal(room.deployment, dep, where);
          checkShape(room, where);
        }
      }
    }
  }
});

test('spawns: unique open tiles off the puddles, 8+ for the party and 10+ for the enemies; a line, a scattered or a pincer keeps monsters 3+ tiles from heroes', () => {
  for (const act of ACTS) {
    for (const kind of KINDS) {
      for (const dep of DEPLOYMENTS) {
        for (let seed = 0; seed < SEEDS; seed++) {
          const where = `act ${act} ${kind} ${dep} seed ${seed}`;
          const room = generateRoom(kind, makeRng(seed), act, dep);
          const spots = [...room.partySpawns, ...room.enemySpawns];
          assert.ok(room.partySpawns.length >= 8, `${where}: ${room.partySpawns.length} party spawns`);
          assert.ok(room.enemySpawns.length >= 10, `${where}: ${room.enemySpawns.length} enemy spawns`);
          assert.equal(new Set(spots.map((p) => p.y * room.width + p.x)).size, spots.length, `${where}: a spawn is used twice`);
          for (const p of spots) {
            assert.ok(floor(room, p.x, p.y), `${where}: spawn ${p.x},${p.y} is not open floor`);
            assert.equal(room.ground[p.y * room.width + p.x], undefined, `${where}: spawn ${p.x},${p.y} is in a puddle`);
          }
          if (kind === 'combat' && (dep === 'line' || dep === 'scattered' || dep === 'pincer')) checkApart(room, where);
        }
      }
    }
  }
});

test('surrounded and camp starts keep the monsters more than 3 tiles from the party', () => {
  for (const act of ACTS) {
    for (const dep of ['surrounded', 'camp'] as const) {
      for (let seed = 0; seed < SEEDS; seed++) checkApart(generateRoom('combat', makeRng(seed), act, dep), `act ${act} ${dep} seed ${seed}`);
    }
  }
});

const meanX = (ps: Pos[]) => ps.reduce((s, p) => s + p.x, 0) / ps.length;
const center = (ps: Pos[]) => ({ x: meanX(ps), y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

test('line: the party on the left of the engagement zone, the monsters on its right', () => {
  for (const act of ACTS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const where = `act ${act} seed ${seed}`;
      const room = generateRoom('combat', makeRng(seed), act, 'line');
      const party = room.partySpawns.slice(0, 6);
      const foes = room.enemySpawns.slice(0, 8);
      assert.ok(meanX(foes) - meanX(party) >= 8, `${where}: party at x ${meanX(party).toFixed(1)}, monsters at x ${meanX(foes).toFixed(1)}`);
    }
  }
});

test('the engagement zone is an old-size stretch of the room, and the fight starts in or next to it', () => {
  for (const kind of KINDS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const room = generateRoom(kind, makeRng(seed), 1, 'line');
      const z = room.zone;
      assert.ok(z.x >= 0 && z.y >= 0 && z.x + z.w <= room.width && z.y + z.h <= room.height, `${kind} seed ${seed}: zone out of the room`);
      assert.ok(z.w < room.width && z.h < room.height, `${kind}: the room is bigger than the zone`);
      for (const p of [...room.partySpawns.slice(0, 4), ...room.enemySpawns.slice(0, 4)]) {
        assert.ok(p.x >= z.x - 6 && p.x < z.x + z.w + 6 && p.y >= z.y - 6 && p.y < z.y + z.h + 6, `${kind} seed ${seed}: spawn ${p.x},${p.y} far from the zone`);
      }
    }
  }
});

test('surrounded: the first hero starts near the middle, and the first four monsters each stand in a different corner', () => {
  for (const act of ACTS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const where = `act ${act} seed ${seed}`;
      const room = generateRoom('combat', makeRng(seed), act, 'surrounded');
      const z = room.zone;
      const hero = room.partySpawns[0];
      assert.ok(Math.abs(hero.x - (z.x + (z.w - 1) / 2)) <= 5 && Math.abs(hero.y - (z.y + (z.h - 1) / 2)) <= 5, `${where}: first hero at ${hero.x},${hero.y}`);
      // The monsters come from all around the party: at least three of the four quarters around it.
      const c = center(room.partySpawns.slice(0, 6));
      const quarters = room.enemySpawns.slice(0, 6).map((p) => `${p.x < c.x ? 'W' : 'E'}${p.y < c.y ? 'N' : 'S'}`);
      assert.ok(new Set(quarters).size >= 3, `${where}: quarters ${quarters.join(' ')}`);
    }
  }
});

test('pincer: monsters on both the left and the right of the party, and the first two come from opposite ends', () => {
  for (const act of ACTS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const where = `act ${act} seed ${seed}`;
      const room = generateRoom('combat', makeRng(seed), act, 'pincer');
      const c = meanX(room.partySpawns.slice(0, 6));
      assert.ok(room.enemySpawns.some((e) => e.x < c - 2), `${where}: nobody on the left`);
      assert.ok(room.enemySpawns.some((e) => e.x > c + 2), `${where}: nobody on the right`);
      assert.ok((room.enemySpawns[0].x - c) * (room.enemySpawns[1].x - c) < 0, `${where}: first two monsters at x ${room.enemySpawns[0].x}, ${room.enemySpawns[1].x}`);
    }
  }
});

test('camp: the first monster stands in the middle of the engagement zone, and the party comes in from several sides', () => {
  let oneSided = 0;
  for (const act of ACTS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const where = `act ${act} seed ${seed}`;
      const room = generateRoom('combat', makeRng(seed), act, 'camp');
      const z = room.zone;
      const first = room.enemySpawns[0]; // their camp sits at about 60% across the zone (room.ts)
      assert.ok(first.x >= z.x + z.w / 4 - 3 && first.x <= z.x + (3 * z.w) / 4 + 3 && first.y >= z.y + z.h / 4 - 3 && first.y <= z.y + (3 * z.h) / 4 + 3, `${where}: camp at ${first.x},${first.y}`);
      const side = (p: Pos) => (Math.abs(p.x - first.x) > Math.abs(p.y - first.y) ? (p.x < first.x ? 'west' : 'east') : p.y < first.y ? 'north' : 'south');
      if (new Set(room.partySpawns.map(side)).size < 2) oneSided++; // a twisty room can squeeze all three ways in to one side
    }
  }
  assert.ok(oneSided <= ACTS.length * SEEDS * 0.03, `${oneSided} one-sided camps`);
});

test('scattered: the party starts in two groups, apart', () => {
  for (const act of ACTS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const where = `act ${act} seed ${seed}`;
      const room = generateRoom('combat', makeRng(seed), act, 'scattered');
      // Two groups that start apart: the first two heroes are one of each.
      const [a, b] = room.partySpawns;
      assert.ok(dist(a, b) >= 4, `${where}: the first two heroes at ${a.x},${a.y} and ${b.x},${b.y}`);
    }
  }
});

// ---------------------------------------------------------------- picking a deployment

test('pickDeployment: a boss is always the line, and an ambush is always surrounded (for combats and elites)', () => {
  for (let seed = 0; seed < 200; seed++) {
    for (const start of ['vote', 'charge', 'ambush'] as const) {
      assert.equal(pickDeployment('boss', start, makeRng(seed)), 'line', `boss, ${start}, seed ${seed}`);
    }
    for (const kind of ['combat', 'elite'] as const) {
      assert.equal(pickDeployment(kind, 'ambush', makeRng(seed)), 'surrounded', `${kind}, ambush, seed ${seed}`);
    }
  }
});

test('pickDeployment: an elite never starts scattered (line, pincer or camp), and a regular combat mixes all four of line, scattered, pincer and camp', () => {
  const elite = new Set<Deployment>();
  const combat = new Set<Deployment>();
  for (let seed = 0; seed < 400; seed++) {
    for (const start of ['vote', 'charge'] as const) {
      elite.add(pickDeployment('elite', start, makeRng(seed)));
      combat.add(pickDeployment('combat', start, makeRng(seed)));
    }
  }
  assert.deepEqual([...elite].sort(), ['camp', 'line', 'pincer']);
  assert.deepEqual([...combat].sort(), ['camp', 'line', 'pincer', 'scattered']);
});

// ---------------------------------------------------------------- plans and dressing

test('every plan comes up in act 1-3 fights, and boss rooms use rocks, pillars or a cavern', () => {
  const plans = new Set<Plan>();
  for (const act of ACTS) for (let seed = 0; seed < 200; seed++) plans.add(generateRoom('combat', makeRng(seed), act).plan);
  assert.deepEqual([...plans].sort(), [...ALL_PLANS].sort());
  const boss = new Set<Plan>();
  for (const act of ACTS) for (let seed = 0; seed < 60; seed++) boss.add(generateRoom('boss', makeRng(seed), act, 'line').plan);
  assert.deepEqual([...boss].sort(), ['cavern', 'pillars', 'rocks']);
});

test('pits: most act 2-3 rooms have one, none in act 0, never at a spawn, and the floor stays in one piece around them', () => {
  let rooms = 0;
  let withPit = 0;
  for (const act of [2, 3]) {
    for (let seed = 0; seed < 100; seed++) {
      const room = generateRoom('combat', makeRng(seed), act);
      rooms++;
      if (room.tiles.includes('v')) withPit++;
      for (const p of [...room.partySpawns, ...room.enemySpawns]) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.notEqual(room.tiles[(p.y + dy) * room.width + p.x + dx], 'v', `act ${act} seed ${seed}: spawn ${p.x},${p.y} at a pit`);
      }
    }
  }
  assert.ok(withPit / rooms >= 0.75, `pits in ${withPit} of ${rooms}`);
  for (let seed = 0; seed < 50; seed++) assert.ok(!generateRoom('combat', makeRng(seed), 0).tiles.includes('v'));
});

test('low cover is in most act 1-3 fights, whichever plan built the room', () => {
  const byPlan = new Map<Plan, { cover: number; total: number }>();
  for (const act of ACTS) {
    for (let seed = 0; seed < 200; seed++) {
      const room = generateRoom('combat', makeRng(seed), act);
      const row = byPlan.get(room.plan) ?? { cover: 0, total: 0 };
      row.total++;
      if (room.tiles.includes(LOW_COVER)) row.cover++;
      byPlan.set(room.plan, row);
    }
  }
  let cover = 0;
  let total = 0;
  for (const [plan, row] of byPlan) {
    assert.ok(row.cover / row.total >= 0.9, `${plan}: low cover in ${row.cover} of ${row.total} rooms`);
    cover += row.cover;
    total += row.total;
  }
  assert.ok(cover / total >= 0.95, `low cover in ${cover} of ${total} rooms`);
});

test('act 0 (no theme) rooms have no low cover, puddles or props', () => {
  for (const kind of KINDS) {
    for (const dep of DEPLOYMENTS) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const room = generateRoom(kind, makeRng(seed), 0, dep);
        const where = `act 0 ${kind} ${dep} seed ${seed}`;
        assert.ok(!room.tiles.includes(LOW_COVER), `${where}: low cover`);
        assert.equal(Object.keys(room.ground).length, 0, `${where}: puddles`);
        assert.equal(Object.keys(room.props).length, 0, `${where}: props`);
      }
    }
  }
});

test('boss rooms are mirrored: the tile at x matches the tile at width-1-x (a prop stands on one side only, so those are skipped)', () => {
  for (const act of ACTS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const room = generateRoom('boss', makeRng(seed), act, 'line');
      const { width: w, height: h, tiles } = room;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w / 2; x++) {
          const i = y * w + x;
          const j = y * w + (w - 1 - x);
          if (room.props[i] || room.props[j] || tiles[i] === 'v' || tiles[j] === 'v') continue; // props and pits are placed one by one
          assert.equal(tiles[i], tiles[j], `act ${act} seed ${seed}: ${x},${y} against ${w - 1 - x},${y}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- grid

test('canStep: no stepping onto low cover, and no squeezing diagonally past a corner of low cover or a wall', () => {
  const open = grid(['#######', '#.....#', '#.....#', '#.....#', '#######']);
  const cover = grid(['#######', '#.....#', '#..o..#', '#.....#', '#######']); // low cover at (3,2)
  const coverBelow = grid(['#######', '#.....#', '#.....#', '#.o...#', '#######']); // low cover at (2,3)
  const pillar = grid(['#######', '#.....#', '#..#..#', '#.....#', '#######']); // a wall at (3,2)
  assert.equal(canStep(open, { x: 2, y: 2 }, 1, 0), true, 'open floor');
  assert.equal(canStep(cover, { x: 2, y: 2 }, 1, 0), false, 'straight onto low cover');
  assert.equal(canStep(cover, { x: 4, y: 2 }, -1, 0), false, 'and back onto it from the other side');
  assert.equal(canStep(cover, { x: 2, y: 2 }, 0, 1), true, 'a step that does not touch it');
  // Diagonal squeezes: the destination is open, but one of the two corners you pass is cover or a wall.
  assert.equal(canStep(open, { x: 2, y: 2 }, 1, 1), true, 'diagonal on open floor');
  assert.equal(canStep(cover, { x: 2, y: 2 }, 1, -1), false, 'past the cover corner at (3,2), upwards');
  assert.equal(canStep(cover, { x: 2, y: 2 }, 1, 1), false, 'past the same corner, downwards');
  assert.equal(canStep(cover, { x: 4, y: 2 }, -1, -1), false, 'and from the far side');
  assert.equal(canStep(coverBelow, { x: 2, y: 2 }, 1, 1), false, 'past the cover corner at (2,3)');
  assert.equal(canStep(coverBelow, { x: 2, y: 2 }, 1, -1), true, 'the other diagonal has no cover at a corner');
  assert.equal(canStep(pillar, { x: 2, y: 2 }, 1, -1), false, 'past a wall corner');
  assert.equal(canStep(pillar, { x: 1, y: 1 }, 1, 0), true, 'along the row above the wall is fine');
});

test('hasLOS: sight goes over low cover but not through a wall, and low cover blocks movement but not sight', () => {
  const crate = grid(['#########', '#.......#', '#...o...#', '#.......#', '#########']); // low cover at (4,2)
  const hall = grid(['#########', '#.......#', '#...#...#', '#.......#', '#########']); // a wall at (4,2)
  assert.equal(hasLOS(crate, { x: 2, y: 2 }, { x: 6, y: 2 }), true, 'straight over the cover');
  assert.equal(hasLOS(crate, { x: 2, y: 1 }, { x: 6, y: 3 }), true, 'diagonally over the cover');
  assert.equal(hasLOS(hall, { x: 2, y: 2 }, { x: 6, y: 2 }), false, 'a wall in the way');
  assert.equal(hasLOS(hall, { x: 3, y: 2 }, { x: 5, y: 2 }), false, 'a wall right between');
  assert.equal(isBlocked(crate, 4, 2), true, 'nobody stands on low cover');
  assert.equal(isWall(crate, 4, 2), false, 'but it is not a wall');
  assert.equal(isWall(hall, 4, 2), true);
});

// ---------------------------------------------------------------- cover from a position

test('coverFrom: a wall or low cover on the target\'s side gives 5 or 2, a prop on a wall gives 2, and nothing from the wall side, the open or melee', () => {
  assert.equal(FULL_COVER, 5);
  assert.equal(HALF_COVER, 2);
  assert.equal(coverFrom(yard({ '3,2': '#' }), { x: 6, y: 2 }, { x: 2, y: 2 }), FULL_COVER, 'a wall east of the target, shot from the east');
  assert.equal(coverFrom(yard({ '3,2': '#' }), { x: 7, y: 2 }, { x: 2, y: 2 }), FULL_COVER, 'and from further off');
  assert.equal(coverFrom(yard({ '3,2': LOW_COVER }), { x: 6, y: 2 }, { x: 2, y: 2 }), HALF_COVER, 'low cover');
  assert.equal(coverFrom(yard({ '3,2': '#' }, { '3,2': 'barrel' }), { x: 6, y: 2 }, { x: 2, y: 2 }), HALF_COVER, 'a prop on a wall');
  assert.equal(coverWord(FULL_COVER), 'behind a wall');
  assert.equal(coverWord(HALF_COVER), 'in cover');
  assert.equal(coverWord(0), '');
  const wall = yard({ '4,2': '#' }); // the wall is east of the target at (3,2)
  assert.equal(coverFrom(wall, { x: 1, y: 2 }, { x: 3, y: 2 }), 0, 'an attacker west of the target: the wall is behind it');
  assert.equal(coverFrom(wall, { x: 1, y: 6 }, { x: 3, y: 2 }), 0, 'and from the open to the south-west');
  assert.equal(coverFrom(wall, { x: 4, y: 1 }, { x: 3, y: 2 }), 0, 'melee: the attacker is next to the target, no cover');
  assert.equal(coverFrom(wall, { x: 3, y: 1 }, { x: 3, y: 2 }), 0, 'melee again, straight above');
});

test('coverFrom: an attacker round the side of a wall (over 60 degrees off) gets no cover, one straight on does', () => {
  const wall = yard({ '3,2': '#' }); // the wall is east of the target at (2,2)
  assert.equal(coverFrom(wall, { x: 3, y: 7 }, { x: 2, y: 2 }), 0, 'at (+1,+5): flanked, the wall does not count');
  assert.equal(coverFrom(wall, { x: 7, y: 4 }, { x: 2, y: 2 }), FULL_COVER, 'at (+5,+2): still behind it');
  const both = yard({ '3,2': '#', '2,3': LOW_COVER }); // a wall to the east, low cover to the south
  assert.equal(coverFrom(both, { x: 5, y: 5 }, { x: 2, y: 2 }), FULL_COVER, 'from the south-east: the wall (5) beats the cover (2)');
  assert.equal(coverFrom(yard({ '2,3': LOW_COVER }), { x: 5, y: 5 }, { x: 2, y: 2 }), HALF_COVER, 'with only the cover, it is 2');
});

// ---------------------------------------------------------------- attacks and saves in a Game

test('an archer shooting over a wall: AC +5, the roll misses and the log says "behind a wall"; from round the side the same roll hits', () => {
  const { p, heroes, foe } = battle(['ranger', 'fighter', 'cleric']);
  const [archer] = heroes;
  const gob = foe('goblin', 6, 3);
  gob.facing = { x: 1, y: 0 }; // turned to the archer, so a shot from the east is not from behind
  setTile(p, 7, 3, '#'); // a wall just behind the goblin, on the east
  Object.assign(archer, { x: 9, y: 3 }); // the archer on the far side of it
  const roll = gob.ac + 2; // between AC and AC + 5
  const shot = { bonus: 0, dmg: { n: 1, d: 6 }, verb: 'shoots', element: 'physical' as const };
  assert.equal(dice([showing(roll)], () => p.attackRoll(archer, gob, shot)), false, 'behind the wall it misses');
  assert.ok(logged(p, new RegExp(`vs AC ${gob.ac + 5} \\(behind a wall\\), miss`)), JSON.stringify(p.log.at(-1)));
  assert.equal(gob.hp, gob.maxHp);
  Object.assign(archer, { x: 7, y: 6 }); // round the side of the wall: no cover
  assert.equal(dice([showing(roll)], () => p.attackRoll(archer, gob, shot)), true, 'from the flank the same roll hits');
  assert.ok(gob.hp < gob.maxHp);
});

test('low cover adds 2 to AC: the log says "in cover", a roll that beats the open misses behind the crate', () => {
  const { p, heroes, foe } = battle(['ranger', 'fighter', 'cleric']);
  const [archer] = heroes;
  const gob = foe('goblin', 6, 3);
  gob.facing = { x: 1, y: 0 };
  setTile(p, 7, 3, LOW_COVER);
  Object.assign(archer, { x: 9, y: 3 });
  const roll = gob.ac + 1; // hits the open goblin, not the one behind the crate
  const shot = { bonus: 0, dmg: { n: 1, d: 6 }, verb: 'shoots', element: 'physical' as const };
  assert.equal(dice([showing(roll)], () => p.attackRoll(archer, gob, shot)), false);
  assert.ok(logged(p, new RegExp(`vs AC ${gob.ac + 2} \\(in cover\\), miss`)), JSON.stringify(p.log.at(-1)));
  Object.assign(archer, { x: 7, y: 6 });
  assert.equal(dice([showing(roll)], () => p.attackRoll(archer, gob, shot)), true, 'round the side it hits');
});

test('a DEX save from a blast: a wall between the target and the caster adds its cover, so a save that fails in the open passes', () => {
  const { p, heroes, foe } = battle(['wizard', 'fighter', 'cleric']);
  const [wiz] = heroes;
  const gob = foe('goblin', 6, 3);
  setTile(p, 7, 3, '#');
  Object.assign(wiz, { x: 9, y: 3 }); // the caster, on the far side of the wall
  const fireball = statsAt('fireball');
  const dc = heroDc(wiz);
  const roll = dc - 2 - MONSTERS.goblin.dex; // the goblin's save totals DC - 2: a fail, unless the wall adds 5
  assert.ok(roll >= 1 && roll <= 20, `roll ${roll}`);
  const before = gob.hp;
  assert.equal(dice([showing(roll)], () => p.saveHit(wiz, gob, fireball, 'Fireball', '#ff0000')), false, 'behind the wall it is saved');
  assert.ok(logged(p, new RegExp(`resists .*\\+5 behind a wall vs DC ${dc}`)), JSON.stringify(p.log.at(-1)));
  const halved = before - gob.hp;
  gob.hp = gob.maxHp;
  assert.equal(dice([showing(roll)], () => p.saveHit(wiz, gob, fireball, 'Fireball', '#ff0000', false, { x: 7, y: 6 })), true, 'from round the side it is caught');
  assert.ok(logged(p, /is caught by/));
  assert.ok(gob.maxHp - gob.hp > halved, 'and it takes the whole blast, not half');
});

// ---------------------------------------------------------------- the start of a fight

test('an ambush: the log says so, and each hero turns to face its nearest monster', () => {
  const { p, heroes } = battle(['fighter', 'paladin', 'cleric']);
  p.log = [];
  seeded(7, () => p.startRoom('combat', ['goblin', 'goblin', 'goblin'], 'Test', 'ambush'));
  assert.ok(logged(p, /Surrounded! They come at you from every corner\./), JSON.stringify(p.log.map((l: { text: string }) => l.text)));
  assert.ok(logged(p, /Ambush! They were waiting for you\./));
  const foes: MonsterEntity[] = p.entities.filter((e: any) => e.kind === 'monster');
  assert.equal(foes.length, 3);
  for (const h of heroes) {
    const d = Math.min(...foes.map((m) => dist(h, m)));
    assert.ok(foes.some((m) => dist(h, m) === d && facesTo(h, m, h)), `${h.name} faces ${JSON.stringify(h.facing)}, not a nearest monster`);
  }
});

test('startRoom: the monsters start facing their nearest hero', () => {
  const { p, heroes } = battle(['fighter', 'paladin', 'cleric']);
  seeded(7, () => p.startRoom('combat', ['goblin', 'goblin', 'goblin'], 'Test', 'ambush'));
  const foes: MonsterEntity[] = p.entities.filter((e: any) => e.kind === 'monster');
  for (const m of foes) {
    const d = Math.min(...heroes.map((h) => dist(m, h)));
    assert.ok(heroes.some((h) => dist(m, h) === d && facesTo(m, h, m)), `${m.name} at ${m.x},${m.y} faces ${JSON.stringify(m.facing)}, not a nearest hero`);
  }
});

test('startRoom: identical monsters in one fight get the same stats, and only the heroes are surprised in an ambush (the party list is a copy)', () => {
  const { p } = battle(['fighter', 'paladin', 'cleric']);
  seeded(7, () => p.startRoom('combat', ['goblin', 'goblin', 'goblin'], 'Test', 'ambush'));
  const foes: MonsterEntity[] = p.entities.filter((e: any) => e.kind === 'monster');
  assert.equal(new Set(foes.map((m) => `${m.maxHp}/${m.dmgBonus ?? 0}`)).size, 1, foes.map((m) => `${m.maxHp} hp +${m.dmgBonus ?? 0}`).join(', '));
  assert.ok(foes.every((m) => !m.statuses.some((s) => s.id === 'surprised')), 'a monster is surprised');
});

test('a fight that starts with a vote gets the deployment its rng rolls: the log names it, and the heroes stand where it says', () => {
  const { p, heroes } = battle(['fighter', 'paladin', 'cleric']);
  const LINES: [Deployment, RegExp][] = [
    ['scattered', /The party comes in by two ways/],
    ['pincer', /A pincer!/],
    ['camp', /You come upon their camp from three sides/],
  ];
  const seen = new Set<Deployment>();
  let squeezed = 0;
  for (let seed = 1; seed <= 200; seed++) {
    p.log = [];
    seeded(seed, () => p.startRoom('combat', Array<string>(6).fill('goblin'), 'Test', 'vote'));
    const found = LINES.filter(([, re]) => logged(p, re)).map(([d]) => d);
    assert.ok(found.length <= 1, `seed ${seed}: ${found.join(', ')}`);
    const d: Deployment = found[0] ?? 'line';
    seen.add(d);
    const foes: MonsterEntity[] = p.entities.filter((e: any) => e.kind === 'monster');
    const where = `seed ${seed} (${d})`;
    if (d === 'line') {
      assert.ok(meanX(foes) - meanX(heroes) >= 6, `${where}: heroes at x ${meanX(heroes).toFixed(1)}, monsters at x ${meanX(foes).toFixed(1)}`);
    } else if (d === 'scattered') {
      assert.ok(dist(heroes[0], heroes[1]) >= 4, `${where}: the first two heroes together`);
    } else if (d === 'pincer') {
      const c = meanX(heroes);
      assert.ok(foes.some((m) => m.x < c) && foes.some((m) => m.x > c), `${where}: monsters not on both sides`);
    } else if (dist(foes[0], center(heroes)) < 3) squeezed++; // a twisty room now and then (room.ts)
  }
  assert.deepEqual([...seen].sort(), ['camp', 'line', 'pincer', 'scattered']);
  assert.ok(squeezed <= 4, `${squeezed} camps squeezed onto the party`);
});
