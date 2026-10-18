import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import type { GameState, PlayerEntity } from '../shared/types.ts';
import { Game } from '../server/game.ts';
import { archiveSave, hasSave, listSaves, readSave } from '../server/saves.ts';

process.env.DELVERS_SAVES = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-saves-'));
after(() => fs.rmSync(process.env.DELVERS_SAVES!, { recursive: true, force: true }));

const games: Game[] = [];
after(() => games.forEach((g) => g.dispose()));

/** A stand-in for Socket.IO that remembers the last state each room was sent. */
function room(code: string, save?: ReturnType<typeof readSave>) {
  let last: GameState | null = null;
  const io = { to: () => ({ emit: (event: string, data: unknown) => event === 'state' && (last = data as GameState) }) } as unknown as Server;
  const g = save ? Game.fromSave(io, save) : new Game(io, code);
  games.push(g);
  const state = async () => {
    await new Promise((r) => setImmediate(r)); // broadcasts go out on the next microtask
    return last!;
  };
  return { g, state };
}

const heroes = (s: GameState) => s.entities.filter((e): e is PlayerEntity => e.kind === 'player');
const join = (g: Game, name: string, playerId?: string) => {
  const res = g.join(playerId, name, 'wizard');
  assert.ok(res.ok);
  return res.playerId;
};

test('a run is saved on the map and comes back with the same heroes and map', async () => {
  const { g, state } = room('SAVE');
  const ann = join(g, 'Ann');
  g.addBot(ann);
  g.start(ann);
  const before = await state();
  assert.equal(before.phase, 'map');
  const save = readSave('SAVE');
  assert.ok(save, 'a save file was written');
  assert.deepEqual(save.at, { kind: 'map' });
  assert.equal(save.heroes.length, 2);
  g.dispose();

  // The server restarts: the room comes back from disk and waits in the tavern.
  const back = room('SAVE', readSave('SAVE'));
  assert.equal(join(back.g, 'ann'), ann, 'typing the same name (any case) reclaims the hero');
  const lobby = await back.state();
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.resume?.heroes.length, 2);
  back.g.start(ann);
  const after = await back.state();
  assert.equal(after.phase, 'map');
  assert.equal(after.run?.seed, before.run?.seed);
  assert.deepEqual(after.vote?.options, before.vote?.options, 'same spot on the same map');
  assert.deepEqual(
    heroes(after).map((h) => [h.name, h.classId, h.level, h.maxHp, h.skills.map((s) => s.id)]),
    heroes(before).map((h) => [h.name, h.classId, h.level, h.maxHp, h.skills.map((s) => s.id)]),
  );
  assert.ok(after.players.find((p) => p.name !== 'Ann')?.bot, 'the bot is still a bot');
});

test('a node in progress is replayed from its start', async () => {
  const { g, state } = room('NODE');
  const ann = join(g, 'Ann');
  g.start(ann);
  const map = await state();
  const node = map.vote!.options[0];
  g.handleVote(ann, node); // a single human vote resolves at once: into the first fight
  assert.equal((await state()).phase, 'combat');
  const save = readSave('NODE');
  assert.deepEqual(save?.at, { kind: 'node', nodeId: node });
  assert.equal(save?.run.currentId, null, 'saved before the node changed anything');
  g.dispose();

  const back = room('NODE', readSave('NODE'));
  join(back.g, 'Ann', ann);
  back.g.start(ann);
  const s = await back.state();
  assert.equal(s.phase, 'combat');
  assert.equal(s.run?.currentId, node);
  assert.deepEqual(s.run?.visited, [node]);
});

test('a newcomer can take over a saved hero whose player is away', async () => {
  const { g } = room('CLAI');
  const ann = join(g, 'Ann');
  const cid = join(g, 'Cid');
  g.start(ann);
  g.dispose();

  const back = room('CLAI', readSave('CLAI'));
  const ann2 = join(back.g, 'Ann');
  const bob = join(back.g, 'Bob'); // no hero by that name: joins unassigned
  let s = await back.state();
  assert.equal(s.resume?.heroes.some((h) => h.playerId === bob), false);
  back.g.claimHero(bob, cid);
  s = await back.state();
  assert.ok(s.resume?.heroes.some((h) => h.playerId === bob), 'Cid now belongs to Bob');
  assert.equal(s.players.find((p) => p.id === bob)?.name, 'Cid');
  assert.equal(s.players.length, 2);
  back.g.start(ann2);
  s = await back.state();
  assert.deepEqual(heroes(s).map((h) => h.name).sort(), ['Ann', 'Cid']);
});

test('saves are listed newest first and archived runs leave the list', async () => {
  assert.ok(listSaves().length >= 3);
  assert.ok(listSaves().every((s, i, all) => i === 0 || all[i - 1].savedAt >= s.savedAt));
  archiveSave('CLAI', 'abandoned');
  assert.equal(hasSave('CLAI'), false);
  assert.ok(!listSaves().some((s) => s.code === 'CLAI'));
  assert.ok(fs.readdirSync(path.join(process.env.DELVERS_SAVES!, 'archive')).some((n) => n.startsWith('CLAI-abandoned')));
  assert.equal(readSave('../etc'), null, 'codes are four letters, nothing else');
});
