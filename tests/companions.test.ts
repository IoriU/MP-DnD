import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import {
  BOT_NAMES, CALLOUT_ODDS, LINES, MAX_PER_BEAT, PLACEHOLDERS, URGENT, VOICE, calloutLine, newChatter, tryCallout, voiceOf,
  type CallEvent, type CallVars,
} from '../server/companions.ts';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { rng } from '../server/rng.ts';
import { ACTS } from '../shared/rules.ts';
import type { MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Bot callouts (server/companions.ts): the voices and lines as plain data, the cooldown and cap as pure functions, and
// the hooks through the real Game class (private members are reached with `any`, as in tests/elites.test.ts).

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-companions-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const EVENTS = Object.keys(CALLOUT_ODDS) as CallEvent[];
const VARS: CallVars = { target: 'Goblin', ally: 'Pip' };
const voices = Object.keys(LINES) as (keyof typeof LINES)[];

// ---------------------------------------------------------------- the data

test('every bot name has its own voice, and any other name gets the plain one', () => {
  for (const name of BOT_NAMES) assert.ok(Object.hasOwn(VOICE, name), `${name} has a voice`);
  assert.equal(new Set(BOT_NAMES.map(voiceOf)).size, BOT_NAMES.length, 'no two bots sound alike');
  assert.ok(BOT_NAMES.every((n) => voiceOf(n) !== 'plain'));
  assert.equal(voiceOf('Bot 4'), 'plain');
  assert.equal(voiceOf('constructor'), 'plain', 'an odd name is not a lookup on Object.prototype');
});

test('every voice has lines, the plain voice has every event, and every line fills its placeholders', () => {
  for (const ev of EVENTS) assert.ok(LINES.plain[ev]?.length, `plain has lines for ${ev}`);
  assert.ok(voices.includes('plain') && BOT_NAMES.every((n) => voices.includes(voiceOf(n))));
  for (const voice of voices) {
    for (const [ev, lines] of Object.entries(LINES[voice]) as [CallEvent, string[]][]) {
      assert.ok(ev in CALLOUT_ODDS, `${voice}: ${ev} is a known event`);
      assert.equal(new Set(lines).size, lines.length, `${voice}/${ev}: no repeated line`);
      for (const line of lines) {
        const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        assert.ok(used.every((k) => PLACEHOLDERS[ev].includes(k)), `${voice}/${ev}: "${line}" uses a placeholder the event doesn't fill`);
        const filled = line.replace(/\{(\w+)\}/g, (_, k: string) => VARS[k as keyof CallVars]!);
        assert.ok(!/[{}]/.test(filled), `${voice}/${ev}: "${line}" has a placeholder left over`);
        assert.ok(line.length >= 4 && line.length <= 70, `${voice}/${ev}: "${line}" is short`);
        assert.ok(!line.startsWith('*') && !line.includes('"'), `${voice}/${ev}: "${line}" reads as plain speech`);
      }
    }
  }
});

test('the bots with a voice have the key moments covered (a few lines each), and the rest fall back to plain', () => {
  for (const name of BOT_NAMES) {
    for (const ev of ['low', 'down', 'revive', 'steal', 'won'] as CallEvent[]) {
      assert.ok((LINES[voiceOf(name)][ev]?.length ?? 0) >= 3, `${name} has at least 3 lines for ${ev}`);
    }
  }
  assert.equal(calloutLine('Bot 4', 'down', VARS, 0), LINES.plain.down![0].replace('{ally}', 'Pip'));
});

test('calloutLine fills {target} and {ally}, picks by the roll, and never leaves a brace', () => {
  for (const name of [...BOT_NAMES, 'Bot 4']) {
    for (const ev of EVENTS) {
      const lines = LINES[voiceOf(name)][ev] ?? LINES.plain[ev]!;
      for (let i = 0; i < lines.length; i++) {
        const text = calloutLine(name, ev, VARS, (i + 0.5) / lines.length);
        assert.ok(text && !/[{}]/.test(text), `${name}/${ev}: ${text}`);
      }
    }
  }
  assert.equal(calloutLine('Brakka', 'kill', VARS, 0.99), 'Stay down, Goblin.');
  assert.equal(calloutLine('Brakka', 'steal', {}, 0), 'Mine now, friend.', 'missing names get a stand-in');
});

// ---------------------------------------------------------------- the cooldown and the cap

test('a bot speaks at most once per round, and the odds decide whether it does', () => {
  const c = newChatter();
  assert.equal(tryCallout(c, 'brakka', 'crit', 'r1', 0.99), false, 'a roll above the odds stays quiet');
  assert.equal(tryCallout(c, 'brakka', 'crit', 'r1', 0), true);
  assert.equal(tryCallout(c, 'brakka', 'kill', 'r1', 0), false, 'one line per bot per round');
  assert.equal(tryCallout(c, 'pip', 'kill', 'r1', 0), true, 'someone else can still talk');
  assert.equal(tryCallout(c, 'brakka', 'kill', 'r2', 0), true, 'the next round, Brakka is free again');
});

test('a round has a cap, and only the urgent moments can go one over it', () => {
  const c = newChatter();
  const who = ['a', 'b', 'c', 'd'];
  assert.equal(MAX_PER_BEAT, 2);
  assert.equal(tryCallout(c, who[0], 'crit', 'r3', 0), true);
  assert.equal(tryCallout(c, who[1], 'kill', 'r3', 0), true);
  assert.equal(tryCallout(c, who[2], 'crit', 'r3', 0), false, 'the round is full for small talk');
  assert.ok(URGENT.has('steal') && URGENT.has('low') && URGENT.has('revive') && URGENT.has('down'));
  assert.equal(tryCallout(c, who[2], 'steal', 'r3', 0), true, 'a kill steal still gets through');
  assert.equal(tryCallout(c, who[3], 'revive', 'r3', 0), false, 'but not a fourth line');
  assert.equal(tryCallout(c, who[3], 'revive', 'r4', 0), true, 'a new round starts fresh');
});

test('low HP is called out once per fight, and a failed roll does not spend it', () => {
  const c = newChatter();
  assert.equal(tryCallout(c, 'brakka', 'low', 'r1', 0.99), false);
  assert.equal(tryCallout(c, 'brakka', 'low', 'r1', 0), true);
  assert.equal(tryCallout(c, 'brakka', 'low', 'r5', 0), false, 'already said it this fight');
  assert.equal(tryCallout(c, 'pip', 'low', 'r5', 0), true, 'each bot has its own');
  assert.equal(tryCallout(newChatter(), 'brakka', 'low', 'r6', 0), true, 'a new fight has a new chatter');
});

// ---------------------------------------------------------------- in a fight

/**
 * Every die and every roll comes up 0, after any `rolls` given: a bot always gets its chance, says its first line, and the
 * first bot in line is the one who speaks up. (The game's `rng` is bound to the real Math.random, so it's patched too.)
 */
function lucky<T>(fn: () => T, rolls: number[] = []): T {
  const real = { random: Math.random, next: rng.next, pick: rng.pick };
  const queue = [...rolls];
  const roll = () => queue.shift() ?? 0;
  Math.random = roll;
  rng.next = roll;
  rng.pick = (arr) => arr[0];
  try {
    return fn();
  } finally {
    Math.random = real.random;
    rng.next = real.next;
    rng.pick = real.pick;
  }
}

/** Ann (a person) and `bots` bots in a small walled room, in combat, everyone at 40 HP. */
function battle(bots = 2) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'CHAT');
  games.push(g);
  const p = g as any;
  const ann = g.join(undefined, 'Ann', 'fighter');
  assert.ok(ann.ok);
  for (let i = 0; i < bots; i++) g.addBot(ann.playerId);
  const heroes: PlayerEntity[] = p.players.map((info: PlayerInfo) => p.makePlayer(info, 1));
  g.width = 12;
  g.height = 8;
  g.tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  g.ground = {};
  g.clouds = {};
  g.props = {};
  heroes.forEach((h, i) => {
    h.x = 2;
    h.y = 1 + i;
    h.hp = h.maxHp = 40;
  });
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, movesLeft: 6, ap: 3 };
  p.turnOwner = heroes[0].id;
  const foe = (type: string, x: number, y: number, hp?: number): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    if (hp !== undefined) m.hp = m.maxHp = hp;
    p.turn.order.push(m.id);
    return m;
  };
  const named = (name: string) => heroes.find((h) => h.name === name)!;
  return { g, p, heroes, foe, ann: named('Ann'), brakka: named('Brakka'), pip: named('Pip'), named };
}

