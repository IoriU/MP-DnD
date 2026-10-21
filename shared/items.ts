// Items: equipment (a weapon, armor and a trinket per hero), consumables (thrown, drunk or read, mostly in a fight),
// relics (party-wide perks for the rest of the run) and blessings (party-wide perks for the rest of the act).
// Like skills, content is data. Equipment stats are summed by `gearBonus` (the server's recalcHero and a few hooks
// read them); consumables are 'item' skills in shared/skills.ts, used like the potion; relics are hooks keyed by id.

import type { Dice, Resist, Stat } from './rules.ts';
import { SKILLS, statsOf, type Element, type StatusApply } from './skills.ts';
import type { PlayerEntity } from './types.ts';

export type Slot = 'weapon' | 'armor' | 'trinket';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
/** Worst to best. */
export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const SLOTS: Slot[] = ['weapon', 'armor', 'trinket'];
export const SLOT_NAME: Record<Slot, string> = { weapon: 'Weapon', armor: 'Armor', trinket: 'Trinket' };
export const BAG_SIZE = 8; // unequipped gear and consumables (potions are counted separately)

/** What a piece of equipment adds while it's worn. */
export interface GearStats {
  ac?: number;
  hp?: number; // max HP
  speed?: number;
  init?: number;
  saves?: number; // every saving throw and death save
  slots?: number; // max slots
  stealth?: number; // sneaking (the group Stealth check)
  hit?: number; // every attack roll
  dmg?: number; // basic weapon attacks
  power?: number; // attack rolls and save DC of cantrips and spells that use your casting stat
  heal?: number; // every heal you cast or drink
  shove?: number; // Shove contests; a win also pushes 1 tile further
  block?: number; // 🧱 Block at the start of each of your turns (until the next one)
  weapon?: { element: Element; dice: Dice }; // basic weapon hits deal this on top (and it reacts with the ground)
  onHit?: StatusApply[]; // basic weapon hits
  resist?: Partial<Record<Element, Resist>>;
  alert?: boolean; // can't be surprised
  lucky?: number; // rerolls of a natural 1 on an attack, per fight
  // build engines (shared/engines.ts)
  crit?: number; // your attacks crit this much sooner (19-20 for 1)
  thorns?: number; // melee attackers that hit you take this much
  lifesteal?: number; // percent of your melee damage you heal
  poison?: number; // basic weapon hits add this much Poison
  charges?: number; // Arcane Charges you start every fight with
  verses?: number; // Verses you start every fight with
  radiance?: number; // your radiant hits add this much Radiance
  stats?: Partial<Record<Stat, number>>; // +STR, +CON... on top of the hero's own
}

export interface GearDef {
  kind: 'gear';
  slot: Slot;
  name: string;
  icon: string;
  rarity: Rarity;
  stats: GearStats;
  note?: string; // flavor or rules the generated text can't say
}

/** A consumable is an 'item' skill (shared/skills.ts) of the same id: thrown, drunk or read like the potion. */
export interface ConsumableDef {
  kind: 'consumable';
  rarity: Rarity;
}

export type ItemDef = GearDef | ConsumableDef;

const d = (n: number, sides: number): Dice => ({ n, d: sides });
const gear = (slot: Slot, name: string, icon: string, rarity: Rarity, stats: GearStats, note?: string): GearDef => ({ kind: 'gear', slot, name, icon, rarity, stats, ...(note ? { note } : {}) });
const use = (rarity: Rarity): ConsumableDef => ({ kind: 'consumable', rarity });

