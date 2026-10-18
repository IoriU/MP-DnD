// Act map: a Slay-the-Spire-style branching graph of rooms, from row 0 at the bottom up to the boss.

import { ACT_ROWS, MAP_COLS } from '../shared/rules.ts';
import type { ActMap, MapNode, NodeType } from '../shared/types.ts';
import { makeRng, type Rng } from './rng.ts';

export const SHOP_WEIGHT = 0; // shops come in a later phase

const PATHS = 6;
const SIBLING_REROLLS = 20;
const WEIGHTS: ReadonlyArray<readonly [NodeType, number]> = [
  ['combat', 45],
  ['event', 25],
  ['elite', 15],
  ['rest', 12],
  ['shop', SHOP_WEIGHT],
];
const NO_REPEAT: ReadonlySet<NodeType> = new Set(['elite', 'rest', 'shop']);

const nodeId = (act: number, row: number, col: number) => `a${act}-r${row}-c${col}`;

function weighted(r: Rng, table: ReadonlyArray<readonly [NodeType, number]>): NodeType {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let roll = r.next() * total;
  for (const [t, w] of table) if ((roll -= w) < 0) return t;
  return table[table.length - 1][0];
}

export function generateActMap(act: number, seed: number, rows = ACT_ROWS, cols = MAP_COLS): ActMap {
  const r = makeRng(seed * 31 + act);
  // out[row][col] = columns on row + 1 that (row, col) leads to
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => new Set<number>()));
  const used = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));

  let firstStart = -1;
  for (let p = 0; p < PATHS; p++) {
    let c = r.int(0, cols - 1);
    if (p === 1 && cols > 1) while (c === firstStart) c = r.int(0, cols - 1);
    if (p === 0) firstStart = c;
    used[0][c] = true;
    for (let row = 0; row < rows - 1; row++) {
      const options = r.shuffle([c - 1, c, c + 1].filter((n) => n >= 0 && n < cols));
      // Moving diagonally must not cross the opposite diagonal; straight up never crosses.
      const nc =
        options.find(
          (n) => !(n === c + 1 && out[row][c + 1].has(c)) && !(n === c - 1 && out[row][c - 1].has(c)),
        ) ?? c;
      out[row][c].add(nc);
      c = nc;
      used[row + 1][c] = true;
    }
  }

  const bossId = `a${act}-boss`;
  const nodes: MapNode[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!used[row][col]) continue;
      const next =
        row === rows - 1 ? [bossId] : [...out[row][col]].sort((a, b) => a - b).map((n) => nodeId(act, row + 1, n));
      nodes.push({ id: nodeId(act, row, col), row, col, type: 'combat', next });
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map<string, MapNode[]>();
  for (const n of nodes) for (const id of n.next) parents.set(id, [...(parents.get(id) ?? []), n]);

  const midRow = Math.floor(rows / 2);
  const typed = new Set<string>();
  for (const n of nodes) {
    if (n.row === 0) n.type = 'combat';
    else if (n.row === rows - 1) n.type = 'rest';
    else if (n.row === midRow) n.type = 'treasure';
    else {
      const ps = parents.get(n.id) ?? [];
      const table = WEIGHTS.filter(([t, w]) => {
        if (w <= 0) return false;
        if ((t === 'elite' || t === 'rest') && n.row < 4) return false;
        if (t === 'rest' && n.row === rows - 2) return false;
        return !(NO_REPEAT.has(t) && ps.some((p) => p.type === t));
      });
      const siblingTypes = new Set(
        ps
          .flatMap((p) => p.next)
          .filter((id) => id !== n.id && typed.has(id))
          .map((id) => byId.get(id)!.type),
      );
      let type = weighted(r, table);
      for (let i = 0; i < SIBLING_REROLLS && siblingTypes.has(type); i++) type = weighted(r, table);
      n.type = type;
    }
    typed.add(n.id);
  }

  nodes.push({ id: bossId, row: rows, col: Math.floor(cols / 2), type: 'boss', next: [] });
  return { act, rows, cols, nodes, bossId };
}
