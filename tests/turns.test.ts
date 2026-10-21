import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { planFreeWalk } from '../shared/surfaces.ts';
import { AP_GAIN, ATTACK_AP } from '../shared/rules.ts';
import type { ClassId, MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Shared hero turns (your call, 2026-10-20, BG3 style): heroes side by side in the turn order play at the same time. Each
// moves and acts with their own movement and AP, in any order, and ends their own turn; the turn moves on once the last of
// them has. A monster or an NPC ally always acts alone. Rules run through the real Game class (private members reached
// with `any`, as in tests/ap.test.ts).

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-turns-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** Dice that show these numbers (Math.random values). */
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

/**
 * Heroes in a small walled room, in combat, and goblins. `order` lays out the turn order with 'H' for the next hero and
 * 'G' for the next goblin, e.g. 'HHGH'. Monster turns do nothing (the tests drive the rules themselves).
 */
function battle(order: string, classes: ClassId[] = ['fighter', 'cleric', 'rogue']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'TURNS');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const tiles = ['#'.repeat(14), ...Array.from({ length: 8 }, () => `#${'.'.repeat(12)}#`), '#'.repeat(14)].join('');
  Object.assign(g, { width: 14, height: 10, tiles, ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 3, y: 2 + 2 * i }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.runMonster = async () => {};
  const goblins: MonsterEntity[] = [];
  const ids: string[] = [];
  let h = 0;
  for (const c of order) {
    if (c === 'H') ids.push(heroes[h++].id);
    else {
      p.spawnMonster('goblin', { x: 10, y: 2 + 2 * goblins.length }, heroes.length);
      const m = p.entities.at(-1) as MonsterEntity;
      Object.assign(m, { traits: undefined, ward: 0, atkBonus: 0, dmgBonus: 0, hp: 100, maxHp: 100 });
      goblins.push(m);
      ids.push(m.id);
    }
  }
  p.turn = { order: ids, init: {}, index: 0, round: 1, group: [], acts: {} };
  return { g, p, heroes, goblins };
}

/** Who is playing the turn now (not those losing theirs). */
const names = (p: any) => p.turn.group.filter((id: string) => !p.turn.acts[id]?.lost).map((id: string) => p.entity(id)?.name);
const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));

test('heroes side by side in the order share the turn; a monster between them splits it', () => {
  const { p, heroes, goblins } = battle('HHGH');
  const [ann, bob, cid] = heroes;
  p.beginTurn();
  assert.deepEqual(names(p), ['Ann', 'Bob'], 'Ann and Bob play together');
  assert.equal(p.turn.index, 1, 'the turn moves on from the last of them');
  for (const h of [ann, bob]) assert.deepEqual(p.turn.acts[h.id], { moves: h.speed, ap: AP_GAIN }, `${h.name} has their own movement and AP`);
  assert.equal(p.turn.acts[cid.id], undefined, "Cid's turn comes after the goblin's");
  p.handleEndTurn(ann.playerId);
  assert.deepEqual(names(p), ['Bob'], 'Ann is done, Bob still plays');
  p.handleEndTurn(cid.playerId);
  assert.deepEqual(names(p), ['Bob'], "Cid can't end a turn that isn't his");
  p.handleEndTurn(bob.playerId);
  assert.deepEqual(names(p), [goblins[0].name], 'then the goblin, alone');
  p.advanceTurn();
  assert.deepEqual(names(p), ['Cid']);
});

