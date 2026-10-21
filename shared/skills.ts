// Skills: basic attacks, cantrips (cooldowns), spells (slots) and passives, each with tiers I → II → III-A / III-B.
// Content is data. The server executes active skills generically from their stats (see SkillStats), the client
// describes them from the same stats, and the auto-play AI scores them from the same stats.
// Passives are hooks in the server, keyed by skill id; their numbers live in `value` per tier. Simpler passives are a
// `perk`: a stat block like equipment's (shared/items.ts statBlocks adds it up with gear, relics and blessings).

import { isAllyNpc, isFoe } from './elites.ts';
import { dist, hasLOS, type MapLike } from './grid.ts';
import { CLASSES, HELP_UP_HP, MAX_CANTRIPS, MAX_SPELLS, TIER3_LEVEL, passiveSlots, profBonus, saveDc, sneakDice, statMod, type Dice, type Stat } from './rules.ts';
import { ITEMS, describeStats, gearBonus, gearDef, isItemId, type GearStats, type ItemId, type Rarity, type Slot } from './items.ts';
import type { CloudId, GroundId, PropMap } from './surfaces.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, Pos } from './types.ts';
import { SUBCLASSES, type SubclassId } from './subclasses.ts';
import { ENGINES, ENGINE_IDS, type CardRarity, type EngineId } from './engines.ts';

// ---------------------------------------------------------------- statuses

export type StatusId =
  | 'burning'
  | 'poisoned'
  | 'stunned'
  | 'dazed'
  | 'blinded'
  | 'marked'
  | 'taunted'
  | 'shielded'
  | 'blessed'
  | 'focused'
  | 'riposte'
  | 'hidden'
  | 'surprised'
  | 'wet'
  | 'chilled'
  | 'frozen'
  | 'shocked'
  | 'netted'
  | 'webbed'
  | 'prone'
  | 'distracted'
  | 'drained'
  | 'rallied'
  | 'fury'
  | 'charging'
  | 'raging'
  | 'honed'
  | 'envenomed'
  | 'emboldened'
  | 'frightened'
  | 'groggy'
  | 'charged'
  | 'unleashed'
  | 'seared'
  | 'aiming'
  | 'verse'
  | 'linked'
  | 'inspired';

export interface StatusDef {
  name: string;
  icon: string;
  good: boolean; // a buff (shown green) or a debuff
  desc: string;
}

/**
 * Durations: `turns` drops by 1 at the end of each of the affected creature's turns, and is removed at 0.
 * A status applied to a creature during its own turn doesn't count that turn (so Shield cast on your turn lasts
 * through the enemies' turns). Burning and Poisoned deal their damage at the start of the creature's turn.
 * Elements add their own (shared/surfaces.ts): cold Chills, lightning Shocks, and a second hit, or one on a Wet
 * creature, Freezes or Stuns it.
 */
export const STATUSES: Record<StatusId, StatusDef> = {
  burning: { name: 'Burning', icon: '🔥', good: false, desc: 'Takes 1d4 fire damage (per power) at the start of each turn.' },
  poisoned: { name: 'Poisoned', icon: '🤢', good: false, desc: 'Takes 1d4 poison damage at the start of each turn.' },
  stunned: { name: 'Stunned', icon: '💫', good: false, desc: 'Loses its next turn.' },
  dazed: { name: 'Dazed', icon: '😵', good: false, desc: 'Half movement and −2 to attack rolls.' },
  blinded: { name: 'Blinded', icon: '🙈', good: false, desc: 'Attack rolls have disadvantage.' },
  marked: { name: 'Marked', icon: '🎯', good: false, desc: 'Attack rolls against it have advantage.' },
  taunted: { name: 'Taunted', icon: '😤', good: false, desc: 'Must attack whoever taunted it, if it can reach them.' },
  shielded: { name: 'Shielded', icon: '🔰', good: true, desc: '+AC (by its power).' },
  blessed: { name: 'Blessed', icon: '🙏', good: true, desc: '+2 to attack rolls and saves. With power, hits also deal +1d4 radiant.' },
  focused: { name: 'Focused', icon: '👁️', good: true, desc: 'The next attack roll has advantage.' },
  riposte: { name: 'Riposte', icon: '🤺', good: true, desc: 'Strikes back when a melee attack misses it.' },
  hidden: { name: 'Hidden', icon: '👤', good: true, desc: 'Enemies go for someone else if they can. The next attack has advantage and gives you away. With power, it also deals +power d6.' },
  surprised: { name: 'Surprised', icon: '😱', good: false, desc: "Caught off guard: loses its first turn and can't react (no Sentinel, Riposte or Bodyguard)." },
  wet: { name: 'Wet', icon: '💧', good: false, desc: "Half fire damage and can't catch fire, but lightning stuns it and cold freezes it." },
  chilled: { name: 'Chilled', icon: '🥶', good: false, desc: 'Half movement. More cold freezes it solid.' },
  frozen: { name: 'Frozen', icon: '🧊', good: false, desc: 'Frozen solid: loses its next turn. Fire thaws it.' },
  shocked: { name: 'Shocked', icon: '⚡', good: false, desc: '−2 AC. More lightning stuns it.' },
  // Monster tricks (Phase 12): set-ups that another monster pays off.
  netted: { name: 'Netted', icon: '🪢', good: false, desc: "Can't move, and ranged attacks against it have advantage. Cut Free (1 AP) gets out of it." },
  webbed: {
    name: 'Webbed', icon: '🕸️', good: false,
    desc: "Stuck in a web: can't move, attacks against it have advantage and its own have disadvantage. Cut Free (1 AP) or fire gets out of it.",
  },
  prone: { name: 'Prone', icon: '🤕', good: false, desc: 'Knocked down: melee attacks against it have advantage, ranged ones disadvantage. Getting up costs half its movement.' },
  distracted: { name: 'Distracted', icon: '👉', good: false, desc: "Someone's in its face: the next attack against it has advantage." },
  drained: { name: 'Drained', icon: '🩸', good: false, desc: 'Max HP lowered by its power until the end of the fight.' },
  rallied: { name: 'Rallied', icon: '📯', good: true, desc: '+1 to attack rolls and +1 damage per stack (stacks up to 3).' },
  fury: { name: 'Fury', icon: '😡', good: true, desc: 'A boss in a long fight: +1 to attack rolls and +10% damage per stack, and one more stack every round. Bring it down fast.' },
  charging: { name: 'Charging', icon: '🏃', good: true, desc: '+3 movement on its next turn.' },
  raging: { name: 'Raging', icon: '😤', good: true, desc: 'Melee hits deal + its power in damage, and physical damage against it is halved.' },
  honed: { name: 'Honed', icon: '💢', good: true, desc: 'The next hit deals +1d8 per power.' },
  envenomed: { name: 'Envenomed', icon: '☣️', good: true, desc: 'Weapon hits Poison the target (at its power).' },
  emboldened: { name: 'Emboldened', icon: '⚡', good: true, desc: '+AP (its power) at the start of the next turn.' },
  frightened: { name: 'Frightened', icon: '😨', good: false, desc: "Spends its turn running from whoever frightened it, and can't attack." },
  groggy: { name: 'Groggy', icon: '🥴', good: false, desc: 'Just got back up from 0 HP: loses its next turn.' },
  // Build-engine stacks (shared/engines.ts): their power is the number of stacks.
  charged: { name: 'Arcane Charge', icon: '🔷', good: true, desc: '+1 damage on spells per Charge.' },
  unleashed: { name: 'Unleashed', icon: '💥', good: true, desc: 'The next spell deals extra dice on each target (one per Charge spent).' },
  seared: { name: 'Radiance', icon: '🔆', good: false, desc: '+1 radiant damage taken per Radiance.' },
  aiming: { name: 'Focus', icon: '🧘', good: true, desc: 'Steady breathing: Kill Shot deals extra dice per Focus.' },
  verse: { name: 'Verse', icon: '🎼', good: true, desc: 'A Verse for the Finale.' },
  linked: { name: 'Soul Link', icon: '🔗', good: true, desc: 'Heals its cleric gives anyone else heal it too (its power is the share, in percent).' },
  inspired: { name: 'Inspired', icon: '🎇', good: true, desc: '+1d6 damage on hits per stack.' },
};

/** Statuses that make a creature lose its turn. */
export const SKIP_TURN: StatusId[] = ['stunned', 'frozen', 'surprised', 'groggy'];
/** Statuses that halve movement. */
export const SLOWED: StatusId[] = ['dazed', 'chilled'];
/** Statuses that keep a creature from moving. Cut Free (1 AP) removes them; fire burns a web away. */
export const ROOTED: StatusId[] = ['netted', 'webbed'];
/** What Purifying Touch and other cleanses remove. */
export const CLEANSED: StatusId[] = ['burning', 'poisoned', 'dazed', 'blinded', 'chilled', 'shocked', 'frozen', 'netted', 'webbed'];

export interface StatusApply {
  id: StatusId;
  turns: number;
  power?: number;
  stack?: number; // it stacks: each application adds its power, up to this many times (Rallied)
}

// ---------------------------------------------------------------- skill schema

export type SkillKind = 'basic' | 'cantrip' | 'spell' | 'passive' | 'item' | 'action'; // action: everyone has it (Shove)
export type Element = 'physical' | 'fire' | 'cold' | 'lightning' | 'poison' | 'radiant' | 'force';

/**
 * enemy:  one monster (aim = its id), within `range` and line of sight.
 * ally:   one hero, you included (aim = its id). Range only matters in a fight.
 * self:   you.
 * area:   every monster within `radius` of a tile (aim = a tile, or a creature's id for its tile) within `range`.
 * around: every monster within `radius` of you (no aim).
 * allies: you and every hero within `radius` of you (no aim).
 */
export type TargetMode = 'enemy' | 'ally' | 'self' | 'area' | 'around' | 'allies';

/**
 * What a skill does. The server runs it in this order:
 *  1. pay: AP, slots, cooldown
 *  2. teleport (step next to the main target, on the far side if free), pull (enemies within `pull` tiles are
 *     dragged next to you)
 *  3. for each foe: `hits` times roll (attack roll vs AC / save vs your DC / auto-hit), deal `dmg` (+ stat mod if
 *     `mod`, + Sneak Attack once per turn if `sneak` and an ally is next to the target or you have advantage,
 *     + `execute` if the target is below half HP), then on a hit or failed save apply `onHit` and `push`
 *     Area skills (aimed at a spot) hit heroes in the blast too: friendly fire.
 *  4. for each friend: heal, temp HP, Block, cleanse, `status`
 *  5. on you: `selfStatus`, `selfBlock`, `taunt` (enemies within radius), `dash`, `gainAp`, `resetCooldowns`
 *  6. the battlefield: the element reacts with the tiles it reached (where everyone stood when it was cast),
 *     then `surface` appears (see shared/surfaces.ts aimFieldOps)
 */
export interface SkillStats {
  name: string;
  icon: string;
  ap: number; // action points: 1 for quick things (the old bonus actions), 2 for attacks and most spells, 3 for the biggest
  target: TargetMode;
  range: number; // tiles; diagonals count as 1
  radius?: number; // area / around / allies
  cooldown?: number; // cantrips: unusable for this many of your turns after use
  slots?: number; // spells: slot cost (default 1)
  stat?: Stat; // to-hit and damage stat; defaults to the class's casting stat
  // offense
  roll?: 'attack' | 'save' | 'auto' | 'contest'; // contest: your stat + proficiency vs its best of STR/DEX, no damage
  save?: 'dex' | 'str' | 'wis';
  half?: boolean; // a successful save still takes half damage
  falloff?: boolean; // the outer ring of a radius 2+ area takes half damage (Fireball II, Meteor)
  dmg?: Dice;
  mod?: boolean; // add the stat modifier to damage
  hits?: number; // attack rolls (or darts) per target, default 1
  extraAttack?: boolean; // +1 hit from level 5 (Fighter's Extra Attack)
  chain?: number; // also hits up to this many other monsters within 2 tiles of the main target
  adv?: boolean; // attack rolls have advantage
  sneak?: boolean; // can add Sneak Attack
  execute?: Dice; // extra damage against targets below half HP
  critFull?: boolean; // always crits a target at full HP
  element?: Element;
  onHit?: StatusApply[]; // on each target hit (or failing its save); always, if the skill has no roll
  push?: number; // knock hit targets this many tiles away (from you, or from the area's center)
  pull?: number; // before hitting, drag enemies within this many tiles next to you
  teleport?: boolean;
  stealth?: boolean; // can't be used with an enemy next to you (Hide)
  // the battlefield (shared/surfaces.ts): fire, cold and lightning `element`s also react with whatever is on the tiles
  // they reach; `surface` leaves something behind (on the target's tile, the area, or `at: 'self'` around you)
  surface?: { ground?: GroundId; cloud?: CloudId; radius?: number; turns?: number; at?: 'self' };
  // support
  heal?: Dice;
  healMod?: boolean; // + casting stat modifier
  healLevel?: boolean; // + hero level
  overheal?: boolean; // healing past max HP becomes temporary HP
  cleanse?: boolean; // removes the statuses in CLEANSED
  frees?: boolean; // cuts a Netted or Webbed hero free
  helpUp?: boolean; // gets a downed friend back up at HELP_UP_HP of their max HP, Groggy (Help Up)
  noRevive?: boolean; // can't get a downed friend up (set by statsAt for a cantrip's heal)
  tempHp?: Dice;
  block?: Dice; // 🧱 Block on each friend affected (you, for a self skill), until the start of your next turn
  selfBlock?: Dice; // 🧱 Block on you after the rest (Bulwark Bash), until the start of your next turn
  blockLevel?: boolean; // + your level to the Block
  status?: StatusApply[]; // on each friend affected
  // you
  selfStatus?: StatusApply[];
  taunt?: { radius: number; turns: number };
  dash?: number; // extra movement this turn
  gainAp?: number; // AP back this turn, past the usual cap (Action Surge, Blood Price)
  hpCost?: number; // you pay this percent of your max HP first (Blood Price)
  healSelf?: number; // you heal this share of what the skill healed friends (Restoring Touch)
  trap?: { status: StatusApply[]; dmg?: Dice; element?: Element }; // hidden traps on the area's tiles: the first monster to step in gets it
  // build engines (shared/engines.ts)
  per?: PerBonus; // + damage for every stack of something (Rupture, Mind Rot, Dawn, Kill Shot, Shield Slam)
  poisonMult?: number; // multiplies the target's Poison (Toxic Catalyst)
  doubleBlock?: boolean; // the Block you gave yourself doubles (Entrench)
  unleash?: number; // spends your Arcane Charges: the next spell adds a d(this) per Charge on each target (Unleash)
  raise?: { cover: 'low' | 'wall'; tiles: number; turns?: number; ring?: boolean }; // cover or a wall rises across the spot (around the target with `ring`)
  rubble?: number; // leaves low cover on this many empty tiles of the area (Shatter Ground)
  finale?: { heal: number; block: number }; // per Verse spent, on every friend affected (Finale)
  oncePerTurn?: boolean; // usable once per turn (Brace)
  resetCooldowns?: boolean; // every other cantrip is ready again
  restoreSlots?: number; // slots back (Ether)
  // passives
  value?: number; // the tier's number, read by the server hook
  perk?: GearStats; // a passive's stat block, added up like equipment (shared/items.ts statBlocks)
  note?: string; // rules text the generated description can't express
}

/** What a `per` bonus counts: stacks on the target (Poison, Radiance, debuffs) or on you (Focus, Block, Verses). */
export type PerSource = 'poison' | 'radiance' | 'debuffs' | 'focus' | 'block' | 'verses';
export interface PerBonus {
  of: PerSource;
  dice?: Dice; // rolled once per stack
  flat?: number; // per stack
  spend?: boolean; // the stacks are used up
}

export interface SkillDef {
  kind: SkillKind;
  pool: ClassId | 'common';
  sub?: SubclassId; // gone since 2026-10-19 (cards belong to engines now, shared/engines.ts); kept for old codex code
  base: SkillStats; // tier I
  t2?: Partial<SkillStats>; // tier II, on top of tier I (no t2 = can't be upgraded)
  a?: Partial<SkillStats> & { name: string }; // tier III-A, on top of tier II
  b?: Partial<SkillStats> & { name: string }; // tier III-B, on top of tier II
}

export const DASH_TILES = 3; // 👟 Dash (everyone, 1 AP). Here, not in rules.ts: SKILLS is built while rules.ts is still loading.

const d = (n: number, sides: number, bonus?: number): Dice => (bonus ? { n, d: sides, bonus } : { n, d: sides });
const st = (id: StatusId, turns: number, power?: number, stack?: number): StatusApply =>
  stack ? { id, turns, power: power ?? 1, stack } : power ? { id, turns, power } : { id, turns };

type PassiveTier = { value?: number; note?: string; perk?: GearStats }; // no note: the perk's own description
/** Passives only carry text and a number per tier; the server implements the behavior. */
function passive(
  pool: SkillDef['pool'], icon: string, name: string,
  t1: PassiveTier, t2: PassiveTier, a: PassiveTier & { name: string }, b: PassiveTier & { name: string },
): SkillDef {
  return { kind: 'passive', pool, base: { name, icon, ap: 0, target: 'self', range: 0, ...t1 }, t2, a, b };
}

// ---------------------------------------------------------------- content