const ITEM_DEFS = {
  // ---------------------------------------------- weapons: they change your basic attacks, whatever your class
  fine_blade: gear('weapon', 'Fine Blade', '🗡️', 'common', { hit: 1, dmg: 1 }),
  heavy_maul: gear('weapon', "Giant's Maul", '🔨', 'uncommon', { dmg: 3, hit: -1 }),
  venom_edge: gear('weapon', 'Venom Edge', '🐍', 'uncommon', { onHit: [{ id: 'poisoned', turns: 2 }] }),
  arcane_focus: gear('weapon', 'Arcane Focus', '🪄', 'uncommon', { power: 1 }, 'For spellcasters: sharper spells, harder saves.'),
  holy_symbol: gear('weapon', 'Holy Symbol', '📿', 'uncommon', { heal: 2 }),
  flametongue: gear('weapon', 'Flametongue', '🔥', 'rare', { weapon: { element: 'fire', dice: d(1, 6) } }, 'Its flames light the oil under your target.'),
  frostbrand: gear('weapon', 'Frostbrand', '❄️', 'rare', { weapon: { element: 'cold', dice: d(1, 6) } }, 'Chills, and freezes the Wet.'),
  stormcaller: gear('weapon', 'Stormcaller', '⚡', 'rare', { weapon: { element: 'lightning', dice: d(1, 6) } }, 'Shocks, and stuns the Wet.'),
  // ---------------------------------------------- armor
  padded_vest: gear('armor', 'Padded Vest', '🧥', 'common', { ac: 1 }),
  chain_shirt: gear('armor', 'Chain Shirt', '⛓️', 'uncommon', { ac: 2 }),
  plate_armor: gear('armor', 'Plate Armor', '🛡️', 'rare', { ac: 3, speed: -1 }),
  splint_mail: gear('armor', 'Splint Mail', '🪖', 'uncommon', { ac: 1, block: 2 }),
  elven_cloak: gear('armor', 'Elven Cloak', '🧝', 'uncommon', { ac: 1, stealth: 3 }),
  dragonscale: gear('armor', 'Dragonscale Mail', '🐉', 'rare', { ac: 2, resist: { fire: 'resist' } }),
  archmage_robe: gear('armor', 'Archmage Robe', '🥋', 'epic', { ac: 1, slots: 1, power: 1 }),
  // ---------------------------------------------- trinkets
  protection_ring: gear('trinket', 'Ring of Protection', '💍', 'uncommon', { ac: 1, saves: 1 }),
  health_amulet: gear('trinket', 'Amulet of Health', '❤️', 'uncommon', { hp: 8 }),
  speed_boots: gear('trinket', 'Boots of Speed', '🥾', 'uncommon', { speed: 2 }),
  vigilant_eye: gear('trinket', 'Eye of Vigilance', '🧿', 'uncommon', { init: 3, alert: true }),
  ogre_gauntlets: gear('trinket', 'Ogre Gauntlets', '🧤', 'common', { shove: 2 }),
  lucky_charm: gear('trinket', 'Lucky Charm', '🍀', 'common', { lucky: 1 }),
  antidote_charm: gear('trinket', 'Periapt of Purity', '💚', 'common', { resist: { poison: 'immune' } }),
  ember_ring: gear('trinket', 'Ring of Warmth', '🔆', 'common', { resist: { fire: 'resist', cold: 'resist' } }),
  buckler: gear('trinket', 'Buckler', '🥏', 'common', { block: 2 }),
  tower_shield: gear('trinket', 'Tower Shield', '🧱', 'epic', { block: 5, speed: -1 }),
  // ---------------------------------------------- engine gear (decided 2026-10-19): each one feeds a build
  keen_whetstone: gear('trinket', 'Keen Whetstone', '🔹', 'rare', { crit: 1 }),
  venom_vial: gear('trinket', 'Venom Vial', '🧪', 'uncommon', { poison: 1 }),
  spiked_pauldrons: gear('armor', 'Spiked Pauldrons', '🦔', 'rare', { ac: 1, thorns: 2 }),
  bloodstone: gear('trinket', 'Bloodstone', '🩸', 'rare', { lifesteal: 10 }),
  charged_orb: gear('weapon', 'Charged Orb', '🔮', 'epic', { power: 1, charges: 2 }, 'For spellcasters: it hums with stored power.'),
  lute_of_echoes: gear('trinket', 'Lute of Echoes', '🪕', 'rare', { verses: 2 }),
  sunstone: gear('trinket', 'Sunstone', '🌞', 'uncommon', { radiance: 1 }),
  // A stat each (playtest 1, 2026-10-21): gear can lift a stat past the +5 that levels and boons stop at.
  giant_belt: gear('trinket', 'Belt of Giant Strength', '🥋', 'uncommon', { stats: { str: 1 } }),
  thief_gloves: gear('trinket', 'Gloves of Thievery', '🧤', 'uncommon', { stats: { dex: 1 }, stealth: 1 }),
  fortitude_stone: gear('trinket', 'Ioun Stone of Fortitude', '💎', 'uncommon', { stats: { con: 1 } }),
  intellect_headband: gear('trinket', 'Headband of Intellect', '🎓', 'uncommon', { stats: { int: 1 } }),
  wisdom_periapt: gear('trinket', 'Periapt of Wisdom', '📿', 'uncommon', { stats: { wis: 1 } }),
  splendor_circlet: gear('trinket', 'Circlet of Splendor', '👑', 'uncommon', { stats: { cha: 1 } }),
  champion_torc: gear('trinket', "Champion's Torc", '🏅', 'rare', { stats: { str: 1, con: 1 } }),
  sage_ring: gear('trinket', "Sage's Ring", '🔷', 'rare', { stats: { int: 1, wis: 1 } }),
  vorpal_blade: gear('weapon', 'Vorpal Blade', '⚔️', 'legendary', { crit: 2, dmg: 2 }, 'So sharp it finds the gaps in anything.'),
  ancient_aegis: gear('armor', 'Aegis of the Ancients', '🛡️', 'legendary', { ac: 2, block: 4 }),
  // ---------------------------------------------- consumables (their skills are in shared/skills.ts)
  greater_potion: use('uncommon'),
  ether: use('uncommon'),
  oil_flask: use('common'),
  water_flask: use('common'),
  fire_bomb: use('common'),
  frost_bomb: use('common'),
  thunderstone: use('uncommon'),
  smoke_pellet: use('common'),
  stink_bomb: use('common'),
  scroll_healing: use('rare'),
  scroll_blessing: use('uncommon'),
} satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEM_DEFS;
export const ITEMS: Record<ItemId, ItemDef> = ITEM_DEFS;
export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];
export const GEAR_IDS = ITEM_IDS.filter((id) => ITEMS[id].kind === 'gear');
export const CONSUMABLE_IDS = ITEM_IDS.filter((id) => ITEMS[id].kind === 'consumable');