test('the heroes of a shared turn move and act in any order, each with their own AP', () => {
  const { p, heroes, goblins } = battle('HHG', ['fighter', 'fighter']);
  const [ann, bob] = heroes;
  const [goblin] = goblins;
  Object.assign(goblin, { x: 4, y: 3 }); // next to both
  p.beginTurn();
  // Bob swings first, then Ann, then Bob again with the rest of his AP: neither waits for the other.
  assert.equal(dice([showing(15), showing(15), 0.5], () => p.handleSkill(bob.playerId, 'longsword', goblin.id)), true);
  assert.equal(dice([showing(15), showing(15), 0.5], () => p.handleSkill(ann.playerId, 'longsword', goblin.id)), true);
  assert.equal(p.turn.acts[ann.id].ap, AP_GAIN - ATTACK_AP);
  assert.equal(p.turn.acts[bob.id].ap, AP_GAIN - ATTACK_AP, "Ann's swing didn't cost Bob anything");
  p.handleStep(ann.playerId, -1, 0);
  assert.equal(ann.x, 2);
  assert.equal(p.turn.acts[ann.id].moves, ann.speed - 1);
  assert.equal(p.turn.acts[bob.id].moves, bob.speed, "Ann's step didn't cost Bob anything");
  // Unspent AP is saved per hero.
  p.handleEndTurn(ann.playerId);
  assert.equal(ann.savedAp, AP_GAIN - ATTACK_AP);
  assert.equal(p.handleSkill(ann.playerId, 'longsword', goblin.id), false, 'Ann ended her turn');
  assert.equal(p.turn.acts[bob.id].ap, AP_GAIN - ATTACK_AP, 'Bob still has his');
});

test('a monster or an NPC ally always acts alone, and the round turns over between heroes', () => {
  const { p } = battle('HGGH');
  p.beginTurn();
  assert.deepEqual(names(p), ['Ann']);
  p.advanceTurn();
  assert.equal(p.turn.group.length, 1, 'goblins take their turns one by one');
  p.advanceTurn();
  assert.equal(p.turn.group.length, 1);
  p.advanceTurn();
  assert.deepEqual(names(p), ['Bob'], 'last in the round');
  p.advanceTurn();
  assert.equal(p.turn.round, 2);
  assert.deepEqual(names(p), ['Ann'], "a new round: Bob's turn doesn't spill into it");
});

test('a stunned hero loses their part of a shared turn, and the others play on', () => {
  const { p, heroes } = battle('HHG');
  const [ann, bob] = heroes;
  bob.statuses.push({ id: 'stunned', turns: 1 });
  p.beginTurn();
  assert.ok(logged(p, /Bob is stunned and loses the turn/));
  assert.deepEqual(names(p), ['Ann'], 'Ann plays');
  assert.deepEqual(p.turn.acts[bob.id], { moves: 0, ap: 0, lost: true }, 'Bob has nothing to spend');
  assert.equal(p.handleSkill(bob.playerId, 'brace'), false, "he can't act");
  p.handleEndTurn(ann.playerId);
  assert.equal(p.entity(p.turn.group[0])?.kind, 'monster', "Bob's turn ended with Ann's");
  assert.ok(!bob.statuses.some((s) => s.id === 'stunned'), 'the stun wore off at the end of his turn');
});

test('a hero who is down when the shared turn starts and is helped up during it spends the Groggy on this turn', () => {
  const { p, heroes } = battle('HHG');
  const [ann, bob] = heroes;
  Object.assign(ann, { hp: 0, downed: true, x: 3, y: 3 });
  Object.assign(bob, { x: 4, y: 3 });
  dice([showing(12)], () => p.beginTurn());
  assert.deepEqual(names(p), ['Bob']);
  assert.equal(p.handleSkill(bob.playerId, 'help_up', ann.id), true);
  assert.ok(!ann.downed && ann.statuses.some((s) => s.id === 'groggy'));
  p.handleEndTurn(bob.playerId);
  assert.ok(!ann.statuses.some((s) => s.id === 'groggy'), 'this turn was the one she lost');
  p.advanceTurn(); // the goblin
  assert.deepEqual(names(p), ['Ann', 'Bob'], 'next round she plays');
});

