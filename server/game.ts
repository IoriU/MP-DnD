// One game room. The server is the Dungeon Master: it owns the state, rolls every die,
// runs the monsters and broadcasts a snapshot to everyone in the room after each change.
//
// A run: 3 acts. Each act is a node map the party votes its way up; fights happen in small rooms.
// Heroes earn XP (killing blows earn extra), level up and pick upgrades; skills are data in shared/skills.ts.

import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { canStep, dist, findPath, hasLOS } from '../shared/grid.ts';
import {
  ACTS,
  ACT_ROWS,
  AMBUSH_CHANCE,
  BREATH_DC,
  CLASSES,
  CLASS_IDS,
  AP_GAIN,
  AP_MAX,
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
  VOTE_MS,
  XP_BUFF,
  XP_CATCH_UP,
  XP_HEAL,
  XP_REVIVE,
  encounterBudget,
  fmtMod,
  isDifficulty,
  isMonsterAi,
  partyScaling,
  rollDice,
  rollDie,
  roomGold,
  scaledHp,
  sneakDice,
  statMod,
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
  attackBonus,
  avgDice,
  damageMod,
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
  slotCost,
  statsAt,
  statsOf,
  type AimResult,
  type Element,
  type SkillId,
  type SkillStats,
  type StatusApply,
  type StatusId,
} from '../shared/skills.ts';
import {
  BLESSINGS,
  BLESSING_IDS,
  CONSUMABLE_IDS,
  ELITE_GEAR,
  FORGET_PRICE,
  ITEMS,
  GEAR_IDS,
  POTION_PRICE,
  RELICS,
  RELIC_IDS,
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
  Notice,
  OwnedSkill,
  Phase,
  PickRequest,
  PlayerEntity,
  PlayerInfo,
  Pos,
  RestPick,
  RunInfo,
  TurnState,
} from '../shared/types.ts';
import { attackAdvantage, canReact, dirTo, netAdvantage, turnsToFace } from '../shared/tactics.ts';
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
import { SUBCLASS_LEVEL } from '../shared/subclasses.ts';
import { pick, randInt, rng, shuffle } from './rng.ts';
import { generateRoom } from './room.ts';
import { SAVE_VERSION, archiveSave, dumpFight, writeSave, type SaveFile, type SavePoint } from './saves.ts';

/**
 * Chooses a monster's move from the options the monster AI lists (Phase 11): the trained PPO policy, or the RL
 * trainer itself (training/env.ts). Returns the option's index.
 */
export type MonsterBrain = (m: MonsterEntity, choices: MonsterChoices) => number | Promise<number>;

// Dev knobs for bot testing: DELVERS_SPEED=10 makes monster turns 10x faster, DELVERS_ROWS=4 makes acts short.
const SPEED = Math.max(0.1, Number(process.env.DELVERS_SPEED) || 1);
const ROWS = Math.max(3, Number(process.env.DELVERS_ROWS) || ACT_ROWS);

const STEP_MS = 120 / SPEED; // player walking speed
const MONSTER_STEP_MS = 170; // passed through sleep(), which applies SPEED
const LOG_LIMIT = 80;
const MAX_ROOM_MONSTERS = 6;
const POST_FIGHT_HEAL = 0.2; // short rest after every won fight, so damage doesn't snowball into a wipe
const AUTO_DELAY_MS = 700; // pause before auto heroes vote, pick or use potions between rooms
const SHOP_MS = 90_000; // the shop closes this long after the first person is done shopping
const AWAY_MS = 20_000; // ...or this long after everyone left is someone who dropped out (a reload shouldn't close it)
/** The icon a pick's log line starts with, by kind. */
const PICK_ICON = { level: '⬆️', elite: '💀', reward: '🏆' } as const;
const SHOP_GEAR: Record<number, Rarity[]> = { 1: ['common', 'common', 'uncommon'], 2: ['common', 'uncommon', 'uncommon', 'rare'], 3: ['uncommon', 'rare', 'rare'] };

const ELEMENT_COLOR: Record<Element, string> = {
  physical: '#ffe9a8', fire: '#ff8a3d', cold: '#8fd8ff', lightning: '#fff36b', poison: '#8fdc5a', radiant: '#ffe27a', force: '#c58bff',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / SPEED));

