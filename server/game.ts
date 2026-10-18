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
  BREATH_DC,
  CLASSES,
  CLASS_IDS,
  LEVEL_CAP,
  MAX_ACT,
  MAX_PLAYERS,
  MONSTERS,
  NODE_INFO,
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
  rollDice,
  rollDie,
  roomGold,
  saveDc,
  scaledHp,
  sneakDice,
  statMod,
  type Dice,
} from '../shared/rules.ts';
import {
  SKILLS,
  STATUSES,
  attackBonus,
  damageMod,
  hasBranch,
  hasStatus,
  healBonus,
  hitsOf,
  isSkillId,
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
  type SkillStats,
  type StatusApply,
} from '../shared/skills.ts';
import type {
  ClassId,
  Entity,
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
import { generateActMap } from './actmap.ts';
import { getEvent, pickEvent, type CheckResult, type EventDef, type EventEffect, type EventStat } from './events.ts';
import { autoEventChoice, autoLevelPick, autoPathChoice, autoRestPick, nextHeroIntent, upkeepIntent } from './heroai.ts';
import { applyLevelUps, applyPick, killShares, makeOffer, recalcHero, startingSkills, upgrade, validRestPick } from './progression.ts';
import { pick, randInt, rng } from './rng.ts';
import { generateRoom } from './room.ts';
import { SAVE_VERSION, archiveSave, writeSave, type SaveFile, type SavePoint } from './saves.ts';

const BOT_NAMES = ['Brakka', 'Pip', 'Sister Wren', 'Old Tam', 'Vexa', 'Grimble', 'Lady Ash', 'Moss'];

// Dev knobs for bot testing: DELVERS_SPEED=10 makes monster turns 10x faster, DELVERS_ROWS=4 makes acts short.
const SPEED = Math.max(0.1, Number(process.env.DELVERS_SPEED) || 1);
const ROWS = Math.max(3, Number(process.env.DELVERS_ROWS) || ACT_ROWS);

const STEP_MS = 120 / SPEED; // player walking speed
const MONSTER_STEP_MS = 170; // passed through sleep(), which applies SPEED
const LOG_LIMIT = 80;
const MAX_ROOM_MONSTERS = 6;
const POST_FIGHT_HEAL = 0.2; // short rest after every won fight, so damage doesn't snowball into a wipe
const AUTO_DELAY_MS = 700; // pause before auto heroes vote, pick or use potions between rooms

const ELEMENT_COLOR: Record<Element, string> = {
  physical: '#ffe9a8', fire: '#ff8a3d', cold: '#8fd8ff', lightning: '#fff36b', poison: '#8fdc5a', radiant: '#ffe27a', force: '#c58bff',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / SPEED));

interface Walk {
  path: Pos[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface Vote {
  kind: 'path' | 'event';
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
  private heroTurnToken = -1; // the turn an auto hero is currently playing
  private event: EventDef | null = null;
  private seenEvents: string[] = [];
  private notice: Notice | null = null;
  private roomKind: NodeType | null = null;
  private lastChecker: string | null = null; // hero who made the last event check
  private entities: Entity[] = [];
  private turn: TurnState | null = null;
  private turnOwner: string | null = null; // whose turn it is (stays set even if they're removed mid-turn)
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
    const taken = new Set(this.players.map((p) => p.classId));
    const classId = CLASS_IDS.find((c) => !taken.has(c)) ?? pick(CLASS_IDS);
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

  start(playerId: string) {
    if (this.phase !== 'lobby' || playerId !== this.hostId) return;
    if (this.resumeFrom) return this.resumeRun(this.resumeFrom);
    this.createdAt = Date.now();
    this.log = [];
    this.seenEvents = [];
    this.notice = null;
    this.entities = this.players.map((p) => this.makePlayer(p, 1));
    const seed = randInt(1, 2 ** 31 - 2);
    this.run = { act: 1, maxAct: MAX_ACT, actName: ACTS[0].name, map: generateActMap(1, seed, ROWS), currentId: null, visited: [], gold: 0, seed };
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
    this.voteTimer = null;
    this.autoVoteTimer = null;
    this.restTimer = null;
    this.vote = null;
    this.restPicks = null;
    this.restDeadline = null;
  }

  private makePlayer(info: PlayerInfo, level: number): PlayerEntity {
    const c = CLASSES[info.classId];
    const p: PlayerEntity = {
      id: this.newId(), kind: 'player', playerId: info.id, classId: info.classId, name: info.name, glyph: c.glyph, color: info.color,
      x: 0, y: 0, level, xp: 0, skills: startingSkills(info.classId), levelUps: 0, offer: null,
      hp: 0, maxHp: 0, ac: c.ac, speed: c.speed, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0,
      potions: 2, kills: 0, steals: 0, slots: 0, maxSlots: 0, downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], statuses: [],
    };
    recalcHero(p); // fills HP and slots for the level
    return p;
  }

  /** A hero joining a run in progress starts at the party's level, with the picks they missed. */
  private newcomer(info: PlayerInfo, level: number): PlayerEntity {
    const e = this.makePlayer(info, level);
    e.levelUps = level - 1;
    if (e.levelUps) e.offer = makeOffer(e, rng);
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
      skills: (saved.skills ?? base.skills).filter((s) => isSkillId(s.id)).map((s) => ({ ...s, cd: 0 })),
      statuses: [],
      tempHp: 0,
      used: [],
      downed: false,
      dead: false,
      saves: { ok: 0, fail: 0 },
    };
    // Cards for skills that no longer exist are dealt again.
    if (p.offer && !p.offer.every((c) => c.kind === 'boon' || isSkillId(c.skill))) p.offer = null;
    if (p.levelUps > 0 && !p.offer) p.offer = makeOffer(p, rng);
    recalcHero(p);
    return p;
  }