export const isItemId = (id: unknown): id is ItemId => typeof id === 'string' && Object.hasOwn(ITEMS, id);
export const isGear = (id: ItemId): boolean => ITEMS[id].kind === 'gear';
export const gearDef = (id: ItemId): GearDef | null => {
  const def = ITEMS[id];
  return def.kind === 'gear' ? def : null;
};

// ---------------------------------------------------------------- relics (party-wide, for the rest of the run)

export interface RelicDef {
  name: string;
  icon: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'boss'; // treasure and shops roll RELIC_ODDS; act bosses drop the boss ones
  desc: string;
}

const RELIC_DEFS = {
  eagle_eye: { name: 'Eagle Eye', icon: '🦅', rarity: 'uncommon', desc: "Every hero's first attack in each fight has advantage." },
  whetstone: { name: 'Whetstone', icon: '🪨', rarity: 'common', desc: '+1 damage on basic weapon attacks.' },
  golden_idol: { name: 'Golden Idol', icon: '🗿', rarity: 'common', desc: '+25% gold from fights and treasure.' },
  alchemist_kit: { name: "Alchemist's Kit", icon: '⚗️', rarity: 'uncommon', desc: 'Potions and scrolls heal 50% more.' },
  ember_stone: { name: 'Ember Stone', icon: '🔥', rarity: 'common', desc: '+2 damage on fire hits.' },
  frost_shard: { name: 'Frost Shard', icon: '🧊', rarity: 'common', desc: '+2 damage on cold hits.' },
  storm_rod: { name: 'Storm Rod', icon: '🌩️', rarity: 'common', desc: '+2 damage on lightning hits.' },
  war_banner: { name: 'War Banner', icon: '🚩', rarity: 'rare', desc: '+1 AC for every hero.' },
  wind_charm: { name: 'Wind Charm', icon: '🍃', rarity: 'uncommon', desc: '+1 movement for every hero.' },
  rations: { name: 'Hearty Rations', icon: '🍖', rarity: 'uncommon', desc: 'The party heals 10% more after every fight.' },
  battle_plans: { name: 'Battle Plans', icon: '🗺️', rarity: 'uncommon', desc: '+3 initiative for every hero.' },
  mana_crystal: { name: 'Mana Crystal', icon: '💠', rarity: 'rare', desc: '+1 max slot for every hero.' },
  owl_totem: { name: 'Owl Totem', icon: '🦉', rarity: 'common', desc: '+3 to sneaking.' },
  lodestone: { name: 'Lodestone', icon: '🧲', rarity: 'common', desc: 'Shoves push 1 tile further.' },
  vampire_fang: { name: 'Vampire Fang', icon: '🦷', rarity: 'rare', desc: 'Killing blows heal 3 HP.' },
  smelling_salts: { name: 'Smelling Salts', icon: '👃', rarity: 'common', desc: 'A hero healed back up from 0 HP gets 5 HP more.' },
  storm_coil: { name: 'Storm Coil', icon: '🌀', rarity: 'uncommon', desc: 'Lightning hits on the Wet deal +3.' },
  plague_censer: { name: 'Plague Censer', icon: '🏺', rarity: 'rare', desc: 'Every Poison a hero puts on a monster is 1 stronger.' },
  // act bosses drop these
  phoenix_feather: { name: 'Phoenix Feather', icon: '🪶', rarity: 'boss', desc: 'Once per fight, the first hero to drop to 0 HP rises again with half their HP.' },
  loaded_dice: { name: 'Loaded Dice', icon: '🎲', rarity: 'boss', desc: 'Every hero crits on a 19 or 20.' },
  crown_of_command: { name: 'Crown of Command', icon: '👑', rarity: 'boss', desc: '+1 to every hero attack roll and saving throw.' },
  dragon_heart: { name: 'Dragon Heart', icon: '🫀', rarity: 'boss', desc: '+10 max HP for every hero.' },
} satisfies Record<string, RelicDef>;

