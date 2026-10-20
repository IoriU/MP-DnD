// Balance harness: plays N full games through the server's auto-play and aggregates how they went.
//
//   node scripts/balance.ts [runs=8] [heroes=4] [concurrency=4]       env: URL (default http://localhost:3000), RUN_TIMEOUT_S (default 900)
//                                                                     OUT=<file.json>: also keep every run's result (scripts/balance-merge.ts reports on several)
//
// Fast run against a test server:  PORT=3200 DELVERS_SPEED=10 node server/index.ts
//                                  URL=http://localhost:3200 node scripts/balance.ts 8 4 4
// Each run is its own room: one socket joins as host (fighter), switches Auto on, adds bots up to the party size,
// starts the run and then only watches. playRun() below is also what scripts/smoke.ts uses.
// Exit code: 0 even when runs are lost (it is a measurement tool), 1 on anomalies or connection failures.

import fs from 'node:fs';
import { io } from 'socket.io-client';
import { DIFFICULTIES, DIFFICULTY_IDS, MAX_PLAYERS, MONSTER_AIS, MONSTER_AI_IDS, isDifficulty, isMonsterAi, type Difficulty, type MonsterAi } from '../shared/rules.ts';
import { LINES, type BarkEvent } from '../server/barks.ts';
import { RELICS } from '../shared/items.ts';
import { itemInfo, skillTitle, topEngine } from '../shared/skills.ts';
import { ENGINES } from '../shared/engines.ts';
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
  ['monster heals', /^(🔮|🧛|🕯️) .+ heals /], ['buffs', / (blesses|wards|rallies) .+ \((Blessed|Shielded|Rallied)\)\.$/], ['barks', /^💬 /],
  // Phase 12 tricks
  ['tricks', / (throws a net at|throws sand in the eyes of|spits a web at|brands) [^:]+: /], ['tricks landed', / (throws a net at|throws sand in the eyes of|spits a web at|brands) [^:]+: .*(failed|hit)\.$/],
  ['helps', / gets in .+'s face/], ['orders', /: "(Charge!|Hold the line!|Kill .+!)"$/], ['knocked down', /^🤕 .+ (drags|knocks) /], ['drained', /^🩸 .+ drinks the life/],
  ['cut free', / uses Cut Free/], ['webs burned', /The web around .+ burns away/],
];
/** The heroes' AP, Block and subclass tricks (Phase 12), counted from the log like AI_RES. */
const HERO_RES: [string, RegExp][] = [
  ['dashes', / uses Dash!/], ['braces', / uses Brace!/], ['block given', /^🧱 .+ (gets|covers) /],
  ['snares set', /^🪤 .+ hides /], ['snares sprung', / steps into .*snare!/], ['counterattacks', / counterattacks!/], ['intercepts', /^🙅 /],
  ['frightened', / flees in terror/], ['blood paid', / HP in blood\./], ['thorns', / spiked shield: /], ['smite heals', /The smite's light flows/],
  ['help ups', /^🤝 .+ hauls /], ['heal revives', / is back on their feet, but groggy/], ['groggy turns lost', / is still groggy /],
  ['injuries', /^🩹 .+ is back, but injured/], ['blast edges', /edge of the blast/],
  ['rolls vs cover', /\((behind a wall|in cover)\)|\+\d (in cover|behind a wall) vs DC/], ['starts scattered', /^🌫️ The party comes in by two ways/],
  ['starts pincer', /^⚠️ A pincer!/], ['starts surrounded', /^⚠️ Surrounded!/], ['starts at a camp', /^🔥 You come upon their camp/],
];
/** Build engines (shared/engines.ts) at work: their own log lines. */
const ENGINE_RES: [string, RegExp][] = [
  ['poison blooms', /^⚗️ The poison in/], ['free knives', /^🔪 .+ flicks a knife/], ['unleashed', /^💥 .+ unleashes/], ['walls raised', /^⛰️ A wall of stone rises/],
  ['cover raised', /^🪨 Rubble rises|^⛏️ The broken floor/], ['crushed', /^🧱 .+ slams into/], ['shock arcs', /^⚡ The shock arcs/], ['ice shattered', /^💎 /],
  ['arrow rains', /^🌧️ Arrows rain/], ['finales', /^🎆 /], ['madness', /^🤪 /], ['unkillable', /refuses to fall/], ['knockdown hits', /^🌋 /],
  ['split shots', /^🪃 /], ['entrench', /^🏯 /], ['vengeance', /^👼 /], ['radiance burns', /Radiance burns/],
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
  downs: number; // heroes who fell unconscious in this fight
  deaths: number; // heroes who died in it
  startHp: number; // the party's share of its max HP when the fight starts (what earlier fights left)
  minHp: number; // the party's lowest share of its max HP during the fight (downed heroes count 0)
  endHp: number; // the party's share of its max HP at the end of the fight
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
  heroes: { name: string; classId: string; level: number; kills: number; steals: number; hp: number; maxHp: number; skills: string[]; engine?: string; dmg: number }[];
  skillUses: Record<string, number>; // by skill name as it appears in the log
  tactics: { sneakOk: number; sneakFail: number; charge: number; ambush: number; flanking: number; behind: number };
  field: Record<string, number>; // FIELD_RES counts
  combosByAct: Record<number, number>; // field reactions set off by a hero's skill, per act
  items: Record<string, number>; // ITEM_RES counts
  elites: Record<string, number>; // ELITE_RES counts
  ai: Record<string, number>; // AI_RES counts
  swings: Record<number, Swings>; // attack rolls per act, monsters on heroes and heroes on monsters
  difficulty: Difficulty;
  monsterAi: MonsterAi;
  party: number; // heroes in the run
  goldAtEnd: number;
  goldByAct: Record<number, number>; // the purse when each act ends (before the next act's first shop)
  spentByAct: Record<number, number>; // gold spent in shops per act
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

export interface Swings {
  mSwings: number;
  mHits: number;
  mDmg: number; // damage from the monsters' hits
  hSwings: number;
  hHits: number;
}

export const whereLabel = (at: RunResult['at']) => (at ? `A${at.act} ${at.boss ? 'boss' : `r${at.row}`}` : '-');

export interface RunOptions {
  url: string;
  heroes: number;
  difficulty?: Difficulty; // Normal if unset
  monsterAi?: MonsterAi; // scripted if unset
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
    swings: {},
    difficulty: opts.difficulty ?? 'normal',
    monsterAi: opts.monsterAi ?? 'scripted',
    party: opts.heroes,
    goldAtEnd: 0,
    goldByAct: {},
    spentByAct: {},
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
  // Damage dealt per hero entity id: each monster's dmgBy only grows, so the last one seen in a fight is its total.
  const dmgSeen = new Map<string, Record<string, number>>();
  const dmgTotal: Record<string, number> = {};
  const bankDamage = () => {
    for (const by of dmgSeen.values()) for (const [id, n] of Object.entries(by)) dmgTotal[id] = (dmgTotal[id] ?? 0) + n;
    dmgSeen.clear();
  };
  const partyHp = (s: GameState) => {
    const hs = s.entities.filter((e) => e.kind === 'player');
    const max = hs.reduce((a, e) => a + e.maxHp, 0);
    return max ? hs.reduce((a, e) => a + Math.max(0, e.hp), 0) / max : 0;
  };

  const observe = (s: GameState) => {
    box.s = s;
    r.states++;
    lastStateAt = Date.now();
    for (const l of s.log) {
      if (l.id <= lastLogId) continue;
      lastLogId = l.id;
      const enc = ENCOUNTER_RE.exec(l.text);
      if (enc && !/ uses /.test(enc[1])) lastEncounter = enc[1]; // not "⚔️ Ann uses Relentless: ..."
      if (/Act \d+ complete|VICTORY/.test(l.text)) {
        r.actsCleared++;
        // "Act 1 complete" is logged once the run is already in act 2: take the act from the line.
        const done = /Act (\d+) complete/.exec(l.text);
        if (s.run) r.goldByAct[done ? Number(done[1]) : s.run.act] = s.run.gold;
      }
      const paid = /^🛒 .* (?:buys .* for|pays) (\d+) gold/.exec(l.text);
      if (paid && s.run) r.spentByAct[s.run.act] = (r.spentByAct[s.run.act] ?? 0) + Number(paid[1]);
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
      for (const [name, re] of [...AI_RES, ...HERO_RES, ...ENGINE_RES]) if (re.test(l.text)) r.ai[name] = (r.ai[name] ?? 0) + 1;
      if (/^🛒 A merchant spreads/.test(l.text)) r.shops++;
      // A reaction right after a hero's skill line is a combo the heroes set off (not a monster's firebomb).
      if (REACTION_RE.test(l.text) && heroActed && s.run) r.combosByAct[s.run.act] = (r.combosByAct[s.run.act] ?? 0) + 1;
      if (/ uses | attacks .*\(|'s .* \((DEX|STR|WIS) save|'s .*: \d+ hits? strike| hits the (Oil Barrel|Brazier)/.test(l.text)) {
        heroActed = s.players.some((p) => l.text.startsWith(p.name) || [`${p.name} uses `, `${p.name} hits the`, ` ${p.name}'s `].some((x) => l.text.includes(x)));
      } else if (!REACTION_RE.test(l.text) && !/caught in|is shocked|is stunned|freezes|knocked back|Friendly fire/.test(l.text)) heroActed = false;
      if (/ shoves | tries to shove /.test(l.text)) r.skillUses.Shove = (r.skillUses.Shove ?? 0) + 1;
      // Attack rolls: "Giant Rat bites Host: 🎲9+5=14 vs AC 16, miss", "Host attacks Giant Rat (Longsword): 🎲... hit for 6".
      if (s.run && / vs AC \d+/.test(l.text) && (l.kind === 'hit' || l.kind === 'miss')) {
        const byHero = s.players.some((p) => l.text.startsWith(`${p.name} `));
        const onHero = s.players.some((p) => l.text.includes(` ${p.name}: 🎲`) || l.text.includes(` ${p.name} (`));
        const sw = (r.swings[s.run.act] ??= { mSwings: 0, mHits: 0, mDmg: 0, hSwings: 0, hHits: 0 });
        const dealt = /(?:hit|HIT) for (\d+)/.exec(l.text);
        if (!byHero && onHero) {
          sw.mSwings++;
          if (dealt) {
            sw.mHits++;
            sw.mDmg += Number(dealt[1]);
          }
        } else if (byHero && !onHero) {
          sw.hSwings++;
          if (dealt) sw.hHits++;
        }
      }
      if (l.kind !== 'death') continue;
      const fell = /^\S+ (.+?) falls unconscious/.exec(l.text);
      if (fell) {
        r.downs.push(classOf(s, fell[1]));
        if (fight) fight.downs++;
      }
      const died = /^\S+ (.+?) has died/.exec(l.text);
      if (died) {
        r.deaths.push(classOf(s, died[1]));
        if (fight) fight.deaths++;
      }
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
      fight = { act: run?.act ?? 0, row: node?.row ?? 0, kind: s.roomKind ?? '?', name: lastEncounter, won: false, rounds: 1, downs: 0, deaths: 0, startHp: partyHp(s), minHp: 1, endHp: 1 };
    }
    if (fight && s.phase === 'combat') {
      const hp = partyHp(s);
      fight.minHp = Math.min(fight.minHp, hp);
      fight.endHp = hp;
      for (const e of s.entities) if (e.kind === 'monster' && e.dmgBy) dmgSeen.set(e.id, { ...e.dmgBy });
    }
    if (fight && s.turn) {
      const before = fight.rounds;
      fight.rounds = Math.max(fight.rounds, s.turn.round);
      if (fight.rounds > MAX_ROUNDS && before <= MAX_ROUNDS) {
        // Once per fight, with the end of the log and who's still standing, to see what goes round in circles.
        const who = s.entities.map((e) => `${e.name} ${e.hp}/${e.maxHp}${e.statuses.length ? ` [${e.statuses.map((x) => x.id).join(',')}]` : ''}`).join('; ');
        // LIVELOCK_DIR=<dir>: also keep the whole state, to replay the turn (e.g. nextHeroIntent on it).
        if (process.env.LIVELOCK_DIR) fs.writeFileSync(`${process.env.LIVELOCK_DIR}/livelock-${r.code}.json`, JSON.stringify(s));
        r.anomalies.push(`fight "${fight.name}" (A${fight.act} r${fight.row}) passed ${MAX_ROUNDS} rounds: livelock?\n    ${who}\n    ${s.log.slice(-25).map((l) => l.text).join('\n    ')}`);
      }
    }
    if (fight && s.phase !== 'combat') {
      fight.won = s.phase !== 'defeat';
      r.fights.push(fight);
      fight = null;
      bankDamage();
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
    const stuck = s.entities.filter((e): e is PlayerEntity => e.kind === 'player' && t.group.includes(e.id)); // a shared turn: maybe several
    if (!stuck.length) return;
    reportedTurns.add(turnKey);
    r.anomalies.push(
      `${stuck.map((e) => `${e.name} (${e.classId})`).join(', ')} stuck on their turn for ${Math.round((now - turnSince) / 1000)}s: round ${t.round}, ` +
        stuck.map((e) => `${e.name}: moves left ${t.acts[e.id]?.moves}, ${t.acts[e.id]?.ap} AP left, hp ${e.hp}/${e.maxHp}`).join('; '),
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
    socket.emit('setMonsterAi', r.monsterAi);
    await waitFor('the monster AI (is there a trained policy on the server?)', () => box.s?.monsterAi === r.monsterAi);
    opts.onStart?.(res.code);
    socket.emit('start');
    await waitFor('the run to start', () => !!box.s && box.s.phase !== 'lobby');
    r.party = box.s!.entities.filter((e) => e.kind === 'player').length; // small parties get bots on top (MIN_PARTY)
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
        engine: ((id) => (id ? ENGINES[id].name : undefined))(topEngine(e)),
        dmg: dmgTotal[e.id] ?? 0,
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

export function report(results: RunResult[], heroes: string, elapsed: number) {
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
    ['class', 'heroes', 'avg kills', 'avg steals', 'avg level', 'dmg share', 'downs', 'deaths'],
    ...classes.map((c) => {
      const hs = results.flatMap((r) => r.heroes.filter((h) => h.classId === c));
      const downs = results.reduce((a, r) => a + r.downs.filter((x) => x === c).length, 0);
      const deaths = results.reduce((a, r) => a + r.deaths.filter((x) => x === c).length, 0);
      // Damage share: a hero's part of the party's damage times the party size, so 1.00 is an even share.
      const shares = results.flatMap((r) => {
        const total = r.heroes.reduce((a, h) => a + (h.dmg ?? 0), 0);
        return total ? r.heroes.filter((h) => h.classId === c).map((h) => ((h.dmg ?? 0) / total) * r.heroes.length) : [];
      });
      return [c, String(hs.length), avg(hs.map((h) => h.kills)).toFixed(1), avg(hs.map((h) => h.steals)).toFixed(1), avg(hs.map((h) => h.level)).toFixed(1), avg(shares).toFixed(2), String(downs), String(deaths)];
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
  const won = results.filter((r) => r.goldByAct);
  console.log(
    `gold per act (purse at the act's end / spent in shops): ${[1, 2, 3].map((a) => `A${a} ${avg(won.filter((r) => r.goldByAct[a] !== undefined).map((r) => r.goldByAct[a])).toFixed(0)} / ${avg(won.map((r) => r.spentByAct?.[a] ?? 0)).toFixed(0)}`).join(' · ')}`,
  );
  const elites = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.elites)) elites.set(k, (elites.get(k) ?? 0) + v);
  console.log(`elites: ${ELITE_RES.map(([k]) => `${k} ${elites.get(k) ?? 0}`).join(' · ')}`);
  const ai = new Map<string, number>();
  for (const r of results) for (const [k, v] of Object.entries(r.ai)) ai.set(k, (ai.get(k) ?? 0) + v);
  console.log(`monster AI: ${AI_RES.map(([k]) => `${k} ${ai.get(k) ?? 0}`).join(' · ')}`);
  console.log(`hero tricks: ${HERO_RES.map(([k]) => `${k} ${ai.get(k) ?? 0}`).join(' · ')}`);
  console.log(`engines: ${ENGINE_RES.map(([k]) => `${k} ${ai.get(k) ?? 0}`).join(' · ')}`);
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
  const ais = MONSTER_AI_IDS.filter((a) => results.some((r) => r.monsterAi === a));
  if (ais.length > 1) {
    console.log('\nper monster AI:');
    const rows = [['', 'runs', 'won', 'lost', 'fights won', 'acts cleared', 'downs/run', 'deaths/run']];
    for (const a of ais) {
      const rs = results.filter((r) => r.monsterAi === a);
      const won = rs.filter((r) => r.outcome === 'victory').length;
      rows.push([
        `${MONSTER_AIS[a].icon} ${MONSTER_AIS[a].name}`, String(rs.length), `${won} (${pct(won, rs.length)})`, String(rs.filter((r) => r.outcome === 'defeat').length),
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
    const builds = new Map<string, number>();
    for (const r of results) for (const h of r.heroes) builds.set(`${h.classId} ${h.engine ?? '(no engine)'}`, (builds.get(`${h.classId} ${h.engine ?? '(no engine)'}`) ?? 0) + 1);
    console.log(`main engines at the end: ${[...builds].sort().map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    console.log(`builds at the end of run ${last.code}:`);
    for (const h of last.heroes) console.log(`  ${h.name} (${h.classId} ${h.level}): ${h.skills.join(', ')}`);
    console.log(`  items: ${last.gearAtEnd.join(' | ')}`);
    console.log(`  relics: ${last.relicsAtEnd.join(', ') || '-'}`);
  }

  if (diffs.length) {
    // How close the fights are, which says more than wins while the bots win everything: downs per fight and the
    // party's lowest HP during a fight, per difficulty, act and kind of fight.
    console.log('\npressure (downs per fight, lowest party HP on average, rounds, ✝ wipes, (fights)) per difficulty and act:');
    const kinds = ['combat', 'elite', 'boss'];
    const rows = [['', ...kinds, 'start HP', 'deaths/fight']];
    for (const d of diffs) {
      for (let a = 1; a <= 3; a++) {
        const fs = results.filter((r) => r.difficulty === d).flatMap((r) => r.fights.filter((f) => f.act === a && f.minHp !== undefined));
        if (!fs.length) continue;
        rows.push([
          `${label(d)} A${a}`,
          ...kinds.map((k) => {
            const ks = fs.filter((f) => f.kind === k);
            const wipes = ks.filter((f) => !f.won).length;
            const rounds = `${avg(ks.map((f) => f.rounds)).toFixed(1)}r`;
            return ks.length ? `${avg(ks.map((f) => f.downs)).toFixed(2)}↓ ${Math.round(avg(ks.map((f) => f.minHp)) * 100)}% ${rounds}${wipes ? ` ✝${wipes}` : ''} (${ks.length})` : '-';
          }),
          `${Math.round(avg(fs.filter((f) => f.startHp !== undefined).map((f) => f.startHp)) * 100)}%`,
          avg(fs.map((f) => f.deaths)).toFixed(2),
        ]);
      }
    }
    printTable(rows);
    console.log('\nattack rolls per difficulty and act (monsters on heroes: hit rate, damage per hit; heroes on monsters: hit rate):');
    const rows3 = [['', 'monsters hit', 'dmg/hit', 'heroes hit', 'rounds']];
    for (const d of diffs) {
      for (let a = 1; a <= 3; a++) {
        const rs = results.filter((r) => r.difficulty === d);
        const sw = rs.map((r) => r.swings?.[a]).filter((x): x is Swings => !!x);
        if (!sw.length) continue;
        const t = (k: keyof Swings) => sw.reduce((n, x) => n + x[k], 0);
        const fs = rs.flatMap((r) => r.fights.filter((f) => f.act === a));
        rows3.push([`${label(d)} A${a}`, pct(t('mHits'), t('mSwings')), (t('mDmg') / Math.max(1, t('mHits'))).toFixed(1), pct(t('hHits'), t('hSwings')), avg(fs.map((f) => f.rounds)).toFixed(1)]);
      }
    }
    printTable(rows3);
    if (sizes.length > 1) {
      console.log('\ndowns per fight and lowest party HP per difficulty and party size:');
      const rows2 = [['', ...sizes.map((n) => `${n} heroes`)]];
      for (const d of diffs) {
        rows2.push([label(d), ...sizes.map((n) => {
          const fs = results.filter((r) => r.difficulty === d && r.party === n).flatMap((r) => r.fights.filter((f) => f.minHp !== undefined));
          return fs.length ? `${avg(fs.map((f) => f.downs)).toFixed(2)}↓ ${Math.round(avg(fs.map((f) => f.minHp)) * 100)}%` : '-';
        })]);
      }
      printTable(rows2);
    }
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
  // Party size, or a list like 3,4,5,6 to spread the runs over several sizes (each size gets every difficulty in DIFF).
  // Fewer than MIN_PARTY (3) still plays: the server fills the party up with bots, and the report counts the real size.
  const SIZES = (process.argv[3] ?? '4').split(',').map((v) => Math.min(MAX_PLAYERS, int(v, 4)));
  const CONCURRENCY = Math.min(RUNS, int(process.argv[4], 4));
  const TIMEOUT_S = int(process.env.RUN_TIMEOUT_S, 900);
  const url = process.env.URL ?? 'http://localhost:3000';
  // DIFF=story|normal|hard, or DIFF=all to spread the runs over all three.
  const DIFFS: Difficulty[] = process.env.DIFF === 'all' ? DIFFICULTY_IDS : [isDifficulty(process.env.DIFF) ? process.env.DIFF : 'normal'];
  // MONSTER_AI=scripted|ppo, or MONSTER_AI=all to compare them (ppo needs server/policies/monster-ppo.json).
  const AIS: MonsterAi[] = process.env.MONSTER_AI === 'all' ? MONSTER_AI_IDS : [isMonsterAi(process.env.MONSTER_AI) ? process.env.MONSTER_AI : 'scripted'];
  console.log(`${RUNS} runs x ${SIZES.join('/')} heroes on ${url}, ${CONCURRENCY} at a time, ${TIMEOUT_S}s limit per run, difficulty ${DIFFS.join('/')}, monsters ${AIS.join('/')}`);

  const results: RunResult[] = [];
  let next = 0;
  const startedAt = Date.now();
  const worker = async () => {
    while (next < RUNS) {
      const difficulty = DIFFS[next % DIFFS.length];
      const heroes = SIZES[Math.floor(next / DIFFS.length) % SIZES.length];
      const monsterAi = AIS[Math.floor(next / (DIFFS.length * SIZES.length)) % AIS.length];
      next++;
      const r = await playRun({ url, heroes, timeoutS: TIMEOUT_S, difficulty, monsterAi });
      results.push(r);
      const levels = r.heroes.map((h) => h.level).join('/') || '-';
      const verdict = r.outcome === 'victory' ? 'WIN' : r.outcome === 'defeat' ? `lost at ${whereLabel(r.at)} to ${r.killer ?? '?'}` : `${r.outcome.toUpperCase()} at ${whereLabel(r.at)}`;
      console.log(`[${results.length}/${RUNS}] ${r.code || '----'} ${DIFFICULTIES[r.difficulty].icon}${r.monsterAi === 'ppo' ? '🧠' : ''} ${r.party}p ${verdict}; ${r.seconds.toFixed(1)}s; fights won ${r.fights.filter((f) => f.won).length}; levels ${levels}${r.anomalies.length ? `; ${r.anomalies.length} ANOMALIES` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results));
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
