// The RL environment (Phase 11): real fights from the real game, played headless at full speed, where the Python
// trainer (training/ppo.py) chooses the monsters' moves. The heroes are the usual hero bots. Each fight starts from a
// save recorded at the start of a fight in a bot run (DELVERS_FIGHT_DUMP, see training/README.md), so the parties are
// the ones the game really produces.
//
// It talks JSON lines over stdin/stdout:
//   out {"hello":{...}}                                   sizes of the feature vectors, once at the start
//   out {"ep":3,"opts":[[...],...],"state":[...],"r":0.1}  a monster's turn: its options (the scripted AI's pick first),
//                                                          and the reward since this fight's last decision
//   out {"ep":3,"end":true,"r":-0.2,"won":false,...}       the fight is over (won: the monsters won)
//   in  {"ep":3,"a":5}                                     the option to play
// A worker keeps several fights going at once: the game spends most of its time waiting on animation timers.
//
//   node training/env.ts <fights dir> [fights at once] [train | scripted | policy] [episodes, for the eval modes]
// "scripted" and "policy" play by themselves (the scripted AI, or server/policies/monster-ppo.json, or DELVERS_POLICY)
// and print one summary line at the end: the trainer uses them to compare the two.

import './headless.ts'; // first: full speed, no saves, stdout kept for the protocol
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Server } from 'socket.io';
import { isFoe } from '../shared/elites.ts';
import type { Entity, PlayerEntity } from '../shared/types.ts';
import { Game, type MonsterBrain } from '../server/game.ts';
import { MAX_OPTIONS, OPTION_FEATURES, STATE_FEATURES, TOP_FEATURE } from '../server/monsterai.ts';
import { monsterPolicy } from '../server/policy.ts';
import type { SaveFile } from '../server/saves.ts';

const [dir = 'training/data/fights', k = '16', mode = 'train', count = '200'] = process.argv.slice(2);
const AT_ONCE = Math.max(1, Number(k) || 16);
const EPISODES = Math.max(1, Number(count) || 200);
const FIGHT_LIMIT_MS = 120_000; // a fight that takes this long is stuck: drop it
const WIN_BONUS = 2; // the monsters wiping the party

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
if (!files.length) throw new Error(`no recorded fights in ${dir}`);
const io = { to: () => ({ emit() {} }) } as unknown as Server;
const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** The trainer's answers, by fight. */
const waiting = new Map<number, (a: number) => void>();
if (mode === 'train') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line) as { ep: number; a: number };
    waiting.get(msg.ep)?.(msg.a);
    waiting.delete(msg.ep);
  });
}

/** Each side's losses so far, averaged over its members: HP lost, heroes down or dead, monsters dead. */
function losses(g: Game, seen: Map<string, number>): { party: number; monsters: number } {
  const entities = (g as unknown as { entities: Entity[] }).entities;
  const heroes = entities.filter((e): e is PlayerEntity => e.kind === 'player');
  let party = 0;
  for (const h of heroes) party += h.dead ? 3 : h.downed ? 2 : 1 - h.hp / h.maxHp;
  track(g, seen);
  let monsters = 0;
  for (const id of seen.keys()) {
    const m = entities.find((e) => e.id === id);
    monsters += m ? 1 - m.hp / m.maxHp : 1;
  }
  return { party: party / Math.max(1, heroes.length), monsters: monsters / Math.max(1, seen.size) };
}

/**
 * What the trainer is rewarded for: the party's losses (the pressure the monsters put on it). Monsters staying alive
 * pays off through the damage they deal later. DELVERS_REWARD=both also subtracts the monsters' own losses (the
 * first run did that; their deaths are mostly up to the heroes, so it was mostly noise).
 */
const standing = (g: Game, seen: Map<string, number>) => {
  const l = losses(g, seen);
  return process.env.DELVERS_REWARD === 'both' ? l.party - l.monsters : l.party;
};