const SKILL_DEFS = {
  // ---------------------------------------------- basic attacks (free, no tiers)
  longsword: { kind: 'basic', pool: 'fighter', base: { name: 'Longsword', icon: '⚔️', ap: 2, target: 'enemy', range: 1, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true, extraAttack: true } },
  rapier: { kind: 'basic', pool: 'rogue', base: { name: 'Rapier', icon: '🗡️', ap: 2, target: 'enemy', range: 1, stat: 'dex', roll: 'attack', dmg: d(1, 8), mod: true, sneak: true } },
  shove: {
    kind: 'action', pool: 'common',
    base: { name: 'Shove', icon: '✋', ap: 1, target: 'enemy', range: 1, stat: 'str', roll: 'contest', push: 1, note: 'Win by 5 or more and it flies 2 tiles.' },
  },
  shortbow: { kind: 'basic', pool: 'rogue', base: { name: 'Shortbow', icon: '🏹', ap: 2, target: 'enemy', range: 8, stat: 'dex', roll: 'attack', dmg: d(1, 6), mod: true, sneak: true } },
  dagger: { kind: 'basic', pool: 'wizard', base: { name: 'Dagger', icon: '🔪', ap: 2, target: 'enemy', range: 4, stat: 'dex', roll: 'attack', dmg: d(1, 4), mod: true, note: 'Stab, or throw it up to 4 tiles.' } },
  mace: { kind: 'basic', pool: 'cleric', base: { name: 'Mace', icon: '🔨', ap: 2, target: 'enemy', range: 1, stat: 'str', roll: 'attack', dmg: d(1, 6), mod: true } },
  potion: { kind: 'item', pool: 'common', base: { name: 'Potion', icon: '🧪', ap: 1, target: 'ally', range: 1, heal: d(2, 4, 2), note: 'Drink it, or feed it to an ally next to you.' } },
  cut_free: { kind: 'action', pool: 'common', base: { name: 'Cut Free', icon: '✂️', ap: 1, target: 'ally', range: 1, frees: true } },
  help_up: { kind: 'action', pool: 'common', base: { name: 'Help Up', icon: '🤝', ap: 2, target: 'ally', range: 1, helpUp: true } },
  dash: { kind: 'action', pool: 'common', base: { name: 'Dash', icon: '👟', ap: 1, target: 'self', range: 0, dash: DASH_TILES } },
  brace: { kind: 'action', pool: 'common', base: { name: 'Brace', icon: '🧱', ap: 1, target: 'self', range: 0, block: d(1, 6), oncePerTurn: true } }, // class skills are the big Block

  // ---------------------------------------------- consumables (shared/items.ts): one use each, from the bag
  greater_potion: { kind: 'item', pool: 'common', base: { name: 'Greater Potion', icon: '🧴', ap: 1, target: 'ally', range: 1, heal: d(4, 4, 4), note: 'Drink it, or feed it to an ally next to you.' } },
  ether: { kind: 'item', pool: 'common', base: { name: 'Ether', icon: '🔮', ap: 1, target: 'self', range: 0, restoreSlots: 1 } },
  oil_flask: { kind: 'item', pool: 'common', base: { name: 'Oil Flask', icon: '🫗', ap: 1, target: 'area', range: 5, radius: 1, surface: { ground: 'oil' }, note: 'Throw it, then light it.' } },
  water_flask: { kind: 'item', pool: 'common', base: { name: 'Water Flask', icon: '🫙', ap: 1, target: 'area', range: 5, radius: 1, surface: { ground: 'water' }, note: 'Puts out fires and soaks whoever is there.' } },
  fire_bomb: { kind: 'item', pool: 'common', base: { name: 'Fire Bomb', icon: '🧨', ap: 2, target: 'area', range: 5, radius: 1, roll: 'save', save: 'dex', half: true, dmg: d(2, 6), element: 'fire' } },
  frost_bomb: { kind: 'item', pool: 'common', base: { name: 'Frost Bomb', icon: '☃️', ap: 2, target: 'area', range: 5, radius: 1, roll: 'save', save: 'dex', half: true, dmg: d(2, 6), element: 'cold' } },
  thunderstone: { kind: 'item', pool: 'common', base: { name: 'Thunderstone', icon: '🌩️', ap: 2, target: 'area', range: 5, radius: 1, roll: 'save', save: 'dex', half: true, dmg: d(2, 6), element: 'lightning' } },
  smoke_pellet: { kind: 'item', pool: 'common', base: { name: 'Smoke Pellet', icon: '💨', ap: 1, target: 'area', range: 5, radius: 1, surface: { cloud: 'smoke' } } },
  stink_bomb: { kind: 'item', pool: 'common', base: { name: 'Stink Bomb', icon: '🦨', ap: 1, target: 'area', range: 5, radius: 1, surface: { cloud: 'gas' } } },
  scroll_healing: { kind: 'item', pool: 'common', base: { name: 'Scroll of Mass Healing', icon: '📜', ap: 2, target: 'allies', radius: 6, range: 0, heal: d(2, 4, 2) } },
  scroll_blessing: { kind: 'item', pool: 'common', base: { name: 'Scroll of Blessing', icon: '📃', ap: 2, target: 'allies', radius: 4, range: 0, status: [st('blessed', 3)] } },

  // ---------------------------------------------- Fighter
  shield_bash: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Shield Bash', icon: '🛡️', ap: 1, target: 'enemy', range: 1, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(1, 4), mod: true, push: 1, onHit: [st('dazed', 1)] },
    t2: { dmg: d(1, 6), push: 2 },
    a: { name: 'Concussive Bash', onHit: [st('stunned', 1)] },
    b: { name: 'Bulwark Bash', taunt: { radius: 2, turns: 1 }, selfStatus: [], selfBlock: d(1, 6), blockLevel: true },
  },
  heavy_strike: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Heavy Strike', icon: '🪓', ap: 2, target: 'enemy', range: 1, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(2, 8), mod: true },
    t2: { dmg: d(3, 8) },
    a: { name: 'Sunder', onHit: [st('marked', 2)] },
    b: { name: 'Execute', execute: d(2, 8) },
  },
  battle_cry: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Battle Cry', icon: '📯', ap: 1, target: 'self', range: 0, cooldown: 3, taunt: { radius: 2, turns: 1 }, selfStatus: [st('shielded', 1, 2)] },
    t2: { taunt: { radius: 3, turns: 2 } },
    a: { name: 'Rallying Cry', target: 'allies', radius: 3, heal: d(1, 6), healLevel: true },
    b: { name: 'Iron Wall', selfBlock: d(2, 6), blockLevel: true },
  },
  second_wind: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Second Wind', icon: '💨', ap: 1, target: 'self', range: 0, slots: 1, heal: d(1, 10), healLevel: true },
    t2: { heal: d(2, 10) },
    a: { name: 'Adrenaline Rush', dash: 3, selfStatus: [st('focused', 1)] },
    b: { name: 'Rally', target: 'allies', radius: 2 },
  },
  whirlwind: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Whirlwind', icon: '🌀', ap: 2, target: 'around', radius: 1, range: 0, slots: 1, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true },
    t2: { dmg: d(2, 8) },
    a: { name: 'Cyclone', pull: 3 },
    b: { name: 'Bladestorm', hits: 2 },
  },
  action_surge: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Action Surge', icon: '⚡', ap: 1, target: 'self', range: 0, slots: 1, gainAp: 2, oncePerTurn: true },
    t2: { dash: 3 },
    a: { name: 'Battle Surge', ap: 0 },
    b: { name: 'Second Surge', resetCooldowns: true },
  },
  sentinel: passive('fighter', '👁️', 'Sentinel',
    { note: 'When an enemy next to you walks away, you get a free Longsword attack on it.' },
    { note: 'Your free attack also stops its movement on a hit.' },
    { name: 'Bodyguard', note: 'Free attack that stops movement. Once per round, you take an attack meant for an ally next to you.' },
    { name: 'Cleave', note: 'Free attack that stops movement. When you kill an enemy, you get a free Longsword attack on another one next to you.' }),
  battle_hardened: passive('fighter', '🪨', 'Battle Hardened',
    { value: 2, note: 'Start your turn below half HP: regain 2 HP.' },
    { value: 4, note: 'Start your turn below half HP: regain 4 HP.' },
    { name: 'Unbreakable', value: 4, note: 'Regain 4 HP at the start of your turn below half HP. Once per fight, a hit that would drop you leaves you at 1 HP.' },
    { name: 'Iron Skin', value: 4, note: 'Regain 4 HP at the start of your turn below half HP. +1 AC.' }),

  // ---------------------------------------------- Rogue
  cunning_dash: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Cunning Dash', icon: '👟', ap: 1, target: 'self', range: 0, cooldown: 2, dash: 6 },
    t2: { cooldown: 1 },
    a: { name: 'Blur', selfStatus: [st('shielded', 1, 2)] },
    b: { name: 'Hit and Run', selfStatus: [st('focused', 1)] },
  },
  feint: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Feint', icon: '🎭', ap: 1, target: 'enemy', range: 1, cooldown: 3, selfStatus: [st('focused', 1)], note: 'No roll: it always works.' },
    t2: { cooldown: 2, range: 4 },
    a: { name: 'Mark for Death', selfStatus: undefined, onHit: [st('marked', 2)] },
    b: { name: 'Riposte', selfStatus: [st('focused', 1), st('riposte', 1)] },
  },
  hide: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Hide', icon: '👤', ap: 1, target: 'self', range: 0, cooldown: 2, stealth: true, selfStatus: [st('hidden', 2)] },
    t2: { cooldown: 1 },
    a: { name: 'Shadow Strike', selfStatus: [st('hidden', 2, 2)] },
    b: { name: 'Smoke and Mirrors', stealth: false },
  },
  throwing_knives: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Throwing Knives', icon: '🔪', ap: 2, target: 'enemy', range: 5, cooldown: 2, stat: 'dex', roll: 'attack', dmg: d(1, 4), mod: true, hits: 2 },
    t2: { hits: 3 },
    a: { name: 'Fan of Knives', target: 'area', radius: 1, hits: 2 },
    b: { name: 'Poisoned Knives', onHit: [st('poisoned', 2)] },
  },
  shadow_step: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Shadow Step', icon: '🌑', ap: 2, target: 'enemy', range: 6, slots: 1, teleport: true, stat: 'dex', roll: 'attack', adv: true, dmg: d(1, 8), mod: true, sneak: true },
    t2: { range: 9, dmg: d(2, 8) },
    a: { name: 'Assassinate', critFull: true },
    b: { name: 'Smoke Bomb', surface: { cloud: 'smoke', radius: 1, at: 'self' }, selfStatus: [st('hidden', 2)], dash: 3 },
  },
  cheap_shot: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Cheap Shot', icon: '👊', ap: 2, target: 'enemy', range: 1, slots: 1, stat: 'dex', roll: 'attack', adv: true, dmg: d(1, 8), mod: true, sneak: true, onHit: [st('stunned', 1)] },
    t2: { dmg: d(2, 8) },
    a: { name: 'Knockout', onHit: [st('stunned', 2)] },
    b: { name: 'Crippling Shot', onHit: [st('stunned', 1), st('poisoned', 3)] },
  },
  hail_of_arrows: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Hail of Arrows', icon: '🎯', ap: 2, target: 'area', range: 8, radius: 1, slots: 1, stat: 'dex', roll: 'attack', dmg: d(1, 6), mod: true },
    t2: { dmg: d(2, 6) },
    a: { name: 'Volley', radius: 2 },
    b: { name: 'Poison Rain', onHit: [st('poisoned', 2)] },
  },
  opportunist: passive('rogue', '🦊', 'Opportunist',
    { value: 2, note: '+2 damage against targets below half HP.' },
    { value: 4, note: '+4 damage against targets below half HP.' },
    { name: 'Executioner', value: 4, note: '+4 damage against targets below half HP. Once per turn, a killing blow gives you 2 AP back.' },
    { name: 'Evasion', value: 4, note: '+4 damage against targets below half HP. Area attacks (like breath) deal half damage to you, none on a successful save.' }),
  slippery: passive('rogue', '🐍', 'Slippery',
    { value: 1, note: '+1 movement.' },
    { value: 2, note: '+2 movement.' },
    { name: 'Uncanny Dodge', value: 2, note: '+2 movement. Once per round, halve the damage of a hit.' },
    { name: 'Shadow', value: 2, note: '+2 movement. Start every fight Focused (your first attack has advantage).' }),

  // ---------------------------------------------- Wizard
  fire_bolt: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Fire Bolt', icon: '🔥', ap: 2, target: 'enemy', range: 8, roll: 'attack', dmg: d(1, 10), element: 'fire' }, // no cooldown: the Wizard's at-will ranged attack
    t2: { dmg: d(2, 10) },
    a: { name: 'Inferno', surface: { ground: 'fire' } },
    b: { name: 'Splitting Bolt', chain: 1 },
  },
  ray_of_frost: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Ray of Frost', icon: '❄️', ap: 2, target: 'enemy', range: 6, cooldown: 2, roll: 'attack', dmg: d(1, 8), element: 'cold' },
    t2: { dmg: d(2, 8) },
    a: { name: 'Deep Freeze', onHit: [st('frozen', 1)] },
    b: { name: 'Glacial Ray', range: 8, surface: { ground: 'ice', radius: 1 } },
  },
  shocking_grasp: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Shocking Grasp', icon: '⚡', ap: 2, target: 'enemy', range: 1, cooldown: 2, roll: 'attack', adv: true, dmg: d(1, 8), element: 'lightning', push: 2 },
    t2: { dmg: d(2, 8) },
    a: { name: 'Thunderclap', target: 'around', radius: 1 },
    b: { name: 'Chain Lightning', chain: 2 },
  },
  magic_missile: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Magic Missile', icon: '🌟', ap: 2, target: 'enemy', range: 8, slots: 1, roll: 'auto', dmg: d(1, 4, 1), hits: 3, element: 'force' },
    t2: { hits: 4 },
    a: { name: 'Missile Barrage', hits: 6 },
    b: { name: 'Mind Spike', onHit: [st('dazed', 1)] },
  },
  fireball: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Fireball', icon: '☄️', ap: 3, target: 'area', range: 8, radius: 1, slots: 1, roll: 'save', save: 'dex', half: true, falloff: true, dmg: d(3, 6), element: 'fire' },
    t2: { dmg: d(4, 6), radius: 2 },
    a: { name: 'Meteor', dmg: d(6, 6), slots: 2, surface: { ground: 'fire' } },
    b: { name: 'Concussive Blast', push: 1, onHit: [st('dazed', 1)] },
  },
  grease: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Grease', icon: '🛢️', ap: 2, target: 'area', range: 8, radius: 1, slots: 1, surface: { ground: 'oil' }, note: 'Oil burns: one spark sets all of it ablaze.' },
    t2: { radius: 2 },
    a: { name: 'Quick Grease', ap: 1 },
    b: { name: 'Slick', surface: { ground: 'oil', turns: 10 }, onHit: [st('dazed', 1)] },
  },
  shield: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Shield', icon: '🔰', ap: 1, target: 'self', range: 0, slots: 1, status: [st('shielded', 1, 4)] },
    t2: { status: [st('shielded', 2, 4)] },
    a: { name: 'Warding Flare', target: 'allies', radius: 2 },
    b: { name: 'Arcane Armor', status: [st('shielded', 3, 4)], tempHp: d(2, 6) },
  },
  elemental_affinity: passive('wizard', '🌋', 'Elemental Affinity',
    { value: 1, note: '+1 damage on every fire hit.' },
    { value: 2, note: '+2 damage on every fire hit.' },
    { name: 'Overload', value: 2, note: '+2 fire damage, and your fire hits set the target Burning for 2 turns.' },
    { name: 'Attunement', value: 2, note: '+2 fire damage. You take half damage from fire, can\'t be set Burning, and fire on the ground doesn\'t hurt you.' }),
  arcane_ward: passive('wizard', '🔮', 'Arcane Ward',
    { value: 5, note: 'Start every fight with 5 temporary HP.' },
    { value: 10, note: 'Start every fight with 10 temporary HP.' },
    { name: 'Spell Shield', value: 10, note: 'Start every fight with 10 temporary HP. +2 AC while any of it is left.' },
    { name: 'Recharging Ward', value: 10, note: 'Start every fight with 10 temporary HP, and regain 3 (up to 10) at the start of each of your turns.' }),

  // ---------------------------------------------- Cleric
  sacred_flame: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Sacred Flame', icon: '☀️', ap: 2, target: 'enemy', range: 6, cooldown: 1, roll: 'save', save: 'dex', dmg: d(1, 8), element: 'radiant' },
    t2: { dmg: d(2, 8) },
    a: { name: 'Searing Flame', onHit: [st('blinded', 1)] },
    b: { name: 'Radiant Flame', target: 'area', radius: 1 },
  },
  word_of_radiance: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Word of Radiance', icon: '🌞', ap: 2, target: 'around', radius: 1, range: 0, cooldown: 2, roll: 'save', save: 'str', dmg: d(1, 6), element: 'radiant' },
    t2: { dmg: d(2, 6) },
    a: { name: 'Blinding Word', onHit: [st('blinded', 1)] },
    b: { name: 'Wide Radiance', radius: 2 },
  },
  healing_touch: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Healing Touch', icon: '🤲', ap: 1, target: 'ally', range: 1, cooldown: 3, heal: d(1, 4), healMod: true },
    t2: { range: 3 },
    a: { name: 'Purifying Touch', heal: d(2, 4), cleanse: true },
    b: { name: 'Sanctuary', status: [st('shielded', 1, 2)] },
  },
  healing_word: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Healing Word', icon: '💖', ap: 1, target: 'ally', range: 6, slots: 1, heal: d(1, 4), healMod: true },
    t2: { heal: d(2, 4) },
    a: { name: 'Mass Healing Word', target: 'allies', radius: 6 },
    b: { name: 'Second Chance', overheal: true },
  },
  create_water: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Create Water', icon: '🌧️', ap: 2, target: 'area', range: 8, radius: 1, slots: 1, surface: { ground: 'water' }, note: 'Puts out fires and washes away oil and poison. Wet enemies are easy to shock or freeze.' },
    t2: { radius: 2 },
    a: { name: 'Downpour', radius: 3 },
    b: { name: 'Tidal Wave', push: 1, onHit: [st('dazed', 1)] },
  },
  bless: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Bless', icon: '🙏', ap: 2, target: 'allies', radius: 3, range: 0, slots: 1, status: [st('blessed', 3)] },
    t2: { radius: 4, status: [st('blessed', 4)] },
    a: { name: 'Holy Aura', status: [st('blessed', 4), st('shielded', 4, 1)] },
    b: { name: 'Divine Favor', status: [st('blessed', 4, 1)] },
  },
  guiding_bolt: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Guiding Bolt', icon: '✴️', ap: 3, target: 'enemy', range: 8, slots: 1, roll: 'attack', dmg: d(4, 6), element: 'radiant', onHit: [st('marked', 1)] },
    t2: { dmg: d(5, 6) },
    a: { name: 'Sunburst', target: 'area', radius: 1 },
    b: { name: 'Holy Fire', onHit: [st('marked', 1), st('burning', 3)] },
  },
  blessed_healer: passive('cleric', '😇', 'Blessed Healer',
    { value: 0.5, note: 'When you heal an ally, you heal half as much yourself.' },
    { value: 1, note: 'When you heal an ally, you heal the same amount yourself.' },
    { name: 'Beacon', value: 1, note: 'Heal yourself as much as you heal an ally, and healed allies get +2 AC until their next turn ends.' },
    { name: 'Shepherd', value: 1, note: 'Heal yourself as much as you heal an ally. +2 to every heal, and +50% support XP.' }),
  divine_strike: passive('cleric', '⚜️', 'Divine Strike',
    { value: 4, note: 'Your Mace hits deal +1d4 radiant.' },
    { value: 8, note: 'Your Mace hits deal +1d8 radiant.' },
    { name: 'Blinding Strike', value: 8, note: 'Your Mace hits deal +1d8 radiant and Blind the target for 1 turn.' },
    { name: 'Holy Mending', value: 8, note: 'Your Mace hits deal +1d8 radiant and heal the most hurt ally within 6 tiles for 1d4 + WIS.' }),

  // ---------------------------------------------- common passives (anyone can take them)
  tough: passive('common', '💪', 'Tough',
    { value: 4, note: '+4 max HP.' },
    { value: 8, note: '+8 max HP.' },
    { name: 'Colossus', value: 14, note: '+14 max HP.' },
    { name: 'Regeneration', value: 8, note: '+8 max HP, and regain 1 HP at the start of each of your turns.' }),
  alert: passive('common', '⏰', 'Alert',
    { value: 3, note: "+3 initiative. You can't be surprised." },
    { value: 5, note: "+5 initiative. You can't be surprised." },
    { name: 'Quickstep', value: 5, note: "+5 initiative and +1 movement. You can't be surprised." },
    { name: 'First Strike', value: 5, note: "+5 initiative, and start every fight Focused (your first attack has advantage). You can't be surprised." }),
  lucky: passive('common', '🍀', 'Lucky',
    { value: 1, note: 'Once per fight, reroll an attack that rolled a natural 1.' },
    { value: 2, note: 'Twice per fight, reroll an attack that rolled a natural 1.' },
    { name: 'Fortune', value: 2, note: 'Twice per fight, reroll a natural 1 on an attack, a save or a death save.' },
    { name: 'Jackpot', value: 2, note: 'Twice per fight, reroll a natural 1 on an attack. Your attacks also crit on a natural 19.' }),
  bloodthirsty: passive('common', '🩸', 'Bloodthirsty',
    { value: 3, note: 'Heal 3 HP when you land a killing blow.' },
    { value: 6, note: 'Heal 6 HP when you land a killing blow.' },
    { name: 'Frenzy', value: 6, note: 'Heal 6 HP and gain 3 movement when you land a killing blow.' },
    { name: 'Feast', value: 6, note: 'Heal 6 HP when you land a killing blow, and every ally heals 2.' }),
  steady: passive('common', '🧘', 'Steady',
    { value: 1, note: '+1 to saves and death saves.' },
    { value: 2, note: '+2 to saves and death saves.' },
    { name: 'Unshakable', value: 3, note: '+3 to saves and death saves. Immune to Stunned and Dazed.' },
    { name: 'Defiant', value: 2, note: '+2 to saves and death saves. A death save of 15 or more gets you back up with 1 HP.' }),

  // ---------------------------------------------- more class passives (Phase 12: deeper pools)
  fighting_style: passive('fighter', '⚔️', 'Fighting Style',
    { perk: { hit: 1 } },
    { perk: { hit: 1, ac: 1 } },
    { name: 'Dueling', perk: { hit: 1, ac: 1, dmg: 2 } },
    { name: 'Defense', perk: { hit: 1, ac: 2 } }),
  trip_attack: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Trip Attack', icon: '🦵', ap: 2, target: 'enemy', range: 1, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true, onHit: [st('prone', 1)] },
    t2: { dmg: d(2, 8) },
    a: { name: 'Sweeping Trip', target: 'around', radius: 1 },
    b: { name: 'Hamstring', onHit: [st('prone', 1), st('dazed', 1)] },
  },
  nimble: passive('rogue', '🤸', 'Nimble',
    { perk: { ac: 1, init: 2 } },
    { perk: { ac: 1, init: 3, stealth: 3 } },
    { name: 'Acrobat', perk: { ac: 2, init: 3, speed: 1 } },
    { name: 'Master Thief', perk: { ac: 1, init: 3, stealth: 6, lucky: 1 } }),
  arcane_focus: passive('wizard', '🔷', 'Arcane Focus',
    { perk: { power: 1 } },
    { perk: { power: 1, slots: 1 } },
    { name: 'Spell Mastery', perk: { power: 2, slots: 1 } },
    { name: 'Overchannel', perk: { power: 1, slots: 2 } }),
  devout: passive('cleric', '📿', 'Devout',
    { perk: { heal: 1, saves: 1 } },
    { perk: { heal: 2, saves: 1 } },
    { name: "Healer's Grace", perk: { heal: 3, saves: 1 } },
    { name: 'Warpriest', perk: { heal: 2, hit: 1, ac: 1 } }),

  // ---------------------------------------------- Barbarian (Phase 12)
  greataxe: { kind: 'basic', pool: 'barbarian', base: { name: 'Greataxe', icon: '🪓', ap: 2, target: 'enemy', range: 1, stat: 'str', roll: 'attack', dmg: d(1, 12), mod: true, extraAttack: true } },
  rage: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Rage', icon: '😤', ap: 1, target: 'self', range: 0, cooldown: 4, selfStatus: [st('raging', 3, 2)] },
    t2: { selfStatus: [st('raging', 3, 3)] },
    a: { name: 'Berserk', dash: 3 },
    b: { name: 'Bear Totem', tempHp: d(2, 6) },
  },
  reckless_attack: {
    kind: 'cantrip', pool: 'barbarian',
    base: {
      name: 'Reckless Attack', icon: '💢', ap: 2, target: 'enemy', range: 1, cooldown: 1, stat: 'str', roll: 'attack', adv: true, dmg: d(1, 12), mod: true,
      selfStatus: [st('marked', 1)], note: 'Wide open: attacks against you have advantage until your next turn ends.',
    },
    t2: { dmg: d(2, 8) },
    a: { name: 'Savage Swings', hits: 2 },
    b: { name: 'Calculated Fury', selfStatus: undefined, note: undefined },
  },
  ground_slam: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Ground Slam', icon: '🌋', ap: 2, target: 'around', radius: 1, range: 0, cooldown: 2, stat: 'str', roll: 'save', save: 'str', dmg: d(1, 8), onHit: [st('prone', 1)] },
    t2: { dmg: d(2, 8) },
    a: { name: 'Earthshaker', radius: 2 },
    b: { name: 'Shockwave', push: 1 },
  },
  war_roar: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Menacing Roar', icon: '🦁', ap: 1, target: 'around', radius: 2, range: 0, cooldown: 3, stat: 'str', roll: 'save', save: 'wis', onHit: [st('dazed', 1)] },
    t2: { radius: 3 },
    a: { name: 'Dread Roar', onHit: [st('dazed', 1), st('marked', 1)] },
    b: { name: 'War Cry', target: 'allies', radius: 3, roll: undefined, save: undefined, onHit: undefined, status: [st('rallied', 3, 1, 3)] },
  },
  brutal_strike: {
    kind: 'spell', pool: 'barbarian',
    base: { name: 'Brutal Strike', icon: '💥', ap: 3, target: 'enemy', range: 1, slots: 1, stat: 'str', roll: 'attack', dmg: d(3, 10), mod: true, onHit: [st('prone', 1)] },
    t2: { dmg: d(4, 10) },
    a: { name: 'Skullsplitter', onHit: [st('prone', 1), st('stunned', 1)] },
    b: { name: 'Bonebreaker', onHit: [st('prone', 1), st('dazed', 2), st('marked', 2)] },
  },
  relentless: {
    kind: 'spell', pool: 'barbarian',
    base: { name: 'Relentless', icon: '💀', ap: 1, target: 'self', range: 0, slots: 1, heal: d(2, 6), healLevel: true, cleanse: true },
    t2: { heal: d(3, 6) },
    a: { name: 'Second Rage', resetCooldowns: true },
    b: { name: 'Undying', tempHp: d(2, 8) },
  },
  harpoon: {
    kind: 'spell', pool: 'barbarian',
    base: { name: 'Harpoon', icon: '🪝', ap: 2, target: 'enemy', range: 5, slots: 1, stat: 'str', roll: 'attack', dmg: d(2, 8), mod: true, pull: 5, note: 'Drags it next to you first.' },
    t2: { dmg: d(3, 8) },
    a: { name: 'Reel and Rend', onHit: [st('marked', 2)] },
    b: { name: 'Chain Hook', chain: 1 },
  },
  earth_splitter: {
    kind: 'spell', pool: 'barbarian',
    base: { name: 'Earth Splitter', icon: '⛰️', ap: 3, target: 'area', range: 4, radius: 1, slots: 1, stat: 'str', roll: 'save', save: 'dex', half: true, dmg: d(3, 8), onHit: [st('prone', 1)] },
    t2: { radius: 2 },
    a: { name: 'Chasm', dmg: d(5, 8), slots: 2 },
    b: { name: 'Aftershock', onHit: [st('prone', 1), st('dazed', 1)] },
  },
  thick_hide: passive('barbarian', '🦏', 'Thick Hide',
    { perk: { ac: 1, hp: 4 } },
    { perk: { ac: 1, hp: 8 } },
    { name: 'Stoneskin', perk: { ac: 2, hp: 8 } },
    { name: 'Juggernaut', perk: { ac: 1, hp: 12, resist: { poison: 'resist' } } }),
  danger_sense: passive('barbarian', '⚠️', 'Danger Sense',
    { perk: { saves: 1, init: 2 } },
    { perk: { saves: 2, init: 3 } },
    { name: 'Feral Instinct', perk: { saves: 2, init: 5, alert: true } },
    { name: 'Evasive', perk: { saves: 2, init: 3, speed: 1 } }),
  brutal_blows: passive('barbarian', '🔨', 'Brutal Blows',
    { perk: { dmg: 1 } },
    { perk: { dmg: 2 } },
    { name: 'Brutal Critical', perk: { dmg: 3 } },
    { name: 'Heavy Hitter', perk: { dmg: 2, shove: 2 } }),

  // ---------------------------------------------- Ranger (Phase 12)
  longbow: { kind: 'basic', pool: 'ranger', base: { name: 'Longbow', icon: '🏹', ap: 2, target: 'enemy', range: 10, stat: 'dex', roll: 'attack', dmg: d(1, 8), mod: true } },
  shortsword: { kind: 'basic', pool: 'ranger', base: { name: 'Shortsword', icon: '🗡️', ap: 2, target: 'enemy', range: 1, stat: 'dex', roll: 'attack', dmg: d(1, 6), mod: true, extraAttack: true } },
  hunters_mark: {
    kind: 'cantrip', pool: 'ranger',
    base: { name: "Hunter's Mark", icon: '🎯', ap: 1, target: 'enemy', range: 10, cooldown: 3, onHit: [st('marked', 2)], note: 'No roll: it always works.' },
    t2: { cooldown: 2 },
    a: { name: 'Mark the Pack', chain: 2 },
    b: { name: 'Quarry', onHit: [st('marked', 3)] },
  },
  ensnaring_shot: {
    kind: 'cantrip', pool: 'ranger',
    base: { name: 'Ensnaring Shot', icon: '🪢', ap: 2, target: 'enemy', range: 8, cooldown: 3, stat: 'dex', roll: 'attack', dmg: d(1, 8), mod: true, onHit: [st('netted', 1)] },
    t2: { dmg: d(2, 8) },
    a: { name: 'Thorned Snare', onHit: [st('netted', 2), st('poisoned', 2)] },
    b: { name: 'Net Volley', target: 'area', radius: 1 },
  },
  quick_shot: {
    kind: 'cantrip', pool: 'ranger',
    base: { name: 'Quick Shot', icon: '🏹', ap: 1, target: 'enemy', range: 8, cooldown: 2, stat: 'dex', roll: 'attack', dmg: d(1, 6) },
    t2: { dmg: d(1, 10) },
    a: { name: 'Double Shot', hits: 2 },
    b: { name: 'Pinning Shot', onHit: [st('dazed', 1)] },
  },
  lightning_arrow: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Lightning Arrow', icon: '⚡', ap: 2, target: 'enemy', range: 10, slots: 1, stat: 'dex', roll: 'attack', dmg: d(3, 8), element: 'lightning' },
    t2: { dmg: d(4, 8) },
    a: { name: 'Storm Arrow', chain: 2 },
    b: { name: 'Thunder Arrow', push: 2, onHit: [st('dazed', 1)] },
  },
  hail_of_thorns: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Hail of Thorns', icon: '🌵', ap: 3, target: 'area', range: 8, radius: 1, slots: 1, roll: 'save', save: 'dex', half: true, dmg: d(2, 10), element: 'poison' },
    t2: { dmg: d(3, 10) },
    a: { name: 'Bramble Field', surface: { ground: 'poison' } },
    b: { name: 'Thorn Wall', onHit: [st('netted', 1)] },
  },
  herbal_remedy: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Herbal Remedy', icon: '🌿', ap: 1, target: 'ally', range: 1, slots: 1, heal: d(2, 4), healMod: true, cleanse: true },
    t2: { heal: d(3, 4) },
    a: { name: 'Healing Spirit', target: 'allies', radius: 2 },
    b: { name: 'Barkskin', status: [st('shielded', 2, 2)] },
  },
  steady_aim: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Steady Aim', icon: '🔭', ap: 1, target: 'self', range: 0, slots: 1, selfStatus: [st('focused', 1), st('blessed', 2)] },
    t2: { selfStatus: [st('focused', 1), st('blessed', 3)] },
    a: { name: 'Deadeye', selfStatus: [st('focused', 1), st('blessed', 3, 1)] },
    b: { name: "Hunter's Patience", selfStatus: [st('focused', 1), st('blessed', 3), st('hidden', 2)] },
  },
  favored_foe: passive('ranger', '🐺', 'Favored Foe',
    { value: 2, note: '+2 damage against Marked targets.' },
    { value: 4, note: '+4 damage against Marked targets.' },
    { name: 'Relentless Hunter', value: 4, note: '+4 damage against Marked targets, and +1 movement.', perk: { speed: 1 } },
    { name: 'Pack Tactics', value: 4, note: '+4 damage against Marked targets, and +1 to attack rolls.', perk: { hit: 1 } }),
  natural_explorer: passive('ranger', '🧭', 'Natural Explorer',
    { perk: { init: 2, stealth: 2 } },
    { perk: { init: 3, speed: 1, stealth: 3 } },
    { name: 'Pathfinder', perk: { init: 4, speed: 2, stealth: 3 } },
    { name: 'Ambusher', perk: { init: 3, speed: 1, stealth: 5, alert: true } }),
  archery: passive('ranger', '🎯', 'Archery',
    { perk: { hit: 1 } },
    { perk: { hit: 2 } },
    { name: 'Sharpshooter', perk: { hit: 2, dmg: 2 } },
    { name: 'Eagle Eye', perk: { hit: 2, lucky: 1 } }),

  // ---------------------------------------------- Paladin (Phase 12)
  warhammer: { kind: 'basic', pool: 'paladin', base: { name: 'Warhammer', icon: '🔨', ap: 2, target: 'enemy', range: 1, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true, extraAttack: true } },
  lay_on_hands: {
    kind: 'cantrip', pool: 'paladin',
    base: { name: 'Lay on Hands', icon: '🙌', ap: 1, target: 'ally', range: 1, cooldown: 3, heal: d(1, 8), healLevel: true },
    t2: { heal: d(2, 8) },
    a: { name: 'Cleansing Touch', cleanse: true },
    b: { name: 'Shield of Faith', status: [st('shielded', 2, 2)] },
  },
  compelled_duel: {
    kind: 'cantrip', pool: 'paladin',
    base: { name: 'Compelled Duel', icon: '⚔️', ap: 1, target: 'enemy', range: 4, cooldown: 3, roll: 'save', save: 'wis', onHit: [st('taunted', 2)], note: 'On a failed save it has to come for you.' },
    t2: { range: 6 },
    a: { name: 'Hold the Line', target: 'around', radius: 2 },
    b: { name: 'Rebuke', onHit: [st('taunted', 2), st('marked', 2)] },
  },
  radiant_strike: {
    kind: 'cantrip', pool: 'paladin',
    base: { name: 'Radiant Strike', icon: '✨', ap: 2, target: 'enemy', range: 1, cooldown: 1, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true, element: 'radiant' },
    t2: { dmg: d(2, 8) },
    a: { name: 'Searing Smite', onHit: [st('burning', 2)] },
    b: { name: 'Thunderous Smite', push: 2, onHit: [st('prone', 1)] },
  },
  bulwark: {
    kind: 'cantrip', pool: 'paladin',
    base: { name: 'Bulwark', icon: '🛡️', ap: 1, target: 'ally', range: 1, cooldown: 3, block: d(2, 4), blockLevel: true },
    t2: { block: d(2, 6) },
    a: { name: 'Guardian', target: 'allies', radius: 1 },
    b: { name: 'Sacred Bond', heal: d(1, 6), healMod: true },
  },
  divine_smite: {
    kind: 'spell', pool: 'paladin',
    base: { name: 'Divine Smite', icon: '⚡', ap: 2, target: 'enemy', range: 1, slots: 1, stat: 'str', roll: 'attack', dmg: d(3, 8), mod: true, element: 'radiant' },
    t2: { dmg: d(4, 8) },
    a: { name: 'Blinding Smite', onHit: [st('blinded', 2)] },
    b: { name: 'Staggering Smite', onHit: [st('dazed', 2), st('prone', 1)] },
  },
  healing_hands: {
    kind: 'spell', pool: 'paladin',
    base: { name: 'Healing Hands', icon: '💗', ap: 2, target: 'ally', range: 1, slots: 1, heal: d(2, 8), healMod: true },
    t2: { heal: d(3, 8) },
    a: { name: 'Mass Cure', target: 'allies', radius: 2 },
    b: { name: 'Restoration', cleanse: true, overheal: true },
  },
  crusaders_mantle: {
    kind: 'spell', pool: 'paladin',
    base: { name: "Crusader's Mantle", icon: '🔆', ap: 2, target: 'allies', radius: 3, range: 0, slots: 1, status: [st('blessed', 3, 1)] },
    t2: { radius: 4, status: [st('blessed', 4, 1)] },
    a: { name: 'Aura of Valor', status: [st('blessed', 4, 1), st('shielded', 4, 1)] },
    b: { name: 'Holy Vigor', tempHp: d(1, 8) },
  },
  aura_of_protection: passive('paladin', '🛡️', 'Aura of Protection',
    { value: 1, note: 'You and every ally within 2 tiles get +1 to saves.' },
    { value: 2, note: 'You and every ally within 2 tiles get +2 to saves.' },
    { name: 'Aura of Devotion', value: 3, note: 'You and every ally within 2 tiles get +3 to saves.' },
    { name: 'Wide Aura', value: 2, note: 'You and every ally within 4 tiles get +2 to saves.' }),
  divine_health: passive('paladin', '💚', 'Divine Health',
    { perk: { hp: 3, resist: { poison: 'resist' } } },
    { perk: { hp: 6, resist: { poison: 'resist' } } },
    { name: 'Purity of Body', perk: { hp: 6, resist: { poison: 'immune' } } },
    { name: 'Holy Bulwark', perk: { hp: 6, ac: 1, resist: { poison: 'resist' } } }),
  defender: passive('paladin', '🏰', 'Defender',
    { perk: { ac: 1 } },
    { perk: { ac: 1, shove: 2 } },
    { name: 'Protection', perk: { ac: 2, shove: 2 } },
    { name: 'Great Weapon', perk: { ac: 1, dmg: 3 } }),

  // ---------------------------------------------- Bard (Phase 12)
  hand_crossbow: { kind: 'basic', pool: 'bard', base: { name: 'Hand Crossbow', icon: '🏹', ap: 2, target: 'enemy', range: 6, stat: 'dex', roll: 'attack', dmg: d(1, 6), mod: true } },
  vicious_mockery: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Vicious Mockery', icon: '🗯️', ap: 2, target: 'enemy', range: 6, cooldown: 1, roll: 'save', save: 'wis', dmg: d(1, 6), element: 'force', onHit: [st('dazed', 1)] },
    t2: { dmg: d(2, 6) },
    a: { name: 'Cutting Words', onHit: [st('dazed', 1), st('marked', 1)] },
    b: { name: 'Crowd Heckle', target: 'area', radius: 1 },
  },
  inspiration: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Bardic Inspiration', icon: '🎵', ap: 1, target: 'ally', range: 6, cooldown: 2, status: [st('focused', 1)] },
    t2: { status: [st('focused', 1), st('blessed', 2)] },
    a: { name: 'Song of Valor', target: 'allies', radius: 3, status: [st('rallied', 3, 1, 3)] },
    b: { name: 'Song of Defense', status: [st('focused', 1), st('shielded', 2, 2)] },
  },
  thunderwave: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Thunderwave', icon: '🌩️', ap: 2, target: 'around', radius: 1, range: 0, cooldown: 2, roll: 'save', save: 'str', half: true, dmg: d(1, 8), element: 'force', push: 2 },
    t2: { dmg: d(2, 8) },
    a: { name: 'Booming Chord', radius: 2 },
    b: { name: 'Concussive Note', onHit: [st('dazed', 1)] },
  },
  hypnotic_gaze: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Hypnotic Gaze', icon: '🌀', ap: 2, target: 'enemy', range: 6, cooldown: 4, roll: 'save', save: 'wis', onHit: [st('dazed', 2)] },
    t2: { onHit: [st('stunned', 1)] },
    a: { name: 'Mass Hypnosis', target: 'area', radius: 1 },
    b: { name: 'Nightmare', onHit: [st('stunned', 1), st('poisoned', 2)] },
  },
  healing_ballad: {
    kind: 'spell', pool: 'bard',
    base: { name: 'Healing Ballad', icon: '🎶', ap: 2, target: 'allies', radius: 3, range: 0, slots: 1, heal: d(1, 6), healMod: true },
    t2: { heal: d(2, 6) },
    a: { name: 'Anthem of Life', radius: 5 },
    b: { name: 'Second Verse', overheal: true },
  },
  shatter: {
    kind: 'spell', pool: 'bard',
    base: { name: 'Shatter', icon: '💥', ap: 3, target: 'area', range: 8, radius: 1, slots: 1, roll: 'save', save: 'str', half: true, dmg: d(3, 8), element: 'force' },
    t2: { dmg: d(4, 8) },
    a: { name: 'Sonic Boom', radius: 2 },
    b: { name: 'Resonance', onHit: [st('dazed', 1)] },
  },
  hideous_laughter: {
    kind: 'spell', pool: 'bard',
    base: { name: 'Hideous Laughter', icon: '😂', ap: 2, target: 'enemy', range: 6, slots: 1, roll: 'save', save: 'wis', onHit: [st('stunned', 2)] },
    t2: { range: 8 },
    a: { name: 'Contagious Laughter', chain: 1 },
    b: { name: 'Mocking Jest', onHit: [st('stunned', 1), st('marked', 2)] },
  },
  heroic_anthem: {
    kind: 'spell', pool: 'bard',
    base: { name: 'Heroic Anthem', icon: '🎺', ap: 3, target: 'allies', radius: 4, range: 0, slots: 1, status: [st('rallied', 3, 1, 3), st('shielded', 2, 1)] },
    t2: { tempHp: d(1, 8) },
    a: { name: 'Battle Hymn', status: [st('rallied', 3, 1, 3), st('shielded', 2, 1), st('focused', 1)] },
    b: { name: 'Ballad of Heroes', status: [st('rallied', 3, 1, 3), st('shielded', 2, 1), st('blessed', 3)] },
  },
  song_of_rest: passive('bard', '🛌', 'Song of Rest',
    { value: 5, note: 'After every fight, the party heals 5% more of their max HP.' },
    { value: 10, note: 'After every fight, the party heals 10% more of their max HP.' },
    { name: 'Lullaby of Mending', value: 15, note: 'After every fight, the party heals 15% more of their max HP.' },
    { name: 'Encore', value: 10, note: 'After every fight, the party heals 10% more of their max HP, and you get a slot back.' }),
  jack_of_all_trades: passive('bard', '🃏', 'Jack of All Trades',
    { perk: { saves: 1, init: 1 } },
    { perk: { saves: 1, init: 2, hit: 1 } },
    { name: 'Polymath', perk: { saves: 2, init: 2, hit: 1, slots: 1 } },
    { name: 'Lucky Performer', perk: { saves: 1, init: 2, hit: 1, lucky: 1 } }),
  silver_tongue: passive('bard', '🎭', 'Silver Tongue',
    { perk: { power: 1 } },
    { perk: { power: 1, heal: 1 } },
    { name: 'Spellsinger', perk: { power: 2, slots: 1 } },
    { name: 'Soothing Voice', perk: { power: 1, heal: 3 } }),

  // ---------------------------------------------- subclasses (shared/subclasses.ts): picked at level 3, `sub` marks
  // the subclass's own skills. The signature (first of each) is learned at once and takes no slot.
  // Fighter: Weapon Master
  cleave: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Cleave', icon: '🪓', ap: 2, target: 'around', radius: 1, range: 0, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true },
    t2: { dmg: d(1, 10) },
    a: { name: 'Sweeping Cleave', push: 1 },
    b: { name: 'Rending Cleave', onHit: [st('marked', 1)] },
  },
  precision_strike: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Precision Strike', icon: '🎯', ap: 1, target: 'self', range: 0, slots: 1, selfStatus: [st('focused', 1), st('honed', 1, 1)] },
    t2: { selfStatus: [st('focused', 1), st('honed', 1, 2)] },
    a: { name: 'Deadly Precision', selfStatus: [st('focused', 1), st('honed', 1, 3)] },
    b: { name: 'Quick Precision', ap: 0 },
  },
  counterattack: passive('fighter', '🤺', 'Counterattack',
    { note: 'Once per round, when a monster misses you in melee, you hit back with your weapon.' },
    { value: 2, note: 'Once per round, when a monster misses you in melee, you hit back with your weapon (+2 damage).' },
    { name: 'Relentless Counter', value: 2, note: 'Twice per round, when a monster misses you in melee, you hit back with your weapon (+2 damage).' },
    { name: 'Disarming Counter', value: 2, note: 'Once per round, when a monster misses you in melee, you hit back with your weapon (+2 damage), and a hit Dazes it.' }),
  // Fighter: Guardian
  shield_wall: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Shield Wall', icon: '🧱', ap: 1, target: 'self', range: 0, cooldown: 2, block: d(2, 6), blockLevel: true, taunt: { radius: 1, turns: 1 } },
    t2: { block: d(3, 6) },
    a: { name: 'Bastion', taunt: { radius: 2, turns: 2 } },
    b: { name: 'Phalanx', target: 'allies', radius: 1 },
  },
  iron_recovery: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Iron Recovery', icon: '⛑️', ap: 1, target: 'self', range: 0, slots: 1, heal: d(2, 8), healLevel: true, block: d(1, 8), blockLevel: true },
    t2: { heal: d(3, 8) },
    a: { name: 'Second Breath', cleanse: true },
    b: { name: 'Unbreakable', tempHp: d(2, 6) },
  },
  spiked_shield: passive('fighter', '🦔', 'Spiked Shield',
    { value: 50, note: 'When your Block soaks a melee hit, the attacker takes half of what it soaked.' },
    { value: 100, note: 'When your Block soaks a melee hit, the attacker takes all of what it soaked.' },
    { name: 'Barbed Shield', value: 100, note: 'When your Block soaks a melee hit, the attacker takes all of what it soaked, and is Poisoned.' },
    { name: 'Retribution', value: 100, note: 'When your Block soaks any hit (ranged too), the attacker takes all of what it soaked.' }),
  // Rogue: Assassin
  envenom: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Envenom', icon: '☣️', ap: 1, target: 'self', range: 0, cooldown: 3, selfStatus: [st('envenomed', 2, 1)] },
    t2: { selfStatus: [st('envenomed', 2, 2)] },
    a: { name: 'Lethal Toxin', selfStatus: [st('envenomed', 2, 3)] },
    b: { name: 'Lasting Venom', selfStatus: [st('envenomed', 3, 2)] },
  },
  assassinate: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Assassinate', icon: '💀', ap: 3, target: 'enemy', range: 1, slots: 1, stat: 'dex', roll: 'attack', dmg: d(3, 8), mod: true, sneak: true, critFull: true },
    t2: { dmg: d(4, 8) },
    a: { name: 'Shadow Kill', range: 6, teleport: true },
    b: { name: 'Vanish', selfStatus: [st('hidden', 1)] },
  },
  death_mark: passive('rogue', '☠️', 'Death Mark',
    { value: 1, note: 'Sneak Attack deals +1d6 against Poisoned targets.' },
    { value: 2, note: 'Sneak Attack deals +2d6 against Poisoned targets.' },
    { name: 'Coup de Grâce', value: 3, note: 'Sneak Attack deals +3d6 against Poisoned targets.' },
    { name: 'Marked for Death', value: 2, note: 'Sneak Attack deals +2d6 against Poisoned or Marked targets.' }),
  // Rogue: Skirmisher
  quick_stab: { kind: 'basic', pool: 'rogue', base: { name: 'Quick Stab', icon: '🔪', ap: 1, target: 'enemy', range: 1, stat: 'dex', roll: 'attack', dmg: d(1, 4), mod: true, sneak: true } },
  tumble: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Tumble', icon: '🤸', ap: 1, target: 'self', range: 0, cooldown: 2, dash: 4, selfStatus: [st('shielded', 1, 2)] },
    t2: { dash: 5 },
    a: { name: 'Long Roll', dash: 7 },
    b: { name: 'Evasive Roll', selfStatus: [st('shielded', 1, 4)] },
  },
  strike_and_fade: passive('rogue', '🌫️', 'Strike and Fade',
    { value: 2, note: 'Your first attack each turn gives you +2 movement.' },
    { value: 3, note: 'Your first attack each turn gives you +3 movement.' },
    { name: 'Blitz', value: 4, note: 'Your first attack each turn gives you +4 movement.' },
    { name: 'Fade', value: 3, note: 'Your first attack each turn gives you +3 movement and +2 AC until your next turn.' }),
  // Wizard: Evoker
  sculpt_spells: passive('wizard', '🔷', 'Sculpt Spells',
    { note: 'Your area attacks never hit friends.' },
    { value: 2, note: 'Your area attacks never hit friends, and deal +2 damage.' },
    { name: 'Overchannel', value: 4, note: 'Your area attacks never hit friends, and deal +4 damage.' },
    { name: 'Careful Weave', value: 2, note: 'Your area attacks never hit friends or NPC allies, and deal +2 damage.' }),
  meteor: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Meteor', icon: '🌠', ap: 3, target: 'area', range: 10, radius: 2, slots: 2, roll: 'save', save: 'dex', half: true, falloff: true, dmg: d(6, 6), element: 'fire' },
    t2: { dmg: d(8, 6) },
    a: { name: 'Meteor Swarm', radius: 3 },
    b: { name: 'Comet', element: 'cold' },
  },
  empowered_evocation: passive('wizard', '💥', 'Empowered Evocation',
    { value: 2, note: 'Your spells deal +2 damage to each target.' },
    { value: 3, note: 'Your spells deal +3 damage to each target.' },
    { name: 'Arcane Surge', value: 5, note: 'Your spells deal +5 damage to each target.' },
    { name: 'Spell Pierce', value: 3, note: 'Your spells deal +3 damage to each target and ignore resistances.' }),
  // Wizard: Elementalist
  frost_nova: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Frost Nova', icon: '❄️', ap: 2, target: 'around', radius: 1, range: 0, cooldown: 2, roll: 'save', save: 'dex', half: true, dmg: d(1, 6), element: 'cold', onHit: [st('chilled', 2)], push: 1 },
    t2: { dmg: d(2, 6) },
    a: { name: 'Deep Freeze', onHit: [st('chilled', 2), st('dazed', 1)] },
    b: { name: 'Shatterwave', push: 2 },
  },
  flash_freeze: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Flash Freeze', icon: '🧊', ap: 2, target: 'area', range: 8, radius: 2, slots: 1, roll: 'save', save: 'dex', half: true, dmg: d(2, 6), element: 'cold', onHit: [st('chilled', 2)], note: 'Wet creatures freeze solid.' },
    t2: { dmg: d(3, 6) },
    a: { name: 'Glacier', surface: { ground: 'ice' } },
    b: { name: 'Hailstorm', onHit: [st('chilled', 2), st('prone', 1)] },
  },
  catalyst: passive('wizard', '⚗️', 'Catalyst',
    { value: 50, note: 'Fire, poison, shocks and explosions you set off on the battlefield deal +50% to monsters.' },
    { value: 75, note: 'Fire, poison, shocks and explosions you set off on the battlefield deal +75% to monsters.' },
    { name: 'Chain Reaction', value: 100, note: 'Fire, poison, shocks and explosions you set off on the battlefield deal double to monsters.' },
    { name: 'Elemental Weave', value: 50, note: 'Fire, poison, shocks and explosions you set off deal +50% to monsters, and your fire, cold and lightning skills +2.' }),
  // Cleric: Life
  mass_healing_word: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Mass Healing Word', icon: '💞', ap: 1, target: 'allies', radius: 4, range: 0, slots: 1, heal: d(1, 6), healMod: true },
    t2: { heal: d(2, 6) },
    a: { name: 'Mass Cure', ap: 2, heal: d(3, 6) },
    b: { name: 'Beacon of Hope', status: [st('blessed', 2)] },
  },
  prayer_of_healing: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Prayer of Healing', icon: '🙏', ap: 2, target: 'allies', radius: 3, range: 0, slots: 2, heal: d(2, 8), healMod: true },
    t2: { heal: d(3, 8) },
    a: { name: 'Prayer of Vigor', tempHp: d(1, 8) },
    b: { name: 'Sanctified Prayer', cleanse: true },
  },
  disciple_of_life: passive('cleric', '💗', 'Disciple of Life',
    { perk: { heal: 2 } },
    { perk: { heal: 3 } },
    { name: 'Supreme Healing', perk: { heal: 5 } },
    { name: 'Preserve Life', perk: { heal: 3, hp: 6 } }),
  // Cleric: Order
  warding_light: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Warding Light', icon: '🔆', ap: 1, target: 'ally', range: 6, cooldown: 2, block: d(1, 8), blockLevel: true },
    t2: { block: d(2, 8) },
    a: { name: 'Wide Ward', target: 'allies', radius: 3, range: 0 },
    b: { name: 'Sanctuary Ward', status: [st('shielded', 1, 2)] },
  },
  command: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Command', icon: '☝️', ap: 2, target: 'enemy', range: 6, slots: 1, roll: 'save', save: 'wis', onHit: [st('dazed', 1), st('prone', 1)] },
    t2: { onHit: [st('dazed', 2), st('prone', 1)] },
    a: { name: 'Mass Command', target: 'area', radius: 1 },
    b: { name: 'Halt!', onHit: [st('dazed', 2), st('netted', 1)] },
  },
  voice_of_authority: passive('cleric', '📣', 'Voice of Authority',
    { value: 1, note: 'Once per round, a friend you buff, heal or Block gets +1 AP on their next turn.' },
    { value: 1, note: 'Once per turn, a friend you buff, heal or Block gets +1 AP on their next turn.' },
    { name: 'Commanding Presence', value: 1, note: 'Every friend you buff, heal or Block gets +1 AP on their next turn.' },
    { name: 'Zealous Command', value: 2, note: 'Once per turn, a friend you buff, heal or Block gets +2 AP on their next turn.' }),
  // Barbarian: Berserker
  blood_price: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Blood Price', icon: '🩸', ap: 0, target: 'self', range: 0, cooldown: 0, hpCost: 10, gainAp: 1, oncePerTurn: true },
    t2: { hpCost: 6 },
    a: { name: 'Blood Frenzy', hpCost: 12, gainAp: 2 },
    b: { name: 'Savage Price', selfStatus: [st('rallied', 2, 1, 3)] },
  },
  frenzy: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Frenzy', icon: '🌪️', ap: 2, target: 'enemy', range: 1, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(1, 10), mod: true, hits: 2, selfStatus: [st('marked', 1)] },
    t2: { dmg: d(1, 12) },
    a: { name: 'Rampage', hits: 3 },
    b: { name: 'Reckless Frenzy', adv: true },
  },
  bloodlust: passive('barbarian', '🔥', 'Bloodlust',
    { value: 3, note: 'Below half HP, your melee hits deal +3 damage.' },
    { value: 4, note: 'Below half HP, your melee hits deal +4 damage.' },
    { name: 'Death Wish', value: 6, note: 'Below half HP, your melee hits deal +6 damage.' },
    { name: 'Red Mist', value: 4, note: 'Below half HP, or while Raging, your melee hits deal +4 damage.' }),
  // Barbarian: Juggernaut
  blood_drinker: passive('barbarian', '🍷', 'Blood Drinker',
    { value: 25, note: 'Your melee hits heal you for a quarter of the damage they deal.' },
    { value: 33, note: 'Your melee hits heal you for a third of the damage they deal.' },
    { name: 'Sanguine', value: 50, note: 'Your melee hits heal you for half the damage they deal.' },
    { name: 'Shared Feast', value: 25, note: 'Your melee hits heal you for a quarter of the damage they deal, and every friend next to you for 1.' }),
  challenge: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Challenge', icon: '🫵', ap: 1, target: 'self', range: 0, cooldown: 3, taunt: { radius: 2, turns: 1 }, block: d(1, 8), blockLevel: true },
    t2: { taunt: { radius: 2, turns: 2 } },
    a: { name: 'Roar of Defiance', taunt: { radius: 3, turns: 2 } },
    b: { name: 'Iron Hide', block: d(2, 8) },
  },
  unstoppable: passive('barbarian', '🐂', 'Unstoppable',
    { note: "While Raging, you can't be knocked Prone, Netted or Webbed." },
    { note: "You can't be knocked Prone, and while Raging you can't be Netted or Webbed either." },
    { name: 'Iron Will', note: "You can't be knocked Prone, and while Raging you can't be Netted, Webbed, Dazed or Frightened." },
    { name: 'Rampaging', value: 2, note: "You can't be knocked Prone, while Raging you can't be Netted or Webbed, and Raging gives +2 movement." }),
  // Ranger: Trapper
  snare_trap: {
    kind: 'cantrip', pool: 'ranger',
    base: { name: 'Snare Trap', icon: '🪤', ap: 1, target: 'area', range: 4, radius: 0, cooldown: 2, trap: { status: [st('netted', 2)], dmg: d(1, 6) }, note: "Monsters don't see snares. Up to 3 at a time." },
    t2: { trap: { status: [st('netted', 2)], dmg: d(2, 6) } },
    a: { name: 'Spiked Snare', trap: { status: [st('netted', 2), st('prone', 1)], dmg: d(2, 6) } },
    b: { name: 'Wide Snare', radius: 1 },
  },
  barrage: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Barrage', icon: '🏹', ap: 2, target: 'area', range: 10, radius: 2, slots: 1, stat: 'dex', roll: 'attack', dmg: d(1, 8), mod: true },
    t2: { dmg: d(2, 8) },
    a: { name: 'Arrow Storm', radius: 3 },
    b: { name: 'Pinning Barrage', onHit: [st('netted', 1)] },
  },
  ambusher: passive('ranger', '🌿', 'Ambusher',
    { value: 2, note: 'Your hits deal +2 damage against Netted, Webbed or Prone targets.' },
    { value: 3, note: 'Your hits deal +3 damage against Netted, Webbed or Prone targets.' },
    { name: "Hunter's Glee", value: 5, note: 'Your hits deal +5 damage against Netted, Webbed or Prone targets.' },
    { name: 'Snare Master', value: 3, note: 'Your hits deal +3 damage against Netted, Webbed or Prone targets, and your traps +1d6.' }),
  // Ranger: Sharpshooter
  aimed_shot: {
    kind: 'cantrip', pool: 'ranger',
    base: { name: 'Aimed Shot', icon: '🎯', ap: 3, target: 'enemy', range: 14, cooldown: 1, stat: 'dex', roll: 'attack', dmg: d(2, 10), mod: true },
    t2: { dmg: d(3, 10) },
    a: { name: 'Headshot', critFull: true },
    b: { name: 'Pinning Shot', onHit: [st('netted', 1)] },
  },
  piercing_shot: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Piercing Shot', icon: '➶', ap: 2, target: 'enemy', range: 10, slots: 1, stat: 'dex', roll: 'attack', dmg: d(2, 8), mod: true, chain: 2 },
    t2: { chain: 3 },
    a: { name: 'Ricochet', dmg: d(3, 8) },
    b: { name: 'Barbed Shot', onHit: [st('poisoned', 2)] },
  },
  deadeye: passive('ranger', '👁️‍🗨️', 'Deadeye',
    { value: 2, note: 'Your hits on targets 5 or more tiles away deal +2 damage.' },
    { value: 3, note: 'Your hits on targets 5 or more tiles away deal +3 damage.' },
    { name: 'Eagle Eye', value: 5, note: 'Your hits on targets 5 or more tiles away deal +5 damage.' },
    { name: 'Long Shot', value: 3, note: 'Your hits on targets 4 or more tiles away deal +3 damage.' }),
  // Paladin: Protection
  intercept: passive('paladin', '🙅', 'Intercept',
    { note: 'Once per round, when a monster attacks a friend next to you, you take the attack instead.' },
    { value: 3, note: 'Once per round, when a monster attacks a friend next to you, you take the attack instead, with 3 Block.' },
    { name: 'Shield of the Many', value: 3, note: 'Twice per round, when a monster attacks a friend next to you, you take the attack instead, with 3 Block.' },
    { name: 'Retaliation', value: 3, note: 'Once per round, you take an attack meant for a friend next to you (with 3 Block), then hit back.' }),
  aegis: {
    kind: 'spell', pool: 'paladin',
    base: { name: 'Aegis', icon: '🛡️', ap: 2, target: 'allies', radius: 1, range: 0, slots: 1, block: d(2, 6), blockLevel: true },
    t2: { block: d(3, 6) },
    a: { name: 'Aegis of Light', radius: 2 },
    b: { name: 'Holy Aegis', status: [st('shielded', 1, 2)] },
  },
  aura_of_warding: passive('paladin', '💠', 'Aura of Warding',
    { value: 2, note: 'At the start of your turn, every friend next to you gets 2 Block.' },
    { value: 3, note: 'At the start of your turn, every friend next to you gets 3 Block.' },
    { name: 'Wide Ward', value: 3, note: 'At the start of your turn, every friend within 2 tiles gets 3 Block.' },
    { name: 'Warden', value: 3, note: 'At the start of your turn, you and every friend next to you get 3 Block.' }),
  // Paladin: Devotion
  blessed_smites: passive('paladin', '🌟', 'Blessed Smites',
    { value: 50, note: 'Divine Smite heals you for half the damage it deals.' },
    { value: 50, note: 'Divine Smite and Radiant Strike heal you for half the damage they deal.' },
    { name: 'Holy Wrath', value: 100, note: 'Divine Smite and Radiant Strike heal you for all the damage they deal.' },
    { name: 'Shared Grace', value: 50, note: 'Divine Smite and Radiant Strike heal half the damage they deal: to you, or a friend within 4 tiles who is hurt worse.' }),
  restoring_touch: {
    kind: 'cantrip', pool: 'paladin',
    base: { name: 'Restoring Touch', icon: '🤲', ap: 1, target: 'ally', range: 1, cooldown: 2, heal: d(2, 6), healLevel: true, healSelf: 0.5 },
    t2: { heal: d(3, 6) },
    a: { name: 'Shared Light', target: 'allies', radius: 1, healSelf: 0 },
    b: { name: 'Purifying Light', cleanse: true },
  },
  divine_vitality: passive('paladin', '💛', 'Divine Vitality',
    { value: 2, note: 'You heal 2 HP at the start of each of your turns.' },
    { value: 3, note: 'You heal 3 HP at the start of each of your turns.' },
    { name: 'Radiant Vitality', value: 4, note: 'You heal 4 HP at the start of each of your turns.' },
    { name: 'Vitality Aura', value: 3, note: 'You heal 3 HP at the start of each of your turns, and every friend next to you 1.' }),
  // Bard: Valor
  rousing: passive('bard', '📯', 'Rousing Inspiration',
    { value: 1, note: 'Your Bardic Inspiration also gives +1 AP on their next turn.' },
    { value: 1, note: 'Your Bardic Inspiration also gives +1 AP on their next turn, and +1d4 damage on their hits (Blessed) for 2 turns.' },
    { name: 'Heroic Rousing', value: 2, note: 'Your Bardic Inspiration also gives +2 AP on their next turn, and +1d4 damage on their hits for 2 turns.' },
    { name: 'Encouraging Word', value: 1, note: 'Your Bardic Inspiration also gives +1 AP on their next turn, +1d4 damage on their hits for 2 turns, and heals 1d6 + your level.' }),
  war_chant: {
    kind: 'spell', pool: 'bard',
    base: { name: 'War Chant', icon: '🥁', ap: 2, target: 'allies', radius: 4, range: 0, slots: 1, status: [st('rallied', 3, 1, 3), st('rallied', 3, 1, 3)], block: d(1, 6) },
    t2: { block: d(2, 6) },
    a: { name: 'Chant of Fury', status: [st('rallied', 3, 1, 3), st('rallied', 3, 1, 3), st('rallied', 3, 1, 3)] },
    b: { name: 'Chant of Iron', status: [st('rallied', 3, 1, 3), st('rallied', 3, 1, 3), st('shielded', 2, 1)] },
  },
  combat_inspiration: passive('bard', '⚔️', 'Combat Inspiration',
    { value: 1, note: 'A friend you inspire hits harder: +1d4 damage on their hits (Blessed) for 2 turns.' },
    { value: 1, note: 'A friend you inspire gets +1d4 damage on their hits (Blessed) and +1 AC for 2 turns.' },
    { name: 'Battle Muse', value: 2, note: 'A friend you inspire gets +1d4 damage on their hits (Blessed) and +2 AC for 3 turns.' },
    { name: 'Rallying Muse', value: 1, note: 'A friend you inspire gets +1d4 damage on their hits (Blessed), +1 AC and a stack of Rallied for 2 turns.' }),
  // Bard: Whispers
  dissonant_whispers: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Dissonant Whispers', icon: '🌀', ap: 2, target: 'enemy', range: 6, cooldown: 2, roll: 'save', save: 'wis', half: true, dmg: d(2, 6), element: 'force', onHit: [st('frightened', 1)] },
    t2: { dmg: d(3, 6) },
    a: { name: 'Terror', onHit: [st('frightened', 2)] },
    b: { name: 'Mind Spike', onHit: [st('frightened', 1), st('dazed', 1)] },
  },
  cutting_words: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Cutting Words', icon: '✂️', ap: 1, target: 'enemy', range: 6, cooldown: 2, onHit: [st('dazed', 1)] },
    t2: { onHit: [st('dazed', 2)] },
    a: { name: 'Withering Words', onHit: [st('dazed', 2), st('marked', 1)] },
    b: { name: 'Biting Words', onHit: [st('dazed', 2), st('blinded', 1)] },
  },
  psychic_blades: passive('bard', '🔮', 'Psychic Blades',
    { value: 1, note: 'Your hits deal +1d6 against monsters with a debuff on them.' },
    { value: 2, note: 'Your hits deal +2d6 against monsters with a debuff on them.' },
    { name: 'Mind Shatter', value: 3, note: 'Your hits deal +3d6 against monsters with a debuff on them.' },
    { name: 'Lingering Dread', value: 2, note: 'Your hits deal +2d6 against monsters with a debuff on them, and leave them Dazed.' }),

  // ---------------------------------------------- build engines (shared/engines.ts, decided 2026-10-19): the new cards
  // Fighter: Weapon Master (crits)
  keen_edge: passive('fighter', '🗡️', 'Keen Edge',
    { value: 1, note: 'Your attacks crit on a 19 or 20.' },
    { value: 2, note: 'Your attacks crit on an 18 or higher.' },
    { name: 'Razor Edge', value: 3, note: 'Your attacks crit on a 17 or higher.' },
    { name: 'Exploit Weakness', value: 2, note: 'Your attacks crit on an 18 or higher, and on a 16 or higher against the Prone and the Netted.' }),
  devastating_blows: passive('fighter', '💥', 'Devastating Blows',
    { value: 3, note: 'Your crits roll the damage dice three times instead of twice.' },
    { value: 3, note: 'Your crits roll the damage dice three times, and deal +3 damage.' },
    { name: 'Annihilate', value: 4, note: 'Your crits roll the damage dice four times, and deal +3 damage.' },
    { name: 'Shattering Blows', value: 3, note: 'Your crits roll the damage dice three times, deal +3 damage and knock the target Prone.' }),
  momentum: passive('fighter', '🌀', 'Momentum',
    { value: 1, note: 'Once per turn, a crit gives you 1 AP back.' },
    { value: 1, note: 'Once per turn, a crit or a killing blow gives you 1 AP back.' },
    { name: 'Rolling Thunder', value: 2, note: 'Twice per turn, a crit or a killing blow gives you 1 AP back.' },
    { name: 'Battle Flow', value: 1, note: 'Once per turn, a crit or a killing blow gives you 1 AP back and +2 movement.' }),
  perfect_form: passive('fighter', '✴️', 'Perfect Form',
    { value: 1, note: 'Once per turn, after you crit, your next attack this turn is a crit too.' },
    { value: 1, note: 'Once per turn, after you crit, your next attack this turn is a crit too, with +4 damage.' },
    { name: 'Flawless', value: 2, note: 'Twice per turn, after you crit, your next attack this turn is a crit too, with +4 damage.' },
    { name: 'Killing Rhythm', value: 1, note: 'Once per turn, after a crit or a killing blow, your next attack this turn is a crit too, with +4 damage.' }),
  // Fighter: Guardian (Block and thorns)
  shield_slam: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Shield Slam', icon: '🫸', ap: 2, target: 'enemy', range: 1, cooldown: 1, stat: 'str', roll: 'attack', dmg: d(1, 4), mod: true, per: { of: 'block', flat: 1 } },
    t2: { dmg: d(1, 8) },
    a: { name: 'Shield Crush', per: { of: 'block', flat: 1.5 } },
    b: { name: 'Slam and Brace', selfBlock: d(1, 6) },
  },
  entrench: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Entrench', icon: '🏯', ap: 1, target: 'self', range: 0, slots: 1, doubleBlock: true },
    t2: { selfBlock: d(1, 6) },
    a: { name: 'Bunker Down', ap: 0 },
    b: { name: 'Unyielding', selfStatus: [st('shielded', 1, 2)] },
  },
  fortress: passive('fighter', '🏰', 'Fortress',
    { value: 50, note: 'At the start of your turn, half the Block you gave yourself stays instead of running out.' },
    { value: 75, note: 'At the start of your turn, three quarters of the Block you gave yourself stays.' },
    { name: 'Citadel', value: 100, note: 'The Block you give yourself never runs out (until the fight ends or you go down).' },
    { name: 'Garrison', value: 75, note: 'Three quarters of your own Block stays at the start of your turn, and each friend next to you gets half of what stayed.' }),
  // Fighter: Duelist (counters)
  parry: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Parry', icon: '🤺', ap: 1, target: 'self', range: 0, cooldown: 2, selfStatus: [st('shielded', 1, 3)], taunt: { radius: 1, turns: 1 } },
    t2: { selfStatus: [st('shielded', 1, 4)] },
    a: { name: 'Bait', taunt: { radius: 2, turns: 1 } },
    b: { name: 'Guard Stance', cooldown: 1 },
  },
  swift_riposte: passive('fighter', '⚔️', 'Swift Riposte',
    { value: 1, note: 'Your counterattacks and ripostes deal +1d6 and heal you 2.' },
    { value: 2, note: 'Your counterattacks and ripostes deal +2d6 and heal you 3.' },
    { name: 'Bloody Riposte', value: 3, note: 'Your counterattacks and ripostes deal +3d6 and heal you 3.' },
    { name: 'Humbling Riposte', value: 2, note: 'Your counterattacks and ripostes deal +2d6, heal you 3 and leave the attacker Dazed.' }),
  blade_wall: passive('fighter', '🌪️', 'Blade Wall',
    { value: 1, note: 'Counterattack answers every melee miss against you, not just once a round.' },
    { value: 1, note: 'Counterattack answers every melee miss against you, and each counter gives you +1 AC until your next turn (up to +3).' },
    { name: 'Steel Storm', value: 2, note: 'Counterattack answers every melee miss, each counter deals +2 damage and gives you +1 AC until your next turn (up to +3).' },
    { name: 'Iron Curtain', value: 1, note: 'Counterattack answers every melee miss, and each counter gives you +1 AC until your next turn (up to +5).' }),

  // Rogue: Assassin (poison stacks)
  noxious_fumes: passive('rogue', '☁️', 'Noxious Fumes',
    { value: 1, note: 'At the start of your turn, every enemy next to you gains 1 Poison.' },
    { value: 2, note: 'At the start of your turn, every enemy next to you gains 2 Poison.' },
    { name: 'Toxic Cloud', value: 2, note: 'At the start of your turn, every enemy within 2 tiles gains 2 Poison.' },
    { name: 'Choking Fumes', value: 2, note: 'At the start of your turn, every enemy next to you gains 2 Poison and is Dazed.' }),
  toxic_catalyst: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Toxic Catalyst', icon: '⚗️', ap: 1, target: 'enemy', range: 5, cooldown: 3, poisonMult: 2, note: 'No roll. Only on the Poisoned.' },
    t2: { cooldown: 2 },
    a: { name: 'Plague Bloom', poisonMult: 3 },
    b: { name: 'Quick Catalyst', ap: 0 },
  },
  rupture: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Rupture', icon: '🩸', ap: 1, target: 'enemy', range: 5, cooldown: 2, roll: 'auto', dmg: d(1, 4), element: 'poison', per: { of: 'poison', flat: 3 } },
    t2: { per: { of: 'poison', flat: 4 } },
    a: { name: 'Hemorrhage', per: { of: 'poison', flat: 5 } },
    b: { name: 'Toxic Burst', target: 'area', radius: 1 },
  },
  virulence: passive('rogue', '🦠', 'Virulence',
    { value: 10, note: 'Your Poison deals d6s instead of d4s and never wears off.' },
    { value: 15, note: 'Your Poison deals d6s, never wears off, and stacks up to 15.' },
    { name: 'Pandemic', value: 15, note: 'Your Poison deals d6s, never wears off, stacks up to 15, and spreads to the enemies next to a Poisoned enemy when it dies.' },
    { name: 'Wasting Toxin', value: 15, note: 'Your Poison deals d6s, never wears off, stacks up to 15, and the Poisoned deal 2 less damage.' }),
  // Rogue: Skirmisher (many small hits)
  flurry: passive('rogue', '⚡', 'Flurry',
    { value: 1, note: 'Each hit after your first one in a turn deals 1 more than the one before (+1, +2, +3...).' },
    { value: 2, note: 'Each hit after your first one in a turn deals 2 more than the one before (+2, +4, +6...).' },
    { name: 'Blade Frenzy', value: 3, note: 'Each hit after your first one in a turn deals 3 more than the one before (+3, +6, +9...).' },
    { name: 'Bleeding Flurry', value: 2, note: 'Each hit after your first one in a turn deals 2 more than the one before, and from your fourth hit on they Poison (2).' }),
  knife_juggler: passive('rogue', '🔪', 'Knife Juggler',
    { value: 3, note: 'Every 3rd hit in a turn throws a free knife at the nearest enemy within 5 tiles: 1d4 + DEX, never misses.' },
    { value: 3, note: 'Every 3rd hit in a turn throws a free knife at the nearest enemy within 5 tiles: 2d4 + DEX, never misses.' },
    { name: 'Knife Storm', value: 2, note: 'Every 2nd hit in a turn throws a free knife at the nearest enemy within 5 tiles: 2d4 + DEX, never misses.' },
    { name: 'Venom Knives', value: 3, note: 'Every 3rd hit in a turn throws a free knife (2d4 + DEX, never misses) that Poisons (2).' }),
  thousand_cuts: passive('rogue', '✂️', 'Thousand Cuts',
    { value: 50, note: 'After your first Sneak Attack in a turn, every later hit that could Sneak Attack adds half the dice.' },
    { value: 75, note: 'After your first Sneak Attack in a turn, every later hit that could Sneak Attack adds three quarters of the dice.' },
    { name: 'Death by a Thousand Cuts', value: 100, note: 'Every hit that could Sneak Attack does, as many times a turn as you hit.' },
    { name: 'Opening Wounds', value: 50, note: 'After your first Sneak Attack in a turn, later hits that could Sneak Attack add half the dice and Poison (1).' }),
  // Rogue: Shadow (one huge backstab)
  cunning_strikes: passive('rogue', '🧠', 'Cunning Strikes',
    { value: 1, note: 'Sneak Attack deals +1d6 for each debuff on the target (up to 3).' },
    { value: 1, note: 'Sneak Attack deals +1d6 for each debuff on the target (up to 5).' },
    { name: 'Merciless', value: 2, note: 'Sneak Attack deals +2d6 for each debuff on the target (up to 3).' },
    { name: 'Twist the Knife', value: 1, note: 'Sneak Attack deals +1d6 for each debuff on the target (up to 5) and Poisons it (2).' }),
  melt_away: passive('rogue', '🌫️', 'Melt Away',
    { note: 'A killing blow hides you again (Hidden).' },
    { value: 2, note: 'A killing blow hides you again and gives you +2 movement.' },
    { name: 'Ghost', value: 2, note: 'A killing blow hides you again, gives +2 movement and, once per turn, 1 AP back.' },
    { name: 'Phantom Step', value: 4, note: 'A killing blow hides you again and gives you +4 movement.' }),
  death_blossom: passive('rogue', '🌸', 'Death Blossom',
    { value: 1, note: 'Once per turn, your first hit from hiding is a crit, and you hide again.' },
    { value: 1, note: 'Once per turn, your first hit from hiding is a crit that ignores cover, and you hide again.' },
    { name: "Reaper's Bloom", value: 2, note: 'Twice per turn, a hit from hiding is a crit that ignores cover, and you hide again.' },
    { name: 'Silent Bloom', value: 1, note: 'Once per turn, your first hit from hiding is a crit that ignores cover and Poisons (3), and you hide again.' }),

  // Wizard: Evoker (Arcane Charge)
  arcane_charge: passive('wizard', '🔷', 'Arcane Charge',
    { value: 5, note: 'Every spell you cast gives you an Arcane Charge (up to 5, until the fight ends). Each Charge adds +1 damage to your spells.' },
    { value: 5, note: 'Every cantrip or spell you cast gives you an Arcane Charge (up to 5). Each Charge adds +1 damage to your spells.' },
    { name: 'Overflowing Power', value: 5, note: 'Every cantrip or spell gives you an Arcane Charge (up to 5). Each Charge adds +2 damage to your spells.' },
    { name: 'Steady Charge', value: 5, note: 'Every cantrip or spell gives you an Arcane Charge (up to 5), and you start every fight with 2.' }),
  unleash: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Unleash', icon: '💥', ap: 1, target: 'self', range: 0, cooldown: 3, unleash: 6, note: 'Spends all your Arcane Charges: your next spell deals +1d6 per Charge on each target.' },
    t2: { cooldown: 2 },
    a: { name: 'Cataclysm', unleash: 8, note: 'Spends all your Arcane Charges: your next spell deals +1d8 per Charge on each target.' },
    b: { name: 'Quick Release', ap: 0 },
  },
  archmage: passive('wizard', '🧙', 'Archmage',
    { value: 3, note: 'With 3 or more Arcane Charges, your 3-AP spells cost 2 AP.' },
    { value: 2, note: 'With 2 or more Arcane Charges, your 3-AP spells cost 2 AP.' },
    { name: 'Spell Weaver', value: 3, note: 'With 3 or more Arcane Charges, all your spells cost 1 AP less (never below 1).' },
    { name: 'Endless Charge', value: 2, note: 'With 2 or more Arcane Charges, your 3-AP spells cost 2 AP, and you can hold up to 7 Charges.' }),
  // Wizard: Elementalist (combos)
  drench: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Drench', icon: '💧', ap: 1, target: 'enemy', range: 6, cooldown: 1, onHit: [st('wet', 2)], surface: { ground: 'water' }, note: 'No roll: a splash of water. Wet: lightning stuns it, cold freezes it.' },
    t2: { range: 8 },
    a: { name: 'Deluge', target: 'area', radius: 1 },
    b: { name: 'Icy Drench', onHit: [st('wet', 2), st('chilled', 2)] },
  },
  conductor: passive('wizard', '⚡', 'Conductor',
    { value: 1, note: 'Your lightning rolls its damage dice twice against the Wet, and arcs 1d6 to every Wet enemy next to the target.' },
    { value: 2, note: 'Your lightning rolls its damage dice twice against the Wet, and arcs 2d6 to every Wet enemy next to the target.' },
    { name: 'Superconductor', value: 2, note: 'Your lightning rolls its damage dice three times against the Wet, and arcs 2d6 to every Wet enemy next to the target.' },
    { name: 'Storm Chain', value: 2, note: 'Your lightning rolls its damage dice twice against the Wet, and arcs 2d6 to every Wet enemy within 3 tiles of the target.' }),
  shatter_point: passive('wizard', '💎', 'Shatter Point',
    { value: 2, note: 'Your hits deal +2d6 against the Frozen, and break the ice.' },
    { value: 3, note: 'Your hits deal +3d6 against the Frozen, and break the ice.' },
    { name: 'Glass Shards', value: 4, note: 'Your hits deal +4d6 against the Frozen, and break the ice.' },
    { name: 'Frost Shatter', value: 3, note: 'Your hits deal +3d6 against the Frozen and break the ice, and the shards Chill every enemy next to it.' }),
  convergence: passive('wizard', '🌈', 'Convergence',
    { value: 1, note: 'Once per turn, setting off a combo (oil that explodes, water that shocks, a freeze or a stun on the Wet) gives you 1 AP back.' },
    { value: 2, note: 'Twice per turn, setting off a combo gives you 1 AP back.' },
    { name: 'Harmony', value: 3, note: 'Three times per turn, setting off a combo gives you 1 AP back.' },
    { name: 'Elemental Surge', value: 1, note: 'Once per turn, setting off a combo gives you 2 AP back.' }),
  // Wizard: Geomancer (terrain)
  raise_cover: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Raise Cover', icon: '🪨', ap: 1, target: 'area', range: 5, radius: 0, cooldown: 2, raise: { cover: 'low', tiles: 2 }, note: 'Rubble rises across the spot, on empty floor: you can shoot over it, nobody can walk through it.' },
    t2: { raise: { cover: 'low', tiles: 3 } },
    a: { name: 'Earthen Rampart', raise: { cover: 'low', tiles: 5 } },
    b: { name: 'Quick Rampart', ap: 0, cooldown: 3 },
  },
  wall_of_stone: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Wall of Stone', icon: '⛰️', ap: 2, target: 'area', range: 6, radius: 0, slots: 1, raise: { cover: 'wall', tiles: 3, turns: 3 }, note: 'A wall rises across the spot, on empty floor, for 3 rounds: it blocks movement and sight.' },
    t2: { raise: { cover: 'wall', tiles: 5, turns: 3 } },
    a: { name: 'Bastion Wall', raise: { cover: 'wall', tiles: 5, turns: 5 } },
    b: { name: 'Prison of Stone', target: 'enemy', range: 6, raise: { cover: 'wall', tiles: 8, turns: 2, ring: true }, note: 'Walls rise all around an enemy for 2 rounds: it can only fight what stands next to it.' },
  },
  shatter_ground: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Shatter Ground', icon: '⛏️', ap: 2, target: 'area', range: 6, radius: 1, slots: 1, roll: 'save', save: 'dex', half: true, dmg: d(2, 6), onHit: [st('prone', 1)], rubble: 2 },
    t2: { dmg: d(3, 6), rubble: 3 },
    a: { name: 'Earthquake', radius: 2 },
    b: { name: 'Sinkhole', onHit: [st('prone', 1), st('dazed', 1)] },
  },
  tremor: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Tremor', icon: '〰️', ap: 2, target: 'around', range: 0, radius: 1, cooldown: 2, roll: 'save', save: 'str', dmg: d(1, 6), push: 1, onHit: [st('prone', 1)] },
    t2: { dmg: d(2, 6) },
    a: { name: 'Seismic Wave', radius: 2 },
    b: { name: 'Rumble', push: 2 },
  },
  crushing_force: passive('wizard', '🧱', 'Crushing Force',
    { value: 1, note: 'Anything you push into a wall, cover or a creature takes 1d6 for each tile it could not move.' },
    { value: 2, note: 'Anything you push into a wall, cover or a creature takes 2d6 for each tile it could not move.' },
    { name: 'Pulverize', value: 3, note: 'Anything you push into a wall, cover or a creature takes 3d6 for each tile it could not move.' },
    { name: 'Domino', value: 2, note: 'Anything you push into a wall, cover or a creature takes 2d6 for each tile it could not move, and so does the creature it hits.' }),
  earthshaper: passive('wizard', '🏔️', 'Earthshaper',
    { value: 2, note: 'Walls and cover you raise burst for 2d6 on every enemy next to them, and your walls last twice as long.' },
    { value: 3, note: 'Walls and cover you raise burst for 3d6 on every enemy next to them, and your walls last twice as long.' },
    { name: "Mountain's Wrath", value: 4, note: 'Walls and cover you raise burst for 4d6 on every enemy next to them, and your walls last twice as long.' },
    { name: 'Living Stone', value: 2, note: 'Walls and cover you raise burst for 2d6 on enemies next to them and give friends next to them 1d6 Block; your walls last twice as long.' }),

  // Cleric: Life (overhealing)
  overflowing_grace: passive('cleric', '🌊', 'Overflowing Grace',
    { value: 100, note: 'Healing you give past max HP becomes your Block on them.' },
    { value: 100, note: 'Healing you give past max HP becomes your Block on them, and every heal of yours gives at least 2 Block.' },
    { name: 'Cup Runneth Over', value: 150, note: 'Healing you give past max HP becomes one and a half times as much Block, and every heal gives at least 2.' },
    { name: 'Living Shield', value: 100, note: 'Healing past max HP becomes Block (at least 2), and the friend gets +1 AC until your next turn.' }),
  soul_link: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Soul Link', icon: '🔗', ap: 1, target: 'ally', range: 6, slots: 1, status: [st('linked', 3, 50)], note: 'While linked, every heal you give anyone else also heals them for half.' },
    t2: { status: [st('linked', 4, 50)] },
    a: { name: 'Twin Souls', status: [st('linked', 4, 100)], note: 'While linked, every heal you give anyone else also heals them as much.' },
    b: { name: 'Guardian Link', status: [st('linked', 4, 50), st('shielded', 2, 1)] },
  },
  font_of_life: passive('cleric', '⛲', 'Font of Life',
    { value: 1, note: 'A heal of yours on a friend below half HP gives them 1 AP (now on their turn, or on their next one). Once per friend per round.' },
    { value: 1, note: 'A heal of yours on a friend below half HP gives them 1 AP and +2 movement. Once per friend per round.' },
    { name: 'Wellspring', value: 2, note: 'A heal of yours on a friend below half HP gives them 2 AP. Once per friend per round.' },
    { name: 'Second Life', value: 1, note: 'A heal of yours on a friend below half HP gives them 1 AP and +2 AC until your next turn. Once per friend per round.' }),
  // Cleric: Order (buffs from range)
  inspiring_presence: passive('cleric', '🕊️', 'Inspiring Presence',
    { value: 1, note: 'Friends deal +1 damage for every buff of yours on them.' },
    { value: 2, note: 'Friends deal +2 damage for every buff of yours on them.' },
    { name: 'Crusade', value: 3, note: 'Friends deal +3 damage for every buff of yours on them.' },
    { name: 'Zeal', value: 2, note: 'Friends deal +2 damage for every buff of yours on them, and your buffs last 1 turn longer.' }),
  divine_order: passive('cleric', '📜', 'Divine Order',
    { value: 1, note: 'Bless also gives everyone it touches 1 AP (once a round).' },
    { value: 1, note: 'Bless and Warding Light also give everyone they touch 1 AP (once a round).' },
    { name: 'Divine Mandate', value: 2, note: 'Bless and Warding Light also give everyone they touch 2 AP (once a round).' },
    { name: 'Chain of Command', value: 1, note: 'Bless and Warding Light also give 1 AP (once a round), and Bless costs 1 AP less.' }),
  // Cleric: Light (Radiance)
  searing_light: passive('cleric', '🔆', 'Searing Light',
    { value: 1, note: 'Your radiant hits Sear the target: +1 Radiance (up to 5). Every Radiance on an enemy adds +1 to radiant damage it takes, from anyone.' },
    { value: 2, note: 'Your radiant hits Sear the target: +2 Radiance (up to 5). Every Radiance adds +1 to radiant damage it takes.' },
    { name: 'Blinding Light', value: 2, note: 'Your radiant hits add +2 Radiance (up to 5), and at 5 the enemy is Blinded.' },
    { name: 'Holy Brand', value: 1, note: 'Your radiant hits add +1 Radiance (up to 5), and every Radiance adds +2 to radiant damage it takes.' }),
  dawn: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Dawn', icon: '🌅', ap: 2, target: 'around', range: 0, radius: 3, slots: 1, roll: 'auto', dmg: d(1, 4), element: 'radiant', per: { of: 'radiance', dice: d(1, 6), spend: true } },
    t2: { per: { of: 'radiance', dice: d(1, 8), spend: true } },
    a: { name: 'High Noon', radius: 5 },
    b: { name: 'Lingering Dawn', per: { of: 'radiance', dice: d(1, 6) } },
  },
  avatar_of_light: passive('cleric', '😇', 'Avatar of Light',
    { value: 5, note: 'Radiance you put on enemies never fades, and when a Seared enemy dies its Radiance spreads to the enemies next to it.' },
    { value: 8, note: 'Radiance you put on enemies never fades, can reach 8, and spreads to the enemies next to a Seared enemy that dies.' },
    { name: 'Sunfire', value: 8, note: 'Radiance never fades, can reach 8 and spreads on a death, and Seared enemies take 1 radiant per Radiance at the start of their turn.' },
    { name: 'Radiant Soul', value: 8, note: 'Radiance never fades, can reach 8 and spreads on a death, and your radiant hits deal +1d4.' }),

  // Barbarian: Berserker (low HP, high damage)
  blood_rite: {
    kind: 'cantrip', pool: 'barbarian',
    base: { name: 'Blood Rite', icon: '🗡️', ap: 0, target: 'self', range: 0, cooldown: 2, hpCost: 15, selfStatus: [st('honed', 2, 2)], note: 'Your next hit deals +2d8.' },
    t2: { selfStatus: [st('honed', 2, 3)], note: 'Your next hit deals +3d8.' },
    a: { name: 'Blood Oath', hpCost: 20, selfStatus: [st('honed', 2, 4)], note: 'Your next hit deals +4d8.' },
    b: { name: 'Frenzied Rite', selfStatus: [st('honed', 2, 3), st('blessed', 1)], note: 'Your next hit deals +3d8.' },
  },
  blood_fury: passive('barbarian', '😡', 'Blood Fury',
    { value: 1, note: 'Your melee hits deal +1 damage for every 10% of your HP you are missing.' },
    { value: 1, note: 'Your melee hits deal +1 damage for every 10% of your HP you are missing, and +3 more below half HP.' },
    { name: 'Berserk Fury', value: 2, note: 'Your melee hits deal +2 damage for every 10% of your HP you are missing.' },
    { name: 'Cold Fury', value: 1, note: 'Your melee hits deal +1 damage for every 10% of your HP you are missing, and heal you 2 below half HP.' }),
  unkillable: passive('barbarian', '💀', 'Unkillable',
    { note: "While Raging, you can't drop below 1 HP." },
    { value: 1, note: "While Raging, you can't drop below 1 HP, and each time that saves you, you heal 1d8." },
    { name: 'Undying Fury', value: 1, note: "While Raging, you can't drop below 1 HP; each time that saves you, you heal 1d8 and your Rage deals +2 damage." },
    { name: 'Defy Death', value: 1, note: "While Raging you can't drop below 1 HP (healing 1d8 when it saves you), and once per fight not even without Rage." }),
  // Barbarian: Juggernaut (lifesteal tank)
  bloodbath: passive('barbarian', '🍷', 'Bloodbath',
    { value: 2, note: 'Your lifesteal heals twice as much from Taunted enemies.' },
    { value: 2, note: 'Your lifesteal heals twice as much from Taunted, Prone and Netted enemies.' },
    { name: 'Sanguine Feast', value: 3, note: 'Your lifesteal heals three times as much from Taunted, Prone and Netted enemies.' },
    { name: 'Blood Bond', value: 2, note: 'Lifesteal heals twice as much from the Taunted, Prone and Netted, and the most hurt friend next to you heals half of it too.' }),
  scar_tissue: passive('barbarian', '🦴', 'Scar Tissue',
    { value: 100, note: 'Healing past your max HP becomes Block.' },
    { value: 150, note: 'Healing past your max HP becomes one and a half times as much Block.' },
    { name: 'Iron Scars', value: 200, note: 'Healing past your max HP becomes twice as much Block.' },
    { name: 'Hardened Scars', value: 150, note: 'Healing past your max HP becomes one and a half times as much Block, and you have +1 AC while you have Block.' }),
  immortal_hunger: passive('barbarian', '🧛', 'Immortal Hunger',
    { value: 4, note: 'While Raging, every heal you get makes your Rage deal +1 damage more (up to +4, until it ends).' },
    { value: 6, note: 'While Raging, every heal you get makes your Rage deal +1 damage more (up to +6).' },
    { name: 'Endless Hunger', value: 99, note: 'While Raging, every heal you get makes your Rage deal +1 damage more, with no limit.' },
    { name: 'Ravenous', value: 6, note: 'While Raging, every heal you get makes your Rage deal +2 damage more (up to +6).' }),
  // Barbarian: Wrecker (knockdowns)
  stomp: passive('barbarian', '🦶', 'Stomp',
    { value: 2, note: 'Your hits deal +2d6 against the Prone.' },
    { value: 3, note: 'Your hits deal +3d6 against the Prone.' },
    { name: 'Crater', value: 4, note: 'Your hits deal +4d6 against the Prone.' },
    { name: 'Grinding Stomp', value: 3, note: 'Your hits deal +3d6 against the Prone and leave them Dazed.' }),
  pile_driver: passive('barbarian', '⬇️', 'Pile Driver',
    { note: 'A Shove that wins also knocks the target Prone.' },
    { note: 'A Shove that wins also knocks the target Prone, and once per turn Shove costs no AP.' },
    { name: 'Body Slam', note: 'A Shove that wins knocks the target Prone and deals your weapon damage; once per turn Shove costs no AP.' },
    { name: 'Ground and Pound', note: 'A Shove that wins knocks the target Prone and Dazes it; once per turn Shove costs no AP.' }),
  earthbreaker: passive('barbarian', '🌋', 'Earthbreaker',
    { note: 'Anything you knock Prone takes your weapon damage (no roll).' },
    { note: 'Anything you knock Prone takes your weapon damage plus STR (no roll).' },
    { name: 'World Breaker', note: 'Anything you knock Prone takes your weapon damage plus STR, and every enemy next to it takes half.' },
    { name: 'Tectonic Rage', note: 'Anything you knock Prone takes your weapon damage plus STR, and each one makes your Rage deal +1 more (up to +4).' }),

  // Ranger: Trapper (traps and nets)
  spike_pit: {
    kind: 'cantrip', pool: 'ranger',
    base: { name: 'Spike Pit', icon: '🕳️', ap: 1, target: 'area', range: 4, radius: 0, cooldown: 2, trap: { status: [st('prone', 1)], dmg: d(2, 6) }, note: "Monsters don't see traps. Up to 3 at a time." },
    t2: { trap: { status: [st('prone', 1)], dmg: d(3, 6) } },
    a: { name: 'Punji Field', radius: 1 },
    b: { name: 'Poisoned Spikes', trap: { status: [st('prone', 1), st('poisoned', 2, 2)], dmg: d(3, 6) } },
  },
  fire_trap: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Fire Trap', icon: '🧨', ap: 1, target: 'area', range: 4, radius: 0, slots: 1, trap: { status: [st('burning', 2)], dmg: d(2, 6), element: 'fire' }, note: "A hidden fire trap: it lights any oil around it. Monsters don't see traps." },
    t2: { trap: { status: [st('burning', 2)], dmg: d(3, 6), element: 'fire' } },
    a: { name: 'Inferno Trap', radius: 1 },
    b: { name: 'Flash Trap', trap: { status: [st('burning', 2), st('blinded', 1)], dmg: d(3, 6), element: 'fire' } },
  },
  hunters_snare: passive('ranger', '🪢', "Hunter's Snare",
    { value: 50, note: 'Your hits deal 50% more damage against the Netted, the Webbed and the Prone.' },
    { value: 75, note: 'Your hits deal 75% more damage against the Netted, the Webbed and the Prone.' },
    { name: 'Killing Snare', value: 100, note: 'Your hits deal double damage against the Netted, the Webbed and the Prone.' },
    { name: 'Trophy Hunter', value: 75, note: 'Your hits deal 75% more against the Netted, Webbed and Prone, and killing one gives 1 AP back (once per turn).' }),
  killing_field: passive('ranger', '☠️', 'Killing Field',
    { value: 2, note: 'Each of your traps springs twice before it is used up.' },
    { value: 2, note: 'Each of your traps springs twice, and you can keep 5 traps at a time.' },
    { name: 'Minefield', value: 3, note: 'Each of your traps springs three times, and you can keep 5 traps at a time.' },
    { name: 'Cruel Traps', value: 2, note: 'Each of your traps springs twice and deals +1d6, and you can keep 5 traps at a time.' }),
  // Ranger: Sharpshooter (stand still, hit hard)
  patience: passive('ranger', '🧘', 'Patience',
    { value: 3, note: 'Each turn you end without moving gives you 1 Focus (up to 3, until the fight ends).' },
    { value: 4, note: 'Each turn you end without moving gives you 1 Focus (up to 4).' },
    { name: 'Stillness', value: 4, note: 'Each turn you end without moving gives you 2 Focus (up to 4).' },
    { name: "Hunter's Calm", value: 3, note: 'Each turn you end without moving gives you 1 Focus (up to 3), and each Focus gives +1 to your attack rolls.' }),
  kill_shot: {
    kind: 'spell', pool: 'ranger',
    base: { name: 'Kill Shot', icon: '🔱', ap: 2, target: 'enemy', range: 12, slots: 1, stat: 'dex', roll: 'attack', dmg: d(1, 10), mod: true, per: { of: 'focus', dice: d(1, 8), spend: true } },
    t2: { per: { of: 'focus', dice: d(1, 10), spend: true } },
    a: { name: 'Execution Shot', critFull: true },
    b: { name: 'Twin Shot', hits: 2 },
  },
  snipers_nest: passive('ranger', '🪺', "Sniper's Nest",
    { value: 2, note: 'Shooting from cover (cover between you and the target), your ranged attacks crit on 18 or higher.' },
    { value: 3, note: 'Shooting from cover, your ranged attacks crit on 17 or higher.' },
    { name: 'Overwatch', value: 3, note: 'Shooting from cover, your ranged attacks crit on 17 or higher and get +2 to hit.' },
    { name: 'Deadly Nest', value: 2, note: 'Shooting from cover, your ranged attacks crit on 18 or higher, and those crits deal +2d8.' }),
  // Ranger: Hunter (marks and many targets)
  split_shot: passive('ranger', '🪃', 'Split Shot',
    { value: 1, note: 'Quick Shot also fires at another Marked enemy in range.' },
    { value: 1, note: 'Quick Shot also fires at another Marked enemy in range, with +2 damage.' },
    { name: 'Triple Shot', value: 2, note: 'Quick Shot also fires at two more Marked enemies in range, with +2 damage.' },
    { name: 'Marking Shot', value: 1, note: 'Quick Shot also fires at another enemy in range (Marked first), with +2 damage, and Marks it.' }),
  pack_hunter: passive('ranger', '🐺', 'Pack Hunter',
    { value: 1, note: 'Your hits deal +1 damage for every Marked enemy in the room.' },
    { value: 2, note: 'Your hits deal +2 damage for every Marked enemy in the room.' },
    { name: 'Alpha', value: 3, note: 'Your hits deal +3 damage for every Marked enemy in the room.' },
    { name: 'Pack Leader', value: 2, note: 'Your hits deal +2 damage for every Marked enemy in the room, and your friends\' hits +1.' }),
  rain_of_arrows: passive('ranger', '🌧️', 'Rain of Arrows',
    { value: 1, note: 'Once per turn, when you hit a Marked enemy, every other Marked enemy within 8 tiles takes 1d6.' },
    { value: 2, note: 'Once per turn, when you hit a Marked enemy, every other Marked enemy within 8 tiles takes 2d6.' },
    { name: 'Deluge of Arrows', value: 3, note: 'Once per turn, when you hit a Marked enemy, every other Marked enemy within 8 tiles takes 3d6.' },
    { name: 'Endless Rain', value: 2, note: 'Twice per turn, when you hit a Marked enemy, every other Marked enemy within 8 tiles takes 2d6.' }),

  // Paladin: Protection (Block on friends)
  shared_burden: passive('paladin', '🫂', 'Shared Burden',
    { value: 50, note: 'When Block you gave a friend soaks a hit, you heal half of what it soaked.' },
    { value: 75, note: 'When Block you gave a friend soaks a hit, you heal three quarters of what it soaked.' },
    { name: "Martyr's Grace", value: 100, note: 'When Block you gave a friend soaks a hit, you heal all of what it soaked.' },
    { name: 'Bond of Steel', value: 50, note: 'When Block you gave a friend soaks a hit, you and the friend both heal half of what it soaked.' }),
  unbreakable_oath: passive('paladin', '🗝️', 'Unbreakable Oath',
    { note: 'Block you give lasts through your next turn: it runs out at the start of the one after.' },
    { value: 2, note: 'Block you give lasts through your next turn, and is 2 higher.' },
    { name: 'Eternal Oath', value: 4, note: 'Block you give lasts through your next turn, and is 4 higher.' },
    { name: 'Oath of Valor', value: 2, note: 'Block you give lasts through your next turn and is 2 higher, and friends holding it deal +1 damage.' }),
  // Paladin: Devotion (sustain by touch)
  radiant_recovery: passive('paladin', '🌤️', 'Radiant Recovery',
    { value: 50, note: 'Heals you give also give the target Block equal to half the healing.' },
    { value: 75, note: 'Heals you give also give the target Block equal to three quarters of the healing.' },
    { name: 'Radiant Bastion', value: 100, note: 'Heals you give also give the target as much Block as the healing.' },
    { name: 'Light of Recovery', value: 50, note: 'Heals you give also give half as much Block, and heal you 2.' }),
  saint: passive('paladin', '🕯️', 'Saint',
    { note: 'Lay on Hands has no cooldown when you use it on a friend below half HP.' },
    { value: 4, note: 'Lay on Hands has no cooldown on a friend below half HP, and heals +4.' },
    { name: 'Miracle Worker', value: 4, note: 'Lay on Hands has no cooldown on a friend below three quarters of their HP, and heals +4.' },
    { name: 'Martyr', value: 4, note: 'Lay on Hands has no cooldown on a friend below half HP, heals +4 and costs no AP, but you lose 3 HP.' }),
  // Paladin: Vengeance (smite burst)
  vow_of_enmity: {
    kind: 'cantrip', pool: 'paladin',
    base: { name: 'Vow of Enmity', icon: '🎌', ap: 1, target: 'enemy', range: 6, cooldown: 3, onHit: [st('marked', 2)], note: 'No roll: every attack on it has advantage.' },
    t2: { onHit: [st('marked', 3)] },
    a: { name: 'Sworn Enemy', onHit: [st('marked', 3), st('dazed', 1)] },
    b: { name: 'Vow of Wrath', selfStatus: [st('honed', 2, 1)] },
  },
  zealous_smite: passive('paladin', '🗯️', 'Zealous Smite',
    { value: 1, note: 'Your smites (Divine Smite and Radiant Strike) crit on 19 or 20, and a crit smite rolls its dice three times.' },
    { value: 2, note: 'Your smites crit on 18 or higher, and a crit smite rolls its dice three times.' },
    { name: 'Wrath of the Gods', value: 3, note: 'Your smites crit on 17 or higher, and a crit smite rolls its dice three times.' },
    { name: 'Righteous Fury', value: 2, note: 'Your smites crit on 18 or higher, a crit smite rolls its dice three times, and heals you 1d8.' }),
  avenging_angel: passive('paladin', '👼', 'Avenging Angel',
    { note: 'A killing blow with Divine Smite gives its slot back (once per turn).' },
    { note: 'A killing blow with Divine Smite gives its slot and 1 AP back (once per turn).' },
    { name: 'Angel of Death', note: 'A killing blow with any smite gives 1 AP back, and with Divine Smite the slot too (once per turn).' },
    { name: 'Wings of Vengeance', note: 'A killing blow with Divine Smite gives its slot and 1 AP back, and +3 movement (once per turn).' }),

  // Bard: Valor (hand out AP)
  standing_ovation: passive('bard', '👏', 'Standing Ovation',
    { value: 1, note: 'Bardic Inspiration on a friend who still has your last one (Focused) gives them 1 AP more.' },
    { value: 1, note: 'Bardic Inspiration on a friend who still has your last one gives them 1 AP more, and it gets ready a turn sooner.' },
    { name: 'Curtain Call', value: 2, note: 'Bardic Inspiration on a friend who still has your last one gives them 2 AP more, and it gets ready a turn sooner.' },
    { name: 'Bravo', value: 1, note: 'Bardic Inspiration on a friend who still has your last one gives them 1 AP more and +2 movement, and it gets ready a turn sooner.' }),
  heroic_saga: passive('bard', '📖', 'Heroic Saga',
    { value: 3, note: 'Bardic Inspiration also Inspires: +1d6 damage on their hits for 2 turns, stacking up to 3.' },
    { value: 4, note: 'Bardic Inspiration also Inspires: +1d6 damage on their hits for 2 turns, stacking up to 4.' },
    { name: 'Legend', value: 4, note: 'Bardic Inspiration also Inspires: +1d8 damage on their hits for 2 turns, stacking up to 4.' },
    { name: 'Epic Tale', value: 3, note: 'Bardic Inspiration Inspires your friend and you: +1d6 on hits for 2 turns, stacking up to 3.' }),
  // Bard: Whispers (debuffs stack)
  mind_rot: {
    kind: 'cantrip', pool: 'bard',
    base: { name: 'Mind Rot', icon: '🌀', ap: 2, target: 'enemy', range: 6, cooldown: 1, roll: 'save', save: 'wis', half: true, dmg: d(1, 6), element: 'force', per: { of: 'debuffs', dice: d(1, 6) } },
    t2: { dmg: d(2, 6) },
    a: { name: 'Mind Shred', per: { of: 'debuffs', dice: d(1, 8) } },
    b: { name: 'Fester', onHit: [st('dazed', 1)] },
  },
  haunting_refrain: passive('bard', '👻', 'Haunting Refrain',
    { value: 1, note: 'Debuffs you put on monsters last 1 turn longer.' },
    { value: 1, note: 'Debuffs you put on monsters last 1 turn longer, and every one of them adds +1 to the damage it takes from anyone.' },
    { name: 'Endless Refrain', value: 2, note: 'Debuffs you put on monsters last 2 turns longer, and every one adds +1 to the damage it takes.' },
    { name: 'Dirge', value: 1, note: 'Debuffs you put on monsters last 1 turn longer, and every one adds +2 to the damage it takes.' }),
  madness: passive('bard', '🤪', 'Madness',
    { value: 3, note: 'A monster with 3 or more of your debuffs goes mad on its turn: it attacks another monster it can reach instead of you.' },
    { value: 3, note: 'A monster with 3 or more of your debuffs goes mad on its turn, attacks another monster it can reach, and takes 1d6.' },
    { name: 'Bedlam', value: 2, note: 'A monster with 2 or more of your debuffs goes mad on its turn, attacks another monster it can reach, and takes 1d6.' },
    { name: 'Delirium', value: 3, note: 'A monster with 3 or more of your debuffs goes mad on its turn, attacks another monster it can reach, takes 1d6 and is Dazed.' }),
  // Bard: Crescendo (Verses)
  verse: passive('bard', '🎼', 'Verse',
    { value: 5, note: 'Every cantrip or spell you cast adds a Verse (up to 5, until the fight ends). The Finale spends them.' },
    { value: 6, note: 'Every cantrip or spell you cast adds a Verse (up to 6).' },
    { name: 'Chorus', value: 6, note: 'Every spell you cast adds 2 Verses, every cantrip 1 (up to 6).' },
    { name: 'Refrain', value: 6, note: 'Every cantrip or spell adds a Verse (up to 6), and you start every fight with 2.' }),
  finale: {
    kind: 'spell', pool: 'bard',
    base: { name: 'Finale', icon: '🎆', ap: 2, target: 'allies', range: 0, radius: 3, slots: 1, finale: { heal: 2, block: 2 }, note: 'Spends all your Verses: you and every friend within 3 tiles heal 2 and get 2 Block per Verse.' },
    t2: { finale: { heal: 3, block: 3 }, note: 'Spends all your Verses: you and every friend within 3 tiles heal 3 and get 3 Block per Verse.' },
    a: { name: 'Grand Finale', radius: 5 },
    b: { name: 'Crashing Finale', target: 'around', roll: 'save', save: 'dex', half: true, dmg: d(1, 4), element: 'force', per: { of: 'verses', dice: d(1, 8), spend: true }, note: '' },
  },
  magnum_opus: passive('bard', '🎻', 'Magnum Opus',
    { value: 1, note: 'Your first Finale each fight keeps its Verses.' },
    { value: 1, note: 'Your first Finale each fight keeps its Verses and gives everyone it touches 1 AP.' },
    { name: 'Masterpiece', value: 2, note: 'Your first two Finales each fight keep their Verses and give everyone they touch 1 AP.' },
    { name: 'Opus of Valor', value: 1, note: 'Your first Finale keeps its Verses and gives 1 AP, and you gain a Verse at the start of each of your turns.' }),
} satisfies Record<string, SkillDef>;

