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
import { CONTINUE_MS } from '../shared/rules.ts';
import type { ClassId, GameState, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Outcome screens (2026-10-20, after "moving to the map feels abrupt"): a won fight, an event's outcome, a treasure and
// a rest each end on their own screen, where everyone reads what happened and picks their spoils. The map comes when
// every person has clicked Continue; the map's banner no longer says what happened.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-outcome-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** A party on the act 1 map; `bots` of them are bots. */
function camp(classes: ClassId[] = ['fighter', 'wizard', 'cleric'], bots = 1) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'AFTER');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    const info = p.players.find((x: PlayerInfo) => x.id === r.playerId);
    if (i >= classes.length - bots) info.bot = true;
    return p.makePlayer(info, 1);
  });
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 100, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'map';
  p.runMonster = async () => {};
  p.runHero = async () => {};
  return { g, p, heroes, state: (): GameState => p.snapshot() };
}

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

/** Starts a fight and wins it. */
function win(p: any, heroes: PlayerEntity[], kind = 'combat', monsters = ['goblin', 'goblin']) {
  seeded(5, () => p.startRoom(kind, monsters, 'Goblin Campfire', 'charge'));
  for (const m of p.monsters()) p.damage(m, 9999, heroes[0]);
  assert.equal(p.checkEnd(), true);
}

test('a won fight ends on a victory screen over the battlefield: the gold, the healing, the damage dealt, and the spoils', () => {
  const { p, heroes, state } = camp();
  win(p, heroes);
  assert.equal(p.phase, 'event');
  assert.ok(p.tiles.length > 0, 'the room stays behind the screen');
  const s = state();
  assert.equal(s.event?.title, 'Victory!');
  assert.match(s.event!.text, /Goblin Campfire: won in \d+ rounds?\./);
  const lines = s.event!.lines!;
  assert.ok(lines.some((l) => /Room cleared! The party loots \d+ gold/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /catches its breath/.test(l)));
  assert.ok(lines.some((l) => /^⚔️ Damage dealt: Ann \d+ · /.test(l)));
  assert.ok(lines.some((l) => /picks their spoils/.test(l)));
  assert.ok(!lines.some((l) => /^[^:]+: "/.test(l)), 'no bot chatter');
  assert.deepEqual(s.event!.choices.map((c) => c.id), ['continue']);
  assert.equal(s.vote?.kind, 'continue');
  for (const h of heroes) assert.ok(h.offer && h.rewardPicks === 1, `${h.name} picks on this screen`);
  assert.equal(s.notice, null, 'nothing on the map banner');
  assert.deepEqual(p.savePoint, { kind: 'map' }, 'a restart lands on the map: the fight is not replayed');
});

test('Continue waits for every person (bots do not count), with a clock that starts at the first click', () => {
  const { p, heroes, state } = camp(['fighter', 'wizard', 'cleric'], 1);
  win(p, heroes);
  const [ann, bob] = p.players;
  p.handleVote(ann.id, 'continue');
  assert.equal(p.phase, 'event', 'Bob is still reading');
  const left = state().vote!.endsInMs!;
  assert.ok(left > CONTINUE_MS - 1000 && left <= CONTINUE_MS, `${left} ms left`);
  p.handleVote(bob.id, 'continue');
  assert.equal(p.phase, 'map');
  assert.equal(p.vote.kind, 'path');
  assert.equal(p.tiles, '', 'the room is gone');
  assert.equal(heroes[0].rewardPicks, 1, 'an untaken pick waits on the map');
});

test('a party of bots moves on by itself', async () => {
  const { p, heroes } = camp(['fighter', 'wizard', 'cleric'], 3);
  win(p, heroes);
  for (let i = 0; i < 40 && p.phase === 'event'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.phase, 'map');
});

test("an event's outcome stays up until everyone continues: the choice, the story, and what it did", () => {
  const { p, state } = camp();
  p.event = getEvent('toll_bridge', 1);
  p.phase = 'event';
  p.chooseEventOption('pay');
  const s = state();
  assert.equal(s.phase, 'event');
  assert.equal(s.event?.title, 'The Goblin Toll Bridge');
  assert.equal(s.event?.chosen, 'Pay the toll');
  assert.match(s.event!.text, /count the coins twice/);
  assert.ok(s.event!.lines!.some((l) => l === '💰 −20 gold (the party has 80).'), s.event!.lines!.join('\n'));
  assert.ok(s.event!.lines!.some((l) => /receives the .+ until the end of the act/.test(l)), 'the blessing it gave');
  assert.equal(s.vote?.kind, 'continue');
  p.moveOn();
  assert.equal(p.phase, 'map');
});

test('an event that starts a fight shows the outcome first, and a restart still replays the event', () => {
  const { p, heroes } = camp();
  const node = p.run.map.nodes[0];
  p.savePoint = { kind: 'node', nodeId: node.id, eventId: 'toll_bridge' };
  p.event = getEvent('toll_bridge', 1);
  p.phase = 'event';
  p.eventCheck = () => ({ ok: false, heroId: heroes[0].id, heroName: 'Ann', text: '🎲 Ann (WIS +0): 2+0=2 vs DC 13, failure' });
  seeded(2, () => p.chooseEventOption('bluff'));
  assert.equal(p.phase, 'event');
  assert.match(p.event.text, /^🎲 Ann .*failure\. "Inspectors/);
  assert.equal(p.event.choices[0].label, '⚔️ Fight!');
  assert.deepEqual(p.savePoint, { kind: 'node', nodeId: node.id, eventId: 'toll_bridge' });
  seeded(2, () => p.moveOn());
  assert.equal(p.phase, 'combat');
  assert.ok(p.monsters().length > 0);
});

test('a treasure and a rest site say what they gave before the map', () => {
  const { p, heroes } = camp();
  p.treasure();
  const take = p.event.choices[0];
  p.chooseEventOption(take.id);
  assert.equal(p.phase, 'event');
  assert.ok(p.event.lines.some((l: string) => /^💰 \+\d+ gold/.test(l)));
  p.moveOn();
  heroes[1].hp = 1;
  p.startRest();
  p.resolveRest();
  assert.equal(p.phase, 'event');
  assert.equal(p.event.title, 'Rest site');
  assert.equal(p.event.lines.filter((l: string) => /takes a Long Rest|trains by the fire/.test(l)).length, heroes.length);
  assert.equal(p.restPicks, null);
  p.moveOn();
  assert.equal(p.phase, 'map');
  assert.equal(p.notice, null);
});

test('the act boss: the victory screen tells the act is done, and the map banner only introduces the next act', () => {
  const { p, heroes } = camp();
  win(p, heroes, 'boss', ['goblin_king']);
  assert.equal(p.phase, 'event');
  assert.equal(p.event.title, 'Act 1 complete!');
  assert.equal(p.run.act, 2, 'the next act is ready behind the screen');
  assert.ok(p.event.lines.some((l: string) => /fully healed/.test(l)));
  assert.match(p.event.choices[0].label, /On to Act 2/);
  p.moveOn();
  assert.equal(p.phase, 'map');
  assert.equal(p.vote.kind, 'path');
  assert.match(p.notice.title, /^Act 2: /);
});
