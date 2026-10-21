// One game room. The server is the Dungeon Master: it owns the state, rolls every die,
// runs the monsters and broadcasts a snapshot to everyone in the room after each change.
//
// A run: 3 acts. Each act is a node map the party votes its way up; fights happen in small rooms.
// Heroes earn XP (killing blows earn extra), level up and pick upgrades; skills are data in shared/skills.ts.

import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { canStep, dist, findPath, hasLOS, isBlocked } from '../shared/grid.ts';
import {
  ACTS,
  ACT_ROWS,
  type EncounterDef,
  hardId,
  AMBUSH_CHANCE,
  BREATH_DC,
  CLASSES,
  CLASS_IDS,
  AP_GAIN,
  AP_MAX,
  HELP_UP_HP,
  INJURY_PCT,
  MAX_INJURIES,
  POTION_ODDS,
  POTION_ODDS_STEP,
  CHARGE_MOVES,
  COWARD_TURNS,
  DIFFICULTIES,
  HELP,
  MONSTER_AIS,
  LEVEL_CAP,
  MAX_ACT,
  MAX_PLAYERS,
  MIN_PARTY,
  MONSTERS,
  ORDERS,
  ORDER_EVERY,
  ORDER_RANGE,
  ORDER_STATUS,
  PLAYER_COLORS,
  REST_HEAL,
  REST_MS,
  STEAL_SHARE,
  CONTINUE_MS,
  PICK_WAIT_MS,
  VOTE_MS,
  XP_BUFF,
  XP_CATCH_UP,
  XP_HEAL,
  XP_REVIVE,
  encounterBudget,
  fmtMod,
  isDifficulty,
  isMonsterAi,
  BOSS,
  BREATHER,
  ELITE,
  MAX_DOWNS,
  WARMUP_BUDGET,
  actScaling,
  partyScaling,
  rollDice,
  rollDie,
  roomGold,
  scaledHp,
  tune,
  sneakDice,
  monsterSave,
  statMod,
  type Stat,
  stealthBonus,
  stealthDc,
  type Dice,
  type Difficulty,
  type MonsterAi,
  type MonsterRider,
} from '../shared/rules.ts';
import {
  ROOTED,
  SKILLS,
  SKIP_TURN,
  SLOWED,
  CLEANSED,
  STATUSES,
  apOf,
  atEdge,
  attackBonus,
  avgDice,
  blockOf,
  damageMod,
  debuffsOn,
  stacksOf,
  hasBranch,
  hpCostOf,
  isSignature,
  hasStatus,
  healBonus,
  heroDc,
  hitsOf,
  isSkillId,
  itemInfo,
  nextTier,
  ownedSkill,
  passiveOf,
  resolveAim,
  skillBlockReason,
  skillTitle,
  topEngine,
  slotCost,
  statsAt,
  statsOf,
  type AimResult,
  type Element,
  type SkillId,
  type PerSource,
  type SkillStats,
  type StatusApply,
  type StatusId,
} from '../shared/skills.ts';
import {
  BLESSINGS,
  BLESSING_IDS,
  CONSUMABLE_IDS,
  FORGET_PRICE,
  ITEMS,
  GEAR_IDS,
  POTION_PRICE,
  RELICS,
  RELIC_IDS,
  RELIC_ODDS,
  RELIC_PRICE,
  RENEWAL_HP,
  bagRoom,
  gearAlert,
  gearBonus,
  gearDef,
  isBlessingId,
  isItemId,
  isRelicId,
  itemPrice,
  pickRarity,
  rarityPool,
  rollRarity,
  sellPrice,
  trainPrice,
  weaponExtras,
  type BlessingId,
  type ItemId,
  type Rarity,
  type RelicId,
} from '../shared/items.ts';
import {
  ALLIES,
  ALLY_FIGHTS,
  ALLY_IDS,
  AURA_DICE,
  ENRAGED_DMG,
  MAX_ALLIES,
  MAX_SUMMONS,
  SUMMON_EVERY,
  TRAITS,
  TRAIT_IDS,
  WARD_EVERY,
  WARD_SHARE,
  allyScaling,
  auraOf,
  hasTrait,
  isAllyId,
  isAllyNpc,
  isFoe,
  sameSide,
  traitCount,
  type AllyId,
  type TraitId,
} from '../shared/elites.ts';
import type {
  AllyState,
  ClassId,
  Entity,
  ItemRequest,
  ShopOffer,
  ShopRequest,
  ShopView,
  Fx,
  GameState,
  LogKind,
  LogLine,
  MapNode,
  MonsterEntity,
  NodeType,
  EventView,
  Notice,
  OfferCard,
  OwnedSkill,
  Phase,
  PickRequest,
  PlayerEntity,
  PlayerInfo,
  Pos,
  RestPick,
  RunInfo,
  TurnActs,
  TurnState,
  TurnView,
} from '../shared/types.ts';
import { attackAdvantage, canReact, coverFrom, coverWord, dirTo, netAdvantage, turnsToFace } from '../shared/tactics.ts';
import { LOW_COVER } from '../shared/grid.ts';
import {
  EXPLOSION,
  FIELD_STATUS_TURNS,
  HAZARD_DICE,
  ICE_DC,
  PROPS,
  REACTIONS,
  aimFieldOps,
  applyField,
  damageFactor,
  fieldElement,
  hazardAt,
  immuneToStatus,
  moveArea,
  planFreeWalk,
  planWalk,
  selfFieldOps,
  tickField,
  tilePos,
  tilesAround,
  type CloudMap,
  type FieldOp,
  type GroundMap,
  type PropMap,
} from '../shared/surfaces.ts';
import { generateActMap } from './actmap.ts';
import { getEvent, pickEvent, type CheckResult, type EventChoiceDef, type EventDef, type EventEffect, type EventStat } from './events.ts';
import { BARK_ODDS, barkLine, type BarkEvent } from './barks.ts';
import { BOT_NAMES, LOW_HP, calloutLine, newChatter, tryCallout, type CallEvent, type CallVars } from './companions.ts';
import { autoApproachChoice, autoEquip, autoEventChoice, autoGive, autoLevelPick, autoPathChoice, autoRestPick, autoShopPick, nextHeroIntent, upkeepIntent } from './heroai.ts';
import {
  canHitFrom, elementOf, monsterChoices, pickOrder, planMonster, shoveResist, squadFocus, squadPlan,
  type MonsterChoices, type MonsterOrder, type MonsterPlan, type MonsterView,
} from './monsterai.ts';
import { monsterPolicy } from './policy.ts';
import { applyLevelUps, applyPick, dealOffer, killShares, picksLeft, recalcHero, startingSkills, upgrade, validCard, validRestPick } from './progression.ts';
import { pick, randInt, rng, shuffle } from './rng.ts';
import { generateRoom, pickDeployment, type Deployment } from './room.ts';
import { SAVE_VERSION, archiveSave, dumpFight, writeSave, type SaveFile, type SavePoint } from './saves.ts';
import { Journal } from './journal.ts';
import { ENGINES } from '../shared/engines.ts';

/**
 * Chooses a monster's move from the options the monster AI lists (Phase 11): the trained PPO policy, or the RL
 * trainer itself (training/env.ts). Returns the option's index.
 */
export type MonsterBrain = (m: MonsterEntity, choices: MonsterChoices) => number | Promise<number>;

// Dev knobs for bot testing: DELVERS_SPEED=10 makes monster turns 10x faster, DELVERS_ROWS=4 makes acts short.
const SPEED = Math.max(0.1, Number(process.env.DELVERS_SPEED) || 1);
const ROWS = Math.max(3, Number(process.env.DELVERS_ROWS) || ACT_ROWS);
if (process.env.DELVERS_TUNE) tune(JSON.parse(process.env.DELVERS_TUNE)); // the balance pass's knobs (shared/rules.ts TUNABLES)

const STEP_MS = 120 / SPEED; // player walking speed
const MONSTER_STEP_MS = 170; // passed through sleep(), which applies SPEED
const LOG_LIMIT = 80;
const MAX_ROOM_MONSTERS = 6;
const AUTO_DELAY_MS = 700; // pause before auto heroes vote, pick or use potions between rooms
const SHOP_MS = 90_000; // the shop closes this long after the first person is done shopping
const AWAY_MS = 20_000; // ...or this long after everyone left is someone who dropped out (a reload shouldn't close it)
/** The smites: Zealous Smite and Avenging Angel work on these. */
const SMITES: SkillId[] = ['divine_smite', 'radiant_strike'];
/** Poison from heroes stacks up to this (Virulence raises it). */
const POISON_CAP = 10;

/** What the log says about where a fight starts (the classic line says nothing). */
const DEPLOYMENT_LINE: Partial<Record<Deployment, string>> = {
  scattered: '🌫️ The party comes in by two ways, and the monsters are spread around the room.',
  pincer: "⚠️ A pincer! They're coming at you from both ends of the room.",
  surrounded: '⚠️ Surrounded! They come at you from every corner.',
  camp: '🔥 You come upon their camp from three sides at once.',
};

/** The icon a pick's log line starts with, by kind. */
const PICK_ICON = { level: '⬆️', elite: '💀', reward: '🏆' } as const;

const ELEMENT_COLOR: Record<Element, string> = {
  physical: '#ffe9a8', fire: '#ff8a3d', cold: '#8fd8ff', lightning: '#fff36b', poison: '#8fdc5a', radiant: '#ffe27a', force: '#c58bff',
};

/** The run's first fight: a smaller one, from the classic line (WARMUP_BUDGET). */
const isWarmup = (act: number, node: MapNode) => act === 1 && node.row === 0 && node.type === 'combat';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / SPEED));

/** What makes an encounter template's fight different: how it starts, and its own ground (shared/rules.ts EncounterDef). */
type Twist = Pick<EncounterDef, 'deploy' | 'terrain'>;

interface Walk {
  path: Pos[];
  hazards: Pos[]; // the dangerous tiles the plan knowingly crosses
  timer: ReturnType<typeof setTimeout> | null;
}

interface Vote {
  kind: 'path' | 'event' | 'approach' | 'continue';
  options: string[];
  votes: Record<string, string>;
  deadline: number | null;
}

/** Everything one attack roll needs. Heroes' skills and monsters' attacks both go through it. */
interface AttackOpts {
  bonus: number; // to hit
  dmg: Dice;
  extra?: number; // flat damage on top of the dice
  verb: string;
  weapon?: string;
  element: Element;
  adv?: boolean;
  sneak?: boolean;
  execute?: Dice;
  critFull?: boolean;
  basic?: boolean; // a basic weapon attack (Divine Strike)
}

export class Game {
  readonly code: string;
  width = 0; // the current room (0 when the party is on the map)
  height = 0;
  tiles = '';
  ground: GroundMap = {}; // the battlefield (shared/surfaces.ts)
  clouds: CloudMap = {};
  props: PropMap = {};
  phase: Phase = 'lobby';
  emptySince: number | null = Date.now();

  private readonly io: Server;
  private players: PlayerInfo[] = [];
  private sockets = new Map<string, number>(); // playerId -> open connections
  private run: RunInfo | null = null;
  private vote: Vote | null = null;
  private voteTimer: ReturnType<typeof setTimeout> | null = null;
  private autoVoteTimer: ReturnType<typeof setTimeout> | null = null;
  private restPicks: Record<string, RestPick> | null = null; // the open rest site, if any
  private restDeadline: number | null = null;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private approachDc: number | null = null; // the Sneak-or-Charge vote before a fight
  private heroTurns = new Map<string, number>(); // hero id -> the turn their auto-play is playing
  private event: (EventDef & Pick<EventView, 'chosen' | 'lines'>) | null = null;
  private onContinue: (() => void) | null = null; // where an outcome screen's Continue leads
  private pickAt = new Map<string, number>(); // playerId -> when auto-play makes the pick for a person who has it on
  private pickTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private restAutoAt: number | null = null; // when auto-play chooses at the rest site for the people who have it on
  private told: string[] | null = null; // collecting what gets logged, for an outcome screen's lines
  private seenEvents: string[] = [];
  private notice: Notice | null = null;
  private roomKind: NodeType | null = null;
  private lastChecker: string | null = null; // hero who made the last event check
  private entities: Entity[] = [];
  private turn: TurnState | null = null;
  private log: LogLine[] = [];
  private logId = 0;
  private idSeq = 0;
  private fx: Fx[] = [];
  private walks = new Map<string, Walk>();
  private turnToken = 0; // bumps on every turn change so stale timers/AI loops stop
  private broadcastQueued = false;
  private resumeFrom: SaveFile | null = null; // a loaded save waiting in the tavern
  private savePoint: SavePoint = { kind: 'map' }; // where a restart would pick the run back up
  private createdAt = Date.now();
  private deferredBursts: { ops: FieldOp[]; by?: Entity }[] | null = null; // death bursts held until the killing skill is done
  private shop: Omit<ShopView, 'endsInMs'> | null = null; // the open shop, if any
  private shopDeadline: number | null = null;
  private shopTimer: ReturnType<typeof setTimeout> | null = null;
  private shopReceipts: string[] = []; // what was bought, for the notice when the party moves on
  private eliteKiller: string | null = null; // the hero who landed the killing blow on this fight's elite (they take its gear)
  private phoenixUsed = false; // Phoenix Feather: once per fight
  private journal: Journal | null = null; // the run journal (server/journal.ts), from the run's start
  private fightMeta: { kind: string; name: string; deployment: string } | null = null; // the room being fought in
  private slain = 0; // monsters fallen this fight (Raise Dead needs a body)
  private turnStarted = 0; // when the current turn began (the journal times turns)
  private turnSize = 1; // how many began it together (heroes side by side share a turn)
  private fallen: { type: string; x: number; y: number; at: number }[] = []; // Rise Again: minions to stand back up, and when
  /** This fight's numbers for the journal: downs and deaths, the party's HP share (start, lowest), damage per hero. */
  private fightStats: { downs: number; deaths: number; startHp: number; minHp: number; dmg: Record<string, number> } | null = null;
  private chatter = newChatter(); // who among the bots has spoken lately (callouts, server/companions.ts)
  private difficulty: Difficulty = 'normal'; // the lobby's pick; a run keeps its own (run.difficulty)
  private monsterAi: MonsterAi = 'scripted'; // likewise (run.monsterAi)
  /** Takes the monsters' choices over from the scripted AI: the RL trainer sets it (training/env.ts). */
  monsterBrain: MonsterBrain | null = null;

  constructor(io: Server, code: string) {
    this.io = io;
    this.code = code;
  }

  /** A room rebuilt from a save: the party waits in the tavern until the host continues. */
  static fromSave(io: Server, save: SaveFile): Game {
    const g = new Game(io, save.code);
    g.resumeFrom = save;
    g.createdAt = save.createdAt;
    // Bots come back on their own; everyone else is away until they rejoin.
    g.players = save.players.map((p) => ({ ...p, connected: p.bot, auto: p.bot }));
    g.difficulty = isDifficulty(save.run.difficulty) ? save.run.difficulty : 'normal'; // saves from before Phase 9 play on Normal
    g.monsterAi = isMonsterAi(save.run.monsterAi) ? save.run.monsterAi : 'scripted';
    g.log = save.log.slice(-30);
    g.logId = Math.max(0, ...g.log.map((l) => l.id));
    g.addLog('system', `📜 Saved run loaded: Act ${save.run.act}, ${save.run.actName}. Rejoin your hero, then the host continues.`);
    return g;
  }

  /** People in the room right now (not bots). */
  get online(): number {
    return this.players.filter((p) => p.connected && !p.bot).length;
  }

  private savedHero(playerId: string) {
    return this.resumeFrom?.heroes.find((h) => h.playerId === playerId);
  }

  // ------------------------------------------------------------ players & lobby

  private get hostId(): string | null {
    return this.players.find((p) => p.connected && !p.bot)?.id ?? null;
  }

  /** Real people at the keyboard right now (not bots, not on auto, not disconnected). */
  private humans(): PlayerInfo[] {
    return this.players.filter((p) => p.connected && !p.bot && !p.auto);
  }

  /** A person at the keyboard with auto-play on: the AI fights for them, but each pick waits PICK_WAIT_MS for them. */
  private watching(playerId: string): boolean {
    const info = this.players.find((p) => p.id === playerId);
    return !!info && info.auto && info.connected && !info.bot;
  }

  /** Auto-play covers bots, players who switched it on, and players who dropped out. */
  private isAuto(playerId: string): boolean {
    const info = this.players.find((p) => p.id === playerId);
    return !!info && (info.bot || info.auto || !info.connected);
  }

  handleSetAuto(playerId: string, on: boolean) {
    const info = this.players.find((p) => p.id === playerId);
    if (!info || info.bot || info.auto === !!on) return;
    info.auto = !!on;
    this.addLog('system', `🤖 ${info.name} turned auto-play ${info.auto ? 'on' : 'off'}.`);
    const e = this.hero(playerId);
    if (info.auto && e && this.acting(e)) this.runHero(e, this.turnToken);
    if (info.auto && this.phase === 'map') this.scheduleUpkeep();
    this.onHumansChanged();
    this.broadcast();
  }