test('a downed hero makes their death save, and a hero who goes down on their own turn leaves the shared turn', () => {
  const { p, heroes } = battle('HHHG');
  const [ann, bob, cid] = heroes;
  Object.assign(ann, { hp: 0, downed: true });
  dice([showing(12)], () => p.beginTurn());
  assert.ok(logged(p, /Ann death save: .*success/));
  assert.deepEqual(names(p), ['Bob', 'Cid'], 'still down: Ann loses this turn');
  // Bob takes a hit on his own turn and goes down: Cid plays on.
  p.damage(bob, 999);
  assert.ok(bob.downed);
  p.finishTurn(bob); // the 800 ms after he falls
  assert.deepEqual(names(p), ['Cid']);
  p.handleEndTurn(cid.playerId);
  assert.equal(p.entity(p.turn.group[0])?.kind, 'monster', 'the goblin is next');
});

test('AP given to a hero who is playing the same turn comes right away; otherwise it waits for their next turn', () => {
  const { p, heroes } = battle('HHGH');
  const [ann, bob, cid] = heroes;
  p.beginTurn();
  p.giveAp(bob, 1, ann);
  assert.equal(p.turn.acts[bob.id].ap, AP_GAIN + 1, 'Bob can spend it now');
  p.giveAp(cid, 1, ann);
  assert.equal(cid.statuses.find((s) => s.id === 'emboldened')?.power, 1, 'Cid gets it on his next turn');
});

test('every bot in a shared turn gets its turn played', () => {
  const { p, heroes } = battle('HHG');
  for (const info of p.players as PlayerInfo[]) info.auto = true;
  const played: string[] = [];
  p.playHeroTurn = async (h: PlayerEntity) => {
    played.push(h.name);
  };
  p.beginTurn();
  assert.deepEqual(played, heroes.slice(0, 2).map((h) => h.name));
});

test('a monster that dies during a shared turn keeps the order right', () => {
  const { p, goblins } = battle('GHHG');
  const [first, last] = goblins;
  p.advanceTurn(); // on from the first goblin: Ann and Bob's turn begins
  assert.deepEqual(names(p), ['Ann', 'Bob']);
  p.damage(first, 999);
  assert.ok(!p.entities.includes(first));
  assert.deepEqual(names(p), ['Ann', 'Bob']);
  p.advanceTurn();
  assert.deepEqual(names(p), [last.name], 'the goblin after them, not one skipped or repeated');
});

test('a walk stops where a friend in the same turn just made the way dangerous, and goes on through hazards it planned for', async () => {
  const { g, p, heroes } = battle('HHG');
  const [ann] = heroes;
  p.beginTurn();
  const at = (x: number, y: number) => y * g.width + x;
  // Ann walks right along her row; after her first step, Bob sets the third tile on fire.
  p.startWalk(ann, [{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 6, y: 2 }, { x: 7, y: 2 }], []);
  assert.equal(ann.x, 4, 'the first step is taken at once');
  g.ground[at(6, 2)] = { id: 'fire', turns: 3 };
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual([ann.x, ann.y], [5, 2], 'she stops in front of the new fire');
  // A path planned through a hazard (no other way) still walks into it.
  Object.assign(ann, { x: 3, y: 4 });
  p.turn.acts[ann.id].moves = 6;
  g.ground[at(5, 4)] = { id: 'fire', turns: 3 };
  p.startWalk(ann, [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 }], [{ x: 5, y: 4 }]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(ann.x, 6, 'she knew about that fire');
});

