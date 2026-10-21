// Fight rooms. Since playtest 1 (2026-10-21) they are about 1.5x bigger (elites and bosses about 2x) and shaped: a walled
// arena built from one of several plans (scattered rocks, a pillared hall, a wall with gaps, side halls, ruins, a cavern,
// chambers joined by corridors), with low cover to duck behind and pits to shove things into. The fight starts in an
// engagement zone about the size the old rooms were, so the two sides start as far apart as before, and the rest of the
// room is there to flank, fall back and fight over. The deployment is who starts where in that zone: the classic line
// (the party on the left, the monsters on the right), scattered groups, a pincer, surrounded, or their camp in the
// middle with the party coming in from three sides. Each act dresses its rooms differently (shared/surfaces.ts): oil and
// lamps in the Goblin Warrens, water and poison in the Crypt, lava and braziers in the Dragon's Lair.
// Act 0 (tests) is the old bare room: a rectangle of rocks, no cover, no pits, the old sizes.

import { LOW_COVER, PIT, reachable } from '../shared/grid.ts';
import type { GroundId, GroundMap, PropId, PropMap } from '../shared/surfaces.ts';
import type { NodeType, Pos } from '../shared/types.ts';
import { rng, type Rng } from './rng.ts';

export type Plan = 'rocks' | 'pillars' | 'chokepoint' | 'halls' | 'ruins' | 'cavern' | 'chambers';
export type Deployment = 'line' | 'scattered' | 'pincer' | 'surrounded' | 'camp';

/** A stretch of the room: where the fight starts. */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomLayout {
  width: number;
  height: number;
  tiles: string; // '#' wall, 'o' low cover (blocks movement, not sight), 'v' a pit (the same, and whatever falls in...), '.' floor
  ground: GroundMap; // permanent puddles, oil slicks, lava
  props: PropMap;
  plan: Plan;
  deployment: Deployment;
  zone: Zone; // where the fight starts (the camera opens on it)
  partySpawns: Pos[]; // heroes first (groups interleaved, so even a small party is split), then NPC allies
  enemySpawns: Pos[]; // monsters in order, groups interleaved (enemySpawns[0] is where a boss goes)
}

/** What an act scatters around its rooms: [what, how many patches, patch size]. Counts are for an old-size room. */
interface Theme {
  patches: [GroundId, [number, number], [number, number]][];
  props: [PropId, [number, number]][];
  pits: [number, number]; // how many pits a room of this act gets (regular fights; elites and bosses one more)
}

const THEMES: Record<number, Theme> = {
  1: { patches: [['oil', [2, 4], [3, 6]]], props: [['barrel', [1, 3]], ['brazier', [0, 1]]], pits: [0, 2] },
  2: { patches: [['water', [3, 4], [4, 8]], ['poison', [0, 1], [2, 4]]], props: [], pits: [1, 2] },
  3: { patches: [['lava', [1, 3], [2, 4]], ['oil', [0, 1], [3, 5]]], props: [['brazier', [1, 2]], ['barrel', [0, 1]]], pits: [1, 3] },
};

const SHAPES: ReadonlyArray<readonly [number, number]> = [[1, 1], [2, 1], [1, 2], [2, 2]];
const ATTEMPTS = 30;
/** How often each plan comes up (bosses get the open ones, mirrored). */
const PLANS: Record<'fight' | 'boss', [Plan, number][]> = {
  fight: [['rocks', 15], ['pillars', 10], ['chokepoint', 10], ['halls', 10], ['ruins', 15], ['cavern', 20], ['chambers', 20]],
  boss: [['rocks', 35], ['pillars', 35], ['cavern', 30]],
};
/** How often each deployment comes up: regular fights mix them all, elites never scatter you, bosses face you head-on. */
const DEPLOYMENTS: Record<'combat' | 'elite', [Deployment, number][]> = {
  combat: [['line', 25], ['scattered', 30], ['pincer', 20], ['camp', 25]],
  elite: [['line', 40], ['pincer', 25], ['camp', 35]],
};

/** The old room sizes: act 0 rooms, and the engagement zone in the bigger ones. */
const OLD_SIZE: Record<'combat' | 'elite' | 'boss', [number, number]> = { combat: [24, 16], elite: [26, 17], boss: [28, 18] };
/** Room sizes since playtest 1: about 1.5x the old ones, elites and bosses about 2x. */
const SIZE: Record<'combat' | 'elite' | 'boss', [number, number]> = { combat: [36, 24], elite: [46, 30], boss: [50, 32] };