export type RelicId = keyof typeof RELIC_DEFS;
export const RELICS: Record<RelicId, RelicDef> = RELIC_DEFS;
export const RELIC_IDS = Object.keys(RELICS) as RelicId[];
export const isRelicId = (id: unknown): id is RelicId => typeof id === 'string' && Object.hasOwn(RELICS, id);

/** Flat numbers some relics add to every hero (the rest are hooks in server/game.ts). */
export const RELIC_STATS: Partial<Record<RelicId, GearStats>> = {
  war_banner: { ac: 1 },
  wind_charm: { speed: 1 },
  battle_plans: { init: 3 },
  mana_crystal: { slots: 1 },
  owl_totem: { stealth: 3 },
  dragon_heart: { hp: 10 },
  crown_of_command: { hit: 1, saves: 1 },
};

// ---------------------------------------------------------------- blessings (party-wide, until the end of the act)

export interface BlessingDef {
  name: string;
  icon: string;
  desc: string;
}

const BLESSING_DEFS = {
  valor: { name: 'Blessing of Valor', icon: '⚔️', desc: '+1 to every attack roll and +1 damage on basic attacks.' },
  bulwark: { name: 'Blessing of the Bulwark', icon: '🛡️', desc: '+1 AC for every hero.' },
  vigor: { name: 'Blessing of Vigor', icon: '❤️', desc: '+8 max HP for every hero.' },
  arcana: { name: 'Blessing of Arcana', icon: '🔮', desc: '+1 max slot, and +1 to spell attacks and save DCs.' },
  haste: { name: 'Blessing of Haste', icon: '💨', desc: '+1 movement and +3 initiative.' },
  fortune: { name: 'Blessing of Fortune', icon: '🍀', desc: '+2 to saving throws, and reroll one natural 1 on an attack each fight.' },
  warding: { name: 'Blessing of Warding', icon: '🌈', desc: 'Resist fire, cold and lightning (half damage).' },
  renewal: { name: 'Blessing of Renewal', icon: '🌿', desc: 'Every hero heals 2 HP at the start of each of their turns in a fight.' },
} satisfies Record<string, BlessingDef>;

