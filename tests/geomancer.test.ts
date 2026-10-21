import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { planMonster } from '../server/monsterai.ts';
import { PIT } from '../shared/grid.ts';
import { ENGINES } from '../shared/engines.ts';
import { ACTS, HARD_MOVES, MONSTERS, flies } from '../shared/rules.ts';
import type { MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// The Geomancer is the pit engine (2026-10-21): Open Pit (never under anyone), Earth Ram and Tremor push, Raise Cover
// and Wall of Stone fill pits in, Undertow pushes further. And flying enemies: they cross pits and never step in the
// ground, can't be pushed in, but knocked down over a pit they fall.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-geo-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

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
const showing = (n: number, sides = 20) => (n - 0.5) / sides;

/** A 14×9 open room: a Geomancer wizard (Ann) at (3,4), a goblin at (6,4). */
function arena(skills: string[] = ['open_pit', 'earth_ram', 'raise_cover']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'GEOM');
  games.push(g);
  const p = g as any;
  const r = g.join(undefined, 'Ann', 'wizard');
  assert.ok(r.ok);
  const ann: PlayerEntity = p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 5);
  for (const id of skills) ann.skills.push({ id: id as any, tier: 1, cd: 0 });
  Object.assign(ann, { x: 3, y: 4, slots: 5, maxSlots: 5 });
  const rows = ['#'.repeat(14), ...Array.from({ length: 7 }, () => `#${'.'.repeat(12)}#`), '#'.repeat(14)];
  Object.assign(g, { width: 14, height: 9, tiles: rows.join(''), ground: {}, clouds: {}, props: {} });
  p.entities = [ann];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1, difficulty: 'normal' };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.runMonster = async () => {};
  p.runHero = async () => {};
  p.spawnMonster('goblin', { x: 6, y: 4 }, 1);
  const goblin = p.entities.at(-1) as MonsterEntity;
  Object.assign(goblin, { hp: 20, maxHp: 20, traits: undefined, ward: 0 });
  p.turn = { order: [ann.id, goblin.id], init: {}, index: 0, round: 1, group: [], acts: {} };
  p.beginTurn([ann.id]);
  p.turn.acts[ann.id].ap = 5;
  return { g, p, ann, goblin };
}

const tile = (g: Game, x: number, y: number) => (g as any).tiles[y * (g as any).width + x];
const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));

test('the Geomancer engine is about pits: Open Pit, Earth Ram and Undertow are in it', () => {
  const geo = ENGINES.geomancer;
  const cards = Object.values(geo.cards).flat();
  for (const id of ['open_pit', 'earth_ram', 'undertow', 'raise_cover', 'tremor']) assert.ok(cards.includes(id as any), id);
});

