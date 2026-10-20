import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { PICK_WAIT_MS } from '../shared/rules.ts';
import type { ClassId, GameState, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Auto-play for people who want to build their hero and let the AI fight (2026-10-20): with auto-play on, the AI plays
// your turns, but each spoils or level-up pick (and the rest-site choice) waits PICK_WAIT_MS for you first. Bots, and
// players who dropped out, still pick right away.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-autopick-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

/** Ann (auto-play on), Bob (playing by hand) and Cid (a bot), on the act 1 map. */
function camp(classes: ClassId[] = ['fighter', 'wizard', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'AUTO');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    const info = p.players.find((x: PlayerInfo) => x.id === r.playerId);
    if (i === 2) Object.assign(info, { bot: true, auto: true });
    return p.makePlayer(info, 1);
  });
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 100, relics: [], blessings: [], allies: [], seed: 1, difficulty: 'normal' };
  p.phase = 'map';
  p.runMonster = async () => {};
  p.runHero = async () => {};
  const [ann, bob, cid] = p.players as PlayerInfo[];
  g.handleSetAuto(ann.id, true);
  return { g, p, heroes, ann, bob, cid, state: (): GameState => p.snapshot() };
}

const picks = (h: PlayerEntity) => h.levelUps + h.elitePicks + (h.rewardPicks ?? 0);

/** Makes one pick by hand (the first card that goes through). */
function pickOne(p: any, playerId: string) {
  const h: PlayerEntity = p.hero(playerId);
  const left = picks(h);
  for (let card = 0; card < (h.offer?.length ?? 0) && picks(h) === left; card++) p.handlePick(playerId, { card });
  assert.equal(picks(h), left - 1, `${h.name} made a pick`);
}

function win(p: any, heroes: PlayerEntity[]) {
  p.startRoom('combat', ['goblin'], 'Test', 'charge');
  for (const m of p.monsters()) p.damage(m, 9999, heroes[0]);
  assert.equal(p.checkEnd(), true);
}

test('with auto-play on, a person gets 10 seconds to pick their spoils; a bot picks right away', () => {
  const { p, heroes, ann, state } = camp();
  const [annHero, , cidHero] = heroes;
  win(p, heroes);
  assert.equal(state().autoPicks[ann.id], PICK_WAIT_MS, 'the countdown goes out with the state');
  mock.timers.tick(1000);
  assert.equal(cidHero.rewardPicks, 0, 'the bot picked');
  assert.equal(annHero.rewardPicks, 1, 'Ann still has time');
  mock.timers.tick(PICK_WAIT_MS - 1000 - 1);
  assert.equal(annHero.rewardPicks, 1);
  mock.timers.tick(1);
  assert.equal(annHero.rewardPicks, 0, 'auto-play picked for her');
  assert.equal(state().autoPicks[ann.id], undefined);
});

test('picking in time is your own pick, and the next pick gets a fresh 10 seconds', () => {
  const { p, heroes, ann, state } = camp();
  const [annHero] = heroes;
  win(p, heroes);
  annHero.rewardPicks = (annHero.rewardPicks ?? 0) + 1;
  const left = picks(annHero);
  mock.timers.tick(6000);
  pickOne(p, ann.id);
  assert.equal(state().autoPicks[ann.id], PICK_WAIT_MS, 'a fresh countdown for the next pick');
  mock.timers.tick(PICK_WAIT_MS);
  assert.equal(picks(annHero), left - 2, 'auto-play made the next one');
});

test('turning auto-play off stops the countdown, and turning it on starts one', () => {
  const { g, p, heroes, ann, state } = camp();
  const [annHero] = heroes;
  win(p, heroes);
  g.handleSetAuto(ann.id, false);
  assert.equal(state().autoPicks[ann.id], undefined);
  mock.timers.tick(PICK_WAIT_MS * 3);
  assert.equal(annHero.rewardPicks, 1, 'by hand, the pick waits for you as long as you like');
  g.handleSetAuto(ann.id, true);
  assert.equal(state().autoPicks[ann.id], PICK_WAIT_MS);
  mock.timers.tick(PICK_WAIT_MS);
  assert.equal(annHero.rewardPicks, 0);
});

test('the victory screen waits for a person on auto-play to finish picking, then moves on by itself', () => {
  const { p, heroes, bob } = camp();
  win(p, heroes);
  p.handleVote(bob.id, 'continue');
  mock.timers.tick(1000);
  assert.equal(p.phase, 'event', 'Ann is still picking');
  mock.timers.tick(PICK_WAIT_MS);
  assert.equal(p.phase, 'map', 'her pick was made, and Bob had clicked Continue');
});

test('alone on auto-play: the victory screen stays up while you pick, and moves on as soon as you have', () => {
  const { g, p, heroes, bob } = camp();
  g.handleSetAuto(bob.id, true);
  win(p, heroes);
  mock.timers.tick(2000);
  assert.equal(p.phase, 'event', 'not the bots-only 0.7 seconds');
  for (const pl of [p.players[0], bob]) while (picks(p.hero(pl.id)) > 0) pickOne(p, pl.id);
  assert.equal(p.phase, 'map');
});

test('a rest site: a person on auto-play gets 10 seconds to choose Long Rest or Train', () => {
  const { p, heroes, ann, cid, state } = camp();
  p.startRest();
  mock.timers.tick(1000);
  assert.ok(p.restPicks[cid.id], 'the bot chose');
  assert.equal(p.restPicks[ann.id], undefined);
  assert.equal(state().rest!.autoInMs, PICK_WAIT_MS - 1000);
  p.handleRest(p.players[1].id, { kind: 'long' });
  mock.timers.tick(PICK_WAIT_MS - 1000);
  assert.equal(p.phase, 'event', 'auto-play chose for Ann, and the rest is done');
  assert.equal(p.event.lines.length, heroes.length);
});
