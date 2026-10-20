// Fight rooms (bigger since 2026-10-19): a walled arena built from one of a few plans (scattered rocks, a pillared hall,
// a wall with gaps, side halls, ruins) with low cover to duck behind, and a deployment: who starts where. The classic
// line (the party on the left, the monsters on the right), scattered groups, a pincer, surrounded, or their camp in the
// middle with the party coming in from three sides. Each act dresses its rooms differently (shared/surfaces.ts): oil
// and lamps in the Goblin Warrens, water and poison in the Crypt, lava and braziers in the Dragon's Lair.

import { LOW_COVER, reachable } from '../shared/grid.ts';
import type { GroundId, GroundMap, PropId, PropMap } from '../shared/surfaces.ts';
import type { NodeType, Pos } from '../shared/types.ts';
import { rng, type Rng } from './rng.ts';

export type Plan = 'rocks' | 'pillars' | 'chokepoint' | 'halls' | 'ruins';
export type Deployment = 'line' | 'scattered' | 'pincer' | 'surrounded' | 'camp';

export interface RoomLayout {
  width: number;
  height: number;
  tiles: string; // '#' wall, 'o' low cover (blocks movement, not sight), '.' floor; index = y * width + x (props stand on '#')
  ground: GroundMap; // permanent puddles, oil slicks, lava
  props: PropMap;
  plan: Plan;
  deployment: Deployment;
  partySpawns: Pos[]; // heroes first (groups interleaved, so even a small party is split), then NPC allies
  enemySpawns: Pos[]; // monsters in order, groups interleaved (enemySpawns[0] is where a boss goes)
}

/** What an act scatters around its rooms: [what, how many patches, patch size]. */
interface Theme {
  patches: [GroundId, [number, number], [number, number]][];
  props: [PropId, [number, number]][];
}

const THEMES: Record<number, Theme> = {
  1: { patches: [['oil', [2, 4], [3, 6]]], props: [['barrel', [1, 3]], ['brazier', [0, 1]]] },
  2: { patches: [['water', [3, 4], [4, 8]], ['poison', [0, 1], [2, 4]]], props: [] },
  3: { patches: [['lava', [1, 3], [2, 4]], ['oil', [0, 1], [3, 5]]], props: [['brazier', [1, 2]], ['barrel', [0, 1]]] },
};

const SHAPES: ReadonlyArray<readonly [number, number]> = [[1, 1], [2, 1], [1, 2], [2, 2]];
const ATTEMPTS = 30;
/** How often each plan comes up (bosses get the open ones, mirrored). */
const PLANS: Record<'fight' | 'boss', [Plan, number][]> = {
  fight: [['rocks', 25], ['pillars', 20], ['chokepoint', 15], ['halls', 15], ['ruins', 25]],
  boss: [['rocks', 50], ['pillars', 50]],
};
/** How often each deployment comes up: regular fights mix them all, elites never scatter you, bosses face you head-on. */
const DEPLOYMENTS: Record<'combat' | 'elite', [Deployment, number][]> = {
  combat: [['line', 25], ['scattered', 30], ['pincer', 20], ['camp', 25]],
  elite: [['line', 40], ['pincer', 25], ['camp', 35]],
};

function roomSpec(kind: NodeType) {
  if (kind === 'elite') return { width: 26, height: 17 };
  if (kind === 'boss') return { width: 28, height: 18 };
  return { width: 24, height: 16 };
}

const weighted = <T>(r: Rng, list: [T, number][]): T => {
  let x = r.next() * list.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of list) if ((x -= w) < 0) return v;
  return list[list.length - 1][0];
};

/**
 * Where a fight starts: an ambush surrounds you, a boss waits at the far end, an encounter may have its own (`own`: their
 * camp, a pincer), the rest is a mix.
 */
export function pickDeployment(kind: NodeType, start: 'vote' | 'ambush' | 'charge', r: Rng = rng, warmup = false, own?: Deployment): Deployment {
  if (kind === 'boss' || warmup) return 'line';
  if (start === 'ambush') return 'surrounded';
  return own ?? weighted(r, DEPLOYMENTS[kind === 'elite' ? 'elite' : 'combat']);
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

// ---------------------------------------------------------------- plans
// Every plan keeps columns 1-3 and width-4..width-2 clear, so the classic line always has room to start in.

interface Builder {
  width: number;
  height: number;
  grid: string[];
  r: Rng;
  mirror: boolean;
}

/** Fills a w×h block at (x, y) with `c` (and its mirror image, for a boss room), inside the clear middle only. */
function block(b: Builder, x: number, y: number, w: number, h: number, c: string) {
  const put = (px: number, py: number) => {
    if (px < 4 || px > b.width - 5 || py < 1 || py > b.height - 2) return;
    b.grid[py * b.width + px] = c;
  };
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      put(x + dx, y + dy);
      if (b.mirror) put(b.width - 1 - (x + dx), y + dy);
    }
  }
}

