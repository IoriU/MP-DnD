// Balance harness: plays N full games through the server's auto-play and aggregates how they went.
//
//   node scripts/balance.ts [runs=8] [heroes=4] [concurrency=4]       env: URL (default http://localhost:3000), RUN_TIMEOUT_S (default 900)
//
// Fast run against a test server:  PORT=3200 DELVERS_SPEED=10 node server/index.ts
//                                  URL=http://localhost:3200 node scripts/balance.ts 8 4 4
// Each run is its own room: one socket joins as host (fighter), switches Auto on, adds bots up to the party size,
// starts the run and then only watches. playRun() below is also what scripts/smoke.ts uses.
// Exit code: 0 even when runs are lost (it is a measurement tool), 1 on anomalies or connection failures.

import { io } from 'socket.io-client';
import { MAX_PLAYERS } from '../shared/rules.ts';
import { skillTitle } from '../shared/skills.ts';
import type { GameState, JoinResult, NodeType, PlayerEntity } from '../shared/types.ts';

export const NODE_TYPES: NodeType[] = ['combat', 'elite', 'event', 'rest', 'treasure', 'shop', 'boss'];
const STALL_MS = 30_000; // no state at all for this long = something is stuck
const TURN_STUCK_MS = 15_000; // one hero's turn lasting this long = the hero AI is stuck
const MAX_ROUNDS = 40; // a fight this long is a livelock, not a fight
// Skill names in the log: "X attacks Y (Fire Bolt): 🎲", "X uses Bless!", "Y is caught by X's Sacred Flame (DEX save", "X's Magic Missile: 3 hits"
const SKILL_RES = [/\(([^)]+)\): 🎲/, / uses (.+?)(?: on (?:(?! on )[^:!])+)?[:!]/, /'s (.+?) \((?:DEX|STR|WIS) save/, /'s (.+?): \d+ hits? strike/];
// Passives that fire show up as their own log lines.
const PASSIVE_RES: [string, RegExp][] = [
  ['Battle Hardened', /grits their teeth/], ['Unbreakable', /refuses to fall/], ['Bodyguard', /throws themself in front/],
  ['Executioner', /Executioner!/], ['Evasion', /evades it completely/], ['Uncanny Dodge', /twists away/], ['Lucky', /gets lucky/],
  ['Bloodthirsty', /drinks in the victory/], ['Holy Mending', /Holy light from/], ['Defiant', /defiantly gets back up/],
];
const ENCOUNTER_RE = /^(?:⚔️?|\u{1F480}|\u{1F451}) ([^:]+): /u; // "⚔️ Goblin Patrol: Goblin ×2, ..." (not "💀 X is slain!")

export type Outcome = 'victory' | 'defeat' | 'timeout' | 'stalled' | 'error';

export interface FightRecord {
  act: number;
  row: number;
  kind: string; // combat, elite or boss
  name: string; // encounter name from the log
  won: boolean;
  rounds: number;
}

export interface RunResult {
  outcome: Outcome;
  code: string;
  seconds: number;
  states: number;
  maxAct: number;
  act: number; // the act the party ended in
  at: { act: number; row: number; boss: boolean } | null; // the last node the party stood on
  actsCleared: number;
  nodes: Record<NodeType, number>; // nodes entered
  fightsStarted: number;
  fights: FightRecord[]; // finished fights
  downs: string[]; // class of each hero that fell unconscious
  deaths: string[]; // class of each hero that died
  killer: string | null; // the encounter that wiped the party
  heroes: { name: string; classId: string; level: number; kills: number; steals: number; hp: number; maxHp: number; skills: string[] }[];
  skillUses: Record<string, number>; // by skill name as it appears in the log
  picks: number; // level-up picks taken
  rests: { long: number; train: number };
  toasts: string[];
  toastCount: number;
  anomalies: string[];
  log: string[]; // last 20 lines
}