export type BlessingId = keyof typeof BLESSING_DEFS;
export const BLESSINGS: Record<BlessingId, BlessingDef> = BLESSING_DEFS;
export const BLESSING_IDS = Object.keys(BLESSINGS) as BlessingId[];
export const isBlessingId = (id: unknown): id is BlessingId => typeof id === 'string' && Object.hasOwn(BLESSINGS, id);
export const RENEWAL_HP = 2;

/** Flat numbers blessings add to every hero (Renewal is a hook in server/game.ts). */
export const BLESSING_STATS: Partial<Record<BlessingId, GearStats>> = {
  valor: { hit: 1, dmg: 1 },
  bulwark: { ac: 1 },
  vigor: { hp: 8 },
  arcana: { slots: 1, power: 1 },
  haste: { speed: 1, init: 3 },
  fortune: { saves: 2, lucky: 1 },
  warding: { resist: { fire: 'resist', cold: 'resist', lightning: 'resist' } },
};

// ---------------------------------------------------------------- prices

export const GEAR_PRICE: Record<Rarity, number> = { common: 45, uncommon: 75, rare: 120, epic: 150, legendary: 180 };
export const CONSUMABLE_PRICE: Record<Rarity, number> = { common: 20, uncommon: 35, rare: 50, epic: 65, legendary: 80 };
export const RELIC_PRICE = 140;
export const POTION_PRICE = 25;
export const FORGET_PRICE = 30; // shop service: forget a skill to make room
export const trainPrice = (act: number) => 50 + 25 * act; // shop service: upgrade a cantrip or spell
export const SELL_SHARE = 0.5;

// ---------------------------------------------------------------- rarity rolls (decided 2026-10-19: rare things stay rare)

/**
 * Rarity odds in percent, by act: victory item cards, shops, event and elite gear all roll on this. Elites roll on the
 * next act's odds and never drop commons. Act 1 almost never shows an epic.
 */
export const RARITY_ODDS: Record<number, Record<Rarity, number>> = {
  1: { common: 65, uncommon: 28, rare: 6, epic: 1, legendary: 0 },
  2: { common: 45, uncommon: 36, rare: 14, epic: 4, legendary: 1 },
  3: { common: 28, uncommon: 38, rare: 23, epic: 8, legendary: 3 },
};
/** Pity (Slay the Spire's rare-card offset): each item card below rare moves this many points from common to rare. */
export const RARITY_PITY = 2;
/** Relic odds in percent for treasure and shops (Slay the Spire's chests): boss relics only come from act bosses. */
export const RELIC_ODDS: Record<'common' | 'uncommon' | 'rare', number> = { common: 50, uncommon: 33, rare: 17 };

const clampAct = (act: number) => Math.min(3, Math.max(1, act));

/** The odds a roll uses: the act's, the next act's for an elite (no commons), with `pity` points moved to rare. */
export function rarityOdds(act: number, opts: { pity?: number; elite?: boolean } = {}): Record<Rarity, number> {
  const odds = { ...RARITY_ODDS[clampAct(act + (opts.elite ? 1 : 0))] };
  if (opts.elite) [odds.uncommon, odds.common] = [odds.uncommon + odds.common, 0];
  const shift = Math.min(opts.pity ?? 0, odds.common);
  odds.common -= shift;
  odds.rare += shift;
  return odds;
}

