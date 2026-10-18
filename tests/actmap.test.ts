import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateActMap } from '../server/actmap.ts';
import type { ActMap, MapNode } from '../shared/types.ts';

const SEEDS = 300;
const ACTS = [1, 2, 3];

const maps: ActMap[] = [];
for (let seed = 0; seed < SEEDS; seed++) for (const act of ACTS) maps.push(generateActMap(act, seed));

const label = (m: ActMap) => `act ${m.act}, ${m.nodes.length} nodes`;
const onRow = (m: ActMap, row: number) => m.nodes.filter((n) => n.row === row);
const normal = (m: ActMap) => m.nodes.filter((n) => n.id !== m.bossId);

function check(name: string, fn: (m: ActMap) => void) {
  test(name, () => {
    for (const [i, m] of maps.entries()) {
      try {
        fn(m);
      } catch (e) {
        throw new Error(`seed ${Math.floor(i / ACTS.length)}, ${label(m)}: ${(e as Error).message}`, { cause: e });
      }
    }
  });
}

check('ids, ordering and boss placement', (m) => {
  const ids = m.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  for (const n of normal(m)) assert.equal(n.id, `a${m.act}-r${n.row}-c${n.col}`);
  const sorted = [...m.nodes].sort((a, b) => a.row - b.row || a.col - b.col);
  assert.deepEqual(ids, sorted.map((n) => n.id));
  const boss = m.nodes[m.nodes.length - 1];
  assert.equal(boss.id, m.bossId);
  assert.equal(boss.id, `a${m.act}-boss`);
  assert.equal(boss.type, 'boss');
  assert.equal(boss.row, m.rows);
  assert.equal(boss.col, Math.floor(m.cols / 2));
  assert.deepEqual(boss.next, []);
  for (const n of normal(m)) {
    assert.ok(n.row >= 0 && n.row < m.rows && n.col >= 0 && n.col < m.cols, `${n.id} out of bounds`);
    assert.notEqual(n.type, 'boss');
  }
});

check('fixed rows: combat start, treasure middle, rest before the boss', (m) => {
  for (const n of onRow(m, 0)) assert.equal(n.type, 'combat', n.id);
  for (const n of onRow(m, m.rows - 1)) assert.equal(n.type, 'rest', n.id);
  const mid = onRow(m, Math.floor(m.rows / 2));
  assert.ok(mid.length > 0);
  for (const n of mid) assert.equal(n.type, 'treasure', n.id);
});

check('no elite or rest below row 4, no rest on row rows-2', (m) => {
  for (const n of m.nodes) {
    if (n.row < 4) assert.ok(n.type !== 'elite' && n.type !== 'rest', `${n.id} is ${n.type}`);
    if (n.row === m.rows - 2) assert.notEqual(n.type, 'rest', n.id);
  }
});

check('at least 2 starting nodes', (m) => {
  assert.ok(onRow(m, 0).length >= 2);
});

check('every node leads exactly one row up, and every node above row 0 has a parent', (m) => {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const hasParent = new Set<string>();
  for (const n of normal(m)) {
    assert.ok(n.next.length >= 1, `${n.id} is a dead end`);
    assert.equal(new Set(n.next).size, n.next.length, `${n.id} has duplicate links`);
    for (const id of n.next) {
      const to = byId.get(id);
      assert.ok(to, `${n.id} links to missing ${id}`);
      assert.equal(to.row, n.row + 1, `${n.id} -> ${id}`);
      if (to.id !== m.bossId) assert.ok(Math.abs(to.col - n.col) <= 1, `${n.id} -> ${id} jumps columns`);
      hasParent.add(id);
    }
    const cols = n.next.map((id) => byId.get(id)!.col);
    assert.deepEqual(cols, [...cols].sort((a, b) => a - b), `${n.id} next not sorted by col`);
  }
  for (const n of m.nodes) if (n.row > 0) assert.ok(hasParent.has(n.id), `${n.id} has no parent`);
  for (const n of onRow(m, m.rows - 1)) assert.deepEqual(n.next, [m.bossId]);
});

check('no crossing edges', (m) => {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  for (let row = 0; row < m.rows - 1; row++) {
    const edges = onRow(m, row).flatMap((n) => n.next.map((id) => [n.col, byId.get(id)!.col] as const));
    for (const [a, b] of edges) {
      for (const [c, d] of edges) assert.ok(!(a < c && b > d), `row ${row}: ${a}->${b} crosses ${c}->${d}`);
    }
  }
});

check('elite, rest and shop never directly follow the same type', (m) => {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  for (const n of m.nodes) {
    if (n.type !== 'elite' && n.type !== 'rest' && n.type !== 'shop') continue;
    for (const id of n.next) assert.notEqual(byId.get(id)!.type, n.type, `${n.id} -> ${id}`);
  }
});

test('same seed and act give the same map', () => {
  for (let seed = 0; seed < 50; seed++) {
    for (const act of ACTS) assert.deepEqual(generateActMap(act, seed), generateActMap(act, seed));
  }
});

test('different seeds or acts usually differ', () => {
  const key = (m: ActMap) => JSON.stringify(m.nodes.map((n: MapNode) => [n.row, n.col, n.type, n.next.length]));
  let sameSeed = 0;
  let sameAct = 0;
  for (let seed = 0; seed < 100; seed++) {
    if (key(generateActMap(1, seed)) === key(generateActMap(1, seed + 1000))) sameSeed++;
    if (key(generateActMap(1, seed)) === key(generateActMap(2, seed))) sameAct++;
  }
  assert.ok(sameSeed <= 2, `${sameSeed} identical maps across seeds`);
  assert.ok(sameAct <= 2, `${sameAct} identical maps across acts`);
});

test('a smaller custom map still follows the rules', () => {
  const m = generateActMap(1, 7, 8, 5);
  assert.equal(m.rows, 8);
  assert.equal(m.cols, 5);
  assert.equal(m.nodes[m.nodes.length - 1].row, 8);
  assert.equal(m.nodes[m.nodes.length - 1].col, 2);
  for (const n of m.nodes) if (n.id !== m.bossId) assert.ok(n.col < 5 && n.row < 8);
});