export const whereLabel = (at: RunResult['at']) => (at ? `A${at.act} ${at.boss ? 'boss' : `r${at.row}`}` : '-');

export interface RunOptions {
  url: string;
  heroes: number;
  timeoutS: number;
  onStart?: (code: string) => void;
}

/** Plays one full game: host on auto + bots, then watches until victory, defeat or the time limit. */
export async function playRun(opts: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const r: RunResult = {
    outcome: 'error', code: '', seconds: 0, states: 0, maxAct: 0, act: 0, at: null, actsCleared: 0,
    nodes: Object.fromEntries(NODE_TYPES.map((t) => [t, 0])) as Record<NodeType, number>,
    fightsStarted: 0, fights: [], downs: [], deaths: [], killer: null, heroes: [], toasts: [], toastCount: 0, anomalies: [], log: [],
    skillUses: {}, picks: 0, rests: { long: 0, train: 0 },
  };
  const socket = io(opts.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  const box: { s: GameState | null } = { s: null };
  let outcome: Outcome | null = null;
  let resolveEnded!: (o: Outcome) => void;
  const ended = new Promise<Outcome>((res) => (resolveEnded = res));
  const finish = (o: Outcome) => {
    if (outcome) return;
    outcome = o;
    resolveEnded(o);
  };
  const fail = (msg: string) => {
    if (outcome) return;
    r.anomalies.push(msg);
    finish('error');
  };

  // ---- observing (state only: this never plays)
  let prevPhase = '';
  let lastLogId = 0;
  let lastEncounter = '';
  let fight: FightRecord | null = null;
  let fightNo = 0;
  let lastStateAt = Date.now();
  let turnKey = '';
  let turnSince = Date.now();
  const seenNodes = new Set<string>();
  const reportedTurns = new Set<string>();
  const classOf = (s: GameState, name: string) => s.players.find((p) => p.name === name)?.classId ?? '?';

  const observe = (s: GameState) => {
    box.s = s;
    r.states++;
    lastStateAt = Date.now();
    for (const l of s.log) {
      if (l.id <= lastLogId) continue;
      lastLogId = l.id;
      const enc = ENCOUNTER_RE.exec(l.text);
      if (enc) lastEncounter = enc[1];
      if (/Act \d+ complete|VICTORY/.test(l.text)) r.actsCleared++;
      for (const re of SKILL_RES) {
        const m = re.exec(l.text);
        if (m) {
          r.skillUses[m[1]] = (r.skillUses[m[1]] ?? 0) + 1;
          break;
        }
      }
      for (const [name, re] of PASSIVE_RES) if (re.test(l.text)) r.skillUses[`🔁 ${name}`] = (r.skillUses[`🔁 ${name}`] ?? 0) + 1;
      if (l.kind === 'level' && / (learns|upgrades|masters|gains|gets|stocks) /.test(l.text) && !/trains by the fire/.test(l.text)) r.picks++;
      if (/trains by the fire/.test(l.text)) r.rests.train++;
      if (/takes a Long Rest/.test(l.text)) r.rests.long++;
      if (l.kind !== 'death') continue;
      const fell = /^\S+ (.+?) falls unconscious/.exec(l.text);
      if (fell) r.downs.push(classOf(s, fell[1]));
      const died = /^\S+ (.+?) has died/.exec(l.text);
      if (died) r.deaths.push(classOf(s, died[1]));
    }
    const run = s.run;
    const node = run?.map.nodes.find((n) => n.id === run.currentId);
    if (run) {
      r.act = run.act;
      r.maxAct = run.maxAct;
      if (node) r.at = { act: run.act, row: node.row, boss: node.type === 'boss' };
      for (const id of run.visited) {
        if (seenNodes.has(`${run.act}:${id}`)) continue; // visited resets each act
        seenNodes.add(`${run.act}:${id}`);
        const type = run.map.nodes.find((n) => n.id === id)?.type;
        if (type) r.nodes[type]++;
      }
    }
    if (s.phase === 'combat' && prevPhase !== 'combat') {
      fightNo++;
      r.fightsStarted++;
      fight = { act: run?.act ?? 0, row: node?.row ?? 0, kind: s.roomKind ?? '?', name: lastEncounter, won: false, rounds: 1 };
    }
    if (fight && s.turn) {
      fight.rounds = Math.max(fight.rounds, s.turn.round);
      if (fight.rounds === MAX_ROUNDS + 1) r.anomalies.push(`fight "${fight.name}" (A${fight.act} r${fight.row}) passed ${MAX_ROUNDS} rounds: livelock?`);
    }
    if (fight && s.phase !== 'combat') {
      fight.won = s.phase !== 'defeat';
      r.fights.push(fight);
      fight = null;
    }
    if (s.phase === 'defeat') r.killer = lastEncounter || null;
    const t = s.turn;
    const key = s.phase === 'combat' && t ? `${fightNo}:${t.round}:${t.index}:${t.order[t.index]}` : '';
    if (key !== turnKey) {
      turnKey = key;
      turnSince = Date.now();
    }
    prevPhase = s.phase;
    if (s.phase === 'victory' || s.phase === 'defeat') finish(s.phase);
  };

  socket.on('state', observe);
  socket.on('toast', (msg: string) => {
    r.toastCount++;
    if (!r.toasts.includes(msg)) r.toasts.push(msg);
  });
  socket.on('connect_error', (err) => fail(`connect_error: ${err.message}`));
  socket.on('disconnect', (reason) => fail(`disconnected: ${reason}`));

  const watchdog = setInterval(() => {
    const now = Date.now();
    const s = box.s;
    if (now - lastStateAt > STALL_MS) {
      r.anomalies.push(`no state change for ${STALL_MS / 1000}s (phase ${s?.phase}, vote ${JSON.stringify(s?.vote)})`);
      return finish('stalled');
    }
    const t = s?.turn;
    if (s?.phase !== 'combat' || !t || !turnKey || now - turnSince <= TURN_STUCK_MS || reportedTurns.has(turnKey)) return;
    const cur = s.entities.find((e) => e.id === t.order[t.index]);
    if (cur?.kind !== 'player') return;
    reportedTurns.add(turnKey);
    r.anomalies.push(
      `${cur.name} (${cur.classId}) stuck on their turn for ${Math.round((now - turnSince) / 1000)}s: round ${t.round}, ` +
        `moves left ${t.movesLeft}, action ${t.actionUsed ? 'used' : 'free'}, bonus ${t.bonusUsed ? 'used' : 'free'}, hp ${cur.hp}/${cur.maxHp}`,
    );
  }, 1000);

  const waitFor = async (what: string, cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((res) => setTimeout(res, 25));
    if (!cond()) throw new Error(`timed out waiting for ${what}`);
  };

  // ---- set up the room, then watch
  const setup = async () => {
    const res: JoinResult = await socket.timeout(5000).emitWithAck('join', { name: 'Host', classId: 'fighter' });
    if (!res.ok) throw new Error(`join failed: ${res.error}`);
    r.code = res.code;
    socket.emit('setAuto', true);
    for (let i = 1; i < opts.heroes; i++) socket.emit('addBot'); // the bots pick their own classes
    await waitFor('the party to form', () => {
      const s = box.s;
      return !!s && s.players.length >= opts.heroes && !!s.players.find((p) => p.id === res.playerId)?.auto;
    });
    opts.onStart?.(res.code);
    socket.emit('start');
    await waitFor('the run to start', () => !!box.s && box.s.phase !== 'lobby');
  };
  setup().catch((err) => fail(`setup failed: ${err instanceof Error ? err.message : String(err)}`));
  const timer = setTimeout(() => finish('timeout'), opts.timeoutS * 1000);

  r.outcome = await ended;
  clearTimeout(timer);
  clearInterval(watchdog);
  socket.close();
  r.seconds = (Date.now() - t0) / 1000;
  const s = box.s;
  if (s) {
    r.heroes = s.entities
      .filter((e): e is PlayerEntity => e.kind === 'player')
      .map((e) => ({
        name: e.name, classId: e.classId, level: e.level, kills: e.kills, steals: e.steals, hp: e.hp, maxHp: e.maxHp,
        skills: e.skills.map((o) => skillTitle(o)),
      }));
    r.log = s.log.slice(-20).map((l) => `[${l.kind}] ${l.text}`);
  }
  return r;
}

// ---------------------------------------------------------------- aggregate report

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : 0;
};
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const count = <T>(xs: T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());

