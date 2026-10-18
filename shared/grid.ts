// Grid helpers: distance, line of sight, field of view and pathfinding.

import type { Pos } from './types.ts';

export interface MapLike {
  width: number;
  height: number;
  tiles: string;
}

/** 8-directional moves, orthogonal first so paths look natural. */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Grid distance where diagonals count as 1 (the 5e "every square is 5 ft" rule). */
export const dist = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export function isWall(m: MapLike, x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= m.width || y >= m.height || m.tiles[y * m.width + x] === '#';
}

/** Can you step from `from` by (dx, dy)? Diagonal steps may not squeeze past wall corners. */
export function canStep(m: MapLike, from: Pos, dx: number, dy: number): boolean {
  if (isWall(m, from.x + dx, from.y + dy)) return false;
  if (dx !== 0 && dy !== 0 && (isWall(m, from.x + dx, from.y) || isWall(m, from.x, from.y + dy))) return false;
  return true;
}

/** Bresenham line from a to b, inclusive of both ends. */
export function line(a: Pos, b: Pos): Pos[] {
  const pts: Pos[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push({ x, y });
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

/** True if no wall lies strictly between a and b. */
export function hasLOS(m: MapLike, a: Pos, b: Pos): boolean {
  const pts = line(a, b);
  for (let i = 1; i < pts.length - 1; i++) if (isWall(m, pts[i].x, pts[i].y)) return false;
  return true;
}

/** Tile indices visible from any of the origins within `radius`. */
export function computeFov(m: MapLike, origins: Pos[], radius: number): Set<number> {
  const vis = new Set<number>();
  const r2 = radius * radius + radius;
  for (const o of origins) {
    for (let y = o.y - radius; y <= o.y + radius; y++) {
      for (let x = o.x - radius; x <= o.x + radius; x++) {
        if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
        const idx = y * m.width + x;
        if (vis.has(idx)) continue;
        if ((x - o.x) ** 2 + (y - o.y) ** 2 > r2) continue;
        if (hasLOS(m, o, { x, y })) vis.add(idx);
      }
    }
  }
  return vis;
}

/**
 * Breadth-first search from `start` to the nearest tile where `goal` is true.
 * Returns the steps to take (excluding start), [] if start already satisfies goal, or null if unreachable.
 */
export function findPath(
  m: MapLike,
  start: Pos,
  blocked: (x: number, y: number) => boolean,
  goal: (x: number, y: number) => boolean,
): Pos[] | null {
  if (goal(start.x, start.y)) return [];
  const w = m.width;
  const prev = new Int32Array(w * m.height).fill(-1);
  const startIdx = start.y * w + start.x;
  prev[startIdx] = startIdx;
  const queue = [startIdx];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!canStep(m, { x: cx, y: cy }, dx, dy)) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -1 || blocked(nx, ny)) continue;
      prev[ni] = cur;
      if (goal(nx, ny)) {
        const path: Pos[] = [];
        for (let i = ni; i !== startIdx; i = prev[i]) path.push({ x: i % w, y: Math.floor(i / w) });
        return path.reverse();
      }
      queue.push(ni);
    }
  }
  return null;
}

/** All tiles reachable within `maxSteps`, as index -> steps needed. */
export function reachable(m: MapLike, start: Pos, maxSteps: number, blocked: (x: number, y: number) => boolean): Map<number, number> {
  const w = m.width;
  const out = new Map<number, number>([[start.y * w + start.x, 0]]);
  let frontier: Pos[] = [start];
  for (let step = 1; step <= maxSteps && frontier.length; step++) {
    const next: Pos[] = [];
    for (const p of frontier) {
      for (const [dx, dy] of DIRS) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        const ni = ny * w + nx;
        if (out.has(ni) || !canStep(m, p, dx, dy) || blocked(nx, ny)) continue;
        out.set(ni, step);
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return out;
}
