// Game rules: dice, classes, abilities and monsters. A simplified take on D&D 5e.
// Tweak numbers here to rebalance the game; both server and client read from this file.

import { gearBonus } from './items.ts';
import type { Element, SkillId, StatusApply } from './skills.ts';
import type { CloudId, GroundId } from './surfaces.ts';
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
  role?: Role; // how it fights (default: archer if it shoots, else brute)
  shove?: boolean; // shoves heroes into fire, poison and other hazards when it can (STR contest, like the heroes' Shove)
  support?: { heal: Dice; buff: StatusApply }; // a support's spells, at its attack range: mend a hurt friend, or buff one
}

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
  kobold: m('Kobold', '🦎', 5, 12, 4, { n: 1, d: 4, bonus: 2 }, 1, { dex: 2, role: 'coward', verb: 'stabs' }),
  goblin: m('Goblin', '👺', 7, 15, 4, { n: 1, d: 6, bonus: 2 }, 2, { dex: 2, role: 'skirmisher', verb: 'slashes' }),
  archer: m('Goblin Archer', '🏹', 7, 13, 4, { n: 1, d: 6, bonus: 2 }, 2, { dex: 2, range: 8, verb: 'shoots' }),
  firebomber: m('Goblin Firebomber', '💣', 7, 12, 4, { n: 1, d: 6, bonus: 1 }, 3, { dex: 2, range: 6, element: 'fire', verb: 'lobs a firebomb at' }),
  shaman: m('Goblin Shaman', '🔮', 9, 12, 3, { n: 1, d: 4, bonus: 1 }, 3, {
    range: 6, wis: 2, element: 'lightning', role: 'support', verb: 'zaps',
    support: { heal: { n: 1, d: 8, bonus: 2 }, buff: { id: 'blessed', turns: 2 } },
  }),
  hobgoblin: m('Hobgoblin Captain', '👿', 30, 17, 5, { n: 1, d: 8, bonus: 3 }, 10, { attacks: 2, str: 3, wis: 1, shove: true, verb: 'cuts' }),
  goblin_king: m('Goblin King', '👑', 50, 16, 5, { n: 1, d: 10, bonus: 3 }, 0, { attacks: 2, dex: 2, str: 3, wis: 1, xp: 200, shove: true, verb: 'slashes' }),
  mimic: m('Mimic', '📦', 30, 12, 4, { n: 1, d: 8, bonus: 2 }, 10, { attacks: 2, speed: 4, dex: 0, str: 3, verb: 'chomps' }),
  // Act 2: Forgotten Crypt
  skeleton: m('Skeleton', '💀', 13, 13, 4, { n: 1, d: 6, bonus: 2 }, 3, { dex: 2, wis: -1, resist: { poison: 'immune' }, verb: 'hacks' }),
  zombie: m('Zombie', '🧟', 22, 8, 3, { n: 1, d: 6, bonus: 1 }, 2, { speed: 4, dex: -2, str: 2, wis: -2, resist: { poison: 'immune', fire: 'weak' }, verb: 'claws' }),
  bloated: m('Bloated Zombie', '🤮', 18, 8, 3, { n: 1, d: 6, bonus: 1 }, 2, {
    speed: 4, dex: -2, str: 2, wis: -2, resist: { poison: 'immune' }, verb: 'slaps',
    death: { ground: 'poison', radius: 1, text: 'bursts in a spray of poison' },
  }),
  wolf: m('Wolf', '🐺', 11, 13, 4, { n: 2, d: 4, bonus: 2 }, 3, { speed: 8, dex: 2, role: 'skirmisher', verb: 'bites' }),
  spider: m('Giant Spider', '🕷️', 22, 14, 5, { n: 1, d: 8, bonus: 3 }, 5, { dex: 3, role: 'skirmisher', resist: { poison: 'resist' }, verb: 'bites' }),
  necromancer: m('Necromancer', '🧛', 16, 12, 4, { n: 1, d: 8 }, 5, {
    range: 6, wis: 2, element: 'cold', role: 'support', resist: { cold: 'resist' }, verb: 'sends a chill at',
    support: { heal: { n: 2, d: 6, bonus: 2 }, buff: { id: 'shielded', turns: 2, power: 2 } },
  }),
  wight: m('Wight', '👻', 45, 14, 5, { n: 1, d: 8, bonus: 3 }, 12, { attacks: 2, dex: 2, str: 2, wis: 2, element: 'cold', resist: { poison: 'immune', cold: 'resist' }, verb: 'drains' }),
  broodmother: m('Spider Broodmother', '🕸️', 50, 14, 6, { n: 1, d: 10, bonus: 3 }, 12, { dex: 3, str: 3, attacks: 2, resist: { poison: 'resist' }, verb: 'bites' }),
  bone_knight: m('Bone Knight', '☠️', 85, 17, 7, { n: 2, d: 6, bonus: 4 }, 0, { attacks: 2, str: 4, wis: 2, xp: 350, shove: true, resist: { poison: 'immune' }, verb: 'cleaves' }),
  // Act 3: Dragon's Lair
  orc: m('Orc', '👹', 15, 13, 5, { n: 1, d: 12, bonus: 3 }, 4, { str: 3, shove: true, verb: 'cleaves' }),
  cultist: m('Dragon Cultist', '🦹', 18, 12, 5, { n: 2, d: 6 }, 4, { range: 6, wis: 1, element: 'fire', resist: { fire: 'resist' }, verb: 'hurls fire at' }),
  imp: m('Magma Imp', '😈', 16, 13, 5, { n: 1, d: 6, bonus: 2 }, 4, {
    range: 4, dex: 3, element: 'fire', resist: { fire: 'absorb', cold: 'weak' }, verb: 'spits magma at',
    death: { ground: 'fire', radius: 1, text: 'collapses into a pool of fire' },
  }),
  ogre: m('Ogre', '🧌', 45, 11, 6, { n: 2, d: 8, bonus: 4 }, 8, { dex: -1, str: 4, wis: -2, shove: true, verb: 'smashes' }),
  priest: m('Dragon Priest', '🕯️', 20, 13, 5, { n: 1, d: 8, bonus: 1 }, 5, {
    range: 6, wis: 2, element: 'fire', role: 'support', resist: { fire: 'resist' }, verb: 'scorches',
    support: { heal: { n: 2, d: 8, bonus: 2 }, buff: { id: 'blessed', turns: 2 } },
  }),
  warchief: m('Orc Warchief', '🪓', 55, 16, 7, { n: 1, d: 12, bonus: 4 }, 16, { attacks: 2, str: 4, wis: 1, shove: true, verb: 'cleaves' }),
  drake: m('Fire Drake', '🦖', 60, 15, 7, { n: 2, d: 6, bonus: 4 }, 16, { attacks: 2, str: 4, wis: 1, breath: true, resist: { fire: 'immune' }, verb: 'rends' }),
  wyrm: m('Dread Wyrm', '🐉', 110, 17, 8, { n: 2, d: 8, bonus: 4 }, 0, { attacks: 2, dex: 0, str: 5, wis: 3, xp: 500, breath: true, shove: true, resist: { fire: 'resist' }, verb: 'rends' }),
  // NPC allies (shared/elites.ts): they fight for the party; act 1 numbers, they grow with the act
  sellsword: m('Sellsword', '💂', 24, 15, 5, { n: 1, d: 8, bonus: 3 }, 0, { str: 3, xp: 0, shove: true, verb: 'cuts' }),
  acolyte: m('Acolyte', '😇', 16, 13, 4, { n: 1, d: 8 }, 0, {
    range: 6, wis: 3, xp: 0, element: 'radiant', role: 'support', verb: 'smites',
    support: { heal: { n: 1, d: 8, bonus: 3 }, buff: { id: 'blessed', turns: 2 } },
  }),
  ranger: m('Ranger', '🧝', 16, 14, 5, { n: 1, d: 8, bonus: 2 }, 0, { range: 8, dex: 3, xp: 0, verb: 'shoots' }),
  war_hound: m('War Hound', '🐕', 18, 13, 5, { n: 2, d: 4, bonus: 2 }, 0, { speed: 8, dex: 2, xp: 0, role: 'skirmisher', verb: 'bites' }),
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
    pool: ['rat', 'kobold', 'goblin', 'archer', 'firebomber', 'shaman'],
    encounters: [
      { name: 'Rat Nest', monsters: ['rat', 'rat', 'rat', 'kobold'] },
      { name: 'Goblin Patrol', monsters: ['goblin', 'goblin', 'archer'] },
      { name: 'Kobold Tunnel Crew', monsters: ['kobold', 'kobold', 'goblin'] },
      { name: 'Firebomb Squad', monsters: ['firebomber', 'goblin', 'kobold'], minRow: 2 },
      { name: 'Archer Nest', monsters: ['archer', 'archer', 'goblin'], minRow: 3 },
      { name: "Shaman's Circle", monsters: ['shaman', 'goblin', 'goblin', 'kobold'], minRow: 2 },
      { name: 'Goblin Warband', monsters: ['goblin', 'goblin', 'archer', 'firebomber', 'kobold', 'rat', 'shaman'], minRow: 6 },
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
    ],
    elites: ['warchief', 'drake'],
    escorts: { warchief: ['orc', 'kobold', 'priest'], drake: ['cultist', 'imp', 'kobold', 'priest'] },
    boss: 'wyrm', minions: ['kobold', 'cultist', 'imp'],
  },
];