/** Short runs of low cover: crates, rubble, a broken wall. */
function lowCover(b: Builder, count: number) {
  for (let i = 0; i < count; i++) {
    const len = b.r.int(1, 3);
    const across = b.r.next() < 0.5;
    block(b, b.r.int(4, b.width - 5), b.r.int(1, b.height - 2), across ? len : 1, across ? 1 : len, LOW_COVER);
  }
}

function rocks(b: Builder) {
  const n = b.r.int(6, 10);
  for (let i = 0; i < n; i++) {
    const [w, h] = b.r.pick(SHAPES);
    block(b, b.r.int(4, b.width - 4 - w), b.r.int(1, b.height - 1 - h), w, h, '#');
  }
  lowCover(b, b.r.int(4, 7));
}

/** A hall of pillars on a grid, a few of them fallen into rubble. */
function pillars(b: Builder) {
  const step = b.r.pick([3, 4]);
  const size = b.mirror ? 2 : 1;
  for (let y = 2 + b.r.int(0, 1); y < b.height - 2; y += step + size - 1) {
    for (let x = 5 + b.r.int(0, 1); x < b.width - 5; x += step + size - 1) {
      const roll = b.r.next();
      if (roll < 0.7) block(b, x, y, size, size, '#');
      else if (roll < 0.85) block(b, x, y, 1, 1, LOW_COVER);
    }
  }
  lowCover(b, b.r.int(2, 4));
}

/** A wall across the middle with two or three gaps, low cover on both sides of each gap. */
function chokepoint(b: Builder) {
  const x = Math.floor(b.width / 2) + b.r.int(-1, 1);
  block(b, x, 1, 1, b.height - 2, '#');
  const gaps = b.r.int(2, 3);
  const span = (b.height - 2) / gaps;
  for (let g = 0; g < gaps; g++) {
    const y = Math.floor(1 + span * g + b.r.int(1, Math.max(1, Math.floor(span) - 3)));
    block(b, x, y, 1, 2, '.');
    block(b, x - 2, y + b.r.int(-1, 1), 1, 2, LOW_COVER);
    block(b, x + 2, y + b.r.int(-1, 1), 1, 2, LOW_COVER);
  }
  const n = b.r.int(2, 4);
  for (let i = 0; i < n; i++) block(b, b.r.int(4, b.width - 6), b.r.int(1, b.height - 3), b.r.int(1, 2), b.r.int(1, 2), '#');
}

/** Two long walls with doorways: a middle hall between two side halls. */
function halls(b: Builder) {
  for (const y of [Math.round(b.height / 3), Math.round((2 * b.height) / 3) - 1]) {
    block(b, 4, y, b.width - 8, 1, '#');
    const doors = b.r.int(2, 3);
    const span = (b.width - 8) / doors;
    for (let d = 0; d < doors; d++) block(b, Math.floor(4 + span * d + b.r.int(1, Math.max(1, Math.floor(span) - 3))), y, 2, 1, '.');
  }
  lowCover(b, b.r.int(4, 6));
}

/** Broken walls everywhere: lots of low cover, a few standing stones. */
function ruins(b: Builder) {
  lowCover(b, b.r.int(9, 13));
  const n = b.r.int(2, 4);
  for (let i = 0; i < n; i++) block(b, b.r.int(4, b.width - 5), b.r.int(1, b.height - 2), 1, 1, '#');
}

const BUILDERS: Record<Plan, (b: Builder) => void> = { rocks, pillars, chokepoint, halls, ruins };

