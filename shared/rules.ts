// Game rules: dice, classes, abilities and monsters. A simplified take on D&D 5e.
// Tweak numbers here to rebalance the game; both server and client read from this file.

import type { Element, SkillId } from './skills.ts';
import type { BoonId, ClassId, NodeType } from './types.ts';

export const MAX_PLAYERS = 6;
export const MAX_ACT = 3;
export const ACT_ROWS = 12; // map rows per act before the boss
export const MAP_COLS = 7;
export const VOTE_MS = 20_000; // how long a vote stays open after the first vote

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
}

export const CLASSES: Record<ClassId, ClassDef> = {
  fighter: {
    name: 'Fighter', glyph: '🛡️', hp: 12, hpPerLevel: 8, ac: 16, speed: 6, mods: { str: 3, dex: 1, int: 0, wis: 1 }, stat: 'str', slots: 1,
    start: ['longsword', 'shield_bash', 'second_wind'],
    names: { cantrip: 'Techniques', spell: 'Maneuvers', slots: 'Grit' },
    blurb: 'Tough front-liner in heavy armor. Bashes, taunts and shrugs off hits.',
  },
  rogue: {
    name: 'Rogue', glyph: '🗡️', hp: 9, hpPerLevel: 6, ac: 14, speed: 6, mods: { str: 0, dex: 3, int: 1, wis: 1 }, stat: 'dex', slots: 1,
    start: ['rapier', 'shortbow', 'cunning_dash', 'shadow_step'],
    names: { cantrip: 'Tricks', spell: 'Exploits', slots: 'Cunning' },
    blurb: 'Sneak Attack when a friend is next to the target (or with advantage). Fast, slippery, steals kills.',
  },
  wizard: {
    name: 'Wizard', glyph: '🧙', hp: 7, hpPerLevel: 5, ac: 12, speed: 6, mods: { str: -1, dex: 2, int: 3, wis: 1 }, stat: 'int', slots: 2,
    start: ['dagger', 'fire_bolt', 'magic_missile'],
    names: { cantrip: 'Cantrips', spell: 'Spells', slots: 'Spell slots' },
    blurb: 'Fragile, but deadly from range. Fire, frost and lightning, plus Magic Missile that never misses.',
  },
  cleric: {
    name: 'Cleric', glyph: '✨', hp: 10, hpPerLevel: 7, ac: 16, speed: 6, mods: { str: 2, dex: 0, int: 0, wis: 3 }, stat: 'wis', slots: 2,
    start: ['mace', 'sacred_flame', 'healing_word'],
    names: { cantrip: 'Cantrips', spell: 'Prayers', slots: 'Spell slots' },
    blurb: 'The healer. Healing Word gets downed friends back up from range; Bless makes everyone hit harder.',
  },
};

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
export const PLAYER_COLORS = ['#f2a03d', '#4fb3ff', '#7ddc6f', '#e86df0', '#ffd84d', '#ff6b6b'];

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
/** A hero's Stealth: DEX, and Rogues add their proficiency. */
export const stealthBonus = (p: { classId: ClassId; level: number }) => CLASSES[p.classId].mods.dex + (p.classId === 'rogue' ? profBonus(p.level) : 0);
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
  element?: Element; // damage type of its attacks (Physical if unset)
  breath?: boolean; // fire breath every 3rd round
}

const m = (
  name: string, glyph: string, hp: number, ac: number, atk: number, dmg: Dice, threat: number,
  extra: Partial<MonsterDef> = {},
): MonsterDef => ({
  name, glyph, hp, ac, atk, dmg, threat, speed: 6, range: 1, attacks: 1, dex: 1, str: 1, wis: 0, verb: 'hits', xp: threat * 10, ...extra,
});

export const monsterSave = (def: MonsterDef, save: 'dex' | 'str' | 'wis') => def[save];