// ---------------------------------------------------------------- difficulty

export type Difficulty = 'story' | 'normal' | 'hard';

/**
 * Picked in the lobby by the host, kept for the whole run. The numbers are placeholders until the balance pass (Phase 13).
 * `squad`: monsters fight as a squad (server/monsterai.ts); without it each one goes for whoever is closest.
 * `slip`: the chance a monster forgets the plan for a turn and just goes for the closest hero (readable, beatable).
 */
export interface DifficultyDef {
  name: string;
  icon: string;
  desc: string;
  hp: number; // monster HP multiplier
  atk: number; // added to monster attack rolls
  dmg: number; // added to monster damage
  budget: number; // encounter threat budget multiplier
  squad: boolean;
  slip: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  story: {
    name: 'Story', icon: '📖', hp: 0.75, atk: -1, dmg: 0, budget: 0.8, squad: false, slip: 1,
    desc: 'Weaker monsters that fight on instinct: each one goes for whoever is closest.',
  },
  normal: {
    name: 'Normal', icon: '⚔️', hp: 1, atk: 0, dmg: 0, budget: 1, squad: true, slip: 0.15,
    desc: 'Monsters fight as a squad: they gang up on one hero, flank, and use the battlefield.',
  },
  hard: {
    name: 'Hard', icon: '💀', hp: 1.2, atk: 1, dmg: 1, budget: 1.2, squad: true, slip: 0,
    desc: 'More monsters, tougher ones, and they never miss a trick.',
  },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES) as Difficulty[];
