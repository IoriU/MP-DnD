// Skills: basic attacks, cantrips (cooldowns), spells (slots) and passives, each with tiers I → II → III-A / III-B.
// Content is data. The server executes active skills generically from their stats (see SkillStats), the client
// describes them from the same stats, and the auto-play AI scores them from the same stats.
// Passives are hooks in the server, keyed by skill id; their numbers live in `value` per tier.

import { dist, hasLOS, type MapLike } from './grid.ts';
import { CLASSES, MAX_CANTRIPS, MAX_SPELLS, TIER3_LEVEL, passiveSlots, profBonus, saveDc, sneakDice, statMod, type Dice, type Stat } from './rules.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, Pos, TurnState } from './types.ts';

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
  | 'riposte';

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
};

export interface StatusApply {
  id: StatusId;
  turns: number;
  power?: number;
}

// ---------------------------------------------------------------- skill schema

export type SkillKind = 'basic' | 'cantrip' | 'spell' | 'passive' | 'item';
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
 *  1. pay: action/bonus (or nothing for 'free'), slots, cooldown
 *  2. teleport (step next to the main target, on the far side if free), pull (enemies within `pull` tiles are
 *     dragged next to you)
 *  3. for each foe: `hits` times roll (attack roll vs AC / save vs your DC / auto-hit), deal `dmg` (+ stat mod if
 *     `mod`, + Sneak Attack once per turn if `sneak` and an ally is next to the target or you have advantage,
 *     + `execute` if the target is below half HP), then on a hit or failed save apply `onHit` and `push`
 *  4. for each friend: heal, temp HP, cleanse, `status`
 *  5. on you: `selfStatus`, `taunt` (enemies within radius), `dash`, `refresh`, `resetCooldowns`
 */
export interface SkillStats {
  name: string;
  icon: string;
  cost: 'action' | 'bonus' | 'free';
  target: TargetMode;
  range: number; // tiles; diagonals count as 1
  radius?: number; // area / around / allies
  cooldown?: number; // cantrips: unusable for this many of your turns after use
  slots?: number; // spells: slot cost (default 1)
  stat?: Stat; // to-hit and damage stat; defaults to the class's casting stat
  // offense
  roll?: 'attack' | 'save' | 'auto';
  save?: 'dex' | 'str' | 'wis';
  half?: boolean; // a successful save still takes half damage
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
  // support
  heal?: Dice;
  healMod?: boolean; // + casting stat modifier
  healLevel?: boolean; // + hero level
  overheal?: boolean; // healing past max HP becomes temporary HP
  cleanse?: boolean; // removes Burning, Poisoned, Dazed and Blinded
  tempHp?: Dice;
  status?: StatusApply[]; // on each friend affected
  // you
  selfStatus?: StatusApply[];
  taunt?: { radius: number; turns: number };
  dash?: number; // extra movement this turn
  refresh?: boolean; // get your action back
  resetCooldowns?: boolean; // every other cantrip is ready again
  // passives
  value?: number; // the tier's number, read by the server hook
  note?: string; // rules text the generated description can't express
}

export interface SkillDef {
  kind: SkillKind;
  pool: ClassId | 'common';
  base: SkillStats; // tier I
  t2?: Partial<SkillStats>; // tier II, on top of tier I (no t2 = can't be upgraded)
  a?: Partial<SkillStats> & { name: string }; // tier III-A, on top of tier II
  b?: Partial<SkillStats> & { name: string }; // tier III-B, on top of tier II
}

const d = (n: number, sides: number, bonus?: number): Dice => (bonus ? { n, d: sides, bonus } : { n, d: sides });
const st = (id: StatusId, turns: number, power?: number): StatusApply => (power ? { id, turns, power } : { id, turns });

type PassiveTier = { value?: number; note: string };
/** Passives only carry text and a number per tier; the server implements the behavior. */
function passive(
  pool: SkillDef['pool'], icon: string, name: string,
  t1: PassiveTier, t2: PassiveTier, a: PassiveTier & { name: string }, b: PassiveTier & { name: string },
): SkillDef {
  return { kind: 'passive', pool, base: { name, icon, cost: 'free', target: 'self', range: 0, ...t1 }, t2, a, b };
}

// ---------------------------------------------------------------- content