export type SkillId = keyof typeof SKILL_DEFS;
export const SKILLS: Record<SkillId, SkillDef> = SKILL_DEFS;
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

export const isSkillId = (id: unknown): id is SkillId => typeof id === 'string' && Object.hasOwn(SKILLS, id);

// ---------------------------------------------------------------- build engines and card rarity (shared/engines.ts)

const ENGINE_OF: Partial<Record<SkillId, EngineId>> = {};
const RARITY_OF: Partial<Record<SkillId, CardRarity>> = {};
for (const id of ENGINE_IDS) {
  for (const [r, cards] of Object.entries(ENGINES[id].cards) as [CardRarity, SkillId[]][]) {
    for (const c of cards) {
      ENGINE_OF[c] = id;
      RARITY_OF[c] = r;
    }
  }
}
/** The engine a class card builds toward (none for basics and the common pool). */
export const engineOf = (id: SkillId): EngineId | undefined => ENGINE_OF[id];
/** How rare a card is in offers: engines say, everything else is common. */
export const cardRarity = (id: SkillId): CardRarity => RARITY_OF[id] ?? 'common';
/** How many of an engine's cards a hero owns. */
export const engineCount = (p: Pick<PlayerEntity, 'skills'>, engine: EngineId): number => p.skills.filter((o) => ENGINE_OF[o.id] === engine).length;
/** How many of an engine's cards a hero picked (their class's starting cards don't count): what offers lean on. */
export const enginePicks = (p: Pick<PlayerEntity, 'skills' | 'classId'>, engine: EngineId): number =>
  p.skills.filter((o) => ENGINE_OF[o.id] === engine && !CLASSES[p.classId].start.includes(o.id)).length;