const sizeKey = (kind: NodeType) => (kind === 'elite' ? 'elite' : kind === 'boss' ? 'boss' : 'combat');

export function roomSpec(kind: NodeType, act = 1) {
  const [width, height] = (act ? SIZE : OLD_SIZE)[sizeKey(kind)];
  return { width, height };
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

function emptyRoom(width: number, height: number, fill = '.'): string[] {
  const grid: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.push(x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : fill);
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
// In act 0 rooms every plan keeps columns 1-3 and width-4..width-2 clear, so the classic line always has room to start in.

interface Builder {
  width: number;
  height: number;
  grid: string[];
  r: Rng;
  mirror: boolean;
  margin: number; // columns kept clear on each side (act 0 rooms: the spawn columns)
  scale: number; // the room's area over an old room's: counts of rocks, cover and the like grow with it
}

/** Fills a w×h block at (x, y) with `c` (and its mirror image, for a boss room), inside the clear middle only. */
function block(b: Builder, x: number, y: number, w: number, h: number, c: string) {
  const put = (px: number, py: number) => {
    if (px < b.margin || px > b.width - 1 - b.margin || py < 1 || py > b.height - 2) return;
    b.grid[py * b.width + px] = c;
  };
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      put(x + dx, y + dy);
      if (b.mirror) put(b.width - 1 - (x + dx), y + dy);
    }
  }
}

const many = (b: Builder, lo: number, hi: number) => Math.round(b.r.int(lo, hi) * b.scale);

/** Short runs of low cover: crates, rubble, a broken wall. Only on floor (not into a cave wall). */
function lowCover(b: Builder, count: number) {
  for (let i = 0; i < count; i++) {
    const len = b.r.int(1, 3);
    const across = b.r.next() < 0.5;
    const x = b.r.int(b.margin, b.width - 1 - b.margin);
    const y = b.r.int(1, b.height - 2);
    if (b.grid[y * b.width + x] !== '.') continue;
    block(b, x, y, across ? len : 1, across ? 1 : len, LOW_COVER);
  }
}

function rocks(b: Builder) {
  const n = many(b, 6, 10);
  for (let i = 0; i < n; i++) {
    const [w, h] = b.r.pick(SHAPES);
    block(b, b.r.int(b.margin, b.width - b.margin - w), b.r.int(1, b.height - 1 - h), w, h, '#');
  }
  lowCover(b, many(b, 4, 7));
}

/** A hall of pillars on a grid, a few of them fallen into rubble. */
function pillars(b: Builder) {
  const step = b.r.pick([3, 4]);
  const size = b.mirror ? 2 : 1;
  for (let y = 2 + b.r.int(0, 1); y < b.height - 2; y += step + size - 1) {
    for (let x = b.margin + 1 + b.r.int(0, 1); x < b.width - 1 - b.margin; x += step + size - 1) {
      const roll = b.r.next();
      if (roll < 0.7) block(b, x, y, size, size, '#');
      else if (roll < 0.85) block(b, x, y, 1, 1, LOW_COVER);
    }
  }
  lowCover(b, many(b, 2, 4));
}

/** A wall across the middle with two or three gaps, low cover on both sides of each gap. */
function chokepoint(b: Builder) {
  const x = Math.floor(b.width / 2) + b.r.int(-1, 1);
  block(b, x, 1, 1, b.height - 2, '#');
  const gaps = b.r.int(2, 3) + (b.height > 20 ? 1 : 0);
  const span = (b.height - 2) / gaps;
  for (let g = 0; g < gaps; g++) {
    const y = Math.floor(1 + span * g + b.r.int(1, Math.max(1, Math.floor(span) - 3)));
    block(b, x, y, 1, 2, '.');
    block(b, x - 2, y + b.r.int(-1, 1), 1, 2, LOW_COVER);
    block(b, x + 2, y + b.r.int(-1, 1), 1, 2, LOW_COVER);
  }
  const n = many(b, 2, 4);
  for (let i = 0; i < n; i++) block(b, b.r.int(b.margin, b.width - 2 - b.margin), b.r.int(1, b.height - 3), b.r.int(1, 2), b.r.int(1, 2), '#');
}

/** Two long walls with doorways: a middle hall between two side halls. */
function halls(b: Builder) {
  for (const y of [Math.round(b.height / 3), Math.round((2 * b.height) / 3) - 1]) {
    block(b, b.margin, y, b.width - 2 * b.margin, 1, '#');
    const doors = b.r.int(2, 3) + (b.width > 30 ? 1 : 0);
    const span = (b.width - 2 * b.margin) / doors;
    for (let d = 0; d < doors; d++) block(b, Math.floor(b.margin + span * d + b.r.int(1, Math.max(1, Math.floor(span) - 3))), y, 2, 1, '.');
  }
  lowCover(b, many(b, 4, 6));
}

