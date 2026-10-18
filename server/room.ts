// Fight rooms: a small walled arena with a few obstacles, the party on the left and enemies on the right.
// Each act dresses its rooms differently (shared/surfaces.ts): oil and lamps in the Goblin Warrens, water and poison
// in the Crypt, lava and braziers in the Dragon's Lair.

import { reachable } from '../shared/grid.ts';
import type { GroundId, GroundMap, PropId, PropMap } from '../shared/surfaces.ts';
import type { NodeType, Pos } from '../shared/types.ts';
import { rng, type Rng } from './rng.ts';

export interface RoomLayout {
  width: number;
  height: number;
  tiles: string; // '#' wall, '.' floor, index = y * width + x (props stand on '#' tiles)
  ground: GroundMap; // permanent puddles, oil slicks, lava
  props: PropMap;
  partySpawns: Pos[]; // left side, most central first
  enemySpawns: Pos[]; // right side, most central first (enemySpawns[0] is where a boss goes)
}

/** What an act scatters around its rooms: [what, how many patches, patch size]. */
interface Theme {
  patches: [GroundId, [number, number], [number, number]][];
  props: [PropId, [number, number]][];
}

const THEMES: Record<number, Theme> = {
  1: { patches: [['oil', [2, 3], [3, 6]]], props: [['barrel', [1, 2]], ['brazier', [0, 1]]] },
  2: { patches: [['water', [2, 3], [4, 8]], ['poison', [0, 1], [2, 4]]], props: [] },
  3: { patches: [['lava', [1, 2], [2, 4]], ['oil', [0, 1], [3, 5]]], props: [['brazier', [1, 2]], ['barrel', [0, 1]]] },
};

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

/** A random blob of floor tiles grown from one tile, away from the spawn columns. */
function blob(width: number, height: number, tiles: string[], size: number, r: Rng, taken: Set<number>): number[] {
  const ok = (x: number, y: number) => x >= 3 && x <= width - 4 && y >= 1 && y <= height - 2 && tiles[y * width + x] === '.' && !taken.has(y * width + x);
  for (let attempt = 0; attempt < 20; attempt++) {
    const sx = r.int(3, width - 4);
    const sy = r.int(1, height - 2);
    if (!ok(sx, sy)) continue;
    const out = [sy * width + sx];
    for (let tries = 0; out.length < size && tries < size * 8; tries++) {
      const from = r.pick(out);
      const [dx, dy] = r.pick([[1, 0], [-1, 0], [0, 1], [0, -1]] as const);
      const x = (from % width) + dx;
      const y = Math.floor(from / width) + dy;
      const i = y * width + x;
      if (ok(x, y) && !out.includes(i)) out.push(i);
    }
    return out;
  }
  return [];
}

/** Puddles, slicks and props for the act. Props are walls you can blow up, so they must not cut the room in two. */
function dress(width: number, height: number, tiles: string[], act: number, kind: NodeType, r: Rng): { ground: GroundMap; props: PropMap } {
  const ground: GroundMap = {};
  const props: PropMap = {};
  const theme = THEMES[act];
  if (!theme) return { ground, props };
  const scale = kind === 'boss' ? 0.5 : 1;
  const taken = new Set<number>();
  for (const [id, count, size] of theme.patches) {
    const n = Math.round(r.int(count[0], count[1]) * scale);
    for (let k = 0; k < n; k++) {
      for (const i of blob(width, height, tiles, r.int(size[0], size[1]), r, taken)) {
        ground[i] = { id, turns: null };
        taken.add(i);
      }
    }
  }
  for (const [id, count] of theme.props) {
    const n = Math.round(r.int(count[0], count[1]) * (kind === 'boss' ? 1 : scale));
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const x = r.int(4, width - 5);
        const y = r.int(1, height - 2);
        const i = y * width + x;
        if (tiles[i] !== '.' || ground[i]) continue;
        if (Object.keys(props).some((k2) => Math.max(Math.abs((Number(k2) % width) - x), Math.abs(Math.floor(Number(k2) / width) - y)) < 3)) continue;
        tiles[i] = '#';
        if (!connected(width, height, tiles.join(''))) {
          tiles[i] = '.';
          continue;
        }
        props[i] = id;
        break;
      }
    }
  }
  return { ground, props };
}

/** `act` 1-3 dresses the room for that act (0 = a bare room, for tests). */
export function generateRoom(kind: NodeType, r: Rng = rng, act = 0): RoomLayout {
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

  const grid = tiles.split('');
  const { ground, props } = dress(width, height, grid, act, kind, r);
  tiles = grid.join('');

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
    ground,
    props,
    partySpawns: spawns([1, 2]),
    enemySpawns: spawns([width - 3, width - 2]),
  };
}
