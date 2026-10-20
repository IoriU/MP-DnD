import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { getEvent } from '../server/events.ts';
import { Game } from '../server/game.ts';
import { makeRng, rng } from '../server/rng.ts';
import { generateRoom, pickDeployment } from '../server/room.ts';
import { ACTS, INJURY_PCT, MONSTERS } from '../shared/rules.ts';
import type { ClassId, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// More events and encounters (Phase 12, 2026-10-20): events can hand out spoils picks, XP and random relics, charge an
// Injury, and start a fight as an ambush; encounter templates can bring their own start (a camp, a pincer) and terrain.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-content-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** A party on the act 1 map. */
function camp(classes: ClassId[] = ['fighter', 'wizard']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'EVENT');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'map';
  return { g, p, heroes };
}

/** Runs with this rng sequence (the game's own rng). */
function seeded<T>(seed: number, fn: () => T): T {
  const r = makeRng(seed);
  const real = rng.next;
  rng.next = () => r.next();
  try {
    return fn();
  } finally {
    rng.next = real;
  }
}

const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));

// ---------------------------------------------------------------- event effects

test('a spoils pick from an event works like one after a fight: for everyone, or only for the hero who made the check', () => {
  const { p, heroes } = camp();
  const [ann, bob] = heroes;
  p.applyEffect({ kind: 'spoils', who: 'all' });
  for (const h of heroes) {
    assert.equal(h.rewardPicks, 1, h.name);
    assert.ok(h.offer, `${h.name} has cards to pick from`);
  }
  p.lastChecker = bob.id;
  p.applyEffect({ kind: 'spoils', who: 'checker' });
  assert.deepEqual([ann.rewardPicks, bob.rewardPicks], [1, 2]);
});

test('an Injury from an event costs max HP until the next rest site, like dying in a fight, and never kills', () => {
  const { p, heroes } = camp();
  const [ann] = heroes;
  const full = ann.maxHp;
  ann.hp = full;
  p.applyEffect({ kind: 'injury', who: 'all' });
  assert.equal(ann.injuries, 1);
  assert.equal(ann.maxHp, Math.round(full * (1 - INJURY_PCT)));
  assert.equal(ann.hp, ann.maxHp, 'HP above the new max is cut back');
  assert.ok(logged(p, /Ann is injured: -20% max HP/));
  p.healInjuries(ann, 'at the rest site');
  assert.equal(ann.maxHp, full);
});

test('XP from an event goes to everyone and can level them up between fights', () => {
  const { p, heroes } = camp();
  p.applyEffect({ kind: 'xp', amount: 50 });
  for (const h of heroes) assert.equal(h.level, 2, `${h.name}: 50 XP is past the 40 a level 2 needs`);
  assert.ok(logged(p, /Everyone gains 50 XP/));
});

test('a relic with no id is a random one the party does not have yet', () => {
  const { p } = camp();
  for (let i = 0; i < 3; i++) p.applyEffect({ kind: 'relic' });
  assert.equal(p.run.relics.length, 3);
  assert.equal(new Set(p.run.relics).size, 3);
  assert.ok(p.run.relics.every((id: string) => id !== 'phoenix_feather'), 'no boss relics');
});

test('an event fight can be an ambush: the party starts surrounded and surprised', () => {
  const { p, heroes } = camp(['fighter', 'wizard', 'cleric']);
  p.run.act = 2;
  p.event = getEvent('bone_organ', 2);
  p.eventCheck = () => ({ ok: false, heroId: heroes[0].id, heroName: 'Ann', text: '🎲 Ann (WIS +0): 2+0=2 vs DC 14, failure' });
  seeded(3, () => p.chooseEventOption('play'));
  assert.equal(p.phase, 'combat');
  assert.ok(logged(p, /Surrounded!/));
  assert.ok(heroes.every((h) => h.statuses.some((s) => s.id === 'surprised')), 'the heroes are caught by surprise');
});

// ---------------------------------------------------------------- encounter templates

test('every act has at least 8 encounter templates, and their twists are real', () => {
  for (const [i, act] of ACTS.entries()) {
    assert.ok(act.encounters.length >= 8, `act ${i + 1}: ${act.encounters.length} templates`);
    for (const e of act.encounters) {
      for (const id of e.monsters) assert.ok(id in MONSTERS, `${e.name}: ${id}`);
      for (const [, n, size] of e.terrain ?? []) assert.ok(n[0] <= n[1] && size[0] <= size[1] && size[0] >= 1, `${e.name}: terrain`);
    }
  }
});

test("an encounter's own start wins over the usual mix, but not over an ambush, a boss or the warm-up", () => {
  for (let s = 0; s < 20; s++) assert.equal(pickDeployment('combat', 'vote', makeRng(s), false, 'camp'), 'camp');
  assert.equal(pickDeployment('combat', 'ambush', makeRng(1), false, 'camp'), 'surrounded');
  assert.equal(pickDeployment('combat', 'vote', makeRng(1), true, 'camp'), 'line');
  assert.equal(pickDeployment('boss', 'charge', makeRng(1), false, 'pincer'), 'line');
});

test("an encounter's terrain is spread on top of the act's: an oil cellar has much more oil", () => {
  const oil = (terrain?: Parameters<typeof generateRoom>[4]) => {
    let n = 0;
    for (let s = 1; s <= 10; s++) n += Object.values(generateRoom('combat', makeRng(s), 1, 'line', terrain).ground).filter((g) => g?.id === 'oil').length;
    return n;
  };
  const cellar = ACTS[0].encounters.find((e) => e.name === 'Oil Cellar')!;
  assert.ok(oil(cellar.terrain) > 2 * oil(), `${oil(cellar.terrain)} oil tiles in 10 cellars vs ${oil()} in 10 plain rooms`);
});

test('a fight node passes its template twist to the room: a Goblin Campfire is their camp', () => {
  const { p } = camp(['fighter', 'wizard', 'cleric']);
  const node = p.run.map.nodes.find((n: { row: number; type: string }) => n.row === 5) ?? p.run.map.nodes[0];
  Object.assign(node, { type: 'combat', row: 5 });
  p.run.act = 1;
  const campfire = ACTS[0].encounters.find((e) => e.name === 'Goblin Campfire')!;
  const real = ACTS[0].encounters;
  ACTS[0].encounters = [campfire];
  try {
    const fight = p.encounterFor(node);
    assert.equal(fight.name, 'Goblin Campfire');
    assert.deepEqual(fight.twist, { deploy: 'camp', terrain: undefined });
    seeded(2, () => p.startRoom('combat', fight.monsters, fight.name, 'vote', false, fight.twist));
    assert.equal(p.fightMeta.deployment, 'camp');
  } finally {
    ACTS[0].encounters = real;
  }
});
