// Types shared by the server (rules + state) and the browser client (rendering).

import type { SkillId, StatusId } from './skills.ts';

export type ClassId = 'fighter' | 'rogue' | 'wizard' | 'cleric';
export type Phase = 'lobby' | 'map' | 'combat' | 'event' | 'rest' | 'victory' | 'defeat';
export type NodeType = 'combat' | 'elite' | 'event' | 'rest' | 'treasure' | 'shop' | 'boss';

export interface Pos {
  x: number;
  y: number;
}

/** A condition on a creature. `turns` counts down at the end of that creature's turns. */
export interface StatusInst {
  id: StatusId;
  turns: number;
  power?: number; // e.g. +AC for Shielded, extra dice for Burning
  by?: string; // entity id of whoever applied it (taunt target, kill credit for burn damage)
}

interface EntityBase {
  id: string;
  name: string;
  glyph: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number; // tiles per turn (1 tile = 5 ft)
  statuses: StatusInst[];
  facing: Pos; // 8-way direction it looks: where it last moved or attacked (never 0,0). Attacks from behind have advantage.
}

/** A skill a hero knows. Tier 3 always has a branch. */
export interface OwnedSkill {
  id: SkillId;
  tier: 1 | 2 | 3;
  branch?: 'A' | 'B';
  cd: number; // cantrips: your turns until it's ready again (0 = ready)
}

/** One card in a level-up offer. */
export type OfferCard =
  | { kind: 'learn'; skill: SkillId }
  | { kind: 'upgrade'; skill: SkillId; tier: 2 | 3 } // tier 3: the player also picks branch A or B
  | { kind: 'boon'; boon: BoonId };

export type BoonId = 'hp' | 'ac' | 'potions' | 'slot';

/** How a hero spends a rest site. */
export type RestPick = { kind: 'long' } | { kind: 'train'; skill: SkillId; branch?: 'A' | 'B' };

export interface PlayerEntity extends EntityBase {
  kind: 'player';
  playerId: string;
  classId: ClassId;
  color: string;
  level: number;
  xp: number; // progress toward the next level
  skills: OwnedSkill[]; // basic attacks, cantrips, spells and passives, in hotbar order
  levelUps: number; // level-up picks still to make
  offer: OfferCard[] | null; // the cards for the current pick
  bonusHp: number; // permanent max HP from events, boons and items
  bonusAc: number;
  bonusSlots: number;
  tempHp: number; // soaks damage first; gone after the fight
  potions: number;
  kills: number;
  steals: number; // killing blows on monsters someone else did most of the damage to
  slots: number;
  maxSlots: number;
  downed: boolean;
  dead: boolean;
  saves: { ok: number; fail: number };
  used: string[]; // once-per-fight / per-round / per-turn effects already spent ('fight:lucky', 'round:bodyguard', 'turn:sneak')
}

export interface MonsterEntity extends EntityBase {
  kind: 'monster';
  type: string;
  boss: boolean;
  elite: boolean;
  dmgBy: Record<string, number>; // hero entity id -> damage dealt (XP assists and kill steals)
}

export type Entity = PlayerEntity | MonsterEntity;

export interface PlayerInfo {
  id: string;
  name: string;
  classId: ClassId;
  color: string;
  connected: boolean;
  auto: boolean; // the player switched on auto-play
  bot: boolean; // a server-side bot player (always on auto)
}

export interface TurnState {
  order: string[]; // entity ids, highest initiative first
  init: Record<string, number>;
  index: number;
  round: number;
  movesLeft: number;
  actionUsed: boolean;
  bonusUsed: boolean;
}

export type LogKind = 'info' | 'hit' | 'miss' | 'crit' | 'heal' | 'death' | 'chat' | 'system' | 'loot' | 'level';

export interface LogLine {
  id: number;
  kind: LogKind;
  text: string;
}

// ---------------------------------------------------------------- the run

export interface MapNode {
  id: string;
  row: number; // 0 = bottom row; the boss sits on row `rows`
  col: number;
  type: NodeType;
  next: string[]; // ids of the nodes this one leads to
}

export interface ActMap {
  act: number;
  rows: number; // rows before the boss
  cols: number;
  nodes: MapNode[];
  bossId: string;
}

export interface RunInfo {
  act: number;
  maxAct: number;
  actName: string;
  map: ActMap;
  currentId: string | null; // null = at the start of the act, before the first row
  visited: string[];
  gold: number;
  seed: number;
}

export interface VoteState {
  kind: 'path' | 'event' | 'approach'; // approach: 'sneak' or 'charge', before a fight starts
  options: string[]; // node ids or event choice ids that can be picked
  votes: Record<string, string>; // playerId -> option
  endsInMs: number | null; // countdown after the first vote, as of when the state was sent
}

/** A rest site: every hero picks Long Rest or Train at the same time. */
export interface RestState {
  picks: Record<string, RestPick>; // playerId -> choice so far
  endsInMs: number | null; // countdown after the first pick; anyone undecided takes a Long Rest
}

export interface EventView {
  title: string;
  glyph: string;
  text: string;
  choices: { id: string; label: string; hint?: string }[];
}

export interface Notice {
  glyph: string;
  title: string;
  text: string;
}

/** A saved run waiting in the tavern to be continued (phase 'lobby'). */
export interface ResumeView {
  act: number;
  actName: string;
  savedAt: number; // ms since epoch
  // The saved party. A hero is claimed when a connected player has its playerId.
  heroes: { playerId: string; name: string; classId: ClassId; level: number; bot: boolean }[];
}

/** One saved run in the home screen's "Continue a saved run" list. */
export interface SaveSummary {
  code: string;
  act: number;
  actName: string;
  savedAt: number;
  party: { name: string; classId: ClassId; level: number; bot: boolean }[];
  online: number; // people in that room right now (0 = nobody has opened it since the server started)
}

export interface GameState {
  code: string;
  phase: Phase;
  hostId: string | null;
  resume: ResumeView | null; // set while a loaded save waits in the tavern
  run: RunInfo | null;
  vote: VoteState | null;
  event: EventView | null;
  rest: RestState | null;
  approach: { dc: number } | null; // the Sneak-or-Charge vote before a fight: the group Stealth DC
  notice: Notice | null; // result of the last rest/treasure/event, shown on the map
  roomKind: NodeType | null; // combat, elite or boss while a fight is on
  width: number; // current room; 0 when not in a room
  height: number;
  tiles: string; // '#' wall, '.' floor; index = y * width + x
  players: PlayerInfo[];
  entities: Entity[];
  turn: TurnState | null;
  log: LogLine[];
}

export type Fx =
  | { kind: 'float'; x: number; y: number; text: string; color: string }
  | { kind: 'shot'; from: Pos; to: Pos; color: string }
  | { kind: 'burst'; x: number; y: number; radius: number; color: string }; // area spells

export interface JoinRequest {
  code?: string;
  name: string;
  classId: ClassId;
  playerId?: string;
}

export type JoinResult = { ok: true; code: string; playerId: string } | { ok: false; error: string };

/** Level-up pick sent by the client: which card, plus a branch for tier III and a skill to forget if a bar is full. */
export interface PickRequest {
  card: number;
  branch?: 'A' | 'B';
  forget?: SkillId;
}