/** The engine a hero has built furthest (at least 2 cards), for labels like "Fighter · Guardian". */
export function topEngine(p: Pick<PlayerEntity, 'skills'>): EngineId | undefined {
  let best: EngineId | undefined;
  let most = 1;
  for (const id of ENGINE_IDS) {
    const n = engineCount(p, id);
    if (n > most) [best, most] = [id, n];
  }
  return best;
}
export const canUpgrade = (id: SkillId) => !!SKILLS[id].t2;

// ---------------------------------------------------------------- reading skills

/** The stats of a skill at a tier (tier 3 needs a branch). */
export function statsAt(id: SkillId, tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B'): SkillStats {
  const def = SKILLS[id];
  let s: SkillStats = def.base;
  if (tier >= 2 && def.t2) s = { ...s, ...def.t2 };
  if (tier >= 3) {
    const br = branch === 'B' ? def.b : def.a;
    if (br) s = { ...s, ...br };
  }
  if (def.kind === 'cantrip' && s.heal) s = { ...s, noRevive: true }; // cantrips can't get the downed up (2026-10-19)
  return s;
}

export const statsOf = (o: Pick<OwnedSkill, 'id' | 'tier' | 'branch'>) => statsAt(o.id, o.tier, o.branch);

export const TIER_LABEL = (tier: number, branch?: 'A' | 'B') => (tier >= 3 ? `III-${branch ?? 'A'}` : tier === 2 ? 'II' : 'I');