const SKILL_DEFS = {
  // ---------------------------------------------- basic attacks (free, no tiers)
  longsword: { kind: 'basic', pool: 'fighter', base: { name: 'Longsword', icon: '⚔️', cost: 'action', target: 'enemy', range: 1, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true, extraAttack: true } },
  rapier: { kind: 'basic', pool: 'rogue', base: { name: 'Rapier', icon: '🗡️', cost: 'action', target: 'enemy', range: 1, stat: 'dex', roll: 'attack', dmg: d(1, 8), mod: true, sneak: true } },
  shortbow: { kind: 'basic', pool: 'rogue', base: { name: 'Shortbow', icon: '🏹', cost: 'action', target: 'enemy', range: 8, stat: 'dex', roll: 'attack', dmg: d(1, 6), mod: true, sneak: true } },
  dagger: { kind: 'basic', pool: 'wizard', base: { name: 'Dagger', icon: '🔪', cost: 'action', target: 'enemy', range: 4, stat: 'dex', roll: 'attack', dmg: d(1, 4), mod: true, note: 'Stab, or throw it up to 4 tiles.' } },
  mace: { kind: 'basic', pool: 'cleric', base: { name: 'Mace', icon: '🔨', cost: 'action', target: 'enemy', range: 1, stat: 'str', roll: 'attack', dmg: d(1, 6), mod: true } },
  potion: { kind: 'item', pool: 'common', base: { name: 'Potion', icon: '🧪', cost: 'bonus', target: 'ally', range: 1, heal: d(2, 4, 2), note: 'Drink it, or feed it to an ally next to you.' } },

  // ---------------------------------------------- Fighter
  shield_bash: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Shield Bash', icon: '🛡️', cost: 'bonus', target: 'enemy', range: 1, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(1, 4), mod: true, push: 1, onHit: [st('dazed', 1)] },
    t2: { dmg: d(1, 6), push: 2 },
    a: { name: 'Concussive Bash', onHit: [st('stunned', 1)] },
    b: { name: 'Bulwark Bash', taunt: { radius: 2, turns: 1 }, selfStatus: [st('shielded', 1, 2)] },
  },
  heavy_strike: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Heavy Strike', icon: '🪓', cost: 'action', target: 'enemy', range: 1, cooldown: 2, stat: 'str', roll: 'attack', dmg: d(2, 8), mod: true },
    t2: { dmg: d(3, 8) },
    a: { name: 'Sunder', onHit: [st('marked', 2)] },
    b: { name: 'Execute', execute: d(2, 8) },
  },
  battle_cry: {
    kind: 'cantrip', pool: 'fighter',
    base: { name: 'Battle Cry', icon: '📯', cost: 'bonus', target: 'self', range: 0, cooldown: 3, taunt: { radius: 2, turns: 1 }, selfStatus: [st('shielded', 1, 2)] },
    t2: { taunt: { radius: 3, turns: 2 } },
    a: { name: 'Rallying Cry', target: 'allies', radius: 3, heal: d(1, 6), healLevel: true },
    b: { name: 'Iron Wall', selfStatus: [st('shielded', 2, 4)] },
  },
  second_wind: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Second Wind', icon: '💨', cost: 'bonus', target: 'self', range: 0, slots: 1, heal: d(1, 10), healLevel: true },
    t2: { heal: d(2, 10) },
    a: { name: 'Adrenaline Rush', dash: 3, selfStatus: [st('focused', 1)] },
    b: { name: 'Rally', target: 'allies', radius: 2 },
  },
  whirlwind: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Whirlwind', icon: '🌀', cost: 'action', target: 'around', radius: 1, range: 0, slots: 1, stat: 'str', roll: 'attack', dmg: d(1, 8), mod: true },
    t2: { dmg: d(2, 8) },
    a: { name: 'Cyclone', pull: 3 },
    b: { name: 'Bladestorm', hits: 2 },
  },
  action_surge: {
    kind: 'spell', pool: 'fighter',
    base: { name: 'Action Surge', icon: '⚡', cost: 'bonus', target: 'self', range: 0, slots: 1, refresh: true, note: 'Once per turn.' },
    t2: { dash: 3 },
    a: { name: 'Battle Surge', cost: 'free' },
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
    base: { name: 'Cunning Dash', icon: '👟', cost: 'bonus', target: 'self', range: 0, cooldown: 2, dash: 6 },
    t2: { cooldown: 1 },
    a: { name: 'Blur', selfStatus: [st('shielded', 1, 2)] },
    b: { name: 'Hit and Run', selfStatus: [st('focused', 1)] },
  },
  feint: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Feint', icon: '🎭', cost: 'bonus', target: 'enemy', range: 1, cooldown: 3, selfStatus: [st('focused', 1)], note: 'No roll: it always works.' },
    t2: { cooldown: 2, range: 4 },
    a: { name: 'Mark for Death', selfStatus: undefined, onHit: [st('marked', 2)] },
    b: { name: 'Riposte', selfStatus: [st('focused', 1), st('riposte', 1)] },
  },
  throwing_knives: {
    kind: 'cantrip', pool: 'rogue',
    base: { name: 'Throwing Knives', icon: '🔪', cost: 'action', target: 'enemy', range: 5, cooldown: 2, stat: 'dex', roll: 'attack', dmg: d(1, 4), mod: true, hits: 2 },
    t2: { hits: 3 },
    a: { name: 'Fan of Knives', target: 'area', radius: 1, hits: 2 },
    b: { name: 'Poisoned Knives', onHit: [st('poisoned', 2)] },
  },
  shadow_step: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Shadow Step', icon: '🌑', cost: 'action', target: 'enemy', range: 6, slots: 1, teleport: true, stat: 'dex', roll: 'attack', adv: true, dmg: d(1, 8), mod: true, sneak: true },
    t2: { range: 9, dmg: d(2, 8) },
    a: { name: 'Assassinate', critFull: true },
    b: { name: 'Vanish', selfStatus: [st('shielded', 1, 4)], dash: 3 },
  },
  cheap_shot: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Cheap Shot', icon: '👊', cost: 'action', target: 'enemy', range: 1, slots: 1, stat: 'dex', roll: 'attack', adv: true, dmg: d(1, 8), mod: true, sneak: true, onHit: [st('stunned', 1)] },
    t2: { dmg: d(2, 8) },
    a: { name: 'Knockout', onHit: [st('stunned', 2)] },
    b: { name: 'Crippling Shot', onHit: [st('stunned', 1), st('poisoned', 3)] },
  },
  hail_of_arrows: {
    kind: 'spell', pool: 'rogue',
    base: { name: 'Hail of Arrows', icon: '🎯', cost: 'action', target: 'area', range: 8, radius: 1, slots: 1, stat: 'dex', roll: 'attack', dmg: d(1, 6), mod: true },
    t2: { dmg: d(2, 6) },
    a: { name: 'Volley', radius: 2 },
    b: { name: 'Poison Rain', onHit: [st('poisoned', 2)] },
  },
  opportunist: passive('rogue', '🦊', 'Opportunist',
    { value: 2, note: '+2 damage against targets below half HP.' },
    { value: 4, note: '+4 damage against targets below half HP.' },
    { name: 'Executioner', value: 4, note: '+4 damage against targets below half HP. Once per turn, a killing blow gives you your action back.' },
    { name: 'Evasion', value: 4, note: '+4 damage against targets below half HP. Area attacks (like breath) deal half damage to you, none on a successful save.' }),
  slippery: passive('rogue', '🐍', 'Slippery',
    { value: 1, note: '+1 movement.' },
    { value: 2, note: '+2 movement.' },
    { name: 'Uncanny Dodge', value: 2, note: '+2 movement. Once per round, halve the damage of a hit.' },
    { name: 'Shadow', value: 2, note: '+2 movement. Start every fight Focused (your first attack has advantage).' }),

  // ---------------------------------------------- Wizard
  fire_bolt: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Fire Bolt', icon: '🔥', cost: 'action', target: 'enemy', range: 8, cooldown: 1, roll: 'attack', dmg: d(1, 10), element: 'fire' },
    t2: { dmg: d(2, 10) },
    a: { name: 'Inferno', onHit: [st('burning', 2)] },
    b: { name: 'Splitting Bolt', chain: 1 },
  },
  ray_of_frost: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Ray of Frost', icon: '❄️', cost: 'action', target: 'enemy', range: 6, cooldown: 2, roll: 'attack', dmg: d(1, 8), element: 'cold', onHit: [st('dazed', 1)] },
    t2: { dmg: d(2, 8) },
    a: { name: 'Deep Freeze', onHit: [st('stunned', 1)] },
    b: { name: 'Glacial Ray', range: 8, push: 1, onHit: [st('dazed', 2)] },
  },
  shocking_grasp: {
    kind: 'cantrip', pool: 'wizard',
    base: { name: 'Shocking Grasp', icon: '⚡', cost: 'action', target: 'enemy', range: 1, cooldown: 2, roll: 'attack', adv: true, dmg: d(1, 8), element: 'lightning', push: 2 },
    t2: { dmg: d(2, 8) },
    a: { name: 'Thunderclap', target: 'around', radius: 1 },
    b: { name: 'Chain Lightning', chain: 2 },
  },
  magic_missile: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Magic Missile', icon: '🌟', cost: 'action', target: 'enemy', range: 8, slots: 1, roll: 'auto', dmg: d(1, 4, 1), hits: 3, element: 'force' },
    t2: { hits: 4 },
    a: { name: 'Missile Barrage', hits: 6 },
    b: { name: 'Mind Spike', onHit: [st('dazed', 1)] },
  },
  fireball: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Fireball', icon: '☄️', cost: 'action', target: 'area', range: 8, radius: 1, slots: 1, roll: 'save', save: 'dex', half: true, dmg: d(3, 6), element: 'fire' },
    t2: { dmg: d(4, 6), radius: 2 },
    a: { name: 'Meteor', dmg: d(6, 6), slots: 2 },
    b: { name: 'Concussive Blast', push: 1, onHit: [st('dazed', 1)] },
  },
  shield: {
    kind: 'spell', pool: 'wizard',
    base: { name: 'Shield', icon: '🔰', cost: 'bonus', target: 'self', range: 0, slots: 1, status: [st('shielded', 1, 4)] },
    t2: { status: [st('shielded', 2, 4)] },
    a: { name: 'Warding Flare', target: 'allies', radius: 2 },
    b: { name: 'Arcane Armor', status: [st('shielded', 3, 4)], tempHp: d(2, 6) },
  },
  elemental_affinity: passive('wizard', '🌋', 'Elemental Affinity',
    { value: 1, note: '+1 damage on every fire hit.' },
    { value: 2, note: '+2 damage on every fire hit.' },
    { name: 'Overload', value: 2, note: '+2 fire damage, and your fire hits set the target Burning for 2 turns.' },
    { name: 'Attunement', value: 2, note: '+2 fire damage. You take half damage from fire and can\'t be set Burning.' }),
  arcane_ward: passive('wizard', '🔮', 'Arcane Ward',
    { value: 5, note: 'Start every fight with 5 temporary HP.' },
    { value: 10, note: 'Start every fight with 10 temporary HP.' },
    { name: 'Spell Shield', value: 10, note: 'Start every fight with 10 temporary HP. +2 AC while any of it is left.' },
    { name: 'Recharging Ward', value: 10, note: 'Start every fight with 10 temporary HP, and regain 3 (up to 10) at the start of each of your turns.' }),

  // ---------------------------------------------- Cleric
  sacred_flame: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Sacred Flame', icon: '☀️', cost: 'action', target: 'enemy', range: 6, cooldown: 1, roll: 'save', save: 'dex', dmg: d(1, 8), element: 'radiant' },
    t2: { dmg: d(2, 8) },
    a: { name: 'Searing Flame', onHit: [st('blinded', 1)] },
    b: { name: 'Radiant Flame', target: 'area', radius: 1 },
  },
  word_of_radiance: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Word of Radiance', icon: '🌞', cost: 'action', target: 'around', radius: 1, range: 0, cooldown: 2, roll: 'save', save: 'str', dmg: d(1, 6), element: 'radiant' },
    t2: { dmg: d(2, 6) },
    a: { name: 'Blinding Word', onHit: [st('blinded', 1)] },
    b: { name: 'Wide Radiance', radius: 2 },
  },
  healing_touch: {
    kind: 'cantrip', pool: 'cleric',
    base: { name: 'Healing Touch', icon: '🤲', cost: 'bonus', target: 'ally', range: 1, cooldown: 3, heal: d(1, 4), healMod: true },
    t2: { range: 3 },
    a: { name: 'Lay on Hands', heal: d(2, 4), cleanse: true },
    b: { name: 'Sanctuary', status: [st('shielded', 1, 2)] },
  },
  healing_word: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Healing Word', icon: '💖', cost: 'bonus', target: 'ally', range: 6, slots: 1, heal: d(1, 4), healMod: true },
    t2: { heal: d(2, 4) },
    a: { name: 'Mass Healing Word', target: 'allies', radius: 6 },
    b: { name: 'Second Chance', overheal: true },
  },
  bless: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Bless', icon: '🙏', cost: 'action', target: 'allies', radius: 3, range: 0, slots: 1, status: [st('blessed', 3)] },
    t2: { radius: 4, status: [st('blessed', 4)] },
    a: { name: 'Holy Aura', status: [st('blessed', 4), st('shielded', 4, 1)] },
    b: { name: 'Divine Favor', status: [st('blessed', 4, 1)] },
  },
  guiding_bolt: {
    kind: 'spell', pool: 'cleric',
    base: { name: 'Guiding Bolt', icon: '✴️', cost: 'action', target: 'enemy', range: 8, slots: 1, roll: 'attack', dmg: d(4, 6), element: 'radiant', onHit: [st('marked', 1)] },
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
    { value: 3, note: '+3 initiative.' },
    { value: 5, note: '+5 initiative.' },
    { name: 'Quickstep', value: 5, note: '+5 initiative and +1 movement.' },
    { name: 'First Strike', value: 5, note: '+5 initiative, and start every fight Focused (your first attack has advantage).' }),
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
} satisfies Record<string, SkillDef>;