/** Every monster that has been in the fight (dead ones leave the board, but still count as lost). */
function track(g: Game, seen: Map<string, number>) {
  for (const e of (g as unknown as { entities: Entity[] }).entities) if (isFoe(e)) seen.set(e.id, e.maxHp);
}

interface Result {
  won: boolean;
  rounds: number;
  decisions: number;
  score: number; // the standing at the end
  party: number; // the party's losses at the end (per hero: HP lost, 2 if down, 3 if dead)
  stuck?: boolean;
}

let nextEp = 0;

/** One fight, from a random recorded start, to the end. */
function playFight(): Promise<Result> {
  const ep = nextEp++;
  const save = JSON.parse(fs.readFileSync(path.join(dir, files[Math.floor(Math.random() * files.length)]), 'utf8')) as SaveFile;
  const g = Game.fromSave(io, save);
  const seen = new Map<string, number>();
  let last = 0;
  let decisions = 0;
  const reward = () => {
    const now = standing(g, seen);
    const r = now - last;
    last = now;
    return r;
  };
  const policy = mode === 'policy' ? monsterPolicy() : null;
  if (mode === 'policy' && !policy) throw new Error('no usable policy (server/policies/monster-ppo.json or DELVERS_POLICY)');
  const brain: MonsterBrain | null =
    mode === 'train'
      ? (_m, choices) => {
          decisions++;
          if (decisions === 1) last = standing(g, seen);
          const r = decisions === 1 ? 0 : reward();
          return new Promise<number>((resolve) => {
            waiting.set(ep, resolve);
            send({ ep, opts: choices.options.map((o) => o.features), state: choices.state, r });
          });
        }
      : policy
        ? (_m, choices) => {
            decisions++;
            return policy.pick(choices.options.map((o) => o.features));
          }
        : null;
  g.monsterBrain = brain;
  const internal = g as unknown as { resumeRun(s: SaveFile): void; turn: { round: number } | null };
  internal.resumeRun(save);
  const started = Date.now();
  let rounds = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      rounds = internal.turn?.round ?? rounds; // the turn is gone once the fight is over
      track(g, seen);
      const stuck = Date.now() - started > FIGHT_LIMIT_MS;
      if (g.phase === 'combat' && !stuck) return;
      clearInterval(timer);
      const won = g.phase === 'defeat';
      const end = losses(g, seen);
      const result: Result = { won, rounds, decisions, score: end.party - end.monsters, party: end.party, ...(stuck ? { stuck } : {}) };
      if (mode === 'train') {
        if (decisions) send({ ep, end: true, r: stuck ? 0 : reward() + (won ? WIN_BONUS : 0), ...result });
        waiting.delete(ep);
      }
      g.monsterBrain = null;
      g.dispose();
      resolve(result);
    }, 2);
  });
}

send({ hello: { features: OPTION_FEATURES, state: STATE_FEATURES, top: TOP_FEATURE, maxOptions: MAX_OPTIONS, fights: files.length, mode, atOnce: AT_ONCE } });

if (mode === 'train') {
  // Forever (the trainer kills the worker when it's done).
  const lane = async () => {
    for (;;) await playFight();
  };
  for (let i = 0; i < AT_ONCE; i++) void lane();
} else {
  // Evaluate: play EPISODES fights and print a summary.
  const results: Result[] = [];
  const lane = async () => {
    while (nextEp < EPISODES) results.push(await playFight());
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, EPISODES) }, lane));
  const n = results.length;
  const avg = (f: (r: Result) => number) => results.reduce((s, r) => s + f(r), 0) / Math.max(1, n);
  send({
    summary: {
      mode, fights: n, monsterWins: results.filter((r) => r.won).length, stuck: results.filter((r) => r.stuck).length,
      score: avg((r) => r.score), party: avg((r) => r.party), rounds: avg((r) => r.rounds), decisions: avg((r) => r.decisions),
      partySd: Math.sqrt(avg((r) => (r.party - avg((x) => x.party)) ** 2)),
    },
  });
  process.exit(0);
}