/** "Fire Bolt II", or the branch's own name at tier III ("Inferno"). Basic attacks have no tier label. */
export function skillTitle(o: Pick<OwnedSkill, 'id' | 'tier' | 'branch'>): string {
  const def = SKILLS[o.id];
  if (!def.t2) return def.base.name;
  if (o.tier >= 3) return statsOf(o).name;
  return `${def.base.name} ${TIER_LABEL(o.tier)}`;
}

/** Things every hero can do without learning them. */
export const COMMON_ACTIONS: SkillId[] = ['shove', 'potion', 'help_up', 'cut_free', 'dash', 'brace'];

/** Consumables in the bag, one hotbar entry per kind. */
export const bagConsumables = (p: Pick<PlayerEntity, 'bag'>): SkillId[] =>
  [...new Set(p.bag)].filter((id): id is ItemId & SkillId => isItemId(id) && ITEMS[id].kind === 'consumable' && isSkillId(id));

/** The hero's copy of a skill. Shove and the potion are things everyone has; consumables come from the bag. */
export function ownedSkill(p: PlayerEntity, id: SkillId): OwnedSkill | undefined {
  if (COMMON_ACTIONS.includes(id)) return { id, tier: 1, cd: 0 };
  if (SKILLS[id].kind === 'item') return (p.bag as string[]).includes(id) ? { id, tier: 1, cd: 0 } : undefined;
  return p.skills.find((s) => s.id === id);
}