test('bots in a shared turn take theirs one after another, in turn order', async () => {
  const { p, heroes } = battle('HHHG');
  for (const info of p.players as PlayerInfo[]) info.auto = true;
  const seen: string[] = [];
  const real = p.finishTurn.bind(p);
  p.finishTurn = (e: PlayerEntity) => {
    seen.push(`${e.name} done`);
    real(e);
  };
  const start = p.handleSkill.bind(p);
  p.handleSkill = (...args: unknown[]) => {
    seen.push(`${p.hero(args[0]).name} acts`);
    return start(...args);
  };
  p.beginTurn();
  for (let i = 0; i < 400 && p.turn.group.some((id: string) => heroes.some((h) => h.id === id)); i++) await new Promise((r) => setTimeout(r, 50));
  const order = seen.filter((x) => x.endsWith('done')).map((x) => x.split(' ')[0]);
  assert.deepEqual(order, ['Ann', 'Bob', 'Cid'], 'each finishes before the next starts');
  for (const name of ['Bob', 'Cid']) {
    const first = seen.findIndex((x) => x.startsWith(name));
    const before = seen.slice(0, first);
    assert.ok(before.includes(`${name === 'Bob' ? 'Ann' : 'Bob'} done`), `${name} waited: ${seen.join(', ')}`);
  }
});

// ---------------------------------------------------------------- free movement until you act (playtest 1)

test('free movement until you act: walking somewhere and back costs nothing, and a misclick can be undone', () => {
  const { p, heroes } = battle('HG', ['fighter']);
  const [ann] = heroes;
  p.beginTurn();
  const a = p.turn.acts[ann.id];
  const speed = a.moves;
  const start = { x: ann.x, y: ann.y };
  for (let i = 0; i < 3; i++) assert.ok(p.tryMove(ann, { x: ann.x + 1, y: ann.y }));
  assert.equal(a.moves, speed - 3);
  for (let i = 0; i < 3; i++) assert.ok(p.tryMove(ann, { x: ann.x - 1, y: ann.y }));
  assert.deepEqual({ x: ann.x, y: ann.y }, start);
  assert.equal(a.moves, speed, 'back where the turn began: every move is back');
  // Walk to the edge of the area: no moves left, but stepping back toward the start is still allowed.
  for (let i = 0; i < speed; i++) assert.ok(p.tryMove(ann, { x: ann.x + 1, y: ann.y }));
  assert.equal(a.moves, 0);
  assert.equal(p.tryMove(ann, { x: ann.x + 1, y: ann.y }), false, 'not past the edge of the area');
  assert.ok(p.tryMove(ann, { x: ann.x - 1, y: ann.y }), 'but back inside it');
  assert.equal(a.moves, 1);
});

test('acting fixes where you stand: after an action, the moves left count from there', () => {
  const { p, heroes } = battle('HG', ['fighter']);
  const [ann] = heroes;
  p.beginTurn();
  const a = p.turn.acts[ann.id];
  const speed = a.moves;
  assert.ok(p.tryMove(ann, { x: ann.x + 1, y: ann.y }));
  assert.ok(p.tryMove(ann, { x: ann.x + 1, y: ann.y }));
  assert.ok(p.handleSkill(ann.playerId, 'brace'), 'an action');
  assert.equal(a.from, undefined, 'the stretch is over');
  assert.equal(a.moves, speed - 2);
  assert.ok(p.tryMove(ann, { x: ann.x - 1, y: ann.y }));
  assert.equal(a.moves, speed - 3, 'walking back now costs a move');
});

test('a click walks inside the move area; a tile beyond it gets walked toward as far as the area goes', () => {
  const { g, heroes } = battle('HG', ['fighter']);
  const [ann] = heroes;
  const free = () => false;
  const here = { x: ann.x, y: ann.y };
  const near = planFreeWalk(g as any, here, { x: here.x + 2, y: here.y }, { moves: 2 }, free);
  assert.equal(near?.path.length, 2);
  const far = planFreeWalk(g as any, here, { x: here.x + 6, y: here.y }, { moves: 2 }, free);
  assert.deepEqual(far?.path, [{ x: here.x + 1, y: here.y }, { x: here.x + 2, y: here.y }], 'two steps toward it');
  // Out at the edge with no moves left, a click back toward the start still walks.
  const back = planFreeWalk(g as any, { x: here.x + 2, y: here.y }, here, { moves: 0, from: here, budget: 2 }, free);
  assert.equal(back?.path.length, 2);
});