export const isDifficulty = (x: unknown): x is Difficulty => typeof x === 'string' && Object.hasOwn(DIFFICULTIES, x);

/** How much bigger fights get with more heroes: a solo hero is 1, a party of 6 faces 3 times as much. */
export const partyFactor = (partySize: number) => 0.6 + 0.4 * partySize;

/** Threat budget for a regular fight. Grows with the act, the map row and the party size. */
export const encounterBudget = (act: number, row: number, partySize: number) =>
  (3 + 2 * (act - 1) + Math.floor(row / 3)) * partyFactor(partySize);

/**
 * The monsters split into this many packs against a party (server/monsterai.ts squadPlan), each hunting its own hero:
 * one pack per "solo hero's worth" of monsters (partyFactor), so no one hero takes the whole fight. 3 at most.
 */
export const packsFor = (partySize: number) => Math.min(3, Math.max(1, Math.round(partyFactor(partySize))));

/** Elites and bosses get extra HP for every hero beyond the first. */
export const scaledHp = (hp: number, partySize: number, boss: boolean) =>
  Math.round(hp * (1 + (boss ? 0.3 : 0.25) * (partySize - 1)));

/** Gold for clearing a room. */
export const roomGold = (act: number, kind: NodeType) => (kind === 'boss' ? 4 : kind === 'elite' ? 2 : 1) * (8 + 4 * act);