/** A passive the hero has: its tier, branch and number, or null. */
export function passiveOf(p: PlayerEntity, id: SkillId): { tier: 1 | 2 | 3; branch?: 'A' | 'B'; value: number } | null {
  const o = p.skills.find((s) => s.id === id);
  if (!o || SKILLS[id].kind !== 'passive') return null;
  return { tier: o.tier, branch: o.branch, value: statsOf(o).value ?? 0 };
}

/** True if the hero has this passive at tier III with this branch. */
export const hasBranch = (p: PlayerEntity, id: SkillId, branch: 'A' | 'B') => {
  const o = p.skills.find((s) => s.id === id);
  return !!o && o.tier === 3 && o.branch === branch;
};

/** Usable skills in hotbar order: basic attacks, cantrips, spells, Shove and the potion, then the bag. Keys 1-9, 0 follow this order. */
export function hotbar(p: PlayerEntity): SkillId[] {
  const of = (k: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === k).map((s) => s.id);
  return [...of('basic'), ...of('cantrip'), ...of('spell'), ...COMMON_ACTIONS, ...bagConsumables(p)];
}

export const skillsOfKind = (p: PlayerEntity, kind: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === kind);
export const slotCost = (s: SkillStats) => s.slots ?? 1;
export const hasStatus = (e: Entity, id: StatusId) => e.statuses.some((x) => x.id === id);
/** Stacks of a status (its power), 0 without it: Poison, Radiance, Focus, Verses, Arcane Charges. */
export const stacksOf = (e: Pick<Entity, 'statuses'>, id: StatusId): number => e.statuses.find((x) => x.id === id)?.power ?? 0;
/** Debuffs on a creature (Mind Rot, Cunning Strikes, Madness); `by` counts only that hero's. */
export const debuffsOn = (e: Pick<Entity, 'statuses'>, by?: string): number => e.statuses.filter((x) => !STATUSES[x.id].good && (!by || x.by === by)).length;