/** The chat lines in the log, as shown to the players. */
const chat = (p: any): string[] => p.log.filter((l: { kind: string }) => l.kind === 'chat').map((l: { text: string }) => l.text);
/** The chat line a bot says when its roll is 0: its first line for the event. */
const first = (name: string, ev: CallEvent, vars: CallVars = {}) => `${name}: ${calloutLine(name, ev, vars, 0)}`;

test('a bot calls out low HP in the log like a teammate typing, once per fight', () => {
  const { p, brakka, foe } = battle();
  const goblin = foe('goblin', 7, 3, 100);
  lucky(() => p.damage(brakka, 30, goblin));
  assert.deepEqual(chat(p), [first('Brakka', 'low')], "formatted exactly like a person's chat line: Name: text");
  assert.equal(p.log.find((l: { text: string }) => l.text === first('Brakka', 'low')).kind, 'chat');
  p.turn.round = 2;
  lucky(() => p.damage(brakka, 3, goblin));
  assert.equal(chat(p).length, 1, 'already said it this fight');
  const high = battle();
  lucky(() => high.p.damage(high.brakka, 10, high.foe('goblin', 7, 3, 100)));
  assert.deepEqual(chat(high.p), [], 'a scratch is not low HP');
});

test('a person who switched on auto-play stays quiet, and so does a bot that is down', () => {
  const { p, ann, brakka, foe } = battle();
  p.players.find((i: PlayerInfo) => i.id === ann.playerId).auto = true;
  const goblin = foe('goblin', 7, 3, 100);
  lucky(() => p.damage(ann, 35, goblin));
  lucky(() => p.callout(ann, 'crit', { target: 'Goblin' }));
  assert.deepEqual(chat(p), [], 'Ann is on auto, but she is a person');
  lucky(() => p.damage(brakka, 60, goblin)); // down
  assert.ok(brakka.downed);
  lucky(() => p.callout(brakka, 'crit', { target: 'Goblin' }));
  assert.ok(chat(p).every((l) => !l.startsWith('Brakka: ')), 'the fallen do not shout');
});