/** A rarity from a 0..1 roll on `odds`. */
export function pickRarity<R extends string>(roll: number, odds: Record<R, number>): R {
  const keys = Object.keys(odds) as R[];
  let x = roll * keys.reduce((s, k) => s + odds[k], 0);
  for (const k of keys) if ((x -= odds[k]) < 0) return k;
  return keys.filter((k) => odds[k] > 0).pop() ?? keys[0];
}

export const rollRarity = (roll: number, act: number, opts: { pity?: number; elite?: boolean } = {}): Rarity => pickRarity(roll, rarityOdds(act, opts));

/** The ids of the rarity wanted, or else of the nearest rarity there is (worse first, then better). */
export function rarityPool<T>(ids: T[], rarityOf: (id: T) => Rarity, want: Rarity): T[] {
  const i = RARITIES.indexOf(want);
  const order = [...RARITIES.slice(0, i + 1).reverse(), ...RARITIES.slice(i + 1)];
  for (const r of order) {
    const pool = ids.filter((id) => rarityOf(id) === r);
    if (pool.length) return pool;
  }
  return [];
}

/** A hero's pity after an item card of this rarity: a rare or better resets it, anything else adds RARITY_PITY. */
export const nextPity = (pity: number | undefined, r: Rarity) => (RARITIES.indexOf(r) >= RARITIES.indexOf('rare') ? 0 : (pity ?? 0) + RARITY_PITY);

export const itemPrice = (id: ItemId): number => {
  const def = ITEMS[id];
  return def.kind === 'gear' ? GEAR_PRICE[def.rarity] : CONSUMABLE_PRICE[def.rarity];
};
export const sellPrice = (id: ItemId) => Math.floor(itemPrice(id) * SELL_SHARE);

// ---------------------------------------------------------------- reading a hero's gear

type Geared = Partial<Pick<PlayerEntity, 'gear' | 'relics' | 'blessings' | 'skills'>>;

/** Every equipment, relic, blessing and passive perk stat block that applies to a hero. */
export function statBlocks(p: Geared): GearStats[] {
  const out: GearStats[] = [];
  for (const o of p.skills ?? []) {
    const perk = SKILLS[o.id]?.kind === 'passive' ? statsOf(o).perk : undefined;
    if (perk) out.push(perk);
  }
  for (const id of Object.values(p.gear ?? {})) {
    const def = id && isItemId(id) ? gearDef(id) : null;
    if (def) out.push(def.stats);
  }
  for (const r of p.relics ?? []) {
    const st = RELIC_STATS[r];
    if (st) out.push(st);
  }
  for (const b of p.blessings ?? []) {
    const st = BLESSING_STATS[b];
    if (st) out.push(st);
  }
  return out;
}

type NumKey =
  | 'ac' | 'hp' | 'speed' | 'init' | 'saves' | 'slots' | 'stealth' | 'hit' | 'dmg' | 'power' | 'heal' | 'shove' | 'lucky' | 'block'
  | 'crit' | 'thorns' | 'lifesteal' | 'poison' | 'charges' | 'verses' | 'radiance';

/** What a hero's equipment adds to one of their stats. */
export const gearStat = (p: Geared, stat: Stat): number => statBlocks(p).reduce((s, st) => s + (st.stats?.[stat] ?? 0), 0);

/** The sum of one number over a hero's equipment and the party's relics and blessings. */
export const gearBonus = (p: Geared, key: NumKey): number => statBlocks(p).reduce((s, st) => s + (st[key] ?? 0), 0);

/** Equipment that makes a hero alert (can't be surprised). */
export const gearAlert = (p: Geared): boolean => statBlocks(p).some((st) => st.alert);

/** The strongest resistance a hero's equipment gives against an element. */
export function gearResist(p: Geared, el: Element): Resist | null {
  const order: Resist[] = ['absorb', 'immune', 'resist'];
  let best: Resist | null = null;
  for (const st of statBlocks(p)) {
    const r = st.resist?.[el];
    if (r && (!best || order.indexOf(r) < order.indexOf(best))) best = r;
  }
  return best;
}