/**
 * What a skill costs in AP right now: Archmage takes 1 off spells with enough Arcane Charges, Pile Driver makes one
 * Shove a turn free, Chain of Command makes Bless cheaper.
 */
export function apOf(p: PlayerEntity, id: SkillId, s: SkillStats): number {
  let ap = s.ap;
  const kind = SKILLS[id].kind;
  const mage = kind === 'spell' ? passiveOf(p, 'archmage') : null;
  if (mage && stacksOf(p, 'charged') >= mage.value && (ap >= 3 || hasBranch(p, 'archmage', 'A'))) ap = Math.max(1, ap - 1);
  if (id === 'shove' && (passiveOf(p, 'pile_driver')?.tier ?? 0) >= 2 && !p.used.includes('turn:free-shove')) ap = 0;
  if (id === 'bless' && hasBranch(p, 'divine_order', 'B')) ap = Math.max(0, ap - 1);
  if (id === 'lay_on_hands' && hasBranch(p, 'saint', 'B')) ap = 0;
  return ap;
}
/** 🧱 Block on a creature, from everyone who gave it some. */
export const blockOf = (e: Pick<Entity, 'block'>): number => Object.values(e.block ?? {}).reduce((s, n) => s + n, 0);
/** Fireball's falloff: a creature on the outer ring of a big blast (radius 2 or more: Fireball II, Meteor) takes half. */
export const atEdge = (s: SkillStats, center: Pos, e: Pos) => !!s.falloff && s.target === 'area' && (s.radius ?? 0) >= 2 && dist(center, e) >= (s.radius ?? 0);

// ---------------------------------------------------------------- numbers for a hero

export const statFor = (p: Pick<PlayerEntity, 'classId'>, s: SkillStats): Stat => s.stat ?? CLASSES[p.classId].stat;
type Hero = Pick<PlayerEntity, 'classId' | 'level'> & Partial<Pick<PlayerEntity, 'gear' | 'relics' | 'maxHp'>>;

/** Attack bonus with a skill: proficiency + its stat, plus equipment (an Arcane Focus helps skills on your casting stat). */
export const attackBonus = (p: Hero, s: SkillStats) =>
  profBonus(p.level) + statMod(p.classId, statFor(p, s)) + gearBonus(p, 'hit') + (s.stat ? 0 : gearBonus(p, 'power'));
/** Save DC of a hero's cantrips, spells and bombs: 8 + proficiency + casting stat, plus equipment. */
export const heroDc = (p: Hero) => saveDc(p.classId, p.level) + gearBonus(p, 'power');
/** Flat damage bonus with a skill (its stat modifier, if `mod`). */
export const damageMod = (p: Pick<PlayerEntity, 'classId'>, s: SkillStats) => (s.mod ? statMod(p.classId, statFor(p, s)) : 0);
/** Flat bonus on a heal. */
export const healBonus = (p: Hero, s: SkillStats) =>
  (s.heal?.bonus ?? 0) + (s.healMod ? statMod(p.classId, CLASSES[p.classId].stat) : 0) + (s.healLevel ? p.level : 0) + gearBonus(p, 'heal');
/** Attacks (or darts) per target. */
export const hitsOf = (p: Pick<PlayerEntity, 'level'>, s: SkillStats) => (s.hits ?? 1) + (s.extraAttack && p.level >= 5 ? 1 : 0);

const avgDice = (x: Dice) => (x.n * (x.d + 1)) / 2 + (x.bonus ?? 0);
export { avgDice };

// ---------------------------------------------------------------- descriptions

const ELEMENT_WORD: Record<Element, string> = {
  physical: '', fire: ' fire', cold: ' cold', lightning: ' lightning', poison: ' poison', radiant: ' radiant', force: ' force',
};
const STAT_WORD: Record<Stat, string> = { str: 'STR', dex: 'DEX', int: 'INT', wis: 'WIS' };

const fmtBonus = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

function diceStr(x: Dice, extra = 0): string {
  const b = (x.bonus ?? 0) + extra;
  return `${x.n}d${x.d}${b > 0 ? `+${b}` : b < 0 ? `${b}` : ''}`;
}

const ELEMENT_EFFECT: Partial<Record<Element, string>> = {
  cold: 'Chills (half movement); a Wet or Chilled target freezes solid',
  lightning: 'Shocks (−2 AC); a Wet or Shocked target is stunned',
};
const FIELD_WORD: Partial<Record<Element, string>> = {
  fire: 'Ignites oil, blows up poison and turns water to steam',
  cold: 'Freezes water and puts out fire',
  lightning: 'Electrifies water and steam',
};
const GROUND_WORD: Record<GroundId, string> = { water: 'water', ice: 'ice', fire: 'fire', oil: 'oil', poison: 'poison', lava: 'lava' };
const CLOUD_WORD: Record<CloudId, string> = { steam: 'steam', smoke: 'smoke', gas: 'poison gas' };

const statusList = (list: StatusApply[]) =>
  list
    .map((x) => `${STATUSES[x.id].icon} ${STATUSES[x.id].name}${x.id === 'shielded' && x.power ? ` +${x.power} AC` : ''}${x.id === 'blessed' && x.power ? ' (+1d4 radiant on hits)' : ''}${x.id === 'hidden' && x.power ? ` (+${x.power}d6 on the attack from hiding)` : ''} ${x.turns} turn${x.turns === 1 ? '' : 's'}`)
    .join(', ');

/**
 * Rules text generated from the stats, so it always matches what the server does.
 * Pass the hero to show real numbers (damage bonus, DC, hits at their level).
 */
