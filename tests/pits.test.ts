import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { PIT, canStep, fallsIn, hasLOS } from '../shared/grid.ts';
import { PIT_FALL } from '../shared/rules.ts';
import type { ClassId, MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Pits (playtest 1, 2026-10-21): nobody can walk into one, you can see and shoot across, and whatever is shoved in falls.
// A monster is gone (the shover gets the kill); an elite or a boss is harder to shove and may catch the edge; a hero takes
// heavy damage and climbs out, and on Hard the fall kills.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-pits-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

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
const showing = (n: number, sides = 20) => (n - 0.5) / sides;

/** A 12×8 room with a pit at x=6 (rows 2-5), Ann the fighter at (4,3) next to a goblin at (5,3) on its edge. */
function arena(classes: ClassId[] = ['fighter'], difficulty: 'normal' | 'hard' = 'normal') {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'PITS');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const rows = ['#'.repeat(12), ...Array.from({ length: 6 }, (_, y) => `#.....${y >= 1 && y <= 4 ? PIT : '.'}....#`), '#'.repeat(12)];
  Object.assign(g, { width: 12, height: 8, tiles: rows.join(''), ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 4, y: 3 + 2 * i, hp: 40, maxHp: 40 }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1, difficulty };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.runMonster = async () => {};
  p.runHero = async () => {};
  p.spawnMonster('goblin', { x: 5, y: 3 }, heroes.length);
  const goblin = p.entities.at(-1) as MonsterEntity;
  Object.assign(goblin, { hp: 30, maxHp: 30, traits: undefined, ward: 0 });
  p.turn = { order: [heroes[0].id, goblin.id], init: {}, index: 0, round: 1, group: [], acts: {} };
  p.beginTurn([heroes[0].id]);
  return { g, p, heroes, goblin };
}

const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));

test('a pit: nobody walks into it, but you see and shoot across it, and a push toward it goes over the edge', () => {
  const { g } = arena();
  assert.equal(canStep(g as any, { x: 5, y: 3 }, 1, 0), false);
  assert.ok(hasLOS(g as any, { x: 5, y: 3 }, { x: 7, y: 3 }), 'sight crosses a pit');
  assert.ok(fallsIn(g as any, { x: 5, y: 3 }, 1, 0));
  assert.ok(!fallsIn(g as any, { x: 4, y: 3 }, 1, 0), 'one tile short of it');
});

test('a goblin shoved into the pit is gone, and the shover gets the kill', () => {
  const { p, heroes, goblin } = arena();
  const [ann] = heroes;
  const kills = ann.kills;
  dice([showing(18), showing(2)], () => p.handleSkill(ann.playerId, 'shove', goblin.id));
  assert.ok(!p.entities.includes(goblin), 'it fell');
  assert.ok(logged(p, /Goblin falls into the pit!/));
  assert.equal(ann.kills, kills + 1, 'the kill is Ann\'s');
});

test('an elite is harder to shove (it rolls twice), and catches the edge on a good DEX save', () => {
  const { p, heroes, goblin } = arena();
  goblin.elite = true;
  // Ann rolls 15, the elite rolls 3 and 14 (keeps 14): Ann still wins with her STR, then it saves at 19.
  dice([showing(15), showing(3), showing(14), showing(19), showing(2)], () => p.handleSkill(heroes[0].playerId, 'shove', goblin.id));
  assert.ok(p.entities.includes(goblin), 'it caught the edge');
  assert.ok(logged(p, /catches it/));
  assert.ok(goblin.statuses.some((s) => s.id === 'prone'));
});

test('a hero shoved into a pit takes heavy damage and climbs out knocked down, with no movement left', () => {
  const { p, heroes, goblin } = arena();
  const [ann] = heroes;
  Object.assign(ann, { x: 5, y: 3 });
  Object.assign(goblin, { x: 4, y: 3 });
  p.push(ann, goblin, 1, undefined, goblin);
  assert.equal(ann.hp, 40 - Math.ceil(40 * PIT_FALL));
  assert.deepEqual([ann.x, ann.y], [5, 3], 'back up at the edge');
  assert.ok(ann.statuses.some((s) => s.id === 'prone'));
  assert.equal(p.turn.acts[ann.id].moves, 0);
  assert.ok(!ann.dead);
});

test('on Hard the fall kills a hero', () => {
  const { p, heroes, goblin } = arena(['fighter', 'cleric'], 'hard');
  const [ann] = heroes;
  Object.assign(ann, { x: 5, y: 3 });
  Object.assign(goblin, { x: 4, y: 3 });
  p.push(ann, goblin, 1, undefined, goblin);
  assert.ok(ann.dead);
  assert.ok(logged(p, /Ann falls into the pit!/));
});