/** Broken walls everywhere: lots of low cover, a few standing stones. */
function ruins(b: Builder) {
  lowCover(b, many(b, 9, 13));
  const n = many(b, 2, 4);
  for (let i = 0; i < n; i++) block(b, b.r.int(b.margin, b.width - 1 - b.margin), b.r.int(1, b.height - 2), 1, 1, '#');
}

/** A cave: random rock smoothed into winding walls (a cellular automaton); pockets cut off from the rest are filled in. */
function cavern(b: Builder) {
  const { width: w, height: h, r } = b;
  const edge = (i: number) => i % w === 0 || i < w || i % w === w - 1 || i >= w * (h - 1);
  let rock = Array.from({ length: w * h }, (_, i) => edge(i) || r.next() < 0.41);
  for (let pass = 0; pass < 4; pass++) {
    rock = rock.map((was, i) => {
      if (edge(i)) return true;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && rock[i + dy * w + dx]) n++;
      return n >= 5 || (was && n >= 4);
    });
  }
  for (let i = 0; i < w * h; i++) b.grid[i] = rock[i] ? '#' : '.';
  if (b.mirror) for (let y = 0; y < h; y++) for (let x = Math.ceil(w / 2); x < w; x++) b.grid[y * w + x] = b.grid[y * w + (w - 1 - x)];
  keepLargestCave(b);
  lowCover(b, many(b, 3, 5));
}

/** Chambers joined by corridors two tiles wide; the rock between them is solid. */
function chambers(b: Builder) {
  const { width: w, height: h, r } = b;
  b.grid = emptyRoom(w, h, '#');
  const rooms: Zone[] = [];
  for (let tries = 0; tries < 80 && rooms.length < 6; tries++) {
    const rw = r.int(8, 13);
    const rh = r.int(6, 10);
    const x = r.int(1, w - 1 - rw);
    const y = r.int(1, h - 1 - rh);
    if (rooms.some((o) => x < o.x + o.w + 2 && o.x < x + rw + 2 && y < o.y + o.h + 2 && o.y < y + rh + 2)) continue;
    rooms.push({ x, y, w: rw, h: rh });
  }
  for (const c of rooms) for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) b.grid[y * w + x] = '.';
  const mid = (c: Zone) => ({ x: Math.floor(c.x + c.w / 2), y: Math.floor(c.y + c.h / 2) });
  const dig = (x: number, y: number) => {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) if (x + dx > 0 && x + dx < w - 1 && y + dy > 0 && y + dy < h - 1) b.grid[(y + dy) * w + x + dx] = '.';
  };
  const corridor = (a: Pos, c: Pos) => {
    // An L: along one axis, then the other (which one first, by the dice).
    const flip = r.next() < 0.5;
    const [ax, ay, cx, cy] = [a.x, a.y, c.x, c.y];
    for (let x = Math.min(ax, cx); x <= Math.max(ax, cx); x++) dig(x, flip ? cy : ay);
    for (let y = Math.min(ay, cy); y <= Math.max(ay, cy); y++) dig(flip ? ax : cx, y);
  };
  rooms.sort((a, c) => a.x - c.x);
  for (let i = 1; i < rooms.length; i++) corridor(mid(rooms[i - 1]), mid(rooms[i]));
  if (rooms.length > 2) corridor(mid(rooms[0]), mid(rooms[r.int(2, rooms.length - 1)])); // a loop, so there's a way around
  lowCover(b, many(b, 3, 5));
}

const BUILDERS: Record<Plan, (b: Builder) => void> = { rocks, pillars, chokepoint, halls, ruins, cavern, chambers };

/** Floor cut off from the biggest open area is filled with rock. */
function keepLargestCave(b: Builder) {
  const { width: w, height: h } = b;
  const seen = new Set<number>();
  let best: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (b.grid[i] !== '.' || seen.has(i)) continue;
    const region: number[] = [];
    const queue = [i];
    seen.add(i);
    while (queue.length) {
      const j = queue.pop()!;
      region.push(j);
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen.has(k) || b.grid[k] !== '.') continue;
        if (Math.abs((k % w) - (j % w)) > 1) continue;
        seen.add(k);
        queue.push(k);
      }
    }
    if (region.length > best.length) best = region;
  }
  const keep = new Set(best);
  for (let i = 0; i < w * h; i++) if (b.grid[i] === '.' && !keep.has(i)) b.grid[i] = '#';
}