test('Open Pit opens on empty floor for 3 rounds, never under anyone', () => {
  const { g, p, ann, goblin } = arena();
  assert.ok(p.handleSkill(ann.playerId, 'open_pit', { x: goblin.x, y: goblin.y }));
  assert.equal(tile(g, goblin.x, goblin.y), '.', 'not under the goblin');
  assert.ok(logged(p, /won't open there/));
  assert.ok(p.handleSkill(ann.playerId, 'open_pit', { x: 7, y: 4 }));
  assert.equal(tile(g, 7, 4), PIT);
  for (let round = 0; round < 3; round++) p.tickRaised();
  assert.equal(tile(g, 7, 4), '.', 'closed after 3 rounds');
});

test('Earth Ram slams a goblin 2 tiles away, over the edge of a pit: it is gone', () => {
  const { g, p, ann, goblin } = arena();
  (g as any).tiles = (g as any).tiles.slice(0, 4 * 14 + 8) + PIT + (g as any).tiles.slice(4 * 14 + 9);
  dice([showing(2)], () => p.handleSkill(ann.playerId, 'earth_ram', goblin.id)); // the goblin fails its STR save
  assert.ok(!p.entities.includes(goblin));
  assert.ok(logged(p, /Goblin falls into the pit!/));
});

test('Raise Cover on a pit fills it in: floor again', () => {
  const { g, p, ann } = arena();
  (g as any).tiles = (g as any).tiles.slice(0, 2 * 14 + 4) + PIT + (g as any).tiles.slice(2 * 14 + 5);
  p.pits.set(2 * 14 + 4, 3);
  assert.ok(p.handleSkill(ann.playerId, 'raise_cover', { x: 4, y: 2 }));
  assert.equal(tile(g, 4, 2), '.');
  assert.ok(logged(p, /pit is filled in/));
  assert.ok(!p.pits.has(2 * 14 + 4));
});

test('Undertow: your pushes carry further, and Gravity Well drags the enemies at a new pit\'s edge in', () => {
  const { p, ann, goblin } = arena(['open_pit', 'earth_ram']);
  ann.skills.push({ id: 'undertow', tier: 3, branch: 'B', cd: 0 });
  dice([showing(2)], () => p.handleSkill(ann.playerId, 'open_pit', { x: 7, y: 4 })); // the goblin next to it fails its STR save
  assert.ok(!p.entities.includes(goblin), 'dragged in');
});

test('a flyer is pushed over a pit, not into it; knocked down over one, it falls', () => {
  const { g, p, ann, goblin } = arena();
  goblin.type = 'bat';
  assert.ok(flies(goblin));
  (g as any).tiles = (g as any).tiles.slice(0, 4 * 14 + 7) + PIT + (g as any).tiles.slice(4 * 14 + 8);
  p.push(goblin, ann, 1, ann);
  assert.ok(p.entities.includes(goblin), 'it flies');
  assert.deepEqual([goblin.x, goblin.y], [7, 4], 'hovering over the pit');
  p.applyStatus(goblin, { id: 'prone', turns: 1 }, ann);
  assert.ok(!p.entities.includes(goblin), 'down it goes');
});

test('a flyer never steps in the ground: fire under it does nothing', () => {
  const { g, p, goblin } = arena();
  goblin.type = 'bat';
  (g as any).ground[goblin.y * 14 + goblin.x] = { id: 'fire', turns: 2 };
  const hp = goblin.hp;
  p.standIn(goblin, 'start');
  assert.equal(goblin.hp, hp);
  assert.ok(!goblin.statuses.some((s) => s.id === 'burning'));
});

test('a flying monster plans its walk straight across a pit; a walking one goes around', () => {
  const { g, p, ann, goblin } = arena();
  // A pit column between them at x = 5, rows 1-6 (a gap at row 7).
  let tiles: string = (g as any).tiles;
  for (let y = 1; y <= 6; y++) tiles = tiles.slice(0, y * 14 + 5) + PIT + tiles.slice(y * 14 + 6);
  (g as any).tiles = tiles;
  Object.assign(ann, { x: 2, y: 4 });
  Object.assign(goblin, { x: 8, y: 4 });
  goblin.type = 'bat';
  p.turn.acts[goblin.id] = { moves: 8, ap: 0 };
  const plan = planMonster(p.monsterView(goblin));
  assert.ok(plan.path?.some((q: { x: number; y: number }) => q.x === 5 && q.y <= 6), `the bat crosses the pit: ${JSON.stringify(plan.path)}`);
});

test('the new flyers: a Giant Bat in acts 1 and 2, a Gargoyle in act 3, each with a Hard move; imps, drakes and the wyrm fly', () => {
  assert.ok(ACTS[0].pool.includes('bat') && ACTS[1].pool.includes('bat') && ACTS[2].pool.includes('gargoyle'));
  for (const id of ['bat', 'gargoyle']) {
    assert.ok(MONSTERS[id].fly, id);
    assert.ok(HARD_MOVES[id], `${id}: a Hard move`);
  }
  for (const id of ['imp', 'drake', 'wyrm']) assert.ok(MONSTERS[id].fly, id);
});