// ---------------------------------------------------------------- dressing

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
function dress(
  width: number, height: number, tiles: string[], act: number, kind: NodeType, r: Rng, terrain: Theme['patches'] = [],
): { ground: GroundMap; props: PropMap } {
  const ground: GroundMap = {};
  const props: PropMap = {};
  const theme = THEMES[act];
  if (!theme) return { ground, props };
  const scale = kind === 'boss' ? 0.5 : 1;
  const taken = new Set<number>();
  for (const [id, count, size] of [...theme.patches, ...terrain]) { // an encounter's own terrain on top of the act's
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

// ---------------------------------------------------------------- deployments

/** How close the two sides may start: a monster this near a hero could hit them before they move. */
const APART = 4;

/**
 * The open tiles nearest (by walking) to `at`, up to `n`, skipping `taken`, ground patches, and tiles closer than APART
 * to anyone in `away` (the other side).
 */
function cluster(width: number, height: number, tiles: string, ground: GroundMap, at: Pos, n: number, taken: Set<number>, away: Pos[] = []): Pos[] {
  const far = (i: number) => away.every((p) => Math.max(Math.abs(p.x - (i % width)), Math.abs(p.y - Math.floor(i / width))) >= APART);
  const open = (i: number) => tiles[i] === '.' && !taken.has(i) && !ground[i] && far(i); // nobody starts in a puddle or the lava
  const walkable = (i: number) => tiles[i] === '.';
  // Start from the nearest open tile to the anchor (as the crow flies).
  let start = -1;
  let best = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    if (!open(i)) continue;
    const d = Math.max(Math.abs((i % width) - at.x), Math.abs(Math.floor(i / width) - at.y));
    if (d < best) [best, start] = [d, i];
  }
  if (start < 0) return [];
  const out: Pos[] = [];
  const seen = new Set([start]);
  const queue = [start];
  for (let q = 0; q < queue.length && out.length < n; q++) {
    const i = queue[q];
    if (open(i)) out.push({ x: i % width, y: Math.floor(i / width) });
    const x = i % width;
    const y = Math.floor(i / width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const j = ny * width + nx;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen.has(j) || !walkable(j)) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return out;
}

/** Groups taken in turn: the first of each, then the second of each, and so on. */
function weave(groups: Pos[][]): Pos[] {
  const out: Pos[] = [];
  for (let k = 0; k < Math.max(0, ...groups.map((g) => g.length)); k++) for (const g of groups) if (g[k]) out.push(g[k]);
  return out;
}

function deploy(d: Deployment, width: number, height: number, tiles: string, ground: GroundMap, r: Rng): { party: Pos[]; enemies: Pos[] } {
  const mid = (height - 1) / 2;
  const taken = new Set<number>();
  const grab = (x: number, y: number, n: number, away: Pos[] = []) => {
    const c = cluster(width, height, tiles, ground, { x: Math.round(x), y: Math.round(y) }, n, taken, away);
    for (const p of c) taken.add(p.y * width + p.x);
    return c;
  };
  const jitter = (n: number) => r.int(-n, n);
  switch (d) {
    case 'scattered':
      // The party comes in by two ways on the left; the monsters are spread over the right in three groups.
      return {
        party: weave([grab(2, height * 0.22 + jitter(1), 6), grab(2, height * 0.78 + jitter(1), 6)]),
        enemies: weave([grab(width - 3, 2 + r.int(0, 2), 5), grab(width * 0.68 + jitter(1), mid + jitter(2), 5), grab(width - 3, height - 3 - r.int(0, 2), 5)]),
      };
    case 'pincer': {
      // The party in the left-middle, monsters closing in from both ends.
      const party = grab(width * 0.4, mid + jitter(1), 9);
      return { party, enemies: weave([grab(width - 2, mid + jitter(2), 8, party), grab(1, mid + jitter(3), 6, party)]) };
    }
    case 'surrounded': {
      const party = grab(width / 2, mid, 9);
      const corners = [[1, 1, 4], [width - 2, height - 2, 4], [width - 2, 1, 4], [1, height - 2, 4], [width / 2, 1, 3], [width / 2, height - 2, 3]];
      return { party, enemies: weave(corners.map(([x, y, n]) => grab(x, y, n, party))) };
    }
    case 'camp': {
      // Their camp in the middle; the party comes in from the left, the top and the bottom.
      // The party's three ways in go first, so the camp fills the space between them.
      const sides = [[1, mid + jitter(2)], [width * 0.5 + jitter(2), 1], [width * 0.5 + jitter(2), height - 2]];
      const party = weave(sides.map(([x, y]) => grab(x, y, 4)));
      return { party, enemies: grab(width * 0.6 + jitter(1), mid + jitter(1), 12, party) };
    }
    case 'line':
    default: {
      // The party on the left, the monsters on the right, most central first.
      const spawns = (cols: number[]): Pos[] => {
        const out: Pos[] = [];
        for (const x of cols) for (let y = 1; y < height - 1; y++) if (tiles[y * width + x] === '.') out.push({ x, y });
        // Shuffle first so the stable sort breaks distance ties randomly.
        return r.shuffle(out).sort((a, b) => Math.abs(a.y - mid) - Math.abs(b.y - mid));
      };
      return { party: spawns([1, 2]), enemies: spawns([width - 3, width - 2]) };
    }
  }
}

// ---------------------------------------------------------------- the room

/**
 * `act` 1-3 dresses the room for that act and uses the act's plans (0 = a bare room of rocks, for tests).
 * `deployment` is where everyone starts (default: the classic line).
 */
export function generateRoom(kind: NodeType, r: Rng = rng, act = 0, deployment: Deployment = 'line', terrain: Theme['patches'] = []): RoomLayout {
  const { width, height } = roomSpec(kind);
  const mirror = kind === 'boss';
  const plan: Plan = act ? weighted(r, PLANS[mirror ? 'boss' : 'fight']) : 'rocks';
  let tiles = emptyRoom(width, height).join('');

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const b: Builder = { width, height, grid: emptyRoom(width, height), r, mirror };
    BUILDERS[plan](b);
    if (!act) b.grid = b.grid.map((t) => (t === LOW_COVER ? '.' : t)); // bare test rooms: no low cover
    const candidate = b.grid.join('');
    if (connected(width, height, candidate)) {
      tiles = candidate;
      break;
    }
  }

  const grid = tiles.split('');
  const { ground, props } = dress(width, height, grid, act, kind, r, terrain);
  tiles = grid.join('');
  const { party, enemies } = deploy(deployment, width, height, tiles, ground, r);
  return { width, height, tiles, ground, props, plan, deployment, partySpawns: party, enemySpawns: enemies };
}
