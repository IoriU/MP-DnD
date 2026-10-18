// Fight rooms: a small walled arena with a few obstacles, the party on the left and enemies on the right.

import { reachable } from '../shared/grid.ts';
import type { NodeType, Pos } from '../shared/types.ts';
import { rng, type Rng } from './rng.ts';

export interface RoomLayout {
  width: number;
  height: number;
  tiles: string; // '#' wall, '.' floor, index = y * width + x
  partySpawns: Pos[]; // left side, most central first
  enemySpawns: Pos[]; // right side, most central first (enemySpawns[0] is where a boss goes)
}

const SHAPES: ReadonlyArray<readonly [number, number]> = [[1, 1], [2, 1], [1, 2], [2, 2]];
const ATTEMPTS = 30;

function roomSpec(kind: NodeType) {
  if (kind === 'elite') return { width: 20, height: 13, obstacles: [4, 7] };
  if (kind === 'boss') return { width: 22, height: 14, obstacles: [2, 4] };
  return { width: 18, height: 12, obstacles: [3, 6] };
}

function emptyRoom(width: number, height: number): string[] {
  const grid: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.push(x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : '.');
  }
  return grid;
}

/** True if every floor tile can reach every other one. */
function connected(width: number, height: number, tiles: string): boolean {
  const start = tiles.indexOf('.');
  if (start < 0) return false;
  const floor = tiles.split('').filter((t) => t === '.').length;
  const m = { width, height, tiles };
  return reachable(m, { x: start % width, y: Math.floor(start / width) }, width * height, () => false).size === floor;
}

export function generateRoom(kind: NodeType, r: Rng = rng): RoomLayout {
  const { width, height, obstacles } = roomSpec(kind);
  const mirror = kind === 'boss';
  let tiles = emptyRoom(width, height).join('');

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const grid = emptyRoom(width, height);
    const wall = (x: number, y: number, w: number, h: number) => {
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) grid[(y + dy) * width + x + dx] = '#';
    };
    const count = r.int(obstacles[0], obstacles[1]);
    for (let i = 0; i < count; i++) {
      const [w, h] = r.pick(SHAPES);
      // Obstacles stay within columns 4 .. width-5 so the spawn zones are clear.
      const x = r.int(4, width - 4 - w);
      const y = r.int(1, height - 1 - h);
      wall(x, y, w, h);
      if (mirror) wall(width - x - w, y, w, h);
    }
    const candidate = grid.join('');
    if (connected(width, height, candidate)) {
      tiles = candidate;
      break;
    }
  }

  const mid = (height - 1) / 2;
  const spawns = (cols: number[]): Pos[] => {
    const out: Pos[] = [];
    for (const x of cols) for (let y = 1; y < height - 1; y++) if (tiles[y * width + x] === '.') out.push({ x, y });
    // Shuffle first so the stable sort breaks distance ties randomly.
    return r.shuffle(out).sort((a, b) => Math.abs(a.y - mid) - Math.abs(b.y - mid));
  };

  return {
    width,
    height,
    tiles,
    partySpawns: spawns([1, 2]),
    enemySpawns: spawns([width - 3, width - 2]),
  };
}