  addBot(playerId: string) {
    if (playerId !== this.hostId || this.phase === 'victory' || this.phase === 'defeat') return;
    if (this.players.length >= MAX_PLAYERS) return this.whisper(playerId, `The party is full (max ${MAX_PLAYERS}).`);
    // A class the party doesn't have yet, one that fills a missing role (front line, healer, ranged) if it can.
    const taken = new Set(this.players.map((p) => p.classId));
    const covered = new Set([...taken].flatMap((c) => CLASSES[c].roles));
    const free = CLASS_IDS.filter((c) => !taken.has(c));
    const needed = free.filter((c) => CLASSES[c].roles.some((r) => !covered.has(r)));
    const classId = pick(needed.length ? needed : free.length ? free : CLASS_IDS);
    const names = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !names.has(n)) ?? `Bot ${this.players.length + 1}`;
    const used = new Set(this.players.map((p) => p.color));
    const info: PlayerInfo = {
      id: randomUUID(), name, classId, color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0],
      connected: true, auto: true, bot: true,
    };
    this.players.push(info);
    this.addLog('system', `🤖 ${name} the ${CLASSES[classId].name} (bot) joined the party.`);
    if (this.run) this.spawnLatecomer(info);
    this.broadcast();
  }

  removeBot(playerId: string, botId: string) {
    if (playerId !== this.hostId || this.phase !== 'lobby') return;
    const bot = this.players.find((p) => p.id === botId && p.bot);
    if (!bot) return;
    this.players = this.players.filter((p) => p !== bot);
    if (this.resumeFrom) this.resumeFrom.heroes = this.resumeFrom.heroes.filter((h) => h.playerId !== bot.id);
    this.addLog('system', `🤖 ${bot.name} left the party.`);
    this.broadcast();
  }

  /** The host picks a bot's class in the tavern. A saved run's bots keep theirs (their hero is already built). */
  setBotClass(playerId: string, botId: string, classId: unknown) {
    if (playerId !== this.hostId || this.phase !== 'lobby' || typeof classId !== 'string' || !Object.hasOwn(CLASSES, classId)) return;
    const bot = this.players.find((p) => p.id === botId && p.bot);
    if (!bot || bot.classId === classId) return;
    if (this.savedHero(botId)) return this.whisper(playerId, `${bot.name} is a saved hero and keeps their class.`);
    bot.classId = classId as ClassId;
    this.addLog('system', `🤖 ${bot.name} will play the ${CLASSES[bot.classId].name}.`);
    this.broadcast();
  }

  /** In a resumed tavern, a newcomer takes over a saved hero whose player isn't here. */
  claimHero(playerId: string, heroPlayerId: string) {
    const me = this.players.find((p) => p.id === playerId);
    const owner = this.players.find((p) => p.id === heroPlayerId);
    const hero = this.savedHero(heroPlayerId);
    if (this.phase !== 'lobby' || !me || !owner || !hero || this.savedHero(playerId)) return;
    if (owner.connected || owner.bot) return this.whisper(playerId, `${owner.name} is already here.`);
    hero.playerId = me.id;
    Object.assign(me, { name: owner.name, classId: owner.classId, color: owner.color });
    this.players = this.players.filter((p) => p !== owner);
    this.addLog('system', `📜 ${me.name} is back in the party.`);
    this.broadcast();
  }

  /** Votes, rest picks and level-up picks may be ready once the set of humans changes (someone went auto, left or came back). */
  private onHumansChanged() {
    this.scheduleAutoPicks();
    if (this.restPicks) this.scheduleAutoRest();
    if (this.shop) this.maybeCloseShop();
    if (!this.vote) return;
    this.maybeResolveVote();
    this.scheduleAutoVotes();
  }

  join(playerId: string | undefined, name: string, classId: ClassId): { ok: true; playerId: string } | { ok: false; error: string } {
    let info = playerId ? this.players.find((p) => p.id === playerId) : undefined;
    // Lost your session (new device, server restart)? Typing the same name gets you your hero back.
    info ??= this.players.find((p) => !p.connected && !p.bot && p.name.toLowerCase() === name.toLowerCase());
    if (info) {
      if (!info.connected && (this.phase !== 'lobby' || this.resumeFrom)) this.addLog('system', `${info.name} is back.`);
    } else {
      if (this.players.length >= MAX_PLAYERS) return { ok: false, error: `This room is full (max ${MAX_PLAYERS} players).` };
      const used = new Set(this.players.map((p) => p.color));
      info = {
        id: randomUUID(), name, classId, color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0],
        connected: true, auto: false, bot: false,
      };
      this.players.push(info);
      this.addLog('system', `${name} joined the party.`);
      if (this.run && this.phase !== 'victory' && this.phase !== 'defeat') this.spawnLatecomer(info);
    }
    info.connected = true;
    this.sockets.set(info.id, (this.sockets.get(info.id) ?? 0) + 1);
    this.emptySince = null;
    this.onHumansChanged();
    this.broadcast();
    return { ok: true, playerId: info.id };
  }

  socketLeft(playerId: string) {
    const open = (this.sockets.get(playerId) ?? 1) - 1;
    this.sockets.set(playerId, open);
    if (open > 0) return;
    const info = this.players.find((p) => p.id === playerId);
    if (!info) return;
    if (this.phase === 'lobby' && !this.savedHero(playerId)) {
      this.players = this.players.filter((p) => p !== info);
      this.sockets.delete(playerId);
    } else {
      info.connected = false;
      this.addLog('system', `${info.name} disconnected.`);
      const e = this.hero(playerId);
      if (e) {
        this.cancelWalk(e.id);
        // Give them a moment to come back (a page reload, a wifi blip) before auto-play takes their turn.
        if (this.acting(e)) {
          this.later(this.turnToken, 3000, () => {
            if (!info.connected) this.runHero(e, this.turnToken);
          });
        }
      }
      this.onHumansChanged();
    }
    if (!this.players.some((p) => p.connected && !p.bot)) this.emptySince = Date.now();
    this.broadcast();
  }

  setClass(playerId: string, classId: ClassId) {
    const info = this.players.find((p) => p.id === playerId);
    if (!info || this.phase !== 'lobby' || typeof classId !== 'string' || !Object.hasOwn(CLASSES, classId)) return;
    if (this.savedHero(playerId)) return this.whisper(playerId, 'Your saved hero keeps their class.');
    info.classId = classId;
    this.broadcast();
  }

  /** The host picks Story, Normal or Hard in the tavern. A loaded save keeps its own. */
  setDifficulty(playerId: string, d: unknown) {
    if (this.phase !== 'lobby' || playerId !== this.hostId || !isDifficulty(d) || d === this.difficulty) return;
    if (this.resumeFrom) return this.whisper(playerId, 'A saved run keeps its difficulty.');
    this.difficulty = d;
    const def = DIFFICULTIES[d];
    this.addLog('system', `${def.icon} Difficulty: ${def.name}. ${def.desc}`);
    this.broadcast();
  }

  /** The host picks who plays the monsters: the scripted AI or the trained PPO policy. A loaded save keeps its own. */
  setMonsterAi(playerId: string, ai: unknown) {
    if (this.phase !== 'lobby' || playerId !== this.hostId || !isMonsterAi(ai) || ai === this.monsterAi) return;
    if (this.resumeFrom) return this.whisper(playerId, 'A saved run keeps its monster AI.');
    if (ai === 'ppo' && !monsterPolicy()) return this.whisper(playerId, 'This server has no trained PPO policy yet (server/policies/monster-ppo.json).');
    this.monsterAi = ai;
    const def = MONSTER_AIS[ai];
    this.addLog('system', `${def.icon} Monsters: ${def.name}. ${def.desc}`);
    this.broadcast();
  }

  /** Who plays the monsters in this run (the lobby's pick before a run starts). */
  private get monsterAiNow(): MonsterAi {
    return this.run?.monsterAi ?? this.monsterAi;
  }

  /** The run's difficulty (the lobby's pick before a run starts). */
  private get diff(): Difficulty {
    return this.run?.difficulty ?? this.difficulty;
  }

  /** Every run has at least MIN_PARTY heroes: bots take the empty seats, with the classes the party doesn't have yet. */
  private fillParty() {
    const missing = MIN_PARTY - this.players.length;
    if (missing <= 0 || !this.hostId) return;
    for (let i = 0; i < missing; i++) this.addBot(this.hostId);
    this.addLog('system', `🤖 Every party has at least ${MIN_PARTY} heroes, so ${missing === 1 ? 'a bot takes the empty seat' : `${missing} bots take the empty seats`}.`);
  }

  start(playerId: string) {
    if (this.phase !== 'lobby' || playerId !== this.hostId) return;
    this.fillParty();
    if (this.resumeFrom) return this.resumeRun(this.resumeFrom);
    this.createdAt = Date.now();
    this.log = [];
    this.seenEvents = [];
    this.notice = null;
    this.entities = this.players.map((p) => this.makePlayer(p, 1));
    const seed = randInt(1, 2 ** 31 - 2);
    this.run = { act: 1, maxAct: MAX_ACT, actName: ACTS[0].name, map: generateActMap(1, seed, ROWS), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed, difficulty: this.difficulty, monsterAi: this.monsterAi };
    this.openJournal(false);
    this.addLog('system', '🍺 The party finishes their drinks and leaves the tavern...');
    this.addLog('system', `🗺️ Act 1: ${ACTS[0].name}. Vote on your path. The ${MONSTERS[ACTS[0].boss].name} waits at the top of the map.`);
    this.notice = {
      glyph: ACTS[0].glyph,
      title: `Act 1: ${ACTS[0].name}`,
      text: `Pick your path together. Fights earn XP (the killing blow earns extra), elites (💀) are tough, rests (🔥) heal or train. The ${MONSTERS[ACTS[0].boss].name} waits at the top.`,
    };
    this.toMap();
  }

  restart(playerId: string) {
    if (this.phase !== 'victory' && this.phase !== 'defeat') return;
    if (!this.players.some((p) => p.id === playerId)) return;
    this.dispose();
    this.phase = 'lobby';
    this.players = this.players.filter((p) => p.connected);
    this.run = null;
    this.event = null;
    this.notice = null;
    this.roomKind = null;
    this.entities = [];
    this.clearRoom();
    this.log = [];
    this.addLog('system', '🍺 Back at the tavern. Swap classes if you like, then the host starts a new run.');
    this.broadcast();
  }

  /** Stops everything time-based (the game is closing, or back to the tavern): the room's timers and the pick countdowns. */
  dispose() {
    this.endRoom();
    for (const t of this.pickTimers.values()) clearTimeout(t);
    this.pickTimers.clear();
    this.pickAt.clear();
  }

  /** Leaving a room: stops walks, monster turns, turn timers, the vote and the rest site. Pick countdowns carry on. */
  private endRoom() {
    this.cancelAllWalks();
    this.turnToken++;
    this.turn = null;
    if (this.voteTimer) clearTimeout(this.voteTimer);
    if (this.autoVoteTimer) clearTimeout(this.autoVoteTimer);
    if (this.restTimer) clearTimeout(this.restTimer);
    if (this.shopTimer) clearTimeout(this.shopTimer);
    this.shopTimer = null;
    this.shop = null;
    this.shopDeadline = null;
    this.voteTimer = null;
    this.autoVoteTimer = null;
    this.restTimer = null;
    this.vote = null;
    this.onContinue = null;
    this.restPicks = null;
    this.restDeadline = null;
    this.restAutoAt = null;
    this.approachDc = null;
  }

  private makePlayer(info: PlayerInfo, level: number): PlayerEntity {
    const c = CLASSES[info.classId];
    const p: PlayerEntity = {
      id: this.newId(), kind: 'player', playerId: info.id, classId: info.classId, name: info.name, glyph: c.glyph, color: info.color,
      x: 0, y: 0, level, xp: 0, skills: startingSkills(info.classId), levelUps: 0, elitePicks: 0, offer: null,
      hp: 0, maxHp: 0, ac: c.ac, speed: c.speed, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0,
      potions: 2, gear: {}, bag: [], relics: [...(this.run?.relics ?? [])], blessings: [...(this.run?.blessings ?? [])],
      kills: 0, steals: 0, slots: 0, maxSlots: 0, downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], statuses: [],
      facing: { x: 1, y: 0 },
    };
    recalcHero(p); // fills HP and slots for the level
    return p;
  }

  /** A hero joining a run in progress starts at the party's level, with a pick for every level they missed. */
  private newcomer(info: PlayerInfo, level: number): PlayerEntity {
    const e = this.makePlayer(info, level);
    e.rewardPicks = level - 1;
    e.levelUps = Math.floor(level / 2); // the stat points of the even levels they skipped
    dealOffer(e, rng, this.run?.act ?? 1);
    return e;
  }

  /** A saved hero back in play. Fight-only state is reset and derived stats follow the current rules. */
  private restoreHero(saved: PlayerEntity, info: PlayerInfo): PlayerEntity {
    const base = this.makePlayer(info, saved.level);
    const p: PlayerEntity = {
      ...base,
      ...saved,
      id: base.id, // fresh ids, so they can't clash with this room's monsters
      playerId: info.id,
      name: info.name,
      color: info.color,
      x: 0,
      y: 0,
      facing: { x: 1, y: 0 },
      skills: (saved.skills ?? base.skills).filter((s) => isSkillId(s.id)).map((s) => ({ ...s, cd: 0 })),
      // Items that no longer exist are dropped; relics follow the run's list.
      gear: Object.fromEntries(Object.entries(saved.gear ?? {}).filter(([slot, id]) => isItemId(id) && gearDef(id)?.slot === slot)),
      bag: (saved.bag ?? []).filter(isItemId),
      relics: [...(this.run?.relics ?? [])],
      blessings: [...(this.run?.blessings ?? [])],
      elitePicks: saved.elitePicks ?? 0,
      statuses: [],
      tempHp: 0,
      used: [],
      downed: false,
      dead: false,
      saves: { ok: 0, fail: 0 },
    };
    if (!saved.statUps) {
      p.statUps = {};
      p.levelUps = (saved.levelUps ?? 0) + Math.floor(saved.level / 2); // saved before stat points (2026-10-21)
    }
    // Cards for skills or items that no longer exist are dealt again.
    if (p.offer && !p.offer.every(validCard)) p.offer = null;
    if (p.offer && !p.offerKind) p.offerKind = 'level'; // saved before elite spoils existed
    if (!p.offer) dealOffer(p, rng, this.run?.act ?? 1);
    recalcHero(p);
    return p;
  }

  /** Continues a loaded save: same heroes, same map, the node in progress replayed from its start. */
  private resumeRun(save: SaveFile) {
    this.resumeFrom = null;
    this.openJournal(true);
    const level = Math.max(1, ...save.heroes.map((h) => h.level));
    // The run first, so the heroes come back with its relics and blessings already on their sheets.
    this.run = {
      ...save.run,
      relics: (save.run.relics ?? []).filter(isRelicId),
      blessings: (save.run.blessings ?? []).filter(isBlessingId),
      allies: (save.run.allies ?? []).filter((a) => isAllyId(a?.id) && a.fights > 0),
      difficulty: this.difficulty,
      monsterAi: this.monsterAi,
    };
    this.entities = this.players.map((info) => {
      const saved = save.heroes.find((h) => h.playerId === info.id);
      return saved ? this.restoreHero(saved, info) : this.newcomer(info, level);
    });
    this.syncPerks();
    this.seenEvents = [...save.seenEvents];
    this.notice = save.notice;
    this.addLog('system', '📜 The party picks up right where they left off.');
    if (save.at.kind === 'node' && this.node(save.at.nodeId)) this.enterNode(save.at.nodeId, save.at.eventId);
    else if (save.at.kind === 'reward') this.eliteReward(save.at.text, save.at.choices, save.at.lines);
    else this.toMap();
    this.scheduleAutoPicks();
  }

  private spawnLatecomer(info: PlayerInfo) {
    const level = Math.max(1, ...this.heroes().map((h) => h.level));
    const e = this.newcomer(info, level); // they skipped the earlier level-ups, so they get those picks now
    if (this.phase === 'combat') {
      const spot = this.freeSpotNear(this.heroes().find((p) => !p.dead));
      if (!spot) return; // no room to stand: they'll appear after this fight
      e.x = spot.x;
      e.y = spot.y;
      this.entities.push(e);
      this.joinInitiative(e);
    } else {
      this.entities.push(e);
      this.checkpoint();
    }
    this.scheduleAutoPicks();
  }

  // ------------------------------------------------------------ the act map

  private node(id: string | null): MapNode | undefined {
    return this.run?.map.nodes.find((n) => n.id === id);
  }

  private clearRoom() {
    this.tiles = '';
    this.width = 0;
    this.height = 0;
    this.ground = {};
    this.clouds = {};
    this.props = {};
  }

  /** Back to the map: the party votes on the next node. */
  private toMap() {
    this.endRoom();
    const run = this.run;
    if (!run) return;
    this.phase = 'map';
    this.roomKind = null;
    this.event = null;
    this.entities = this.heroes();
    this.clearRoom();
    const options = run.currentId ? (this.node(run.currentId)?.next ?? []) : run.map.nodes.filter((n) => n.row === 0).map((n) => n.id);
    this.openVote('path', options);
    this.savePoint = { kind: 'map' };
    this.checkpoint();
    this.scheduleUpkeep();
    this.scheduleAutoPicks();
    this.broadcast();
  }

  /**
   * Saves the run at a safe point: on the map, or as the party enters a node (before it changes anything).
   * Never mid-fight: a restart replays the node in progress from its start.
   */
  private checkpoint() {
    this.journal?.flush();
    const run = this.run;
    if (!run || this.resumeFrom || this.phase === 'combat' || this.phase === 'victory' || this.phase === 'defeat') return;
    const save: SaveFile = {
      version: SAVE_VERSION,
      code: this.code,
      createdAt: this.createdAt,
      savedAt: Date.now(),
      players: this.players.map(({ id, name, classId, color, bot }) => ({ id, name, classId, color, bot })),
      heroes: structuredClone(this.heroes()),
      run: structuredClone(run),
      seenEvents: [...this.seenEvents],
      at: { ...this.savePoint },
      notice: this.notice,
      log: this.log.slice(-30),
    };
    try {
      writeSave(save);
      // The RL trainer replays real fights: keep a copy of the save at each fight's start (training/).
      const node = save.at.kind === 'node' ? this.node(save.at.nodeId) : undefined;
      if (node && (node.type === 'combat' || node.type === 'elite' || node.type === 'boss')) dumpFight(save);
    } catch (err) {
      console.error(`[save ${this.code}] could not write the save:`, err);
    }
  }

  private openVote(kind: Vote['kind'], options: string[]) {
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.voteTimer = null;
    this.vote = { kind, options, votes: {}, deadline: null };
    this.scheduleAutoVotes();
  }

  /** When nobody is at the keyboard, the auto heroes vote among themselves. */
  private scheduleAutoVotes() {
    if (!this.vote || this.humans().length) return;
    if (this.autoVoteTimer) clearTimeout(this.autoVoteTimer);
    const vote = this.vote;
    this.autoVoteTimer = setTimeout(() => {
      this.autoVoteTimer = null;
      if (this.vote !== vote || this.humans().length) return;
      if (vote.kind === 'continue' && this.pickAt.size) return; // someone on auto-play is still picking: their last pick moves on
      if (vote.kind === 'path') this.autoUpkeep(); // before the party moves on (its own timer would fire too late)
      const heroes = this.heroes();
      for (const p of this.players) {
        if (this.vote !== vote) return; // the vote resolved along the way
        if (vote.votes[p.id]) continue;
        const choice =
          vote.kind === 'path'
            ? autoPathChoice(vote.options.map((id) => ({ id, type: this.node(id)?.type ?? 'combat' })), heroes, this.run?.gold ?? 0)
            : vote.kind === 'continue'
              ? 'continue'
              : vote.kind === 'approach'
              ? autoApproachChoice(heroes, this.approachDc ?? 99)
              : autoEventChoice(vote.options, heroes);
        this.handleVote(p.id, choice);
      }
      if (this.vote === vote) this.resolveVote();
    }, AUTO_DELAY_MS / SPEED);
  }

  /** Between rooms, auto heroes sort out their gear, drink potions and patch each other up. */
  private scheduleUpkeep() {
    setTimeout(() => this.autoUpkeep(), AUTO_DELAY_MS / SPEED);
  }

  private autoUpkeep() {
    if (this.phase !== 'map') return;
    for (const hero of this.heroes()) {
      if (!this.isAuto(hero.playerId)) continue;
      this.autoManage(hero);
      const gift = autoGive(hero, this.heroes());
      if (gift) this.itemAction(hero, gift);
      const intent = upkeepIntent(hero, this.heroes());
      if (intent?.kind === 'act') this.handleSkill(hero.playerId, intent.skill, intent.target);
    }
  }

  handleVote(playerId: string, option: string) {
    const v = this.vote;
    if (!v || typeof option !== 'string' || !v.options.includes(option)) return;
    if (!this.players.some((p) => p.id === playerId)) return;
    v.votes[playerId] = option;
    // Continue waits for everyone (with a longer clock), so nobody is pulled away from their spoils or the story.
    const wait = v.kind === 'continue' ? CONTINUE_MS : VOTE_MS;
    if (v.deadline === null && (v.options.length > 1 || v.kind === 'continue')) {
      v.deadline = Date.now() + wait;
      this.voteTimer = setTimeout(() => this.resolveVote(), wait);
    }
    if (v.options.length === 1 && v.kind !== 'continue') this.resolveVote();
    else this.maybeResolveVote();
    this.broadcast();
  }

  /** Resolves early once every human has voted. Auto heroes follow the humans' choice and don't vote. */
  private maybeResolveVote() {
    const v = this.vote;
    if (!v) return;
    if (v.kind === 'continue') {
      // An outcome screen waits for everyone at a keyboard; someone on auto-play is ready once their picks are made.
      const people = this.players.filter((p) => p.connected && !p.bot);
      if (people.length && people.every((p) => v.votes[p.id] || (p.auto && !this.pickAt.has(p.id)))) this.resolveVote();
      return;
    }
    const voters = this.humans();
    if (voters.length && voters.every((p) => v.votes[p.id])) this.resolveVote();
  }

  private resolveVote() {
    const v = this.vote;
    if (!v) return;
    if (v.kind === 'continue') {
      if (this.voteTimer) clearTimeout(this.voteTimer);
      this.voteTimer = null;
      this.vote = null;
      this.moveOn();
      this.broadcast();
      return;
    }
    const tally = new Map<string, number>();
    for (const option of Object.values(v.votes)) tally.set(option, (tally.get(option) ?? 0) + 1);
    if (!tally.size) return;
    const best = Math.max(...tally.values());
    const winners = [...tally].filter(([, n]) => n === best).map(([option]) => option);
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.voteTimer = null;
    this.vote = null;
    if (winners.length > 1) this.addLog('system', '🎲 The vote is tied, so the dice decide.');
    const winner = pick(winners);
    if (v.kind === 'path') this.enterNode(winner);
    else if (v.kind === 'approach') this.resolveApproach(winner);
    else this.chooseEventOption(winner);
    this.broadcast();
  }

  /**
   * What happened in a room, on its own screen before the party moves on: a won fight, an event's outcome, a treasure,
   * a rest. Everyone reads it and picks their spoils; the party moves on once every person has clicked Continue (or
   * CONTINUE_MS after the first did). `save`: the run is saved here as the map (the room is done); an event that
   * starts a fight keeps the save from before the event, so a restart replays the event.
   */
  private showOutcome(scene: Pick<EventView, 'glyph' | 'title' | 'text' | 'chosen' | 'lines'>, label: string, next: () => void, save = true) {
    this.event = { id: 'outcome', ...scene, choices: [{ id: 'continue', label, resolve: () => ({ text: '', effects: [] }) }] };
    this.phase = 'event';
    this.onContinue = next;
    if (save) {
      this.savePoint = { kind: 'map' };
      this.checkpoint();
    }
    this.openVote('continue', ['continue']);
    this.broadcast();
  }

  private moveOn() {
    const next = this.onContinue;
    this.onContinue = null;
    (next ?? (() => this.toMap()))();
  }

  /** Runs fn and returns what it logged (not chatter or system lines): an outcome screen's lines. */
  private collect(fn: () => void): string[] {
    const outer = this.told;
    const lines: string[] = [];
    this.told = lines;
    try {
      fn();
    } finally {
      this.told = outer;
    }
    outer?.push(...lines);
    return lines;
  }

  private enterNode(id: string, eventId?: string) {
    const run = this.run;
    const node = this.node(id);
    if (!run || !node) return;
    // Saved before anything changes, so a restart replays this node from its start.
    this.savePoint = { kind: 'node', nodeId: id };
    this.checkpoint();
    run.currentId = id;
    if (run.visited.at(-1) !== id) run.visited.push(id); // a resumed node is already on the list
    this.journal?.write({ k: 'node', act: run.act, row: node.row, type: node.type });
    this.notice = null;
    switch (node.type) {
      case 'combat':
      case 'elite':
      case 'boss': {
        const fight = this.encounterFor(node);
        // Regular fights past the first rows are sometimes ambushes; bosses are expecting you.
        const ambush = node.type === 'combat' && node.row >= 2 && rng.chance(AMBUSH_CHANCE);
        this.startRoom(node.type, fight.monsters, fight.name, node.type === 'boss' ? 'charge' : ambush ? 'ambush' : 'vote', isWarmup(run.act, node), fight.twist);
        break;
      }
      case 'rest':
        this.startRest();
        break;
      case 'treasure':
        this.treasure();
        break;
      case 'event':
        this.startEvent(eventId);
        break;
      case 'shop':
        this.startShop();
        break;
    }
  }

  /** Builds a fight from the act's handwritten templates, filled up to a threat budget. */
  private encounterFor(node: MapNode): { name: string; monsters: string[]; twist?: Twist } {
    const run = this.run!;
    const act = ACTS[run.act - 1];
    const size = this.heroes().length;
    if (node.type === 'boss') {
      return { name: MONSTERS[act.boss].name, monsters: [act.boss, ...Array.from({ length: Math.floor(size * BOSS.minions) }, () => pick(act.minions))] };
    }
    let budget = encounterBudget(run.act, node.row, size) * DIFFICULTIES[this.diff].budget * (isWarmup(run.act, node) ? WARMUP_BUDGET : 1);
    let name: string;
    let draw: string[];
    let twist: Twist | undefined;
    const monsters: string[] = [];
    if (node.type === 'elite') {
      const leader = pick(act.elites);
      monsters.push(leader);
      name = MONSTERS[leader].name;
      draw = act.escorts[leader] ?? act.pool;
      budget *= 0.4;
    } else {
      const template = pick(act.encounters.filter((e) => (e.minRow ?? 0) <= node.row));
      name = template.name;
      draw = template.monsters;
      if (template.deploy || template.terrain) twist = { deploy: template.deploy, terrain: template.terrain };
    }
    while (monsters.length < MAX_ROOM_MONSTERS) {
      const fits = draw.filter((t) => MONSTERS[t].threat <= budget);
      if (!fits.length) break;
      const type = pick(fits);
      monsters.push(type);
      budget -= MONSTERS[type].threat;
    }
    // Always at least one monster: the cheapest one in the template.
    if (!monsters.length) monsters.push([...draw].sort((a, b) => MONSTERS[a].threat - MONSTERS[b].threat)[0]);
    return { name, monsters, twist };
  }

  /** Gold, and the party votes on one of three relics. The gold comes with the choice, so a restart can't pay out twice. */
  private treasure() {
    const run = this.run!;
    const gold = this.goldFound(randInt(25, 40) * run.act);
    const choices = this.rollRelics(3);
    const take = (id: RelicId | null): EventChoiceDef => ({
      id: id ?? 'gold',
      label: id ? `${RELICS[id].icon} ${RELICS[id].name}` : 'Just the gold',
      hint: id ? RELICS[id].desc : undefined,
      resolve: () => ({
        text: id ? `The party pockets ${gold} gold and takes the ${RELICS[id].name}.` : `The party pockets ${gold} gold.`,
        effects: [{ kind: 'gold', amount: gold }, ...(id ? [{ kind: 'relic' as const, id }] : [])],
      }),
    });
    this.startEvent(undefined, {
      id: 'treasure',
      title: 'Treasure',
      glyph: '💰',
      text: `A chest with ${gold} gold in it${choices.length ? ', and something stranger. Choose one relic to take: it helps the whole party for the rest of the run.' : '.'}`,
      choices: choices.length ? choices.map(take) : [take(null)],
    });
  }

  /** Gold the party finds (the Golden Idol adds a quarter). */
  private goldFound(amount: number): number {
    return this.hasRelic('golden_idol') ? Math.round(amount * 1.25) : amount;
  }

  private hasRelic(id: RelicId): boolean {
    return !!this.run?.relics?.includes(id);
  }

  /** A relic for the whole party: every hero's sheet picks it up. */
  private grantRelic(id: RelicId) {
    const run = this.run;
    if (!run || run.relics.includes(id)) return;
    run.relics.push(id);
    this.syncPerks();
    this.addLog('loot', `${RELICS[id].icon} The party gains the ${RELICS[id].name}: ${RELICS[id].desc}`);
  }

  private hasBlessing(id: BlessingId): boolean {
    return !!this.run?.blessings?.includes(id);
  }

  /** A blessing for the whole party until the end of the act. */
  private grantBlessing(id: BlessingId) {
    const run = this.run;
    if (!run || run.blessings.includes(id)) return;
    run.blessings.push(id);
    this.syncPerks();
    this.addLog('loot', `${BLESSINGS[id].icon} The party receives the ${BLESSINGS[id].name} until the end of the act: ${BLESSINGS[id].desc}`);
  }

  /** Every hero's sheet follows the party's relics and blessings. */
  private syncPerks() {
    const run = this.run;
    if (!run) return;
    for (const h of this.heroes()) {
      h.relics = [...run.relics];
      h.blessings = [...run.blessings];
      recalcHero(h);
    }
  }

  /** An NPC ally joins the party for the next few fights. With two along already, the one closest to leaving goes. */
  private addAlly(id: AllyId) {
    const run = this.run;
    if (!run) return;
    const def = ALLIES[id];
    const kind = MONSTERS[def.monster].name;
    if (run.allies.length >= MAX_ALLIES) {
      const gone = [...run.allies].sort((a, b) => a.fights - b.fights)[0];
      run.allies = run.allies.filter((a) => a !== gone);
      this.addLog('info', `👋 ${gone.name} parts ways with the party to make room.`);
    }
    const taken = new Set(run.allies.map((a) => a.name));
    const names = def.names.map((n) => `${n} the ${kind}`).filter((n) => !taken.has(n));
    const name = names.length ? pick(names) : `${kind} ${run.allies.length + 1}`;
    run.allies.push({ id, name, fights: ALLY_FIGHTS });
    this.addLog('loot', `🤝 ${name} joins the party for the next ${ALLY_FIGHTS} fights. ${def.desc}`);
  }

  /**
   * Puts an item in a hero's bag: theirs if there's room, else whoever has the most room; if every bag is full it's sold
   * on the spot. Returns who got it (or null if it became gold). Auto heroes put on gear that beats theirs.
   */
  private giveItem(to: PlayerEntity | undefined, id: ItemId): PlayerEntity | null {
    const room = this.heroes().filter((h) => bagRoom(h) > 0).sort((a, b) => bagRoom(b) - bagRoom(a));
    const p = to && bagRoom(to) > 0 ? to : room[0];
    if (!p) {
      this.run!.gold += sellPrice(id);
      this.addLog('loot', `Every bag is full: the ${itemInfo(id).name} is sold for ${sellPrice(id)} gold.`);
      return null;
    }
    p.bag.push(id);
    if (this.isAuto(p.playerId)) this.autoManage(p);
    return p;
  }

  /** Auto heroes put on the best gear in their bag. */
  private autoManage(p: PlayerEntity) {
    for (let i = 0; i < 3; i++) {
      const req = autoEquip(p);
      if (!req || this.itemAction(p, req)) break;
    }
  }

  /** A random item of this rarity, or the nearest rarity there is (gear or consumable). */
  private randomItem(kind: 'gear' | 'consumable', rarity: Rarity): ItemId {
    return pick(rarityPool(kind === 'gear' ? GEAR_IDS : CONSUMABLE_IDS, (id) => ITEMS[id].rarity, rarity));
  }

  /** Up to `n` different relics the party doesn't have yet, each rolled on RELIC_ODDS (boss relics only from bosses). */
  private rollRelics(n: number): RelicId[] {
    const run = this.run!;
    const out: RelicId[] = [];
    for (let i = 0; out.length < n && i < 4 * n; i++) {
      const left = RELIC_IDS.filter((id) => RELICS[id].rarity !== 'boss' && !run.relics.includes(id) && !out.includes(id));
      if (!left.length) break;
      out.push(pick(rarityPool(left, (id) => RELICS[id].rarity as Rarity, pickRarity(rng.next(), RELIC_ODDS))));
    }
    return out;
  }

  /** Hands out potions one at a time to whoever has the fewest. Returns who got them. */
  private giveSharedPotions(amount: number): string[] {
    const got: string[] = [];
    for (let i = 0; i < amount; i++) {
      const p = this.heroes().sort((a, b) => a.potions - b.potions)[0];
      if (!p) break;
      p.potions++;
      got.push(p.name);
    }
    return got;
  }

  /** The act boss is down: the next act's map, after the victory screen (the last act's boss wins the run). */
  private finishAct(text = 'The act boss falls.', lines: string[] = []) {
    const run = this.run!;
    if (run.act >= MAX_ACT) return this.endRun(true);
    run.act++;
    const def = ACTS[run.act - 1];
    run.actName = def.name;
    run.map = generateActMap(run.act, run.seed, ROWS);
    run.currentId = null;
    run.visited = [];
    const faded = run.blessings.length > 0;
    lines.push(
      ...this.collect(() => {
        // The act boss leaves a relic behind, and the act's blessings fade.
        const boss = shuffle(RELIC_IDS.filter((id) => RELICS[id].rarity === 'boss' && !run.relics.includes(id)))[0];
        if (boss) this.grantRelic(boss);
        run.blessings = [];
        this.syncPerks();
        for (const p of this.heroes()) {
          this.healInjuries(p, 'on the way up');
          p.hp = p.maxHp;
          p.slots = p.maxSlots;
        }
      }),
    );
    lines.push('❤️ Everyone is fully healed and every slot is restored.');
    if (faded) lines.push("✨ This act's blessings fade.");
    lines.push('🏆 Every hero picks their spoils before the climb.');
    this.addLog('system', `🏆 Act ${run.act - 1} complete! The party recovers fully (HP and every slot) and presses on to Act ${run.act}: ${def.name}.`);
    this.notice = { glyph: def.glyph, title: `Act ${run.act}: ${def.name}`, text: `The ${MONSTERS[def.boss].name} waits at the top of the map.` };
    this.showOutcome({ glyph: '👑', title: `Act ${run.act - 1} complete!`, text, lines }, `🗺️ On to Act ${run.act}: ${def.name}`, () => this.toMap());
  }

  // ------------------------------------------------------------ rest sites

  /** Every hero picks Long Rest or Train at the same time; undecided heroes take a Long Rest when the timer runs out. */
  private startRest() {
    this.phase = 'rest';
    this.restPicks = {};
    this.restDeadline = null;
    this.restAutoAt = Date.now() + PICK_WAIT_MS / SPEED;
    this.addLog('system', '🔥 A rest site. Each hero chooses: Long Rest (heal and restore slots) or Train (upgrade a cantrip or spell).');
    this.scheduleAutoRest();
    this.broadcast();
  }

  handleRest(playerId: string, raw: RestPick) {
    const picks = this.restPicks;
    const p = this.hero(playerId);
    if (this.phase !== 'rest' || !picks || !p) return;
    const choice: RestPick =
      raw?.kind === 'train'
        ? { kind: 'train', skill: raw.skill, ...(raw.branch === 'A' || raw.branch === 'B' ? { branch: raw.branch } : {}) }
        : { kind: 'long' };
    if (raw?.kind !== 'train' && raw?.kind !== 'long') return;
    const err = validRestPick(p, choice);
    if (err) return this.whisper(playerId, err);
    picks[playerId] = choice;
    // The countdown starts when a person picks, so bots deciding instantly don't rush anyone.
    if (this.restDeadline === null && !this.isAuto(playerId)) {
      this.restDeadline = Date.now() + REST_MS;
      this.restTimer = setTimeout(() => this.resolveRest(), REST_MS);
    }
    if (this.heroes().every((h) => picks[h.playerId])) this.resolveRest();
    this.broadcast();
  }

  /** Bots (and players who dropped out) choose right away; people on auto-play get PICK_WAIT_MS to choose themselves. */
  private scheduleAutoRest() {
    setTimeout(() => this.autoRest(false), AUTO_DELAY_MS / SPEED);
    if (this.restAutoAt === null) return;
    const timer = setTimeout(() => this.autoRest(true), Math.max(0, this.restAutoAt - Date.now()));
    timer.unref?.();
  }

  private autoRest(watched: boolean) {
    const picks = this.restPicks;
    if (this.phase !== 'rest' || !picks) return;
    for (const h of this.heroes()) {
      const id = h.playerId;
      if (this.isAuto(id) && !picks[id] && (watched || !this.watching(id))) this.handleRest(id, autoRestPick(h, this.heroes()));
    }
  }

  private resolveRest() {
    const picks = this.restPicks;
    if (this.phase !== 'rest' || !picks) return;
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    this.restPicks = null;
    this.restDeadline = null;
    this.restAutoAt = null;
    const lines = this.collect(() => {
      for (const p of this.heroes()) this.healInjuries(p, 'by the fire');
      for (const p of this.heroes()) {
        const choice = picks[p.playerId] ?? { kind: 'long' };
        if (choice.kind === 'train') {
          const tier = nextTier(p, choice.skill);
          const res = tier ? upgrade(p, choice.skill, tier, choice.branch) : null;
          if (res?.ok) {
            this.addLog('level', `🏋️ ${p.name} trains by the fire and ${res.text}.`);
            continue;
          }
        }
        p.hp = Math.min(p.maxHp, p.hp + Math.ceil(p.maxHp * REST_HEAL));
        p.slots = p.maxSlots;
        this.addLog('heal', `🔥 ${p.name} takes a Long Rest: +${Math.round(REST_HEAL * 100)}% HP and every slot restored.`);
      }
    });
    this.showOutcome({ glyph: '🔥', title: 'Rest site', text: 'The fire burns low. The party packs up, a little stronger than before.', lines }, '🗺️ Back to the map', () => this.toMap());
  }

  /** 🩹 An Injury (an event's price): less max HP until the next rest site or act, like dying in a fight. */
  private injure(p: PlayerEntity) {
    p.injuries = Math.min(MAX_INJURIES, (p.injuries ?? 0) + 1);
    const hp = p.hp;
    recalcHero(p);
    p.hp = Math.max(1, Math.min(hp, p.maxHp));
    this.addLog('death', `🩹 ${p.name} is injured: -${Math.round(INJURY_PCT * 100 * p.injuries)}% max HP until the next rest site.`);
  }

  /** 🩹 Rest sites and new acts heal Injuries: the max HP comes back (and the HP with it). */
  private healInjuries(p: PlayerEntity, where: string) {
    if (!p.injuries) return;
    p.injuries = 0;
    recalcHero(p);
    this.addLog('heal', `🩹 ${p.name}'s injuries heal ${where}.`);
  }

  // ------------------------------------------------------------ XP & level-ups

  /** Gives XP, with a catch-up bonus for heroes behind the party's highest level. */
  private grantXp(p: PlayerEntity, amount: number) {
    if (amount <= 0 || p.level >= LEVEL_CAP) return;
    const top = Math.max(...this.heroes().map((h) => h.level));
    p.xp += Math.round(amount * (1 + XP_CATCH_UP * (top - p.level)));
  }

  /** Turns banked XP into levels (between fights) and deals the level-up cards. */
  private checkLevelUps(): string[] {
    const names: string[] = [];
    for (const p of this.heroes()) {
      const gained = applyLevelUps(p);
      if (!gained) continue;
      names.push(p.name);
      if (!p.offer) dealOffer(p, rng, this.run?.act ?? 1);
      this.addLog('level', `⬆️ ${p.name} reaches level ${p.level}!${p.level % 2 === 0 ? ' A stat point to spend.' : ''}`);
      this.callout(p, 'level', {}, 'after');
    }
    this.scheduleAutoPicks();
    return names;
  }

  /** Auto heroes take their level-up picks on their own. */
  private scheduleAutoPicks() {
    // People on auto-play build their own hero if they like: each pick waits PICK_WAIT_MS for them (their panel counts down).
    for (const p of this.heroes()) {
      const id = p.playerId;
      if (!this.watching(id) || !p.offer || picksLeft(p) <= 0) {
        this.clearPickTimer(id);
        continue;
      }
      if (!this.pickAt.has(id)) this.pickAt.set(id, Date.now() + PICK_WAIT_MS / SPEED);
      if (this.pickTimers.has(id)) continue;
      const timer = setTimeout(() => {
        this.pickTimers.delete(id);
        this.pickAt.delete(id);
        const h = this.hero(id);
        if (!h || !this.run) return;
        this.autoPick(h, 1);
        this.afterPick();
      }, Math.max(0, this.pickAt.get(id)! - Date.now()));
      timer.unref?.();
      this.pickTimers.set(id, timer);
    }
    // Bots and players who dropped out pick right away.
    if (!this.heroes().some((p) => p.offer && this.isAuto(p.playerId) && !this.watching(p.playerId))) return;
    setTimeout(() => {
      for (const p of this.heroes()) if (!this.watching(p.playerId)) this.autoPick(p, 16);
      this.checkpoint();
      this.broadcast();
    }, AUTO_DELAY_MS / SPEED);
  }

  /** Auto-play makes up to `n` of a hero's picks. */
  private autoPick(p: PlayerEntity, n: number) {
    for (let i = 0; i < n && p.offer && picksLeft(p) > 0 && this.isAuto(p.playerId); i++) {
      const icon = PICK_ICON[p.offerKind ?? 'level'];
      const [offered, kind, req] = [p.offer, p.offerKind ?? 'level', autoLevelPick(p)];
      const res = applyPick(p, req, rng, this.run?.act ?? 1);
      if (!res.ok) {
        console.warn(`[auto pick ${p.name}] rejected: ${res.error}`);
        break;
      }
      this.journalPick(p, offered, kind, req, res.text, true);
      this.addLog('level', `${icon} ${p.name} ${res.text}.`);
      this.autoManage(p); // gear from elite spoils
    }
  }

  private clearPickTimer(playerId: string) {
    const t = this.pickTimers.get(playerId);
    if (t) clearTimeout(t);
    this.pickTimers.delete(playerId);
    this.pickAt.delete(playerId);
  }

  /** A pick was made: the next one gets its own countdown, and an outcome screen may have been waiting for it. */
  private afterPick() {
    this.scheduleAutoPicks();
    this.maybeResolveVote();
    this.checkpoint();
    this.broadcast();
  }

  handlePick(playerId: string, req: PickRequest) {
    const p = this.hero(playerId);
    if (!p?.offer || this.phase === 'lobby' || this.phase === 'victory' || this.phase === 'defeat') return;
    const icon = PICK_ICON[p.offerKind ?? 'level'];
    const [offered, kind] = [p.offer, p.offerKind ?? 'level'];
    const pick = { card: Number(req?.card), branch: req?.branch, forget: req?.forget };
    const res = applyPick(p, pick, rng, this.run?.act ?? 1);
    if (!res.ok) return this.whisper(playerId, res.error);
    this.journalPick(p, offered, kind, pick, res.text, this.isAuto(playerId) && !this.watching(playerId));
    this.addLog('level', `${icon} ${p.name} ${res.text}.`);
    this.clearPickTimer(playerId);
    this.afterPick();
  }

  // ------------------------------------------------------------ events

  /** Opens an event: a fresh one, or the same one again when a save is resumed mid-event. */
  private startEvent(eventId?: string, scene?: EventDef & Pick<EventView, 'lines'>) {
    const run = this.run!;
    const def = scene ?? ((eventId && getEvent(eventId, run.act)) || pickEvent(run.act, this.seenEvents, rng));
    if (!scene && !this.seenEvents.includes(def.id)) this.seenEvents.push(def.id);
    if (this.savePoint.kind === 'node') this.savePoint.eventId = def.id;
    this.event = def;
    this.phase = 'event';
    this.checkpoint(); // now with the event's id, so a restart reopens the same scene
    const options = def.choices.filter((c) => !c.cost || c.cost <= run.gold).map((c) => c.id);
    this.openVote('event', options);
    this.addLog('system', `${def.glyph} ${def.title}`);
    this.broadcast();
  }

  private chooseEventOption(choiceId: string) {
    const run = this.run!;
    const def = this.event;
    const choice = def?.choices.find((c) => c.id === choiceId);
    if (!def || !choice) return this.toMap();
    this.lastChecker = null;
    const outcome = choice.resolve({
      act: run.act,
      gold: run.gold,
      partySize: this.heroes().length,
      rng,
      check: (stat, dc) => this.eventCheck(stat, dc),
    });
    this.addLog('info', `${def.glyph} ${choice.label}: ${outcome.text}`);
    let fight: Extract<EventEffect, { kind: 'fight' }> | null = null;
    const lines = this.collect(() => {
      for (const effect of outcome.effects) {
        if (effect.kind === 'fight') fight = effect;
        else this.applyEffect(effect);
      }
    });
    // The outcome on its own screen; a fight starts when the party is ready.
    const scene = { glyph: def.glyph, title: def.title, text: outcome.text, chosen: choice.label, lines };
    const f = fight as Extract<EventEffect, { kind: 'fight' }> | null;
    if (f) {
      const monsters = f.monsters.filter((m) => Object.hasOwn(MONSTERS, m));
      this.showOutcome(scene, f.ambush ? '⚔️ Ambush! Fight!' : '⚔️ Fight!', () => this.startRoom(f.elite ? 'elite' : 'combat', monsters, def.title, f.ambush ? 'ambush' : 'charge'), false);
    } else this.showOutcome(scene, '🗺️ Back to the map', () => this.toMap());
  }

  /** Who would roll an event check: the standing hero with the best modifier for that stat. */
  private checkRoller(stat: EventStat): PlayerEntity | undefined {
    return this.heroes()
      .filter((p) => !p.dead)
      .sort((a, b) => statMod(b, stat) - statMod(a, stat))[0];
  }

  /** "WIS check, DC 13" gets who would roll it and the chance: "WIS check, DC 13: bunted rolls (+1), 45%". */
  private checkOdds(hint: string | undefined): string | undefined {
    const m = hint && /\b(STR|DEX|CON|INT|WIS|CHA) check, DC (\d+)/.exec(hint);
    if (!hint || !m) return hint;
    const stat = m[1].toLowerCase() as EventStat;
    const hero = this.checkRoller(stat);
    if (!hero) return hint;
    const mod = statMod(hero, stat);
    const chance = Math.max(0, Math.min(20, 21 - Number(m[2]) + mod)) * 5; // a d20 + mod against the DC
    return hint.replace(m[0], `${m[0]}: ${hero.name} rolls (${fmtMod(mod)}), ${chance}%`);
  }

  /** d20 + the best modifier in the party for that stat. */
  private eventCheck(stat: EventStat, dc: number): CheckResult {
    const hero = this.checkRoller(stat);
    const mod = hero ? statMod(hero, stat) : 0;
    const roll = rollDie(20);
    const ok = roll + mod >= dc;
    this.lastChecker = hero?.id ?? null;
    return {
      ok,
      heroId: hero?.id ?? '',
      heroName: hero?.name ?? 'Someone',
      text: `🎲 ${hero?.name ?? 'Someone'} (${stat.toUpperCase()} ${fmtMod(mod)}): ${roll}${fmtMod(mod)}=${roll + mod} vs DC ${dc}, ${ok ? 'success' : 'failure'}`,
    };
  }

  private applyEffect(effect: Exclude<EventEffect, { kind: 'fight' }>) {
    const run = this.run!;
    const heroes = this.heroes();
    switch (effect.kind) {
      case 'heal':
        for (const p of heroes) p.hp = Math.min(p.maxHp, p.hp + Math.ceil(p.maxHp * effect.pct));
        this.addLog('heal', `❤️ Everyone heals ${Math.round(effect.pct * 100)}% of their max HP.`);
        break;
      case 'damage': {
        const targets = effect.who === 'checker' ? heroes.filter((p) => p.id === this.lastChecker) : heroes;
        for (const p of targets) {
          const dmg = rollDice(effect.dice);
          p.hp = Math.max(1, p.hp - dmg); // events can hurt, but never kill
          this.addLog('hit', `${p.name} takes ${dmg} damage.`);
        }
        break;
      }
      case 'gold': {
        const before = run.gold;
        run.gold = Math.max(0, run.gold + effect.amount);
        const d = run.gold - before;
        if (d) this.addLog('loot', `💰 ${d > 0 ? `+${d}` : `−${-d}`} gold (the party has ${run.gold}).`);
        break;
      }
      case 'potions': {
        const got = this.giveSharedPotions(effect.amount);
        if (got.length) this.addLog('loot', `🧪 ${got.length === 1 ? 'A healing potion' : `${got.length} healing potions`}: ${[...new Set(got)].join(', ')}.`);
        break;
      }
      case 'relic': {
        const id = effect.id ?? this.rollRelics(1)[0]; // random if the event doesn't say
        if (id && isRelicId(id)) this.grantRelic(id);
        break;
      }
      case 'spoils':
        // A spoils pick, as after a won fight: two skill cards and an item card.
        for (const p of effect.who === 'checker' ? heroes.filter((h) => h.id === this.lastChecker) : heroes) {
          p.rewardPicks = (p.rewardPicks ?? 0) + 1;
          if (!p.offer) dealOffer(p, rng, run.act);
          this.addLog('level', `🏆 ${p.name} gets a spoils pick.`);
        }
        this.scheduleAutoPicks();
        break;
      case 'injury':
        for (const p of effect.who === 'checker' ? heroes.filter((h) => h.id === this.lastChecker) : heroes) this.injure(p);
        break;
      case 'xp':
        for (const p of heroes) this.grantXp(p, effect.amount);
        this.addLog('level', `📖 Everyone gains ${effect.amount} XP.`);
        this.checkLevelUps();
        break;
      case 'item': {
        const id = effect.id && isItemId(effect.id) ? effect.id : this.randomItem(effect.gear ? 'gear' : 'consumable', effect.rarity ?? 'common');
        const got = this.giveItem(this.heroes().find((h) => h.id === this.lastChecker), id);
        if (got) this.addLog('loot', `${itemInfo(id).icon} ${got.name} takes the ${itemInfo(id).name}.`);
        break;
      }
      case 'maxHp':
        for (const p of heroes) {
          p.bonusHp += effect.amount;
          recalcHero(p);
          p.hp = Math.max(1, p.hp);
        }
        this.addLog(effect.amount > 0 ? 'heal' : 'hit', `${effect.amount > 0 ? '💪' : '🩸'} Everyone ${effect.amount > 0 ? 'gains' : 'loses'} ${Math.abs(effect.amount)} max HP for the rest of the run.`);
        break;
      case 'restoreSlots':
        for (const p of heroes) p.slots = p.maxSlots;
        this.addLog('heal', '🔮 Every spell slot is restored.');
        break;
      case 'blessing': {
        const open = BLESSING_IDS.filter((b) => !run.blessings.includes(b));
        const id = effect.id && isBlessingId(effect.id) ? effect.id : open.length ? pick(open) : null;
        if (id) this.grantBlessing(id);
        break;
      }
      case 'ally':
        this.addAlly(effect.id && isAllyId(effect.id) ? effect.id : pick(ALLY_IDS));
        break;
    }
  }

  // ------------------------------------------------------------ rooms

  /**
   * Builds the room and starts the fight. 'vote': the party first votes Sneak or Charge;
   * 'ambush': the heroes start surprised; 'charge': a straight fight.
   */
  private startRoom(kind: NodeType, monsters: string[], name: string, start: 'vote' | 'ambush' | 'charge' = 'charge', warmup = false, twist?: Twist) {
    this.endRoom();
    const deployment = pickDeployment(kind, start, rng, warmup, twist?.deploy);
    const layout = generateRoom(kind, rng, this.run?.act ?? 1, deployment, twist?.terrain);
    this.width = layout.width;
    this.height = layout.height;
    this.tiles = layout.tiles;
    this.ground = layout.ground;
    this.props = layout.props;
    this.clouds = {};
    this.roomKind = kind;
    this.event = null;
    const heroes = this.heroes();
    heroes.forEach((h, i) => {
      const t = layout.partySpawns[i % layout.partySpawns.length];
      h.x = t.x;
      h.y = t.y;
    });
    this.entities = [...heroes]; // a copy: the monsters spawned below must not join the party list
    const spots = [...layout.enemySpawns];
    for (const type of monsters) {
      const spot = spots.shift();
      if (!spot) break;
      this.spawnMonster(type, spot, heroes.length);
    }
    const names = this.monsters().map((m) => m.name);
    const counted = [...new Set(names)].map((n) => `${n}${names.filter((x) => x === n).length > 1 ? ` ×${names.filter((x) => x === n).length}` : ''}`);
    const icon = kind === 'boss' ? '👑' : kind === 'elite' ? '💀' : '⚔️';
    this.addLog('system', `${icon} ${name}: ${counted.join(', ')}!`);
    if (DEPLOYMENT_LINE[deployment]) this.addLog('info', DEPLOYMENT_LINE[deployment]!);
    this.fightMeta = { kind, name, deployment };
    for (const m of this.monsters()) {
      if (m.traits?.length) this.addLog('info', `${m.traits.map((t) => TRAITS[t].icon).join('')} ${m.name}: ${m.traits.map((t) => `${TRAITS[t].name} (${TRAITS[t].desc})`).join(' ')}`);
    }
    // NPC allies take the free spots next to the heroes.
    const free = layout.partySpawns.slice(heroes.length);
    for (const a of this.run?.allies ?? []) {
      const spot = free.find((p) => !this.occupied(p.x, p.y)) ?? this.freeSpotNear(heroes[0]);
      if (spot) this.spawnAlly(a, spot);
    }
    if (this.allies().length) this.addLog('info', `🤝 Fighting alongside you: ${this.allies().map((a) => a.name).join(', ')}.`);
    // Everyone starts out looking at the nearest enemy.
    const nearest = (e: Entity, of: Entity[]) => of.reduce((b, x) => (dist(e, x) < dist(e, b) ? x : b), of[0]);
    const party = [...heroes, ...this.allies()];
    for (const h of party) if (this.monsters().length) this.face(h, nearest(h, this.monsters()));
    for (const m of this.monsters()) this.face(m, nearest(m, party));
    this.phase = 'combat';
    if (start === 'vote') {
      this.approachDc = stealthDc(this.monsters().map((m) => m.type));
      this.addLog('system', `🤫 Sneak up on them (group Stealth vs DC ${this.approachDc}) or charge in?`);
      this.openVote('approach', ['sneak', 'charge']);
    } else {
      if (start === 'ambush') {
        this.addLog('crit', '⚠️ Ambush! They were waiting for you.');
        for (const h of [...heroes, ...this.allies()]) this.applyStatus(h, { id: 'surprised', turns: 1 });
      } else if (kind === 'boss') {
        this.addLog('info', `The ${name} has been expecting you.`);
      }
      this.startCombat();
    }
    this.broadcast();
  }

  /** The Sneak-or-Charge vote is in: roll the group Stealth check if sneaking, then start the fight. */
  private resolveApproach(choice: string) {
    const dc = this.approachDc;
    this.approachDc = null;
    if (this.phase !== 'combat' || this.turn || dc === null) return;
    if (choice === 'sneak') {
      const heroes = this.heroes().filter((h) => this.standing(h));
      let passed = 0;
      const rolls = heroes.map((h) => {
        const d20 = rollDie(20);
        const bonus = stealthBonus(h);
        const ok = d20 + bonus >= dc;
        if (ok) passed++;
        return `${h.name} 🎲${d20}${fmtMod(bonus)}=${d20 + bonus} ${ok ? '✓' : '✗'}`;
      });
      const success = passed * 2 >= heroes.length;
      this.addLog(success ? 'crit' : 'miss', `🤫 Sneaking in (DC ${dc}): ${rolls.join(' · ')}. ${success ? 'They never saw you coming!' : "You've been spotted!"}`);
      const caught = success ? this.monsters() : [...heroes, ...this.allies()];
      for (const e of caught) this.applyStatus(e, { id: 'surprised', turns: 1 });
    } else {
      this.addLog('info', '⚔️ The party charges in!');
    }
    this.startCombat();
    this.broadcast();
  }

  /** Enemies next to a creature that just stepped there turn to face it (shared/tactics.ts: turnsToFace). */
  private watch(mover: Entity) {
    for (const e of this.entities) if (turnsToFace(e, mover, mover)) this.face(e, mover);
  }

  /** Turns a creature toward a spot (8-way). Facing never becomes 0,0. */
  private face(e: Entity, to: Pos) {
    const d = dirTo(e, { x: Math.round(to.x), y: Math.round(to.y) });
    if (d.x || d.y) e.facing = d;
  }

  private spawnMonster(base: string, pos: Pos, partySize: number): MonsterEntity {
    const type = this.diff === 'hard' ? hardId(base) : base; // on Hard, with one more move (HARD_MOVES)
    const def = MONSTERS[type];
    const boss = ACTS.some((a) => a.boss === type);
    const elite = !boss && (ACTS.some((a) => a.elites.includes(type)) || type === 'mimic');
    // Bigger parties: regular monsters get more HP (elites and bosses have their own curve), everyone hits harder.
    // Later acts: everyone gets tougher (actScaling).
    const d = DIFFICULTIES[this.diff];
    const party = partyScaling(partySize);
    const act = actScaling(this.run?.act ?? 1);
    const hp = Math.max(1, Math.round((boss || elite ? scaledHp(def.hp, partySize, boss) * act.solo : def.hp * party.hp * act.hp) * d.hp));
    const dmg = Math.round(avgDice(def.dmg) * (party.dmg * act.dmg * d.dmg * (boss ? BOSS.dmg : elite ? ELITE.dmg : 1) - 1));
    const atk = d.atk + act.atk;
    const m: MonsterEntity = {
      id: this.newId(), kind: 'monster', type, name: def.name, glyph: def.glyph, x: pos.x, y: pos.y,
      hp, maxHp: hp, ac: def.ac + act.ac, speed: def.speed, boss, elite, statuses: [], dmgBy: {}, facing: { x: -1, y: 0 },
      ...(atk ? { atkBonus: atk } : {}), ...(dmg ? { dmgBonus: dmg } : {}),
    };
    this.entities.push(m);
    if (elite) this.giveTraits(m);
    return m;
  }

  /** Elite traits (shared/elites.ts): one in act 1, one or two in act 2, two in act 3, never two auras. */
  private giveTraits(m: MonsterEntity) {
    const n = traitCount(this.run?.act ?? 1, rng.next());
    const traits: TraitId[] = [];
    for (const t of shuffle([...TRAIT_IDS])) {
      if (traits.length >= n) break;
      if (TRAITS[t].aura && traits.some((x) => TRAITS[x].aura)) continue;
      traits.push(t);
    }
    if (!traits.length) return;
    m.traits = traits;
    m.name = `${TRAITS[traits[0]].name} ${m.name}`;
    if (traits.includes('swift')) {
      m.speed += 3;
      m.ac += 1;
    }
    if (traits.includes('shielded')) m.ward = Math.round(m.maxHp * WARD_SHARE);
  }

  /** An NPC ally at full HP, grown to the act. */
  private spawnAlly(a: AllyState, pos: Pos): MonsterEntity {
    const type = ALLIES[a.id].monster;
    const def = MONSTERS[type];
    const k = allyScaling(this.run?.act ?? 1);
    const hp = Math.round(def.hp * k.hp);
    const e: MonsterEntity = {
      id: this.newId(), kind: 'monster', type, name: a.name, glyph: def.glyph, x: pos.x, y: pos.y,
      hp, maxHp: hp, ac: def.ac, speed: def.speed, boss: false, elite: false, statuses: [], dmgBy: {}, facing: { x: 1, y: 0 },
      ally: true, atkBonus: k.atk, dmgBonus: k.dmg,
    };
    this.entities.push(e);
    return e;
  }

  /** The nearest free floor tile to a spot (latecomers, NPC allies, summoned minions). */
  private freeSpotNear(from: Pos | undefined): Pos | null {
    if (!from) return null;
    const path = findPath(this, from, () => false, (x, y) => !this.occupied(x, y));
    return path?.[path.length - 1] ?? null;
  }

  // ------------------------------------------------------------ movement

  handleMove(playerId: string, target: Pos) {
    const p = this.hero(playerId);
    const a = p && this.acts(p);
    if (!p || !a || !this.canMove(p) || !Number.isInteger(target?.x) || !Number.isInteger(target?.y)) return;
    if (!this.canWalk(a)) return this.whisper(playerId, 'No movement left. Use an action or end your turn.');
    // Inside the move area; around fire, poison and the like when that still gets there (the client warns before walking through).
    const plan = planFreeWalk(this, p, target, a, (x, y) => this.occupied(x, y, p.id), p);
    if (!plan?.path.length) return;
    this.startWalk(p, plan.path, plan.hazards);
  }

  handleStep(playerId: string, dx: number, dy: number) {
    const p = this.hero(playerId);
    if (!p || !this.canMove(p) || ![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || (dx === 0 && dy === 0)) return;
    this.cancelWalk(p.id);
    const a = this.acts(p);
    if (!a || !this.canWalk(a)) return this.whisper(playerId, 'No movement left. Use an action or end your turn.');
    this.tryMove(p, { x: p.x + dx, y: p.y + dy });
  }

  /** Any movement this stretch (free movement until you act: a hero with 0 moves left may still walk back). */
  private canWalk(a: TurnActs): boolean {
    return (a.budget ?? a.moves) > 0;
  }

  /** Where a stretch of free movement begins: the first step after the turn starts or after the hero acts. */
  private beginStretch(p: PlayerEntity, a: TurnActs) {
    if (a.from) return;
    a.from = { x: p.x, y: p.y };
    a.budget = a.moves;
  }

  /** Acting (or anything else that fixes where it stands) ends the stretch: moves count from here again. */
  private endStretch(e: Entity) {
    const a = this.acts(e);
    if (!a) return;
    delete a.from;
    delete a.budget;
  }

  private canMove(p: PlayerEntity): boolean {
    return this.standing(p) && this.phase === 'combat' && this.acting(p) && !hasStatus(p, 'stunned') && !hasStatus(p, 'frozen');
  }

  private startWalk(p: PlayerEntity, path: Pos[], hazards: Pos[] = []) {
    this.cancelWalk(p.id);
    const walk: Walk = { path: [...path], hazards, timer: null };
    this.walks.set(p.id, walk);
    const step = () => {
      walk.timer = null;
      if (this.walks.get(p.id) !== walk) return;
      const next = walk.path.shift();
      if (next && this.turnedDangerous(p, next, walk.hazards)) {
        this.walks.delete(p.id);
        return this.whisper(p.playerId, '⚠️ The way ahead just turned dangerous, so you stopped. Click again to go on.');
      }
      const moved = next ? this.tryMove(p, next) : false;
      if (!moved || !walk.path.length || this.walks.get(p.id) !== walk) {
        if (this.walks.get(p.id) === walk) this.walks.delete(p.id);
        return;
      }
      walk.timer = setTimeout(step, STEP_MS);
    };
    step();
  }

  /**
   * A tile on a walk that turned dangerous after the walk was planned: a friend in the same turn set it on fire, iced it or
   * electrified it. Walks stop there instead of marching on into it.
   */
  private turnedDangerous(p: PlayerEntity, next: Pos, known: Pos[]): boolean {
    return hazardAt(this, next.y * this.width + next.x, p) > 0 && !known.some((h) => h.x === next.x && h.y === next.y);
  }

  private cancelWalk(entityId: string) {
    const w = this.walks.get(entityId);
    if (w?.timer) clearTimeout(w.timer);
    this.walks.delete(entityId);
  }

  private cancelAllWalks() {
    for (const id of [...this.walks.keys()]) this.cancelWalk(id);
  }

  /**
   * Moves one tile on your turn. Returns false if it couldn't. Free movement until you act: the tile has to be inside this
   * stretch's move area, and the moves left are counted from where the stretch began, so stepping back gives them back.
   */
  private tryMove(p: PlayerEntity, next: Pos): boolean {
    const a = this.acts(p);
    if (!this.canMove(p) || !a || !this.canWalk(a) || ROOTED.some((id) => hasStatus(p, id))) return false;
    const dx = next.x - p.x;
    const dy = next.y - p.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1 || !canStep(this, p, dx, dy) || this.occupied(next.x, next.y, p.id)) return false;
    this.beginStretch(p, a);
    const steps = moveArea(this, p, a, (x, y) => this.occupied(x, y, p.id)).get(next.y * this.width + next.x);
    if (steps === undefined) return false; // beyond this stretch's movement
    a.moves = a.budget! - steps;
    p.facing = { x: dx, y: dy };
    if (!p.used.includes('turn:moved')) p.used.push('turn:moved'); // Patience
    p.x = next.x;
    p.y = next.y;
    this.watch(p);
    if (this.standIn(p, 'step')) {
      a.moves = 0; // slipped on ice, stunned, or down
      this.endStretch(p);
    }
    if (!this.standing(p)) this.cancelWalk(p.id);
    this.checkEnd();
    this.broadcast();
    return true;
  }

  // ------------------------------------------------------------ turns

  private initBonus(e: Entity): number {
    if (e.kind === 'monster') return MONSTERS[e.type].dex + (hasTrait(e, 'swift') ? 5 : 0);
    return statMod(e, 'dex') + (passiveOf(e, 'alert')?.value ?? 0) + gearBonus(e, 'init');
  }

  /** Fresh start for every fight: cooldowns ready, no leftover statuses, once-per-fight effects back. */
  private prepareForFight(p: PlayerEntity) {
    for (const s of p.skills) s.cd = 0;
    p.statuses = p.statuses.filter((s) => s.id === 'surprised'); // an ambush or a failed sneak still counts
    p.used = [];
    p.tempHp = passiveOf(p, 'arcane_ward')?.value ?? 0;
    p.savedAp = 0;
    delete p.block;
    if (hasBranch(p, 'slippery', 'B') || hasBranch(p, 'alert', 'B') || this.hasRelic('eagle_eye')) p.statuses.push({ id: 'focused', turns: 99 });
    // Stacks some heroes start a fight with: Arcane Charges (Steady Charge, the Charged Orb), Verses (Refrain, the Lute).
    const charges = (hasBranch(p, 'arcane_charge', 'B') ? 2 : 0) + gearBonus(p, 'charges');
    if (charges) p.statuses.push({ id: 'charged', turns: 99, power: charges, by: p.id });
    const verses = (hasBranch(p, 'verse', 'B') ? 2 : 0) + gearBonus(p, 'verses');
    if (verses) p.statuses.push({ id: 'verse', turns: 99, power: verses, by: p.id });
  }

  /** Adds stacks of a fight-long status (Arcane Charge, Verse, Focus), up to `cap`. */
  private addStacks(p: PlayerEntity, id: StatusId, n: number, cap: number) {
    const have = p.statuses.find((x) => x.id === id);
    if (have) have.power = Math.min(cap, (have.power ?? 0) + n);
    else p.statuses.push({ id, turns: 99, power: Math.min(cap, n), by: p.id });
  }

  private startCombat() {
    this.phoenixUsed = false;
    this.fallen = [];
    this.slain = 0;
    this.traps.clear();
    this.raised.clear();
    this.eliteKiller = null;
    for (const p of this.heroes()) this.prepareForFight(p);
    const fighters: Entity[] = [...this.heroes().filter((p) => !p.dead), ...this.allies(), ...this.monsters()];
    const init: Record<string, number> = {};
    for (const e of fighters) init[e.id] = rollDie(20) + this.initBonus(e);
    const order = fighters.map((e) => e.id).sort((a, b) => init[b] - init[a]); // stable: players win ties
    this.turn = { order, init, index: 0, round: 1, group: [], acts: {} };
    const node = this.run?.currentId ? this.node(this.run.currentId) : undefined;
    this.journal?.write({
      k: 'fight', act: this.run?.act ?? 1, row: node?.row ?? -1, kind: this.fightMeta?.kind ?? this.roomKind ?? 'combat', name: this.fightMeta?.name ?? '',
      monsters: this.monsters().map((m) => m.name), deployment: this.fightMeta?.deployment ?? 'line',
      heroes: this.heroes().map((h) => ({ name: h.name, classId: h.classId, level: h.level, hp: h.hp, maxHp: h.maxHp })),
    });
    this.fightStats = { downs: 0, deaths: 0, startHp: this.partyHp(), minHp: this.partyHp(), dmg: {} };
    this.addLog('system', `🎲 Roll for initiative! ${order.map((id) => `${this.entity(id)?.name} ${init[id]}`).join(' · ')}`);
    // A bot sizes up the foe: elites and bosses get a line of their own.
    this.chatter = newChatter();
    const foes = this.monsters();
    const lead = foes.find((m) => m.boss) ?? foes.find((m) => m.elite) ?? foes[0];
    if (lead) this.callout(this.randomBot(), lead.boss ? 'boss' : lead.elite ? 'elite' : 'start', { target: lead.name }, 'start');
    this.beginTurn();
  }

  private joinInitiative(e: Entity) {
    const t = this.turn;
    if (!t || t.order.includes(e.id)) return;
    if (e.kind === 'player') this.prepareForFight(e);
    const roll = rollDie(20) + this.initBonus(e);
    t.init[e.id] = roll;
    let i = t.order.findIndex((id) => (t.init[id] ?? 0) < roll);
    if (i < 0) i = t.order.length;
    t.order.splice(i, 0, e.id);
    if (i <= t.index) t.index++;
    this.addLog('info', `${e.name} joins the fight (initiative ${roll}).`);
  }

  private removeFromOrder(id: string) {
    const t = this.turn;
    if (!t) return;
    this.dropBlock(id); // nobody's turn will end it now
    t.group = t.group.filter((x) => x !== id);
    delete t.acts[id];
    const i = t.order.indexOf(id);
    if (i < 0) return;
    t.order.splice(i, 1);
    if (i <= t.index) t.index--;
  }

  /** Is it this creature's turn? Heroes side by side in the order share one (BG3 style). */
  private acting(e: Entity): boolean {
    const t = this.turn;
    return !!t && t.group.includes(e.id) && !t.acts[e.id]?.lost;
  }

  /** Is anyone in the current turn still playing (not just losing their turn)? */
  private anyActing(except?: Entity): boolean {
    const t = this.turn;
    return !!t && t.group.some((id) => id !== except?.id && !t.acts[id]?.lost);
  }

  /** The movement and AP a creature has left, while it's their turn. */
  private acts(e: Entity): TurnActs | undefined {
    return this.acting(e) ? this.turn!.acts[e.id] : undefined;
  }

  /** The turn as this hero sees it (the hero AI). */
  private view(p: PlayerEntity): TurnView {
    const a = this.acts(p);
    return { ...this.turn!, movesLeft: a?.moves ?? 0, ap: a?.ap ?? 0 };
  }

  /** Who acts from this spot in the order: a monster or an NPC ally alone, or every hero side by side from here on. */
  private groupAt(i: number): string[] {
    const t = this.turn!;
    const first = this.entity(t.order[i]);
    if (!first) return [];
    if (first.kind !== 'player') return [first.id];
    const ids: string[] = [];
    for (let j = i; j < t.order.length; j++) {
      const e = this.entity(t.order[j]);
      if (e?.kind !== 'player') break;
      ids.push(e.id);
    }
    return ids;
  }

  /**
   * Starts the next turn: a monster or an NPC ally alone, or every hero side by side in the order at once. Those heroes move
   * and act in any order, each ends their own turn, and the turn moves on when the last of them has. `only` starts just
   * those creatures (tests).
   */
  private beginTurn(only?: string[]) {
    const t = this.turn;
    if (!t || this.phase !== 'combat') return;
    const token = ++this.turnToken;
    const ids = only ?? this.groupAt(t.index);
    if (!ids.length) return this.advanceTurn();
    if (!only) t.index += ids.length - 1;
    t.group = [...ids];
    t.acts = {};
    this.turnStarted = Date.now();
    this.turnSize = ids.length;
    if (this.fightStats) this.fightStats.minHp = Math.min(this.fightStats.minHp, this.partyHp());
    const ready: Entity[] = [];
    let pause = 0;
    for (const id of ids) {
      const e = this.entity(id);
      const how = e ? this.startTurn(e) : 'gone';
      if (how === 'over' || token !== this.turnToken || this.phase !== 'combat') return;
      if (how === 'act') ready.push(e!);
      else if (how === 'gone') {
        if (e && t.group.includes(id)) this.endOfTurn(e);
        t.group = t.group.filter((x) => x !== id);
        delete t.acts[id];
      } else {
        Object.assign(t.acts[id], { moves: 0, ap: 0, lost: true }); // its turn ends with everyone's
        pause = Math.max(pause, how === 'down' ? 1000 : 900);
      }
    }
    if (!t.group.length) return this.advanceTurn();
    if (!ready.length) this.later(token, pause, () => this.advanceTurn()); // a lost turn stays on screen a moment
    for (const e of ready) {
      if (e.kind === 'monster') this.runMonster(e, token).catch((err) => console.error('monster AI error', err));
      else if (this.isAuto(e.playerId)) this.runHero(e, token);
    }
    this.broadcast();
  }

  /**
   * One creature's start of turn: its Block runs out, statuses tick, the ground it stands on, a death save if it's down.
   * Says whether it gets to act ('act'), loses the turn ('lost', 'down'), is gone ('gone'), or the fight just ended ('over').
   */
  private startTurn(e: Entity): 'act' | 'lost' | 'down' | 'gone' | 'over' {
    const t = this.turn!;
    // Heroes get their AP once it's clear they get to act.
    const a: TurnActs = { moves: (SLOWED.some((id) => hasStatus(e, id)) ? Math.floor(e.speed / 2) : e.speed) + (hasStatus(e, 'charging') ? CHARGE_MOVES : 0), ap: 0 };
    t.acts[e.id] = a;
    // The Block this creature gave runs out (on itself and on friends); then shields and gear put up this turn's.
    this.expireBlock(e);
    if (e.kind === 'player' && e.dead) return 'gone';
    const wall = e.kind === 'player' ? (this.standing(e) ? gearBonus(e, 'block') : 0) : (MONSTERS[e.type]?.block ?? 0);
    if (wall > 0) this.addBlock(e, e, wall, false);
    if (hasStatus(e, 'prone')) {
      // Getting back up costs half its movement.
      e.statuses = e.statuses.filter((s) => s.id !== 'prone');
      if (!(e.kind === 'player' && e.downed)) {
        a.moves = Math.floor(a.moves / 2);
        this.addLog('info', `🤕 ${e.name} gets back up.`);
      }
    }
    if (ROOTED.some((id) => hasStatus(e, id))) [a.held, a.moves] = [a.moves, 0];
    if (e.kind === 'monster') {
      if (e.trickCd) e.trickCd--;
      if (e.orderCd) e.orderCd--;
    }

    if (e.kind === 'player' && !e.downed) this.heroTurnStart(e);
    this.tickStatuses(e);
    this.standIn(e, 'start'); // still in the fire, the poison, the water...
    if (this.checkEnd()) return 'over';
    if (!this.entities.includes(e)) return 'gone'; // burned to death
    if (e.kind === 'player' && e.dead) return 'gone';
    if (e.kind === 'monster' && e.traits?.length) {
      this.eliteTurnStart(e);
      if (this.checkEnd()) return 'over';
      if (!this.entities.includes(e)) return 'gone';
    }

    if (e.kind === 'player' && e.downed) {
      this.deathSave(e);
      if (e.dead) return 'gone';
      if (e.downed) return 'down';
      this.grantAp(e); // a great death save gets them back up mid-turn
      return 'act';
    }
    const lost: [StatusId, string, string, string][] = [
      ['surprised', '😱', 'is caught by surprise and loses the turn', '#ffd84d'],
      ['stunned', '💫', 'is stunned and loses the turn', '#ffd84d'],
      ['frozen', '🧊', 'is frozen solid and loses the turn', '#cdefff'],
      ['groggy', '🥴', 'is still groggy from going down and loses the turn', '#ffd84d'],
    ];
    const skip = lost.find(([id]) => hasStatus(e, id));
    if (skip) {
      const [id, icon, text, color] = skip;
      this.addLog('info', `${icon} ${e.name} ${text}.`);
      this.float(e, id === 'surprised' ? 'surprised!' : id, color);
      return 'lost';
    }
    if (e.kind === 'player') this.grantAp(e);
    return 'act';
  }

  /** The hero skill being resolved right now (Empowered Evocation, Sculpt Spells, Blessed Smites read it). */
  private casting: { id: SkillId; s: SkillStats } | null = null;
  /** Who this cast's Unleashed dice already hit (once per target, however many darts). */
  private unleashedOn = new Set<string>();
  /** Hidden snares (Ranger Trapper), by tile: the first monster to step in gets it. `cast` orders them (3 casts each). */
  private traps = new Map<number, { by: string; cast: number; status: StatusApply[]; dmg?: Dice; element?: Element; left: number }>();
  private trapCasts = 0;

  /** 🧱 Block from `by` (until the start of its next turn), on top of what the target has. */
  private addBlock(t: Entity, by: Entity, n: number, show = true) {
    if (n <= 0) return;
    if (by.kind === 'player') n += passiveOf(by, 'unbreakable_oath')?.value ?? 0; // Unbreakable Oath II: a little more
    (t.block ??= {})[by.id] = (t.block[by.id] ?? 0) + n;
    if (show) this.float(t, `🧱+${n}`, '#c8d1dc');
  }

  /** A hero's skill puts up Block (the dice, plus their level for some), with a line in the log. */
  private blockFrom(p: PlayerEntity, t: Entity, dice: Dice, level?: boolean) {
    const n = rollDice(dice) + (level ? p.level : 0);
    this.addBlock(t, p, n);
    this.addLog('info', t === p ? `🧱 ${p.name} gets ${n} Block until their next turn.` : `🧱 ${p.name} covers ${t.name}: ${n} Block until ${p.name}'s next turn.`);
  }

  /** The Block this creature gave runs out, wherever it is (`old`: only what an Unbreakable Oath kept from last turn). */
  private dropBlock(id: string, old = false) {
    for (const e of this.entities) {
      if (!e.block) continue;
      for (const key of old ? [`${id}:old`] : [id, `${id}:old`]) delete e.block[key];
      if (!Object.keys(e.block).length) delete e.block;
    }
  }

  /**
   * The start of a creature's turn: the Block it gave runs out. An Unbreakable Oath makes it last one more turn (it's
   * kept as `id:old`), and Fortress keeps part of the Block a fighter gave themself.
   */
  private expireBlock(e: Entity) {
    const hero = e.kind === 'player' ? e : null;
    const fort = hero ? passiveOf(hero, 'fortress') : null;
    const own = e.block?.[e.id] ?? 0;
    if (hero && passiveOf(hero, 'unbreakable_oath')) {
      this.dropBlock(e.id, true);
      for (const x of this.entities) {
        const n = x.block?.[e.id];
        if (!n) continue;
        x.block![`${e.id}:old`] = n;
        delete x.block![e.id];
      }
    } else this.dropBlock(e.id);
    if (hero && fort && own > 0 && this.standing(hero)) {
      const kept = Math.floor((own * fort.value) / 100);
      if (kept > 0) {
        (e.block ??= {})[e.id] = Math.max(e.block[e.id] ?? 0, kept);
        if (hasBranch(hero, 'fortress', 'B')) for (const h of this.heroes()) if (h !== hero && this.standing(h) && dist(h, hero) <= 1) this.addBlock(h, hero, Math.floor(kept / 2));
      }
    }
  }

  /** Block soaks damage before anything else. Returns what gets through. */
  private soakBlock(t: Entity, amount: number): number {
    if (!t.block || amount <= 0) return amount;
    let soaked = 0;
    for (const [id, n] of Object.entries(t.block)) {
      const take = Math.min(n, amount - soaked);
      soaked += take;
      this.sharedBurden(id.split(':')[0], t, take);
      if (n > take) t.block[id] = n - take;
      else delete t.block[id];
      if (soaked >= amount) break;
    }
    if (!Object.keys(t.block).length) delete t.block;
    if (soaked) this.float(t, `🧱${soaked}`, '#c8d1dc');
    return amount - soaked;
  }

  /** Shared Burden: when a paladin's Block soaks a hit on a friend, the paladin heals part of it (Bond of Steel: both). */
  private sharedBurden(giverId: string, t: Entity, soaked: number) {
    const giver = this.entity(giverId);
    if (soaked <= 0 || giver === t || giver?.kind !== 'player' || !this.standing(giver)) return;
    const burden = passiveOf(giver, 'shared_burden');
    if (!burden) return;
    const n = Math.floor((soaked * burden.value) / 100);
    if (n <= 0) return;
    this.healBy(null, giver, n);
    if (hasBranch(giver, 'shared_burden', 'B') && t.kind === 'player') this.healBy(null, t, n);
  }

  /** Gives a hero AP: now, if it's their turn, else on their next one (Emboldened). */
  private giveAp(t: PlayerEntity, n: number, by: Entity) {
    if (n <= 0 || !this.standing(t)) return;
    const a = this.acts(t);
    if (a) a.ap += n;
    else {
      const had = t.statuses.find((x) => x.id === 'emboldened');
      if (had) had.power = (had.power ?? 0) + n;
      else t.statuses.push({ id: 'emboldened', turns: 9, power: n, by: by.id });
    }
    this.float(t, `⚡+${n} AP`, '#f6cf7a');
  }

  /** A hero who gets to act: this turn's AP plus what they saved last turn, up to AP_MAX. A lost turn keeps the savings. */
  private grantAp(p: PlayerEntity) {
    const bold = p.statuses.find((x) => x.id === 'emboldened')?.power ?? 0; // Voice of Authority, Rousing Inspiration
    p.statuses = p.statuses.filter((x) => x.id !== 'emboldened');
    this.turn!.acts[p.id].ap = Math.min(AP_MAX, (p.savedAp ?? 0) + AP_GAIN) + bold;
    p.savedAp = 0;
  }

  /** Start of a hero's turn: cooldowns tick down, per-round effects come back, regeneration passives. */
  private heroTurnStart(p: PlayerEntity) {
    for (const s of p.skills) if (s.cd > 0) s.cd--;
    p.used = p.used.filter((u) => !u.startsWith('turn:') && !u.startsWith('round:'));
    const hardened = passiveOf(p, 'battle_hardened');
    if (hardened && p.hp < p.maxHp / 2) {
      this.addLog('heal', `🪨 ${p.name} grits their teeth: +${Math.min(hardened.value, p.maxHp - p.hp)} HP.`);
      this.healBy(null, p, hardened.value);
    }
    if (hasBranch(p, 'tough', 'B') && p.hp < p.maxHp) this.healBy(null, p, 1);
    if (this.hasBlessing('renewal') && p.hp < p.maxHp) this.healBy(null, p, RENEWAL_HP);
    const ward = passiveOf(p, 'arcane_ward');
    if (ward && hasBranch(p, 'arcane_ward', 'B')) p.tempHp = Math.min(ward.value, p.tempHp + 3);
    // Aura of Warding: Block for the friends next to you (and you, as a Warden).
    const aura = passiveOf(p, 'aura_of_warding');
    if (aura) {
      const reach = hasBranch(p, 'aura_of_warding', 'A') ? 2 : 1;
      for (const h of this.heroes()) {
        if (!this.standing(h) || dist(h, p) > reach || (h === p && !hasBranch(p, 'aura_of_warding', 'B'))) continue;
        this.addBlock(h, p, aura.value);
      }
    }
    // Divine Vitality: a little HP back every turn (and for the friends next to you, with Vitality Aura).
    const vital = passiveOf(p, 'divine_vitality');
    if (vital) {
      this.healBy(null, p, vital.value);
      if (hasBranch(p, 'divine_vitality', 'B')) for (const h of this.heroes()) if (h !== p && this.standing(h) && dist(h, p) <= 1) this.healBy(null, h, 1);
    }
    if (hasBranch(p, 'unstoppable', 'B') && hasStatus(p, 'raging')) this.addMoves(p, 2); // Rampaging
    // Noxious Fumes: the enemies around you choke on it.
    const fumes = passiveOf(p, 'noxious_fumes');
    if (fumes) {
      const reach = hasBranch(p, 'noxious_fumes', 'A') ? 2 : 1;
      for (const m of this.monsters().filter((m) => dist(m, p) <= reach)) {
        this.applyStatus(m, { id: 'poisoned', turns: 2, power: fumes.value }, p);
        if (hasBranch(p, 'noxious_fumes', 'B')) this.applyStatus(m, { id: 'dazed', turns: 1 }, p);
      }
    }
    if (hasBranch(p, 'magnum_opus', 'B')) this.addStacks(p, 'verse', 1, passiveOf(p, 'verse')?.value ?? 5);
  }

  /** Voice of Authority and Rousing Inspiration: a friend you help gets more AP on their next turn (Emboldened). */
  private hurry(p: PlayerEntity, fr: PlayerEntity, id: SkillId, s: SkillStats) {
    const helps = !!(s.heal || s.block || s.status?.length || s.tempHp);
    if (!helps) return;
    let bold = 0;
    const voice = passiveOf(p, 'voice_of_authority');
    if (voice && fr !== p) {
      const once = hasBranch(p, 'voice_of_authority', 'A') ? null : voice.tier === 1 ? 'round:voice' : 'turn:voice';
      if (!once || !p.used.includes(once)) {
        if (once) p.used.push(once);
        bold += voice.value;
      }
    }
    // Divine Order: Bless (and from tier II Warding Light) gives AP, once a round per friend.
    const order = passiveOf(p, 'divine_order');
    if (order && (id === 'bless' || (id === 'warding_light' && order.tier >= 2)) && !fr.used.includes('round:order')) {
      fr.used.push('round:order');
      bold += order.value;
    }
    if (id === 'inspiration') {
      const rouse = passiveOf(p, 'rousing');
      if (rouse) {
        bold += rouse.value;
        if (rouse.tier >= 2) this.applyStatus(fr, { id: 'blessed', turns: 2, power: 1 }, p);
        if (hasBranch(p, 'rousing', 'B')) {
          const healed = this.healBy(p, fr, rollDice({ n: 1, d: 6 }) + p.level);
          if (healed) this.addLog('heal', `📯 ${p.name}'s encouragement mends ${fr.name}: +${healed} HP.`);
        }
      }
      const muse = passiveOf(p, 'combat_inspiration');
      if (muse) {
        const turns = hasBranch(p, 'combat_inspiration', 'A') ? 3 : 2;
        this.applyStatus(fr, { id: 'blessed', turns, power: 1 }, p);
        if (muse.tier >= 2) this.applyStatus(fr, { id: 'shielded', turns, power: muse.value }, p);
        if (hasBranch(p, 'combat_inspiration', 'B')) this.applyStatus(fr, { id: 'rallied', turns, power: 1, stack: 3 }, p);
      }
    }
    if (bold > 0) {
      const had = fr.statuses.find((x) => x.id === 'emboldened');
      if (had) had.power = (had.power ?? 0) + bold;
      else fr.statuses.push({ id: 'emboldened', turns: 9, power: bold, by: p.id });
      this.float(fr, `⚡+${bold} AP`, '#f6cf7a');
    }
  }

  /** Snare Trap: hidden traps on the open, empty tiles of the area. A hero keeps the traps of their last 3 casts. */
  private setTraps(p: PlayerEntity, s: SkillStats, center: Pos) {
    const trap = s.trap!;
    const cast = ++this.trapCasts;
    const r = s.radius ?? 0;
    let n = 0;
    for (let y = center.y - r; y <= center.y + r; y++) {
      for (let x = center.x - r; x <= center.x + r; x++) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || this.tiles[y * this.width + x] !== '.') continue;
        if (this.entities.some((e) => e.x === x && e.y === y && !(e.kind === 'player' && e.dead))) continue;
        const extra = hasBranch(p, 'ambusher', 'B') ? { n: (trap.dmg?.n ?? 0) + 1, d: 6 } : trap.dmg; // Snare Master
        const field = passiveOf(p, 'killing_field'); // springs more than once (Cruel Traps: harder)
        const dmg = hasBranch(p, 'killing_field', 'B') ? { n: (extra?.n ?? 0) + 1, d: extra?.d ?? 6, ...(extra?.bonus ? { bonus: extra.bonus } : {}) } : extra;
        this.traps.set(y * this.width + x, { by: p.id, cast, status: trap.status, dmg, element: trap.element, left: field?.value ?? 1 });
        n++;
      }
    }
    const mine = [...new Set([...this.traps.values()].filter((t) => t.by === p.id).map((t) => t.cast))].sort((a, b) => b - a);
    const keep = (passiveOf(p, 'killing_field')?.tier ?? 0) >= 2 ? 5 : 3;
    for (const [i, t] of [...this.traps]) if (t.by === p.id && !mine.slice(0, keep).includes(t.cast)) this.traps.delete(i);
    this.addLog('info', `🪤 ${p.name} hides ${n > 1 ? `${n} snares` : 'a snare'}.`);
  }

  /** A monster steps on a snare: it springs (damage, then Netted and the rest). Returns true if it's stuck. */
  private springTrap(e: Entity): boolean {
    if (e.kind !== 'monster' || isAllyNpc(e)) return false;
    const i = e.y * this.width + e.x;
    const trap = this.traps.get(i);
    if (!trap) return false;
    if (--trap.left <= 0) this.traps.delete(i);
    const by = this.entity(trap.by);
    this.addLog('hit', `🪤 ${e.name} steps into ${by ? `${by.name}'s` : 'a'} snare!`);
    this.float(e, '🪤 snared!', '#f6cf7a');
    if (trap.dmg) this.damage(e, rollDice(trap.dmg), by, trap.element ?? 'physical');
    if (trap.element && by) this.runField([{ kind: 'touch', tiles: [i], element: trap.element === 'fire' ? 'fire' : 'cold' }], by); // Fire Trap lights the oil
    if (!this.entities.includes(e)) return true;
    for (const st of trap.status) this.applyStatus(e, st, by);
    return ROOTED.some((id) => hasStatus(e, id));
  }

  /** Unstoppable (Juggernaut): no Prone (from tier II), and while Raging no Netted, Webbed (Iron Will: Dazed, Frightened). */
  private unstoppable(p: PlayerEntity, id: StatusId): boolean {
    const u = passiveOf(p, 'unstoppable');
    if (!u) return false;
    const raging = hasStatus(p, 'raging');
    if (id === 'prone') return u.tier >= 2 || raging;
    if (!raging) return false;
    return id === 'netted' || id === 'webbed' || (hasBranch(p, 'unstoppable', 'A') && (id === 'dazed' || id === 'frightened'));
  }

  /** Burning and poison bite at the start of the creature's turn. */
  private tickStatuses(e: Entity) {
    // Sunfire (Avatar of Light): Radiance burns at the start of the turn.
    const seared = e.statuses.find((x) => x.id === 'seared');
    const sun = seared && this.entity(seared.by);
    if (seared?.power && sun?.kind === 'player' && hasBranch(sun, 'avatar_of_light', 'A')) {
      this.addLog('hit', `🔆 ${e.name}'s Radiance burns for ${seared.power}.`);
      this.damage(e, seared.power, sun, 'radiant');
      if (!this.entities.includes(e)) return;
    }
    for (const s of [...e.statuses]) {
      if (s.id !== 'burning' && s.id !== 'poisoned') continue;
      if (!this.entities.includes(e) || (e.kind === 'player' && (e.downed || e.dead))) return;
      const source = this.entity(s.by);
      const virulent = s.id === 'poisoned' && source?.kind === 'player' && !!passiveOf(source, 'virulence'); // Virulence: d6s
      const dmg = rollDice({ n: s.power ?? 1, d: virulent ? 6 : 4 });
      this.addLog('hit', `${STATUSES[s.id].icon} ${e.name} ${s.id === 'burning' ? 'burns' : 'suffers from poison'} for ${dmg}.`);
      this.damage(e, dmg, source, s.id === 'burning' ? 'fire' : 'poison');
    }
  }

  /** End of a creature's turn: statuses count down, and a hero's unspent AP is saved for the next turn. */
  private endOfTurn(e: Entity) {
    if (e.kind === 'player') e.savedAp = e.downed || e.dead ? 0 : Math.max(e.savedAp ?? 0, this.turn?.acts[e.id]?.ap ?? 0);
    this.journalTurn(e);
    // Patience: a turn without moving builds Focus.
    const calm = e.kind === 'player' ? passiveOf(e, 'patience') : null;
    if (calm && e.kind === 'player' && this.standing(e) && !e.used.includes('turn:moved')) {
      const n = hasBranch(e, 'patience', 'A') ? 2 : 1;
      this.applyStatus(e, { id: 'aiming', turns: 99, power: n, stack: calm.value / n }, e);
    }
    for (const s of e.statuses) if (!this.lasting(s)) s.turns--;
    e.statuses = e.statuses.filter((s) => s.turns > 0);
  }

  /** The run journal's pace data: how long this turn took. Lost turns (down, stunned...) aren't timed. */
  private journalTurn(e: Entity) {
    const t = this.turn;
    if (!this.journal || !t || t.acts[e.id]?.lost || (e.kind === 'player' && (e.dead || e.downed))) return;
    this.journal.write({
      k: 'turn', who: e.name, side: e.kind === 'player' ? 'hero' : isAllyNpc(e) ? 'ally' : 'monster',
      auto: e.kind === 'player' ? this.isAuto(e.playerId) : true, round: t.round, ms: Date.now() - this.turnStarted, shared: this.turnSize,
    });
  }

  /** Virulent Poison and an Avatar's Radiance never wear off. */
  private lasting(s: { id: StatusId; by?: string }): boolean {
    if (s.id !== 'poisoned' && s.id !== 'seared') return false;
    const by = this.entity(s.by);
    return by?.kind === 'player' && !!passiveOf(by, s.id === 'poisoned' ? 'virulence' : 'avatar_of_light');
  }

  /** Plays an auto hero's turn, one decision at a time, through the same checks as a human. */
  private runHero(p: PlayerEntity, token: number) {
    if (this.heroTurns.get(p.id) === token) return; // already playing this turn
    this.heroTurns.set(p.id, token);
    this.playHeroTurn(p, token)
      .catch((err) => console.error('hero AI error', err))
      .finally(() => {
        if (this.heroTurns.get(p.id) === token) this.heroTurns.delete(p.id); // allow a restart if Auto is toggled off and on again
      });
  }

  private async playHeroTurn(p: PlayerEntity, token: number) {
    // Stops as soon as the turn changes, the fight ends, or the player takes back control.
    const ok = () => token === this.turnToken && this.phase === 'combat' && this.acting(p) && this.isAuto(p.playerId);
    await sleep(350);
    // Bots in a shared turn take theirs one after another, in turn order, so each plans with the moves before it done (all
    // at once, they ran to the same downed friend or at a monster another was about to kill). The people play any time.
    while (ok() && this.botAhead(p, token)) await sleep(100);
    for (let i = 0; i < 16 && ok(); i++) {
      const intent = nextHeroIntent({
        map: this, hero: p, heroes: this.heroes(), monsters: this.monsters(), allies: this.allies(), turn: this.view(p),
        occupied: (x, y, exceptId) => this.occupied(x, y, exceptId),
      });
      if (intent.kind === 'end') break;
      if (intent.kind === 'act') {
        const used = this.handleSkill(p.playerId, intent.skill, intent.target);
        if (!ok()) return;
        if (!used) break; // rejected: don't loop on it
        await sleep(450);
      } else {
        const plan = planWalk(this, p, intent.to, this.acts(p)?.moves ?? 0, (x, y) => this.occupied(x, y, p.id), p);
        if (!plan?.path.length) break;
        for (const step of plan.path) {
          if (this.turnedDangerous(p, step, plan.hazards) || !this.tryMove(p, step)) break; // the next decision plans again
          await sleep(MONSTER_STEP_MS);
          if (!ok()) return;
        }
      }
    }
    if (ok()) this.finishTurn(p);
  }

  /** Is another bot of this shared turn, ahead of this one in the turn order, still playing? */
  private botAhead(p: PlayerEntity, token: number): boolean {
    const t = this.turn!;
    const mine = t.group.indexOf(p.id);
    return t.group.some((id, i) => i < mine && this.heroTurns.get(id) === token);
  }

  /** A hero is done for this turn (or can't go on). Once everyone acting is, the turn moves on. */
  private finishTurn(e: Entity) {
    const t = this.turn;
    if (!t || this.phase !== 'combat') return;
    if (this.anyActing(e)) {
      if (!t.group.includes(e.id)) return;
      this.endOfTurn(e);
      this.cancelWalk(e.id);
      t.group = t.group.filter((id) => id !== e.id);
      delete t.acts[e.id];
      this.broadcast();
    } else this.advanceTurn(); // the last one playing: the turn ends for everyone in it
  }

  /** Everyone still acting is done: their turns end, and the next creature (or group of heroes) begins. */
  private advanceTurn() {
    const t = this.turn;
    if (!t || this.phase !== 'combat') return;
    for (const id of t.group) {
      const e = this.entity(id);
      if (e) this.endOfTurn(e);
      this.cancelWalk(id);
    }
    t.group = [];
    t.acts = {};
    if (this.checkEnd() || !t.order.length) return;
    t.index++;
    if (t.index >= t.order.length) {
      t.index = 0;
      t.round++;
      tickField(this); // fires burn out, ice melts, electricity fades
      this.tickRaised();
    }
    this.beginTurn();
  }

  handleEndTurn(playerId: string) {
    const p = this.hero(playerId);
    if (!p || this.phase !== 'combat' || !this.acting(p)) return;
    this.finishTurn(p);
  }

  /** Ends the fight or the run if appropriate. Returns true if the current flow should stop. */
  private checkEnd(): boolean {
    if (this.phase !== 'combat') return true;
    if (!this.heroes().some((p) => this.standing(p))) {
      this.endRun(false);
      return true;
    }
    if (!this.monsters().length) {
      this.endCombat();
      return true;
    }
    return false;
  }

  /** A won fight: everyone gets up and catches their breath, then the victory screen (the room stays behind it). */
  private endCombat() {
    const rounds = this.turn?.round ?? 1;
    const dealt = { ...this.fightStats?.dmg };
    const name = this.fightMeta?.name || 'The fight';
    const kind = this.roomKind ?? 'combat';
    let leveled: string[] = [];
    const lines = this.collect(() => (leveled = this.afterFight(kind)));
    const damage = this.heroes()
      .map((h) => [h.name, Math.round(dealt[h.name] ?? 0)] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([n, d]) => `${n} ${d}`);
    lines.push(`⚔️ Damage dealt: ${damage.join(' · ')}.`);
    const text = `${name}: won in ${rounds} round${rounds === 1 ? '' : 's'}.`;
    if (kind === 'boss') return this.finishAct(text, lines);
    if (kind === 'elite') return this.eliteSpoils(text, lines);
    lines.push(`🏆 Every hero picks their spoils: two skill cards and an item card${leveled.length ? ', plus the level-up cards' : ''}.`);
    this.showOutcome({ glyph: '✅', title: 'Victory!', text, lines }, '🗺️ Back to the map', () => this.toMap());
  }

  /** What a won fight hands out: healing, gold, loot, potions, level-ups and spoils. Returns who leveled up. */
  private afterFight(kind: NodeType): string[] {
    this.journalFightEnd(true);
    this.traps.clear();
    this.raised.clear();
    const run = this.run!;
    // Song of Rest: the best Bard's song adds its share on top.
    const song = Math.max(0, ...this.heroes().map((h) => passiveOf(h, 'song_of_rest')?.value ?? 0)) / 100;
    const breather = BREATHER.heal + (this.hasRelic('rations') ? 0.1 : 0) + song;
    for (const h of this.heroes()) if (hasBranch(h, 'song_of_rest', 'B') && h.slots < h.maxSlots) h.slots++; // Encore
    this.endRoom();
    const gold = this.goldFound(roomGold(run.act, kind));
    run.gold += gold;
    this.addLog('loot', `✅ Room cleared! The party loots ${gold} gold.`);
    // NPC allies have one fight fewer to go.
    for (const a of run.allies) a.fights--;
    for (const a of run.allies) if (a.fights <= 0) this.addLog('info', `👋 ${a.name} has fought the agreed fights and heads home. Good luck!`);
    run.allies = run.allies.filter((a) => a.fights > 0);
    // Everyone gets back up, then the party catches its breath (a short rest).
    for (const p of this.heroes()) {
      const died = p.dead;
      if (p.dead || p.downed) {
        p.dead = false;
        p.downed = false;
        p.saves = { ok: 0, fail: 0 };
      }
      const drained = hasStatus(p, 'drained');
      p.statuses = [];
      // 🩹 Death leaves an Injury (less max HP) until the next rest site.
      if (died) p.injuries = Math.min(MAX_INJURIES, (p.injuries ?? 0) + 1);
      if (drained || died) {
        const hp = p.hp;
        recalcHero(p); // max HP comes back (or shrinks with an Injury), the HP doesn't
        p.hp = Math.min(hp, p.maxHp);
      }
      if (died) this.addLog('death', `🩹 ${p.name} is back, but injured: -${Math.round(INJURY_PCT * 100 * (p.injuries ?? 1))}% max HP until the next rest site.`);
      p.tempHp = 0;
      delete p.block;
      p.used = [];
      for (const s of p.skills) s.cd = 0;
      p.hp = Math.min(p.maxHp, Math.max(1, p.hp) + Math.ceil(p.maxHp * breather - 1e-9)); // (0.2 + 0.1 isn't quite 0.3)
    }
    this.addLog('heal', `🫁 The party catches its breath: everyone heals ${Math.round(breather * 100)}% of their max HP.`);
    this.callout(this.randomBot(), 'won', {}, 'after');
    if (kind === 'elite') this.fightLoot(kind);
    this.potionDrop();
    if (kind === 'elite') for (const p of this.heroes()) p.elitePicks++; // dealt first (dealOffer), before the spoils below
    const leveled = this.checkLevelUps();
    this.victorySpoils();
    return leveled;
  }

  /**
   * After an elite (every hero's elite-spoils pick, an upgrade, gear or a boon, was dealt in endCombat): the party votes
   * on a blessing for the rest of the act or an NPC ally for the next few fights.
   */
  private eliteSpoils(text: string, lines: string[]) {
    const run = this.run!;
    const blessings = shuffle(BLESSING_IDS.filter((b) => !run.blessings.includes(b))).slice(0, 2);
    this.eliteReward(text, [...blessings.map((b) => `blessing:${b}`), `ally:${pick(ALLY_IDS)}`], lines);
  }

  /** The party's vote after an elite. A save made during it reopens the same vote. */
  private eliteReward(text: string, choices: string[], lines: string[] = []) {
    const run = this.run!;
    const choice = (c: string): EventChoiceDef | null => {
      const [kind, id] = c.split(':');
      if (kind === 'blessing' && isBlessingId(id)) {
        const b = BLESSINGS[id];
        return {
          id: c, label: `${b.icon} ${b.name}`, hint: `${b.desc} Until the end of the act.`,
          resolve: () => ({ text: `The party takes the ${b.name}.`, effects: [{ kind: 'blessing', id }] }),
        };
      }
      if (kind === 'ally' && isAllyId(id)) {
        const a = ALLIES[id];
        const m = MONSTERS[a.monster];
        return {
          id: c, label: `${m.glyph} Free their captive ${m.name}`, hint: `${a.desc} Fights with you for the next ${ALLY_FIGHTS} fights.`,
          resolve: () => ({ text: `A grateful ${m.name} joins the party.`, effects: [{ kind: 'ally', id }] }),
        };
      }
      return null;
    };
    const options = choices.map(choice).filter((c): c is EventChoiceDef => !!c);
    this.savePoint = { kind: 'reward', nodeId: run.currentId ?? '', choices: options.map((o) => o.id), text, lines };
    this.startEvent(undefined, {
      id: 'spoils',
      title: 'Elite defeated!',
      glyph: '💀',
      text: `${text} Every hero picks their spoils. Then choose together: a blessing for the rest of the act, or the captive they were holding, who fights with you for the next ${ALLY_FIGHTS} fights.`,
      choices: options,
      lines,
    });
  }

  /** Every won fight: each hero gets a spoils pick (two skill cards and an item card, server/progression.ts). */
  private victorySpoils() {
    const act = this.run?.act ?? 1;
    for (const p of this.heroes()) {
      p.rewardPicks = (p.rewardPicks ?? 0) + 1;
      if (!p.offer) dealOffer(p, rng, act);
    }
    this.scheduleAutoPicks();
  }

  /** A potion after a won fight, Slay the Spire style: the odds drop after one does and climb after a fight without. */
  private potionDrop(): string | null {
    const run = this.run!;
    const odds = run.potionOdds ?? POTION_ODDS;
    if (rng.next() * 100 >= odds) {
      run.potionOdds = Math.min(100, odds + POTION_ODDS_STEP);
      return null;
    }
    run.potionOdds = Math.max(0, odds - POTION_ODDS_STEP);
    const taker = this.heroes().filter((h) => !h.dead).sort((a, b) => a.potions - b.potions)[0];
    if (!taker) return null;
    taker.potions++;
    const text = `🧪 ${taker.name} finds a healing potion.`;
    this.addLog('loot', text);
    return text;
  }

  /** What an elite leaves behind: its gear goes to whoever killed it. */
  private fightLoot(kind: NodeType): string | null {
    const act = this.run?.act ?? 1;
    if (kind === 'elite') {
      const id = this.randomItem('gear', rollRarity(rng.next(), act, { elite: true }));
      const killer = this.heroes().find((h) => h.id === this.eliteKiller);
      const got = this.giveItem(killer, id);
      const info = itemInfo(id);
      if (!got) return null;
      const text = `${info.icon} ${got.name} ${killer === got ? 'claims' : 'picks up'} the ${info.name}${killer === got ? ' (killing blow)' : ''}.`;
      this.addLog('loot', text);
      return text;
    }
    return null;
  }

  private endRun(victory: boolean) {
    this.journalFightEnd(victory);
    this.endRoom();
    this.phase = victory ? 'victory' : 'defeat';
    try {
      archiveSave(this.code, victory ? 'victory' : 'defeat');
    } catch (err) {
      console.error(`[save ${this.code}] could not archive the save:`, err);
    }
    const run = this.run;
    const gold = run?.gold ?? 0;
    this.addLog(
      'system',
      victory
        ? `🏆 VICTORY! The ${MONSTERS[ACTS[MAX_ACT - 1].boss].name} is slain and the party leaves the dungeon with ${gold} gold!`
        : `☠️ The party has fallen in Act ${run?.act ?? 1} (${run?.actName ?? ''}). Gold found: ${gold}.`,
    );
    this.journal?.write({
      k: 'end', victory, act: run?.act ?? 1, gold, relics: (run?.relics ?? []).map((id) => RELICS[id]?.name ?? id),
      heroes: this.heroes().map((h) => ({
        name: h.name, classId: h.classId, level: h.level, engine: ((e) => (e ? ENGINES[e].name : undefined))(topEngine(h)),
        skills: h.skills.map((o) => skillTitle(o)), gear: [...Object.values(h.gear), ...h.bag].filter((id) => !!id).map((id) => itemInfo(id!).name), injuries: h.injuries ?? 0,
      })),
    });
    this.journal?.flush();
    this.broadcast();
  }

  private later(token: number, ms: number, fn: () => void) {
    setTimeout(() => {
      if (token === this.turnToken && this.phase === 'combat') fn();
    }, ms / SPEED);
  }

  // ------------------------------------------------------------ monsters

  private async runMonster(m: MonsterEntity, token: number) {
    const def = MONSTERS[m.type];
    const ok = () => token === this.turnToken && this.phase === 'combat' && this.entities.includes(m);
    /** The monster died on its own turn (Sentinel, Riposte): move on. */
    const diedMidTurn = () => {
      if (token === this.turnToken && !this.checkEnd()) this.advanceTurn();
    };
    await sleep(400);
    if (!ok()) return;
    const ally = !!m.ally;
    if (m.boss && !ally) this.bossClock(m);
    if (!ally && this.madness(m)) {
      this.broadcast();
      if (this.checkEnd()) return;
      await sleep(700);
      if (ok()) this.advanceTurn();
      else diedMidTurn();
      return;
    }

    if (def.breath && !ally && this.turn && this.turn.round % 3 === 0) {
      const victims = this.entities.filter((e) => !isFoe(e) && this.up(e) && dist(e, m) <= 3 && hasLOS(this, m, e));
      if (victims.length) {
        this.breathWeapon(m, victims);
        this.broadcast();
        if (this.checkEnd()) return;
        await sleep(700);
        if (ok()) this.advanceTurn();
        return;
      }
    }

    if (hasTrait(m, 'summoner')) this.summon(m);
    if (def.raise && !ally) this.raiseDead(m, def.raise);

    // A leader shouts an order first (a free action), then takes its turn. Not on Story: monsters there fight on instinct.
    const view = this.monsterView(m);
    if (def.leader && !ally && !(m.orderCd ?? 0) && DIFFICULTIES[this.diff].squad) {
      const order = pickOrder(view);
      if (order) {
        this.giveOrder(m, order);
        this.broadcast();
        await sleep(600);
        if (!ok()) return;
      }
    }

    // The plan (server/monsterai.ts): where to walk, then attack, shove, hit the ground, heal, buff, trick, help or run.
    const plan = await this.monsterPlan(m, view);
    if (!ok()) return;
    if (plan.kind === 'flee' && hasStatus(m, 'frightened')) {
      this.addLog('info', `😨 ${m.name} flees in terror!`);
    } else if (plan.kind === 'flee') {
      m.fled = (m.fled ?? 0) + 1;
      if (m.fled === 1) this.bark(m, 'flee');
    } else if (plan.cornered) {
      m.fled = COWARD_TURNS; // it stops trying to run
      this.bark(m, 'cornered');
    }
    const canHit = (from: Pos, t: Pos) => canHitFrom(this, m, from, t);
    // Its enemies: the party (heroes and NPC allies) for a monster, the monsters for an ally.
    const enemies: Entity[] = ally ? this.monsters() : this.entities.filter((e) => !isFoe(e) && this.up(e));
    // Taunted monsters go for whoever taunted them.
    const taunt = m.statuses.find((s) => s.id === 'taunted');
    const taunter = enemies.find((e) => e.id === taunt?.by);
    // Hidden heroes are ignored while anyone else is in the open.
    const visible = enemies.filter((e) => !hasStatus(e, 'hidden'));

    {
      const path = plan.path;
      for (const step of path.slice(0, this.acts(m)?.moves ?? m.speed)) {
        if (this.occupied(step.x, step.y, m.id)) break;
        const stopped = !ally && this.provokeSentinels(m, step);
        if (!this.entities.includes(m)) return diedMidTurn();
        if (stopped) break;
        this.face(m, step);
        m.x = step.x;
        m.y = step.y;
        this.watch(m);
        const stuck = this.standIn(m, 'step');
        this.broadcast();
        if (this.checkEnd()) return;
        if (!this.entities.includes(m)) return diedMidTurn();
        await sleep(MONSTER_STEP_MS);
        if (!ok()) return;
        if (stuck) break;
      }
      if (SKIP_TURN.some((id) => hasStatus(m, id))) return this.advanceTurn(); // stunned or frozen on the way
    }

    // Spells, shoves and shots at the ground replace the attacks (if they're still possible from where it ended up).
    const aimed = plan.target ? this.entity(plan.target) : undefined;
    if (plan.kind === 'flee') return this.advanceTurn();
    if ((plan.kind === 'heal' || plan.kind === 'buff') && aimed && this.entities.includes(aimed) && dist(m, aimed) <= def.range) {
      this.supportCast(m, aimed, plan.kind);
      return this.afterMonsterAct(m, token, ok, diedMidTurn);
    }
    if (plan.kind === 'shove' && aimed && this.up(aimed) && dist(m, aimed) === 1 && !(taunter && aimed !== taunter)) {
      this.monsterShove(m, aimed);
      return this.afterMonsterAct(m, token, ok, diedMidTurn);
    }
    if (plan.kind === 'ignite' && plan.tile && canHit(m, plan.tile) && !taunter) {
      this.groundShot(m, plan.tile);
      return this.afterMonsterAct(m, token, ok, diedMidTurn);
    }
    const trick = def.trick;
    if (plan.kind === 'trick' && trick && aimed && this.up(aimed) && !(m.trickCd ?? 0) && !(taunter && aimed !== taunter)) {
      if (dist(m, aimed) <= trick.range && (trick.range <= 1 || hasLOS(this, m, aimed))) {
        this.useTrick(m, aimed);
        return this.afterMonsterAct(m, token, ok, diedMidTurn);
      }
    }
    if (plan.kind === 'help' && aimed && this.up(aimed) && dist(m, aimed) === 1 && !(taunter && aimed !== taunter)) {
      this.help(m, aimed);
      return this.afterMonsterAct(m, token, ok, diedMidTurn);
    }

    const target = aimed && enemies.includes(aimed) ? aimed : undefined;
    const attacks = def.attacks + (hasTrait(m, 'enraged') && m.hp < m.maxHp / 2 ? 1 : 0);
    for (let i = 0; i < attacks; i++) {
      const victim =
        target && this.up(target) && canHit(m, target) && !(taunter && target !== taunter)
          ? target
          : ((taunter && this.up(taunter) && canHit(m, taunter) ? taunter : undefined) ??
            visible.find((e) => this.up(e) && canHit(m, e)) ??
            enemies.find((e) => this.up(e) && canHit(m, e)));
      if (!victim) break;
      this.monsterAttack(m, victim);
      this.broadcast();
      if (this.checkEnd()) return;
      if (!this.entities.includes(m)) return diedMidTurn();
      await sleep(450);
      if (!ok()) return;
    }
    this.advanceTurn();
  }

  /**
   * One monster (or NPC ally) attack, with the heroes' defensive tricks: Bodyguard steps in, Riposte strikes back.
   * Elite traits: an aura sets the element, Enraged hits harder, Vampiric drinks half of it.
   */
  private monsterAttack(m: MonsterEntity, victim: Entity) {
    const def = MONSTERS[m.type];
    let target = victim;
    // Bodyguard (Sentinel) and Intercept (Protection): a hero next to the victim takes the attack instead.
    const covers = (h: PlayerEntity): 'bodyguard' | 'intercept' | null => {
      if (h === victim || !this.standing(h) || hasStatus(h, 'surprised') || dist(h, victim) > 1) return null;
      if (hasBranch(h, 'sentinel', 'A') && !h.used.includes('round:bodyguard')) return 'bodyguard';
      const times = h.used.filter((u) => u === 'round:intercept').length;
      if (passiveOf(h, 'intercept') && times < (hasBranch(h, 'intercept', 'A') ? 2 : 1)) return 'intercept';
      return null;
    };
    const guard = isFoe(m) && !isFoe(victim) ? this.heroes().find((h) => covers(h)) : undefined; // a mad monster's friend gets no bodyguard
    const how = guard ? covers(guard) : null;
    if (guard) {
      guard.used.push(how === 'bodyguard' ? 'round:bodyguard' : 'round:intercept');
      this.addLog('info', `${how === 'bodyguard' ? '🛡️' : '🙅'} ${guard.name} throws themself in front of ${victim.name}!`);
      if (how === 'intercept') this.addBlock(guard, guard, passiveOf(guard, 'intercept')!.value);
      target = guard;
    }
    const at = { x: target.x, y: target.y };
    const element = auraOf(m) ?? def.element ?? 'physical';
    const enraged = hasTrait(m, 'enraged') && m.hp < m.maxHp / 2;
    const before = target.hp;
    const fury = stacksOf(m, 'fury');
    const furyDmg = Math.round((avgDice(def.dmg) + (m.dmgBonus ?? 0)) * BOSS.furyDmg * fury);
    const hit = this.attackRoll(m, target, {
      bonus: def.atk + (m.atkBonus ?? 0) + BOSS.furyAtk * fury, dmg: def.dmg, extra: (m.dmgBonus ?? 0) + furyDmg + (enraged ? ENRAGED_DMG : 0) - this.wasting(m), verb: def.verb, element,
    });
    // Spiked Pauldrons: melee hits on you hurt back.
    const thorns = hit && target.kind === 'player' && dist(m, target) <= 1 ? gearBonus(target, 'thorns') : 0;
    if (thorns && this.entities.includes(m)) {
      this.addLog('hit', `🦔 ${m.name} cuts itself on ${target.name}'s spikes: ${thorns}.`);
      this.damage(m, thorns, target, 'physical');
    }
    if (hit && hasTrait(m, 'vampiric') && this.entities.includes(m)) {
      const drained = Math.min(Math.ceil(Math.max(0, before - target.hp) / 2), m.maxHp - m.hp);
      if (drained > 0) {
        m.hp += drained;
        this.addLog('heal', `🩸 ${m.name} drinks ${drained} HP from the wound.`);
        this.float(m, `+${drained}`, '#c0392b');
      }
    }
    if (hit && def.rider && this.entities.includes(target) && this.up(target)) this.applyRider(m, target, def.rider);
    // Fire, cold and lightning attacks react with whatever the target stands in (a firebomb on oil...).
    const el = fieldElement(element);
    if (el) this.runField([{ kind: 'touch', tiles: [at.y * this.width + at.x], element: el }], m);
    if (!hit && target.kind === 'player' && hasStatus(target, 'riposte') && !hasStatus(target, 'surprised') && this.standing(target) && dist(m, target) <= 1 && this.entities.includes(m)) {
      this.addLog('info', `🤺 ${target.name} ripostes!`);
      this.freeStrike(target, m, 'Riposte', this.riposteBonus(target));
      this.afterCounter(target, m);
    }
    // Counterattack (Weapon Master): a melee miss gets hit back, once per round (twice with Relentless Counter).
    const counter = target.kind === 'player' ? passiveOf(target, 'counterattack') : null;
    if (!hit && counter && target.kind === 'player' && dist(m, target) <= 1 && this.standing(target) && !hasStatus(target, 'surprised') && this.entities.includes(m)) {
      const times = target.used.filter((u) => u === 'round:counter').length;
      const wall = passiveOf(target, 'blade_wall'); // Blade Wall: every miss
      if (wall || times < (hasBranch(target, 'counterattack', 'A') ? 2 : 1)) {
        target.used.push('round:counter');
        this.addLog('info', `🤺 ${target.name} counterattacks!`);
        const landed = this.freeStrike(target, m, 'Counterattack', counter.value + this.riposteBonus(target) + (hasBranch(target, 'blade_wall', 'A') ? 2 : 0));
        if (landed && hasBranch(target, 'counterattack', 'B') && this.entities.includes(m)) this.applyStatus(m, { id: 'dazed', turns: 1 }, target);
        this.afterCounter(target, m);
      }
    }
    // Retaliation (Protection): after taking a hit for a friend, hit back.
    if (how === 'intercept' && guard && hasBranch(guard, 'intercept', 'B') && this.standing(guard) && dist(m, guard) <= 1 && this.entities.includes(m)) {
      this.addLog('info', `⚔️ ${guard.name} retaliates!`);
      this.freeStrike(guard, m, 'Retaliation');
    }
  }

  /** Sentinel: heroes get a free swing at monsters walking out of their reach. Returns true if the monster is stopped. */
  private provokeSentinels(m: MonsterEntity, to: Pos): boolean {
    for (const h of this.heroes()) {
      const sentinel = passiveOf(h, 'sentinel');
      if (!sentinel || !this.standing(h) || hasStatus(h, 'surprised') || h.used.includes('round:sentinel')) continue;
      if (dist(h, m) > 1 || dist(h, to) <= 1) continue;
      h.used.push('round:sentinel');
      this.addLog('info', `👁️ ${h.name} punishes ${m.name} for leaving their reach!`);
      const hit = this.freeStrike(h, m, 'Sentinel');
      if (!this.entities.includes(m)) return true;
      if (hit && sentinel.tier >= 2) {
        this.addLog('info', `${m.name} is stopped in its tracks.`);
        return true;
      }
    }
    return false;
  }

  /**
   * Elite traits at the start of its turn: the Shielded ward re-forms once (on a 3rd round), and an aura hurts everyone on
   * the party's side next to it (and touches the ground around it: a Burning elite lights the oil it stands near).
   */
  private eliteTurnStart(m: MonsterEntity) {
    const round = this.turn?.round ?? 1;
    if (hasTrait(m, 'shielded') && round % WARD_EVERY === 0 && !m.wardBack) {
      const full = Math.round(m.maxHp * WARD_SHARE);
      if (!m.ward) {
        m.ward = full;
        m.wardBack = true;
        this.addLog('info', `🔰 ${m.name}'s ward re-forms (${full}).`);
        this.float(m, `🔰 ${full}`, '#8fd8ff');
      }
    }
    const aura = auraOf(m);
    if (!aura) return;
    const icon = m.traits?.map((t) => TRAITS[t]).find((t) => t.aura)?.icon ?? '';
    for (const e of this.entities.filter((x) => !isFoe(x) && this.up(x) && dist(x, m) <= 1)) {
      if (!this.up(e)) continue;
      const dmg = rollDice(AURA_DICE);
      this.addLog('hit', `${icon} ${e.name} is caught in ${m.name}'s aura: ${dmg} ${aura}.`);
      this.damage(e, dmg, m, aura, true);
    }
    const touch = fieldElement(aura);
    if (touch && this.entities.includes(m)) this.runField([{ kind: 'touch', tiles: tilesAround(this, m, 1), element: touch }], m);
  }

  /**
   * A boss's signature at the start of its turn (BOSS_SIGNATURES): Wrath has one 😡 Fury stack per round from round
   * furyFrom (it catches up after a stun), War Horn calls in its warband every callEvery rounds (never past a full room),
   * Rise Again stands up the minions that fell riseAfter rounds ago.
   */
  private bossClock(m: MonsterEntity) {
    const sig = MONSTERS[m.type]?.signature;
    if (sig === 'wrath') this.wrath(m);
    if (sig === 'horn') this.warHorn(m);
    if (sig === 'rise') this.riseAgain(m);
  }

  private wrath(m: MonsterEntity) {
    const round = this.turn?.round ?? 1;
    const fury = round - BOSS.furyFrom + 1;
    if (fury > stacksOf(m, 'fury')) {
      m.statuses = [...m.statuses.filter((s) => s.id !== 'fury'), { id: 'fury', turns: 99, power: fury }];
      this.addLog(
        'crit',
        fury === 1
          ? `😡 The fight drags on, and ${m.name} grows furious: +${BOSS.furyAtk} to hit and +${Math.round(BOSS.furyDmg * 100)}% damage, and more every round. Bring it down!`
          : `😡 ${m.name}'s fury grows (${fury}).`,
      );
      this.float(m, `😡 ${fury}`, '#ff6b6b');
    }
  }

  private warHorn(m: MonsterEntity) {
    const round = this.turn?.round ?? 1;
    if (round % BOSS.callEvery !== 0 || m.calledAt === round) return;
    m.calledAt = round;
    const act = ACTS[(this.run?.act ?? 1) - 1];
    const size = this.heroes().length;
    let called = 0;
    for (let i = 0; i < Math.max(1, Math.floor(size * BOSS.callPerHero)); i++) {
      if (this.monsters().length >= MAX_ROOM_MONSTERS) break;
      const spot = this.freeSpotNear(m);
      if (!spot) break;
      const minion = this.spawnMonster(pick(act.minions), spot, size);
      this.face(minion, this.heroes().find((h) => this.standing(h)) ?? m);
      this.float(minion, '📯', '#ffd84d');
      this.joinInitiative(minion);
      this.standIn(minion, 'appear');
      called++;
    }
    if (called) this.addLog('crit', `📯 ${m.name} blows a war horn, and more of its warband pours in!`);
  }

  /** Rise Again: the minions that fell at least riseAfter rounds ago get back up where they fell (or close by). */
  private riseAgain(m: MonsterEntity) {
    const round = this.turn?.round ?? 1;
    const size = this.heroes().length;
    const ready = this.fallen.filter((f) => f.at <= round);
    this.fallen = this.fallen.filter((f) => f.at > round);
    for (const f of ready) {
      if (this.monsters().length >= MAX_ROOM_MONSTERS) break;
      const spot = !this.occupied(f.x, f.y) && !isBlocked(this, f.x, f.y) ? { x: f.x, y: f.y } : this.freeSpotNear(f);
      if (!spot) continue;
      const back = this.spawnMonster(f.type, spot, size);
      back.risen = true;
      this.face(back, this.heroes().find((h) => this.standing(h)) ?? m);
      this.float(back, '🦴', '#c8d1dc');
      this.joinInitiative(back);
      this.standIn(back, 'appear');
      this.addLog('crit', `🦴 The ${back.name} claws its way back up! (${m.name} still stands.)`);
    }
  }

  /** Summoner: every other round the elite calls in one of its escorts (3 at most, never past a full room). */
  /** Raise Dead (a Hard necromancer): once a fight, after a friend has fallen, it stands one back up next to itself. */
  private raiseDead(m: MonsterEntity, type: string) {
    if (m.raised || !this.slain || this.monsters().length >= MAX_ROOM_MONSTERS) return;
    const spot = this.freeSpotNear(m);
    if (!spot) return;
    m.raised = true;
    const back = this.spawnMonster(type, spot, this.heroes().length);
    back.risen = true; // no XP the second time
    this.face(back, this.heroes().find((h) => this.standing(h)) ?? m);
    this.addLog('info', `🧟 ${m.name} raises the dead: a ${back.name} claws its way up!`);
    this.float(back, '🧟', '#9ad1a0');
    this.joinInitiative(back);
    this.standIn(back, 'appear');
  }

  private summon(m: MonsterEntity) {
    const round = this.turn?.round ?? 1;
    if (round % SUMMON_EVERY !== 0 || (m.summons ?? 0) >= MAX_SUMMONS || this.monsters().length >= MAX_ROOM_MONSTERS) return;
    const act = ACTS[(this.run?.act ?? 1) - 1];
    const spot = this.freeSpotNear(m);
    if (!spot) return;
    m.summons = (m.summons ?? 0) + 1;
    const minion = this.spawnMonster(pick(act.escorts[m.type] ?? act.pool), spot, this.heroes().length);
    this.face(minion, this.heroes().find((h) => this.standing(h)) ?? m);
    this.addLog('info', `📯 ${m.name} calls for help!`);
    this.float(minion, '📯', '#ffd84d');
    this.joinInitiative(minion);
    this.standIn(minion, 'appear');
  }

  /**
   * What a monster sees: the room, who its pack hunts, and who acts when. The squad director (server/monsterai.ts) picks
   * or keeps the packs' targets, one per pack (more packs against bigger parties), and a new target gets called out with
   * a bark; then the monster plans its turn around its pack's target. The NPC allies pick one target of their own. On
   * Story there's no squad: every monster goes for whoever is closest.
   */
  private monsterView(m: MonsterEntity): MonsterView {
    const t = this.turn!;
    const brain = m.ally ? null : this.learnedBrain();
    let focus: string | null = null;
    let assign: Record<string, string> | undefined;
    if (DIFFICULTIES[this.diff].squad && m.ally) {
      const before = t.allyFocus ?? null;
      focus = t.allyFocus = squadFocus(this.entities, 'allies', before);
      if (focus && focus !== before) this.bark(m, 'focus', this.entity(focus));
    } else if (DIFFICULTIES[this.diff].squad || brain) {
      const before = t.focus ?? [];
      const squad = squadPlan(this.entities, before);
      t.focus = squad.targets;
      assign = squad.assign;
      focus = squad.assign[m.id] ?? squad.targets[0] ?? null;
      const fresh = squad.targets.find((id) => !before.includes(id));
      if (fresh) {
        this.bark(m, 'focus', this.entity(fresh));
        this.callout(this.entity(fresh), 'hunted'); // a bot hears it's the target
      }
    }
    const i = Math.max(0, t.order.indexOf(m.id));
    const order = [...t.order.slice(i), ...t.order.slice(0, i)];
    return { me: m, map: this, entities: this.entities, moves: this.acts(m)?.moves ?? m.speed, difficulty: this.diff, focus, rand: () => rng.next(), round: t.round, order, assign };
  }

  private async monsterPlan(m: MonsterEntity, view = this.monsterView(m)): Promise<MonsterPlan> {
    const brain = m.ally ? null : this.learnedBrain();
    if (!brain) return planMonster(view);
    // The learned policy (or the trainer) picks from the same options the scripted AI weighs.
    const choices = monsterChoices(view);
    if (choices.forced) return choices.forced;
    const i = await brain(m, choices);
    return (choices.options[i] ?? choices.options[0]).plan;
  }

  /** Who decides for the monsters instead of the scripted AI: the trainer, or the PPO policy if the run picked it. */
  private learnedBrain(): MonsterBrain | null {
    if (this.monsterBrain) return this.monsterBrain;
    const policy = this.monsterAiNow === 'ppo' ? monsterPolicy() : null;
    return policy && ((_m, c) => policy.pick(c.options.map((o) => o.features)));
  }

  /** After a spell, shove or shot at the ground: the fight may be over, or the monster gone. */
  private async afterMonsterAct(m: MonsterEntity, token: number, ok: () => boolean, diedMidTurn: () => void) {
    this.broadcast();
    if (this.checkEnd()) return;
    if (!this.entities.includes(m)) return diedMidTurn();
    await sleep(450);
    if (ok()) this.advanceTurn();
  }

  /** A monster's bark in the log (server/barks.ts). */
  private bark(m: MonsterEntity, ev: BarkEvent, target?: Entity) {
    if (rng.next() >= BARK_ODDS[ev]) return;
    const line = barkLine(m, ev, target, rng.next());
    if (line) this.addLog('say', line);
  }

  /**
   * A bot hero's callout in the log (server/companions.ts), worded like a person's chat line. Only real bots talk,
   * not people who switched on auto-play. `beat` is the round, unless the callout is for the fight's start or end.
   */
  private callout(who: Entity | undefined, ev: CallEvent, vars: CallVars = {}, beat?: string) {
    if (who?.kind !== 'player' || this.phase !== 'combat' || !this.standing(who)) return;
    const info = this.players.find((p) => p.id === who.playerId);
    if (!info?.bot) return;
    const text = calloutLine(info.name, ev, vars, rng.next());
    if (text && tryCallout(this.chatter, who.id, ev, beat ?? `r${this.turn?.round ?? 0}`, rng.next())) this.addLog('chat', `${info.name}: ${text}`);
  }

  /** A random bot hero still on their feet (not `not`): the one who speaks up for the party. */
  private randomBot(not?: Entity): PlayerEntity | undefined {
    const bots = this.heroes().filter((h) => h !== not && this.standing(h) && this.players.find((p) => p.id === h.playerId)?.bot);
    return bots.length ? pick(bots) : undefined;
  }

  /** A support's spell (shared/rules.ts `support`): mend a friend (a downed hero, for the Acolyte) or buff one. */
  private supportCast(m: MonsterEntity, f: Entity, kind: 'heal' | 'buff') {
    const sup = MONSTERS[m.type].support;
    if (!sup) return;
    this.face(m, f);
    this.bark(m, kind, f);
    if (kind === 'heal') {
      this.shot(m, f, '#7ddc6f');
      const amount = rollDice(sup.heal) + (m.ally ? (this.run?.act ?? 1) - 1 : 0); // NPC allies grow with the act
      const healed = f.kind === 'player' ? this.healBy(null, f, amount, false, true) : this.healMonster(f, amount);
      this.addLog('heal', `${m.glyph} ${m.name} heals ${f.name}: +${healed} HP.`);
      if (healed > 0) this.callout(f, 'healed', { ally: m.name });
    } else {
      this.shot(m, f, '#ffd84d');
      this.applyStatus(f, sup.buff, m);
      const verb = sup.buff.id === 'shielded' ? 'wards' : sup.buff.id === 'rallied' ? 'rallies' : 'blesses';
      this.addLog('info', `${m.glyph} ${m.name} ${verb} ${f.name} (${STATUSES[sup.buff.id].name}).`);
    }
  }

  /** A leader's shout (shared/rules.ts ORDERS): its side within 8 tiles charges or holds, or everyone goes for one enemy. */
  private giveOrder(m: MonsterEntity, o: MonsterOrder) {
    const def = ORDERS[o.id];
    m.orderCd = ORDER_EVERY;
    const target = o.target ? this.entity(o.target) : undefined;
    this.addLog('say', `${m.glyph} ${m.name}: "${o.id === 'kill' && target ? `Kill ${target.name}!` : def.name}"`);
    this.float(m, `${def.icon} ${def.name}`, '#ff8a5c');
    if (o.id === 'kill') {
      if (!target) return;
      this.face(m, target);
      for (const st of ORDER_STATUS.kill) this.applyStatus(target, st, m);
      if (target.kind === 'player') this.callout(target, 'hunted');
      return;
    }
    const squad = this.entities.filter((e) => e.kind === 'monster' && sameSide(e, m) && dist(e, m) <= ORDER_RANGE);
    for (const f of squad) for (const st of ORDER_STATUS[o.id]) this.applyStatus(f, st, m);
  }

  /** A monster's trick (shared/rules.ts MonsterTrick): a net, a web, a brand... a save, or an attack roll without one. */
  private useTrick(m: MonsterEntity, t: Entity) {
    const trick = MONSTERS[m.type].trick!;
    m.trickCd = trick.cooldown;
    this.face(m, t);
    if (dist(m, t) > 1) this.shot(m, t, '#c8b6ff');
    const what = `${trick.icon} ${m.name} ${trick.verb} ${t.name}`;
    let landed: boolean;
    if (trick.save) {
      const dc = trick.dc ?? 12;
      const sv = this.creatureSave(t, trick.save);
      landed = sv.total < dc;
      this.addLog(landed ? 'hit' : 'miss', `${what}: ${trick.save.toUpperCase()} save ${sv.text} vs DC ${dc}, ${landed ? 'failed' : 'saved'}.`);
    } else {
      const why = attackAdvantage(m, t, this.entities);
      const net = netAdvantage(why);
      const r1 = rollDie(20);
      const r2 = rollDie(20);
      const d20 = net > 0 ? Math.max(r1, r2) : net < 0 ? Math.min(r1, r2) : r1;
      const bonus = MONSTERS[m.type].atk + (m.atkBonus ?? 0) + (hasStatus(m, 'blessed') ? 2 : 0) - (hasStatus(m, 'dazed') ? 2 : 0) + this.rallyOf(m) + BOSS.furyAtk * stacksOf(m, 'fury');
      const cover = coverFrom(this, m, t);
      const ac = this.acOf(t) + cover;
      landed = d20 === 20 || (d20 !== 1 && d20 + bonus >= ac);
      if (why.adv.includes('distracted')) t.statuses = t.statuses.filter((s) => s.id !== 'distracted');
      const rolled = net ? `🎲${r1}|${r2}→${d20}` : `🎲${d20}`;
      this.addLog(landed ? 'hit' : 'miss', `${what}: ${rolled}${fmtMod(bonus)}=${d20 + bonus} vs AC ${ac}${cover ? ` (${coverWord(cover)})` : ''}, ${landed ? 'hit' : 'miss'}.`);
    }
    if (!landed) {
      this.float(t, 'dodged', '#9aa0a6');
      return;
    }
    for (const st of trick.status) this.applyStatus(t, st, m);
  }

  /** Help: it gets in an enemy's face, and the next attack against them (from its side) has advantage. */
  private help(m: MonsterEntity, t: Entity) {
    this.face(m, t);
    this.applyStatus(t, HELP, m);
    this.addLog('info', `👉 ${m.name} gets in ${t.name}'s face: the next attack against ${t.name} has advantage.`);
  }

  /** What a monster's hit does on top of the damage: a Wolf drags you down, a Wight drains your life. */
  private applyRider(m: MonsterEntity, t: Entity, rider: MonsterRider) {
    if (rider.status.id === 'drained' && t.kind !== 'player') return;
    if (hasStatus(t, rider.status.id) && !rider.status.stack) return;
    let save = '';
    if (rider.save) {
      const dc = rider.dc ?? 12;
      const sv = this.creatureSave(t, rider.save);
      if (sv.total >= dc) return;
      save = ` (${rider.save.toUpperCase()} save ${sv.text} vs DC ${dc})`;
    }
    this.applyStatus(t, rider.status, m);
    this.addLog('hit', `${STATUSES[rider.status.id].icon} ${m.name} ${rider.text.replace('{target}', t.name)}${save}.`);
  }

  /** Rallied stacks: +1 to attack rolls and damage each. */
  private rallyOf(e: Entity): number {
    return e.statuses.find((s) => s.id === 'rallied')?.power ?? 0;
  }

  /** Extra movement this turn (a dash). Stuck in a net or a web, it's held back until it gets free. */
  private addMoves(e: Entity, n: number) {
    const a = this.acts(e);
    if (!a) return;
    if (ROOTED.some((id) => hasStatus(e, id))) a.held = (a.held ?? 0) + n;
    else {
      a.moves += n;
      if (a.budget !== undefined) a.budget += n;
    }
  }

  /** Out of a net or a web: on its own turn it gets its held-back movement. */
  private unrooted(e: Entity) {
    if (ROOTED.some((id) => hasStatus(e, id))) return;
    const a = this.acts(e);
    if (a?.held) {
      a.moves += a.held;
      a.held = 0;
      this.endStretch(e);
    }
  }

  /** Heals a monster or NPC ally, up to its max. Returns how much. */
  private healMonster(f: MonsterEntity, amount: number): number {
    const healed = Math.max(0, Math.min(amount, f.maxHp - f.hp));
    f.hp += healed;
    if (healed > 0) this.float(f, `+${healed}`, '#7ddc6f');
    return healed;
  }

  /** A brute shoves someone, into a hazard if it can: a STR contest like the heroes' Shove (win by 5: two tiles). */
  private monsterShove(m: MonsterEntity, t: Entity) {
    const str = MONSTERS[m.type].str;
    this.bark(m, 'shove', t);
    this.face(m, t);
    const mine = rollDie(20);
    const theirs = rollDie(20);
    const resist = shoveResist(t);
    const margin = mine + str - (theirs + resist);
    const roll = `🎲${mine}${fmtMod(str)}=${mine + str} vs 🎲${theirs}${fmtMod(resist)}=${theirs + resist}`;
    if (margin < 0) {
      this.addLog('miss', `${m.name} tries to shove ${t.name} (${roll}) but they hold their ground.`);
      this.float(t, 'holds', '#9aa0a6');
      return;
    }
    this.addLog('hit', `✋ ${m.name} shoves ${t.name} (${roll})!`);
    this.push(t, m, margin >= 5 ? 2 : 1);
  }

  /** A monster aims its element at the ground: fire on the oil around the party, cold or lightning on their water. */
  private groundShot(m: MonsterEntity, tile: Pos) {
    const element = elementOf(m);
    const el = fieldElement(element);
    if (!el) return;
    this.bark(m, 'ignite');
    this.face(m, tile);
    this.shot(m, tile, ELEMENT_COLOR[element]);
    this.addLog('info', `${m.glyph} ${m.name} ${MONSTERS[m.type].verb} the ground!`);
    this.runField([{ kind: 'touch', tiles: [tile.y * this.width + tile.x], element: el }], m);
  }

  private breathWeapon(m: MonsterEntity, victims: Entity[]) {
    this.addLog('crit', `🔥 ${m.name} unleashes a torrent of fire!`);
    for (const p of victims) {
      const { total: save, text } = this.creatureSave(p, 'dex');
      const saved = save >= BREATH_DC;
      let dmg = Math.round(rollDice({ n: 3, d: 6 }) * (actScaling(this.run?.act ?? 1).dmg + BOSS.furyDmg * stacksOf(m, 'fury')));
      const evasion = p.kind === 'player' && hasBranch(p, 'opportunist', 'B');
      if (saved) dmg = evasion ? 0 : Math.floor(dmg / 2);
      else if (evasion) dmg = Math.floor(dmg / 2);
      this.shot(m, p, '#ff7b2e');
      this.addLog(saved ? 'miss' : 'hit', `${p.name} DEX save ${text} vs DC ${BREATH_DC}: ${saved ? (evasion ? 'evades it completely' : 'half damage') : 'fails'}, ${dmg} fire.`);
      if (dmg > 0) this.damage(p, dmg, m, 'fire', true);
    }
    this.runField([{ kind: 'touch', tiles: victims.map((p) => p.y * this.width + p.x), element: 'fire' }], m);
  }

  /** Any creature's saving throw: heroes add their passives and gear, monsters and NPC allies use their stat block. */
  private creatureSave(e: Entity, stat: Stat): { total: number; text: string } {
    if (e.kind === 'player') return this.heroSave(e, stat);
    const d20 = rollDie(20);
    const bonus = monsterSave(MONSTERS[e.type], stat);
    return { total: d20 + bonus, text: `🎲${d20}${fmtMod(bonus)}=${d20 + bonus}` };
  }

  /** A hero's saving throw: d20 + stat + Steady + Bless; Fortune rerolls a natural 1. */
  private heroSave(p: PlayerEntity, stat: Stat): { total: number; text: string } {
    let d20 = rollDie(20);
    if (d20 === 1 && this.useLucky(p, true)) d20 = rollDie(20);
    const bonus = statMod(p, stat) + (passiveOf(p, 'steady')?.value ?? 0) + (hasStatus(p, 'blessed') ? 2 : 0) + gearBonus(p, 'saves') + this.auraBonus(p);
    return { total: d20 + bonus, text: `🎲${d20}${fmtMod(bonus)}=${d20 + bonus}` };
  }

  /** Aura of Protection: the best Paladin aura a hero stands in (2 tiles, or 4 with Wide Aura), the Paladin included. */
  private auraBonus(p: PlayerEntity): number {
    let best = 0;
    for (const h of this.heroes()) {
      const aura = passiveOf(h, 'aura_of_protection');
      if (aura && this.standing(h) && dist(h, p) <= (hasBranch(h, 'aura_of_protection', 'B') ? 4 : 2)) best = Math.max(best, aura.value);
    }
    return best;
  }

  /** Spends a Lucky reroll if the hero has one left (Lucky Charms count for attacks). `save`: Fortune also covers saves. */
  private useLucky(p: PlayerEntity, save = false): boolean {
    const lucky = passiveOf(p, 'lucky');
    const allowed = save ? (hasBranch(p, 'lucky', 'A') ? (lucky?.value ?? 0) : 0) : (lucky?.value ?? 0) + gearBonus(p, 'lucky');
    if (p.used.filter((u) => u === 'fight:lucky').length >= allowed) return false;
    p.used.push('fight:lucky');
    this.addLog('info', `🍀 ${p.name} gets lucky and rerolls the natural 1!`);
    return true;
  }

  // ------------------------------------------------------------ hero skills

  /** Uses a skill if it's allowed right now. Returns true if it happened (the auto-play loop needs to know). */
  handleSkill(playerId: string, skillId: unknown, aim: unknown): boolean {
    const p = this.hero(playerId);
    if (!p || !isSkillId(skillId)) return false;
    if (!['map', 'event', 'rest', 'shop', 'combat'].includes(this.phase)) return false;
    const inCombat = this.phase === 'combat';
    const reason = skillBlockReason(p, skillId, inCombat, this.turn ? this.view(p) : null, this.acting(p));
    if (reason) {
      this.whisper(playerId, reason);
      return false;
    }
    const own = ownedSkill(p, skillId)!;
    const s = statsOf(own);
    const target =
      typeof aim === 'string' ? aim : aim && typeof aim === 'object' ? { x: Number((aim as Pos).x), y: Number((aim as Pos).y) } : undefined;
    const res = resolveAim(s, p, target, { map: this, entities: this.entities, inCombat });
    if (typeof res === 'string') {
      this.whisper(playerId, res);
      return false;
    }

    this.cancelWalk(p.id);
    const kind = SKILLS[skillId].kind;
    // Before anything changes: who was low (Saint) and who still had your Inspiration (Standing Ovation).
    const lowBefore = res.friends.map((f) => f.hp / f.maxHp);
    const acts = inCombat ? this.acts(p) : undefined;
    if (acts) {
      const ap = apOf(p, skillId, s);
      acts.ap -= ap;
      this.endStretch(p); // acting fixes where you stand: movement counts from here again
      if (skillId === 'shove' && ap === 0) p.used.push('turn:free-shove'); // Pile Driver
      if (s.oncePerTurn) p.used.push(`turn:${skillId}`);
      const blood = hpCostOf(p, s);
      if (blood > 0) {
        p.hp = Math.max(1, p.hp - blood);
        this.float(p, `-${blood}`, '#ff6b6b');
        this.addLog('hit', `${s.icon} ${p.name} pays ${blood} HP in blood.`);
      }
    }
    if (kind === 'spell') p.slots -= slotCost(s);
    if (kind === 'cantrip') own.cd = (s.cooldown ?? 0) + 1; // ticks down at the start of each of your turns
    if (skillId === 'potion') p.potions--;
    else if (kind === 'item') p.bag.splice(p.bag.indexOf(skillId as ItemId), 1); // used up
    this.casting = { id: skillId, s };
    this.unleashedOn.clear();
    try {
      this.useSkill(p, own, s, res);
    } finally {
      this.casting = null;
    }
    if (inCombat) this.afterCast(p, own, s, res, lowBefore);
    if (inCombat) this.checkEnd();
    else this.checkpoint(); // a potion or heal between rooms
    this.broadcast();
    return true;
  }

  /** Runs a skill's effects in the order documented on SkillStats. */
  private useSkill(p: PlayerEntity, own: OwnedSkill, s: SkillStats, res: AimResult) {
    const name = skillTitle(own);
    const color = ELEMENT_COLOR[s.element ?? 'physical'];
    const basic = SKILLS[own.id].kind === 'basic';
    const inCombat = this.phase === 'combat';
    // What it does to the battlefield, from where everyone stands now; it happens after the hits.
    const fieldOps = inCombat ? aimFieldOps(s, p, res, this) : [];
    // Monsters it kills burst (poison, fire) only after its own effect, so a Fire Bolt kill doesn't set off the poison.
    const outer = this.deferredBursts === null;
    if (outer) this.deferredBursts = [];
    const singleRoll = (s.target === 'enemy' && !!s.roll && res.prop === undefined) || (s.target === 'ally' && !!s.heal);
    if (res.prop !== undefined) {
      const prop = this.props[res.prop];
      const at = tilePos(this, res.prop);
      this.addLog('info', `${s.icon} ${p.name} hits the ${prop ? PROPS[prop].name : 'barrel'} with ${name}!`);
      if (dist(p, at) > 1) this.shot(p, at, color);
    } else if (!singleRoll && !(s.target === 'self' && s.heal)) {
      const on = res.main && s.target !== 'area' ? ` on ${res.main.name}` : '';
      this.addLog('info', `${s.icon} ${p.name} uses ${name}${on}!`);
    }

    // Movement tricks first.
    if (s.teleport && res.main) this.teleportNextTo(p, res.main);
    if (s.pull) this.pullFoes(p, res.foes, s.pull);
    if (s.target === 'enemy' || s.target === 'area') this.face(p, res.center);
    if (s.target === 'area' || s.target === 'around') {
      this.fx.push({ kind: 'burst', x: res.center.x, y: res.center.y, radius: s.radius ?? 1, color });
    }

    // Foes: roll, damage, then statuses and knockback on whoever got hit. Area attacks hit heroes in the blast too.
    const strikeOne = (f: Entity) => {
      if (!this.entities.includes(f) || (f.kind === 'player' && !this.standing(f))) return; // died to an earlier hit
      let landed = false;
      if (!s.roll) landed = true;
      else if (s.roll === 'auto') landed = this.autoHit(p, f, s, name, color);
      else if (s.roll === 'contest') landed = f.kind === 'monster' && this.contestHit(p, f, s, name);
      else {
        for (let i = 0; i < hitsOf(p, s) && this.entities.includes(f) && !(f.kind === 'player' && !this.standing(f)); i++) {
          const hit =
            s.roll === 'save' ? this.saveHit(p, f, s, name, color, atEdge(s, res.center, f), s.target === 'area' ? res.center : p) : this.weaponHit(p, f, s, name, color, basic);
          landed ||= hit;
        }
      }
      if (!landed || !this.entities.includes(f) || (f.kind === 'player' && !this.standing(f))) return;
      for (const st of s.onHit ?? []) this.applyStatus(f, st, p);
      if (s.poisonMult) this.multiplyPoison(p, f, s.poisonMult);
      if (s.push && s.roll !== 'contest') this.push(f, s.target === 'area' && (f.x !== res.center.x || f.y !== res.center.y) ? res.center : p, s.push, p);
    };
    for (const f of res.foes) strikeOne(f);
    if (own.id === 'quick_shot' && inCombat) this.splitShot(p, s, name, color, res.main);
    if (s.trap && inCombat) this.setTraps(p, s, res.center);
    if (s.raise && inCombat) this.raiseGround(p, s, res);
    if (s.rubble && inCombat) this.rubble(res.center, s.radius ?? 1, s.rubble);
    const caught = (res.caught ?? []).filter((h) => this.up(h));
    if (caught.length) {
      const who = caught.map((h) => (h === p ? `${p.name} themself` : h.name)).join(', ');
      this.addLog('miss', `⚠️ Friendly fire! ${who} ${caught.length > 1 ? 'are' : 'is'} caught in the ${name}.`);
      for (const h of caught) strikeOne(h);
    }

    // Friends: heals, temporary HP, cleansing and buffs.
    let healedAll = 0;
    const verses = stacksOf(p, 'verse');
    for (const fr of res.friends) {
      if (s.finale && verses > 0) this.finale(p, fr, s.finale, verses);
      const ovation = own.id === 'inspiration' && fr.statuses.some((x) => x.id === 'focused' && x.by === p.id); // Standing Ovation
      if (s.heal) {
        const drink = SKILLS[own.id].kind === 'item' && this.hasRelic('alchemist_kit') ? 1.5 : 1; // Alchemist's Kit
        const saint = own.id === 'lay_on_hands' ? (passiveOf(p, 'saint')?.value ?? 0) : 0; // Saint: +4 on Lay on Hands
        const amount = Math.round((rollDice({ n: s.heal.n, d: s.heal.d }) + healBonus(p, s) + saint) * drink);
        const healed = this.healBy(p, fr, amount, s.overheal, !s.noRevive);
        if (fr !== p) healedAll += healed;
        const line =
          s.target === 'self'
            ? `${p.name} uses ${name}`
            : singleRoll
              ? `${p.name} uses ${name} on ${fr === p ? 'themself' : fr.name}`
              : `${fr.name} is healed`;
        this.addLog('heal', `${s.icon} ${line}: +${healed} HP.`);
      }
      if (s.helpUp) this.helpUp(p, fr);
      if (s.tempHp) fr.tempHp = Math.max(fr.tempHp, rollDice(s.tempHp));
      if (s.block && this.standing(fr)) this.blockFrom(p, fr, s.block, s.blockLevel);
      if (s.cleanse) fr.statuses = fr.statuses.filter((x) => !CLEANSED.includes(x.id));
      if (s.frees) fr.statuses = fr.statuses.filter((x) => !ROOTED.includes(x.id));
      if (s.cleanse || s.frees) this.unrooted(fr);
      for (const st of s.status ?? []) this.applyStatus(fr, st, p);
      if ((s.status?.length || s.block) && fr !== p) this.grantXp(p, XP_BUFF);
      if (inCombat && this.standing(fr)) this.hurry(p, fr, own.id, s);
      if (inCombat && this.standing(fr) && own.id === 'inspiration') this.inspire(p, fr, ovation);
    }
    if (s.healSelf && healedAll > 0) {
      const back = this.healBy(p, p, Math.floor(healedAll * s.healSelf));
      if (back) this.addLog('heal', `${s.icon} The light flows back into ${p.name}: +${back} HP.`);
    }

    // You. Any move against the enemy gives a hidden hero away (Smoke Bomb hides you again right after).
    if (s.target === 'enemy' || s.target === 'area' || s.target === 'around') p.statuses = p.statuses.filter((x) => x.id !== 'hidden');
    for (const st of s.selfStatus ?? []) this.applyStatus(p, st, p);
    if (s.selfBlock) this.blockFrom(p, p, s.selfBlock, s.blockLevel);
    if (s.doubleBlock && p.block?.[p.id]) {
      const more = p.block[p.id];
      this.addBlock(p, p, more);
      this.addLog('info', `🏯 ${p.name} digs in: ${p.block[p.id]} Block.`);
    }
    if (s.taunt) {
      const taunted = this.monsters().filter((m) => dist(m, p) <= s.taunt!.radius);
      for (const m of taunted) this.applyStatus(m, { id: 'taunted', turns: s.taunt.turns }, p);
      if (taunted.length) this.addLog('info', `😤 ${taunted.map((m) => m.name).join(', ')} can't take their eyes off ${p.name}.`);
    }
    const mine = this.phase === 'combat' ? this.acts(p) : undefined;
    if (mine) {
      if (s.dash) this.addMoves(p, s.dash);
      if (s.gainAp) {
        mine.ap += s.gainAp;
        p.used.push('turn:surge');
      }
    }
    if (s.resetCooldowns) for (const o of p.skills) if (o !== own) o.cd = 0;
    if (s.restoreSlots) {
      const back = Math.min(s.restoreSlots, p.maxSlots - p.slots);
      p.slots += back;
      this.addLog('heal', `${s.icon} ${p.name} drinks the ${name}: ${back ? `+${back} ${CLASSES[p.classId].names.slots}` : 'nothing to restore'}.`);
    }

    // The battlefield: the element reacts with the tiles it reached, then the skill's surface appears.
    if (inCombat) {
      this.runField(fieldOps, p);
      this.runField(selfFieldOps(s, p, this), p);
    }
    if (outer) {
      const bursts = this.deferredBursts ?? [];
      this.deferredBursts = null;
      for (const b of bursts) this.runField(b.ops, b.by);
    }
  }

  /** An attack-roll skill against one foe. */
  private weaponHit(p: PlayerEntity, f: Entity, s: SkillStats, name: string, color: string, basic: boolean): boolean {
    if (dist(p, f) > 1) this.shot(p, f, color);
    return this.attackRoll(p, f, {
      bonus: attackBonus(p, s), dmg: s.dmg ?? { n: 1, d: 4 }, extra: damageMod(p, s) + (basic ? this.weaponDamage(p) : 0), verb: 'attacks', weapon: name,
      element: s.element ?? 'physical', adv: s.adv, sneak: s.sneak, execute: s.execute, critFull: s.critFull, basic,
    });
  }

  /** A saving-throw skill against one creature (a hero, if caught in friendly fire). Returns true if it failed the save. */
  /**
   * A save against a hero's skill. `edge`: on the outer ring of a blast with falloff (Fireball), half damage. `origin`:
   * where it comes from (the caster, or the blast's center), for cover on a DEX save.
   */
  private saveHit(p: PlayerEntity, f: Entity, s: SkillStats, name: string, color: string, edge = false, origin: Pos = p): boolean {
    const save = s.save ?? 'dex';
    const { total, text: rolled } = this.creatureSave(f, save);
    const cover = save === 'dex' ? coverFrom(this, origin, f) : 0;
    const dc = heroDc(p);
    const saved = total + cover >= dc;
    this.shot(p, f, color);
    let dmg = s.dmg ? rollDice(s.dmg) + damageMod(p, s) + this.bonusDamage(p, f, s.element ?? 'physical') : 0;
    if (edge) dmg = Math.floor(dmg / 2);
    dmg = Math.round(dmg * this.damageScale(p, f));
    const evasion = f.kind === 'player' && s.target === 'area' && hasBranch(f, 'opportunist', 'B');
    if (saved) dmg = s.half && !evasion ? Math.floor(dmg / 2) : 0;
    else if (evasion) dmg = Math.floor(dmg / 2);
    const roll = `${save.toUpperCase()} save ${rolled}${cover ? ` +${cover} ${coverWord(cover)}` : ''} vs DC ${dc}${edge ? ', edge of the blast' : ''}`;
    this.addLog(saved ? 'miss' : 'hit', `${f.name} ${saved ? 'resists' : 'is caught by'} ${p.name}'s ${name} (${roll})${dmg ? `: ${dmg}${elementWord(s.element)}` : ''}.`);
    if (dmg > 0) this.damage(f, dmg, p, s.element ?? 'physical', s.target === 'area');
    else if (saved) this.float(f, 'saved', '#9aa0a6');
    if (!saved && this.entities.includes(f)) this.afterHit(p, f, s.element ?? 'physical', false);
    return !saved;
  }

  /** Never misses (Magic Missile): every dart in one go. */
  private autoHit(p: PlayerEntity, f: Entity, s: SkillStats, name: string, color: string): boolean {
    const hits = hitsOf(p, s);
    let total = 0;
    for (let i = 0; i < hits; i++) total += rollDice(s.dmg ?? { n: 1, d: 4 }) + damageMod(p, s) + this.bonusDamage(p, f, s.element ?? 'physical');
    total = Math.round(total * this.damageScale(p, f));
    this.shot(p, f, color);
    this.addLog('hit', `${p.name}'s ${name}: ${hits} hit${hits > 1 ? 's' : ''} strike ${f.name} for ${total}${elementWord(s.element)}.`);
    this.damage(f, total, p, s.element ?? 'physical');
    if (this.entities.includes(f)) this.afterHit(p, f, s.element ?? 'physical', false);
    return true;
  }

  /** Shove: your stat + proficiency against the target's best of STR and DEX. Win by 5+ and it flies further. */
  private contestHit(p: PlayerEntity, f: MonsterEntity, s: SkillStats, name: string): boolean {
    const def = MONSTERS[f.type];
    const mine = rollDie(20);
    const theirs = rollDie(20);
    const bonus = attackBonus(p, s) + gearBonus(p, 'shove');
    const resist = Math.max(def.str, def.dex);
    const margin = mine + bonus - (theirs + resist);
    const roll = `🎲${mine}${fmtMod(bonus)}=${mine + bonus} vs 🎲${theirs}${fmtMod(resist)}=${theirs + resist}`;
    if (margin < 0) {
      this.addLog('miss', `${p.name} tries to ${name.toLowerCase()} ${f.name} (${roll}) but it holds its ground.`);
      this.float(f, 'holds', '#9aa0a6');
      return false;
    }
    this.addLog('hit', `${p.name} ${name.toLowerCase()}s ${f.name} (${roll})!`);
    const further = (gearBonus(p, 'shove') > 0 ? 1 : 0) + (this.hasRelic('lodestone') ? 1 : 0); // Ogre Gauntlets, Lodestone
    this.push(f, p, (s.push ?? 1) + (margin >= 5 ? 1 : 0) + further, p);
    // Pile Driver: a won Shove also knocks it down (Body Slam hurts, Ground and Pound dazes).
    const driver = passiveOf(p, 'pile_driver');
    if (driver && this.entities.includes(f)) {
      this.applyStatus(f, { id: 'prone', turns: 1 }, p);
      if (hasBranch(p, 'pile_driver', 'A')) this.damage(f, this.weaponRoll(p), p, 'physical');
      if (hasBranch(p, 'pile_driver', 'B')) this.applyStatus(f, { id: 'dazed', turns: 1 }, p);
    }
    return true;
  }

  /** A free basic attack outside the normal action economy (Sentinel, Riposte, Cleave). */
  private freeStrike(p: PlayerEntity, t: Entity, label: string, bonus = 0): boolean {
    const basic = p.skills.find((o) => SKILLS[o.id].kind === 'basic' && statsOf(o).range <= 1) ?? p.skills.find((o) => SKILLS[o.id].kind === 'basic');
    const s = basic ? statsOf(basic) : statsAt('longsword');
    return this.attackRoll(p, t, {
      bonus: attackBonus(p, s), dmg: s.dmg ?? { n: 1, d: 6 }, extra: damageMod(p, s) + this.weaponDamage(p) + bonus, verb: 'strikes', weapon: label,
      element: s.element ?? 'physical', sneak: s.sneak, basic: true,
    });
  }

  /** Flat damage that basic weapon attacks get from equipment and the Whetstone. */
  private weaponDamage(p: PlayerEntity): number {
    return gearBonus(p, 'dmg') + (this.hasRelic('whetstone') ? 1 : 0);
  }

  /** A magic weapon's extra: elemental dice (which react with the ground like any element) and on-hit statuses. */
  private weaponExtras(p: PlayerEntity, t: Entity, crit: boolean) {
    const { weapon, onHit } = weaponExtras(p);
    const name = p.gear.weapon ? itemInfo(p.gear.weapon).name : 'weapon';
    if (weapon && this.entities.includes(t)) {
      const dmg = rollDice(weapon.dice, crit);
      this.addLog('hit', `${itemInfo(p.gear.weapon!).icon} The ${name} adds ${dmg} ${weapon.element}.`);
      const at = t.y * this.width + t.x;
      this.damage(t, dmg, p, weapon.element);
      const el = fieldElement(weapon.element);
      if (el) this.runField([{ kind: 'touch', tiles: [at], element: el }], p);
    }
    for (const st of onHit) if (this.entities.includes(t)) this.applyStatus(t, st, p);
  }

  /** Steps next to the target, on its far side if there's room (behind it). */
  /**
   * After a cast, in a fight: stacks get spent or gained. The `per` and Finale stacks are used up, Unleash turns
   * Arcane Charges into the next spell's dice (and a spell uses them), spells build Arcane Charge and Verses, and the
   * cooldown tricks (Saint, Standing Ovation) kick in.
   */
  private afterCast(p: PlayerEntity, own: OwnedSkill, s: SkillStats, res: AimResult, lowBefore: number[]) {
    const kind = SKILLS[own.id].kind;
    const spend = (id: StatusId) => (p.statuses = p.statuses.filter((x) => x.id !== id));
    if (s.per?.spend) {
      if (s.per.of === 'focus') spend('aiming');
      if (s.per.of === 'radiance') for (const f of res.foes) f.statuses = f.statuses.filter((x) => x.id !== 'seared');
    }
    if (s.finale || (s.per?.spend && s.per.of === 'verses')) {
      const opus = passiveOf(p, 'magnum_opus');
      if (opus && p.used.filter((u) => u === 'fight:opus').length < opus.value) p.used.push('fight:opus');
      else spend('verse');
    }
    if (kind === 'spell' && !s.unleash) spend('unleashed'); // the Unleashed spell has gone off
    if (s.unleash) {
      const charges = stacksOf(p, 'charged');
      spend('charged');
      if (charges) {
        p.statuses.push({ id: 'unleashed', turns: 99, power: charges, by: p.id });
        this.addLog('info', `💥 ${p.name} unleashes ${charges} Arcane Charge${charges > 1 ? 's' : ''} into the next spell.`);
      }
    }
    const charge = passiveOf(p, 'arcane_charge');
    if (charge && (kind === 'spell' || (kind === 'cantrip' && charge.tier >= 2)) && !s.unleash) {
      this.addStacks(p, 'charged', 1, hasBranch(p, 'archmage', 'B') ? 7 : charge.value);
    }
    const verse = passiveOf(p, 'verse');
    if (verse && (kind === 'spell' || kind === 'cantrip') && !s.finale) {
      this.addStacks(p, 'verse', hasBranch(p, 'verse', 'A') && kind === 'spell' ? 2 : 1, verse.value);
    }
    // Saint: Lay on Hands on a badly hurt friend is ready again at once (Martyr: it costs you 3 HP instead of AP).
    const saint = own.id === 'lay_on_hands' ? passiveOf(p, 'saint') : null;
    if (saint && lowBefore[0] !== undefined && lowBefore[0] < (hasBranch(p, 'saint', 'A') ? 0.75 : 0.5)) own.cd = 0;
    if (saint && hasBranch(p, 'saint', 'B')) p.hp = Math.max(1, p.hp - 3);
    if (own.id === 'inspiration' && (passiveOf(p, 'standing_ovation')?.tier ?? 0) >= 2) own.cd = Math.max(0, own.cd - 1);
  }

  /** Finale: every friend it touches heals and gets Block for each Verse (Magnum Opus II: and 1 AP). */
  private finale(p: PlayerEntity, fr: PlayerEntity, f: { heal: number; block: number }, verses: number) {
    const healed = this.healBy(p, fr, f.heal * verses, false, true);
    if (this.standing(fr)) this.addBlock(fr, p, f.block * verses);
    this.addLog('heal', `🎆 ${fr.name} rides the Finale: +${healed} HP, ${f.block * verses} Block.`);
    const opus = passiveOf(p, 'magnum_opus');
    if (opus && opus.tier >= 2 && p.used.filter((u) => u === 'fight:opus').length < opus.value) this.giveAp(fr, 1, p);
  }

  /** Bardic Inspiration's engines: Standing Ovation (more AP on the still-inspired) and Heroic Saga (Inspired stacks). */
  private inspire(p: PlayerEntity, fr: PlayerEntity, ovation: boolean) {
    const o = passiveOf(p, 'standing_ovation');
    if (o && ovation && fr !== p) {
      this.giveAp(fr, o.value, p);
      if (hasBranch(p, 'standing_ovation', 'B')) this.addMoves(fr, 2);
    }
    const saga = passiveOf(p, 'heroic_saga');
    if (saga) {
      for (const h of hasBranch(p, 'heroic_saga', 'B') ? [fr, p] : [fr]) this.applyStatus(h, { id: 'inspired', turns: 2, power: 1, stack: saga.value }, p);
    }
  }

  /** Toxic Catalyst: multiplies the Poison on it (up to the cap). */
  private multiplyPoison(p: PlayerEntity, f: Entity, mult: number) {
    const ps = f.statuses.find((x) => x.id === 'poisoned');
    if (!ps?.power) return;
    const cap = Math.max(POISON_CAP, ...this.heroes().map((h) => passiveOf(h, 'virulence')?.value ?? 0));
    ps.power = Math.min(cap, ps.power * mult);
    ps.turns = Math.max(ps.turns, 2);
    ps.by = p.id;
    this.addLog('info', `⚗️ The poison in ${f.name} blooms: ${ps.power} Poison.`);
    this.float(f, `☠️×${mult}`, '#7ddc6f');
  }

  /** Split Shot: Quick Shot also fires at another Marked enemy in range (Marking Shot: any enemy, and Marks it). */
  private splitShot(p: PlayerEntity, s: SkillStats, name: string, color: string, main: Entity | undefined) {
    const split = passiveOf(p, 'split_shot');
    if (!split) return;
    const any = hasBranch(p, 'split_shot', 'B');
    const near = this.monsters()
      .filter((m) => m !== main && dist(m, p) <= s.range && hasLOS(this, p, m) && (any || hasStatus(m, 'marked')))
      .sort((x, y) => Number(hasStatus(y, 'marked')) - Number(hasStatus(x, 'marked')) || dist(x, p) - dist(y, p))
      .slice(0, split.value);
    const shot = split.tier >= 2 && s.dmg ? { ...s, dmg: { ...s.dmg, bonus: (s.dmg.bonus ?? 0) + 2 } } : s;
    for (const m of near) {
      this.addLog('info', `🪃 ${p.name}'s shot splits toward ${m.name}!`);
      this.weaponHit(p, m, shot, name, color, false);
      if (any && this.entities.includes(m)) this.applyStatus(m, { id: 'marked', turns: 2 }, p);
    }
  }

  /** Earthbreaker: knocking a monster Prone hurts it (World Breaker: those next to it too; Tectonic Rage: more Rage). */
  private earthbreaker(p: PlayerEntity, t: MonsterEntity) {
    const e = passiveOf(p, 'earthbreaker')!;
    const hurt = this.weaponRoll(p) + (e.tier >= 2 ? statMod(p, 'str') : 0);
    this.later(this.turnToken, 0, () => {
      if (!this.entities.includes(t)) return;
      this.addLog('hit', `🌋 ${t.name} hits the ground hard: ${hurt}.`);
      this.damage(t, hurt, p, 'physical');
      if (hasBranch(p, 'earthbreaker', 'A')) for (const m of this.monsters().filter((m) => m !== t && dist(m, t) <= 1)) this.damage(m, Math.floor(hurt / 2), p, 'physical');
      const rage = p.statuses.find((x) => x.id === 'raging');
      if (hasBranch(p, 'earthbreaker', 'B') && rage && p.used.filter((u) => u === 'fight:quake').length < 4) {
        p.used.push('fight:quake');
        rage.power = (rage.power ?? 0) + 1;
      }
    });
  }

  /** A hero's weapon dice, no roll to hit (Body Slam, Earthbreaker). */
  private weaponRoll(p: PlayerEntity): number {
    const basic = p.skills.find((o) => SKILLS[o.id].kind === 'basic' && statsOf(o).range <= 1) ?? p.skills.find((o) => SKILLS[o.id].kind === 'basic');
    return rollDice((basic && statsOf(basic).dmg) || { n: 1, d: 6 });
  }

  /** Tiles a Geomancer raised, with the rounds they have left (walls only: rubble stays for the fight). */
  private raised = new Map<number, number>();

  private setTile(i: number, c: string) {
    this.tiles = this.tiles.slice(0, i) + c + this.tiles.slice(i + 1);
  }

  /**
   * Raise Cover and Wall of Stone: cover or a wall rises on empty floor across the aimed spot (square to the caster),
   * or all around the target (Prison of Stone). Earthshaper makes it burst on the enemies next to it, and walls last
   * twice as long.
   */
  private raiseGround(p: PlayerEntity, s: SkillStats, res: AimResult) {
    const r = s.raise!;
    const c = res.center;
    const spots: Pos[] = [];
    if (r.ring) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) spots.push({ x: c.x + dx, y: c.y + dy });
    } else {
      const d = dirTo(p, c);
      const across = d.x || d.y ? { x: -d.y, y: d.x } : { x: 0, y: 1 };
      spots.push(c);
      for (let k = 1; spots.length < r.tiles; k++) spots.push({ x: c.x + across.x * k, y: c.y + across.y * k }, { x: c.x - across.x * k, y: c.y - across.y * k });
    }
    const open = (q: Pos) => {
      const i = q.y * this.width + q.x;
      return q.x > 0 && q.y > 0 && q.x < this.width - 1 && q.y < this.height - 1 && this.tiles[i] === '.' && !this.occupied(q.x, q.y) && !this.traps.has(i);
    };
    const shaper = passiveOf(p, 'earthshaper');
    const turns = (r.turns ?? 0) * (shaper ? 2 : 1);
    const up: Pos[] = [];
    for (const q of spots.slice(0, r.ring ? 8 : r.tiles)) {
      if (!open(q)) continue;
      const i = q.y * this.width + q.x;
      this.setTile(i, r.cover === 'wall' ? '#' : LOW_COVER);
      if (r.cover === 'wall') {
        delete this.ground[i];
        if (turns) this.raised.set(i, turns);
      }
      up.push(q);
    }
    if (!up.length) {
      this.addLog('miss', `${s.icon} The ground won't rise there: no empty floor.`);
      return;
    }
    this.addLog('info', r.cover === 'wall' ? `⛰️ A wall of stone rises (${up.length} tiles, ${turns} rounds).` : `🪨 Rubble rises: ${up.length} tiles of low cover.`);
    if (shaper) {
      const hit = this.monsters().filter((m) => up.some((q) => dist(q, m) <= 1));
      for (const m of hit) this.damage(m, rollDice({ n: shaper.value, d: 6 }), p, 'physical');
      if (hasBranch(p, 'earthshaper', 'B')) for (const h of this.heroes().filter((h) => this.standing(h) && up.some((q) => dist(q, h) <= 1))) this.addBlock(h, p, rollDice({ n: 1, d: 6 }));
    }
  }

  /** Shatter Ground: the broken floor leaves rubble (low cover) on some empty tiles of the area. */
  private rubble(center: Pos, radius: number, n: number) {
    const free: number[] = [];
    for (let y = center.y - radius; y <= center.y + radius; y++) {
      for (let x = center.x - radius; x <= center.x + radius; x++) {
        const i = y * this.width + x;
        if (x > 0 && y > 0 && x < this.width - 1 && y < this.height - 1 && this.tiles[i] === '.' && !this.occupied(x, y) && !this.traps.has(i)) free.push(i);
      }
    }
    const picked = shuffle(free).slice(0, n);
    for (const i of picked) this.setTile(i, LOW_COVER);
    if (picked.length) this.addLog('info', `⛏️ The broken floor leaves rubble on ${picked.length} tiles.`);
  }

  /** End of a round: raised walls crumble when their time is up. */
  private tickRaised() {
    for (const [i, left] of [...this.raised]) {
      if (left > 1) {
        this.raised.set(i, left - 1);
        continue;
      }
      this.raised.delete(i);
      if (this.tiles[i] === '#' && !this.props[i]) this.setTile(i, '.');
    }
  }

  private teleportNextTo(p: PlayerEntity, t: Entity) {
    const spots: Pos[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if ((dx || dy) && this.tiles[y * this.width + x] === '.' && !this.occupied(x, y, p.id)) spots.push({ x, y });
      }
    }
    if (!spots.length) return;
    const from = { x: p.x, y: p.y };
    const harm = (q: Pos) => hazardAt(this, q.y * this.width + q.x, p);
    const spot = spots.sort((a, b) => harm(a) - harm(b) || dist(b, from) - dist(a, from))[0];
    p.x = spot.x;
    p.y = spot.y;
    this.addLog('info', `🌑 ${p.name} steps out of the shadows behind ${t.name}.`);
    this.standIn(p, 'appear');
  }

  /** Drags enemies within `range` tiles next to you (Cyclone). */
  private pullFoes(p: PlayerEntity, foes: MonsterEntity[], range: number) {
    for (const f of foes) {
      if (dist(f, p) <= 1 || dist(f, p) > range) continue;
      let best: Pos | null = null;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (!(dx || dy) || this.tiles[y * this.width + x] !== '.' || this.occupied(x, y)) continue;
          if (!best || dist({ x, y }, f) < dist(best, f)) best = { x, y };
        }
      }
      if (!best) continue;
      f.x = best.x;
      f.y = best.y;
      this.addLog('info', `🌀 ${f.name} is dragged into the storm.`);
      this.standIn(f, 'step');
    }
  }

  /** Knocks a creature `tiles` steps directly away from `from`; walls and creatures stop it. */
  /** Knocks a creature `tiles` away from `from`. `by`: the hero who pushed it (Crushing Force). */
  private push(t: Entity, from: Pos, tiles: number, by?: PlayerEntity) {
    const dx = Math.sign(t.x - from.x);
    const dy = Math.sign(t.y - from.y);
    if (!dx && !dy) return;
    const path: Pos[] = [];
    let at: Pos = { x: t.x, y: t.y };
    let into: Entity | undefined; // the creature it slammed into
    for (let i = 0; i < tiles; i++) {
      if (!canStep(this, at, dx, dy)) break;
      if (this.occupied(at.x + dx, at.y + dy, t.id)) {
        into = this.entities.find((e) => e.x === at.x + dx && e.y === at.y + dy && e !== t);
        break;
      }
      at = { x: at.x + dx, y: at.y + dy };
      path.push(at);
    }
    // Crushing Force: every tile it couldn't go hurts (Domino: the one it hits too).
    const crush = by ? passiveOf(by, 'crushing_force') : null;
    const blocked = tiles - path.length;
    if (by && crush && blocked > 0) {
      this.later(this.turnToken, 0, () => {
        if (!this.entities.includes(t)) return;
        const hurt = rollDice({ n: crush.value * blocked, d: 6 });
        this.addLog('hit', `🧱 ${t.name} slams into ${into ? into.name : 'the wall'}: ${hurt}.`);
        this.damage(t, hurt, by, 'physical');
        if (into && hasBranch(by, 'crushing_force', 'B') && this.entities.includes(into) && isFoe(into)) this.damage(into, hurt, by, 'physical');
      });
    }
    if (!path.length) return;
    this.addLog('info', `${t.name} is knocked back ${path.length} tile${path.length > 1 ? 's' : ''}.`);
    for (const step of path) {
      t.x = step.x;
      t.y = step.y;
      // Shoved into the fire: every tile it's pushed through counts.
      if (this.standIn(t, 'step') || !this.entities.includes(t)) return;
    }
  }

  /** Adds or refreshes a status. Statuses put on whoever's turn it is don't count that turn. */
  private applyStatus(t: Entity, a: StatusApply, by?: Entity) {
    if (!this.entities.includes(t)) return;
    if (t.kind === 'player' && this.unstoppable(t, a.id)) {
      this.float(t, 'unstoppable', '#ffd84d');
      return;
    }
    if (t.kind === 'player' && (a.id === 'stunned' || a.id === 'dazed') && hasBranch(t, 'steady', 'A')) return; // Unshakable
    if (immuneToStatus(t, a.id)) return; // fire can't burn a fire drake (or an Attuned wizard), poison can't hurt the dead
    if (a.id === 'burning' && hasStatus(t, 'wet')) {
      // Wet creatures don't catch fire: the flames just dry them off.
      t.statuses = t.statuses.filter((x) => x.id !== 'wet');
      if (this.phase === 'combat') this.float(t, '💨 dried off', '#cfd8dc');
      return;
    }
    if (a.id === 'wet') t.statuses = t.statuses.filter((x) => x.id !== 'burning');
    if (t.kind === 'player' && a.id === 'surprised' && (passiveOf(t, 'alert') || gearAlert(t))) {
      this.addLog('info', `⏰ ${t.name} is too alert to be caught off guard.`);
      return;
    }
    if (a.id === 'drained' && t.kind !== 'player') return;
    // Poison from heroes stacks (Slay the Spire style), up to POISON_CAP (Virulence: more); the Plague Censer adds 1.
    if (a.id === 'poisoned' && by?.kind === 'player') {
      const power = (a.power ?? 1) + (this.hasRelic('plague_censer') ? 1 : 0);
      const cap = Math.max(POISON_CAP, ...this.heroes().map((h) => passiveOf(h, 'virulence')?.value ?? 0));
      a = { ...a, power, stack: cap / power };
    }
    // Haunting Refrain: a bard's debuffs last longer; Zeal: a cleric's buffs too.
    if (by?.kind === 'player') {
      const refrain = passiveOf(by, 'haunting_refrain');
      if (refrain && t.kind === 'monster' && !STATUSES[a.id].good) a = { ...a, turns: a.turns + refrain.value };
      if (hasBranch(by, 'inspiring_presence', 'B') && t.kind === 'player' && STATUSES[a.id].good && a.turns < 50) a = { ...a, turns: a.turns + 1 };
    }
    const turns = a.turns + (this.acting(t) ? 1 : 0);
    const have = t.statuses.find((x) => x.id === a.id);
    if (have) {
      have.turns = Math.max(have.turns, turns);
      if (a.stack) have.power = Math.min((have.power ?? 0) + (a.power ?? 1), (a.power ?? 1) * a.stack); // Rallied, Drained
      else if (a.power) have.power = Math.max(have.power ?? 0, a.power);
      if (by) have.by = by.id;
    } else {
      t.statuses.push({ id: a.id, turns, ...(a.power ? { power: a.power } : {}), ...(by ? { by: by.id } : {}) });
    }
    if (a.id === 'drained' && t.kind === 'player') recalcHero(t); // max HP comes down (progression.ts)
    if (a.id === 'prone' && !have && t.kind === 'monster' && by?.kind === 'player' && passiveOf(by, 'earthbreaker')) this.earthbreaker(by, t);
    const def = STATUSES[a.id];
    // Only new statuses pop up: wading through a puddle shouldn't say "Wet" on every step.
    if (this.phase === 'combat' && t !== by && !have) this.float(t, `${def.icon} ${def.name}`, def.good ? '#7ddc6f' : '#ffb04d');
  }

  // ------------------------------------------------------------ dice & damage

  /** Armor class right now: Shielded and Spell Shield add to it. */
  private acOf(t: Entity): number {
    let ac = t.ac;
    for (const s of t.statuses) if (s.id === 'shielded') ac += s.power ?? 2;
    if (hasStatus(t, 'shocked')) ac -= 2;
    if (t.kind === 'player' && t.tempHp > 0 && hasBranch(t, 'arcane_ward', 'A')) ac += 2;
    return ac;
  }

  /** Flat damage from the attacker's passives: Opportunist vs the wounded, Elemental Affinity on fire. */
  private bonusDamage(a: Entity, t: Entity, element: Element): number {
    if (a.kind !== 'player') return 0;
    let extra = 0;
    if (t.hp < t.maxHp / 2) extra += passiveOf(a, 'opportunist')?.value ?? 0;
    if (hasStatus(t, 'marked')) extra += passiveOf(a, 'favored_foe')?.value ?? 0;
    if (element === 'fire') extra += passiveOf(a, 'elemental_affinity')?.value ?? 0;
    // Subclass passives (shared/subclasses.ts).
    if (['netted', 'webbed', 'prone'].some((id) => hasStatus(t, id as StatusId))) extra += passiveOf(a, 'ambusher')?.value ?? 0;
    const eye = passiveOf(a, 'deadeye');
    if (eye && dist(a, t) >= (hasBranch(a, 'deadeye', 'B') ? 4 : 5)) extra += eye.value;
    const lust = passiveOf(a, 'bloodlust');
    if (lust && dist(a, t) <= 1 && (a.hp < a.maxHp / 2 || (hasBranch(a, 'bloodlust', 'B') && hasStatus(a, 'raging')))) extra += lust.value;
    const blades = passiveOf(a, 'psychic_blades');
    if (blades && t.statuses.some((x) => !STATUSES[x.id].good)) extra += rollDice({ n: blades.value, d: 6 });
    const cast = this.casting;
    if (cast && SKILLS[cast.id].kind === 'spell') extra += passiveOf(a, 'empowered_evocation')?.value ?? 0;
    if (cast && cast.s.target === 'area') extra += passiveOf(a, 'sculpt_spells')?.value ?? 0;
    if (cast && hasBranch(a, 'catalyst', 'B') && (element === 'fire' || element === 'cold' || element === 'lightning')) extra += 2;
    const relic: Partial<Record<Element, RelicId>> = { fire: 'ember_stone', cold: 'frost_shard', lightning: 'storm_rod' };
    const r = relic[element];
    if (r && this.hasRelic(r)) extra += 2;
    if (element === 'lightning' && hasStatus(t, 'wet') && this.hasRelic('storm_coil')) extra += 3;
    return extra + this.engineDamage(a, t, element);
  }

  /** Flat damage and extra dice from the build engines (shared/engines.ts) on a hero's hit. */
  private engineDamage(a: PlayerEntity, t: Entity, element: Element): number {
    let extra = 0;
    const cast = this.casting;
    const spell = !!cast && SKILLS[cast.id].kind === 'spell';
    if (spell) {
      // Arcane Charge: every Charge powers your spells; Unleash spends them on one big spell.
      extra += stacksOf(a, 'charged') * (hasBranch(a, 'arcane_charge', 'A') ? 2 : 1);
      const loose = stacksOf(a, 'unleashed');
      if (loose && !this.unleashedOn.has(t.id)) {
        this.unleashedOn.add(t.id);
        extra += rollDice({ n: loose, d: hasBranch(a, 'unleash', 'A') ? 8 : 6 });
      }
    }
    // Rupture, Mind Rot, Dawn, Kill Shot, Shield Slam: more for every stack of something.
    const per = cast?.s.per;
    if (per) {
      const n = this.perCount(a, t, per.of);
      if (n > 0) extra += (per.dice ? rollDice({ n: per.dice.n * n, d: per.dice.d }) : 0) + Math.floor((per.flat ?? 0) * n);
    }
    const wet = hasStatus(t, 'wet');
    const conductor = passiveOf(a, 'conductor');
    if (conductor && element === 'lightning' && wet && cast?.s.dmg) {
      const dice = { n: cast.s.dmg.n * (hasBranch(a, 'conductor', 'A') ? 2 : 1), d: cast.s.dmg.d };
      extra += rollDice(dice); // the dice again (and again, for Superconductor)
    }
    const shards = passiveOf(a, 'shatter_point');
    if (shards && hasStatus(t, 'frozen')) extra += rollDice({ n: shards.value, d: 6 });
    const stomp = passiveOf(a, 'stomp');
    if (stomp && hasStatus(t, 'prone')) extra += rollDice({ n: stomp.value, d: 6 });
    const fury = passiveOf(a, 'blood_fury');
    if (fury && dist(a, t) <= 1) {
      extra += fury.value * Math.floor((10 * (a.maxHp - a.hp)) / a.maxHp);
      if (fury.tier === 2 && a.hp < a.maxHp / 2) extra += 3;
    }
    // Marks: Pack Hunter (yours, and your friends' with Pack Leader).
    const marked = this.monsters().filter((m) => hasStatus(m, 'marked')).length;
    if (marked) {
      extra += (passiveOf(a, 'pack_hunter')?.value ?? 0) * marked;
      if (this.heroes().some((h) => h !== a && hasBranch(h, 'pack_hunter', 'B'))) extra += marked;
    }
    // Radiance on the target: every stack adds to radiant damage (2 each for a Holy Brand).
    const seared = t.statuses.find((x) => x.id === 'seared');
    if (seared && element === 'radiant') {
      const by = this.entity(seared.by);
      extra += (seared.power ?? 0) * (by?.kind === 'player' && hasBranch(by, 'searing_light', 'B') ? 2 : 1);
    }
    if (element === 'radiant' && hasBranch(a, 'avatar_of_light', 'B')) extra += rollDice({ n: 1, d: 4 });
    // Haunting Refrain II: each debuff a bard put on it makes it take more from everyone.
    for (const x of t.statuses) {
      if (STATUSES[x.id].good || !x.by) continue;
      const bard = this.entity(x.by);
      const refrain = bard?.kind === 'player' ? passiveOf(bard, 'haunting_refrain') : null;
      if (refrain && refrain.tier >= 2) extra += hasBranch(bard as PlayerEntity, 'haunting_refrain', 'B') ? 2 : 1;
    }
    // On the hitter: Inspiring Presence (per buff from the cleric), Heroic Saga (Inspired), Oath of Valor (the paladin's Block).
    for (const x of a.statuses) {
      if (!STATUSES[x.id].good || !x.by) continue;
      const giver = this.entity(x.by);
      if (giver?.kind === 'player') extra += passiveOf(giver, 'inspiring_presence')?.value ?? 0;
    }
    const inspired = a.statuses.find((x) => x.id === 'inspired');
    if (inspired?.power) {
      const bard = this.entity(inspired.by);
      extra += rollDice({ n: inspired.power, d: bard?.kind === 'player' && hasBranch(bard, 'heroic_saga', 'A') ? 8 : 6 });
    }
    for (const id of Object.keys(a.block ?? {})) {
      const giver = this.entity(id.split(':')[0]);
      if (giver?.kind === 'player' && giver !== a && hasBranch(giver, 'unbreakable_oath', 'B')) {
        extra += 1;
        break;
      }
    }
    return extra;
  }

  /** How many stacks a `per` bonus counts. */
  private perCount(a: PlayerEntity, t: Entity, of: PerSource): number {
    switch (of) {
      case 'poison':
        return stacksOf(t, 'poisoned');
      case 'radiance':
        return stacksOf(t, 'seared');
      case 'debuffs':
        return debuffsOn(t);
      case 'focus':
        return stacksOf(a, 'aiming');
      case 'block':
        return blockOf(a);
      case 'verses':
        return stacksOf(a, 'verse');
    }
  }

  /** Damage multipliers: Hunter's Snare on the pinned. */
  private damageScale(a: Entity, t: Entity): number {
    if (a.kind !== 'player') return 1;
    const snare = passiveOf(a, 'hunters_snare');
    if (snare && (hasStatus(t, 'netted') || hasStatus(t, 'webbed') || hasStatus(t, 'prone'))) return 1 + snare.value / 100;
    return 1;
  }

  /** Extra to-hit: Hunter's Calm (per Focus) and Overwatch (from cover). */
  private hitBonus(p: PlayerEntity, t: Entity): number {
    let b = hasBranch(p, 'patience', 'B') ? stacksOf(p, 'aiming') : 0;
    if (hasBranch(p, 'snipers_nest', 'A') && dist(p, t) > 1 && coverFrom(this, t, p) > 0) b += 2;
    return b;
  }

  /** Where a hero's attack starts to crit: 20, less for Keen Edge, smites, a Sniper's Nest, Loaded Dice and gear. */
  private critRangeOf(p: PlayerEntity, t: Entity): number {
    let r = 20;
    if (hasBranch(p, 'lucky', 'B') || this.hasRelic('loaded_dice')) r--;
    const keen = passiveOf(p, 'keen_edge');
    if (keen) r -= keen.value + (hasBranch(p, 'keen_edge', 'B') && (hasStatus(t, 'prone') || hasStatus(t, 'netted')) ? 2 : 0);
    const zeal = passiveOf(p, 'zealous_smite');
    if (zeal && this.casting && SMITES.includes(this.casting.id)) r -= zeal.value;
    const nest = passiveOf(p, 'snipers_nest');
    if (nest && dist(p, t) > 1 && coverFrom(this, t, p) > 0) r -= nest.value;
    return Math.max(15, r - gearBonus(p, 'crit'));
  }

  /** Perfect Form (a crit readied by the last one) or Death Blossom (from hiding): this attack is a crit. */
  private forcedCrit(p: PlayerEntity, fromHiding: boolean): 'perfect' | 'blossom' | null {
    const ready = p.used.indexOf('turn:perfect-ready');
    if (ready >= 0) {
      p.used.splice(ready, 1);
      return 'perfect';
    }
    const blossom = passiveOf(p, 'death_blossom');
    if (fromHiding && blossom && p.used.filter((u) => u === 'turn:blossom').length < blossom.value) {
      p.used.push('turn:blossom');
      return 'blossom';
    }
    return null;
  }

  /** On a crit: more dice (Devastating Blows, Zealous Smite), +damage (Perfect Form II, Deadly Nest). */
  private critExtra(p: PlayerEntity, t: Entity, dmg: Dice, forced: 'perfect' | 'blossom' | null): number {
    let extra = 0;
    const blows = passiveOf(p, 'devastating_blows');
    if (blows) extra += rollDice({ n: dmg.n * (blows.value - 2), d: dmg.d }) + (blows.tier >= 2 ? 3 : 0);
    if (passiveOf(p, 'zealous_smite') && this.casting && SMITES.includes(this.casting.id)) extra += rollDice({ n: dmg.n, d: dmg.d });
    if (forced === 'perfect' && (passiveOf(p, 'perfect_form')?.tier ?? 0) >= 2) extra += 4;
    if (hasBranch(p, 'snipers_nest', 'B') && dist(p, t) > 1 && coverFrom(this, t, p) > 0) extra += rollDice({ n: 2, d: 8 });
    return extra;
  }

  /** After a crit lands: Momentum (AP back), Perfect Form (the next one crits), Shattering Blows (Prone), Righteous Fury. */
  private afterCrit(p: PlayerEntity, t: Entity) {
    this.momentum(p);
    const form = passiveOf(p, 'perfect_form');
    if (form && p.used.filter((u) => u === 'turn:perfect').length < form.value) p.used.push('turn:perfect', 'turn:perfect-ready');
    if (hasBranch(p, 'devastating_blows', 'B') && this.entities.includes(t)) this.applyStatus(t, { id: 'prone', turns: 1 }, p);
    if (hasBranch(p, 'zealous_smite', 'B') && this.casting && SMITES.includes(this.casting.id)) {
      const healed = this.healBy(null, p, rollDice({ n: 1, d: 8 }));
      if (healed) this.addLog('heal', `🗯️ Righteous fury mends ${p.name}: +${healed} HP.`);
    }
  }

  /** Momentum: a crit (or, from tier II, a kill) gives 1 AP back, once (or twice) a turn. */
  private momentum(p: PlayerEntity) {
    const m = passiveOf(p, 'momentum');
    const a = this.acts(p);
    if (!m || !a || p.used.filter((u) => u === 'turn:momentum').length >= m.value) return;
    p.used.push('turn:momentum');
    a.ap++;
    this.float(p, '⚡+1 AP', '#f6cf7a');
    if (hasBranch(p, 'momentum', 'B')) this.addMoves(p, 2);
  }

  /** Every Nth hit of a turn: Knife Juggler throws a free knife at the nearest enemy (it never misses). */
  private afterHitInTurn(p: PlayerEntity, t: Entity) {
    const n = p.used.filter((u) => u === 'turn:hit').length;
    if (hasBranch(p, 'flurry', 'B') && n >= 4 && this.entities.includes(t)) this.applyStatus(t, { id: 'poisoned', turns: 2, power: 2 }, p);
    const juggler = passiveOf(p, 'knife_juggler');
    if (!juggler || n % juggler.value !== 0) return;
    const near = this.monsters().filter((m) => dist(m, p) <= 5 && hasLOS(this, p, m)).sort((x, y) => dist(x, p) - dist(y, p))[0];
    if (!near) return;
    const knife = rollDice({ n: juggler.tier >= 2 ? 2 : 1, d: 4 }) + statMod(p, 'dex');
    this.shot(p, near, '#c9d1d9');
    this.addLog('hit', `🔪 ${p.name} flicks a knife at ${near.name}: ${knife}.`);
    this.damage(near, knife, p, 'physical');
    if (hasBranch(p, 'knife_juggler', 'B') && this.entities.includes(near)) this.applyStatus(near, { id: 'poisoned', turns: 2, power: 2 }, p);
  }

  /** Rolls an attack (advantage, crits, Sneak Attack, passives) and applies the damage. Returns true on a hit. */
  private attackRoll(a: Entity, t: Entity, o: AttackOpts): boolean {
    const hero = a.kind === 'player' ? a : null;
    // Advantage: the skill, hidden, focused, a marked target, flanking, or striking from behind (shared/tactics.ts).
    const why = attackAdvantage(a, t, this.entities, !!o.adv);
    const net = netAdvantage(why);
    const adv = net > 0;
    const dis = net < 0;
    const hidden = a.statuses.find((s) => s.id === 'hidden');
    // Focus and hiding are spent on this attack, and you turn to face what you're hitting. So is a Help on the target.
    a.statuses = a.statuses.filter((s) => s.id !== 'focused' && s.id !== 'hidden');
    if (why.adv.includes('distracted')) t.statuses = t.statuses.filter((s) => s.id !== 'distracted');
    const rally = this.rallyOf(a);
    this.face(a, t);
    const r1 = rollDie(20);
    const r2 = rollDie(20);
    let d20 = adv ? Math.max(r1, r2) : dis ? Math.min(r1, r2) : r1;
    const reasons = (adv ? why.adv : dis ? why.dis : []).filter((r) => r !== 'the skill');
    const rolled = adv || dis ? `🎲${r1}|${r2}→${d20}${reasons.length ? ` (${reasons.join(', ')})` : ''}` : `🎲${d20}`;
    let reroll = '';
    if (d20 === 1 && hero && this.useLucky(hero)) {
      d20 = rollDie(20);
      reroll = ` 🍀→${d20}`;
    }
    const bonus = o.bonus + (hasStatus(a, 'blessed') ? 2 : 0) - (hasStatus(a, 'dazed') ? 2 : 0) + rally + (hero ? this.hitBonus(hero, t) : 0);
    // Perfect Form and Death Blossom turn this attack into a crit (it can't miss); a Blossom from hiding ignores cover.
    const forced = hero ? this.forcedCrit(hero, !!hidden) : null;
    const cover = forced === 'blossom' && hero && (passiveOf(hero, 'death_blossom')?.tier ?? 0) >= 2 ? 0 : coverFrom(this, a, t); // ducking behind a wall or a crate (none in melee)
    const ac = this.acOf(t) + cover;
    const critRange = hero ? this.critRangeOf(hero, t) : 20;
    const crit = !!forced || d20 >= critRange || (!!o.critFull && t.hp >= t.maxHp);
    const hit = crit || (d20 !== 1 && d20 + bonus >= ac);
    if (dist(a, t) > 1 && a.kind === 'monster') this.shot(a, t, ELEMENT_COLOR[o.element]);
    // Strike and Fade: the first attack on your own turn, hit or miss, frees up some movement.
    const fade = hero ? passiveOf(hero, 'strike_and_fade') : null;
    if (hero && fade && this.acting(hero) && !hero.used.includes('turn:fade')) {
      hero.used.push('turn:fade');
      this.addMoves(hero, fade.value);
      if (hasBranch(hero, 'strike_and_fade', 'B')) this.applyStatus(hero, { id: 'shielded', turns: 1, power: 2 }, hero);
    }
    const what = `${a.name} ${o.verb} ${t.name}${o.weapon ? ` (${o.weapon})` : ''}`;
    const roll = `${rolled}${reroll}${fmtMod(bonus)}=${d20 + bonus} vs AC ${ac}${cover ? ` (${coverWord(cover)})` : ''}`;
    if (!hit) {
      this.addLog('miss', `${what}: ${roll}, miss${d20 === 1 ? ' (natural 1!)' : ''}`);
      this.float(t, 'miss', '#9aa0a6');
      if (dist(a, t) <= 1 && canReact(t)) this.face(t, a);
      return false;
    }

    const rage = dist(a, t) <= 1 ? (a.statuses.find((s) => s.id === 'raging')?.power ?? 0) : 0; // Rage: melee only
    let total = rollDice(o.dmg, crit) + (o.extra ?? 0) + this.bonusDamage(a, t, o.element) + rally + rage;
    const notes: string[] = [];
    if (hero && crit) total += this.critExtra(hero, t, o.dmg, forced);
    // Hits this turn (Flurry, Knife Juggler): only your own attacks on your own turn count.
    const mine = hero && this.acting(hero);
    if (hero && mine) {
      hero.used.push('turn:hit');
      const n = hero.used.filter((u) => u === 'turn:hit').length;
      const flurry = passiveOf(hero, 'flurry');
      if (flurry && n > 1) {
        total += flurry.value * (n - 1);
        notes.push(`${flurry.value * (n - 1)} flurry`);
      }
    }
    // Sneak Attack, once a turn (Thousand Cuts: part of it on every later hit too).
    const cuts = hero ? passiveOf(hero, 'thousand_cuts') : null;
    const again = !!hero && hero.used.includes('turn:sneak');
    if (hero && o.sneak && (!again || cuts)) {
      const flanked = this.entities.some((e) => e !== hero && !isFoe(e) && this.up(e) && dist(e, t) <= 1);
      if (flanked || adv) {
        // Death Mark: more dice on the Poisoned (or Marked, for Marked for Death). Cunning Strikes: more per debuff.
        const mark = passiveOf(hero, 'death_mark');
        const doomed = mark && (hasStatus(t, 'poisoned') || (hasBranch(hero, 'death_mark', 'B') && hasStatus(t, 'marked')));
        const cunning = passiveOf(hero, 'cunning_strikes');
        const debuffs = cunning ? Math.min(debuffsOn(t), cunning.tier >= 2 && !hasBranch(hero, 'cunning_strikes', 'A') ? 5 : 3) : 0;
        let dice = sneakDice(hero.level) + (doomed ? mark.value : 0) + (cunning ? cunning.value * debuffs : 0);
        if (again && cuts) dice = Math.max(1, Math.floor((dice * cuts.value) / 100));
        const sneak = rollDice({ n: dice, d: 6 }, crit);
        total += sneak;
        if (!again) hero.used.push('turn:sneak');
        notes.push(`${sneak} Sneak Attack`);
        if (this.entities.includes(t) && ((!again && hasBranch(hero, 'cunning_strikes', 'B')) || (again && hasBranch(hero, 'thousand_cuts', 'B')))) {
          this.applyStatus(t, { id: 'poisoned', turns: 2, power: again ? 1 : 2 }, hero); // Twist the Knife, Opening Wounds
        }
      }
    }
    if (o.execute && t.hp < t.maxHp / 2) {
      const ex = rollDice(o.execute, crit);
      total += ex;
      notes.push(`${ex} execute`);
    }
    if (hero && o.basic) {
      const strike = passiveOf(hero, 'divine_strike');
      if (strike) {
        const holy = rollDice({ n: 1, d: strike.value }, crit);
        total += holy;
        notes.push(`${holy} radiant`);
      }
    }
    if (hidden?.power) {
      const ambush = rollDice({ n: hidden.power, d: 6 }, crit);
      total += ambush;
      notes.push(`${ambush} from the shadows`);
    }
    const honed = a.statuses.find((s) => s.id === 'honed');
    if (honed) {
      const sharp = rollDice({ n: honed.power ?? 1, d: 8 }, crit);
      total += sharp;
      a.statuses = a.statuses.filter((s) => s !== honed);
      notes.push(`${sharp} precision`);
    }
    const favor = a.statuses.find((s) => s.id === 'blessed' && s.power);
    if (favor) {
      const holy = rollDice({ n: 1, d: 4 }, crit);
      total += holy;
      notes.push(`${holy} Divine Favor`);
    }
    total = Math.max(1, Math.round(total * this.damageScale(a, t)));
    this.addLog(crit ? 'crit' : 'hit', `${what}: ${roll}, ${crit ? 'CRITICAL HIT' : 'hit'} for ${total}${elementWord(o.element)}${notes.length ? ` (incl. ${notes.join(', ')})` : ''}`);
    this.damage(t, total, a, o.element);
    if (crit) this.callout(a, 'crit', { target: t.name }); // after the damage, so a kill steal gets the bot's word first
    if (hero && crit) this.afterCrit(hero, t);
    if (hero && forced === 'blossom') {
      this.applyStatus(hero, { id: 'hidden', turns: 2 }, hero); // Death Blossom: back into the shadows
      if (hasBranch(hero, 'death_blossom', 'B') && this.entities.includes(t)) this.applyStatus(t, { id: 'poisoned', turns: 2, power: 3 }, hero);
    }
    if (hero && o.basic) this.weaponExtras(hero, t, crit);
    const venom = hero && o.basic ? a.statuses.find((s) => s.id === 'envenomed') : undefined;
    if (venom && this.entities.includes(t)) this.applyStatus(t, { id: 'poisoned', turns: 2, power: venom.power ?? 1 }, a);
    const vial = hero && o.basic ? gearBonus(hero, 'poison') : 0; // Venom Vial
    if (vial && this.entities.includes(t)) this.applyStatus(t, { id: 'poisoned', turns: 2, power: vial }, a);
    if (hero && mine) this.afterHitInTurn(hero, t);
    if (hero && this.entities.includes(t)) this.afterHit(hero, t, o.element, !!o.basic);
    if (dist(a, t) <= 1 && this.entities.includes(t) && canReact(t)) this.face(t, a); // you turn toward whoever hit you
    return true;
  }

  /** Madness: a monster carrying enough of one bard's debuffs attacks another monster it can reach. Returns true if it did. */
  private madness(m: MonsterEntity): boolean {
    for (const bard of this.heroes()) {
      const mad = passiveOf(bard, 'madness');
      if (!mad || debuffsOn(m, bard.id) < mad.value) continue;
      const reach = MONSTERS[m.type].range;
      const friend = this.monsters().filter((x) => x !== m && dist(x, m) <= reach && (reach <= 1 || hasLOS(this, m, x))).sort((x, y) => dist(x, m) - dist(y, m))[0];
      if (!friend) return false;
      this.addLog('crit', `🤪 ${m.name} goes mad and turns on ${friend.name}!`);
      this.float(m, '🤪 mad!', '#b57bff');
      this.monsterAttack(m, friend);
      if (mad.tier >= 2 && this.entities.includes(m)) this.damage(m, rollDice({ n: 1, d: 6 }), bard, 'force');
      if (hasBranch(bard, 'madness', 'B') && this.entities.includes(m)) this.applyStatus(m, { id: 'dazed', turns: 1 }, bard);
      return true;
    }
    return false;
  }

  /** Swift Riposte: extra dice on counterattacks and ripostes. */
  private riposteBonus(p: PlayerEntity): number {
    const r = passiveOf(p, 'swift_riposte');
    return r ? rollDice({ n: r.value, d: 6 }) : 0;
  }

  /** After a counter: Swift Riposte heals (and Humbles), Blade Wall II stacks AC. */
  private afterCounter(p: PlayerEntity, m: MonsterEntity) {
    const r = passiveOf(p, 'swift_riposte');
    if (r && this.standing(p)) this.healBy(null, p, r.tier >= 2 ? 3 : 2);
    if (r && hasBranch(p, 'swift_riposte', 'B') && this.entities.includes(m)) this.applyStatus(m, { id: 'dazed', turns: 1 }, p);
    const wall = passiveOf(p, 'blade_wall');
    if (wall && wall.tier >= 2) this.applyStatus(p, { id: 'shielded', turns: 1, power: 1, stack: hasBranch(p, 'blade_wall', 'B') ? 5 : 3 }, p);
  }

  /** Wasting Toxin (Virulence III-B): the Poisoned hit softer. */
  private wasting(m: MonsterEntity): number {
    const ps = m.statuses.find((x) => x.id === 'poisoned');
    const by = ps && this.entity(ps.by);
    return by?.kind === 'player' && hasBranch(by, 'virulence', 'B') ? 2 : 0;
  }

  /** A hero's killing blow: the engines that pay off on a kill. */
  private engineKill(p: PlayerEntity, t: MonsterEntity) {
    const acts = this.acts(p); // on their own turn
    const melt = passiveOf(p, 'melt_away');
    if (melt && this.standing(p)) {
      this.applyStatus(p, { id: 'hidden', turns: 2 }, p);
      if (melt.value) this.addMoves(p, melt.value);
      if (hasBranch(p, 'melt_away', 'A') && acts && !p.used.includes('turn:ghost')) {
        p.used.push('turn:ghost');
        acts.ap++;
      }
    }
    if ((passiveOf(p, 'momentum')?.tier ?? 0) >= 2) this.momentum(p);
    const form = passiveOf(p, 'perfect_form');
    if (form && hasBranch(p, 'perfect_form', 'B') && p.used.filter((u) => u === 'turn:perfect').length < form.value) p.used.push('turn:perfect', 'turn:perfect-ready');
    if (hasBranch(p, 'hunters_snare', 'B') && acts && !p.used.includes('turn:trophy') && ['netted', 'webbed', 'prone'].some((id) => hasStatus(t, id as StatusId))) {
      p.used.push('turn:trophy');
      acts.ap++;
    }
    const angel = passiveOf(p, 'avenging_angel');
    const id = this.casting?.id;
    if (angel && id && SMITES.includes(id) && !p.used.includes('turn:angel')) {
      const any = hasBranch(p, 'avenging_angel', 'A');
      if (id === 'divine_smite' || any) {
        p.used.push('turn:angel');
        if (id === 'divine_smite') p.slots = Math.min(p.maxSlots, p.slots + 1);
        if ((angel.tier >= 2 || any) && acts) acts.ap++;
        if (hasBranch(p, 'avenging_angel', 'B')) this.addMoves(p, 3);
        this.addLog('level', `👼 ${p.name}'s vengeance is answered.`);
      }
    }
    // Pandemic and Avatar of Light: what was on it spreads to the ones next to it.
    for (const id2 of ['poisoned', 'seared'] as const) {
      const st = t.statuses.find((x) => x.id === id2);
      const by = st && this.entity(st.by);
      if (!st?.power || by?.kind !== 'player') continue;
      const spreads = id2 === 'poisoned' ? hasBranch(by, 'virulence', 'A') : !!passiveOf(by, 'avatar_of_light');
      if (!spreads) continue;
      for (const m of this.monsters().filter((m) => dist(m, t) <= 1)) this.applyStatus(m, { id: id2, turns: 3, power: st.power }, by);
    }
  }

  /** Spiked Shield: Block that soaked a monster's hit hurts it back (melee, or anything but areas with Retribution). */
  private spikes(h: PlayerEntity, m: MonsterEntity, soaked: number, area: boolean) {
    const spiked = passiveOf(h, 'spiked_shield');
    if (!spiked || area || !this.entities.includes(m) || (dist(h, m) > 1 && !hasBranch(h, 'spiked_shield', 'B'))) return;
    const back = Math.floor((soaked * spiked.value) / 100);
    if (back <= 0) return;
    this.addLog('hit', `🦔 ${m.name} cuts itself on ${h.name}'s spiked shield: ${back}.`);
    this.damage(m, back, h, 'physical', true);
    if (hasBranch(h, 'spiked_shield', 'A') && this.entities.includes(m)) this.applyStatus(m, { id: 'poisoned', turns: 2 }, h);
  }

  /** Blood Drinker (melee hits) and Blessed Smites (Divine Smite, Radiant Strike): a hero heals off the damage dealt. */
  private drink(p: PlayerEntity, t: MonsterEntity, dealt: number, area: boolean) {
    const drinker = passiveOf(p, 'blood_drinker');
    const stone = gearBonus(p, 'lifesteal'); // the Bloodstone
    const bath = passiveOf(p, 'bloodbath');
    const pinned = hasStatus(t, 'taunted') || ((bath?.tier ?? 0) >= 2 && (hasStatus(t, 'prone') || hasStatus(t, 'netted')));
    const mult = bath && pinned ? bath.value : 1;
    if (stone && !area && dist(p, t) <= 1 && !drinker) {
      const healed = this.healBy(null, p, Math.max(1, Math.floor((dealt * stone * mult) / 100)));
      if (healed) this.float(p, `🍷+${healed}`, '#c0392b');
    }
    if (drinker && !area && dist(p, t) <= 1) {
      const healed = this.healBy(null, p, Math.max(1, Math.floor((dealt * (drinker.value + stone) * mult) / 100)));
      if (healed && hasBranch(p, 'bloodbath', 'B')) {
        const friend = this.heroes().filter((h) => h !== p && this.standing(h) && dist(h, p) <= 1).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
        if (friend) this.healBy(null, friend, Math.max(1, Math.floor(healed / 2)));
      }
      if (healed) this.float(p, `🍷+${healed}`, '#c0392b');
      if (hasBranch(p, 'blood_drinker', 'B')) for (const h of this.heroes()) if (h !== p && this.standing(h) && dist(h, p) <= 1) this.healBy(null, h, 1);
    }
    const smite = passiveOf(p, 'blessed_smites');
    const id = this.casting?.id;
    if (smite && (id === 'divine_smite' || (id === 'radiant_strike' && smite.tier >= 2))) {
      let who: PlayerEntity = p;
      if (hasBranch(p, 'blessed_smites', 'B')) {
        const worse = this.heroes().filter((h) => this.standing(h) && dist(h, p) <= 4 && h.hp / h.maxHp < who.hp / who.maxHp).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
        if (worse) who = worse;
      }
      const healed = this.healBy(p, who, Math.max(1, Math.floor((dealt * smite.value) / 100)));
      if (healed) this.addLog('heal', `🌟 The smite's light flows into ${who === p ? p.name : who.name}: +${healed} HP.`);
    }
  }

  /** The engines' on-hit effects: Radiance, lightning arcs, shattering ice, Rain of Arrows, Cold Fury, Grinding Stomp. */
  private engineAfterHit(p: PlayerEntity, t: Entity, element: Element) {
    if (!this.entities.includes(t) || t.kind !== 'monster') return;
    // Searing Light (and the Sunstone): radiant hits stack Radiance.
    const sear = (element === 'radiant' ? passiveOf(p, 'searing_light')?.value ?? 0 : 0) + (element === 'radiant' ? gearBonus(p, 'radiance') : 0);
    if (sear > 0) {
      const avatar = this.heroes().find((h) => passiveOf(h, 'avatar_of_light'));
      const cap = avatar ? passiveOf(avatar, 'avatar_of_light')!.value : 5;
      this.applyStatus(t, { id: 'seared', turns: avatar ? 99 : 3, power: sear, stack: cap / sear }, p);
      if (hasBranch(p, 'searing_light', 'A') && stacksOf(t, 'seared') >= 5) this.applyStatus(t, { id: 'blinded', turns: 1 }, p);
    }
    // Conductor: lightning on the Wet arcs to the Wet around it.
    const conductor = passiveOf(p, 'conductor');
    if (conductor && element === 'lightning' && hasStatus(t, 'wet')) {
      const reach = hasBranch(p, 'conductor', 'B') ? 3 : 1;
      for (const m of this.monsters().filter((m) => m !== t && hasStatus(m, 'wet') && dist(m, t) <= reach)) {
        const arc = rollDice({ n: conductor.value, d: 6 });
        this.shot(t, m, ELEMENT_COLOR.lightning);
        this.addLog('hit', `⚡ The shock arcs from ${t.name} to ${m.name}: ${arc}.`);
        this.damage(m, arc, p, 'lightning');
      }
    }
    // Shatter Point: the hit breaks the ice (and Frost Shatter's shards chill the ones around it).
    if (passiveOf(p, 'shatter_point') && this.entities.includes(t) && hasStatus(t, 'frozen')) {
      t.statuses = t.statuses.filter((x) => x.id !== 'frozen');
      this.addLog('info', `💎 ${t.name}'s ice shatters!`);
      if (hasBranch(p, 'shatter_point', 'B')) for (const m of this.monsters()) if (m !== t && dist(m, t) <= 1) this.applyStatus(m, { id: 'chilled', turns: 2 }, p);
    }
    // Rain of Arrows: hitting one Marked enemy sends arrows down on the others.
    const rain = passiveOf(p, 'rain_of_arrows');
    if (rain && hasStatus(t, 'marked') && p.used.filter((u) => u === 'turn:rain').length < (hasBranch(p, 'rain_of_arrows', 'B') ? 2 : 1)) {
      const others = this.monsters().filter((m) => m !== t && hasStatus(m, 'marked') && dist(m, p) <= 8);
      if (others.length) {
        p.used.push('turn:rain');
        this.addLog('info', `🌧️ Arrows rain down on the Marked!`);
        for (const m of others) this.damage(m, rollDice({ n: rain.value, d: 6 }), p, 'physical');
      }
    }
    if (hasBranch(p, 'blood_fury', 'B') && dist(p, t) <= 1 && p.hp < p.maxHp / 2) this.healBy(null, p, 2);
    if (hasBranch(p, 'stomp', 'B') && this.entities.includes(t) && hasStatus(t, 'prone')) this.applyStatus(t, { id: 'dazed', turns: 1 }, p);
  }

  /** On-hit passives that put statuses on the target or heal allies. */
  private afterHit(p: PlayerEntity, t: Entity, element: Element, basic: boolean) {
    if (element === 'fire' && hasBranch(p, 'elemental_affinity', 'A')) this.applyStatus(t, { id: 'burning', turns: 2 }, p);
    this.engineAfterHit(p, t, element);
    if (hasBranch(p, 'psychic_blades', 'B') && t.kind === 'monster' && t.statuses.some((x) => !STATUSES[x.id].good)) this.applyStatus(t, { id: 'dazed', turns: 1 }, p);
    if (!basic) return;
    if (hasBranch(p, 'divine_strike', 'A')) this.applyStatus(t, { id: 'blinded', turns: 1 }, p);
    if (hasBranch(p, 'divine_strike', 'B')) {
      const hurt = this.heroes()
        .filter((h) => this.standing(h) && dist(h, p) <= 6 && h.hp < h.maxHp)
        .sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
      if (hurt) {
        const healed = this.healBy(p, hurt, rollDice({ n: 1, d: 4 }) + statMod(p, 'wis'));
        this.addLog('heal', `⚜️ Holy light from ${p.name}'s strike mends ${hurt === p ? 'themself' : hurt.name}: +${healed} HP.`);
      }
    }
  }

  private damage(t: Entity, amount: number, by?: Entity, element: Element = 'physical', area = false, field = false) {
    if (t.kind === 'monster' && !this.entities.includes(t)) return; // gone already (slain, or fled with its boss)
    // Catalyst: the battlefield's fire, poison, shocks and blasts that a hero set off hit monsters harder.
    const catalyst = field && by?.kind === 'player' && t.kind === 'monster' && !isAllyNpc(t) ? passiveOf(by, 'catalyst') : null;
    if (catalyst && amount > 0) amount = Math.round(amount * (1 + catalyst.value / 100));
    if (element === 'fire' && amount > 0 && hasStatus(t, 'webbed')) {
      t.statuses = t.statuses.filter((s) => s.id !== 'webbed');
      this.addLog('info', `🔥 The web around ${t.name} burns away.`);
      this.unrooted(t);
    }
    if (amount > 0) {
      // Resistances (monsters by kind, Attunement), Wet halves fire, Rage halves physical.
      const k = damageFactor(t, element);
      if (k === 0) {
        this.float(t, 'immune', '#9aa0a6');
        return;
      }
      if (k < 0) {
        const healed = Math.min(amount, t.maxHp - t.hp);
        t.hp += healed;
        this.addLog('heal', `${t.name} drinks in the ${element}: +${healed} HP.`);
        if (healed) this.float(t, `+${healed}`, '#7ddc6f');
        return;
      }
      // Spell Pierce: a wizard's spells go through resistances.
      const pierce = k === 0.5 && by?.kind === 'player' && !!this.casting && SKILLS[this.casting.id].kind === 'spell' && hasBranch(by, 'empowered_evocation', 'B');
      if (k !== 1 && !pierce) amount = Math.max(1, Math.floor(amount * k));
    }
    if (t.kind === 'player') {
      if (by && !area && amount > 1 && hasBranch(t, 'slippery', 'A') && !t.used.includes('round:dodge') && this.standing(t)) {
        t.used.push('round:dodge');
        amount = Math.ceil(amount / 2);
        this.addLog('info', `🐍 ${t.name} twists away: half damage.`);
      }
      const unsoaked = amount;
      amount = this.soakBlock(t, amount);
      if (amount < unsoaked && by?.kind === 'monster') this.spikes(t, by, unsoaked - amount, area);
      if (t.tempHp > 0) {
        const soaked = Math.min(t.tempHp, amount);
        t.tempHp -= soaked;
        amount -= soaked;
        if (soaked) this.float(t, `🛡${soaked}`, '#8fd8ff');
      }
      if (amount >= t.hp && this.standing(t) && this.phase === 'combat' && this.hasRelic('phoenix_feather') && !this.phoenixUsed) {
        this.phoenixUsed = true;
        t.hp = Math.ceil(t.maxHp / 2);
        this.addLog('crit', `🪶 The Phoenix Feather flares: ${t.name} rises from the blow with ${t.hp} HP!`);
        this.float(t, '🪶 REBORN', '#ffb04d');
        return;
      }
      if (amount >= t.hp && t.hp > 1 && this.standing(t) && hasBranch(t, 'battle_hardened', 'A') && !t.used.includes('fight:unbreakable')) {
        t.used.push('fight:unbreakable');
        amount = t.hp - 1;
        this.addLog('info', `🪨 ${t.name} refuses to fall!`);
      }
    }
    if (t.kind === 'monster') amount = this.soakBlock(t, amount);
    if (t.kind === 'monster' && (t.ward ?? 0) > 0 && amount > 0) {
      // Shielded: the ward takes it first.
      const soaked = Math.min(t.ward ?? 0, amount);
      t.ward = (t.ward ?? 0) - soaked;
      amount -= soaked;
      this.float(t, `🔰${soaked}`, '#8fd8ff');
      if (!t.ward) this.addLog('info', `🔰 ${t.name}'s ward shatters!`);
    }
    if (amount <= 0) return;
    if (t.kind === 'monster' && by?.kind === 'player') {
      t.dmgBy[by.id] = (t.dmgBy[by.id] ?? 0) + Math.min(amount, t.hp);
      if (this.fightStats && !isAllyNpc(t)) this.fightStats.dmg[by.name] = (this.fightStats.dmg[by.name] ?? 0) + Math.min(amount, t.hp);
    }
    const bloodied = t.hp < t.maxHp / 2;
    if (t.kind === 'player' && amount >= t.hp && this.unkillable(t)) amount = t.hp - 1;
    const dealt = Math.min(amount, t.hp);
    t.hp = Math.max(0, t.hp - amount);
    if (t.kind === 'monster' && by?.kind === 'player' && dealt > 0) this.drink(by, t, dealt, area);
    this.float(t, `-${amount}`, t.kind === 'player' || isAllyNpc(t) ? '#ff6b6b' : '#ffd84d');
    if (t.hp > 0) {
      if (!bloodied && t.hp < t.maxHp / 2 && hasTrait(t, 'enraged')) {
        this.addLog('crit', `😡 ${t.name} flies into a rage!`);
        this.float(t, '😡 ENRAGED', '#ff6b6b');
      }
      if (t.kind === 'player' && t.hp < t.maxHp * LOW_HP) this.callout(t, 'low'); // once per fight, if the bot gets the chance
      this.elementHit(t, element, by);
      return;
    }
    if (isAllyNpc(t)) {
      this.allyFalls(t, by);
    } else if (t.kind === 'monster') {
      this.monsterDies(t, by);
    } else if (!t.downed && !t.dead) {
      // Worn down: going down again in the same fight starts the death saves one failure worse each time, and a fourth
      // time is death. Hauled up groggy only to drop again (and again) used to loop forever.
      const again = Math.min(MAX_DOWNS - 1, t.used.filter((u) => u === 'fight:down').length);
      t.used.push('fight:down');
      if (this.fightStats) this.fightStats.downs++;
      t.downed = true;
      t.saves = { ok: 0, fail: again };
      t.statuses = [];
      delete t.block;
      t.savedAp = 0; // going down costs the AP saved up
      this.cancelWalk(t.id);
      if (!again) this.addLog('death', `🩸 ${t.name} falls unconscious! Heal them to get them back up.`);
      else if (again < MAX_DOWNS - 1) this.addLog('death', `🩸 ${t.name} falls unconscious again! Worn down: their death saves start with ${again} failure${again > 1 ? 's' : ''}.`);
      else this.addLog('death', `🩸 ${t.name} falls unconscious again, the ${MAX_DOWNS}th time this fight. It's too much.`);
      const mine = this.acting(t);
      if (again >= MAX_DOWNS - 1) this.die(t);
      else this.callout(this.randomBot(t), 'down', { ally: t.name });
      // Went down on their own turn (walked into the fire): their turn is over.
      if (mine && this.phase === 'combat') this.later(this.turnToken, 800, () => this.finishTurn(t));
    }
  }

  /** Unkillable: a Raging barbarian stays at 1 HP (Defy Death: once a fight without Rage too); it heals a little. */
  private unkillable(p: PlayerEntity): boolean {
    const u = passiveOf(p, 'unkillable');
    if (!u || p.hp <= 1) return false;
    const rage = p.statuses.find((x) => x.id === 'raging');
    if (!rage) {
      if (!hasBranch(p, 'unkillable', 'B') || p.used.includes('fight:defy')) return false;
      p.used.push('fight:defy');
    }
    this.addLog('crit', `💀 ${p.name} refuses to fall!`);
    this.float(p, '💀 unkillable', '#ffd84d');
    if (u.tier >= 2) this.later(this.turnToken, 0, () => this.healBy(null, p, rollDice({ n: 1, d: 8 })));
    if (rage && hasBranch(p, 'unkillable', 'A')) rage.power = (rage.power ?? 0) + 2;
    return true;
  }

  /** What an element does to a creature it hurts: cold chills then freezes, lightning shocks then stuns, fire thaws. */
  private elementHit(t: Entity, el: Element, by?: Entity) {
    if (!this.entities.includes(t) || this.phase !== 'combat') return;
    const wet = hasStatus(t, 'wet');
    if (el === 'fire') {
      t.statuses = t.statuses.filter((x) => x.id !== 'chilled' && x.id !== 'frozen');
    } else if (el === 'cold') {
      if (hasStatus(t, 'frozen')) return;
      if (wet || hasStatus(t, 'chilled')) {
        t.statuses = t.statuses.filter((x) => x.id !== 'chilled' && x.id !== 'wet');
        this.addLog('info', `🧊 ${t.name} freezes solid!`);
        this.applyStatus(t, { id: 'frozen', turns: 1 }, by);
        if (by?.kind === 'player') this.combo(by);
      } else this.applyStatus(t, { id: 'chilled', turns: FIELD_STATUS_TURNS }, by);
    } else if (el === 'lightning') {
      if (hasStatus(t, 'stunned')) return; // can't be stunned again while stunned
      if (wet || hasStatus(t, 'shocked')) {
        t.statuses = t.statuses.filter((x) => x.id !== 'shocked');
        this.addLog('info', `⚡ ${t.name} is stunned by the shock${wet ? ' (Wet)' : ''}!`);
        this.applyStatus(t, { id: 'stunned', turns: 1 }, by);
        if (by?.kind === 'player') this.combo(by);
      } else this.applyStatus(t, { id: 'shocked', turns: FIELD_STATUS_TURNS }, by);
    }
  }

  /** Convergence: setting off a combo on your own turn gives AP back, a few times a turn. */
  private combo(p: PlayerEntity) {
    const c = passiveOf(p, 'convergence');
    const a = this.acts(p);
    if (!c || !a || p.used.filter((u) => u === 'turn:combo').length >= c.value) return;
    p.used.push('turn:combo');
    const n = hasBranch(p, 'convergence', 'B') ? 2 : 1;
    a.ap += n;
    this.float(p, `🌈+${n} AP`, '#f6cf7a');
  }

  // ------------------------------------------------------------ the battlefield (shared/surfaces.ts)

  /**
   * Runs field operations for real: logs and pops up the reactions, blows up whoever is next to an explosion, and
   * affects everyone standing where something new appeared.
   */
  private runField(ops: FieldOp[], by?: Entity) {
    if (!ops.length || this.phase !== 'combat') return;
    const r = applyField(this, ops, by?.id);
    if (by?.kind === 'player' && r.reactions.length) this.combo(by);
    for (const x of r.reactions) {
      const info = REACTIONS[x.kind];
      const c = x.tiles.map((i) => tilePos(this, i));
      const mid = c[Math.floor(c.length / 2)];
      this.fx.push({ kind: 'float', x: mid.x, y: mid.y, text: info.text, color: info.color });
      if (x.kind === 'explode') for (const p of c.slice(0, 6)) this.fx.push({ kind: 'burst', x: p.x, y: p.y, radius: 1, color: info.color });
      this.addLog('info', `${info.text.split(' ')[0]} ${info.log}${x.tiles.length > 1 ? ` (${x.tiles.length} tiles)` : ''}!`);
    }
    const at = (e: Entity) => e.y * this.width + e.x;
    const blasts = new Set(r.blasts);
    for (const e of [...this.entities]) {
      if (!blasts.has(at(e)) || !this.entities.includes(e) || (e.kind === 'player' && !this.standing(e))) continue;
      const dmg = rollDice(EXPLOSION);
      this.addLog('hit', `💥 ${e.name} is caught in the explosion: ${dmg} fire.`);
      this.damage(e, dmg, by, 'fire', true, true);
    }
    const changed = new Set(r.changed);
    for (const e of [...this.entities]) if (changed.has(at(e))) this.standIn(e, 'appear');
  }

  /**
   * A creature meets the ground and cloud on its tile: when it steps in, starts its turn there, or something appears
   * under it. Returns true if it has to stop moving (it slipped, got stunned or went down).
   */
  private standIn(e: Entity, mode: 'step' | 'start' | 'appear'): boolean {
    const alive = () => this.entities.includes(e) && !(e.kind === 'player' && !this.standing(e));
    if (this.phase !== 'combat' || !alive()) return true;
    const stopped = () => hasStatus(e, 'stunned') || hasStatus(e, 'frozen');
    const wasStopped = stopped(); // stunned by the blow that's shoving it: it still flies the whole way
    const i = e.y * this.width + e.x;
    const g = this.ground[i];
    const c = this.clouds[i];
    const source = (id?: string) => this.entity(id);
    const zap = (by?: string) => {
      const dmg = rollDice(HAZARD_DICE.shock!);
      this.addLog('hit', `⚡ ${e.name} is shocked by the electrified ${g?.shock ? 'water' : 'steam'}: ${dmg} lightning.`);
      this.damage(e, dmg, source(by), 'lightning', true, true);
    };
    if (g) {
      if ((g.id === 'fire' || g.id === 'lava') && !immuneToStatus(e, 'burning')) {
        const dmg = rollDice(HAZARD_DICE[g.id]!);
        const where = g.id === 'lava' ? 'the lava' : 'the flames';
        this.addLog('hit', `🔥 ${e.name} ${mode === 'start' ? `is still in ${where}` : `is caught in ${where}`}: ${dmg} fire.`);
        this.damage(e, dmg, source(g.by), 'fire', true, true);
        if (alive()) this.applyStatus(e, { id: 'burning', turns: FIELD_STATUS_TURNS }, source(g.by));
      } else if (g.id === 'poison' && !immuneToStatus(e, 'poisoned')) {
        const dmg = rollDice(HAZARD_DICE.poison!);
        this.addLog('hit', `☠️ ${e.name} wades through poison: ${dmg} poison.`);
        this.damage(e, dmg, source(g.by), 'poison', true, true);
        if (alive()) this.applyStatus(e, { id: 'poisoned', turns: FIELD_STATUS_TURNS }, source(g.by));
      } else if (g.id === 'water') {
        this.applyStatus(e, { id: 'wet', turns: FIELD_STATUS_TURNS }, source(g.by));
        if (g.shock) zap(g.by);
      } else if (g.id === 'ice' && mode === 'step') {
        const { total, text } = this.creatureSave(e, 'dex');
        if (total < ICE_DC) {
          this.addLog('miss', `🧊 ${e.name} slips on the ice (DEX ${text} vs DC ${ICE_DC}) and loses the rest of the move.`);
          this.float(e, 'slipped!', '#cdefff');
          return true;
        }
      }
    }
    if (alive() && this.springTrap(e)) return true;
    if (c && alive()) {
      if (c.id === 'steam') {
        this.applyStatus(e, { id: 'wet', turns: FIELD_STATUS_TURNS }, source(c.by));
        if (c.shock) zap(c.by);
      } else if (c.id === 'gas' && !immuneToStatus(e, 'poisoned')) {
        if (!hasStatus(e, 'poisoned')) this.addLog('hit', `🤢 ${e.name} breathes in the poison gas.`);
        this.applyStatus(e, { id: 'poisoned', turns: FIELD_STATUS_TURNS }, source(c.by));
      }
    }
    return !alive() || (!wasStopped && stopped());
  }

  /** Kill credit, kill steals, XP shares and on-kill passives. */
  private monsterDies(t: MonsterEntity, by?: Entity) {
    this.slain++;
    this.entities = this.entities.filter((e) => e !== t);
    this.removeFromOrder(t.id);
    const killer = by?.kind === 'player' ? by : null;
    if (killer && t.elite) this.eliteKiller = killer.id;
    if (killer) this.engineKill(killer, t);
    if (killer) {
      killer.kills++;
      const total = Object.values(t.dmgBy).reduce((s, n) => s + n, 0);
      const mine = t.dmgBy[killer.id] ?? 0;
      const robbedId = Object.entries(t.dmgBy)
        .filter(([id]) => id !== killer.id)
        .sort((x, y) => y[1] - x[1])[0]?.[0];
      const robbed = this.heroes().find((h) => h.id === robbedId);
      if (robbed && total > 0 && mine / total < STEAL_SHARE) {
        killer.steals++;
        this.addLog('death', `💀 Kill steal! ${killer.name} snatches the ${t.name} from ${robbed.name}!`);
        this.float(killer, 'KILL STEAL!', '#ff9df0');
        this.callout(killer, 'steal', { target: t.name, ally: robbed.name });
      } else {
        this.addLog('death', `💀 ${t.name} is slain by ${killer.name}!`);
        this.callout(killer, 'kill', { target: t.name });
      }
    } else {
      this.addLog('death', `💀 ${t.name} is slain${isAllyNpc(by) ? ` by ${by.name}` : ''}!`);
    }
    const alive = this.heroes().filter((h) => !h.dead);
    const shares = killShares(t.risen ? 0 : MONSTERS[t.type].xp, killer?.id ?? null, t.dmgBy, alive.map((h) => h.id)); // the risen give no XP twice
    for (const [id, xp] of shares) {
      const h = this.heroes().find((x) => x.id === id);
      if (h) this.grantXp(h, xp);
    }
    if (killer && this.standing(killer)) this.onKill(killer);
    // A bloated zombie bursts into poison, a magma imp into fire.
    const death = MONSTERS[t.type].death;
    if (death && this.phase === 'combat') {
      this.addLog('info', `${t.glyph} ${t.name} ${death.text}!`);
      const area = tilesAround(this, t, death.radius);
      const ops: FieldOp[] = [];
      if (death.ground) ops.push({ kind: 'ground', tiles: area, id: death.ground });
      if (death.cloud) ops.push({ kind: 'cloud', tiles: area, id: death.cloud });
      if (this.deferredBursts) this.deferredBursts.push({ ops, by: killer ?? undefined });
      else this.runField(ops, killer ?? undefined);
    }
    // Rise Again: while the boss stands, a fallen minion gets back up later.
    const riser = !t.boss && !t.ally ? this.monsters().find((b) => b.boss && MONSTERS[b.type]?.signature === 'rise') : undefined;
    if (riser && this.turn) this.fallen.push({ type: t.type, x: t.x, y: t.y, at: this.turn.round + BOSS.riseAfter });
    // The boss is down: the rest lose heart and flee, and the fight is won.
    if (t.boss && !t.ally && this.phase === 'combat') {
      this.fallen = [];
      const rest = this.entities.filter((e): e is MonsterEntity => isFoe(e));
      for (const e of rest) {
        this.entities = this.entities.filter((x) => x !== e);
        this.removeFromOrder(e.id);
      }
      if (rest.length) this.addLog('system', `🏳️ With ${t.name} dead, the rest of them flee!`);
    }
  }

  /** An NPC ally at 0 HP leaves the party for good. Like a monster, its own turn notices and moves on. */
  private allyFalls(t: MonsterEntity, by?: Entity) {
    this.entities = this.entities.filter((e) => e !== t);
    this.removeFromOrder(t.id);
    if (this.run) this.run.allies = this.run.allies.filter((a) => a.name !== t.name);
    this.addLog('death', `💔 ${t.name} falls${by && by !== t ? ` to ${by.name}` : ''}, and won't be fighting with the party again.`);
  }

  private onKill(p: PlayerEntity) {
    if (this.hasRelic('vampire_fang')) {
      const healed = this.healBy(null, p, 3);
      if (healed) this.addLog('heal', `🦷 The Vampire Fang feeds ${p.name}: +${healed} HP.`);
    }
    const thirst = passiveOf(p, 'bloodthirsty');
    if (thirst) {
      const healed = this.healBy(null, p, thirst.value);
      if (healed) this.addLog('heal', `🩸 ${p.name} drinks in the victory: +${healed} HP.`);
      if (hasBranch(p, 'bloodthirsty', 'A')) this.addMoves(p, 3);
      if (hasBranch(p, 'bloodthirsty', 'B')) for (const h of this.heroes()) if (h !== p && this.standing(h)) this.healBy(null, h, 2);
    }
    const acts = this.acts(p);
    if (acts && hasBranch(p, 'opportunist', 'A') && !p.used.includes('turn:executioner')) {
      p.used.push('turn:executioner');
      acts.ap += 2;
      this.addLog('info', `🦊 Executioner! ${p.name} gets 2 AP back.`);
    }
    if (hasBranch(p, 'sentinel', 'B') && !p.used.includes('turn:cleave')) {
      const next = this.monsters().find((m) => dist(m, p) <= 1);
      if (next) {
        p.used.push('turn:cleave');
        this.addLog('info', `🪓 ${p.name} cleaves on into ${next.name}!`);
        this.freeStrike(p, next, 'Cleave');
      }
    }
  }

  /**
   * Heals a hero and returns how much HP they gained. Only a `revive` (healing spells, potions, scrolls, NPC healers)
   * gets a downed hero up, Groggy: they lose their next turn. Passives, auras and cantrips only heal the standing.
   * `healer` earns support XP and triggers healing passives when the target is someone else.
   */
  private healBy(healer: PlayerEntity | null, t: PlayerEntity, amount: number, overheal = false, revive = false): number {
    if (t.dead || (t.downed && !revive)) return 0;
    if (healer && hasBranch(healer, 'blessed_healer', 'B')) amount += 2; // Shepherd
    const room = t.maxHp - t.hp;
    const wasDown = t.downed;
    const wasLow = t.hp < t.maxHp / 2;
    t.hp = Math.min(t.maxHp, t.hp + amount);
    const healed = Math.min(amount, room);
    const grace = healer && this.phase === 'combat' ? passiveOf(healer, 'overflowing_grace') : null;
    if (overheal && amount > room && !grace) t.tempHp = Math.max(t.tempHp, amount - room);
    if (this.phase === 'combat' && amount > 0) this.healPayoffs(healer, t, amount - room, healed, wasLow);
    if (healed > 0) this.float(t, `+${healed}`, '#7ddc6f');
    if (t.downed && t.hp > 0) {
      this.getUp(t);
      this.addLog('heal', `${t.name} is back on their feet, but groggy: they lose their next turn.`);
    }
    if (healer && healer !== t && (healed > 0 || wasDown)) {
      if (wasDown) this.callout(healer, 'revive', { ally: t.name });
      this.callout(t, 'healed', { ally: healer.name });
    }
    if (healer && healer !== t) {
      const shepherd = hasBranch(healer, 'blessed_healer', 'B') ? 1.5 : 1;
      this.grantXp(healer, (healed * XP_HEAL + (wasDown ? XP_REVIVE : 0)) * shepherd);
      const self = passiveOf(healer, 'blessed_healer');
      if (self && healed > 0 && this.standing(healer) && healer.hp < healer.maxHp) {
        const back = Math.min(healer.maxHp - healer.hp, Math.ceil(healed * self.value));
        healer.hp += back;
        this.float(healer, `+${back}`, '#7ddc6f');
      }
      if (hasBranch(healer, 'blessed_healer', 'A')) this.applyStatus(t, { id: 'shielded', turns: 1, power: 2 }, healer);
    }
    return healed;
  }

  /**
   * What a heal also does, by engine: Overflowing Grace and Scar Tissue turn the overflow into Block, Radiant Recovery
   * shields, Soul Link heals the linked friend too, Font of Life gives AP to the badly hurt, Immortal Hunger feeds Rage.
   */
  private healPayoffs(healer: PlayerEntity | null, t: PlayerEntity, over: number, healed: number, wasLow: boolean) {
    if (!this.standing(t)) return;
    const grace = healer ? passiveOf(healer, 'overflowing_grace') : null;
    if (healer && grace) {
      const n = Math.max(Math.floor((Math.max(0, over) * grace.value) / 100), grace.tier >= 2 ? 2 : 0);
      if (n > 0) this.addBlock(t, healer, n);
      if (n > 0 && hasBranch(healer, 'overflowing_grace', 'B')) this.applyStatus(t, { id: 'shielded', turns: 1, power: 1 }, healer);
    }
    const scar = passiveOf(t, 'scar_tissue');
    if (scar && over > 0) this.addBlock(t, t, Math.floor((over * scar.value) / 100));
    if (!healer || healed <= 0) return;
    const recovery = passiveOf(healer, 'radiant_recovery');
    if (recovery) {
      this.addBlock(t, healer, Math.floor((healed * recovery.value) / 100));
      if (hasBranch(healer, 'radiant_recovery', 'B') && healer !== t && this.standing(healer)) healer.hp = Math.min(healer.maxHp, healer.hp + 2);
    }
    // Soul Link: everyone linked to this healer gets a share (no chain: it's a direct heal).
    for (const h of this.heroes()) {
      const link = h.statuses.find((x) => x.id === 'linked' && x.by === healer.id);
      if (!link || h === t || !this.standing(h) || h.hp >= h.maxHp) continue;
      const n = Math.min(h.maxHp - h.hp, Math.floor((healed * (link.power ?? 50)) / 100));
      if (n <= 0) continue;
      h.hp += n;
      this.float(h, `🔗+${n}`, '#7ddc6f');
    }
    const font = passiveOf(healer, 'font_of_life');
    if (font && healer !== t && wasLow && !t.used.includes(`round:font:${healer.id}`)) {
      t.used.push(`round:font:${healer.id}`);
      this.giveAp(t, font.value, healer);
      if (font.tier >= 2 && !hasBranch(healer, 'font_of_life', 'A') && !hasBranch(healer, 'font_of_life', 'B')) this.addMoves(t, 2);
      if (hasBranch(healer, 'font_of_life', 'B')) this.applyStatus(t, { id: 'shielded', turns: 1, power: 2 }, healer);
    }
    const hunger = passiveOf(t, 'immortal_hunger');
    const rage = t.statuses.find((x) => x.id === 'raging');
    if (hunger && rage && t.used.filter((u) => u === 'fight:hunger').length < hunger.value) {
      const n = hasBranch(t, 'immortal_hunger', 'B') ? 2 : 1;
      for (let i = 0; i < n; i++) t.used.push('fight:hunger');
      rage.power = (rage.power ?? 0) + n;
    }
  }

  /** Back up from 0 HP with someone's help: Groggy, so the next turn is lost (Smelling Salts add 5 HP). */
  private getUp(t: PlayerEntity) {
    t.downed = false;
    t.saves = { ok: 0, fail: 0 };
    if (this.hasRelic('smelling_salts')) t.hp = Math.min(t.maxHp, t.hp + 5);
    t.statuses = [...t.statuses.filter((x) => x.id !== 'groggy'), { id: 'groggy', turns: 1 }];
    this.float(t, '🥴 groggy', '#ffd84d');
  }

  /** 🤝 Help Up (everyone, 2 AP): a downed friend next to you gets back up at HELP_UP_HP of their max HP. */
  private helpUp(p: PlayerEntity, t: PlayerEntity) {
    if (!t.downed || t.dead) return;
    t.hp = Math.max(1, Math.ceil(t.maxHp * HELP_UP_HP));
    this.getUp(t);
    this.float(t, `+${t.hp}`, '#7ddc6f');
    this.addLog('heal', `🤝 ${p.name} hauls ${t.name} back to their feet (${t.hp} HP). ${t.name} is groggy and loses their next turn.`);
    this.grantXp(p, XP_REVIVE);
    this.callout(p, 'revive', { ally: t.name });
  }

  private deathSave(p: PlayerEntity) {
    let r = rollDie(20);
    if (r === 1 && this.useLucky(p, true)) r = rollDie(20);
    const bonus = (passiveOf(p, 'steady')?.value ?? 0) + gearBonus(p, 'saves');
    const total = r + bonus;
    const shown = `🎲${r}${bonus ? fmtMod(bonus) : ''}`;
    const getUp = (text: string) => {
      p.downed = false;
      p.hp = 1;
      p.saves = { ok: 0, fail: 0 };
      this.addLog('crit', text);
      this.float(p, 'BACK UP!', '#7ddc6f');
    };
    if (r === 20) return getUp(`✨ ${p.name} rolls a natural 20 on a death save and springs back up!`);
    if (total >= 15 && hasBranch(p, 'steady', 'B')) return getUp(`✨ ${p.name} defiantly gets back up (${shown})!`);
    if (total >= 10) {
      p.saves.ok++;
      this.addLog('info', `${p.name} death save: ${shown}, success (${p.saves.ok}/3)`);
      if (p.saves.ok >= 3) {
        p.downed = false;
        p.hp = 1;
        p.saves = { ok: 0, fail: 0 };
        this.addLog('heal', `${p.name} stabilizes and staggers up with 1 HP.`);
      }
      return;
    }
    p.saves.fail += r === 1 ? 2 : 1;
    this.addLog('death', `${p.name} death save: ${shown}, failure (${Math.min(3, p.saves.fail)}/3)`);
    if (p.saves.fail >= 3) this.die(p);
  }

  /** Three failed death saves (or going down a fourth time in one fight): out until the fight is won, then an Injury. */
  private die(p: PlayerEntity) {
    p.downed = false;
    p.dead = true;
    if (this.fightStats) this.fightStats.deaths++;
    this.addLog('death', `☠️ ${p.name} has died... they'll be back on their feet after the fight, if the party wins it.`);
    this.removeFromOrder(p.id);
  }

  // ------------------------------------------------------------ shops

  /** A merchant: everyone browses at once and spends the party's gold. Auto heroes shop once the people are done. */
  private startShop() {
    const run = this.run!;
    this.phase = 'shop';
    this.shop = { offers: this.stockShop(run.act), forgetPrice: FORGET_PRICE, trainPrice: trainPrice(run.act), done: [] };
    this.shopDeadline = null;
    this.shopReceipts = [];
    this.addLog('system', `🛒 A merchant spreads out their wares. The party has ${run.gold} gold.`);
    this.maybeCloseShop();
    this.broadcast();
  }

  private stockShop(act: number): ShopOffer[] {
    const gear = new Set<ItemId>();
    for (let i = 0; gear.size < 3 && i < 30; i++) gear.add(this.randomItem('gear', rollRarity(rng.next(), act)));
    const stock = new Set<ItemId>();
    for (let i = 0; stock.size < 3 && i < 30; i++) stock.add(this.randomItem('consumable', rollRarity(rng.next(), act)));
    const consumables = [...stock];
    const relic = this.rollRelics(1)[0];
    return [
      ...[...gear].map((id): ShopOffer => ({ kind: 'item', id, price: itemPrice(id), left: 1 })),
      ...consumables.map((id): ShopOffer => ({ kind: 'item', id, price: itemPrice(id), left: 2 })),
      ...(relic ? [{ kind: 'relic', id: relic, price: RELIC_PRICE, left: 1 } as ShopOffer] : []),
      { kind: 'potion', id: 'potion', price: POTION_PRICE, left: 3 },
    ];
  }

  handleShop(playerId: string, req: ShopRequest) {
    const p = this.hero(playerId);
    if (this.phase !== 'shop' || !this.shop || !p || !req || typeof req !== 'object') return;
    const err = this.shopAction(p, req);
    if (err) this.whisper(playerId, err);
    this.maybeCloseShop();
    this.broadcast();
  }

  /** One shop action for a hero. Returns why it failed, or null. */
  private shopAction(p: PlayerEntity, req: ShopRequest): string | null {
    const shop = this.shop!;
    const run = this.run!;
    switch (req.kind) {
      case 'buy': {
        const o = shop.offers[Number(req.offer)];
        if (!o || o.left <= 0) return 'Sold out.';
        if (o.price > run.gold) return `Not enough gold: it costs ${o.price}.`;
        if (o.kind === 'item') {
          if (!isItemId(o.id)) return 'Not for sale.';
          if (bagRoom(p) <= 0) return 'Your bag is full. Sell or give something first.';
          p.bag.push(o.id);
        } else if (o.kind === 'relic') {
          if (!isRelicId(o.id) || run.relics.includes(o.id)) return 'The party already has it.';
        } else p.potions++;
        o.left--;
        run.gold -= o.price;
        const what = o.kind === 'item' && isItemId(o.id) ? `${itemInfo(o.id).icon} ${itemInfo(o.id).name}` : o.kind === 'relic' && isRelicId(o.id) ? `${RELICS[o.id].icon} ${RELICS[o.id].name}` : '🧪 a potion';
        this.addLog('loot', `🛒 ${p.name} buys ${what} for ${o.price} gold.`);
        this.shopReceipts.push(`${p.name}: ${what}`);
        if (o.kind === 'relic' && isRelicId(o.id)) this.grantRelic(o.id);
        if (this.isAuto(p.playerId)) this.autoManage(p);
        return null;
      }
      case 'sell': {
        const i = isItemId(req.item) ? p.bag.indexOf(req.item) : -1;
        if (i < 0) return "That's not in your bag.";
        p.bag.splice(i, 1);
        run.gold += sellPrice(req.item);
        this.addLog('loot', `🛒 ${p.name} sells the ${itemInfo(req.item).name} for ${sellPrice(req.item)} gold.`);
        return null;
      }
      case 'forget': {
        const o = isSkillId(req.skill) ? p.skills.find((x) => x.id === req.skill) : undefined;
        if (!o || SKILLS[o.id].kind === 'basic' || isSignature(p, o.id)) return "You can't forget that.";
        if (shop.forgetPrice > run.gold) return `Not enough gold: it costs ${shop.forgetPrice}.`;
        p.skills = p.skills.filter((x) => x !== o);
        run.gold -= shop.forgetPrice;
        recalcHero(p);
        this.addLog('level', `🛒 ${p.name} pays ${shop.forgetPrice} gold to forget ${skillTitle(o)}.`);
        return null;
      }
      case 'train': {
        const choice: RestPick = { kind: 'train', skill: req.skill, ...(req.branch === 'A' || req.branch === 'B' ? { branch: req.branch } : {}) };
        const bad = isSkillId(req.skill) ? validRestPick(p, choice) : 'Unknown skill';
        if (bad) return bad;
        if (shop.trainPrice > run.gold) return `Not enough gold: it costs ${shop.trainPrice}.`;
        const tier = nextTier(p, req.skill);
        const res = tier ? upgrade(p, req.skill, tier, req.branch) : null;
        if (!res?.ok) return res?.error ?? "That skill can't be trained right now.";
        run.gold -= shop.trainPrice;
        this.addLog('level', `🛒 ${p.name} pays ${shop.trainPrice} gold for a lesson and ${res.text}.`);
        this.shopReceipts.push(`${p.name}: 📚 a lesson`);
        return null;
      }
      case 'done': {
        shop.done = shop.done.filter((id) => id !== p.playerId);
        if (req.done !== false) shop.done.push(p.playerId);
        return null;
      }
    }
    return 'Unknown action';
  }

  /**
   * Once every person is done shopping (or nobody is at the keyboard), the auto heroes shop and the party moves on.
   * Someone done starts a countdown for the rest; someone who dropped out (a reload) gets a short grace to come back.
   */
  private maybeCloseShop() {
    const shop = this.shop;
    if (this.phase !== 'shop' || !shop) return;
    const notDone = (h: PlayerEntity) => !shop.done.includes(h.playerId);
    const people = this.heroes().filter((h) => !this.isAuto(h.playerId));
    const away = this.heroes().filter((h) => {
      const info = this.players.find((x) => x.id === h.playerId);
      return !!info && !info.bot && !info.auto && !info.connected;
    });
    let wait: number | null = null;
    if (!people.some(notDone) && !away.some(notDone)) wait = AUTO_DELAY_MS / SPEED;
    else if (!people.some(notDone)) wait = AWAY_MS;
    else if (people.some((h) => !notDone(h))) wait = SHOP_MS;
    const deadline = wait === null ? null : Date.now() + wait;
    if (this.shopTimer && deadline !== null && this.shopDeadline !== null && this.shopDeadline <= deadline) return; // keep the sooner countdown
    if (this.shopTimer) clearTimeout(this.shopTimer);
    this.shopTimer = wait === null ? null : setTimeout(() => this.closeShop(), wait);
    this.shopDeadline = wait !== null && wait >= AWAY_MS ? deadline : null;
  }

  private closeShop() {
    const shop = this.shop;
    const run = this.run;
    if (this.phase !== 'shop' || !shop || !run) return;
    // Auto heroes take turns, one purchase each, so nobody empties the party's purse alone.
    const autos = this.heroes().filter((h) => this.isAuto(h.playerId) && !h.dead);
    for (let round = 0; round < 6; round++) {
      let bought = false;
      for (const h of autos) {
        const req = autoShopPick(h, shop, run.gold, this.heroes().length, run.relics);
        if (!req) continue;
        const err = this.shopAction(h, req);
        if (err) console.warn(`[auto shop ${h.name}] rejected: ${err}`);
        else bought = true;
      }
      if (!bought) break;
    }
    this.addLog('system', `🛒 ${this.shopReceipts.length ? `Bought: ${this.shopReceipts.join(', ')}.` : 'Nobody bought anything.'} The party moves on with ${run.gold} gold.`);
    this.toMap();
  }

  // ------------------------------------------------------------ inventory (any time outside a fight)

  handleItem(playerId: string, req: ItemRequest) {
    const p = this.hero(playerId);
    if (!p || !req || typeof req !== 'object') return;
    const err = this.itemAction(p, req);
    if (err) this.whisper(playerId, err);
    else this.checkpoint();
    this.broadcast();
  }

  /** Equip, unequip, give or drop. Returns why it failed, or null. */
  private itemAction(p: PlayerEntity, req: ItemRequest): string | null {
    if (!['map', 'event', 'rest', 'shop'].includes(this.phase)) return 'Not during a fight.';
    switch (req.kind) {
      case 'equip': {
        const g = isItemId(req.item) ? gearDef(req.item) : null;
        const i = g ? p.bag.indexOf(req.item) : -1;
        if (!g || i < 0) return "That's not gear in your bag.";
        const old = p.gear[g.slot];
        p.bag.splice(i, 1);
        p.gear[g.slot] = req.item;
        if (old) p.bag.push(old);
        recalcHero(p);
        this.addLog('info', `${g.icon} ${p.name} equips the ${g.name}.`);
        return null;
      }
      case 'unequip': {
        const id = p.gear[req.slot];
        if (!id) return 'Nothing to take off.';
        if (bagRoom(p) <= 0) return 'Your bag is full.';
        delete p.gear[req.slot];
        p.bag.push(id);
        recalcHero(p);
        return null;
      }
      case 'give': {
        const to = this.heroes().find((h) => h.id === req.to);
        if (!to || to === p || to.dead) return 'Give it to whom?';
        if (req.item === 'potion') {
          if (p.potions <= 0) return 'No potions left.';
          p.potions--;
          to.potions++;
          this.addLog('info', `🧪 ${p.name} gives ${to.name} a potion.`);
          return null;
        }
        const i = isItemId(req.item) ? p.bag.indexOf(req.item) : -1;
        if (i < 0) return "That's not in your bag.";
        if (bagRoom(to) <= 0) return `${to.name}'s bag is full.`;
        p.bag.splice(i, 1);
        to.bag.push(req.item);
        this.addLog('info', `🤝 ${p.name} gives ${to.name} the ${itemInfo(req.item).name}.`);
        if (this.isAuto(to.playerId)) this.autoManage(to);
        return null;
      }
      case 'drop': {
        const i = isItemId(req.item) ? p.bag.indexOf(req.item) : -1;
        if (i < 0) return "That's not in your bag.";
        p.bag.splice(i, 1);
        return null;
      }
    }
    return 'Unknown action';
  }

  // ------------------------------------------------------------ chat

  handleChat(playerId: string, text: string) {
    const info = this.players.find((p) => p.id === playerId);
    const msg = typeof text === 'string' ? text.trim().slice(0, 200) : '';
    if (!info || !msg) return;
    this.addLog('chat', `${info.name}: ${msg}`);
    this.broadcast();
  }

  // ------------------------------------------------------------ helpers

  private newId(): string {
    return `e${++this.idSeq}`;
  }

  private entity(id: string | undefined): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  private heroes(): PlayerEntity[] {
    return this.entities.filter((e): e is PlayerEntity => e.kind === 'player');
  }

  /** The monsters fighting the party (not the NPC allies). */
  private monsters(): MonsterEntity[] {
    return this.entities.filter((e): e is MonsterEntity => isFoe(e));
  }

  /** NPC allies in this fight. */
  private allies(): MonsterEntity[] {
    return this.entities.filter((e): e is MonsterEntity => isAllyNpc(e));
  }

  /** Still in the fight: a monster or NPC ally that's alive, or a hero who isn't down. */
  private up(e: Entity): boolean {
    return this.entities.includes(e) && (e.kind !== 'player' || this.standing(e));
  }

  private hero(playerId: string): PlayerEntity | undefined {
    return this.heroes().find((e) => e.playerId === playerId);
  }

  private standing(p: PlayerEntity): boolean {
    return !p.dead && !p.downed;
  }

  /** Is a tile blocked by a creature? Fallen heroes' graves can be walked over. */
  private occupied(x: number, y: number, exceptId?: string): boolean {
    return this.entities.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead));
  }

  private addLog(kind: LogKind, text: string) {
    if (this.told && kind !== 'chat' && kind !== 'say' && kind !== 'system') this.told.push(text);
    this.log.push({ id: ++this.logId, kind, text });
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.journal?.write({ k: 'log', kind, text, act: this.run?.act, round: this.phase === 'combat' ? this.turn?.round : undefined });
  }

  /** The run journal (server/journal.ts): a file per run, kept for analyzing how real games go. */
  private openJournal(resumed: boolean) {
    this.journal?.flush();
    this.journal = new Journal(this.code, this.createdAt);
    this.journal.write({
      k: 'start', code: this.code, resumed, difficulty: this.difficulty, monsterAi: this.monsterAi,
      party: this.players.map((p) => ({ name: p.name, classId: p.classId, bot: !!p.bot })),
    });
  }

  /** The party's HP as a share of its max HP (the downed and the dead count 0). */
  private partyHp(): number {
    const hs = this.heroes();
    const max = hs.reduce((n, h) => n + h.maxHp, 0);
    return max ? hs.reduce((n, h) => n + (h.downed || h.dead ? 0 : Math.max(0, h.hp)), 0) / max : 0;
  }

  /** A fight is over: its numbers go into the journal (before the breather heals anyone). */
  private journalFightEnd(won: boolean) {
    const f = this.fightStats;
    if (!f) return;
    this.fightStats = null;
    const r = (n: number) => Math.round(n * 100) / 100;
    this.journal?.write({ k: 'fightEnd', won, rounds: this.turn?.round ?? 1, downs: f.downs, deaths: f.deaths, startHp: r(f.startHp), minHp: r(Math.min(f.minHp, this.partyHp())), endHp: r(this.partyHp()), dmg: f.dmg });
  }

  /** A pick went through: which cards were on offer, and which one was taken. */
  private journalPick(p: PlayerEntity, offered: OfferCard[] | null, kind: string, req: PickRequest, text: string, auto: boolean) {
    this.journal?.write({ k: 'pick', hero: p.name, classId: p.classId, offerKind: kind, auto, offered: offered ?? [], card: Number(req.card), branch: req.branch, text });
  }

  private float(at: Pos, text: string, color: string) {
    if (this.phase === 'combat') this.fx.push({ kind: 'float', x: at.x, y: at.y, text, color });
  }

  private shot(from: Pos, to: Pos, color: string) {
    this.fx.push({ kind: 'shot', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, color });
  }

  private whisper(playerId: string, text: string) {
    this.io.to(`p:${playerId}`).emit('toast', text);
    // Bots have no screen to show it on; log it so rejected bot actions show up in tests.
    const info = this.players.find((p) => p.id === playerId);
    if (info?.bot) console.warn(`[bot ${info.name}] rejected: ${text}`);
  }

  /** Sends the state once per tick, no matter how many changes happened in it. */
  broadcast() {
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    queueMicrotask(() => {
      this.broadcastQueued = false;
      this.io.to(this.code).emit('state', this.snapshot());
      if (this.fx.length) {
        this.io.to(this.code).emit('fx', this.fx);
        this.fx = [];
      }
    });
  }

  private snapshot(): GameState {
    const v = this.vote;
    const e = this.event;
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      resume: this.resumeFrom && {
        act: this.resumeFrom.run.act,
        actName: this.resumeFrom.run.actName,
        savedAt: this.resumeFrom.savedAt,
        heroes: this.resumeFrom.heroes.map((h) => ({
          playerId: h.playerId, name: h.name, classId: h.classId, level: h.level,
          bot: !!this.players.find((p) => p.id === h.playerId)?.bot,
        })),
      },
      difficulty: this.diff,
      monsterAi: this.monsterAiNow,
      ppoReady: !!monsterPolicy(),
      run: this.run,
      vote: v && { kind: v.kind, options: v.options, votes: v.votes, endsInMs: v.deadline === null ? null : Math.max(0, v.deadline - Date.now()) },
      event: e && {
        title: e.title,
        glyph: e.glyph,
        text: e.text,
        choices: e.choices.map((c) => ({ id: c.id, label: c.label, hint: this.checkOdds(c.hint) ?? (c.cost ? `Costs ${c.cost} gold` : undefined) })),
        ...(e.chosen ? { chosen: e.chosen } : {}),
        ...(e.lines ? { lines: e.lines } : {}),
      },
      rest: this.restPicks && {
        picks: this.restPicks,
        endsInMs: this.restDeadline === null ? null : Math.max(0, this.restDeadline - Date.now()),
        autoInMs: this.restAutoAt === null ? null : Math.max(0, this.restAutoAt - Date.now()),
      },
      autoPicks: Object.fromEntries([...this.pickAt].map(([id, at]) => [id, Math.max(0, at - Date.now())])),
      shop: this.shop && { ...this.shop, endsInMs: this.shopDeadline === null ? null : Math.max(0, this.shopDeadline - Date.now()) },
      approach: this.approachDc === null ? null : { dc: this.approachDc },
      notice: this.notice,
      roomKind: this.roomKind,
      width: this.width,
      height: this.height,
      tiles: this.tiles,
      ground: this.ground,
      clouds: this.clouds,
      props: this.props,
      traps: Object.fromEntries([...this.traps].map(([i, t]) => [i, { by: t.by, icon: '🪤' }])),
      players: this.players,
      entities: this.entities,
      turn: this.turn,
      log: this.log,
    };
  }
}

const elementWord = (e?: Element) => (e && e !== 'physical' ? ` ${e}` : '');