interface Walk {
  path: Pos[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface Vote {
  kind: 'path' | 'event' | 'approach';
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
  private heroTurnToken = -1; // the turn an auto hero is currently playing
  private event: EventDef | null = null;
  private seenEvents: string[] = [];
  private notice: Notice | null = null;
  private roomKind: NodeType | null = null;
  private lastChecker: string | null = null; // hero who made the last event check
  private entities: Entity[] = [];
  private turn: TurnState | null = null;
  private turnOwner: string | null = null; // whose turn it is (stays set even if they're removed mid-turn)
  private heldMoves = 0; // the turn's movement, held back while it's stuck in a net or a web (Cut Free gives it back)
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
    if (info.auto && e && this.current()?.id === e.id) this.runHero(e, this.turnToken);
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
        if (this.current()?.id === e.id) {
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

  /** Stops everything time-based: walks, monster turns, turn timers, the vote and the rest site. */
  dispose() {
    this.cancelAllWalks();
    this.turnToken++;
    this.turn = null;
    this.turnOwner = null;
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
    this.restPicks = null;
    this.restDeadline = null;
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

  /** A hero joining a run in progress starts at the party's level, with a pick for every level they missed (and the subclass). */
  private newcomer(info: PlayerInfo, level: number): PlayerEntity {
    const e = this.makePlayer(info, level);
    e.rewardPicks = level - 1;
    e.levelUps = level >= SUBCLASS_LEVEL ? 1 : 0;
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
    else if (save.at.kind === 'reward') this.eliteReward(save.at.text, save.at.choices);
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
    this.dispose();
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
      if (vote.kind === 'path') this.autoUpkeep(); // before the party moves on (its own timer would fire too late)
      const heroes = this.heroes();
      for (const p of this.players) {
        if (this.vote !== vote) return; // the vote resolved along the way
        if (vote.votes[p.id]) continue;
        const choice =
          vote.kind === 'path'
            ? autoPathChoice(vote.options.map((id) => ({ id, type: this.node(id)?.type ?? 'combat' })), heroes)
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
    if (v.deadline === null && v.options.length > 1) {
      v.deadline = Date.now() + VOTE_MS;
      this.voteTimer = setTimeout(() => this.resolveVote(), VOTE_MS);
    }
    if (v.options.length === 1) this.resolveVote();
    else this.maybeResolveVote();
    this.broadcast();
  }

  /** Resolves early once every human has voted. Auto heroes follow the humans' choice and don't vote. */
  private maybeResolveVote() {
    const v = this.vote;
    if (!v) return;
    const voters = this.humans();
    if (voters.length && voters.every((p) => v.votes[p.id])) this.resolveVote();
  }

  private resolveVote() {
    const v = this.vote;
    if (!v) return;
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

  private enterNode(id: string, eventId?: string) {
    const run = this.run;
    const node = this.node(id);
    if (!run || !node) return;
    // Saved before anything changes, so a restart replays this node from its start.
    this.savePoint = { kind: 'node', nodeId: id };
    this.checkpoint();
    run.currentId = id;
    if (run.visited.at(-1) !== id) run.visited.push(id); // a resumed node is already on the list
    this.notice = null;
    switch (node.type) {
      case 'combat':
      case 'elite':
      case 'boss': {
        const fight = this.encounterFor(node);
        // Regular fights past the first rows are sometimes ambushes; bosses are expecting you.
        const ambush = node.type === 'combat' && node.row >= 2 && rng.chance(AMBUSH_CHANCE);
        this.startRoom(node.type, fight.monsters, fight.name, node.type === 'boss' ? 'charge' : ambush ? 'ambush' : 'vote');
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
  private encounterFor(node: MapNode): { name: string; monsters: string[] } {
    const run = this.run!;
    const act = ACTS[run.act - 1];
    const size = this.heroes().length;
    if (node.type === 'boss') {
      return { name: MONSTERS[act.boss].name, monsters: [act.boss, ...Array.from({ length: Math.floor(size / 2) }, () => pick(act.minions))] };
    }
    let budget = encounterBudget(run.act, node.row, size) * DIFFICULTIES[this.diff].budget;
    let name: string;
    let draw: string[];
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
    return { name, monsters };
  }

  /** Gold, and the party votes on one of three relics. The gold comes with the choice, so a restart can't pay out twice. */
  private treasure() {
    const run = this.run!;
    const gold = this.goldFound(randInt(25, 40) * run.act);
    const choices = shuffle(RELIC_IDS.filter((id) => RELICS[id].rarity !== 'boss' && !run.relics.includes(id))).slice(0, 3);
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

  /** A random item of one of these rarities (gear or consumable). */
  private randomItem(kind: 'gear' | 'consumable', rarities: Rarity[]): ItemId {
    const ids = kind === 'gear' ? GEAR_IDS : CONSUMABLE_IDS;
    const want = pick(rarities);
    const pool = ids.filter((id) => ITEMS[id].rarity === want);
    return pick(pool.length ? pool : ids);
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

  private finishAct() {
    const run = this.run!;
    if (run.act >= MAX_ACT) return this.endRun(true);
    run.act++;
    const def = ACTS[run.act - 1];
    run.actName = def.name;
    run.map = generateActMap(run.act, run.seed, ROWS);
    run.currentId = null;
    run.visited = [];
    // The act boss leaves a relic behind, and the act's blessings fade.
    const boss = shuffle(RELIC_IDS.filter((id) => RELICS[id].rarity === 'boss' && !run.relics.includes(id)))[0];
    if (boss) this.grantRelic(boss);
    const faded = run.blessings.length > 0;
    run.blessings = [];
    this.syncPerks();
    for (const p of this.heroes()) {
      p.hp = p.maxHp;
      p.slots = p.maxSlots;
    }
    this.addLog('system', `🏆 Act ${run.act - 1} complete! The party recovers fully (HP and every slot) and presses on to Act ${run.act}: ${def.name}.`);
    this.notice = {
      glyph: def.glyph,
      title: `Act ${run.act}: ${def.name}`,
      text: `Everyone is fully healed and every slot is restored.${boss ? ` The boss dropped the ${RELICS[boss].icon} ${RELICS[boss].name}: ${RELICS[boss].desc}` : ''}${faded ? " The last act's blessings fade." : ''} The ${MONSTERS[def.boss].name} waits at the top of the map.`,
    };
    this.toMap();
  }

  // ------------------------------------------------------------ rest sites

  /** Every hero picks Long Rest or Train at the same time; undecided heroes take a Long Rest when the timer runs out. */
  private startRest() {
    this.phase = 'rest';
    this.restPicks = {};
    this.restDeadline = null;
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

  private scheduleAutoRest() {
    setTimeout(() => {
      const picks = this.restPicks;
      if (this.phase !== 'rest' || !picks) return;
      for (const h of this.heroes()) {
        if (this.isAuto(h.playerId) && !picks[h.playerId]) this.handleRest(h.playerId, autoRestPick(h, this.heroes()));
      }
    }, AUTO_DELAY_MS / SPEED);
  }

  private resolveRest() {
    const picks = this.restPicks;
    if (this.phase !== 'rest' || !picks) return;
    const lines: string[] = [];
    for (const p of this.heroes()) {
      const choice = picks[p.playerId] ?? { kind: 'long' };
      if (choice.kind === 'train') {
        const tier = nextTier(p, choice.skill);
        const res = tier ? upgrade(p, choice.skill, tier, choice.branch) : null;
        if (res?.ok) {
          this.addLog('level', `🏋️ ${p.name} trains by the fire and ${res.text}.`);
          lines.push(`${p.name} trained and ${res.text}`);
          continue;
        }
      }
      p.hp = Math.min(p.maxHp, p.hp + Math.ceil(p.maxHp * REST_HEAL));
      p.slots = p.maxSlots;
      this.addLog('heal', `🔥 ${p.name} takes a Long Rest: +${Math.round(REST_HEAL * 100)}% HP and every slot restored.`);
      lines.push(`${p.name} took a Long Rest`);
    }
    this.notice = { glyph: '🔥', title: 'Rest site', text: `${lines.join('. ')}.` };
    this.toMap();
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
      this.addLog('level', `⬆️ ${p.name} reaches level ${p.level}!${p.levelUps && !p.subclass ? ' Time to choose a subclass.' : ''}`);
      this.callout(p, 'level', {}, 'after');
    }
    this.scheduleAutoPicks();
    return names;
  }

  /** Auto heroes take their level-up picks on their own. */
  private scheduleAutoPicks() {
    if (!this.heroes().some((p) => p.offer && this.isAuto(p.playerId))) return;
    setTimeout(() => {
      for (const p of this.heroes()) {
        for (let guard = 0; guard < 16 && p.offer && picksLeft(p) > 0 && this.isAuto(p.playerId); guard++) {
          const icon = PICK_ICON[p.offerKind ?? 'level'];
          const res = applyPick(p, autoLevelPick(p), rng, this.run?.act ?? 1);
          if (!res.ok) {
            console.warn(`[auto pick ${p.name}] rejected: ${res.error}`);
            break;
          }
          this.addLog('level', `${icon} ${p.name} ${res.text}.`);
          this.autoManage(p); // gear from elite spoils
        }
      }
      this.checkpoint();
      this.broadcast();
    }, AUTO_DELAY_MS / SPEED);
  }

  handlePick(playerId: string, req: PickRequest) {
    const p = this.hero(playerId);
    if (!p?.offer || this.phase === 'lobby' || this.phase === 'victory' || this.phase === 'defeat') return;
    const icon = PICK_ICON[p.offerKind ?? 'level'];
    const res = applyPick(p, { card: Number(req?.card), branch: req?.branch, forget: req?.forget }, rng, this.run?.act ?? 1);
    if (!res.ok) return this.whisper(playerId, res.error);
    this.addLog('level', `${icon} ${p.name} ${res.text}.`);
    this.checkpoint();
    this.broadcast();
  }

  // ------------------------------------------------------------ events

  /** Opens an event: a fresh one, or the same one again when a save is resumed mid-event. */
  private startEvent(eventId?: string, scene?: EventDef) {
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
    for (const effect of outcome.effects) {
      if (effect.kind === 'fight') fight = effect;
      else this.applyEffect(effect);
    }
    this.event = null;
    this.notice = { glyph: def.glyph, title: def.title, text: outcome.text };
    if (fight) this.startRoom(fight.elite ? 'elite' : 'combat', fight.monsters.filter((m) => Object.hasOwn(MONSTERS, m)), def.title);
    else this.toMap();
  }

  /** d20 + the best modifier in the party for that stat. */
  private eventCheck(stat: EventStat, dc: number): CheckResult {
    const hero = this.heroes()
      .filter((p) => !p.dead)
      .sort((a, b) => CLASSES[b.classId].mods[stat] - CLASSES[a.classId].mods[stat])[0];
    const mod = hero ? CLASSES[hero.classId].mods[stat] : 0;
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
      case 'gold':
        run.gold = Math.max(0, run.gold + effect.amount);
        break;
      case 'potions':
        this.giveSharedPotions(effect.amount);
        break;
      case 'relic':
        if (isRelicId(effect.id)) this.grantRelic(effect.id);
        break;
      case 'item': {
        const id = effect.id && isItemId(effect.id) ? effect.id : this.randomItem(effect.gear ? 'gear' : 'consumable', [effect.rarity ?? 'common']);
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
        break;
      case 'restoreSlots':
        for (const p of heroes) p.slots = p.maxSlots;
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
  private startRoom(kind: NodeType, monsters: string[], name: string, start: 'vote' | 'ambush' | 'charge' = 'charge') {
    this.dispose();
    const layout = generateRoom(kind, rng, this.run?.act ?? 1);
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
    this.entities = heroes;
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
    // Each side starts out looking at the other.
    const centre = (es: Entity[]) => ({ x: es.reduce((a, e) => a + e.x, 0) / es.length, y: es.reduce((a, e) => a + e.y, 0) / es.length });
    const foes = centre(this.monsters());
    const party = centre(heroes);
    for (const h of [...heroes, ...this.allies()]) this.face(h, foes);
    for (const m of this.monsters()) this.face(m, party);
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

  private spawnMonster(type: string, pos: Pos, partySize: number): MonsterEntity {
    const def = MONSTERS[type];
    const boss = ACTS.some((a) => a.boss === type);
    const elite = !boss && (ACTS.some((a) => a.elites.includes(type)) || type === 'mimic');
    // Bigger parties: regular monsters get more HP (elites and bosses have their own curve), everyone hits harder.
    const d = DIFFICULTIES[this.diff];
    const party = partyScaling(partySize);
    const hp = Math.max(1, Math.round((boss || elite ? scaledHp(def.hp, partySize, boss) : def.hp * party.hp) * d.hp));
    const dmg = d.dmg + Math.round(avgDice(def.dmg) * (party.dmg - 1));
    const m: MonsterEntity = {
      id: this.newId(), kind: 'monster', type, name: def.name, glyph: def.glyph, x: pos.x, y: pos.y,
      hp, maxHp: hp, ac: def.ac, speed: def.speed, boss, elite, statuses: [], dmgBy: {}, facing: { x: -1, y: 0 },
      ...(d.atk ? { atkBonus: d.atk } : {}), ...(dmg ? { dmgBonus: dmg } : {}),
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
    if (!p || !this.canMove(p) || !Number.isInteger(target?.x) || !Number.isInteger(target?.y)) return;
    if (!this.turn) return;
    if (this.turn.movesLeft <= 0) return this.whisper(playerId, 'No movement left. Use an action or end your turn.');
    // Around fire, poison and the like when that still gets there; the client warns before walking through.
    const plan = planWalk(this, p, target, this.turn.movesLeft, (x, y) => this.occupied(x, y, p.id), p);
    if (!plan?.path.length) return;
    this.startWalk(p, plan.path);
  }

  handleStep(playerId: string, dx: number, dy: number) {
    const p = this.hero(playerId);
    if (!p || !this.canMove(p) || ![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || (dx === 0 && dy === 0)) return;
    this.cancelWalk(p.id);
    if (this.turn && this.turn.movesLeft <= 0) return this.whisper(playerId, 'No movement left. Use an action or end your turn.');
    this.tryMove(p, { x: p.x + dx, y: p.y + dy });
  }

  private canMove(p: PlayerEntity): boolean {
    return this.standing(p) && this.phase === 'combat' && this.current()?.id === p.id && !hasStatus(p, 'stunned') && !hasStatus(p, 'frozen');
  }

  private startWalk(p: PlayerEntity, path: Pos[]) {
    this.cancelWalk(p.id);
    const walk: Walk = { path: [...path], timer: null };
    this.walks.set(p.id, walk);
    const step = () => {
      walk.timer = null;
      if (this.walks.get(p.id) !== walk) return;
      const next = walk.path.shift();
      const moved = next ? this.tryMove(p, next) : false;
      if (!moved || !walk.path.length || this.walks.get(p.id) !== walk) {
        if (this.walks.get(p.id) === walk) this.walks.delete(p.id);
        return;
      }
      walk.timer = setTimeout(step, STEP_MS);
    };
    step();
  }

  private cancelWalk(entityId: string) {
    const w = this.walks.get(entityId);
    if (w?.timer) clearTimeout(w.timer);
    this.walks.delete(entityId);
  }

  private cancelAllWalks() {
    for (const id of [...this.walks.keys()]) this.cancelWalk(id);
  }

  /** Moves one tile on your turn. Returns false if it couldn't. */
  private tryMove(p: PlayerEntity, next: Pos): boolean {
    if (!this.canMove(p) || !this.turn || this.turn.movesLeft <= 0 || ROOTED.some((id) => hasStatus(p, id))) return false;
    const dx = next.x - p.x;
    const dy = next.y - p.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1 || !canStep(this, p, dx, dy) || this.occupied(next.x, next.y, p.id)) return false;
    this.turn.movesLeft--;
    p.facing = { x: dx, y: dy };
    p.x = next.x;
    p.y = next.y;
    this.watch(p);
    if (this.standIn(p, 'step') && this.turn) this.turn.movesLeft = 0; // slipped on ice, stunned, or down
    if (!this.standing(p)) this.cancelWalk(p.id);
    this.checkEnd();
    this.broadcast();
    return true;
  }

  // ------------------------------------------------------------ turns

  private initBonus(e: Entity): number {
    if (e.kind === 'monster') return MONSTERS[e.type].dex + (hasTrait(e, 'swift') ? 5 : 0);
    return CLASSES[e.classId].mods.dex + (passiveOf(e, 'alert')?.value ?? 0) + gearBonus(e, 'init');
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
  }

  private startCombat() {
    this.phoenixUsed = false;
    this.traps.clear();
    this.eliteKiller = null;
    for (const p of this.heroes()) this.prepareForFight(p);
    const fighters: Entity[] = [...this.heroes().filter((p) => !p.dead), ...this.allies(), ...this.monsters()];
    const init: Record<string, number> = {};
    for (const e of fighters) init[e.id] = rollDie(20) + this.initBonus(e);
    const order = fighters.map((e) => e.id).sort((a, b) => init[b] - init[a]); // stable: players win ties
    this.turn = { order, init, index: 0, round: 1, movesLeft: 0, ap: 0 };
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
    const i = t.order.indexOf(id);
    if (i < 0) return;
    t.order.splice(i, 1);
    if (i <= t.index) t.index--;
  }

  private current(): Entity | undefined {
    const t = this.turn;
    return t ? this.entity(t.order[t.index]) : undefined;
  }

  private beginTurn() {
    const t = this.turn;
    if (!t || this.phase !== 'combat') return;
    const token = ++this.turnToken;
    const e = this.current();
    if (!e) return this.advanceTurn();
    this.turnOwner = e.id;
    t.movesLeft = (SLOWED.some((id) => hasStatus(e, id)) ? Math.floor(e.speed / 2) : e.speed) + (hasStatus(e, 'charging') ? CHARGE_MOVES : 0);
    t.ap = 0; // heroes get theirs below, once it's clear they get to act
    // The Block this creature gave runs out (on itself and on friends); then shields and gear put up this turn's.
    this.dropBlock(e.id);
    if (e.kind === 'player' && e.dead) return this.advanceTurn();
    const wall = e.kind === 'player' ? (this.standing(e) ? gearBonus(e, 'block') : 0) : (MONSTERS[e.type]?.block ?? 0);
    if (wall > 0) this.addBlock(e, e, wall, false);
    if (hasStatus(e, 'prone')) {
      // Getting back up costs half its movement.
      e.statuses = e.statuses.filter((s) => s.id !== 'prone');
      if (!(e.kind === 'player' && e.downed)) {
        t.movesLeft = Math.floor(t.movesLeft / 2);
        this.addLog('info', `🤕 ${e.name} gets back up.`);
      }
    }
    this.heldMoves = 0;
    if (ROOTED.some((id) => hasStatus(e, id))) [this.heldMoves, t.movesLeft] = [t.movesLeft, 0];
    if (e.kind === 'monster') {
      if (e.trickCd) e.trickCd--;
      if (e.orderCd) e.orderCd--;
    }

    if (e.kind === 'player' && !e.downed) this.heroTurnStart(e);
    this.tickStatuses(e);
    this.standIn(e, 'start'); // still in the fire, the poison, the water...
    if (this.checkEnd()) return;
    if (!this.entities.includes(e)) return this.advanceTurn(); // burned to death
    if (e.kind === 'player' && e.dead) return this.advanceTurn();
    if (e.kind === 'monster' && e.traits?.length) {
      this.eliteTurnStart(e);
      if (this.checkEnd()) return;
      if (!this.entities.includes(e)) return this.advanceTurn();
    }

    if (e.kind === 'player' && e.downed) {
      this.deathSave(e);
      if (e.downed) this.later(token, 1000, () => this.advanceTurn());
      // A great death save gets them back up mid-turn: auto heroes still need someone to play it.
      else if (!e.dead) {
        this.grantAp(e);
        if (this.isAuto(e.playerId)) this.runHero(e, token);
      }
    } else if (hasStatus(e, 'surprised')) {
      this.addLog('info', `😱 ${e.name} is caught by surprise and loses the turn.`);
      this.float(e, 'surprised!', '#ffd84d');
      this.later(token, 900, () => this.advanceTurn());
    } else if (hasStatus(e, 'stunned')) {
      this.addLog('info', `💫 ${e.name} is stunned and loses the turn.`);
      this.float(e, 'stunned', '#ffd84d');
      this.later(token, 900, () => this.advanceTurn());
    } else if (hasStatus(e, 'frozen')) {
      this.addLog('info', `🧊 ${e.name} is frozen solid and loses the turn.`);
      this.float(e, 'frozen', '#cdefff');
      this.later(token, 900, () => this.advanceTurn());
    } else if (e.kind === 'monster') {
      this.runMonster(e, token).catch((err) => console.error('monster AI error', err));
    } else {
      this.grantAp(e);
      if (this.isAuto(e.playerId)) this.runHero(e, token);
    }
    this.broadcast();
  }

  /** The hero skill being resolved right now (Empowered Evocation, Sculpt Spells, Blessed Smites read it). */
  private casting: { id: SkillId; s: SkillStats } | null = null;
  /** Hidden snares (Ranger Trapper), by tile: the first monster to step in gets it. `cast` orders them (3 casts each). */
  private traps = new Map<number, { by: string; cast: number; status: StatusApply[]; dmg?: Dice }>();
  private trapCasts = 0;

  /** 🧱 Block from `by` (until the start of its next turn), on top of what the target has. */
  private addBlock(t: Entity, by: Entity, n: number, show = true) {
    if (n <= 0) return;
    (t.block ??= {})[by.id] = (t.block[by.id] ?? 0) + n;
    if (show) this.float(t, `🧱+${n}`, '#c8d1dc');
  }

  /** A hero's skill puts up Block (the dice, plus their level for some), with a line in the log. */
  private blockFrom(p: PlayerEntity, t: Entity, dice: Dice, level?: boolean) {
    const n = rollDice(dice) + (level ? p.level : 0);
    this.addBlock(t, p, n);
    this.addLog('info', t === p ? `🧱 ${p.name} gets ${n} Block until their next turn.` : `🧱 ${p.name} covers ${t.name}: ${n} Block until ${p.name}'s next turn.`);
  }

  /** The Block this creature gave runs out, wherever it is. */
  private dropBlock(id: string) {
    for (const e of this.entities) {
      if (!e.block || e.block[id] === undefined) continue;
      delete e.block[id];
      if (!Object.keys(e.block).length) delete e.block;
    }
  }

  /** Block soaks damage before anything else. Returns what gets through. */
  private soakBlock(t: Entity, amount: number): number {
    if (!t.block || amount <= 0) return amount;
    let soaked = 0;
    for (const [id, n] of Object.entries(t.block)) {
      const take = Math.min(n, amount - soaked);
      soaked += take;
      if (n > take) t.block[id] = n - take;
      else delete t.block[id];
      if (soaked >= amount) break;
    }
    if (!Object.keys(t.block).length) delete t.block;
    if (soaked) this.float(t, `🧱${soaked}`, '#c8d1dc');
    return amount - soaked;
  }

  /** A hero who gets to act: this turn's AP plus what they saved last turn, up to AP_MAX. A lost turn keeps the savings. */
  private grantAp(p: PlayerEntity) {
    const bold = p.statuses.find((x) => x.id === 'emboldened')?.power ?? 0; // Voice of Authority, Rousing Inspiration
    p.statuses = p.statuses.filter((x) => x.id !== 'emboldened');
    this.turn!.ap = Math.min(AP_MAX, (p.savedAp ?? 0) + AP_GAIN) + bold;
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
    if (hasBranch(p, 'unstoppable', 'B') && hasStatus(p, 'raging') && this.turn) this.turn.movesLeft += 2; // Rampaging
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
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || this.tiles[y * this.width + x] === '#') continue;
        if (this.entities.some((e) => e.x === x && e.y === y && !(e.kind === 'player' && e.dead))) continue;
        const extra = hasBranch(p, 'ambusher', 'B') ? { n: (trap.dmg?.n ?? 0) + 1, d: 6 } : trap.dmg; // Snare Master
        this.traps.set(y * this.width + x, { by: p.id, cast, status: trap.status, dmg: extra });
        n++;
      }
    }
    const mine = [...new Set([...this.traps.values()].filter((t) => t.by === p.id).map((t) => t.cast))].sort((a, b) => b - a);
    for (const [i, t] of [...this.traps]) if (t.by === p.id && !mine.slice(0, 3).includes(t.cast)) this.traps.delete(i);
    this.addLog('info', `🪤 ${p.name} hides ${n > 1 ? `${n} snares` : 'a snare'}.`);
  }

  /** A monster steps on a snare: it springs (damage, then Netted and the rest). Returns true if it's stuck. */
  private springTrap(e: Entity): boolean {
    if (e.kind !== 'monster' || isAllyNpc(e)) return false;
    const i = e.y * this.width + e.x;
    const trap = this.traps.get(i);
    if (!trap) return false;
    this.traps.delete(i);
    const by = this.entity(trap.by);
    this.addLog('hit', `🪤 ${e.name} steps into ${by ? `${by.name}'s` : 'a'} snare!`);
    this.float(e, '🪤 snared!', '#f6cf7a');
    if (trap.dmg) this.damage(e, rollDice(trap.dmg), by, 'physical');
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
    for (const s of [...e.statuses]) {
      if (s.id !== 'burning' && s.id !== 'poisoned') continue;
      if (!this.entities.includes(e) || (e.kind === 'player' && (e.downed || e.dead))) return;
      const dmg = rollDice({ n: s.power ?? 1, d: 4 });
      const source = this.entity(s.by);
      this.addLog('hit', `${STATUSES[s.id].icon} ${e.name} ${s.id === 'burning' ? 'burns' : 'suffers from poison'} for ${dmg}.`);
      this.damage(e, dmg, source, s.id === 'burning' ? 'fire' : 'poison');
    }
  }

  /** End of a creature's turn: statuses count down, and a hero's unspent AP is saved for the next turn. */
  private endOfTurn(e: Entity) {
    if (e.kind === 'player' && this.turn) e.savedAp = e.downed || e.dead ? 0 : Math.max(e.savedAp ?? 0, this.turn.ap);
    for (const s of e.statuses) s.turns--;
    e.statuses = e.statuses.filter((s) => s.turns > 0);
  }

  /** Plays an auto hero's turn, one decision at a time, through the same checks as a human. */
  private runHero(p: PlayerEntity, token: number) {
    if (this.heroTurnToken === token) return; // already playing this turn
    this.heroTurnToken = token;
    this.playHeroTurn(p, token)
      .catch((err) => console.error('hero AI error', err))
      .finally(() => {
        if (this.heroTurnToken === token) this.heroTurnToken = -1; // allow a restart if Auto is toggled off and on again
      });
  }

  private async playHeroTurn(p: PlayerEntity, token: number) {
    // Stops as soon as the turn changes, the fight ends, or the player takes back control.
    const ok = () => token === this.turnToken && this.phase === 'combat' && this.current()?.id === p.id && this.isAuto(p.playerId);
    await sleep(350);
    for (let i = 0; i < 16 && ok(); i++) {
      const t = this.turn!;
      const intent = nextHeroIntent({
        map: this, hero: p, heroes: this.heroes(), monsters: this.monsters(), allies: this.allies(), turn: t,
        occupied: (x, y, exceptId) => this.occupied(x, y, exceptId),
      });
      if (intent.kind === 'end') break;
      if (intent.kind === 'act') {
        const used = this.handleSkill(p.playerId, intent.skill, intent.target);
        if (!ok()) return;
        if (!used) break; // rejected: don't loop on it
        await sleep(450);
      } else {
        const path = planWalk(this, p, intent.to, t.movesLeft, (x, y) => this.occupied(x, y, p.id), p)?.path;
        if (!path?.length) break;
        for (const step of path) {
          if (!this.tryMove(p, step)) break;
          await sleep(MONSTER_STEP_MS);
          if (!ok()) return;
        }
      }
    }
    if (ok()) this.advanceTurn();
  }

  private advanceTurn() {
    const t = this.turn;
    if (!t || this.phase !== 'combat') return;
    const owner = this.entity(this.turnOwner ?? undefined);
    this.turnOwner = null;
    if (owner) this.endOfTurn(owner);
    if (this.checkEnd() || !t.order.length) return;
    t.index++;
    if (t.index >= t.order.length) {
      t.index = 0;
      t.round++;
      tickField(this); // fires burn out, ice melts, electricity fades
    }
    this.beginTurn();
  }

  handleEndTurn(playerId: string) {
    const p = this.hero(playerId);
    if (!p || this.phase !== 'combat' || this.current()?.id !== p.id) return;
    this.cancelWalk(p.id);
    this.advanceTurn();
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

  private endCombat() {
    this.traps.clear();
    const kind = this.roomKind ?? 'combat';
    const run = this.run!;
    // Song of Rest: the best Bard's song adds its share on top.
    const song = Math.max(0, ...this.heroes().map((h) => passiveOf(h, 'song_of_rest')?.value ?? 0)) / 100;
    const breather = POST_FIGHT_HEAL + (this.hasRelic('rations') ? 0.1 : 0) + song;
    for (const h of this.heroes()) if (hasBranch(h, 'song_of_rest', 'B') && h.slots < h.maxSlots) h.slots++; // Encore
    this.dispose();
    // NPC allies have one fight fewer to go.
    for (const a of run.allies) a.fights--;
    for (const a of run.allies) if (a.fights <= 0) this.addLog('info', `👋 ${a.name} has fought the agreed fights and heads home. Good luck!`);
    run.allies = run.allies.filter((a) => a.fights > 0);
    // Everyone gets back up, then the party catches its breath (a short rest).
    for (const p of this.heroes()) {
      if (p.dead || p.downed) {
        p.dead = false;
        p.downed = false;
        p.saves = { ok: 0, fail: 0 };
      }
      const drained = hasStatus(p, 'drained');
      p.statuses = [];
      if (drained) {
        const hp = p.hp;
        recalcHero(p); // max HP comes back, the HP doesn't
        p.hp = Math.min(hp, p.maxHp);
      }
      p.tempHp = 0;
      delete p.block;
      p.used = [];
      for (const s of p.skills) s.cd = 0;
      p.hp = Math.min(p.maxHp, Math.max(1, p.hp) + Math.ceil(p.maxHp * breather - 1e-9)); // (0.2 + 0.1 isn't quite 0.3)
    }
    this.addLog('heal', `🫁 The party catches its breath: everyone heals ${Math.round(breather * 100)}% of their max HP.`);
    const gold = this.goldFound(roomGold(run.act, kind));
    run.gold += gold;
    this.addLog('loot', `✅ Room cleared! The party loots ${gold} gold.`);
    this.callout(this.randomBot(), 'won', {}, 'after');
    const loot = kind === 'elite' ? this.fightLoot(kind) : null;
    const potion = this.potionDrop();
    if (kind === 'elite') for (const p of this.heroes()) p.elitePicks++; // dealt first (dealOffer), before the spoils below
    const leveled = this.checkLevelUps();
    this.victorySpoils();
    if (kind === 'boss') return this.finishAct();
    const text = `+${gold} gold.${loot ? ` ${loot}` : ''}${potion ? ` ${potion}` : ''} 🏆 Everyone picks their spoils.${leveled.length ? ` ⬆️ Level up: ${leveled.join(', ')}!` : ''}`;
    if (kind === 'elite') return this.eliteSpoils(text);
    this.notice = { glyph: '✅', title: 'Room cleared', text };
    this.toMap();
  }

  /**
   * After an elite (every hero's elite-spoils pick, an upgrade, gear or a boon, was dealt in endCombat): the party votes
   * on a blessing for the rest of the act or an NPC ally for the next few fights.
   */
  private eliteSpoils(text: string) {
    const run = this.run!;
    const blessings = shuffle(BLESSING_IDS.filter((b) => !run.blessings.includes(b))).slice(0, 2);
    this.eliteReward(text, [...blessings.map((b) => `blessing:${b}`), `ally:${pick(ALLY_IDS)}`]);
  }

  /** The party's vote after an elite. A save made during it reopens the same vote. */
  private eliteReward(text: string, choices: string[]) {
    const run = this.run!;
    const choice = (c: string): EventChoiceDef | null => {
      const [kind, id] = c.split(':');
      if (kind === 'blessing' && isBlessingId(id)) {
        const b = BLESSINGS[id];
        return {
          id: c, label: `${b.icon} ${b.name}`, hint: `${b.desc} Until the end of the act.`,
          resolve: () => ({ text: `${text} The party takes the ${b.name}.`, effects: [{ kind: 'blessing', id }] }),
        };
      }
      if (kind === 'ally' && isAllyId(id)) {
        const a = ALLIES[id];
        const m = MONSTERS[a.monster];
        return {
          id: c, label: `${m.glyph} Free their captive ${m.name}`, hint: `${a.desc} Fights with you for the next ${ALLY_FIGHTS} fights.`,
          resolve: () => ({ text: `${text} A grateful ${m.name} joins the party.`, effects: [{ kind: 'ally', id }] }),
        };
      }
      return null;
    };
    const options = choices.map(choice).filter((c): c is EventChoiceDef => !!c);
    this.savePoint = { kind: 'reward', nodeId: run.currentId ?? '', choices: options.map((o) => o.id), text };
    this.startEvent(undefined, {
      id: 'spoils',
      title: 'Elite defeated!',
      glyph: '💀',
      text: `${text} Every hero picks their spoils. Then choose together: a blessing for the rest of the act, or the captive they were holding, who fights with you for the next ${ALLY_FIGHTS} fights.`,
      choices: options,
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
      const id = this.randomItem('gear', ELITE_GEAR[act] ?? ['rare']);
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
    this.dispose();
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
      for (const step of path.slice(0, this.turn?.movesLeft ?? m.speed)) {
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
    const guard = isFoe(m) ? this.heroes().find((h) => covers(h)) : undefined;
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
    const hit = this.attackRoll(m, target, {
      bonus: def.atk + (m.atkBonus ?? 0), dmg: def.dmg, extra: (m.dmgBonus ?? 0) + (enraged ? ENRAGED_DMG : 0), verb: def.verb, element,
    });
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
      this.freeStrike(target, m, 'Riposte');
    }
    // Counterattack (Weapon Master): a melee miss gets hit back, once per round (twice with Relentless Counter).
    const counter = target.kind === 'player' ? passiveOf(target, 'counterattack') : null;
    if (!hit && counter && target.kind === 'player' && dist(m, target) <= 1 && this.standing(target) && !hasStatus(target, 'surprised') && this.entities.includes(m)) {
      const times = target.used.filter((u) => u === 'round:counter').length;
      if (times < (hasBranch(target, 'counterattack', 'A') ? 2 : 1)) {
        target.used.push('round:counter');
        this.addLog('info', `🤺 ${target.name} counterattacks!`);
        const landed = this.freeStrike(target, m, 'Counterattack', counter.value);
        if (landed && hasBranch(target, 'counterattack', 'B') && this.entities.includes(m)) this.applyStatus(m, { id: 'dazed', turns: 1 }, target);
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
   * Elite traits at the start of its turn: the Shielded ward re-forms every 3rd round, and an aura hurts everyone on
   * the party's side next to it (and touches the ground around it: a Burning elite lights the oil it stands near).
   */
  private eliteTurnStart(m: MonsterEntity) {
    const round = this.turn?.round ?? 1;
    if (hasTrait(m, 'shielded') && round % WARD_EVERY === 0) {
      const full = Math.round(m.maxHp * WARD_SHARE);
      if ((m.ward ?? 0) < full) {
        m.ward = full;
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

  /** Summoner: every other round the elite calls in one of its escorts (3 at most, never past a full room). */
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
    return { me: m, map: this, entities: this.entities, moves: t.movesLeft, difficulty: this.diff, focus, rand: () => rng.next(), round: t.round, order, assign };
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
      const healed = f.kind === 'player' ? this.healBy(null, f, amount) : this.healMonster(f, amount);
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
      const bonus = MONSTERS[m.type].atk + (m.atkBonus ?? 0) + (hasStatus(m, 'blessed') ? 2 : 0) - (hasStatus(m, 'dazed') ? 2 : 0) + this.rallyOf(m);
      const ac = this.acOf(t);
      landed = d20 === 20 || (d20 !== 1 && d20 + bonus >= ac);
      if (why.adv.includes('distracted')) t.statuses = t.statuses.filter((s) => s.id !== 'distracted');
      const rolled = net ? `🎲${r1}|${r2}→${d20}` : `🎲${d20}`;
      this.addLog(landed ? 'hit' : 'miss', `${what}: ${rolled}${fmtMod(bonus)}=${d20 + bonus} vs AC ${ac}, ${landed ? 'hit' : 'miss'}.`);
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
    if (!this.turn) return;
    if (ROOTED.some((id) => hasStatus(e, id))) this.heldMoves += n;
    else this.turn.movesLeft += n;
  }

  /** Out of a net or a web: on its own turn it gets its held-back movement. */
  private unrooted(e: Entity) {
    if (ROOTED.some((id) => hasStatus(e, id))) return;
    if (this.turn && this.current()?.id === e.id && this.heldMoves) {
      this.turn.movesLeft += this.heldMoves;
      this.heldMoves = 0;
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
      let dmg = rollDice({ n: 3, d: 6 });
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
  private creatureSave(e: Entity, stat: 'dex' | 'str' | 'wis'): { total: number; text: string } {
    if (e.kind === 'player') return this.heroSave(e, stat);
    const d20 = rollDie(20);
    const bonus = MONSTERS[e.type][stat];
    return { total: d20 + bonus, text: `🎲${d20}${fmtMod(bonus)}=${d20 + bonus}` };
  }

  /** A hero's saving throw: d20 + stat + Steady + Bless; Fortune rerolls a natural 1. */
  private heroSave(p: PlayerEntity, stat: 'dex' | 'str' | 'wis'): { total: number; text: string } {
    let d20 = rollDie(20);
    if (d20 === 1 && this.useLucky(p, true)) d20 = rollDie(20);
    const bonus = statMod(p.classId, stat) + (passiveOf(p, 'steady')?.value ?? 0) + (hasStatus(p, 'blessed') ? 2 : 0) + gearBonus(p, 'saves') + this.auraBonus(p);
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
    const reason = skillBlockReason(p, skillId, inCombat, this.turn, this.current()?.id === p.id);
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
    if (inCombat && this.turn) {
      this.turn.ap -= s.ap;
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
    try {
      this.useSkill(p, own, s, res);
    } finally {
      this.casting = null;
    }
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
          const hit = s.roll === 'save' ? this.saveHit(p, f, s, name, color) : this.weaponHit(p, f, s, name, color, basic);
          landed ||= hit;
        }
      }
      if (!landed || !this.entities.includes(f) || (f.kind === 'player' && !this.standing(f))) return;
      for (const st of s.onHit ?? []) this.applyStatus(f, st, p);
      if (s.push && s.roll !== 'contest') this.push(f, s.target === 'area' && (f.x !== res.center.x || f.y !== res.center.y) ? res.center : p, s.push);
    };
    for (const f of res.foes) strikeOne(f);
    if (s.trap && inCombat) this.setTraps(p, s, res.center);
    const caught = (res.caught ?? []).filter((h) => this.up(h));
    if (caught.length) {
      const who = caught.map((h) => (h === p ? `${p.name} themself` : h.name)).join(', ');
      this.addLog('miss', `⚠️ Friendly fire! ${who} ${caught.length > 1 ? 'are' : 'is'} caught in the ${name}.`);
      for (const h of caught) strikeOne(h);
    }

    // Friends: heals, temporary HP, cleansing and buffs.
    let healedAll = 0;
    for (const fr of res.friends) {
      if (s.heal) {
        const drink = SKILLS[own.id].kind === 'item' && this.hasRelic('alchemist_kit') ? 1.5 : 1; // Alchemist's Kit
        const amount = Math.round((rollDice({ n: s.heal.n, d: s.heal.d }) + healBonus(p, s)) * drink);
        const healed = this.healBy(p, fr, amount, s.overheal);
        if (fr !== p) healedAll += healed;
        const line =
          s.target === 'self'
            ? `${p.name} uses ${name}`
            : singleRoll
              ? `${p.name} uses ${name} on ${fr === p ? 'themself' : fr.name}`
              : `${fr.name} is healed`;
        this.addLog('heal', `${s.icon} ${line}: +${healed} HP.`);
      }
      if (s.tempHp) fr.tempHp = Math.max(fr.tempHp, rollDice(s.tempHp));
      if (s.block && this.standing(fr)) this.blockFrom(p, fr, s.block, s.blockLevel);
      if (s.cleanse) fr.statuses = fr.statuses.filter((x) => !CLEANSED.includes(x.id));
      if (s.frees) fr.statuses = fr.statuses.filter((x) => !ROOTED.includes(x.id));
      if (s.cleanse || s.frees) this.unrooted(fr);
      for (const st of s.status ?? []) this.applyStatus(fr, st, p);
      if ((s.status?.length || s.block) && fr !== p) this.grantXp(p, XP_BUFF);
      if (inCombat && this.standing(fr)) this.hurry(p, fr, own.id, s);
    }
    if (s.healSelf && healedAll > 0) {
      const back = this.healBy(p, p, Math.floor(healedAll * s.healSelf));
      if (back) this.addLog('heal', `${s.icon} The light flows back into ${p.name}: +${back} HP.`);
    }

    // You. Any move against the enemy gives a hidden hero away (Smoke Bomb hides you again right after).
    if (s.target === 'enemy' || s.target === 'area' || s.target === 'around') p.statuses = p.statuses.filter((x) => x.id !== 'hidden');
    for (const st of s.selfStatus ?? []) this.applyStatus(p, st, p);
    if (s.selfBlock) this.blockFrom(p, p, s.selfBlock, s.blockLevel);
    if (s.taunt) {
      const taunted = this.monsters().filter((m) => dist(m, p) <= s.taunt!.radius);
      for (const m of taunted) this.applyStatus(m, { id: 'taunted', turns: s.taunt.turns }, p);
      if (taunted.length) this.addLog('info', `😤 ${taunted.map((m) => m.name).join(', ')} can't take their eyes off ${p.name}.`);
    }
    if (this.turn && this.phase === 'combat' && this.current()?.id === p.id) {
      if (s.dash) this.addMoves(p, s.dash);
      if (s.gainAp) {
        this.turn.ap += s.gainAp;
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
  private saveHit(p: PlayerEntity, f: Entity, s: SkillStats, name: string, color: string): boolean {
    const save = s.save ?? 'dex';
    const { total, text: rolled } = this.creatureSave(f, save);
    const dc = heroDc(p);
    const saved = total >= dc;
    this.shot(p, f, color);
    let dmg = s.dmg ? rollDice(s.dmg) + damageMod(p, s) + this.bonusDamage(p, f, s.element ?? 'physical') : 0;
    const evasion = f.kind === 'player' && s.target === 'area' && hasBranch(f, 'opportunist', 'B');
    if (saved) dmg = s.half && !evasion ? Math.floor(dmg / 2) : 0;
    else if (evasion) dmg = Math.floor(dmg / 2);
    const roll = `${save.toUpperCase()} save ${rolled} vs DC ${dc}`;
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
    this.push(f, p, (s.push ?? 1) + (margin >= 5 ? 1 : 0) + further);
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
  private push(t: Entity, from: Pos, tiles: number) {
    const dx = Math.sign(t.x - from.x);
    const dy = Math.sign(t.y - from.y);
    if (!dx && !dy) return;
    const path: Pos[] = [];
    let at: Pos = { x: t.x, y: t.y };
    for (let i = 0; i < tiles; i++) {
      if (!canStep(this, at, dx, dy) || this.occupied(at.x + dx, at.y + dy, t.id)) break;
      at = { x: at.x + dx, y: at.y + dy };
      path.push(at);
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
    const turns = a.turns + (t.id === this.turnOwner ? 1 : 0);
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
    return extra;
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
    const bonus = o.bonus + (hasStatus(a, 'blessed') ? 2 : 0) - (hasStatus(a, 'dazed') ? 2 : 0) + rally;
    const ac = this.acOf(t);
    const critRange = hero && (hasBranch(hero, 'lucky', 'B') || this.hasRelic('loaded_dice')) ? 19 : 20;
    const crit = d20 >= critRange || (!!o.critFull && t.hp >= t.maxHp);
    const hit = crit || (d20 !== 1 && d20 + bonus >= ac);
    if (dist(a, t) > 1 && a.kind === 'monster') this.shot(a, t, ELEMENT_COLOR[o.element]);
    // Strike and Fade: the first attack on your own turn, hit or miss, frees up some movement.
    const fade = hero ? passiveOf(hero, 'strike_and_fade') : null;
    if (hero && fade && this.turn && this.current()?.id === hero.id && !hero.used.includes('turn:fade')) {
      hero.used.push('turn:fade');
      this.addMoves(hero, fade.value);
      if (hasBranch(hero, 'strike_and_fade', 'B')) this.applyStatus(hero, { id: 'shielded', turns: 1, power: 2 }, hero);
    }
    const what = `${a.name} ${o.verb} ${t.name}${o.weapon ? ` (${o.weapon})` : ''}`;
    const roll = `${rolled}${reroll}${fmtMod(bonus)}=${d20 + bonus} vs AC ${ac}`;
    if (!hit) {
      this.addLog('miss', `${what}: ${roll}, miss${d20 === 1 ? ' (natural 1!)' : ''}`);
      this.float(t, 'miss', '#9aa0a6');
      if (dist(a, t) <= 1 && canReact(t)) this.face(t, a);
      return false;
    }

    const rage = dist(a, t) <= 1 ? (a.statuses.find((s) => s.id === 'raging')?.power ?? 0) : 0; // Rage: melee only
    let total = rollDice(o.dmg, crit) + (o.extra ?? 0) + this.bonusDamage(a, t, o.element) + rally + rage;
    const notes: string[] = [];
    if (hero && o.sneak && !hero.used.includes('turn:sneak')) {
      const flanked = this.entities.some((e) => e !== hero && !isFoe(e) && this.up(e) && dist(e, t) <= 1);
      if (flanked || adv) {
        // Death Mark: more dice on the Poisoned (or Marked, for Marked for Death).
        const mark = passiveOf(hero, 'death_mark');
        const doomed = mark && (hasStatus(t, 'poisoned') || (hasBranch(hero, 'death_mark', 'B') && hasStatus(t, 'marked')));
        const sneak = rollDice({ n: sneakDice(hero.level) + (doomed ? mark.value : 0), d: 6 }, crit);
        total += sneak;
        hero.used.push('turn:sneak');
        notes.push(`${sneak} Sneak Attack`);
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
    total = Math.max(1, total);
    this.addLog(crit ? 'crit' : 'hit', `${what}: ${roll}, ${crit ? 'CRITICAL HIT' : 'hit'} for ${total}${elementWord(o.element)}${notes.length ? ` (incl. ${notes.join(', ')})` : ''}`);
    this.damage(t, total, a, o.element);
    if (crit) this.callout(a, 'crit', { target: t.name }); // after the damage, so a kill steal gets the bot's word first
    if (hero && o.basic) this.weaponExtras(hero, t, crit);
    const venom = hero && o.basic ? a.statuses.find((s) => s.id === 'envenomed') : undefined;
    if (venom && this.entities.includes(t)) this.applyStatus(t, { id: 'poisoned', turns: 2, power: venom.power ?? 1 }, a);
    if (hero && this.entities.includes(t)) this.afterHit(hero, t, o.element, !!o.basic);
    if (dist(a, t) <= 1 && this.entities.includes(t) && canReact(t)) this.face(t, a); // you turn toward whoever hit you
    return true;
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
    if (drinker && !area && dist(p, t) <= 1) {
      const healed = this.healBy(null, p, Math.max(1, Math.floor((dealt * drinker.value) / 100)));
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

  /** On-hit passives that put statuses on the target or heal allies. */
  private afterHit(p: PlayerEntity, t: Entity, element: Element, basic: boolean) {
    if (element === 'fire' && hasBranch(p, 'elemental_affinity', 'A')) this.applyStatus(t, { id: 'burning', turns: 2 }, p);
    if (hasBranch(p, 'psychic_blades', 'B') && t.kind === 'monster' && t.statuses.some((x) => !STATUSES[x.id].good)) this.applyStatus(t, { id: 'dazed', turns: 1 }, p);
    if (!basic) return;
    if (hasBranch(p, 'divine_strike', 'A')) this.applyStatus(t, { id: 'blinded', turns: 1 }, p);
    if (hasBranch(p, 'divine_strike', 'B')) {
      const hurt = this.heroes()
        .filter((h) => !h.dead && dist(h, p) <= 6 && h.hp < h.maxHp)
        .sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
      if (hurt) {
        const healed = this.healBy(p, hurt, rollDice({ n: 1, d: 4 }) + statMod(p.classId, 'wis'));
        this.addLog('heal', `⚜️ Holy light from ${p.name}'s strike mends ${hurt === p ? 'themself' : hurt.name}: +${healed} HP.`);
      }
    }
  }

  private damage(t: Entity, amount: number, by?: Entity, element: Element = 'physical', area = false, field = false) {
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
    if (t.kind === 'monster' && by?.kind === 'player') t.dmgBy[by.id] = (t.dmgBy[by.id] ?? 0) + Math.min(amount, t.hp);
    const bloodied = t.hp < t.maxHp / 2;
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
      t.downed = true;
      t.saves = { ok: 0, fail: 0 };
      t.statuses = [];
      delete t.block;
      t.savedAp = 0; // going down costs the AP saved up
      this.cancelWalk(t.id);
      this.addLog('death', `🩸 ${t.name} falls unconscious! Heal them to get them back up.`);
      this.callout(this.randomBot(t), 'down', { ally: t.name });
      // Went down on their own turn (walked into the fire): the turn is over.
      if (this.turnOwner === t.id && this.phase === 'combat') {
        const token = this.turnToken;
        this.later(token, 800, () => this.advanceTurn());
      }
    }
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
      } else this.applyStatus(t, { id: 'chilled', turns: FIELD_STATUS_TURNS }, by);
    } else if (el === 'lightning') {
      if (hasStatus(t, 'stunned')) return; // can't be stunned again while stunned
      if (wet || hasStatus(t, 'shocked')) {
        t.statuses = t.statuses.filter((x) => x.id !== 'shocked');
        this.addLog('info', `⚡ ${t.name} is stunned by the shock${wet ? ' (Wet)' : ''}!`);
        this.applyStatus(t, { id: 'stunned', turns: 1 }, by);
      } else this.applyStatus(t, { id: 'shocked', turns: FIELD_STATUS_TURNS }, by);
    }
  }

  // ------------------------------------------------------------ the battlefield (shared/surfaces.ts)

  /**
   * Runs field operations for real: logs and pops up the reactions, blows up whoever is next to an explosion, and
   * affects everyone standing where something new appeared.
   */
  private runField(ops: FieldOp[], by?: Entity) {
    if (!ops.length || this.phase !== 'combat') return;
    const r = applyField(this, ops, by?.id);
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
    this.entities = this.entities.filter((e) => e !== t);
    this.removeFromOrder(t.id);
    const killer = by?.kind === 'player' ? by : null;
    if (killer && t.elite) this.eliteKiller = killer.id;
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
    const shares = killShares(MONSTERS[t.type].xp, killer?.id ?? null, t.dmgBy, alive.map((h) => h.id));
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
      if (hasBranch(p, 'bloodthirsty', 'A') && this.turn && this.current()?.id === p.id) this.addMoves(p, 3);
      if (hasBranch(p, 'bloodthirsty', 'B')) for (const h of this.heroes()) if (h !== p && this.standing(h)) this.healBy(null, h, 2);
    }
    const myTurn = this.turn && this.current()?.id === p.id;
    if (myTurn && hasBranch(p, 'opportunist', 'A') && !p.used.includes('turn:executioner')) {
      p.used.push('turn:executioner');
      this.turn!.ap += 2;
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
   * Heals a hero (getting them up if downed) and returns how much HP they gained.
   * `healer` earns support XP and triggers healing passives when the target is someone else.
   */
  private healBy(healer: PlayerEntity | null, t: PlayerEntity, amount: number, overheal = false): number {
    if (t.dead) return 0;
    if (healer && hasBranch(healer, 'blessed_healer', 'B')) amount += 2; // Shepherd
    const room = t.maxHp - t.hp;
    const wasDown = t.downed;
    t.hp = Math.min(t.maxHp, t.hp + amount);
    const healed = Math.min(amount, room);
    if (overheal && amount > room) t.tempHp = Math.max(t.tempHp, amount - room);
    if (healed > 0) this.float(t, `+${healed}`, '#7ddc6f');
    if (t.downed && t.hp > 0) {
      t.downed = false;
      t.saves = { ok: 0, fail: 0 };
      if (this.hasRelic('smelling_salts')) t.hp = Math.min(t.maxHp, t.hp + 5);
      this.addLog('heal', `${t.name} is back on their feet!`);
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
    if (p.saves.fail >= 3) {
      p.downed = false;
      p.dead = true;
      this.addLog('death', `☠️ ${p.name} has died... they'll be back on their feet after the fight, if the party wins it.`);
      this.removeFromOrder(p.id);
      this.advanceTurn();
    }
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
    const run = this.run!;
    const gear = new Set<ItemId>();
    for (let i = 0; gear.size < 3 && i < 30; i++) gear.add(this.randomItem('gear', SHOP_GEAR[act] ?? ['rare']));
    const consumables = shuffle([...CONSUMABLE_IDS]).slice(0, 3);
    const relic = shuffle(RELIC_IDS.filter((id) => RELICS[id].rarity !== 'boss' && !run.relics.includes(id)))[0];
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
    const bought = this.shopReceipts.length ? `Bought: ${this.shopReceipts.join(', ')}. ` : 'Nobody bought anything. ';
    this.notice = { glyph: '🛒', title: 'Shop', text: `${bought}The party moves on with ${run.gold} gold.` };
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
    this.log.push({ id: ++this.logId, kind, text });
    if (this.log.length > LOG_LIMIT) this.log.shift();
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
        choices: e.choices.map((c) => ({ id: c.id, label: c.label, hint: c.hint ?? (c.cost ? `Costs ${c.cost} gold` : undefined) })),
      },
      rest: this.restPicks && {
        picks: this.restPicks,
        endsInMs: this.restDeadline === null ? null : Math.max(0, this.restDeadline - Date.now()),
      },
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