export function describe(s: SkillStats, hero?: Hero): string {
  const parts: string[] = [];
  const who = (() => {
    switch (s.target) {
      case 'enemy':
        return s.teleport ? `Teleport next to an enemy within ${s.range} tiles` : s.range <= 1 ? 'Melee' : `Range ${s.range}`;
      case 'area':
        return hitsArea(s)
          ? `Everyone within ${s.radius ?? 1} of a spot up to ${s.range} tiles away`
          : `A spot up to ${s.range} tiles away (radius ${s.radius ?? 1})`;
      case 'around':
        return (s.radius ?? 1) <= 1 ? 'Every enemy next to you' : `Every enemy within ${s.radius} tiles of you`;
      case 'ally':
        return s.range <= 1 ? 'You or an ally next to you' : `You or an ally within ${s.range} tiles`;
      case 'allies':
        return `You and every ally within ${s.radius ?? 1} tiles`;
      case 'self':
        return 'You';
    }
  })();
  const hits = hero ? hitsOf(hero, s) : (s.hits ?? 1);
  if (s.roll === 'contest') {
    const bonus = hero ? ` (${fmtBonus(attackBonus(hero, s))})` : '';
    parts.push(`${who}: ${STAT_WORD[s.stat ?? 'str']}${bonus} contest against its STR or DEX; win and it's knocked back ${s.push ?? 1} tile${(s.push ?? 1) > 1 ? 's' : ''}`);
  } else if (s.dmg) {
    const dmg = diceStr(s.dmg, hero ? damageMod(hero, s) : 0) + (s.mod && !hero ? ` + ${STAT_WORD[s.stat ?? 'str']}` : '') + ELEMENT_WORD[s.element ?? 'physical'];
    const times = hits > 1 ? `${hits}× ` : '';
    if (s.roll === 'save') {
      const dc = hero ? ` (DC ${heroDc(hero)})` : '';
      parts.push(`${who}: ${(s.save ?? 'dex').toUpperCase()} save${dc} or take ${times}${dmg}${s.half ? ', half on a save' : ''}`);
    } else if (s.roll === 'auto') {
      parts.push(`${who}: ${times}${dmg}, never misses`);
    } else {
      parts.push(`${who}: ${times}attack${s.adv ? ' with advantage' : ''}, ${dmg}`);
    }
    if (s.extraAttack && !(hero && hero.level >= 5)) parts.push('Attacks twice from level 5');
    if (s.sneak) parts.push(`+ Sneak Attack${hero ? ` (${sneakDice(hero.level)}d6)` : ''} once per turn if an ally is next to the target or you have advantage`);
    if (s.chain) parts.push(`Also hits ${s.chain === 1 ? 'another enemy' : `${s.chain} more enemies`} within 2 tiles of the target`);
    if (s.execute) parts.push(`+${diceStr(s.execute)} against targets below half HP`);
    if (s.critFull) parts.push('Always crits a target at full HP');
    if (s.falloff && (s.radius ?? 0) >= 2) parts.push('The outer ring of the blast takes half');
    if (s.per) parts.push(perText(s.per));
  } else if (s.target === 'enemy' || s.target === 'area' || s.target === 'around') {
    parts.push(who);
  }
  if (s.dmg && s.element && ELEMENT_EFFECT[s.element]) parts.push(ELEMENT_EFFECT[s.element]!);
  if (s.pull) parts.push(`First pulls enemies within ${s.pull} tiles next to you`);
  if (s.onHit?.length) parts.push(`${s.roll ? 'On a hit: ' : s.target === 'area' ? 'Everyone in it: ' : 'Target: '}${statusList(s.onHit)}`);
  if (s.push && s.roll !== 'contest') parts.push(`Knocks back ${s.push} tile${s.push > 1 ? 's' : ''}`);
  if (s.stealth) parts.push("Can't be used with an enemy next to you");
  if (s.surface) {
    const what = [s.surface.ground && GROUND_WORD[s.surface.ground], s.surface.cloud && `a ${CLOUD_WORD[s.surface.cloud]} cloud`].filter(Boolean).join(' and ');
    const r = s.surface.radius ?? (s.target === 'area' ? (s.radius ?? 1) : 0);
    const where = s.surface.at === 'self' ? (r ? `around you (radius ${r})` : 'where you stand') : s.target === 'area' ? (r === (s.radius ?? 1) ? 'over the area' : `in radius ${r}`) : r ? `around the target (radius ${r})` : "on the target's tile";
    const turns = s.surface.turns ? ` for ${s.surface.turns} rounds` : '';
    parts.push(`Leaves ${what} ${where}${turns}`);
  }
  if (s.element && FIELD_WORD[s.element] && (s.dmg || s.surface)) parts.push(FIELD_WORD[s.element]!);
  if (s.target === 'area' && (s.roll || s.onHit || s.push)) parts.push('⚠ Hits allies in the area too');
  if (s.heal) {
    const bonus = hero ? healBonus(hero, s) - (s.heal.bonus ?? 0) : 0;
    const extra = !hero ? `${s.healMod ? ' + WIS/STAT' : ''}${s.healLevel ? ' + level' : ''}` : '';
    const up = s.target === 'self' ? '' : s.noRevive ? ". Can't get the downed back up" : '. Gets the downed back up (Groggy: they lose their next turn)';
    parts.push(`${s.target === 'self' ? 'Heal' : `${who}: heal`} ${diceStr(s.heal, bonus)}${extra}${up}`);
  }
  if (s.poisonMult) parts.push(`${s.poisonMult === 2 ? 'Doubles' : s.poisonMult === 3 ? 'Triples' : `Multiplies by ${s.poisonMult}`} the Poison on the target`);
  if (s.doubleBlock) parts.push('Doubles the Block you gave yourself');
  if (s.rubble) parts.push(`Leaves rubble (low cover) on ${s.rubble} empty tiles of the area`);
  if (s.per && !s.dmg) parts.push(perText(s.per));
  if (s.helpUp) parts.push(`A downed ally next to you gets back up with ${Math.round(HELP_UP_HP * 100)}% of their max HP, Groggy: they lose their next turn`);
  const lvl = s.blockLevel ? (hero ? hero.level : 0) : 0;
  const lvlText = s.blockLevel && !hero ? ' + level' : '';
  if (s.block) parts.push(`${s.target === 'self' ? 'You get' : `${who}: get`} ${diceStr(s.block, lvl)}${lvlText} 🧱 Block until your next turn`);
  if (s.selfBlock) parts.push(`You get ${diceStr(s.selfBlock, lvl)}${lvlText} 🧱 Block until your next turn`);
  if (s.overheal) parts.push('Healing past max HP becomes temporary HP');
  if (s.cleanse) parts.push(`Removes ${CLEANSED.map((id) => STATUSES[id].name).join(', ').replace(/, ([^,]*)$/, ' and $1')}`);
  if (s.frees) parts.push(`${who}: cut free of a net or a web`);
  if (s.tempHp) parts.push(`+${diceStr(s.tempHp)} temporary HP`);
  if (s.status?.length) parts.push(`${s.heal || s.target === 'self' ? '' : `${who}: `}${statusList(s.status)}`);
  if (s.selfStatus?.length) parts.push(`You: ${statusList(s.selfStatus)}`);
  if (s.taunt) parts.push(`Taunts enemies within ${s.taunt.radius} tiles for ${s.taunt.turns} turn${s.taunt.turns > 1 ? 's' : ''}`);
  if (s.dash) parts.push(`+${s.dash} movement this turn`);
  if (s.gainAp) parts.push(`+${s.gainAp} AP this turn`);
  if (s.oncePerTurn) parts.push('Once per turn');
  if (s.hpCost) parts.push(`Costs ${s.hpCost}% of your max HP${hero ? ` (${hpCostOf(hero, s)})` : ''}`);
  if (s.healSelf) parts.push(`You heal ${s.healSelf === 0.5 ? 'half' : `${Math.round(s.healSelf * 100)}%`} of it too`);
  if (s.trap) parts.push(`Sets a hidden trap${(s.radius ?? 0) > 0 ? ` on every tile within ${s.radius}` : ''}: the first monster to step in ${s.trap.dmg ? `takes ${diceStr(s.trap.dmg)} and ` : ''}is ${statusList(s.trap.status)}`);
  if (s.resetCooldowns) parts.push('Your other cantrips are ready again');
  if (s.restoreSlots) parts.push(`Get ${s.restoreSlots} slot${s.restoreSlots > 1 ? 's' : ''} back (Spell slots, Grit or Cunning)`);
  if (s.note) parts.push(s.note);
  const cost = s.cooldown !== undefined ? `⏱ cooldown ${s.cooldown}` : s.slots !== undefined ? `🔮 ${s.slots} slot${s.slots > 1 ? 's' : ''}` : '';
  const action = s.ap ? `${s.ap} AP` : 'Free';
  const text = parts
    .filter(Boolean)
    .map((x) => x.replace(/\.$/, ''))
    .join('. ');
  return `${text}.\n${action}${cost ? ` · ${cost}` : ''}`;
}

const PER_WORD: Record<PerSource, string> = {
  poison: 'Poison on the target', radiance: 'Radiance on the target', debuffs: 'debuff on the target', focus: 'Focus you have', block: 'Block you have', verses: 'Verse you have',
};

/** "+1d8 per Focus you have, spending it", "+ your Block". */
function perText(p: PerBonus): string {
  if (p.of === 'block') return `+${p.flat && p.flat !== 1 ? ` ${p.flat}× ` : ' '}your Block in damage`.replace('+ ', '+ ');
  const each = p.dice ? `+${diceStr(p.dice)}` : `+${p.flat ?? 1}`;
  return `${each} per ${PER_WORD[p.of]}${p.spend ? ', spending it' : ''}`;
}

/** Rules text for a skill at a tier: generated for active skills, handwritten for passives. */
export function describeSkill(id: SkillId, tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B', hero?: Hero): string {
  const s = statsAt(id, tier, branch);
  if (SKILLS[id].kind === 'passive') return `${s.note ?? (s.perk ? describeStats(s.perk) : '')}\nPassive · always on`;
  const text = describe(s, hero);
  return SKILLS[id].kind === 'item' && id !== 'potion' ? text.replace(/\n(.*)$/, '\n$1 · used up') : text;
}

/** Name, icon, rarity and rules text of any item: equipment from its stats, consumables from their skill. */
export function itemInfo(id: ItemId): { name: string; icon: string; desc: string; rarity: Rarity; slot?: Slot } {
  const def = ITEMS[id];
  const g = gearDef(id);
  if (g) return { name: g.name, icon: g.icon, desc: [describeStats(g.stats), g.note].filter(Boolean).join(' '), rarity: g.rarity, slot: g.slot };
  const skill = id as SkillId;
  return { name: SKILLS[skill].base.name, icon: SKILLS[skill].base.icon, desc: describeSkill(skill), rarity: def.rarity };
}

// ---------------------------------------------------------------- can I use it?

/** Why a hero can't use a skill right now, or null if they can. The server and the client both use this. */
export function skillBlockReason(p: PlayerEntity, id: SkillId, inCombat: boolean, turn: { ap: number } | null, isMyTurn: boolean): string | null {
  const def = SKILLS[id];
  if (!def) return 'Unknown skill';
  if (def.kind === 'passive') return 'Passive: always on';
  if (def.kind === 'item' && id !== 'potion' && !(p.bag as string[]).includes(id)) return 'None left';
  const own = ownedSkill(p, id);
  if (!own) return "You don't know that skill";
  const s = statsOf(own);
  if (p.dead || p.downed) return 'You are down!';
  if (inCombat) {
    if (!isMyTurn || !turn) return 'Not your turn';
    if (hasStatus(p, 'stunned')) return 'You are stunned';
    if (hasStatus(p, 'frozen')) return 'You are frozen solid';
    const ap = apOf(p, id, s);
    if (ap > turn.ap) return `Needs ${ap} AP (${turn.ap} left)`;
    if (s.oncePerTurn && p.used.includes(`turn:${id}`)) return 'Only once per turn';
    if (own.cd > 0) return `Ready in ${own.cd} turn${own.cd > 1 ? 's' : ''}`;
    if (s.hpCost && p.hp <= hpCostOf(p, s)) return 'Not enough HP to pay for it';
  } else if (!s.heal && !s.restoreSlots) {
    return 'Only in combat';
  } else if (def.kind === 'cantrip') {
    return 'Cantrips only work in combat';
  }
  if (def.kind === 'spell' && p.slots < slotCost(s)) return `Not enough ${CLASSES[p.classId].names.slots}. A Long Rest restores them.`;
  if (id === 'potion' && p.potions <= 0) return 'No potions left';
  return null;
}

// ---------------------------------------------------------------- who does it hit?

export interface AimCtx {
  map: MapLike & { props?: PropMap };
  entities: Entity[];
  inCombat: boolean;
}

export interface AimResult {
  center: Pos; // where it lands (the target, the area's center, or you)
  main?: Entity; // the creature aimed at, if any
  foes: MonsterEntity[];
  friends: PlayerEntity[]; // heals and buffs
  caught?: Entity[]; // heroes and NPC allies caught in an area attack (friendly fire)
  prop?: number; // tile index of an oil barrel or brazier that's being hit
}

/** Skills that can smash a prop (oil barrel, brazier): attacks, saves and auto-hits at one target, but no teleports. */
export const canHitProps = (s: SkillStats) => s.target === 'enemy' && !!s.roll && s.roll !== 'contest' && !s.teleport;

/** Does an area skill hit whoever is in the blast (friendly fire), or only create a surface? */
export const hitsArea = (s: SkillStats) => s.target === 'area' && !!(s.roll || s.onHit?.length || s.push);

/** Every enemy within `radius` of `center` (NPC allies aren't enemies). */
function foesNear(ctx: AimCtx, center: Pos, radius: number): MonsterEntity[] {
  return ctx.entities.filter((e): e is MonsterEntity => isFoe(e) && dist(e, center) <= radius);
}

/**
 * What a skill would affect if aimed at `aim` (an entity id, a tile, or nothing for self/around/allies).
 * Returns an error message when the aim isn't valid. Range and line of sight only matter in a fight.
 */
export function resolveAim(s: SkillStats, caster: PlayerEntity, aim: string | Pos | null | undefined, ctx: AimCtx): AimResult | string {
  const byId = typeof aim === 'string' ? ctx.entities.find((e) => e.id === aim) : undefined;
  const inRange = (to: Pos) => dist(caster, to) <= s.range && (s.range <= 1 || hasLOS(ctx.map, caster, to));
  const outOfRange = () => (dist(caster, byId ?? caster) > s.range ? `Out of range (${s.name} reaches ${s.range} tile${s.range === 1 ? '' : 's'}).` : 'No line of sight.');
  switch (s.target) {
    case 'self':
      if (s.stealth && ctx.inCombat && ctx.entities.some((e) => isFoe(e) && dist(e, caster) <= 1)) return "You can't hide with an enemy next to you.";
      return { center: caster, friends: [caster], foes: [] };
    case 'enemy': {
      if (!byId && aim && typeof aim === 'object' && canHitProps(s)) {
        // Aimed at an oil barrel or a brazier.
        const i = aim.y * ctx.map.width + aim.x;
        if (Number.isInteger(aim.x) && Number.isInteger(aim.y) && ctx.map.props?.[i]) {
          if (!ctx.inCombat) return 'Only in combat';
          if (!inRange(aim)) return dist(caster, aim) > s.range ? `Out of range (${s.name} reaches ${s.range} tile${s.range === 1 ? '' : 's'}).` : 'No line of sight.';
          return { center: { x: aim.x, y: aim.y }, foes: [], friends: [], prop: i };
        }
      }
      if (!byId) return 'Pick a target.';
      if (isAllyNpc(byId)) return `${byId.name} is on your side.`;
      if (!isFoe(byId)) return 'Pick an enemy.';
      if (!ctx.inCombat) return 'Only in combat';
      if (!inRange(byId)) return outOfRange();
      if (s.poisonMult && !hasStatus(byId, 'poisoned')) return `${byId.name} isn't Poisoned.`;
      const extra = s.chain
        ? ctx.entities
            .filter((e): e is MonsterEntity => isFoe(e) && e !== byId && dist(e, byId) <= 2)
            .sort((a, b) => dist(a, byId) - dist(b, byId) || a.hp - b.hp)
            .slice(0, s.chain)
        : [];
      return { center: byId, main: byId, foes: [byId, ...extra], friends: [] };
    }
    case 'ally': {
      if (!byId) return 'Pick an ally (or yourself).';
      if (byId.kind !== 'player' || byId.dead) return 'Pick an ally (or yourself).';
      if (s.helpUp && (byId.id === caster.id || !byId.downed)) return byId.id === caster.id ? 'Pick a downed ally next to you.' : `${byId.name} isn't down.`;
      if (ctx.inCombat && !inRange(byId)) return outOfRange();
      if (s.noRevive && byId.downed) return `A cantrip can't get ${byId.name} back up: Help Up (2 AP) or a healing spell can.`;
      if (s.frees && !ROOTED.some((id) => hasStatus(byId, id))) return `${byId.id === caster.id ? "You aren't" : `${byId.name} isn't`} stuck.`;
      return { center: byId, main: byId, foes: [], friends: [byId] };
    }
    case 'area': {
      const center = byId ? { x: byId.x, y: byId.y } : aim && typeof aim === 'object' ? { x: aim.x, y: aim.y } : null;
      if (!center || !Number.isInteger(center.x) || !Number.isInteger(center.y)) return 'Pick a spot.';
      if (center.x < 0 || center.y < 0 || center.x >= ctx.map.width || center.y >= ctx.map.height) return 'Pick a spot in the room.';
      if (ctx.map.tiles[center.y * ctx.map.width + center.x] === '#' && !ctx.map.props?.[center.y * ctx.map.width + center.x]) return 'Pick an open spot.';
      if (!ctx.inCombat) return 'Only in combat';
      if (!inRange(center)) return dist(caster, center) > s.range ? `Out of range (${s.name} reaches ${s.range} tiles).` : 'No line of sight.';
      if (s.trap && ctx.entities.some((e) => e.x === center.x && e.y === center.y && !(e.kind === 'player' && e.dead))) return 'Pick an empty spot.';
      if (s.trap && ctx.map.tiles[center.y * ctx.map.width + center.x] !== '.') return 'Pick an open spot.';
      // Sculpt Spells: an Evoker's blasts go around friends (and NPC allies, with Careful Weave).
      const sculpt = caster.kind === 'player' && caster.skills ? passiveOf(caster, 'sculpt_spells') : null;
      const spared = (e: Entity) => !!sculpt && (e.kind === 'player' || hasBranch(caster as PlayerEntity, 'sculpt_spells', 'B'));
      const caught = hitsArea(s)
        ? ctx.entities.filter((e) => (e.kind === 'player' ? !e.dead && !e.downed : !!e.ally) && dist(e, center) <= (s.radius ?? 1) && !spared(e))
        : [];
      return { center, main: byId, foes: foesNear(ctx, center, s.radius ?? 1), friends: [], caught };
    }
    case 'around': {
      if (!ctx.inCombat) return 'Only in combat';
      return { center: caster, foes: foesNear(ctx, caster, Math.max(s.radius ?? 1, s.pull ?? 0)), friends: [] };
    }
    case 'allies': {
      const friends = ctx.entities.filter(
        (e): e is PlayerEntity => e.kind === 'player' && !e.dead && (!ctx.inCombat || dist(e, caster) <= (s.radius ?? 1)),
      );
      return { center: caster, foes: [], friends };
    }
  }
}

// ---------------------------------------------------------------- limits and upgrades (shared by the server and the UI)

export const COUNTED_KINDS: SkillKind[] = ['cantrip', 'spell', 'passive'];

/** How many skills of a kind a hero may hold at once. */
export function limitFor(p: PlayerEntity, kind: SkillKind): number {
  if (kind === 'cantrip') return MAX_CANTRIPS;
  if (kind === 'spell') return MAX_SPELLS;
  if (kind === 'passive') return passiveSlots(p.level);
  return Infinity;
}

export const countKind = (p: PlayerEntity, kind: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === kind && !isSignature(p, s.id)).length;

/** The subclass's signature skill: learned with the subclass, takes no slot, and can't be forgotten. */
export const isSignature = (p: Pick<PlayerEntity, 'subclass'>, id: SkillId): boolean => !!p.subclass && SUBCLASSES[p.subclass]?.signature === id;

/** HP a skill's price costs this hero (Blood Price). */
export const hpCostOf = (p: { maxHp?: number }, s: SkillStats): number => (s.hpCost && p.maxHp ? Math.max(1, Math.round((p.maxHp * s.hpCost) / 100)) : 0);

/** The upgrade a skill would get next, if it can be upgraded now. */
export function nextTier(p: PlayerEntity, id: SkillId): 2 | 3 | null {
  const o = p.skills.find((s) => s.id === id);
  if (!o || !SKILLS[id].t2) return null;
  if (o.tier === 1) return 2;
  if (o.tier === 2 && p.level >= TIER3_LEVEL) return 3;
  return null;
}

/** Cantrips and spells that Train could upgrade right now. */
export function trainOptions(p: PlayerEntity): { skill: SkillId; tier: 2 | 3 }[] {
  const out: { skill: SkillId; tier: 2 | 3 }[] = [];
  for (const s of p.skills) {
    const kind = SKILLS[s.id].kind;
    if (kind !== 'cantrip' && kind !== 'spell') continue;
    const tier = nextTier(p, s.id);
    if (tier) out.push({ skill: s.id, tier });
  }
  return out;
}