export type SkillId = keyof typeof SKILL_DEFS;
export const SKILLS: Record<SkillId, SkillDef> = SKILL_DEFS;
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

export const isSkillId = (id: unknown): id is SkillId => typeof id === 'string' && Object.hasOwn(SKILLS, id);
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

/** The hero's copy of a skill. The potion is something everyone carries. */
export function ownedSkill(p: PlayerEntity, id: SkillId): OwnedSkill | undefined {
  if (id === 'potion') return { id, tier: 1, cd: 0 };
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

/** Usable skills in hotbar order: basic attacks, cantrips, spells, then the potion. Keys 1-9 follow this order. */
export function hotbar(p: PlayerEntity): SkillId[] {
  const of = (k: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === k).map((s) => s.id);
  return [...of('basic'), ...of('cantrip'), ...of('spell'), 'potion'];
}

export const skillsOfKind = (p: PlayerEntity, kind: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === kind);
export const slotCost = (s: SkillStats) => s.slots ?? 1;
export const hasStatus = (e: Entity, id: StatusId) => e.statuses.some((x) => x.id === id);

// ---------------------------------------------------------------- numbers for a hero

export const statFor = (p: Pick<PlayerEntity, 'classId'>, s: SkillStats): Stat => s.stat ?? CLASSES[p.classId].stat;
/** Attack bonus with a skill: proficiency + its stat. */
export const attackBonus = (p: Pick<PlayerEntity, 'classId' | 'level'>, s: SkillStats) => profBonus(p.level) + statMod(p.classId, statFor(p, s));
/** Flat damage bonus with a skill (its stat modifier, if `mod`). */
export const damageMod = (p: Pick<PlayerEntity, 'classId'>, s: SkillStats) => (s.mod ? statMod(p.classId, statFor(p, s)) : 0);
/** Flat bonus on a heal. */
export const healBonus = (p: Pick<PlayerEntity, 'classId' | 'level'>, s: SkillStats) =>
  (s.heal?.bonus ?? 0) + (s.healMod ? statMod(p.classId, CLASSES[p.classId].stat) : 0) + (s.healLevel ? p.level : 0);
/** Attacks (or darts) per target. */
export const hitsOf = (p: Pick<PlayerEntity, 'level'>, s: SkillStats) => (s.hits ?? 1) + (s.extraAttack && p.level >= 5 ? 1 : 0);

const avgDice = (x: Dice) => (x.n * (x.d + 1)) / 2 + (x.bonus ?? 0);
export { avgDice };

// ---------------------------------------------------------------- descriptions

const ELEMENT_WORD: Record<Element, string> = {
  physical: '', fire: ' fire', cold: ' cold', lightning: ' lightning', poison: ' poison', radiant: ' radiant', force: ' force',
};
const STAT_WORD: Record<Stat, string> = { str: 'STR', dex: 'DEX', int: 'INT', wis: 'WIS' };

function diceStr(x: Dice, extra = 0): string {
  const b = (x.bonus ?? 0) + extra;
  return `${x.n}d${x.d}${b > 0 ? `+${b}` : b < 0 ? `${b}` : ''}`;
}

const statusList = (list: StatusApply[]) =>
  list
    .map((x) => `${STATUSES[x.id].icon} ${STATUSES[x.id].name}${x.id === 'shielded' && x.power ? ` +${x.power} AC` : ''}${x.id === 'blessed' && x.power ? ' (+1d4 radiant on hits)' : ''} ${x.turns} turn${x.turns === 1 ? '' : 's'}`)
    .join(', ');

/**
 * Rules text generated from the stats, so it always matches what the server does.
 * Pass the hero to show real numbers (damage bonus, DC, hits at their level).
 */
export function describe(s: SkillStats, hero?: Pick<PlayerEntity, 'classId' | 'level'>): string {
  const parts: string[] = [];
  const who = (() => {
    switch (s.target) {
      case 'enemy':
        return s.teleport ? `Teleport next to an enemy within ${s.range} tiles` : s.range <= 1 ? 'Melee' : `Range ${s.range}`;
      case 'area':
        return `Every enemy within ${s.radius ?? 1} of a spot up to ${s.range} tiles away`;
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
  if (s.dmg) {
    const dmg = diceStr(s.dmg, hero ? damageMod(hero, s) : 0) + (s.mod && !hero ? ` + ${STAT_WORD[s.stat ?? 'str']}` : '') + ELEMENT_WORD[s.element ?? 'physical'];
    const times = hits > 1 ? `${hits}× ` : '';
    if (s.roll === 'save') {
      const dc = hero ? ` (DC ${saveDc(hero.classId, hero.level)})` : '';
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
  } else if (s.target === 'enemy' || s.target === 'area' || s.target === 'around') {
    parts.push(who);
  }
  if (s.pull) parts.push(`First pulls enemies within ${s.pull} tiles next to you`);
  if (s.onHit?.length) parts.push(`${s.roll ? 'On a hit: ' : 'Target: '}${statusList(s.onHit)}`);
  if (s.push) parts.push(`Knocks back ${s.push} tile${s.push > 1 ? 's' : ''}`);
  if (s.heal) {
    const bonus = hero ? healBonus(hero, s) - (s.heal.bonus ?? 0) : 0;
    const extra = !hero ? `${s.healMod ? ' + WIS/STAT' : ''}${s.healLevel ? ' + level' : ''}` : '';
    parts.push(`${s.target === 'self' ? 'Heal' : `${who}: heal`} ${diceStr(s.heal, bonus)}${extra}. Gets the downed back up`);
  }
  if (s.overheal) parts.push('Healing past max HP becomes temporary HP');
  if (s.cleanse) parts.push('Removes Burning, Poisoned, Dazed and Blinded');
  if (s.tempHp) parts.push(`+${diceStr(s.tempHp)} temporary HP`);
  if (s.status?.length) parts.push(`${s.heal || s.target === 'self' ? '' : `${who}: `}${statusList(s.status)}`);
  if (s.selfStatus?.length) parts.push(`You: ${statusList(s.selfStatus)}`);
  if (s.taunt) parts.push(`Taunts enemies within ${s.taunt.radius} tiles for ${s.taunt.turns} turn${s.taunt.turns > 1 ? 's' : ''}`);
  if (s.dash) parts.push(`+${s.dash} movement this turn`);
  if (s.refresh) parts.push('Get your action back');
  if (s.resetCooldowns) parts.push('Your other cantrips are ready again');
  if (s.note) parts.push(s.note);
  const cost = s.cooldown !== undefined ? `⏱ cooldown ${s.cooldown}` : s.slots !== undefined ? `🔮 ${s.slots} slot${s.slots > 1 ? 's' : ''}` : '';
  const action = s.cost === 'action' ? 'Action' : s.cost === 'bonus' ? 'Bonus action' : 'Free';
  const text = parts
    .filter(Boolean)
    .map((x) => x.replace(/\.$/, ''))
    .join('. ');
  return `${text}.\n${action}${cost ? ` · ${cost}` : ''}`;
}

/** Rules text for a skill at a tier: generated for active skills, handwritten for passives. */
export function describeSkill(id: SkillId, tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B', hero?: Pick<PlayerEntity, 'classId' | 'level'>): string {
  const s = statsAt(id, tier, branch);
  if (SKILLS[id].kind === 'passive') return `${s.note ?? ''}\nPassive · always on`;
  return describe(s, hero);
}

// ---------------------------------------------------------------- can I use it?

/** Why a hero can't use a skill right now, or null if they can. The server and the client both use this. */
export function skillBlockReason(p: PlayerEntity, id: SkillId, inCombat: boolean, turn: TurnState | null, isMyTurn: boolean): string | null {
  const def = SKILLS[id];
  if (!def) return 'Unknown skill';
  if (def.kind === 'passive') return 'Passive: always on';
  const own = ownedSkill(p, id);
  if (!own) return "You don't know that skill";
  const s = statsOf(own);
  if (p.dead || p.downed) return 'You are down!';
  if (inCombat) {
    if (!isMyTurn || !turn) return 'Not your turn';
    if (hasStatus(p, 'stunned')) return 'You are stunned';
    if (s.cost === 'action' && turn.actionUsed) return 'Action already used this turn';
    if (s.cost === 'bonus' && turn.bonusUsed) return 'Bonus action already used this turn';
    if (own.cd > 0) return `Ready in ${own.cd} turn${own.cd > 1 ? 's' : ''}`;
    if (s.refresh && p.used.includes('turn:surge')) return 'Only once per turn';
  } else if (!s.heal) {
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
  map: MapLike;
  entities: Entity[];
  inCombat: boolean;
}

export interface AimResult {
  center: Pos; // where it lands (the target, the area's center, or you)
  main?: Entity; // the creature aimed at, if any
  foes: MonsterEntity[];
  friends: PlayerEntity[];
}

/** Every monster within `radius` of `center`. */
function foesNear(ctx: AimCtx, center: Pos, radius: number): MonsterEntity[] {
  return ctx.entities.filter((e): e is MonsterEntity => e.kind === 'monster' && dist(e, center) <= radius);
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
      return { center: caster, friends: [caster], foes: [] };
    case 'enemy': {
      if (!byId) return 'Pick a target.';
      if (byId.kind !== 'monster') return 'Pick an enemy.';
      if (!ctx.inCombat) return 'Only in combat';
      if (!inRange(byId)) return outOfRange();
      const extra = s.chain
        ? ctx.entities
            .filter((e): e is MonsterEntity => e.kind === 'monster' && e !== byId && dist(e, byId) <= 2)
            .sort((a, b) => dist(a, byId) - dist(b, byId) || a.hp - b.hp)
            .slice(0, s.chain)
        : [];
      return { center: byId, main: byId, foes: [byId, ...extra], friends: [] };
    }
    case 'ally': {
      if (!byId) return 'Pick an ally (or yourself).';
      if (byId.kind !== 'player' || byId.dead) return 'Pick an ally (or yourself).';
      if (ctx.inCombat && !inRange(byId)) return outOfRange();
      return { center: byId, main: byId, foes: [], friends: [byId] };
    }
    case 'area': {
      const center = byId ? { x: byId.x, y: byId.y } : aim && typeof aim === 'object' ? { x: aim.x, y: aim.y } : null;
      if (!center || !Number.isInteger(center.x) || !Number.isInteger(center.y)) return 'Pick a spot.';
      if (center.x < 0 || center.y < 0 || center.x >= ctx.map.width || center.y >= ctx.map.height) return 'Pick a spot in the room.';
      if (ctx.map.tiles[center.y * ctx.map.width + center.x] === '#') return 'Pick an open spot.';
      if (!ctx.inCombat) return 'Only in combat';
      if (!inRange(center)) return dist(caster, center) > s.range ? `Out of range (${s.name} reaches ${s.range} tiles).` : 'No line of sight.';
      return { center, main: byId, foes: foesNear(ctx, center, s.radius ?? 1), friends: [] };
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

export const countKind = (p: PlayerEntity, kind: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === kind).length;

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