// ---------------------------------------------------------------- dressing

/** A random blob of floor tiles grown from one tile, away from the spawn columns of an act 0 room. */
function blob(width: number, height: number, tiles: string[], size: number, r: Rng, taken: Set<number>, margin = 3): number[] {
  const ok = (x: number, y: number) => x >= margin && x <= width - 1 - margin && y >= 1 && y <= height - 2 && tiles[y * width + x] === '.' && !taken.has(y * width + x);
  for (let attempt = 0; attempt < 20; attempt++) {
    const sx = r.int(margin, width - 1 - margin);
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

/** Pits: small chasms in the floor, as long as the room stays in one piece around them. */
function digPits(width: number, height: number, tiles: string[], n: number, r: Rng) {
  for (let k = 0; k < n; k++) {
    const pit = blob(width, height, tiles, r.int(3, 7), r, new Set(), 2);
    if (pit.length < 2) continue;
    for (const i of pit) tiles[i] = PIT;
    if (!connected(width, height, tiles.join(''))) for (const i of pit) tiles[i] = '.';
  }
}

/** Puddles, slicks and props for the act. Props are walls you can blow up, so they must not cut the room in two. */
function dress(
  width: number, height: number, tiles: string[], act: number, kind: NodeType, r: Rng, terrain: Theme['patches'] = [], area = 1, margin = 3,
): { ground: GroundMap; props: PropMap } {
  const ground: GroundMap = {};
  const props: PropMap = {};
  const theme = THEMES[act];
  if (!theme) return { ground, props };
  const scale = (kind === 'boss' ? 0.5 : 1) * area;
  const taken = new Set<number>();
  for (const [id, count, size] of [...theme.patches, ...terrain]) { // an encounter's own terrain on top of the act's
    const n = Math.round(r.int(count[0], count[1]) * scale);
    for (let k = 0; k < n; k++) {
      for (const i of blob(width, height, tiles, r.int(size[0], size[1]), r, taken, margin)) {
        ground[i] = { id, turns: null };
        taken.add(i);
      }
    }
  }
  for (const [id, count] of theme.props) {
    const n = Math.round(r.int(count[0], count[1]) * (kind === 'boss' ? 1 : scale));
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const x = r.int(Math.max(1, margin + 1), width - 2 - margin);
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
 * The open tiles nearest (by walking) to `at`, up to `n`, skipping `taken`, ground patches, the edge of a pit, and tiles
 * closer than APART to anyone in `away` (the other side).
 */
function cluster(width: number, height: number, tiles: string, ground: GroundMap, at: Pos, n: number, taken: Set<number>, away: Pos[] = []): Pos[] {
  const far = (i: number) => away.every((p) => Math.max(Math.abs(p.x - (i % width)), Math.abs(p.y - Math.floor(i / width))) >= APART);
  const nearPit = (i: number) => [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1].some((d) => tiles[i + d] === PIT);
  const open = (i: number) => tiles[i] === '.' && !taken.has(i) && !ground[i] && far(i) && !nearPit(i); // nobody starts in a puddle, the lava or at the brink
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

/** Everyone's starting tiles for a deployment, inside the engagement zone `z` (anchors in the zone, tiles anywhere nearby). */
function deploy(d: Deployment, z: Zone, width: number, height: number, tiles: string, ground: GroundMap, r: Rng, classicLine: boolean): { party: Pos[]; enemies: Pos[] } {
  const mid = (z.h - 1) / 2;
  const taken = new Set<number>();
  // (x, y) in the zone's own coordinates.
  const grab = (x: number, y: number, n: number, away: Pos[] = []) => {
    const at = { x: Math.round(z.x + Math.max(0, Math.min(z.w - 1, x))), y: Math.round(z.y + Math.max(0, Math.min(z.h - 1, y))) };
    const c = cluster(width, height, tiles, ground, at, n, taken, away);
    for (const p of c) taken.add(p.y * width + p.x);
    return c;
  };
  const jitter = (n: number) => r.int(-n, n);
  switch (d) {
    case 'scattered':
      // The party comes in by two ways on the left; the monsters are spread over the right in three groups.
    {
      const party = weave([grab(2, z.h * 0.22 + jitter(1), 6), grab(2, z.h * 0.78 + jitter(1), 6)]);
      return { party, enemies: weave([grab(z.w - 3, 2 + r.int(0, 2), 5, party), grab(z.w * 0.68 + jitter(1), mid + jitter(2), 5, party), grab(z.w - 3, z.h - 3 - r.int(0, 2), 5, party)]) };
    }
    case 'pincer': {
      // The party in the left-middle, monsters closing in from both ends.
      const party = grab(z.w * 0.4, mid + jitter(1), 9);
      return { party, enemies: weave([grab(z.w - 2, mid + jitter(2), 8, party), grab(1, mid + jitter(3), 6, party)]) };
    }
    case 'surrounded': {
      const party = grab(z.w / 2, mid, 9);
      const corners = [[1, 1, 4], [z.w - 2, z.h - 2, 4], [z.w - 2, 1, 4], [1, z.h - 2, 4], [z.w / 2, 1, 3], [z.w / 2, z.h - 2, 3]];
      return { party, enemies: weave(corners.map(([x, y, n]) => grab(x, y, n, party))) };
    }
    case 'camp': {
      // Their camp in the middle; the party comes in from the left, the top and the bottom.
      // The party's three ways in go first, so the camp fills the space between them.
      const sides = [[1, mid + jitter(2)], [z.w * 0.5 + jitter(2), 1], [z.w * 0.5 + jitter(2), z.h - 2]];
      const party = weave(sides.map(([x, y]) => grab(x, y, 4)));
      return { party, enemies: grab(z.w * 0.6 + jitter(1), mid + jitter(1), 12, party) };
    }
    case 'line':
    default: {
      if (!classicLine) {
        // The party on the left of the zone, the monsters on its right, each gathered around the middle.
        const party = grab(2, mid + jitter(1), 12);
        return { party, enemies: grab(z.w - 3, mid + jitter(1), 14, party) };
      }
      // An act 0 room: the party in the left two columns, the monsters in the right two, most central first.
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

/** The most open of a dozen random old-size stretches of the room (its floor tiles counted). */
function openestZone(tiles: string, width: number, height: number, zw: number, zh: number, r: Rng): Zone {
  let best: Zone = { x: 0, y: 0, w: zw, h: zh };
  let most = -1;
  for (let k = 0; k < 12; k++) {
    const z = { x: r.int(0, width - zw), y: r.int(0, height - zh), w: zw, h: zh };
    let open = 0;
    for (let y = z.y; y < z.y + zh; y++) for (let x = z.x; x < z.x + zw; x++) if (tiles[y * width + x] === '.') open++;
    if (open > most) [best, most] = [z, open];
  }
  return best;
}

/**
 * `act` 1-3 builds a big shaped room dressed for that act (0 = the old bare room of rocks, for tests).
 * `deployment` is where everyone starts (default: the classic line).
 */
export function generateRoom(kind: NodeType, r: Rng = rng, act = 0, deployment: Deployment = 'line', terrain: Theme['patches'] = []): RoomLayout {
  const { width, height } = roomSpec(kind, act);
  const [zw, zh] = OLD_SIZE[sizeKey(kind)];
  const area = (width * height) / (zw * zh);
  const mirror = kind === 'boss';
  const plan: Plan = act ? weighted(r, PLANS[mirror ? 'boss' : 'fight']) : 'rocks';
  const margin = act ? 1 : 4;
  let tiles = emptyRoom(width, height).join('');

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const b: Builder = { width, height, grid: emptyRoom(width, height), r, mirror, margin, scale: area };
    BUILDERS[plan](b);
    if (!act) b.grid = b.grid.map((t) => (t === LOW_COVER ? '.' : t)); // bare test rooms: no low cover
    const candidate = b.grid.join('');
    const open = [...candidate].filter((t) => t === '.').length;
    if (open >= width * height * 0.35 && connected(width, height, candidate)) {
      tiles = candidate;
      break;
    }
  }

  const grid = tiles.split('');
  const theme = THEMES[act];
  if (theme) digPits(width, height, grid, r.int(theme.pits[0], theme.pits[1]) + (kind === 'combat' ? 0 : 1), r);
  const { ground, props } = dress(width, height, grid, act, kind, r, terrain, area, act ? 1 : 3);
  tiles = grid.join('');
  // The engagement zone: an old-size stretch of the room (the whole room in act 0, the middle of a boss's hall), placed
  // where the room is most open, so both sides have floor to start on.
  const zone: Zone = !act ? { x: 0, y: 0, w: width, h: height } : mirror ? { x: Math.floor((width - zw) / 2), y: Math.floor((height - zh) / 2), w: zw, h: zh } : openestZone(tiles, width, height, zw, zh, r);
  const { party, enemies } = deploy(deployment, zone, width, height, tiles, ground, r, !act);
  return { width, height, tiles, ground, props, plan, deployment, zone, partySpawns: party, enemySpawns: enemies };
}