/** The weapon's extra elemental damage and on-hit statuses, for basic attacks. */
export function weaponExtras(p: Geared): { weapon?: GearStats['weapon']; onHit: StatusApply[] } {
  const id = p.gear?.weapon;
  const def = id && isItemId(id) ? gearDef(id) : null;
  return { weapon: def?.stats.weapon, onHit: def?.stats.onHit ?? [] };
}

/** Bag room left. */
export const bagRoom = (p: Pick<PlayerEntity, 'bag'>) => BAG_SIZE - p.bag.length;

// ---------------------------------------------------------------- descriptions

const ELEMENT_NAME: Record<Element, string> = { physical: '', fire: 'fire', cold: 'cold', lightning: 'lightning', poison: 'poison', radiant: 'radiant', force: 'force' };
const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** Rules text for equipment, generated from its stats. */
export function describeStats(st: GearStats): string {
  const parts: string[] = [];
  for (const [stat, n] of Object.entries(st.stats ?? {})) if (n) parts.push(`${fmt(n)} ${stat.toUpperCase()}`);
  if (st.ac) parts.push(`${fmt(st.ac)} AC`);
  if (st.hp) parts.push(`${fmt(st.hp)} max HP`);
  if (st.speed) parts.push(`${fmt(st.speed)} movement`);
  if (st.init) parts.push(`${fmt(st.init)} initiative`);
  if (st.saves) parts.push(`${fmt(st.saves)} to saves`);
  if (st.slots) parts.push(`${fmt(st.slots)} max slot${Math.abs(st.slots) > 1 ? 's' : ''}`);
  if (st.stealth) parts.push(`${fmt(st.stealth)} to sneaking`);
  if (st.hit) parts.push(`${fmt(st.hit)} to attack rolls`);
  if (st.dmg) parts.push(`${fmt(st.dmg)} damage with basic attacks`);
  if (st.power) parts.push(`${fmt(st.power)} to spell attacks and save DC`);
  if (st.heal) parts.push(`${fmt(st.heal)} to every heal`);
  if (st.shove) parts.push(`${fmt(st.shove)} to Shove, and a won Shove pushes 1 tile further`);
  if (st.block) parts.push(`🧱 ${st.block} Block at the start of each of your turns`);
  if (st.weapon) parts.push(`basic attacks deal +${st.weapon.dice.n}d${st.weapon.dice.d} ${ELEMENT_NAME[st.weapon.element]}`);
  if (st.onHit?.length) parts.push(`basic attacks inflict ${st.onHit.map((x) => `${x.id} (${x.turns} turns)`).join(', ')}`);
  if (st.resist) {
    for (const [el, r] of Object.entries(st.resist)) parts.push(`${r === 'immune' ? 'immune to' : r === 'absorb' ? 'healed by' : 'resists'} ${ELEMENT_NAME[el as Element]}`);
  }
  if (st.alert) parts.push("can't be surprised");
  if (st.lucky) parts.push(`reroll ${st.lucky === 1 ? 'a natural 1' : `${st.lucky} natural 1s`} on attacks per fight`);
  if (st.crit) parts.push(`your attacks crit on ${20 - st.crit} or higher`);
  if (st.thorns) parts.push(`melee attackers that hit you take ${st.thorns}`);
  if (st.lifesteal) parts.push(`your melee hits heal you ${st.lifesteal}% of the damage`);
  if (st.poison) parts.push(`basic attacks add ${st.poison} Poison`);
  if (st.charges) parts.push(`start every fight with ${st.charges} Arcane Charges`);
  if (st.verses) parts.push(`start every fight with ${st.verses} Verses`);
  if (st.radiance) parts.push(`your radiant hits add ${st.radiance} Radiance`);
  const text = parts.join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) + '.' : '';
}

/** The usual game colors: grey, green, blue, purple, orange. */
export const RARITY_COLOR: Record<Rarity, string> = { common: '#c9d1d9', uncommon: '#6fdc8c', rare: '#58a6ff', epic: '#b57bff', legendary: '#f2a03d' };
