// Game rules: dice, classes, abilities and monsters. A simplified take on D&D 5e.
// Tweak numbers here to rebalance the game; both server and client read from this file.

import { gearBonus } from './items.ts';
import type { Element, SkillId, StatusApply } from './skills.ts';
import type { CloudId, GroundId } from './surfaces.ts';
import type { BoonId, ClassId, NodeType } from './types.ts';

export const MAX_PLAYERS = 6;
export const MIN_PARTY = 3; // every run starts with at least this many heroes: bots take the empty seats
export const MAX_ACT = 3;
export const ACT_ROWS = 12; // map rows per act before the boss
export const MAP_COLS = 7;
export const VOTE_MS = 20_000; // how long a vote stays open after the first vote
export const CONTINUE_MS = 60_000; // an outcome screen: how long the others get to read and pick after the first Continue
/** Auto-play for a person at the keyboard: how long they get to make each spoils or level-up pick (and their rest-site choice) themselves. */
export const PICK_WAIT_MS = 10_000;

export const NODE_INFO: Record<NodeType, { icon: string; name: string }> = {
  combat: { icon: '⚔️', name: 'Combat' },
  elite: { icon: '💀', name: 'Elite' },
  event: { icon: '❓', name: 'Event' },
  rest: { icon: '🔥', name: 'Rest' },
  treasure: { icon: '💰', name: 'Treasure' },
  shop: { icon: '🛒', name: 'Shop' },
  boss: { icon: '👑', name: 'Boss' },
};

// ---------------------------------------------------------------- dice

export interface Dice {
  n: number;
  d: number;
  bonus?: number;
}

export function rollDie(sides: number): number {
  return 1 + Math.floor(Math.random() * sides);
}

/** Rolls dice; a critical hit doubles the number of dice (not the bonus), like 5e. */
export function rollDice(dice: Dice, crit = false): number {
  const count = crit ? dice.n * 2 : dice.n;
  let total = dice.bonus ?? 0;
  for (let i = 0; i < count; i++) total += rollDie(dice.d);
  return total;
}