export const MONSTERS: Record<string, MonsterDef> = {
  // Act 1: Goblin Warrens
  rat: m('Giant Rat', '🐀', 7, 12, 4, { n: 1, d: 4, bonus: 2 }, 1, { dex: 2, verb: 'bites' }),
  kobold: m('Kobold', '🦎', 5, 12, 4, { n: 1, d: 4, bonus: 2 }, 1, { dex: 2, verb: 'stabs' }),
  goblin: m('Goblin', '👺', 7, 15, 4, { n: 1, d: 6, bonus: 2 }, 2, { dex: 2, verb: 'slashes' }),
  archer: m('Goblin Archer', '🏹', 7, 13, 4, { n: 1, d: 6, bonus: 2 }, 2, { dex: 2, range: 8, verb: 'shoots' }),
  hobgoblin: m('Hobgoblin Captain', '👿', 30, 17, 5, { n: 1, d: 8, bonus: 3 }, 10, { attacks: 2, str: 3, wis: 1, verb: 'cuts' }),
  goblin_king: m('Goblin King', '👑', 50, 16, 5, { n: 1, d: 10, bonus: 3 }, 0, { attacks: 2, dex: 2, str: 3, wis: 1, xp: 200, verb: 'slashes' }),
  mimic: m('Mimic', '📦', 30, 12, 4, { n: 1, d: 8, bonus: 2 }, 10, { attacks: 2, speed: 4, dex: 0, str: 3, verb: 'chomps' }),
  // Act 2: Forgotten Crypt
  skeleton: m('Skeleton', '💀', 13, 13, 4, { n: 1, d: 6, bonus: 2 }, 3, { dex: 2, wis: -1, verb: 'hacks' }),
  zombie: m('Zombie', '🧟', 22, 8, 3, { n: 1, d: 6, bonus: 1 }, 2, { speed: 4, dex: -2, str: 2, wis: -2, verb: 'claws' }),
  wolf: m('Wolf', '🐺', 11, 13, 4, { n: 2, d: 4, bonus: 2 }, 3, { speed: 8, dex: 2, verb: 'bites' }),
  spider: m('Giant Spider', '🕷️', 22, 14, 5, { n: 1, d: 8, bonus: 3 }, 5, { dex: 3, verb: 'bites' }),
  wight: m('Wight', '👻', 45, 14, 5, { n: 1, d: 8, bonus: 3 }, 12, { attacks: 2, dex: 2, str: 2, wis: 2, verb: 'drains' }),
  broodmother: m('Spider Broodmother', '🕸️', 50, 14, 6, { n: 1, d: 10, bonus: 3 }, 12, { dex: 3, str: 3, attacks: 2, verb: 'bites' }),
  bone_knight: m('Bone Knight', '☠️', 85, 17, 7, { n: 2, d: 6, bonus: 4 }, 0, { attacks: 2, str: 4, wis: 2, xp: 350, verb: 'cleaves' }),
  // Act 3: Dragon's Lair
  orc: m('Orc', '👹', 15, 13, 5, { n: 1, d: 12, bonus: 3 }, 4, { str: 3, verb: 'cleaves' }),
  cultist: m('Dragon Cultist', '🦹', 18, 12, 5, { n: 2, d: 6 }, 4, { range: 6, wis: 1, element: 'fire', verb: 'hurls fire at' }),
  ogre: m('Ogre', '🧌', 45, 11, 6, { n: 2, d: 8, bonus: 4 }, 8, { dex: -1, str: 4, wis: -2, verb: 'smashes' }),
  warchief: m('Orc Warchief', '🪓', 55, 16, 7, { n: 1, d: 12, bonus: 4 }, 16, { attacks: 2, str: 4, wis: 1, verb: 'cleaves' }),
  drake: m('Fire Drake', '🦖', 60, 15, 7, { n: 2, d: 6, bonus: 4 }, 16, { attacks: 2, str: 4, wis: 1, breath: true, verb: 'rends' }),
  wyrm: m('Dread Wyrm', '🐉', 110, 17, 8, { n: 2, d: 8, bonus: 4 }, 0, { attacks: 2, dex: 0, str: 5, wis: 3, xp: 500, breath: true, verb: 'rends' }),
};

/**
 * A handwritten encounter template. The fight draws monsters from `monsters` until the threat budget runs out
 * (list a type twice to make it twice as common), so the same template scales with party size and map row.
 */