test('the cooldown holds in a fight: one line per bot per round, and the next round it can talk again', () => {
  const { p, brakka } = battle();
  lucky(() => p.callout(brakka, 'crit', { target: 'Goblin' }));
  lucky(() => p.callout(brakka, 'kill', { target: 'Goblin' }));
  assert.deepEqual(chat(p), [first('Brakka', 'crit', { target: 'Goblin' })]);
  p.turn.round = 2;
  lucky(() => p.callout(brakka, 'kill', { target: 'Goblin' }));
  assert.deepEqual(chat(p), [first('Brakka', 'crit', { target: 'Goblin' }), first('Brakka', 'kill', { target: 'Goblin' })]);
});

test('the cap holds in a fight: three bots, two lines of small talk, but all three low-HP calls', () => {
  const { p, heroes } = battle(3);
  const bots = heroes.filter((h) => h.name !== 'Ann');
  assert.equal(bots.length, 3);
  for (const b of bots) lucky(() => p.callout(b, 'crit', { target: 'Goblin' }));
  assert.equal(chat(p).length, 2, 'two lines this round, whoever has more to say');
  p.turn.round = 2;
  for (const b of bots) lucky(() => p.callout(b, 'low'));
  assert.equal(chat(p).length, 5, 'three more: low HP is urgent, and nobody has spoken in round 2');
});

test('a kill steal gets a line from the thief, naming who they robbed', () => {
  const { p, brakka, pip, foe } = battle();
  const goblin = foe('goblin', 7, 3, 10);
  goblin.dmgBy[pip.id] = 100;
  lucky(() => p.damage(goblin, 10, brakka));
  assert.ok(p.log.some((l: { text: string }) => /Kill steal! Brakka snatches the Goblin from Pip/.test(l.text)));
  assert.deepEqual(chat(p), [first('Brakka', 'steal', { target: 'Goblin', ally: 'Pip' })]);
});