export function fmtMod(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function diceText(d: Dice): string {
  return `${d.n}d${d.d}${d.bonus ? fmtMod(d.bonus) : ''}`;
}

// ---------------------------------------------------------------- classes

export type Stat = 'str' | 'dex' | 'int' | 'wis';

/** What a class brings to a party. Bots fill the missing ones first (server/game.ts addBot). */
export type PartyRole = 'front' | 'healer' | 'ranged';

export interface ClassDef {
  name: string;
  glyph: string;
  hp: number; // max HP at level 1
  hpPerLevel: number;
  ac: number;
  speed: number;
  mods: Record<Stat, number>; // attacks, saves, initiative (dex), event checks
  stat: Stat; // casting/technique stat: cantrip and spell attacks, save DCs, heals
  slots: number; // slots at level 1 (every class has some, under its own name)
  start: SkillId[]; // starting skills, in hotbar order
  names: { cantrip: string; spell: string; slots: string }; // class flavor for the shared mechanics
  blurb: string;
  roles: PartyRole[];
}

export const CLASSES: Record<ClassId, ClassDef> = {
  fighter: {
    name: 'Fighter', glyph: '🛡️', hp: 12, hpPerLevel: 8, ac: 16, speed: 6, mods: { str: 3, dex: 1, int: 0, wis: 1 }, stat: 'str', slots: 1,
    start: ['longsword', 'shield_bash', 'second_wind'],
    names: { cantrip: 'Techniques', spell: 'Maneuvers', slots: 'Grit' },
    blurb: 'Tough front-liner in heavy armor. Bashes, taunts and shrugs off hits.',
    roles: ['front'],
  },
  rogue: {
    name: 'Rogue', glyph: '🗡️', hp: 9, hpPerLevel: 6, ac: 14, speed: 6, mods: { str: 0, dex: 3, int: 1, wis: 1 }, stat: 'dex', slots: 1,
    start: ['rapier', 'shortbow', 'cunning_dash', 'shadow_step'],
    names: { cantrip: 'Tricks', spell: 'Exploits', slots: 'Cunning' },
    blurb: 'Sneak Attack when a friend is next to the target (or with advantage). Fast, slippery, steals kills.',
    roles: ['ranged'],
  },
  wizard: {
    name: 'Wizard', glyph: '🧙', hp: 7, hpPerLevel: 5, ac: 12, speed: 6, mods: { str: -1, dex: 2, int: 3, wis: 1 }, stat: 'int', slots: 2,
    start: ['dagger', 'fire_bolt', 'magic_missile'],
    names: { cantrip: 'Cantrips', spell: 'Spells', slots: 'Spell slots' },
    blurb: 'Fragile, but deadly from range. Fire, frost and lightning, plus Magic Missile that never misses.',
    roles: ['ranged'],
  },
  cleric: {
    name: 'Cleric', glyph: '✨', hp: 10, hpPerLevel: 7, ac: 16, speed: 6, mods: { str: 2, dex: 0, int: 0, wis: 3 }, stat: 'wis', slots: 2,
    start: ['mace', 'sacred_flame', 'healing_word'],
    names: { cantrip: 'Cantrips', spell: 'Prayers', slots: 'Spell slots' },
    blurb: 'The healer. Healing Word gets downed friends back up from range; Bless makes everyone hit harder.',
    roles: ['healer'],
  },
  // Phase 12
  barbarian: {
    name: 'Barbarian', glyph: '🪓', hp: 14, hpPerLevel: 9, ac: 14, speed: 7, mods: { str: 3, dex: 2, int: -1, wis: 0 }, stat: 'str', slots: 1,
    start: ['greataxe', 'rage', 'brutal_strike'],
    names: { cantrip: 'Instincts', spell: 'Furies', slots: 'Fury' },
    blurb: 'Huge HP and a temper. Rage halves the damage you take and adds to every swing; Reckless Attack trades your guard for advantage.',
    roles: ['front'],
  },
  ranger: {
    name: 'Ranger', glyph: '🏹', hp: 10, hpPerLevel: 7, ac: 14, speed: 6, mods: { str: 1, dex: 3, int: 0, wis: 2 }, stat: 'dex', slots: 2,
    start: ['longbow', 'shortsword', 'hunters_mark', 'lightning_arrow'],
    names: { cantrip: 'Field Craft', spell: 'Hunter Spells', slots: 'Focus' },
    blurb: "A hunter with a long reach. Marks prey for the whole party, nets runners in place, and patches friends up with herbs.",
    roles: ['ranged'],
  },
  paladin: {
    name: 'Paladin', glyph: '⚜️', hp: 12, hpPerLevel: 8, ac: 17, speed: 5, mods: { str: 3, dex: -1, int: 0, wis: 2 }, stat: 'wis', slots: 2,
    start: ['warhammer', 'lay_on_hands', 'divine_smite'],
    names: { cantrip: 'Oaths', spell: 'Miracles', slots: 'Devotion' },
    blurb: 'Heavy armor and holy fire. Divine Smite hits hard, Lay on Hands heals with a touch, and Compelled Duel drags monsters off your friends.',
    roles: ['front', 'healer'],
  },
  bard: {
    name: 'Bard', glyph: '🎻', hp: 8, hpPerLevel: 6, ac: 13, speed: 6, mods: { str: 0, dex: 2, int: 3, wis: 1 }, stat: 'int', slots: 2,
    start: ['hand_crossbow', 'vicious_mockery', 'inspiration', 'healing_ballad'],
    names: { cantrip: 'Tunes', spell: 'Ballads', slots: 'Verses' },
    blurb: "The party's voice. Insults that sting, songs that inspire, a ballad that heals everyone. Fragile: stay behind the front line.",
    roles: ['healer', 'ranged'],
  },
};

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
export const PLAYER_COLORS = ['#f2a03d', '#4fb3ff', '#7ddc6f', '#e86df0', '#ffd84d', '#ff6b6b'];

// Potions after a won fight, like Slay the Spire: 40% at first, -10% after each one that drops, +10% after each fight without.
export const POTION_ODDS = 40;
export const POTION_ODDS_STEP = 10;

// Getting back up (decided 2026-10-19, after a playtest found dying painless): anyone can Help Up a downed friend next to
// them (2 AP) at a quarter of their max HP. Healing spells, potions and scrolls still revive, cantrips don't, and every
// revive but your own death saves leaves you Groggy (you lose your next turn). A hero who dies (3 failed death saves) is
// back after the fight with an Injury: -20% max HP for each death (up to 3), until the next rest site or act.
export const HELP_UP_HP = 0.25;

// Cover (decided 2026-10-19, XCOM style: harder to hit). Low cover (crates, rubble, barrels) or a wall on the side of
// you that faces a ranged attacker adds to your AC, and to DEX saves against a blast from that side. Melee ignores it,
// and so does an attacker far enough round the side (flanking you). See coverFrom in shared/tactics.ts.
export const HALF_COVER = 2;
export const FULL_COVER = 5;
/** Worn down: each time a hero goes down again in one fight, their death saves start one failure worse; this many is death. */
export const MAX_DOWNS = 4;
export const INJURY_PCT = 0.2;
export const MAX_INJURIES = 3;

// Action points (decided 2026-10-19, DOS2 / Slay the Spire style). Heroes only: monsters keep their move + attack turn.
export const AP_GAIN = 3; // AP a hero gets at the start of each turn
export const AP_MAX = 5; // AP left over carries into the next turn, but a turn starts with at most this many
export const ATTACK_AP = 2; // what a basic attack (and most spells) costs

export const profBonus = (level: number) => 2 + Math.floor((level - 1) / 4);
export const maxHpFor = (c: ClassId, level: number) => CLASSES[c].hp + (level - 1) * CLASSES[c].hpPerLevel;
/** Slots before boons: the class base, +1 every other level. */
export const maxSlotsFor = (c: ClassId, level: number) => CLASSES[c].slots + Math.floor((level - 1) / 2);
export const sneakDice = (level: number) => Math.ceil(level / 2);
export const statMod = (c: ClassId, stat: Stat) => CLASSES[c].mods[stat];
/** Save DC for a hero's cantrips and spells (8 + proficiency + casting stat, like 5e). */
export const saveDc = (c: ClassId, level: number) => 8 + profBonus(level) + CLASSES[c].mods[CLASSES[c].stat];
export const BREATH_DC = 13;

// ---------------------------------------------------------------- sneaking & surprise

export const STEALTH_DC_BASE = 12; // + the sharpest monster's WIS
export const AMBUSH_CHANCE = 0.1; // a regular fight (past the first rows) turns out to be an ambush
/** A hero's Stealth: DEX, Rogues add their proficiency, plus equipment (Elven Cloak) and relics (Owl Totem). */
export const stealthBonus = (p: { classId: ClassId; level: number } & Parameters<typeof gearBonus>[0]) =>
  CLASSES[p.classId].mods.dex + (p.classId === 'rogue' ? profBonus(p.level) : 0) + gearBonus(p, 'stealth');
/** Group Stealth DC to sneak up on these monsters (by MONSTERS key). */
export const stealthDc = (types: string[]) => STEALTH_DC_BASE + Math.max(0, ...types.map((t) => MONSTERS[t]?.wis ?? 0));

// ---------------------------------------------------------------- XP & levels

export const LEVEL_CAP = 12;
/** XP needed to go from `level` to the next one. */
export const xpToNext = (level: number) => 40 * level;
export const XP_SHARED = 0.5; // of a monster's XP, split evenly between every hero still alive in the fight
export const XP_KILL = 0.5; // extra for whoever lands the killing blow
export const XP_ASSIST = 0.15; // extra for everyone else who damaged it
export const XP_HEAL = 0.5; // support XP per HP healed on an ally
export const XP_REVIVE = 10; // support XP for getting a downed ally back up
export const XP_BUFF = 3; // support XP per ally buffed (Bless, Shield on others, ...)
export const XP_CATCH_UP = 0.25; // bonus per level behind the party's highest
export const STEAL_SHARE = 0.34; // a killing blow is a "kill steal" if the killer dealt less than this share of the damage
export const TIER3_LEVEL = 4; // tier III (a branch) needs this hero level
export const MAX_CANTRIPS = 3; // hotbar limits: learning past them means forgetting one
export const MAX_SPELLS = 3;
export const passiveSlots = (level: number) => 2 + (level >= 4 ? 1 : 0) + (level >= 8 ? 1 : 0);
export const REST_HEAL = 0.3; // Long Rest: heal this share of max HP and restore every slot
/** The short rest after every won fight: everyone heals this share of max HP (so damage doesn't snowball into a wipe). */
export const BREATHER = { heal: 0.15 };
export const REST_MS = 30_000; // rest picks close this long after the first pick

/** Common-pool cards that aren't skills. */
export const BOONS: Record<BoonId, { name: string; icon: string; desc: string }> = {
  hp: { name: 'Vigor', icon: '❤️', desc: '+5 max HP.' },
  ac: { name: 'Better Armor', icon: '🛡️', desc: '+1 AC (twice at most).' },
  potions: { name: 'Potion Belt', icon: '🧪', desc: '+2 healing potions.' },
  slot: { name: 'Deep Reserves', icon: '🔮', desc: '+1 max slot (Spell slots, Grit or Cunning).' },
};
export const BOON_HP = 5;
export const MAX_BONUS_AC = 2;

// ---------------------------------------------------------------- monsters

/**
 * How a monster fights (server/monsterai.ts): brutes push to the front, skirmishers circle for flanks and back attacks,
 * archers keep their distance, supports heal and buff their side, cowards run when they're hurt.
 */
export type Role = 'brute' | 'skirmisher' | 'archer' | 'support' | 'coward';

export const ROLES: Record<Role, { name: string; icon: string; desc: string }> = {
  brute: { name: 'Brute', icon: '🛡️', desc: 'Pushes to the front and holds it.' },
  skirmisher: { name: 'Skirmisher', icon: '🗡️', desc: 'Circles around for flanks and back attacks.' },
  archer: { name: 'Archer', icon: '🏹', desc: 'Keeps its distance and shoots.' },
  support: { name: 'Support', icon: '✨', desc: 'Heals and buffs its side from the back.' },
  coward: { name: 'Coward', icon: '💨', desc: 'Runs away when it gets hurt.' },
};

export const COWARD_HP = 0.4; // a coward runs below this share of its HP...
export const COWARD_TURNS = 2; // ...for this many turns, then fights cornered

/** How a creature takes an element: no damage, half, double, or it heals from it. */
export type Resist = 'immune' | 'resist' | 'weak' | 'absorb';

export const RESIST_WORD: Record<Resist, string> = { immune: 'Immune to', resist: 'Resists', weak: 'Weak to', absorb: 'Healed by' };

export interface MonsterDef {
  name: string;
  glyph: string;
  hp: number;
  ac: number;
  speed: number;
  atk: number; // attack bonus
  dmg: Dice;
  range: number; // 1 = melee
  attacks: number;
  dex: number; // initiative and DEX saves
  str: number; // STR saves (shoves, bashes, Word of Radiance)
  wis: number; // WIS saves
  verb: string;
  threat: number; // encounter budget cost
  xp: number; // shared out when it dies (see XP_* above)
  element?: Element; // damage type of its attacks (Physical if unset); fire, cold and lightning react with the ground
  resist?: Partial<Record<Element, Resist>>;
  death?: { ground?: GroundId; cloud?: CloudId; radius: number; text: string }; // what it leaves behind when it dies
  breath?: boolean; // fire breath every 3rd round
  signature?: BossSignature; // an act boss's own mechanic (BOSS_SIGNATURES)
  role?: Role; // how it fights (default: archer if it shoots, else brute)
  shove?: boolean; // shoves heroes into fire, poison and other hazards when it can (STR contest, like the heroes' Shove)
  support?: { heal: Dice; buff: StatusApply }; // a support's spells, at its attack range: mend a hurt friend, or buff one
  trick?: MonsterTrick; // a set-up it can use instead of attacking (server/monsterai.ts decides when)
  rider?: MonsterRider; // what its attacks do on a hit
  leader?: boolean; // gives its side orders (ORDERS)
  block?: number; // 🧱 Block at the start of each of its turns: a shield
  raise?: string; // Raise Dead: once a fight, after a friend has fallen, this monster stands up next to it
  hardMove?: string; // a Hard version's extra move, in a few words (HARD_MOVES)
}

/**
 * A monster's trick (Phase 12): instead of attacking, it throws a net, spits a web or brands a hero in range, so that
 * its friends hit harder. The target saves against `dc`, or without a save it's an attack roll. Then the trick needs
 * `cooldown` of its turns to be ready again.
 */
export interface MonsterTrick {
  name: string;
  icon: string;
  verb: string; // "throws a net at"
  range: number;
  save?: 'dex' | 'str' | 'wis';
  dc?: number;
  status: StatusApply[];
  cooldown: number; // 99: once a fight
}

/** What a monster's attacks do on a hit: the target saves against `dc` or gets the status (without a save, always). */
export interface MonsterRider {
  status: StatusApply;
  save?: 'dex' | 'str' | 'wis';
  dc?: number;
  text: string; // "knocks {target} down"
}

/**
 * Help: instead of attacking, a melee monster gets in an enemy's face, and the next attack against them has advantage.
 * Weak monsters next to a hero help their big friends hit. NPC allies do it for the party too.
 */
export const HELP: StatusApply = { id: 'distracted', turns: 1 };
export const canHelp = (def: MonsterDef) => def.range <= 1 && roleOf(def) !== 'support';

/** A leader's orders: a free shout at the start of its turn, on its first turn and then every ORDER_EVERY turns. */
export type OrderId = 'charge' | 'hold' | 'kill';
export const ORDERS: Record<OrderId, { name: string; icon: string; desc: string }> = {
  charge: { name: 'Charge!', icon: '📯', desc: 'Every friend within 8 tiles gets +3 movement on its next turn and a stack of Rallied.' },
  hold: { name: 'Hold the line!', icon: '🛡️', desc: 'Every friend within 8 tiles is Shielded (+2 AC) for 2 turns.' },
  kill: { name: 'Kill that one!', icon: '🎯', desc: 'Marks one enemy for 2 turns: attacks against it have advantage.' },
};
export const ORDER_RANGE = 8;
export const ORDER_EVERY = 3;
export const ORDER_STATUS: Record<OrderId, StatusApply[]> = {
  charge: [{ id: 'charging', turns: 1 }, { id: 'rallied', turns: 3, power: 1, stack: 3 }],
  hold: [{ id: 'shielded', turns: 2, power: 2 }],
  kill: [{ id: 'marked', turns: 2 }],
};
export const CHARGE_MOVES = 3;

export const roleOf = (def: MonsterDef): Role => def.role ?? (def.range > 1 ? 'archer' : 'brute');

const m = (
  name: string, glyph: string, hp: number, ac: number, atk: number, dmg: Dice, threat: number,
  extra: Partial<MonsterDef> = {},
): MonsterDef => ({
  name, glyph, hp, ac, atk, dmg, threat, speed: 6, range: 1, attacks: 1, dex: 1, str: 1, wis: 0, verb: 'hits', xp: threat * 10, ...extra,
});

export const monsterSave = (def: MonsterDef, save: 'dex' | 'str' | 'wis') => def[save];

export const MONSTERS: Record<string, MonsterDef> = {
  // Act 1: Goblin Warrens
  rat: m('Giant Rat', '🐀', 7, 12, 4, { n: 1, d: 4, bonus: 2 }, 1, { dex: 2, role: 'coward', verb: 'bites' }),
  kobold: m('Kobold', '🦎', 5, 12, 4, { n: 1, d: 4, bonus: 2 }, 1, {
    dex: 2, role: 'coward', verb: 'stabs',
    trick: { name: 'Net', icon: '🪢', verb: 'throws a net at', range: 3, status: [{ id: 'netted', turns: 2 }], cooldown: 99 },
  }),
  goblin: m('Goblin', '👺', 7, 15, 4, { n: 1, d: 6, bonus: 2 }, 2, {
    dex: 2, role: 'skirmisher', verb: 'slashes',
    trick: { name: 'Dirty Trick', icon: '🫳', verb: 'throws sand in the eyes of', range: 1, save: 'dex', dc: 12, status: [{ id: 'blinded', turns: 1 }], cooldown: 3 },
  }),
  archer: m('Goblin Archer', '🏹', 7, 13, 4, { n: 1, d: 6, bonus: 2 }, 2, { dex: 2, range: 8, verb: 'shoots' }),
  firebomber: m('Goblin Firebomber', '💣', 7, 12, 4, { n: 1, d: 6, bonus: 1 }, 3, { dex: 2, range: 6, element: 'fire', verb: 'lobs a firebomb at' }),
  shaman: m('Goblin Shaman', '🔮', 9, 12, 3, { n: 1, d: 4, bonus: 1 }, 3, {
    range: 6, wis: 2, element: 'lightning', role: 'support', verb: 'zaps',
    support: { heal: { n: 1, d: 8, bonus: 2 }, buff: { id: 'rallied', turns: 3, power: 1, stack: 3 } },
  }),
  hobgoblin: m('Hobgoblin Captain', '👿', 30, 17, 5, { n: 1, d: 8, bonus: 3 }, 10, { attacks: 2, str: 3, wis: 1, shove: true, leader: true, block: 3, verb: 'cuts' }),
  goblin_king: m('Goblin King', '👑', 50, 16, 5, { n: 1, d: 10, bonus: 3 }, 0, { attacks: 2, dex: 2, str: 3, wis: 1, xp: 200, shove: true, leader: true, signature: 'horn', verb: 'slashes' }),
  mimic: m('Mimic', '📦', 30, 12, 4, { n: 1, d: 8, bonus: 2 }, 10, { attacks: 2, speed: 4, dex: 0, str: 3, verb: 'chomps' }),
  // Act 2: Forgotten Crypt
  skeleton: m('Skeleton', '💀', 13, 13, 4, { n: 1, d: 6, bonus: 2 }, 3, { dex: 2, wis: -1, resist: { poison: 'immune' }, block: 2, verb: 'hacks' }),
  zombie: m('Zombie', '🧟', 22, 8, 3, { n: 1, d: 6, bonus: 1 }, 2, { speed: 4, dex: -2, str: 2, wis: -2, resist: { poison: 'immune', fire: 'weak' }, verb: 'claws' }),
  bloated: m('Bloated Zombie', '🤮', 18, 8, 3, { n: 1, d: 6, bonus: 1 }, 2, {
    speed: 4, dex: -2, str: 2, wis: -2, resist: { poison: 'immune' }, verb: 'slaps',
    death: { ground: 'poison', radius: 1, text: 'bursts in a spray of poison' },
  }),
  wolf: m('Wolf', '🐺', 11, 13, 4, { n: 2, d: 4, bonus: 2 }, 3, {
    speed: 8, dex: 2, role: 'skirmisher', verb: 'bites',
    rider: { status: { id: 'prone', turns: 1 }, save: 'str', dc: 11, text: 'drags {target} to the ground' },
  }),
  spider: m('Giant Spider', '🕷️', 22, 14, 5, { n: 1, d: 8, bonus: 3 }, 5, {
    dex: 3, role: 'skirmisher', resist: { poison: 'resist' }, verb: 'bites',
    trick: { name: 'Web', icon: '🕸️', verb: 'spits a web at', range: 4, save: 'dex', dc: 12, status: [{ id: 'webbed', turns: 3 }], cooldown: 4 },
  }),
  necromancer: m('Necromancer', '🧛', 16, 12, 4, { n: 1, d: 8 }, 5, {
    range: 6, wis: 2, element: 'cold', role: 'support', resist: { cold: 'resist' }, verb: 'sends a chill at',
    support: { heal: { n: 2, d: 6, bonus: 2 }, buff: { id: 'shielded', turns: 2, power: 2 } },
  }),
  wight: m('Wight', '👻', 45, 14, 5, { n: 1, d: 8, bonus: 3 }, 12, {
    attacks: 2, dex: 2, str: 2, wis: 2, element: 'cold', resist: { poison: 'immune', cold: 'resist' }, verb: 'drains',
    rider: { status: { id: 'drained', turns: 99, power: 2, stack: 5 }, text: 'drinks the life from {target}' },
  }),
  broodmother: m('Spider Broodmother', '🕸️', 50, 14, 6, { n: 1, d: 10, bonus: 3 }, 12, {
    dex: 3, str: 3, attacks: 2, resist: { poison: 'resist' }, verb: 'bites',
    trick: { name: 'Web', icon: '🕸️', verb: 'spits a web at', range: 4, save: 'dex', dc: 13, status: [{ id: 'webbed', turns: 3 }], cooldown: 3 },
  }),
  bone_knight: m('Bone Knight', '☠️', 85, 17, 7, { n: 2, d: 6, bonus: 4 }, 0, {
    attacks: 2, str: 4, wis: 2, xp: 350, shove: true, leader: true, block: 5, resist: { poison: 'immune' }, signature: 'rise', verb: 'cleaves',
  }),
  // Act 3: Dragon's Lair
  orc: m('Orc', '👹', 15, 13, 5, { n: 1, d: 12, bonus: 3 }, 4, { str: 3, shove: true, verb: 'cleaves' }),
  cultist: m('Dragon Cultist', '🦹', 18, 12, 5, { n: 2, d: 6 }, 4, {
    range: 6, wis: 1, element: 'fire', resist: { fire: 'resist' }, verb: 'hurls fire at',
    trick: { name: 'Dragon Brand', icon: '🎯', verb: 'brands', range: 6, save: 'wis', dc: 13, status: [{ id: 'marked', turns: 2 }], cooldown: 3 },
  }),
  imp: m('Magma Imp', '😈', 16, 13, 5, { n: 1, d: 6, bonus: 2 }, 4, {
    range: 4, dex: 3, element: 'fire', resist: { fire: 'absorb', cold: 'weak' }, verb: 'spits magma at',
    death: { ground: 'fire', radius: 1, text: 'collapses into a pool of fire' },
  }),
  ogre: m('Ogre', '🧌', 45, 11, 6, { n: 2, d: 8, bonus: 4 }, 8, {
    dex: -1, str: 4, wis: -2, shove: true, verb: 'smashes',
    rider: { status: { id: 'prone', turns: 1 }, save: 'str', dc: 13, text: 'knocks {target} flat' },
  }),
  priest: m('Dragon Priest', '🕯️', 20, 13, 5, { n: 1, d: 8, bonus: 1 }, 5, {
    range: 6, wis: 2, element: 'fire', role: 'support', resist: { fire: 'resist' }, verb: 'scorches',
    support: { heal: { n: 2, d: 8, bonus: 2 }, buff: { id: 'blessed', turns: 2 } },
  }),
  warchief: m('Orc Warchief', '🪓', 55, 16, 7, { n: 1, d: 12, bonus: 4 }, 16, { attacks: 2, str: 4, wis: 1, shove: true, leader: true, verb: 'cleaves' }),
  drake: m('Fire Drake', '🦖', 60, 15, 7, { n: 2, d: 6, bonus: 4 }, 16, { attacks: 2, str: 4, wis: 1, breath: true, resist: { fire: 'immune' }, verb: 'rends' }),
  wyrm: m('Dread Wyrm', '🐉', 110, 17, 8, { n: 2, d: 8, bonus: 4 }, 0, {
    attacks: 2, dex: 0, str: 5, wis: 3, xp: 500, breath: true, shove: true, leader: true, resist: { fire: 'resist' }, signature: 'wrath', verb: 'rends',
  }),
  // NPC allies (shared/elites.ts): they fight for the party; act 1 numbers, they grow with the act
  sellsword: m('Sellsword', '💂', 24, 15, 5, { n: 1, d: 8, bonus: 3 }, 0, { str: 3, xp: 0, shove: true, block: 2, verb: 'cuts' }),
  acolyte: m('Acolyte', '😇', 16, 13, 4, { n: 1, d: 8 }, 0, {
    range: 6, wis: 3, xp: 0, element: 'radiant', role: 'support', verb: 'smites',
    support: { heal: { n: 1, d: 8, bonus: 3 }, buff: { id: 'blessed', turns: 2 } },
  }),
  ranger: m('Ranger', '🧝', 16, 14, 5, { n: 1, d: 8, bonus: 2 }, 0, { range: 8, dex: 3, xp: 0, verb: 'shoots' }),
  war_hound: m('War Hound', '🐕', 18, 13, 5, { n: 2, d: 4, bonus: 2 }, 0, { speed: 8, dex: 2, xp: 0, role: 'skirmisher', verb: 'bites' }),
};

/**
 * 💀 On Hard every regular monster brings one more move (your call, 2026-10-20: Hard gets smarter monsters, not just
 * tougher ones). Its Hard version is registered as `<id>_hard`, with the same name and numbers plus the move, and spawns in
 * its place on Hard (server/game.ts spawnMonster). `move` says what's new, in a few words (tooltips, the codex).
 */
export const HARD_MOVES: Record<string, { move: string; add: Partial<MonsterDef> }> = {
  // Act 1: Goblin Warrens
  rat: { move: '🦠 Filthy bites: they Poison', add: { rider: { status: { id: 'poisoned', turns: 2, power: 1 }, text: 'infects {target}' } } },
  kobold: { move: '✋ Shoves heroes into fire, oil and lava', add: { shove: true } },
  goblin: { move: '🦵 Hamstring: its hits can Daze (DEX save)', add: { rider: { status: { id: 'dazed', turns: 1 }, save: 'dex', dc: 12, text: 'hamstrings {target}' } } },
  archer: {
    move: '📌 Pinning Shot: pins a hero in place (DEX save)',
    add: { trick: { name: 'Pinning Shot', icon: '📌', verb: 'pins down', range: 8, save: 'dex', dc: 12, status: [{ id: 'netted', turns: 1 }], cooldown: 3 } },
  },
  firebomber: { move: '💥 Drops its last bomb when it dies', add: { death: { ground: 'fire', radius: 1, text: 'drops its last bomb' } } },
  shaman: {
    move: '🌀 Hex: marks a hero, so everyone hits them more easily (WIS save)',
    add: { trick: { name: 'Hex', icon: '🌀', verb: 'hexes', range: 6, save: 'wis', dc: 12, status: [{ id: 'marked', turns: 1 }], cooldown: 3 } },
  },
  // Act 2: Forgotten Crypt
  skeleton: {
    move: '🛡️ Shield Bash: knocks a hero down (STR save)',
    add: { trick: { name: 'Shield Bash', icon: '🛡️', verb: 'shield-bashes', range: 1, save: 'str', dc: 12, status: [{ id: 'prone', turns: 1 }], cooldown: 3 } },
  },
  zombie: { move: '✊ Grab: its hits hold a hero in place (STR save)', add: { rider: { status: { id: 'netted', turns: 1 }, save: 'str', dc: 12, text: 'grabs hold of {target}' } } },
  bloated: {
    move: '🤮 Vomit: Poisons a hero up to 3 tiles away (DEX save)',
    add: { trick: { name: 'Vomit', icon: '🤮', verb: 'vomits on', range: 3, save: 'dex', dc: 12, status: [{ id: 'poisoned', turns: 2, power: 1 }], cooldown: 3 } },
  },
  wolf: { move: '🐺 Howls orders to the pack', add: { leader: true } },
  spider: { move: '🕷️ Venom: its bites Poison', add: { rider: { status: { id: 'poisoned', turns: 2, power: 1 }, text: 'poisons {target}' } } },
  necromancer: { move: '🧟 Raise Dead: once a fight, after a friend falls, a Zombie claws its way up', add: { raise: 'zombie' } },
  // Act 3: Dragon's Lair (the kobolds above come along)
  orc: { move: '💢 Staggering blows: its hits can Daze (STR save)', add: { rider: { status: { id: 'dazed', turns: 1 }, save: 'str', dc: 13, text: 'staggers {target}' } } },
  cultist: { move: '🔥 Its fire sets heroes Burning', add: { rider: { status: { id: 'burning', turns: 2, power: 1 }, text: 'sets {target} alight' } } },
  imp: {
    move: '✨ Cinder Spit: Blinds a hero (DEX save)',
    add: { trick: { name: 'Cinder Spit', icon: '✨', verb: 'spits cinders in the eyes of', range: 4, save: 'dex', dc: 13, status: [{ id: 'blinded', turns: 1 }], cooldown: 3 } },
  },
  ogre: {
    move: '📢 Bellow: Dazes a hero (WIS save)',
    add: { trick: { name: 'Bellow', icon: '📢', verb: 'bellows at', range: 3, save: 'wis', dc: 13, status: [{ id: 'dazed', turns: 1 }], cooldown: 3 } },
  },
  priest: { move: '📯 Leads the faithful: shouts orders', add: { leader: true } },
};

const HARD_SUFFIX = '_hard';
/** The Hard version of a monster, if it has one. */
export const hardId = (type: string) => (Object.hasOwn(HARD_MOVES, type) ? `${type}${HARD_SUFFIX}` : type);
/** The monster a Hard version is made from (sprites, voices). */
export const baseType = (type: string) => (type.endsWith(HARD_SUFFIX) ? type.slice(0, -HARD_SUFFIX.length) : type);
export const isHardVersion = (type: string) => type.endsWith(HARD_SUFFIX) && Object.hasOwn(HARD_MOVES, baseType(type));
for (const [id, h] of Object.entries(HARD_MOVES)) MONSTERS[`${id}${HARD_SUFFIX}`] = { ...MONSTERS[id], ...h.add, hardMove: h.move };

/**
 * A handwritten encounter template. The fight draws monsters from `monsters` until the threat budget runs out
 * (list a type twice to make it twice as common), so the same template scales with party size and map row.
 */
export interface EncounterDef {
  name: string;
  monsters: string[];
  minRow?: number; // not used before this map row
  /** How the fight starts, instead of the usual mix: walking into their camp, a pincer in a tunnel. An ambush still surrounds you. */
  deploy?: 'line' | 'scattered' | 'pincer' | 'camp';
  /** Extra ground on top of the act's: [what, how many patches, patch size], e.g. an oil-soaked cellar. */
  terrain?: [GroundId, [number, number], [number, number]][];
}

export interface ActDef {
  name: string;
  glyph: string;
  pool: string[]; // every regular monster of the act (events draw from it)
  encounters: EncounterDef[];
  elites: string[];
  escorts: Record<string, string[]>; // elite -> monsters that may join it
  boss: string;
  minions: string[]; // join the boss (and answer a War Horn, or rise again)
}

export const ACTS: ActDef[] = [
  {
    name: 'Goblin Warrens', glyph: '👺',
    pool: ['rat', 'kobold', 'goblin', 'archer', 'firebomber', 'shaman'],
    encounters: [
      { name: 'Rat Nest', monsters: ['rat', 'rat', 'rat', 'kobold'] },
      { name: 'Goblin Patrol', monsters: ['goblin', 'goblin', 'archer'] },
      { name: 'Kobold Tunnel Crew', monsters: ['kobold', 'kobold', 'goblin'] },
      { name: 'Firebomb Squad', monsters: ['firebomber', 'goblin', 'kobold'], minRow: 2 },
      { name: 'Archer Nest', monsters: ['archer', 'archer', 'goblin'], minRow: 3 },
      { name: "Shaman's Circle", monsters: ['shaman', 'goblin', 'goblin', 'kobold'], minRow: 2 },
      { name: 'Goblin Warband', monsters: ['goblin', 'goblin', 'archer', 'firebomber', 'kobold', 'rat', 'shaman'], minRow: 6 },
      { name: 'Tunnel Pincer', monsters: ['goblin', 'goblin', 'rat', 'kobold'], minRow: 1, deploy: 'pincer' },
      { name: 'Oil Cellar', monsters: ['firebomber', 'goblin', 'kobold', 'kobold'], minRow: 3, terrain: [['oil', [3, 4], [5, 8]]] },
      { name: 'Goblin Campfire', monsters: ['goblin', 'archer', 'shaman', 'rat'], minRow: 4, deploy: 'camp' },
    ],
    elites: ['hobgoblin', 'mimic'],
    escorts: { hobgoblin: ['goblin', 'archer', 'firebomber', 'shaman'], mimic: ['rat'] },
    boss: 'goblin_king', minions: ['goblin', 'archer'],
  },
  {
    name: 'Forgotten Crypt', glyph: '💀',
    pool: ['skeleton', 'zombie', 'bloated', 'wolf', 'spider', 'necromancer'],
    encounters: [
      { name: 'Restless Dead', monsters: ['skeleton', 'zombie', 'zombie', 'bloated'] },
      { name: 'Plague Pit', monsters: ['bloated', 'bloated', 'zombie'], minRow: 2 },
      { name: 'Wolf Pack', monsters: ['wolf', 'wolf', 'wolf'] },
      { name: 'Bone Sentries', monsters: ['skeleton', 'skeleton'] },
      { name: 'Spider Lair', monsters: ['spider', 'spider', 'wolf'], minRow: 3 },
      { name: "Necromancer's Vigil", monsters: ['necromancer', 'skeleton', 'zombie', 'zombie'], minRow: 2 },
      { name: 'Bone Legion', monsters: ['skeleton', 'skeleton', 'zombie', 'bloated', 'spider', 'necromancer'], minRow: 6 },
      { name: 'Flooded Ossuary', monsters: ['skeleton', 'zombie', 'necromancer', 'zombie'], minRow: 2, terrain: [['water', [3, 4], [6, 10]]] },
      { name: 'Ghoul Feast', monsters: ['zombie', 'zombie', 'bloated', 'wolf'], minRow: 1, deploy: 'camp' },
      { name: 'Webbed Corridor', monsters: ['spider', 'wolf', 'wolf', 'skeleton'], minRow: 4, deploy: 'pincer', terrain: [['poison', [1, 2], [2, 4]]] },
    ],
    elites: ['wight', 'broodmother'],
    escorts: { wight: ['skeleton', 'zombie', 'bloated', 'necromancer'], broodmother: ['spider', 'wolf'] },
    boss: 'bone_knight', minions: ['skeleton', 'zombie'],
  },
  {
    name: "Dragon's Lair", glyph: '🐉',
    pool: ['orc', 'cultist', 'imp', 'kobold', 'ogre', 'priest'],
    encounters: [
      { name: 'Orc Raiders', monsters: ['orc', 'orc', 'kobold'] },
      { name: 'Cult Ritual', monsters: ['cultist', 'cultist', 'priest', 'imp', 'kobold'] },
      { name: 'Imp Swarm', monsters: ['imp', 'imp', 'kobold'], minRow: 2 },
      { name: 'Kobold Swarm', monsters: ['kobold', 'kobold', 'kobold', 'cultist'] },
      { name: 'Ogre Brutes', monsters: ['ogre', 'kobold', 'kobold'], minRow: 4 },
      { name: "Dragon's Guard", monsters: ['orc', 'cultist', 'imp', 'ogre', 'kobold', 'priest'], minRow: 6 },
      { name: 'Magma Vents', monsters: ['imp', 'imp', 'cultist', 'kobold'], minRow: 2, terrain: [['lava', [2, 3], [2, 4]], ['fire', [1, 2], [2, 3]]] },
      { name: 'Orc War Camp', monsters: ['orc', 'orc', 'ogre', 'kobold'], minRow: 4, deploy: 'camp' },
      { name: 'Sermon of Flame', monsters: ['cultist', 'cultist', 'priest', 'kobold', 'imp'], minRow: 3, deploy: 'pincer', terrain: [['oil', [2, 3], [3, 5]]] },
    ],
    elites: ['warchief', 'drake'],
    escorts: { warchief: ['orc', 'kobold', 'priest'], drake: ['cultist', 'imp', 'kobold', 'priest'] },
    boss: 'wyrm', minions: ['kobold', 'cultist', 'imp'],
  },
];

// ---------------------------------------------------------------- difficulty

export type Difficulty = 'story' | 'normal' | 'hard';

/**
 * Picked in the lobby by the host, kept for the whole run. Tuned with bot runs in the balance pass (Phase 13): the bots win
 * about 100% on Story, 85% on Normal and 45% on Hard (`npm run balance-farm`).
 * `squad`: monsters fight as a squad (server/monsterai.ts); without it each one goes for whoever is closest.
 * `slip`: the chance a monster forgets the plan for a turn and just goes for the closest hero (readable, beatable).
 */
export interface DifficultyDef {
  name: string;
  icon: string;
  desc: string;
  hp: number; // monster HP multiplier
  atk: number; // added to monster attack rolls
  dmg: number; // multiplier on a monster's average hit (added as a flat bonus per hit), so it grows with the acts
  budget: number; // encounter threat budget multiplier
  squad: boolean;
  slip: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  story: {
    name: 'Story', icon: '📖', hp: 0.75, atk: -1, dmg: 0.85, budget: 0.8, squad: false, slip: 1,
    desc: 'Weaker monsters that fight on instinct: each one goes for whoever is closest.',
  },
  normal: {
    name: 'Normal', icon: '⚔️', hp: 1.1, atk: 0, dmg: 1, budget: 1.15, squad: true, slip: 0.15,
    desc: 'Monsters fight as a squad: they gang up on one hero, flank, and use the battlefield.',
  },
  hard: {
    name: 'Hard', icon: '💀', hp: 1.15, atk: 1, dmg: 1.2, budget: 1.3, squad: true, slip: 0,
    desc: 'More monsters, tougher ones, and every one brings an extra move: hamstrings, shield bashes, venom, raised dead.',
  },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES) as Difficulty[];

/**
 * Who plays the monsters, picked in the lobby next to the difficulty: the scripted squad AI (server/monsterai.ts), or
 * the policy trained with PPO (server/policy.ts, training/). The difficulty still sets the monsters' numbers either way.
 */
export type MonsterAi = 'scripted' | 'ppo';

export const MONSTER_AIS: Record<MonsterAi, { name: string; icon: string; desc: string }> = {
  scripted: { name: 'Scripted', icon: '📜', desc: 'Handwritten squad tactics: readable, with a plan you can learn to read.' },
  ppo: { name: 'PPO (trained)', icon: '🧠', desc: 'A neural network trained against the hero bots (PPO). It picks from the same moves, its own way.' },
};

export const MONSTER_AI_IDS = Object.keys(MONSTER_AIS) as MonsterAi[];
export const isMonsterAi = (x: unknown): x is MonsterAi => typeof x === 'string' && Object.hasOwn(MONSTER_AIS, x);
export const isDifficulty = (x: unknown): x is Difficulty => typeof x === 'string' && Object.hasOwn(DIFFICULTIES, x);

/**
 * How the monsters grow with each hero past MIN_PARTY, on three levers: more of them (the encounter budget), more max
 * HP and more damage. A room holds at most 6 monsters, so in big parties HP and damage keep growing after the count
 * stops. Elites and bosses get their HP from scaledHp instead (they fight alone, so HP is their lever).
 * Tuned in the balance pass (Phase 13) so the party's lowest HP per fight is about the same for 3 to 6 heroes.
 */
export const PARTY_SCALING = { base: 1.4, count: 0.45, hp: 0.2, dmg: 0.1 }; // base: a 3-hero party's budget per threat point

/**
 * Monsters grow with the act (Phase 13): the heroes pick a card after every fight, so by act 3 they hit 8 times in 10
 * and fights were over in under 3 rounds. Every monster of the act gets more max HP (`hp`, a multiplier), AC, attack
 * bonus, and damage (`dmg`, a multiplier on its average hit, added as a flat bonus per hit like partyScaling's).
 * Elites and bosses too, but their HP grows less (`solo`): all of it on one body made their fights drag past 10 rounds.
 * NPC allies grow on their own curve (allyScaling in shared/elites.ts).
 */
export const ACT_SCALING = [
  { hp: 1, solo: 1, ac: 0, atk: 0, dmg: 1 },
  { hp: 1.7, solo: 1.35, ac: 1, atk: 2, dmg: 1.6 },
  { hp: 2.4, solo: 1.6, ac: 2, atk: 2, dmg: 2.2 },
];
export const actScaling = (act: number) => ACT_SCALING[Math.min(ACT_SCALING.length, Math.max(1, act)) - 1];

const pastMin = (partySize: number) => Math.max(0, partySize - MIN_PARTY);
export const partyScaling = (partySize: number) => ({
  count: 1 + PARTY_SCALING.count * pastMin(partySize), // encounter budget multiplier
  hp: 1 + PARTY_SCALING.hp * pastMin(partySize), // regular monsters' max HP multiplier
  dmg: 1 + PARTY_SCALING.dmg * pastMin(partySize), // every monster's damage multiplier (as a flat bonus per hit, see game.ts)
});

/**
 * The run's first fight (act 1, bottom row) is a warm-up: a smaller fight, from the classic line. Level-1 heroes are
 * fragile, and a party surrounded by six rats could lose the run before making a single choice.
 */
export const WARMUP_BUDGET = 0.75;

/** Threat budget for a regular fight. Grows with the act, the map row and the party size. */
export const encounterBudget = (act: number, row: number, partySize: number) =>
  (3 + 2 * (act - 1) + Math.floor(row / 3)) * PARTY_SCALING.base * partyScaling(partySize).count;

/**
 * The monsters split into this many packs against a party (server/monsterai.ts squadPlan), each hunting its own hero:
 * about one pack per two heroes, 3 at most, so no one hero takes the whole fight.
 */
export const packsFor = (partySize: number) => Math.min(3, Math.max(1, Math.round(partySize / 2)));

/**
 * Elites and bosses fight (mostly) alone, so HP is their lever: against 3 heroes they have `elite` or `boss` times their
 * HP, and `perHero` more for each hero beyond 3. (It was +25% per hero from 1, which left 3-hero parties facing the
 * toughest elites per hero and 6-hero parties the softest: bots won 0 of 12 Hard runs with 3 heroes, 10 of 12 with 6.)
 */
export const SOLO_HP_SCALING = { elite: 1.1, boss: 0.9, perHero: 0.5 };
export const scaledHp = (hp: number, partySize: number, boss: boolean) =>
  Math.round(hp * Math.max(0.5, (boss ? SOLO_HP_SCALING.boss : SOLO_HP_SCALING.elite) + SOLO_HP_SCALING.perHero * (partySize - MIN_PARTY)));

/**
 * Dev knob for the balance pass: the server merges DELVERS_TUNE (JSON, e.g. {"ACT_SCALING":[{},{"hp":1.6}]}) into these
 * numbers at start, so bot batches can try several settings side by side without editing code.
 */
/**
 * Act bosses: minions per hero in the party (rounded down), and a multiplier on the boss's average hit, so the boss is
 * the hardest fight of its act. Elites: a multiplier on their average hit (their traits already add a lot).
 * A boss fight is a race (your call, 2026-10-20): killing the boss ends the fight (the rest flee), and each boss has one
 * signature that punishes a slow fight (BOSS_SIGNATURES). The numbers for those are here: War Horn calls `callPerHero`
 * minions per hero (at least one) every `callEvery` rounds; Rise Again stands a fallen minion back up `riseAfter` rounds
 * later; Wrath adds a 😡 Fury stack every round from round `furyFrom` (+`furyAtk` to hit, +`furyDmg` of its average hit).
 */
export const BOSS = { minions: 0.5, dmg: 1.2, furyFrom: 4, furyAtk: 1, furyDmg: 0.1, callEvery: 3, callPerHero: 0.5, riseAfter: 2 };

/** Each act boss's own way of making a long fight go badly (decided 2026-10-20: one each, so bosses don't feel the same). */
export type BossSignature = 'horn' | 'rise' | 'wrath';
export const BOSS_SIGNATURES: Record<BossSignature, { name: string; icon: string; desc: string }> = {
  horn: { name: 'War Horn', icon: '📯', desc: 'Every 3rd round it blows a war horn and more of its warband pours in. Kill it and they scatter.' },
  rise: { name: 'Rise Again', icon: '🦴', desc: 'Its fallen minions claw their way back up 2 rounds later, as long as it stands. Break it and the dead stay down.' },
  wrath: { name: 'Wrath', icon: '😡', desc: 'From round 4 it grows angrier every round: +1 to hit and +10% damage per Fury stack, its fire breath too.' },
};
export const ELITE = { dmg: 1 };

export const TUNABLES: Record<string, object> = { ACT_SCALING, DIFFICULTIES, PARTY_SCALING, SOLO_HP_SCALING, BREATHER, BOSS, ELITE };
export function tune(patch: Record<string, unknown>) {
  const merge = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(from)) {
      if (!(k in into)) throw new Error(`DELVERS_TUNE: no such knob "${k}"`);
      if (v && typeof v === 'object' && into[k] && typeof into[k] === 'object') merge(into[k] as Record<string, unknown>, v as Record<string, unknown>);
      else into[k] = v;
    }
  };
  merge(TUNABLES as Record<string, unknown>, patch);
}

/** Gold for clearing a room. */
export const roomGold = (act: number, kind: NodeType) => (kind === 'boss' ? 4 : kind === 'elite' ? 2 : 1) * (8 + 4 * act);