export interface EncounterDef {
  name: string;
  monsters: string[];
  minRow?: number; // not used before this map row
}

export interface ActDef {
  name: string;
  glyph: string;
  pool: string[]; // every regular monster of the act (events draw from it)
  encounters: EncounterDef[];
  elites: string[];
  escorts: Record<string, string[]>; // elite -> monsters that may join it
  boss: string;
  minions: string[]; // join the boss
}

export const ACTS: ActDef[] = [
  {
    name: 'Goblin Warrens', glyph: '👺',
    pool: ['rat', 'kobold', 'goblin', 'archer'],
    encounters: [
      { name: 'Rat Nest', monsters: ['rat', 'rat', 'rat', 'kobold'] },
      { name: 'Goblin Patrol', monsters: ['goblin', 'goblin', 'archer'] },
      { name: 'Kobold Tunnel Crew', monsters: ['kobold', 'kobold', 'goblin'] },
      { name: 'Archer Nest', monsters: ['archer', 'archer', 'goblin'], minRow: 3 },
      { name: 'Goblin Warband', monsters: ['goblin', 'goblin', 'archer', 'kobold', 'rat'], minRow: 6 },
    ],
    elites: ['hobgoblin', 'mimic'],
    escorts: { hobgoblin: ['goblin', 'archer'], mimic: ['rat'] },
    boss: 'goblin_king', minions: ['goblin', 'archer'],
  },
  {
    name: 'Forgotten Crypt', glyph: '💀',
    pool: ['skeleton', 'zombie', 'wolf', 'spider'],
    encounters: [
      { name: 'Restless Dead', monsters: ['skeleton', 'zombie', 'zombie'] },
      { name: 'Wolf Pack', monsters: ['wolf', 'wolf', 'wolf'] },
      { name: 'Bone Sentries', monsters: ['skeleton', 'skeleton'] },
      { name: 'Spider Lair', monsters: ['spider', 'spider', 'wolf'], minRow: 3 },
      { name: 'Bone Legion', monsters: ['skeleton', 'skeleton', 'zombie', 'spider'], minRow: 6 },
    ],
    elites: ['wight', 'broodmother'],
    escorts: { wight: ['skeleton', 'zombie'], broodmother: ['spider', 'wolf'] },
    boss: 'bone_knight', minions: ['skeleton', 'zombie'],
  },
  {
    name: "Dragon's Lair", glyph: '🐉',
    pool: ['orc', 'cultist', 'kobold', 'ogre'],
    encounters: [
      { name: 'Orc Raiders', monsters: ['orc', 'orc', 'kobold'] },
      { name: 'Cult Ritual', monsters: ['cultist', 'cultist', 'kobold'] },
      { name: 'Kobold Swarm', monsters: ['kobold', 'kobold', 'kobold', 'cultist'] },
      { name: 'Ogre Brutes', monsters: ['ogre', 'kobold', 'kobold'], minRow: 4 },
      { name: "Dragon's Guard", monsters: ['orc', 'cultist', 'ogre', 'kobold'], minRow: 6 },
    ],
    elites: ['warchief', 'drake'],
    escorts: { warchief: ['orc', 'kobold'], drake: ['cultist', 'kobold'] },
    boss: 'wyrm', minions: ['kobold', 'cultist'],
  },
];

/** Threat budget for a regular fight. Grows with the act, the map row and the party size. */
export const encounterBudget = (act: number, row: number, partySize: number) =>
  (3 + 2 * (act - 1) + Math.floor(row / 3)) * (0.6 + 0.4 * partySize);

/** Elites and bosses get extra HP for every hero beyond the first. */
export const scaledHp = (hp: number, partySize: number, boss: boolean) =>
  Math.round(hp * (1 + (boss ? 0.3 : 0.25) * (partySize - 1)));

/** Gold for clearing a room. */
export const roomGold = (act: number, kind: NodeType) => (kind === 'boss' ? 4 : kind === 'elite' ? 2 : 1) * (8 + 4 * act);