test("a clean kill gets a line, and a crit speaks after the damage so a kill has the bot's word first", () => {
  const { p, brakka, foe } = battle();
  const goblin = foe('goblin', 7, 3, 10);
  lucky(() => p.damage(goblin, 10, brakka));
  assert.deepEqual(chat(p), [first('Brakka', 'kill', { target: 'Goblin' })]);

  // A critical hit (two d20s of 20) that doesn't kill: the crit line. One that does: only the kill line.
  const hit = { bonus: 0, dmg: { n: 1, d: 6 }, verb: 'hits', element: 'physical' };
  const crit = battle();
  const big = crit.foe('goblin', 7, 3, 100);
  lucky(() => crit.p.attackRoll(crit.brakka, big, hit), [0.99, 0.99]);
  assert.ok(crit.p.log.some((l: { text: string }) => /CRITICAL HIT/.test(l.text)));
  assert.deepEqual(chat(crit.p), [first('Brakka', 'crit', { target: 'Goblin' })]);

  const fatal = battle();
  const small = fatal.foe('goblin', 7, 3, 1);
  lucky(() => fatal.p.attackRoll(fatal.brakka, small, hit), [0.99, 0.99]);
  assert.deepEqual(chat(fatal.p), [first('Brakka', 'kill', { target: 'Goblin' })]);
});

test('a bot who gets someone back up says so, and the one who was down says thanks', () => {
  const { p, brakka, pip } = battle();
  pip.hp = 0;
  pip.downed = true;
  lucky(() => p.healBy(brakka, pip, 8));
  assert.ok(!pip.downed);
  assert.deepEqual(chat(p), [first('Brakka', 'revive', { ally: 'Pip' }), first('Pip', 'healed', { ally: 'Brakka' })]);
});

test('a bot says something when a friend goes down, and not about itself', () => {
  const { p, ann, foe } = battle();
  lucky(() => p.damage(ann, 60, foe('goblin', 7, 3, 100)));
  assert.ok(ann.downed);
  assert.deepEqual(chat(p), [first('Brakka', 'down', { ally: 'Ann' })]);
  const solo = battle(1);
  lucky(() => solo.p.damage(solo.brakka, 60, solo.foe('goblin', 7, 3, 100)));
  assert.ok(solo.brakka.downed);
  assert.deepEqual(chat(solo.p), [], 'the only bot is the one down: nobody is left to shout');
});

test('the fight start gets a line from a bot, with special ones for an elite and a boss', () => {
  const normal = battle();
  normal.foe('goblin', 8, 3);
  lucky(() => normal.p.startCombat());
  assert.deepEqual(chat(normal.p), [first('Brakka', 'start', { target: 'Goblin' })], 'the first bot speaks up');

  const boss = battle();
  const king = boss.foe(ACTS[0].boss, 8, 3);
  assert.ok(king.boss);
  lucky(() => boss.p.startCombat());
  assert.deepEqual(chat(boss.p), [first('Brakka', 'boss', { target: king.name })]);

  const elite = battle();
  const champ = elite.foe('hobgoblin', 8, 3);
  assert.ok(champ.elite, 'a hobgoblin is an elite');
  lucky(() => elite.p.startCombat());
  assert.deepEqual(chat(elite.p), [first('Brakka', 'elite', { target: champ.name })]);
});

test('winning the fight and levelling up get lines, one per bot, after the room is cleared', () => {
  const { p, pip } = battle();
  pip.xp = 99_999;
  lucky(() => p.endCombat());
  assert.deepEqual(chat(p), [first('Brakka', 'won'), first('Pip', 'level')]);
  const texts: string[] = p.log.map((l: { text: string }) => l.text);
  assert.ok(texts.findIndex((t) => /Room cleared/.test(t)) < texts.indexOf(first('Brakka', 'won')), 'after the room is cleared');
});

test('when the monsters start hunting a bot, it says so', async () => {
  const { p, heroes, foe } = battle();
  for (const info of p.players as PlayerInfo[]) info.bot = true; // every hero is a bot, so whoever they pick can speak
  const goblin = foe('goblin', 7, 3, 100);
  await lucky(() => p.monsterPlan(goblin));
  const hunted = chat(p);
  assert.equal(hunted.length, 1, 'one new target, one line');
  const [name, text] = hunted[0].split(': ');
  assert.ok(heroes.some((h) => h.name === name), `${name} is a hero`);
  assert.ok((LINES[voiceOf(name)].hunted ?? LINES.plain.hunted!).includes(text), `${name} said a hunted line: ${text}`);
});
