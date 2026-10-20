// Elites and the party's side of the fight: elite traits, NPC allies, and who is whose enemy.
// NPC allies are monsters (MONSTERS stat blocks, the monster AI) with `ally` set: they fight for the party.

import type { Resist } from './rules.ts';
import type { Element } from './skills.ts';
import type { Entity, MonsterEntity } from './types.ts';

// ---------------------------------------------------------------- sides

/** A monster fighting against the party (not an NPC ally). */
export const isFoe = (e: Entity | undefined): e is MonsterEntity & { ally?: false } => !!e && e.kind === 'monster' && !e.ally;

/** An NPC ally fighting for the party. */
export const isAllyNpc = (e: Entity | undefined): e is MonsterEntity & { ally: true } => !!e && e.kind === 'monster' && !!e.ally;

/** Heroes and NPC allies are on one side, the monsters on the other. */
export const sameSide = (a: Entity, b: Entity) => isFoe(a) === isFoe(b);

// ---------------------------------------------------------------- elite traits

export type TraitId = 'shielded' | 'vampiric' | 'enraged' | 'swift' | 'summoner' | 'burning' | 'frost' | 'storm';

export interface TraitDef {
  name: string; // also the adjective in front of the elite's name ("Burning Hobgoblin Captain")
  icon: string;
  desc: string;
  aura?: Element; // its attacks deal this element, it scorches whoever stands next to it, and it's immune to it
}

export const TRAITS: Record<TraitId, TraitDef> = {
  shielded: { name: 'Shielded', icon: '🔰', desc: 'A magic ward soaks the first quarter of its HP in damage. Once it breaks, it comes back one time, on the next 3rd round.' },
  vampiric: { name: 'Vampiric', icon: '🩸', desc: 'Heals half the damage its attacks deal.' },
  enraged: { name: 'Enraged', icon: '😡', desc: 'Below half HP it attacks one extra time each turn and deals +2 damage.' },
  swift: { name: 'Swift', icon: '💨', desc: '+3 movement, +5 initiative and +1 AC.' },
  summoner: { name: 'Summoner', icon: '📯', desc: 'Calls in a minion every other round (3 at most).' },
  burning: { name: 'Burning', icon: '🔥', aura: 'fire', desc: 'Its attacks deal fire. At the start of its turn it scorches everyone next to it (1d6 fire). Immune to fire.' },
  frost: { name: 'Frost', icon: '❄️', aura: 'cold', desc: 'Its attacks deal cold. At the start of its turn it chills everyone next to it (1d6 cold). Immune to cold.' },
  storm: { name: 'Storm', icon: '⚡', aura: 'lightning', desc: 'Its attacks deal lightning. At the start of its turn it shocks everyone next to it (1d6 lightning). Immune to lightning.' },
};

export const TRAIT_IDS = Object.keys(TRAITS) as TraitId[];
export const isTraitId = (id: unknown): id is TraitId => typeof id === 'string' && Object.hasOwn(TRAITS, id);

export const AURA_DICE = { n: 1, d: 6 };
export const WARD_SHARE = 0.25; // Shielded: the ward soaks this share of max HP
export const WARD_EVERY = 3; // ...and re-forms once, on the next 3rd round after it breaks (every time made late-act elites unkillable)
export const SUMMON_EVERY = 2; // Summoner: calls a minion on every 2nd round
export const MAX_SUMMONS = 3;
export const ENRAGED_DMG = 2;

/** How many traits an elite gets in this act: one in act 1, then one or two (two always made act 3's elites spike). */
export const traitCount = (act: number, roll: number) => (act <= 1 ? 1 : roll < 0.5 ? 1 : 2);

export const hasTrait = (e: Entity, t: TraitId) => e.kind === 'monster' && !!e.traits?.includes(t);

/** The element of an elite's aura (Burning, Frost, Storm), if it has one. */
export function auraOf(e: Entity): Element | undefined {
  if (e.kind !== 'monster') return undefined;
  for (const t of e.traits ?? []) if (TRAITS[t]?.aura) return TRAITS[t].aura;
  return undefined;
}

/** An aura makes an elite immune to its own element. */
export const traitResist = (e: Entity, el: Element): Resist | null => (auraOf(e) === el ? 'immune' : null);

// ---------------------------------------------------------------- NPC allies

export type AllyId = 'sellsword' | 'acolyte' | 'ranger' | 'hound';

export interface AllyDef {
  monster: string; // its stat block in MONSTERS (shared/rules.ts)
  desc: string;
  heals?: boolean; // heals the most hurt hero in range instead of attacking, when someone needs it
  hunts?: boolean; // goes for the enemy archers and casters first
  names: string[];
}

export const ALLIES: Record<AllyId, AllyDef> = {
  sellsword: { monster: 'sellsword', desc: 'A hired blade who wades in and hits hard.', names: ['Brann', 'Kessa', 'Old Hob', 'Varga'] },
  acolyte: { monster: 'acolyte', desc: 'Heals the most hurt hero in range (even a downed one); otherwise smites with radiant light.', heals: true, names: ['Brother Aldo', 'Sister Mira', 'Pell', 'Ysolde'] },
  ranger: { monster: 'ranger', desc: 'An archer who shoots from a distance.', names: ['Fennick', 'Lark', 'Tamsin', 'Quill'] },
  hound: { monster: 'war_hound', desc: 'A fast war dog that runs down archers and casters.', hunts: true, names: ['Biscuit', 'Fang', 'Old Yeller', 'Muddle'] },
};

export const ALLY_IDS = Object.keys(ALLIES) as AllyId[];
export const isAllyId = (id: unknown): id is AllyId => typeof id === 'string' && Object.hasOwn(ALLIES, id);

export const ALLY_FIGHTS = 3; // an NPC ally fights for the party this many fights
export const MAX_ALLIES = 2;

/** Allies grow with the act: more HP, better aim, harder hits. */
export const allyScaling = (act: number) => ({ hp: 1 + 0.5 * (act - 1), atk: act - 1, dmg: 2 * (act - 1) });
