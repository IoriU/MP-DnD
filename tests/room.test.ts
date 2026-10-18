import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reachable } from '../shared/grid.ts';
import type { NodeType, Pos } from '../shared/types.ts';
import { makeRng } from '../server/rng.ts';
import { generateRoom, type RoomLayout } from '../server/room.ts';

const ROOMS = 200;
const SIZES: [NodeType, number, number][] = [
  ['combat', 18, 12],
  ['elite', 20, 13],
  ['boss', 22, 14],
];

const floor = (room: RoomLayout, x: number, y: number) => room.tiles[y * room.width + x] === '.';

function checkSpawns(room: RoomLayout, spawns: Pos[], cols: number[]) {
  assert.ok(spawns.length >= 12, `only ${spawns.length} spawns`);
  assert.equal(new Set(spawns.map((p) => p.y * room.width + p.x)).size, spawns.length, 'duplicate spawns');
  for (const p of spawns) {
    assert.ok(cols.includes(p.x), `spawn at x=${p.x}`);
    assert.ok(floor(room, p.x, p.y), `spawn on a wall at ${p.x},${p.y}`);
  }
  const mid = (room.height - 1) / 2;
  const d = spawns.map((p) => Math.abs(p.y - mid));
  assert.deepEqual(d, [...d].sort((a, b) => a - b), 'spawns not ordered by distance from the middle row');
}

for (const [kind, width, height] of SIZES) {
  test(`${kind} rooms`, () => {
    for (let seed = 0; seed < ROOMS; seed++) {
      const room = generateRoom(kind, makeRng(seed));
      const where = `${kind} seed ${seed}`;
      assert.equal(room.width, width, where);
      assert.equal(room.height, height, where);
      assert.equal(room.tiles.length, width * height, where);
      assert.match(room.tiles, /^[#.]+$/, where);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
          if (border) assert.ok(!floor(room, x, y), `${where}: border floor at ${x},${y}`);
          else if (x < 4 || x > width - 5) assert.ok(floor(room, x, y), `${where}: obstacle in spawn zone at ${x},${y}`);
        }
      }

      const floors = [...room.tiles].filter((t) => t === '.').length;
      const start = room.tiles.indexOf('.');
      const seen = reachable(room, { x: start % width, y: Math.floor(start / width) }, width * height, () => false);
      assert.equal(seen.size, floors, `${where}: unreachable floor tiles`);

      checkSpawns(room, room.partySpawns, [1, 2]);
      checkSpawns(room, room.enemySpawns, [width - 3, width - 2]);
      assert.ok(Math.abs(room.enemySpawns[0].y - (height - 1) / 2) <= 1, `${where}: boss spawn off-centre`);
      assert.ok(Math.abs(room.partySpawns[0].y - (height - 1) / 2) <= 1, `${where}: party spawn off-centre`);

      if (kind === 'boss') {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) assert.equal(floor(room, x, y), floor(room, width - 1 - x, y), `${where}: not mirrored`);
        }
      }
    }
  });
}

test('rooms have obstacles and vary', () => {
  const layouts = new Set<string>();
  let walls = 0;
  for (let seed = 0; seed < 50; seed++) {
    const room = generateRoom('combat', makeRng(seed));
    layouts.add(room.tiles);
    walls += [...room.tiles].filter((t) => t === '#').length - 2 * (18 + 12 - 2);
  }
  assert.ok(layouts.size >= 45, `only ${layouts.size} distinct layouts`);
  assert.ok(walls > 0);
});

test('same rng seed gives the same room', () => {
  for (let seed = 0; seed < 20; seed++) assert.deepEqual(generateRoom('elite', makeRng(seed)), generateRoom('elite', makeRng(seed)));
});

test('other node kinds and the default rng give a combat-sized room', () => {
  for (const kind of ['event', 'rest', 'treasure', 'shop'] as const) {
    const room = generateRoom(kind);
    assert.equal(room.width, 18);
    assert.equal(room.height, 12);
    assert.equal(room.tiles.length, 18 * 12);
  }
});