  /** Continues a loaded save: same heroes, same map, the node in progress replayed from its start. */
  private resumeRun(save: SaveFile) {
    this.resumeFrom = null;
    const level = Math.max(1, ...save.heroes.map((h) => h.level));
    this.entities = this.players.map((info) => {
      const saved = save.heroes.find((h) => h.playerId === info.id);
      return saved ? this.restoreHero(saved, info) : this.newcomer(info, level);
    });
    this.run = save.run;
    this.seenEvents = [...save.seenEvents];
    this.notice = save.notice;
    this.addLog('system', '📜 The party picks up right where they left off.');
    if (save.at.kind === 'node' && this.node(save.at.nodeId)) this.enterNode(save.at.nodeId, save.at.eventId);
    else this.toMap();
    this.scheduleAutoPicks();
  }

  private spawnLatecomer(info: PlayerInfo) {
    const level = Math.max(1, ...this.heroes().map((h) => h.level));
    const e = this.newcomer(info, level); // they skipped the earlier level-ups, so they get those picks now
    if (this.phase === 'combat') {
      const anchor = this.heroes().find((p) => !p.dead);
      const path = anchor && findPath(this, anchor, () => false, (x, y) => !this.occupied(x, y));
      const spot = path?.[path.length - 1];
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
      const heroes = this.heroes();
      for (const p of this.players) {
        if (this.vote !== vote) return; // the vote resolved along the way
        if (vote.votes[p.id]) continue;
        const choice =
          vote.kind === 'path'
            ? autoPathChoice(vote.options.map((id) => ({ id, type: this.node(id)?.type ?? 'combat' })), heroes)
            : autoEventChoice(vote.options, heroes);
        this.handleVote(p.id, choice);
      }
      if (this.vote === vote) this.resolveVote();
    }, AUTO_DELAY_MS / SPEED);
  }

  /** Between rooms, auto heroes drink potions and patch each other up. */
  private scheduleUpkeep() {
    setTimeout(() => {
      if (this.phase !== 'map') return;
      for (const hero of this.heroes()) {
        if (!this.isAuto(hero.playerId)) continue;
        const intent = upkeepIntent(hero, this.heroes());
        if (intent?.kind === 'act') this.handleSkill(hero.playerId, intent.skill, intent.target);
      }
    }, AUTO_DELAY_MS / SPEED);
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
        this.startRoom(node.type, fight.monsters, fight.name);
        break;
      }
      case 'rest':
        this.startRest();
        break;
      case 'treasure':
        this.treasure();
        this.toMap();
        break;
      case 'event':
        this.startEvent(eventId);
        break;
      case 'shop':
        this.notice = { glyph: NODE_INFO.shop.icon, title: 'Shop', text: 'The merchant hasn’t set up shop yet. (Coming in a later update.)' };
        this.toMap();
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
    let budget = encounterBudget(run.act, node.row, size);
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

  private treasure() {
    const run = this.run!;
    const gold = randInt(25, 40) * run.act;
    run.gold += gold;
    const lucky = this.giveSharedPotions(1)[0];
    this.addLog('loot', `💰 Treasure! ${gold} gold${lucky ? `, and a potion for ${lucky}` : ''}.`);
    this.notice = { glyph: '💰', title: 'Treasure', text: `You find ${gold} gold${lucky ? ` and a healing potion (${lucky} takes it)` : ''}.` };
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
    for (const p of this.heroes()) {
      p.hp = p.maxHp;
      p.slots = p.maxSlots;
    }
    this.addLog('system', `🏆 Act ${run.act - 1} complete! The party recovers fully (HP and every slot) and presses on to Act ${run.act}: ${def.name}.`);
    this.notice = {
      glyph: def.glyph,
      title: `Act ${run.act}: ${def.name}`,
      text: `Everyone is fully healed and every slot is restored. The ${MONSTERS[def.boss].name} waits at the top of the map.`,
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
      if (!p.offer) p.offer = makeOffer(p, rng);
      this.addLog('level', `⬆️ ${p.name} reaches level ${p.level}! ${gained > 1 ? `${gained} upgrades` : 'An upgrade'} to pick.`);
    }
    this.scheduleAutoPicks();
    return names;
  }

  /** Auto heroes take their level-up picks on their own. */
  private scheduleAutoPicks() {
    if (!this.heroes().some((p) => p.offer && this.isAuto(p.playerId))) return;
    setTimeout(() => {
      for (const p of this.heroes()) {
        for (let guard = 0; guard < 12 && p.offer && p.levelUps > 0 && this.isAuto(p.playerId); guard++) {
          const res = applyPick(p, autoLevelPick(p), rng);
          if (!res.ok) {
            console.warn(`[auto pick ${p.name}] rejected: ${res.error}`);
            break;
          }
          this.addLog('level', `⬆️ ${p.name} ${res.text}.`);
        }
      }
      this.checkpoint();
      this.broadcast();
    }, AUTO_DELAY_MS / SPEED);
  }

  handlePick(playerId: string, req: PickRequest) {
    const p = this.hero(playerId);
    if (!p?.offer || this.phase === 'lobby' || this.phase === 'victory' || this.phase === 'defeat') return;
    const res = applyPick(p, { card: Number(req?.card), branch: req?.branch, forget: req?.forget }, rng);
    if (!res.ok) return this.whisper(playerId, res.error);
    this.addLog('level', `⬆️ ${p.name} ${res.text}.`);
    this.checkpoint();
    this.broadcast();
  }

  // ------------------------------------------------------------ events

  /** Opens an event: a fresh one, or the same one again when a save is resumed mid-event. */
  private startEvent(eventId?: string) {
    const run = this.run!;
    const def = (eventId && getEvent(eventId, run.act)) || pickEvent(run.act, this.seenEvents, rng);
    if (!this.seenEvents.includes(def.id)) this.seenEvents.push(def.id);
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
    }
  }

  // ------------------------------------------------------------ rooms

  private startRoom(kind: NodeType, monsters: string[], name: string) {
    this.dispose();
    const layout = generateRoom(kind);
    this.width = layout.width;
    this.height = layout.height;
    this.tiles = layout.tiles;
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
    this.phase = 'combat';
    this.startCombat();
    this.broadcast();
  }

  private spawnMonster(type: string, pos: Pos, partySize: number) {
    const def = MONSTERS[type];
    const boss = ACTS.some((a) => a.boss === type);
    const elite = !boss && (ACTS.some((a) => a.elites.includes(type)) || type === 'mimic');
    const hp = boss || elite ? scaledHp(def.hp, partySize, boss) : def.hp;
    this.entities.push({
      id: this.newId(), kind: 'monster', type, name: def.name, glyph: def.glyph, x: pos.x, y: pos.y,
      hp, maxHp: hp, ac: def.ac, speed: def.speed, boss, elite, statuses: [], dmgBy: {},
    });
  }

  // ------------------------------------------------------------ movement

  handleMove(playerId: string, target: Pos) {
    const p = this.hero(playerId);
    if (!p || !this.canMove(p) || !Number.isInteger(target?.x) || !Number.isInteger(target?.y)) return;
    let path = findPath(this, p, (x, y) => this.occupied(x, y, p.id), (x, y) => x === target.x && y === target.y);
    if (!path?.length || !this.turn) return;
    if (this.turn.movesLeft <= 0) return this.whisper(playerId, 'No movement left. Use an action or end your turn.');
    path = path.slice(0, this.turn.movesLeft);
    this.startWalk(p, path);
  }

  handleStep(playerId: string, dx: number, dy: number) {
    const p = this.hero(playerId);
    if (!p || !this.canMove(p) || ![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || (dx === 0 && dy === 0)) return;
    this.cancelWalk(p.id);
    if (this.turn && this.turn.movesLeft <= 0) return this.whisper(playerId, 'No movement left. Use an action or end your turn.');
    this.tryMove(p, { x: p.x + dx, y: p.y + dy });
  }

  private canMove(p: PlayerEntity): boolean {
    return this.standing(p) && this.phase === 'combat' && this.current()?.id === p.id && !hasStatus(p, 'stunned');
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
    if (!this.canMove(p) || !this.turn || this.turn.movesLeft <= 0) return false;
    const dx = next.x - p.x;
    const dy = next.y - p.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1 || !canStep(this, p, dx, dy) || this.occupied(next.x, next.y, p.id)) return false;
    this.turn.movesLeft--;
    p.x = next.x;
    p.y = next.y;
    this.broadcast();
    return true;
  }

  // ------------------------------------------------------------ turns

  private initBonus(e: Entity): number {
    if (e.kind === 'monster') return MONSTERS[e.type].dex;
    return CLASSES[e.classId].mods.dex + (passiveOf(e, 'alert')?.value ?? 0);
  }

  /** Fresh start for every fight: cooldowns ready, no leftover statuses, once-per-fight effects back. */
  private prepareForFight(p: PlayerEntity) {
    for (const s of p.skills) s.cd = 0;
    p.statuses = [];
    p.used = [];
    p.tempHp = passiveOf(p, 'arcane_ward')?.value ?? 0;
    if (hasBranch(p, 'slippery', 'B') || hasBranch(p, 'alert', 'B')) p.statuses.push({ id: 'focused', turns: 99 });
  }

  private startCombat() {
    for (const p of this.heroes()) this.prepareForFight(p);
    const fighters: Entity[] = [...this.heroes().filter((p) => !p.dead), ...this.monsters()];
    const init: Record<string, number> = {};
    for (const e of fighters) init[e.id] = rollDie(20) + this.initBonus(e);
    const order = fighters.map((e) => e.id).sort((a, b) => init[b] - init[a]); // stable: players win ties
    this.turn = { order, init, index: 0, round: 1, movesLeft: 0, actionUsed: false, bonusUsed: false };
    this.addLog('system', `🎲 Roll for initiative! ${order.map((id) => `${this.entity(id)?.name} ${init[id]}`).join(' · ')}`);
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
    t.movesLeft = hasStatus(e, 'dazed') ? Math.floor(e.speed / 2) : e.speed;
    t.actionUsed = false;
    t.bonusUsed = false;
    if (e.kind === 'player' && e.dead) return this.advanceTurn();

    if (e.kind === 'player' && !e.downed) this.heroTurnStart(e);
    this.tickStatuses(e);
    if (this.checkEnd()) return;
    if (!this.entities.includes(e)) return this.advanceTurn(); // burned to death
    if (e.kind === 'player' && e.dead) return this.advanceTurn();

    if (e.kind === 'player' && e.downed) {
      this.deathSave(e);
      if (e.downed) this.later(token, 1000, () => this.advanceTurn());
      // A great death save gets them back up mid-turn: auto heroes still need someone to play it.
      else if (!e.dead && this.isAuto(e.playerId)) this.runHero(e, token);
    } else if (hasStatus(e, 'stunned')) {
      this.addLog('info', `💫 ${e.name} is stunned and loses the turn.`);
      this.float(e, 'stunned', '#ffd84d');
      this.later(token, 900, () => this.advanceTurn());
    } else if (e.kind === 'monster') {
      this.runMonster(e, token).catch((err) => console.error('monster AI error', err));
    } else if (this.isAuto(e.playerId)) {
      this.runHero(e, token);
    }
    this.broadcast();
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
    const ward = passiveOf(p, 'arcane_ward');
    if (ward && hasBranch(p, 'arcane_ward', 'B')) p.tempHp = Math.min(ward.value, p.tempHp + 3);
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

  /** End of a creature's turn: statuses count down. */
  private endOfTurn(e: Entity) {
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
        map: this, hero: p, heroes: this.heroes(), monsters: this.monsters(), turn: t,
        occupied: (x, y, exceptId) => this.occupied(x, y, exceptId),
      });
      if (intent.kind === 'end') break;
      if (intent.kind === 'act') {
        const used = this.handleSkill(p.playerId, intent.skill, intent.target);
        if (!ok()) return;
        if (!used) break; // rejected: don't loop on it
        await sleep(450);
      } else {
        const path = findPath(this, p, (x, y) => this.occupied(x, y, p.id), (x, y) => x === intent.to.x && y === intent.to.y);
        if (!path?.length) break;
        for (const step of path.slice(0, t.movesLeft)) {
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
    const kind = this.roomKind ?? 'combat';
    const run = this.run!;
    this.dispose();
    // Everyone gets back up, then the party catches its breath (a short rest).
    for (const p of this.heroes()) {
      if (p.dead || p.downed) {
        p.dead = false;
        p.downed = false;
        p.saves = { ok: 0, fail: 0 };
      }
      p.statuses = [];
      p.tempHp = 0;
      p.used = [];
      for (const s of p.skills) s.cd = 0;
      p.hp = Math.min(p.maxHp, Math.max(1, p.hp) + Math.ceil(p.maxHp * POST_FIGHT_HEAL));
    }
    this.addLog('heal', `🫁 The party catches its breath: everyone heals ${POST_FIGHT_HEAL * 100}% of their max HP.`);
    const gold = roomGold(run.act, kind);
    run.gold += gold;
    this.addLog('loot', `✅ Room cleared! The party loots ${gold} gold.`);
    const leveled = this.checkLevelUps();
    if (kind === 'boss') return this.finishAct();
    this.notice = {
      glyph: kind === 'elite' ? '💀' : '✅',
      title: kind === 'elite' ? 'Elite defeated!' : 'Room cleared',
      text: `+${gold} gold.${leveled.length ? ` ⬆️ Level up: ${leveled.join(', ')}!` : ''}`,
    };
    this.toMap();
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

    if (def.breath && this.turn && this.turn.round % 3 === 0) {
      const victims = this.heroes().filter((p) => this.standing(p) && dist(p, m) <= 3 && hasLOS(this, m, p));
      if (victims.length) {
        this.breathWeapon(m, victims);
        this.broadcast();
        if (this.checkEnd()) return;
        await sleep(700);
        if (ok()) this.advanceTurn();
        return;
      }
    }

    const canHit = (from: Pos, t: Pos) => dist(from, t) <= def.range && (def.range === 1 || hasLOS(this, from, t));
    // Taunted monsters go for whoever taunted them.
    const taunt = m.statuses.find((s) => s.id === 'taunted');
    const taunter = this.heroes().find((p) => p.id === taunt?.by && this.standing(p));
    const target =
      taunter ??
      this.heroes()
        .filter((p) => this.standing(p))
        .sort((a, b) => dist(a, m) - dist(b, m) || a.hp - b.hp)[0];
    if (!target) return this.advanceTurn();

    if (!canHit(m, target)) {
      const goal = (x: number, y: number) => canHit({ x, y }, target);
      // If other monsters block the way, path through them and shuffle as close as possible.
      const path =
        findPath(this, m, (x, y) => this.occupied(x, y, m.id), goal) ??
        findPath(this, m, (x, y) => this.heroes().some((p) => !p.dead && p.x === x && p.y === y), goal) ??
        [];
      for (const step of path.slice(0, this.turn?.movesLeft ?? m.speed)) {
        if (this.occupied(step.x, step.y, m.id)) break;
        const stopped = this.provokeSentinels(m, step);
        if (!this.entities.includes(m)) return diedMidTurn();
        if (stopped) break;
        m.x = step.x;
        m.y = step.y;
        this.broadcast();
        await sleep(MONSTER_STEP_MS);
        if (!ok()) return;
      }
    }

    for (let i = 0; i < def.attacks; i++) {
      const victim =
        this.standing(target) && canHit(m, target) && !(taunter && target !== taunter)
          ? target
          : this.heroes().find((p) => this.standing(p) && canHit(m, p));
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

  /** One monster attack, with the heroes' defensive tricks: Bodyguard steps in, Riposte strikes back. */
  private monsterAttack(m: MonsterEntity, victim: PlayerEntity) {
    const def = MONSTERS[m.type];
    let target = victim;
    const guard = this.heroes().find(
      (h) => h !== victim && this.standing(h) && hasBranch(h, 'sentinel', 'A') && dist(h, victim) <= 1 && !h.used.includes('round:bodyguard'),
    );
    if (guard) {
      guard.used.push('round:bodyguard');
      this.addLog('info', `🛡️ ${guard.name} throws themself in front of ${victim.name}!`);
      target = guard;
    }
    const hit = this.attackRoll(m, target, { bonus: def.atk, dmg: def.dmg, verb: def.verb, element: def.element ?? 'physical' });
    if (!hit && hasStatus(target, 'riposte') && this.standing(target) && dist(m, target) <= 1 && this.entities.includes(m)) {
      this.addLog('info', `🤺 ${target.name} ripostes!`);
      this.freeStrike(target, m, 'Riposte');
    }
  }

  /** Sentinel: heroes get a free swing at monsters walking out of their reach. Returns true if the monster is stopped. */
  private provokeSentinels(m: MonsterEntity, to: Pos): boolean {
    for (const h of this.heroes()) {
      const sentinel = passiveOf(h, 'sentinel');
      if (!sentinel || !this.standing(h) || h.used.includes('round:sentinel')) continue;
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

  private breathWeapon(m: MonsterEntity, victims: PlayerEntity[]) {
    this.addLog('crit', `🔥 ${m.name} unleashes a torrent of fire!`);
    for (const p of victims) {
      const { total: save, text } = this.heroSave(p, 'dex');
      const saved = save >= BREATH_DC;
      let dmg = rollDice({ n: 3, d: 6 });
      const evasion = hasBranch(p, 'opportunist', 'B');
      if (saved) dmg = evasion ? 0 : Math.floor(dmg / 2);
      else if (evasion) dmg = Math.floor(dmg / 2);
      this.shot(m, p, '#ff7b2e');
      this.addLog(saved ? 'miss' : 'hit', `${p.name} DEX save ${text} vs DC ${BREATH_DC}: ${saved ? (evasion ? 'evades it completely' : 'half damage') : 'fails'}, ${dmg} fire.`);
      if (dmg > 0) this.damage(p, dmg, m, 'fire', true);
    }
  }

  /** A hero's saving throw: d20 + stat + Steady + Bless; Fortune rerolls a natural 1. */
  private heroSave(p: PlayerEntity, stat: 'dex' | 'str' | 'wis'): { total: number; text: string } {
    let d20 = rollDie(20);
    if (d20 === 1 && this.useLucky(p, true)) d20 = rollDie(20);
    const bonus = statMod(p.classId, stat) + (passiveOf(p, 'steady')?.value ?? 0) + (hasStatus(p, 'blessed') ? 2 : 0);
    return { total: d20 + bonus, text: `🎲${d20}${fmtMod(bonus)}=${d20 + bonus}` };
  }

  /** Spends a Lucky reroll if the hero has one left. `save`: Fortune also covers saves. */
  private useLucky(p: PlayerEntity, save = false): boolean {
    const lucky = passiveOf(p, 'lucky');
    if (!lucky || (save && !hasBranch(p, 'lucky', 'A'))) return false;
    if (p.used.filter((u) => u === 'fight:lucky').length >= lucky.value) return false;
    p.used.push('fight:lucky');
    this.addLog('info', `🍀 ${p.name} gets lucky and rerolls the natural 1!`);
    return true;
  }

  // ------------------------------------------------------------ hero skills

  /** Uses a skill if it's allowed right now. Returns true if it happened (the auto-play loop needs to know). */
  handleSkill(playerId: string, skillId: unknown, aim: unknown): boolean {
    const p = this.hero(playerId);
    if (!p || !isSkillId(skillId)) return false;
    if (this.phase !== 'map' && this.phase !== 'event' && this.phase !== 'rest' && this.phase !== 'combat') return false;
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
      if (s.cost === 'action') this.turn.actionUsed = true;
      else if (s.cost === 'bonus') this.turn.bonusUsed = true;
    }
    if (kind === 'spell') p.slots -= slotCost(s);
    if (kind === 'cantrip') own.cd = (s.cooldown ?? 0) + 1; // ticks down at the start of each of your turns
    if (skillId === 'potion') p.potions--;
    this.useSkill(p, own, s, res);
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
    const singleRoll = (s.target === 'enemy' && !!s.roll) || (s.target === 'ally' && !!s.heal);
    if (!singleRoll && !(s.target === 'self' && s.heal)) {
      const on = res.main && s.target !== 'area' ? ` on ${res.main.name}` : '';
      this.addLog('info', `${s.icon} ${p.name} uses ${name}${on}!`);
    }

    // Movement tricks first.
    if (s.teleport && res.main) this.teleportNextTo(p, res.main);
    if (s.pull) this.pullFoes(p, res.foes, s.pull);
    if (s.target === 'area' || s.target === 'around') {
      this.fx.push({ kind: 'burst', x: res.center.x, y: res.center.y, radius: s.radius ?? 1, color });
    }

    // Foes: roll, damage, then statuses and knockback on whoever got hit.
    for (const f of res.foes) {
      if (!this.entities.includes(f)) continue; // died to an earlier hit
      let landed = false;
      if (!s.roll) landed = true;
      else if (s.roll === 'auto') landed = this.autoHit(p, f, s, name, color);
      else {
        for (let i = 0; i < hitsOf(p, s) && this.entities.includes(f); i++) {
          const hit = s.roll === 'save' ? this.saveHit(p, f, s, name, color) : this.weaponHit(p, f, s, name, color, basic);
          landed ||= hit;
        }
      }
      if (!landed || !this.entities.includes(f)) continue;
      for (const st of s.onHit ?? []) this.applyStatus(f, st, p);
      if (s.push) this.push(f, s.target === 'area' && (f.x !== res.center.x || f.y !== res.center.y) ? res.center : p, s.push);
    }

    // Friends: heals, temporary HP, cleansing and buffs.
    for (const fr of res.friends) {
      if (s.heal) {
        const amount = rollDice({ n: s.heal.n, d: s.heal.d }) + healBonus(p, s);
        const healed = this.healBy(p, fr, amount, s.overheal);
        const line =
          s.target === 'self'
            ? `${p.name} uses ${name}`
            : singleRoll
              ? `${p.name} uses ${name} on ${fr === p ? 'themself' : fr.name}`
              : `${fr.name} is healed`;
        this.addLog('heal', `${s.icon} ${line}: +${healed} HP.`);
      }
      if (s.tempHp) fr.tempHp = Math.max(fr.tempHp, rollDice(s.tempHp));
      if (s.cleanse) fr.statuses = fr.statuses.filter((x) => !['burning', 'poisoned', 'dazed', 'blinded'].includes(x.id));
      for (const st of s.status ?? []) this.applyStatus(fr, st, p);
      if (s.status?.length && fr !== p) this.grantXp(p, XP_BUFF);
    }

    // You.
    for (const st of s.selfStatus ?? []) this.applyStatus(p, st, p);
    if (s.taunt) {
      const taunted = this.monsters().filter((m) => dist(m, p) <= s.taunt!.radius);
      for (const m of taunted) this.applyStatus(m, { id: 'taunted', turns: s.taunt.turns }, p);
      if (taunted.length) this.addLog('info', `😤 ${taunted.map((m) => m.name).join(', ')} can't take their eyes off ${p.name}.`);
    }
    if (this.turn && this.phase === 'combat' && this.current()?.id === p.id) {
      if (s.dash) this.turn.movesLeft += s.dash;
      if (s.refresh) {
        this.turn.actionUsed = false;
        p.used.push('turn:surge');
      }
    }
    if (s.resetCooldowns) for (const o of p.skills) if (o !== own) o.cd = 0;
  }

  /** An attack-roll skill against one foe. */
  private weaponHit(p: PlayerEntity, f: MonsterEntity, s: SkillStats, name: string, color: string, basic: boolean): boolean {
    if (dist(p, f) > 1) this.shot(p, f, color);
    return this.attackRoll(p, f, {
      bonus: attackBonus(p, s), dmg: s.dmg ?? { n: 1, d: 4 }, extra: damageMod(p, s), verb: 'attacks', weapon: name,
      element: s.element ?? 'physical', adv: s.adv, sneak: s.sneak, execute: s.execute, critFull: s.critFull, basic,
    });
  }

  /** A saving-throw skill against one foe. Returns true if it failed the save. */
  private saveHit(p: PlayerEntity, f: MonsterEntity, s: SkillStats, name: string, color: string): boolean {
    const def = MONSTERS[f.type];
    const save = s.save ?? 'dex';
    const d20 = rollDie(20);
    const total = d20 + def[save];
    const dc = saveDc(p.classId, p.level);
    const saved = total >= dc;
    this.shot(p, f, color);
    let dmg = s.dmg ? rollDice(s.dmg) + damageMod(p, s) + this.bonusDamage(p, f, s.element ?? 'physical') : 0;
    if (saved) dmg = s.half ? Math.floor(dmg / 2) : 0;
    const roll = `${save.toUpperCase()} save 🎲${d20}${fmtMod(def[save])}=${total} vs DC ${dc}`;
    this.addLog(saved ? 'miss' : 'hit', `${f.name} ${saved ? 'resists' : 'is caught by'} ${p.name}'s ${name} (${roll})${dmg ? `: ${dmg}${elementWord(s.element)}` : ''}.`);
    if (dmg > 0) this.damage(f, dmg, p, s.element ?? 'physical');
    else this.float(f, 'saved', '#9aa0a6');
    if (!saved && this.entities.includes(f)) this.afterHit(p, f, s.element ?? 'physical', false);
    return !saved;
  }

  /** Never misses (Magic Missile): every dart in one go. */
  private autoHit(p: PlayerEntity, f: MonsterEntity, s: SkillStats, name: string, color: string): boolean {
    const hits = hitsOf(p, s);
    let total = 0;
    for (let i = 0; i < hits; i++) total += rollDice(s.dmg ?? { n: 1, d: 4 }) + damageMod(p, s) + this.bonusDamage(p, f, s.element ?? 'physical');
    this.shot(p, f, color);
    this.addLog('hit', `${p.name}'s ${name}: ${hits} hit${hits > 1 ? 's' : ''} strike ${f.name} for ${total}${elementWord(s.element)}.`);
    this.damage(f, total, p, s.element ?? 'physical');
    if (this.entities.includes(f)) this.afterHit(p, f, s.element ?? 'physical', false);
    return true;
  }

  /** A free basic attack outside the normal action economy (Sentinel, Riposte, Cleave). */
  private freeStrike(p: PlayerEntity, t: Entity, label: string): boolean {
    const basic = p.skills.find((o) => SKILLS[o.id].kind === 'basic' && statsOf(o).range <= 1) ?? p.skills.find((o) => SKILLS[o.id].kind === 'basic');
    const s = basic ? statsOf(basic) : statsAt('longsword');
    return this.attackRoll(p, t, {
      bonus: attackBonus(p, s), dmg: s.dmg ?? { n: 1, d: 6 }, extra: damageMod(p, s), verb: 'strikes', weapon: label,
      element: s.element ?? 'physical', sneak: s.sneak, basic: true,
    });
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
    const spot = spots.sort((a, b) => dist(b, from) - dist(a, from))[0];
    p.x = spot.x;
    p.y = spot.y;
    this.addLog('info', `🌑 ${p.name} steps out of the shadows behind ${t.name}.`);
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
    }
  }

  /** Knocks a creature `tiles` steps directly away from `from`; walls and creatures stop it. */
  private push(t: Entity, from: Pos, tiles: number) {
    const dx = Math.sign(t.x - from.x);
    const dy = Math.sign(t.y - from.y);
    if (!dx && !dy) return;
    let moved = 0;
    for (let i = 0; i < tiles; i++) {
      if (!canStep(this, t, dx, dy) || this.occupied(t.x + dx, t.y + dy, t.id)) break;
      t.x += dx;
      t.y += dy;
      moved++;
    }
    if (moved) this.addLog('info', `${t.name} is knocked back ${moved} tile${moved > 1 ? 's' : ''}.`);
  }

  /** Adds or refreshes a status. Statuses put on whoever's turn it is don't count that turn. */
  private applyStatus(t: Entity, a: StatusApply, by?: Entity) {
    if (!this.entities.includes(t)) return;
    if (t.kind === 'player' && (a.id === 'stunned' || a.id === 'dazed') && hasBranch(t, 'steady', 'A')) return; // Unshakable
    if (t.kind === 'player' && a.id === 'burning' && hasBranch(t, 'elemental_affinity', 'B')) return; // Attunement
    const turns = a.turns + (t.id === this.turnOwner ? 1 : 0);
    const have = t.statuses.find((x) => x.id === a.id);
    if (have) {
      have.turns = Math.max(have.turns, turns);
      if (a.power) have.power = Math.max(have.power ?? 0, a.power);
      if (by) have.by = by.id;
    } else {
      t.statuses.push({ id: a.id, turns, ...(a.power ? { power: a.power } : {}), ...(by ? { by: by.id } : {}) });
    }
    const def = STATUSES[a.id];
    if (this.phase === 'combat' && t !== by) this.float(t, `${def.icon} ${def.name}`, def.good ? '#7ddc6f' : '#ffb04d');
  }

  // ------------------------------------------------------------ dice & damage

  /** Armor class right now: Shielded and Spell Shield add to it. */
  private acOf(t: Entity): number {
    let ac = t.ac;
    for (const s of t.statuses) if (s.id === 'shielded') ac += s.power ?? 2;
    if (t.kind === 'player' && t.tempHp > 0 && hasBranch(t, 'arcane_ward', 'A')) ac += 2;
    return ac;
  }

  /** Flat damage from the attacker's passives: Opportunist vs the wounded, Elemental Affinity on fire. */
  private bonusDamage(a: Entity, t: Entity, element: Element): number {
    if (a.kind !== 'player') return 0;
    let extra = 0;
    if (t.hp < t.maxHp / 2) extra += passiveOf(a, 'opportunist')?.value ?? 0;
    if (element === 'fire') extra += passiveOf(a, 'elemental_affinity')?.value ?? 0;
    return extra;
  }

  /** Rolls an attack (advantage, crits, Sneak Attack, passives) and applies the damage. Returns true on a hit. */
  private attackRoll(a: Entity, t: Entity, o: AttackOpts): boolean {
    const hero = a.kind === 'player' ? a : null;
    const focused = a.statuses.find((s) => s.id === 'focused');
    if (focused) a.statuses = a.statuses.filter((s) => s !== focused); // spent on this attack
    const adv = !!o.adv || !!focused || hasStatus(t, 'marked');
    const dis = hasStatus(a, 'blinded');
    const r1 = rollDie(20);
    const r2 = rollDie(20);
    let d20 = adv && !dis ? Math.max(r1, r2) : dis && !adv ? Math.min(r1, r2) : r1;
    const rolled = adv !== dis ? `🎲${r1}|${r2}→${d20}` : `🎲${d20}`;
    let reroll = '';
    if (d20 === 1 && hero && this.useLucky(hero)) {
      d20 = rollDie(20);
      reroll = ` 🍀→${d20}`;
    }
    const bonus = o.bonus + (hasStatus(a, 'blessed') ? 2 : 0) - (hasStatus(a, 'dazed') ? 2 : 0);
    const ac = this.acOf(t);
    const critRange = hero && hasBranch(hero, 'lucky', 'B') ? 19 : 20;
    const crit = d20 >= critRange || (!!o.critFull && t.hp >= t.maxHp);
    const hit = crit || (d20 !== 1 && d20 + bonus >= ac);
    if (dist(a, t) > 1 && a.kind === 'monster') this.shot(a, t, ELEMENT_COLOR[o.element]);
    const what = `${a.name} ${o.verb} ${t.name}${o.weapon ? ` (${o.weapon})` : ''}`;
    const roll = `${rolled}${reroll}${fmtMod(bonus)}=${d20 + bonus} vs AC ${ac}`;
    if (!hit) {
      this.addLog('miss', `${what}: ${roll}, miss${d20 === 1 ? ' (natural 1!)' : ''}`);
      this.float(t, 'miss', '#9aa0a6');
      return false;
    }

    let total = rollDice(o.dmg, crit) + (o.extra ?? 0) + this.bonusDamage(a, t, o.element);
    const notes: string[] = [];
    if (hero && o.sneak && !hero.used.includes('turn:sneak')) {
      const flanked = this.heroes().some((h) => h !== hero && this.standing(h) && dist(h, t) <= 1);
      if (flanked || (adv && !dis)) {
        const sneak = rollDice({ n: sneakDice(hero.level), d: 6 }, crit);
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
    const favor = a.statuses.find((s) => s.id === 'blessed' && s.power);
    if (favor) {
      const holy = rollDice({ n: 1, d: 4 }, crit);
      total += holy;
      notes.push(`${holy} Divine Favor`);
    }
    total = Math.max(1, total);
    this.addLog(crit ? 'crit' : 'hit', `${what}: ${roll}, ${crit ? 'CRITICAL HIT' : 'hit'} for ${total}${elementWord(o.element)}${notes.length ? ` (incl. ${notes.join(', ')})` : ''}`);
    this.damage(t, total, a, o.element);
    if (hero && this.entities.includes(t)) this.afterHit(hero, t, o.element, !!o.basic);
    return true;
  }

  /** On-hit passives that put statuses on the target or heal allies. */
  private afterHit(p: PlayerEntity, t: Entity, element: Element, basic: boolean) {
    if (element === 'fire' && hasBranch(p, 'elemental_affinity', 'A')) this.applyStatus(t, { id: 'burning', turns: 2 }, p);
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

  private damage(t: Entity, amount: number, by?: Entity, element: Element = 'physical', area = false) {
    if (t.kind === 'player') {
      if (element === 'fire' && hasBranch(t, 'elemental_affinity', 'B')) amount = Math.floor(amount / 2);
      if (by && !area && amount > 1 && hasBranch(t, 'slippery', 'A') && !t.used.includes('round:dodge') && this.standing(t)) {
        t.used.push('round:dodge');
        amount = Math.ceil(amount / 2);
        this.addLog('info', `🐍 ${t.name} twists away: half damage.`);
      }
      if (t.tempHp > 0) {
        const soaked = Math.min(t.tempHp, amount);
        t.tempHp -= soaked;
        amount -= soaked;
        if (soaked) this.float(t, `🛡${soaked}`, '#8fd8ff');
      }
      if (amount >= t.hp && t.hp > 1 && this.standing(t) && hasBranch(t, 'battle_hardened', 'A') && !t.used.includes('fight:unbreakable')) {
        t.used.push('fight:unbreakable');
        amount = t.hp - 1;
        this.addLog('info', `🪨 ${t.name} refuses to fall!`);
      }
    }
    if (amount <= 0) return;
    if (t.kind === 'monster' && by?.kind === 'player') t.dmgBy[by.id] = (t.dmgBy[by.id] ?? 0) + Math.min(amount, t.hp);
    t.hp = Math.max(0, t.hp - amount);
    this.float(t, `-${amount}`, t.kind === 'player' ? '#ff6b6b' : '#ffd84d');
    if (t.hp > 0) return;
    if (t.kind === 'monster') {
      this.monsterDies(t, by);
    } else if (!t.downed && !t.dead) {
      t.downed = true;
      t.saves = { ok: 0, fail: 0 };
      t.statuses = [];
      this.cancelWalk(t.id);
      this.addLog('death', `🩸 ${t.name} falls unconscious! Heal them to get them back up.`);
    }
  }

  /** Kill credit, kill steals, XP shares and on-kill passives. */
  private monsterDies(t: MonsterEntity, by?: Entity) {
    this.entities = this.entities.filter((e) => e !== t);
    this.removeFromOrder(t.id);
    const killer = by?.kind === 'player' ? by : null;
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
      } else {
        this.addLog('death', `💀 ${t.name} is slain by ${killer.name}!`);
      }
    } else {
      this.addLog('death', `💀 ${t.name} is slain!`);
    }
    const alive = this.heroes().filter((h) => !h.dead);
    const shares = killShares(MONSTERS[t.type].xp, killer?.id ?? null, t.dmgBy, alive.map((h) => h.id));
    for (const [id, xp] of shares) {
      const h = this.heroes().find((x) => x.id === id);
      if (h) this.grantXp(h, xp);
    }
    if (killer && this.standing(killer)) this.onKill(killer);
  }

  private onKill(p: PlayerEntity) {
    const thirst = passiveOf(p, 'bloodthirsty');
    if (thirst) {
      const healed = this.healBy(null, p, thirst.value);
      if (healed) this.addLog('heal', `🩸 ${p.name} drinks in the victory: +${healed} HP.`);
      if (hasBranch(p, 'bloodthirsty', 'A') && this.turn && this.current()?.id === p.id) this.turn.movesLeft += 3;
      if (hasBranch(p, 'bloodthirsty', 'B')) for (const h of this.heroes()) if (h !== p && this.standing(h)) this.healBy(null, h, 2);
    }
    const myTurn = this.turn && this.current()?.id === p.id;
    if (myTurn && this.turn!.actionUsed && hasBranch(p, 'opportunist', 'A') && !p.used.includes('turn:executioner')) {
      p.used.push('turn:executioner');
      this.turn!.actionUsed = false;
      this.addLog('info', `🦊 Executioner! ${p.name} gets their action back.`);
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
      this.addLog('heal', `${t.name} is back on their feet!`);
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
    const bonus = passiveOf(p, 'steady')?.value ?? 0;
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

  private monsters(): MonsterEntity[] {
    return this.entities.filter((e): e is MonsterEntity => e.kind === 'monster');
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
      notice: this.notice,
      roomKind: this.roomKind,
      width: this.width,
      height: this.height,
      tiles: this.tiles,
      players: this.players,
      entities: this.entities,
      turn: this.turn,
      log: this.log,
    };
  }
}

const elementWord = (e?: Element) => (e && e !== 'physical' ? ` ${e}` : '');