function printTable(rows: string[][]) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
  for (const row of rows) console.log('  ' + row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  '));
}

function report(results: RunResult[], heroes: number, elapsed: number) {
  const n = results.length;
  const wins = results.filter((r) => r.outcome === 'victory').length;
  const losses = results.filter((r) => r.outcome === 'defeat').length;
  const other = n - wins - losses;
  console.log(`\n=== balance: ${n} runs x ${heroes} heroes (${elapsed.toFixed(0)}s wall) ===`);
  console.log(`win rate: ${wins}/${n} (${pct(wins, n)}); lost ${losses}${other ? `; unfinished ${other} (${[...count(results.filter((r) => r.outcome !== 'victory' && r.outcome !== 'defeat').map((r) => r.outcome))].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);

  console.log('\nwhere runs ended (A = act, r = map row, 0 = bottom row):');
  const ends = new Map<string, { key: number; n: number }>();
  for (const r of results) {
    const win = r.outcome === 'victory';
    const label = win ? 'WIN' : `${whereLabel(r.at)}${r.outcome === 'defeat' ? '' : ` (${r.outcome})`}`;
    const e = ends.get(label) ?? { key: win ? 1e9 : r.at ? r.at.act * 1000 + (r.at.boss ? 999 : r.at.row) : 0, n: 0 };
    e.n++;
    ends.set(label, e);
  }
  for (const [label, e] of [...ends].sort((a, b) => a[1].key - b[1].key)) console.log(`  ${label.padEnd(16)} ${'#'.repeat(e.n)} ${e.n}`);

  const done = results.filter((r) => r.outcome === 'victory' || r.outcome === 'defeat').map((r) => r.seconds);
  const winTimes = results.filter((r) => r.outcome === 'victory').map((r) => r.seconds);
  console.log(
    `\nmedian run time: ${median(done).toFixed(1)}s over ${done.length} finished runs (min ${Math.min(...done, Infinity).toFixed(1)}, max ${Math.max(...done, 0).toFixed(1)})` +
      (winTimes.length ? `; wins only ${median(winTimes).toFixed(1)}s` : ''),
  );

  console.log('\nper class (heroes at the end of each run):');
  const classes = [...new Set(results.flatMap((r) => r.heroes.map((h) => h.classId)))].sort();
  printTable([
    ['class', 'heroes', 'avg kills', 'avg steals', 'avg level', 'downs', 'deaths'],
    ...classes.map((c) => {
      const hs = results.flatMap((r) => r.heroes.filter((h) => h.classId === c));
      const downs = results.reduce((a, r) => a + r.downs.filter((x) => x === c).length, 0);
      const deaths = results.reduce((a, r) => a + r.deaths.filter((x) => x === c).length, 0);
      return [c, String(hs.length), avg(hs.map((h) => h.kills)).toFixed(1), avg(hs.map((h) => h.steals)).toFixed(1), avg(hs.map((h) => h.level)).toFixed(1), String(downs), String(deaths)];
    }),
  ]);

  const uses = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.skillUses)) uses.set(k, (uses.get(k) ?? 0) + v);
  console.log(`
skills used (${uses.size} different):`);
  console.log('  ' + [...uses].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
  const picks = results.reduce((a, r) => a + r.picks, 0);
  const long = results.reduce((a, r) => a + r.rests.long, 0);
  const train = results.reduce((a, r) => a + r.rests.train, 0);
  console.log(`level-up picks: ${picks}; rest choices: Long Rest ${long}, Train ${train}`);
  const last = results.filter((r) => r.heroes.length).at(-1);
  if (last) {
    console.log(`builds at the end of run ${last.code}:`);
    for (const h of last.heroes) console.log(`  ${h.name} (${h.classId} ${h.level}): ${h.skills.join(', ')}`);
  }

  console.log('\nper act:');
  const acts = Math.max(...results.map((r) => r.maxAct), 0);
  for (let a = 1; a <= acts; a++) {
    const fights = results.flatMap((r) => r.fights.filter((f) => f.act === a));
    const lost = fights.filter((f) => !f.won);
    const killers = [...count(lost.map((f) => f.name))].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} x${v}`);
    const bosses = fights.filter((f) => f.kind === 'boss');
    console.log(
      `  Act ${a}: fights won ${fights.length - lost.length}/${fights.length} (boss ${bosses.filter((f) => f.won).length}/${bosses.length}), ` +
        `rounds avg ${avg(fights.map((f) => f.rounds)).toFixed(1)}, wipes ${lost.length}${killers.length ? `; killed by ${killers.join(', ')}` : ''}`,
    );
  }
}

async function main(): Promise<number> {
  const int = (v: string | undefined, def: number) => (Number(v) > 0 ? Math.floor(Number(v)) : def);
  const RUNS = int(process.argv[2], 8);
  const HEROES = Math.min(MAX_PLAYERS, int(process.argv[3], 4));
  const CONCURRENCY = Math.min(RUNS, int(process.argv[4], 4));
  const TIMEOUT_S = int(process.env.RUN_TIMEOUT_S, 900);
  const url = process.env.URL ?? 'http://localhost:3000';
  console.log(`${RUNS} runs x ${HEROES} heroes on ${url}, ${CONCURRENCY} at a time, ${TIMEOUT_S}s limit per run`);

  const results: RunResult[] = [];
  let next = 0;
  const startedAt = Date.now();
  const worker = async () => {
    while (next < RUNS) {
      next++;
      const r = await playRun({ url, heroes: HEROES, timeoutS: TIMEOUT_S });
      results.push(r);
      const levels = r.heroes.map((h) => h.level).join('/') || '-';
      const verdict = r.outcome === 'victory' ? 'WIN' : r.outcome === 'defeat' ? `lost at ${whereLabel(r.at)} to ${r.killer ?? '?'}` : `${r.outcome.toUpperCase()} at ${whereLabel(r.at)}`;
      console.log(`[${results.length}/${RUNS}] ${r.code || '----'} ${verdict}; ${r.seconds.toFixed(1)}s; fights won ${r.fights.filter((f) => f.won).length}; levels ${levels}${r.anomalies.length ? `; ${r.anomalies.length} ANOMALIES` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  report(results, HEROES, (Date.now() - startedAt) / 1000);
  const anomalies = results.flatMap((r, i) => r.anomalies.map((a) => `run ${r.code || `#${i + 1}`}: ${a}`));
  const toasts = new Set(results.flatMap((r) => r.toasts));
  console.log(`\nrejected-action toasts seen by the host: ${results.reduce((a, r) => a + r.toastCount, 0)} (${toasts.size} unique)`);
  for (const t of [...toasts].slice(0, 10)) console.log(`  ${t}`);
  console.log(`anomalies: ${anomalies.length}`);
  for (const a of anomalies.slice(0, 20)) console.log(`  ${a}`);
  return anomalies.length ? 1 : 0;
}

if (import.meta.main) {
  const code = await main();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref(); // normally the event loop is empty by now
}
