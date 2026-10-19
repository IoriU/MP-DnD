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
import { DIFFICULTIES, DIFFICULTY_IDS, MAX_PLAYERS, isDifficulty, type Difficulty } from '../shared/rules.ts';
import { LINES, type BarkEvent } from '../server/barks.ts';
import { RELICS } from '../shared/items.ts';
import { itemInfo, skillTitle } from '../shared/skills.ts';
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
// The battlefield (Phase 5): reactions, hazards and friendly fire, counted from their log lines.
const FIELD_RES: [string, RegExp][] = [
  ['ignite', /goes up in flames/], ['explode', /^💥 It explodes/], ['electrify', /Lightning crackles through/], ['freeze-water', /water freezes over/],
  ['melt', /The ice melts/], ['steam', /cloud of steam billows/], ['douse', /The fire goes out/], ['spill', /Oil spills everywhere/],
  ['topple', /Burning coals spill/], ['wash', /washes it away/], ['explosion hits', /caught in the explosion/],
  ['fire/lava hits', /is (caught|still) in the (flames|lava)/], ['poison hits', /wades through poison/], ['shock hits', /shocked by the electrified/],
  ['gas', /breathes in the poison gas/], ['frozen', /freezes solid/], ['shock stuns', /stunned by the shock/], ['slips', /slips on the ice/],
  ['friendly fire', /Friendly fire!/], ['prop hits', /hits the (Oil Barrel|Brazier)/], ['death bursts', /bursts in a spray|collapses into a pool/],
  ['absorbed', /drinks in the (fire|cold|lightning|poison)/],
];
// Items (Phase 6): the shop, loot and relics, counted from their log lines.
const ITEM_RES: [string, RegExp][] = [
  ['bought', /^🛒 .* buys /], ['sold', /^🛒 .* sells /], ['lessons', /pays \d+ gold for a lesson/], ['forgot', /gold to forget/],
  ['relics', /The party gains the /], ['equipped', / equips the /], ['given', /^🤝 .* gives /], ['elite gear', /\(killing blow\)|picks up the /],
  ['drops', / finds a /], ['bag full', /Every bag is full/], ['phoenix', /Phoenix Feather flares/], ['weapon procs', /^\S+ The .* adds \d+ /],
];
// Elites, blessings and NPC allies (Phase 7), counted from their log lines.
const ELITE_RES: [string, RegExp][] = [
  ['shielded', /: .*Shielded \(/], ['vampiric', /: .*Vampiric \(/], ['enraged', /: .*Enraged \(/], ['swift', /: .*Swift \(/],
  ['summoner', /: .*Summoner \(/], ['burning', /: .*Burning \(/], ['frost', /: .*Frost \(/], ['storm', /: .*Storm \(/],
  ['ward breaks', /ward shatters/], ['ward re-forms', /ward re-forms/], ['aura hits', /'s aura: \d+/], ['drains', /drinks \d+ HP from the wound/],
  ['rages', /flies into a rage/], ['summons', /calls for help/],
  ['elite picks', /^💀 [^!]+ (takes the|upgrades|masters|learns|gains|stocks up|gets better)/], ['blessings', /receives the Blessing/],
  ['allies joined', /joins the party for the next/], ['ally hits', / the (Sellsword|Acolyte|Ranger|War Hound) (cuts|smites|shoots|bites) .+(hit|CRITICAL HIT) for/],
  ['acolytes', /the Acolyte joins the party/], ['ally heals', /^😇 .+ heals /], ['ally kills', /is slain by .+ the /], ['ally falls', /^💔 /], ['ally leaves', /heads home/],
];
// The monster AI (Phase 9): barks by event (built from the handwritten lines), shoves, shots at the ground, support spells.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const barkRe = (ev: BarkEvent) => {
  const lines = Object.values(LINES).flatMap((v) => v[ev] ?? []);
  return new RegExp(`^💬 (?:.+: ")?(?:${lines.map((l) => escapeRe(l.replace(/^\*/, '')).replace(/\\\{(me|target|class)\\\}/g, '.*')).join('|')})"?$`);
};
const AI_RES: [string, RegExp][] = [
  ['target calls', barkRe('focus')], ['flees', barkRe('flee')], ['cornered', barkRe('cornered')],
  ['shoves', /^✋ .* shoves /], ['shoves held', /tries to shove .* hold their ground/], ['ground shots', / the ground!$/],
  ['monster heals', /^(🔮|🧛|🕯️) .+ heals /], ['buffs', / (blesses|wards) .+ \((Blessed|Shielded)\)\.$/], ['barks', /^💬 /],
];
const REACTION_RE = /^(🔥 The oil|💥 It explodes|⚡ Lightning crackles|🧊 The water freezes|💧 The ice melts|♨️ A cloud of steam|💨 The fire goes out|🛢️ Oil spills|🔥 Burning coals|💧 The water washes)/u;
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
  tactics: { sneakOk: number; sneakFail: number; charge: number; ambush: number; flanking: number; behind: number };
  field: Record<string, number>; // FIELD_RES counts
  combosByAct: Record<number, number>; // field reactions set off by a hero's skill, per act
  items: Record<string, number>; // ITEM_RES counts
  elites: Record<string, number>; // ELITE_RES counts
  ai: Record<string, number>; // AI_RES counts
  difficulty: Difficulty;
  party: number; // heroes in the run
  goldAtEnd: number;
  relicsAtEnd: string[];
  gearAtEnd: string[]; // "Pip: Flametongue, Chain Shirt"
  shops: number;
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
  difficulty?: Difficulty; // Normal if unset
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
    tactics: { sneakOk: 0, sneakFail: 0, charge: 0, ambush: 0, flanking: 0, behind: 0 },
    field: {},
    combosByAct: {},
    items: {},
    elites: {},
    ai: {},
    difficulty: opts.difficulty ?? 'normal',
    party: opts.heroes,
    goldAtEnd: 0,
    relicsAtEnd: [],
    gearAtEnd: [],
    shops: 0,
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
  let heroActed = false;
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
      const t = r.tactics;
      if (/never saw you coming/.test(l.text)) t.sneakOk++;
      if (/You've been spotted/.test(l.text)) t.sneakFail++;
      if (/The party charges in/.test(l.text)) t.charge++;
      if (/Ambush!/.test(l.text)) t.ambush++;
      if (/→\d+ \([^)]*flanking/.test(l.text)) t.flanking++;
      if (/→\d+ \([^)]*from behind/.test(l.text)) t.behind++;
      for (const [name, re] of FIELD_RES) if (re.test(l.text)) r.field[name] = (r.field[name] ?? 0) + 1;
      for (const [name, re] of ITEM_RES) if (re.test(l.text)) r.items[name] = (r.items[name] ?? 0) + 1;
      for (const [name, re] of ELITE_RES) if (re.test(l.text)) r.elites[name] = (r.elites[name] ?? 0) + 1;
      for (const [name, re] of AI_RES) if (re.test(l.text)) r.ai[name] = (r.ai[name] ?? 0) + 1;
      if (/^🛒 A merchant spreads/.test(l.text)) r.shops++;
      // A reaction right after a hero's skill line is a combo the heroes set off (not a monster's firebomb).
      if (REACTION_RE.test(l.text) && heroActed && s.run) r.combosByAct[s.run.act] = (r.combosByAct[s.run.act] ?? 0) + 1;
      if (/ uses | attacks .*\(|'s .* \((DEX|STR|WIS) save|'s .*: \d+ hits? strike| hits the (Oil Barrel|Brazier)/.test(l.text)) {
        heroActed = s.players.some((p) => l.text.startsWith(p.name) || [`${p.name} uses `, `${p.name} hits the`, ` ${p.name}'s `].some((x) => l.text.includes(x)));
      } else if (!REACTION_RE.test(l.text) && !/caught in|is shocked|is stunned|freezes|knocked back|Friendly fire/.test(l.text)) heroActed = false;
      if (/ shoves | tries to shove /.test(l.text)) r.skillUses.Shove = (r.skillUses.Shove ?? 0) + 1;
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
    socket.emit('setDifficulty', r.difficulty);
    await waitFor('the difficulty', () => box.s?.difficulty === r.difficulty);
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
    r.goldAtEnd = s.run?.gold ?? 0;
    r.relicsAtEnd = (s.run?.relics ?? []).map((id) => RELICS[id]?.name ?? id);
    r.gearAtEnd = s.entities
      .filter((e): e is PlayerEntity => e.kind === 'player')
      .map((e) => `${e.name}: ${[...Object.values(e.gear), ...e.bag].map((id) => (id ? itemInfo(id).name : '')).join(', ') || '-'}`);
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

function report(results: RunResult[], heroes: string, elapsed: number) {
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
  const sum = (k: keyof RunResult['tactics']) => results.reduce((a, r) => a + r.tactics[k], 0);
  console.log(
    `approach: sneaked in ${sum('sneakOk')}, spotted ${sum('sneakFail')}, charged ${sum('charge')}, ambushed ${sum('ambush')}; ` +
      `attacks with advantage from flanking ${sum('flanking')}, from behind ${sum('behind')}`,
  );
  const field = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.field)) field.set(k, (field.get(k) ?? 0) + v);
  console.log(`battlefield: ${FIELD_RES.map(([k]) => `${k} ${field.get(k) ?? 0}`).join(' · ')}`);
  const items = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.items)) items.set(k, (items.get(k) ?? 0) + v);
  console.log(`items: shops visited ${results.reduce((n, r) => n + r.shops, 0)} · ${ITEM_RES.map(([k]) => `${k} ${items.get(k) ?? 0}`).join(' · ')}`);
  console.log(`gold left at the end: avg ${avg(results.map((r) => r.goldAtEnd)).toFixed(0)}`);
  const elites = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.elites)) elites.set(k, (elites.get(k) ?? 0) + v);
  console.log(`elites: ${ELITE_RES.map(([k]) => `${k} ${elites.get(k) ?? 0}`).join(' · ')}`);
  const ai = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.ai)) ai.set(k, (ai.get(k) ?? 0) + v);
  console.log(`monster AI: ${AI_RES.map(([k]) => `${k} ${ai.get(k) ?? 0}`).join(' · ')}`);
  // Results per difficulty, and per difficulty and party size (the balance pass in Phase 13 tunes the numbers against these).
  const diffs = DIFFICULTY_IDS.filter((d) => results.some((r) => r.difficulty === d));
  const sizes = [...new Set(results.map((r) => r.party))].sort((a, b) => a - b);
  const label = (d: Difficulty) => `${DIFFICULTIES[d].icon} ${DIFFICULTIES[d].name}`;
  if (diffs.length) {
    console.log('\nper difficulty:');
    const rows = [['', 'runs', 'won', 'lost', 'fights won', 'acts cleared', 'downs/run', 'deaths/run']];
    for (const d of diffs) {
      const rs = results.filter((r) => r.difficulty === d);
      const won = rs.filter((r) => r.outcome === 'victory').length;
      rows.push([
        label(d), String(rs.length), `${won} (${pct(won, rs.length)})`, String(rs.filter((r) => r.outcome === 'defeat').length),
        avg(rs.map((r) => r.fights.filter((f) => f.won).length)).toFixed(1), avg(rs.map((r) => r.actsCleared)).toFixed(1),
        avg(rs.map((r) => r.downs.length)).toFixed(1), avg(rs.map((r) => r.deaths.length)).toFixed(1),
      ]);
    }
    printTable(rows);
  }
  if (sizes.length > 1) {
    console.log('\nwins / runs (acts cleared on average) per difficulty and party size:');
    const rows = [['', ...sizes.map((n) => `${n} hero${n > 1 ? 'es' : ''}`)]];
    for (const d of diffs) {
      rows.push([
        label(d),
        ...sizes.map((n) => {
          const rs = results.filter((r) => r.difficulty === d && r.party === n);
          return rs.length ? `${rs.filter((r) => r.outcome === 'victory').length}/${rs.length} (${avg(rs.map((r) => r.actsCleared)).toFixed(1)})` : '-';
        }),
      ]);
    }
    printTable(rows);
  }
  const last = results.filter((r) => r.heroes.length).at(-1);
  if (last) {
    console.log(`builds at the end of run ${last.code}:`);
    for (const h of last.heroes) console.log(`  ${h.name} (${h.classId} ${h.level}): ${h.skills.join(', ')}`);
    console.log(`  items: ${last.gearAtEnd.join(' | ')}`);
    console.log(`  relics: ${last.relicsAtEnd.join(', ') || '-'}`);
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
        `rounds avg ${avg(fights.map((f) => f.rounds)).toFixed(1)}, wipes ${lost.length}, hero combos ${results.reduce((n, r) => n + (r.combosByAct[a] ?? 0), 0)}` +
        `${killers.length ? `; killed by ${killers.join(', ')}` : ''}`,
    );
  }
}

async function main(): Promise<number> {
  const int = (v: string | undefined, def: number) => (Number(v) > 0 ? Math.floor(Number(v)) : def);
  const RUNS = int(process.argv[2], 8);
  // Party size, or a list like 1,2,4,6 to spread the runs over several sizes (each size gets every difficulty in DIFF).
  const SIZES = (process.argv[3] ?? '4').split(',').map((v) => Math.min(MAX_PLAYERS, int(v, 4)));
  const CONCURRENCY = Math.min(RUNS, int(process.argv[4], 4));
  const TIMEOUT_S = int(process.env.RUN_TIMEOUT_S, 900);
  const url = process.env.URL ?? 'http://localhost:3000';
  // DIFF=story|normal|hard, or DIFF=all to spread the runs over all three.
  const DIFFS: Difficulty[] = process.env.DIFF === 'all' ? DIFFICULTY_IDS : [isDifficulty(process.env.DIFF) ? process.env.DIFF : 'normal'];
  console.log(`${RUNS} runs x ${SIZES.join('/')} heroes on ${url}, ${CONCURRENCY} at a time, ${TIMEOUT_S}s limit per run, difficulty ${DIFFS.join('/')}`);

  const results: RunResult[] = [];
  let next = 0;
  const startedAt = Date.now();
  const worker = async () => {
    while (next < RUNS) {
      const difficulty = DIFFS[next % DIFFS.length];
      const heroes = SIZES[Math.floor(next / DIFFS.length) % SIZES.length];
      next++;
      const r = await playRun({ url, heroes, timeoutS: TIMEOUT_S, difficulty });
      results.push(r);
      const levels = r.heroes.map((h) => h.level).join('/') || '-';
      const verdict = r.outcome === 'victory' ? 'WIN' : r.outcome === 'defeat' ? `lost at ${whereLabel(r.at)} to ${r.killer ?? '?'}` : `${r.outcome.toUpperCase()} at ${whereLabel(r.at)}`;
      console.log(`[${results.length}/${RUNS}] ${r.code || '----'} ${DIFFICULTIES[r.difficulty].icon} ${r.party}p ${verdict}; ${r.seconds.toFixed(1)}s; fights won ${r.fights.filter((f) => f.won).length}; levels ${levels}${r.anomalies.length ? `; ${r.anomalies.length} ANOMALIES` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  report(results, SIZES.join('/'), (Date.now() - startedAt) / 1000);
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
