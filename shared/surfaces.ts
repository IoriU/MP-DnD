// Elements & surfaces (DOS2-style). The battlefield has a ground layer (water, ice, fire, oil, poison, lava),
// a cloud layer above it (steam, smoke, poison gas) and props (oil barrels, braziers). Elements react with them:
// fire ignites oil and blows up poison, lightning electrifies water, cold freezes it, water puts fires out.
//
// Everything here is pure and shared. The server runs it for real; the client runs it on a copy to preview what a
// skill will set off; the auto-play AI uses it to stay out of hazards and to look for combos.
//
// Durations count rounds and tick down at the start of every round. `turns: null` is permanent (room features).

import { DIRS, canStep, dist, findPath, type MapLike } from './grid.ts';
import { gearResist } from './items.ts';
import { MONSTERS, type Dice, type Resist } from './rules.ts';
import { hasBranch, hasStatus, type AimResult, type Element, type SkillStats, type StatusId } from './skills.ts';
import type { Entity, Pos } from './types.ts';

export type GroundId = 'water' | 'ice' | 'fire' | 'oil' | 'poison' | 'lava';
export type CloudId = 'steam' | 'smoke' | 'gas';
export type PropId = 'barrel' | 'brazier';
/** What reacts with the battlefield: three damage elements, plus water (Create Water, puddles). */
export type FieldElement = 'fire' | 'cold' | 'lightning' | 'water';

export interface Ground {
  id: GroundId;
  turns: number | null; // rounds left; null = permanent
  shock?: number; // water: rounds it stays electrified
  by?: string; // entity id of whoever made it (kill credit)
}

export interface Cloud {
  id: CloudId;
  turns: number;
  shock?: number; // steam: rounds it stays electrified
  by?: string;
}

// Keyed by tile index (y * width + x). Plain objects so they go over the wire as they are.
export type GroundMap = Partial<Record<number, Ground>>;
export type CloudMap = Partial<Record<number, Cloud>>;
export type PropMap = Partial<Record<number, PropId>>; // props stand on wall tiles ('#'): they block movement and sight

export interface FieldLike extends MapLike {
  ground: GroundMap;
  clouds: CloudMap;
  props: PropMap;
}

// ---------------------------------------------------------------- the rules, as data

export interface LayerInfo {
  name: string;
  icon: string;
  color: string; // for rendering
  turns: number; // default duration when something creates it (0 = never made by skills)
  desc: string;
}

export const GROUNDS: Record<GroundId, LayerInfo> = {
  water: { name: 'Water', icon: '💧', color: '#3f8fd8', turns: 4, desc: 'Makes you Wet: half fire damage and no Burning, but lightning stuns you and cold freezes you.' },
  ice: { name: 'Ice', icon: '🧊', color: '#cdefff', turns: 3, desc: 'Slippery: stepping onto it takes a DEX save (DC 12) or you fall and lose the rest of your movement. Melts into water.' },
  fire: { name: 'Fire', icon: '🔥', color: '#ff6a2b', turns: 2, desc: '1d4 fire and Burning when you step in or start your turn in it.' },
  oil: { name: 'Oil', icon: '🛢️', color: '#8a6a32', turns: 6, desc: 'Harmless until fire touches it: then all of the connected oil goes up in flames.' },
  poison: { name: 'Poison', icon: '☠️', color: '#79c23a', turns: 3, desc: '1d4 poison and Poisoned when you step in or start your turn in it. Fire makes it explode.' },
  lava: { name: 'Lava', icon: '🌋', color: '#ff3d00', turns: 0, desc: '2d6 fire and Burning when you step in or start your turn in it. Never goes out.' },
};

export const CLOUDS: Record<CloudId, LayerInfo> = {
  steam: { name: 'Steam', icon: '♨️', color: '#e8eef2', turns: 2, desc: 'Blocks line of sight and makes you Wet. Lightning electrifies it.' },
  smoke: { name: 'Smoke', icon: '🌫️', color: '#5d616b', turns: 3, desc: 'Blocks line of sight: nobody can shoot into, out of or through it.' },
  gas: { name: 'Poison Gas', icon: '🤢', color: '#9be04a', turns: 2, desc: 'Poisoned while you stand in it. Fire makes it explode.' },
};

export const PROPS: Record<PropId, { name: string; icon: string; desc: string }> = {
  barrel: { name: 'Oil Barrel', icon: '🛢️', desc: 'Hit it to spill oil around it. Fire makes it explode: 2d6 fire to everyone next to it, and burning oil all around.' },
  brazier: { name: 'Brazier', icon: '🏮', desc: 'Hit it to knock it over: burning coals spill fire all around it.' },
};

export const ELECTRIFIED = { name: 'Electrified', icon: '⚡', color: '#fff36b', desc: '1d4 lightning when you step in or start your turn in it. Wet creatures are stunned.' };

export const SHOCK_TURNS = 1; // electrified water and steam calm down at the start of the next round
export const OIL_FIRE_TURNS = 3; // burning oil lasts longer than a plain fire
export const EXPLOSION: Dice = { n: 2, d: 6 }; // fire damage to everyone within 1 tile of an explosion
export const ICE_DC = 12;
export const HAZARD_DICE: Partial<Record<GroundId | 'shock' | 'gas', Dice>> = {
  fire: { n: 1, d: 4 },
  lava: { n: 2, d: 6 },
  poison: { n: 1, d: 4 },
  shock: { n: 1, d: 4 },
};
/** Statuses the field puts on whoever stands in it (turns are the creature's turns, like any status). */
export const FIELD_STATUS_TURNS = 2;

export type ReactionKind = 'ignite' | 'explode' | 'electrify' | 'freeze' | 'melt' | 'steam' | 'douse' | 'spill' | 'topple' | 'wash';

export const REACTIONS: Record<ReactionKind, { text: string; color: string; log: string }> = {
  ignite: { text: '🔥 Ignited!', color: '#ff8a3d', log: 'The oil goes up in flames' },
  explode: { text: '💥 Explosion!', color: '#ffb04d', log: 'It explodes' },
  electrify: { text: '⚡ Electrified!', color: '#fff36b', log: 'Lightning crackles through it' },
  freeze: { text: '🧊 Frozen over!', color: '#cdefff', log: 'The water freezes over' },
  melt: { text: '💧 Melted!', color: '#8fd8ff', log: 'The ice melts' },
  steam: { text: '♨️ Steam!', color: '#e8eef2', log: 'A cloud of steam billows up' },
  douse: { text: '💨 Put out!', color: '#8fd8ff', log: 'The fire goes out' },
  spill: { text: '🛢️ Spilled!', color: '#c9a25a', log: 'Oil spills everywhere' },
  topple: { text: '🔥 Knocked over!', color: '#ff8a3d', log: 'Burning coals spill out' },
  wash: { text: '💧 Washed away!', color: '#8fd8ff', log: 'The water washes it away' },
};

/**
 * The combo table, for the rules screen and the README. `applyField` is the real implementation.
 * Rows: what's on the tile. Columns: the element that touches it.
 */
export const COMBOS: { on: string; fire?: string; cold?: string; lightning?: string; water?: string }[] = [
  { on: 'Water', fire: 'Steam cloud', cold: 'Ice', lightning: 'Electrified water (all of the puddle)' },
  { on: 'Oil', fire: 'Burning oil (all of it)', water: 'Washed away' },
  { on: 'Poison', fire: 'Explosion + fire', water: 'Washed away' },
  { on: 'Ice', fire: 'Melts into water' },
  { on: 'Fire', cold: 'Put out → water', water: 'Put out → steam' },
  { on: 'Steam', lightning: 'Electrified steam' },
  { on: 'Poison gas', fire: 'Explosion' },
  { on: 'Oil barrel', fire: 'Explosion + burning oil' },
];

// ---------------------------------------------------------------- operations

export type FieldOp =
  | { kind: 'touch'; tiles: number[]; element: FieldElement } // an element reaches these tiles
  | { kind: 'ground'; tiles: number[]; id: GroundId; turns?: number } // something creates a surface (it reacts with what's there)
  | { kind: 'cloud'; tiles: number[]; id: CloudId; turns?: number }
  | { kind: 'hit'; tile: number; element: Element; from?: number }; // an attack hits a prop (from: the attacker's tile)

export interface Reaction {
  kind: ReactionKind;
  tiles: number[];
}

export interface FieldResult {
  reactions: Reaction[];
  changed: number[]; // tiles whose ground or cloud became something new: whoever stands there is affected as if they'd stepped in
  blasts: number[]; // tiles caught in an explosion: whoever stands there takes EXPLOSION fire damage (once)
}

type Job =
  | { i: number; el: FieldElement; create?: number } // create: turns of the surface this element makes on bare ground
  | { i: number; put: GroundId; turns: number | null }
  | { i: number; cloud: CloudId; turns: number }
  | { i: number; hit: Element; from?: number };

const ELEMENT_OF: Partial<Record<GroundId, FieldElement>> = { water: 'water', ice: 'cold', fire: 'fire' };

/** Damage elements that react with the field. */
export function fieldElement(el: Element | undefined): FieldElement | null {
  return el === 'fire' || el === 'cold' || el === 'lightning' ? el : null;
}

const inRoom = (f: MapLike, i: number) => i >= 0 && i < f.width * f.height;
const isWallTile = (f: MapLike, i: number) => f.tiles[i] === '#';

/** Open tiles (and props) within `radius` of a spot. */
export function tilesAround(f: FieldLike, center: Pos, radius: number): number[] {
  const out: number[] = [];
  for (let y = center.y - radius; y <= center.y + radius; y++) {
    for (let x = center.x - radius; x <= center.x + radius; x++) {
      if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
      const i = y * f.width + x;
      if (!isWallTile(f, i) || f.props[i]) out.push(i);
    }
  }
  return out;
}

const neighbors = (f: FieldLike, i: number): number[] => {
  const x = i % f.width;
  const y = (i - x) / f.width;
  const out: number[] = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const n = ny * f.width + nx;
    if (!isWallTile(f, n) || f.props[n]) out.push(n);
  }
  return out;
};

/** A tile index as a position. */
export const tilePos = (f: MapLike, i: number): Pos => ({ x: i % f.width, y: Math.floor(i / f.width) });

/**
 * Runs field operations: surfaces appear, elements react, fire spreads across oil, poison explodes, lightning
 * runs through water. Mutates `f` (pass a `cloneField` copy to preview). `by` gets kill credit for what it makes.
 */
export function applyField(f: FieldLike, ops: FieldOp[], by?: string): FieldResult {
  const reactions = new Map<ReactionKind, Set<number>>();
  const changed = new Set<number>();
  const blasts = new Set<number>();
  const queue: Job[] = [];
  const note = (kind: ReactionKind, i: number) => {
    if (!reactions.has(kind)) reactions.set(kind, new Set());
    reactions.get(kind)!.add(i);
  };
  const setGround = (i: number, g: Omit<Ground, 'by'> | null) => {
    if (g) f.ground[i] = by ? { ...g, by } : { ...g };
    else delete f.ground[i];
    changed.add(i);
  };
  const setCloud = (i: number, c: Omit<Cloud, 'by'> | null) => {
    if (c) f.clouds[i] = by ? { ...c, by } : { ...c };
    else delete f.clouds[i];
    changed.add(i);
  };
  const clearProp = (i: number) => {
    delete f.props[i];
    f.tiles = f.tiles.slice(0, i) + '.' + f.tiles.slice(i + 1);
  };
  const explode = (i: number) => {
    note('explode', i);
    blasts.add(i);
    for (const n of neighbors(f, i)) {
      if (!isWallTile(f, n)) blasts.add(n);
      queue.push({ i: n, el: 'fire' }); // the blast touches everything around it with fire
    }
  };
  const electrify = (i: number, layer: 'ground' | 'cloud') => {
    // Lightning runs through every connected tile of the same water or steam.
    const isIt = (n: number) => (layer === 'ground' ? f.ground[n]?.id === 'water' : f.clouds[n]?.id === 'steam');
    const seen = new Set([i]);
    const todo = [i];
    const credit = by ? { by } : {};
    while (todo.length) {
      const cur = todo.pop()!;
      if (layer === 'ground') f.ground[cur] = { ...f.ground[cur]!, shock: SHOCK_TURNS, ...credit };
      else f.clouds[cur] = { ...f.clouds[cur]!, shock: SHOCK_TURNS, ...credit };
      changed.add(cur);
      note('electrify', cur);
      for (const n of neighbors(f, cur)) {
        if (!seen.has(n) && isIt(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
  };

  for (const op of ops) {
    if (op.kind === 'touch') for (const i of op.tiles) queue.push({ i, el: op.element });
    else if (op.kind === 'hit') queue.push({ i: op.tile, hit: op.element, ...(op.from !== undefined ? { from: op.from } : {}) });
    else if (op.kind === 'cloud') for (const i of op.tiles) queue.push({ i, cloud: op.id, turns: op.turns ?? CLOUDS[op.id].turns });
    else {
      const turns = op.turns ?? GROUNDS[op.id].turns;
      const el = ELEMENT_OF[op.id];
      for (const i of op.tiles) queue.push(el ? { i, el, create: turns } : { i, put: op.id, turns: op.id === 'lava' ? null : turns });
    }
  }

  for (let guard = 0; queue.length && guard < 5000; guard++) {
    const job = queue.shift()!;
    const i = job.i;
    if (!inRoom(f, i)) continue;
    const prop = f.props[i];

    if ('hit' in job) {
      if (prop === 'barrel') {
        if (job.hit === 'fire') queue.unshift({ i, el: 'fire' });
        else {
          clearProp(i);
          note('spill', i);
          for (const n of [i, ...neighbors(f, i)]) queue.push({ i: n, put: 'oil', turns: GROUNDS.oil.turns });
        }
      } else if (prop === 'brazier') {
        clearProp(i);
        note('topple', i);
        // The coals spill everywhere but onto whoever knocked it over.
        for (const n of [i, ...neighbors(f, i)]) if (n !== job.from) queue.push({ i: n, el: 'fire', create: GROUNDS.fire.turns });
      }
      continue;
    }

    if (prop) {
      // Props only care about fire: a barrel blows up in a ball of burning oil.
      if (prop === 'barrel' && 'el' in job && job.el === 'fire') {
        clearProp(i);
        explode(i);
        for (const n of [i, ...neighbors(f, i)]) if (!isWallTile(f, n)) queue.push({ i: n, put: 'oil', turns: GROUNDS.oil.turns });
        queue.push({ i, el: 'fire' });
      }
      continue;
    }
    if (isWallTile(f, i)) continue;
    const g = f.ground[i];
    const c = f.clouds[i];

    if ('cloud' in job) {
      setCloud(i, { id: job.cloud, turns: job.turns });
      if (job.cloud === 'gas' && (g?.id === 'fire' || g?.id === 'lava')) queue.push({ i, el: 'fire' });
      continue;
    }

    if ('put' in job) {
      if (g?.id === 'lava') continue; // nothing sticks to lava
      if (g?.id === job.put) {
        if (g.turns !== null && (job.turns === null || job.turns > g.turns)) f.ground[i] = { ...g, turns: job.turns };
        continue;
      }
      const burning = g?.id === 'fire';
      setGround(i, { id: job.put, turns: job.turns });
      if (burning && (job.put === 'oil' || job.put === 'poison')) queue.push({ i, el: 'fire' }); // poured onto a fire
      continue;
    }

    switch (job.el) {
      case 'fire':
        if (c?.id === 'gas') {
          setCloud(i, null);
          explode(i);
        }
        if (g?.id === 'oil') {
          setGround(i, { id: 'fire', turns: OIL_FIRE_TURNS });
          note('ignite', i);
          for (const n of neighbors(f, i)) if (f.ground[n]?.id === 'oil' || f.ground[n]?.id === 'poison') queue.push({ i: n, el: 'fire' });
        } else if (g?.id === 'poison') {
          setGround(i, { id: 'fire', turns: GROUNDS.fire.turns });
          explode(i);
          for (const n of neighbors(f, i)) if (f.ground[n]?.id === 'poison') queue.push({ i: n, el: 'fire' });
        } else if (g?.id === 'water') {
          setGround(i, null);
          setCloud(i, { id: 'steam', turns: CLOUDS.steam.turns });
          note('steam', i);
        } else if (g?.id === 'ice') {
          setGround(i, { id: 'water', turns: GROUNDS.water.turns });
          note('melt', i);
        } else if (g?.id === 'fire') {
          if (job.create && g.turns !== null && job.create > g.turns) f.ground[i] = { ...g, turns: job.create };
        } else if (!g && job.create) {
          setGround(i, { id: 'fire', turns: job.create });
        }
        break;
      case 'cold':
        if (g?.id === 'water') {
          setGround(i, { id: 'ice', turns: GROUNDS.ice.turns });
          note('freeze', i);
        } else if (g?.id === 'fire') {
          setGround(i, { id: 'water', turns: GROUNDS.water.turns });
          note('douse', i);
        } else if (g?.id === 'ice') {
          if (job.create && g.turns !== null && job.create > g.turns) f.ground[i] = { ...g, turns: job.create };
        } else if (job.create && g?.id !== 'lava') {
          setGround(i, { id: 'ice', turns: job.create });
        }
        break;
      case 'lightning':
        if (g?.id === 'water' && !g.shock) electrify(i, 'ground');
        if (c?.id === 'steam' && !c.shock) electrify(i, 'cloud');
        break;
      case 'water':
        if (g?.id === 'fire') {
          setGround(i, null);
          setCloud(i, { id: 'steam', turns: CLOUDS.steam.turns });
          note('douse', i);
        } else if (g?.id === 'water') {
          if (job.create && g.turns !== null && job.create > g.turns) f.ground[i] = { ...g, turns: job.create };
        } else if (job.create && g?.id !== 'ice' && g?.id !== 'lava') {
          if (g?.id === 'oil' || g?.id === 'poison') note('wash', i);
          setGround(i, { id: 'water', turns: job.create });
        }
        break;
    }
  }

  return {
    reactions: [...reactions].map(([kind, tiles]) => ({ kind, tiles: [...tiles] })),
    changed: [...changed],
    blasts: [...blasts],
  };
}

/** Start of a new round: surfaces and clouds burn out, ice melts, electricity fades. */
export function tickField(f: FieldLike): number[] {
  const changed: number[] = [];
  for (const [k, g] of Object.entries(f.ground)) {
    const i = Number(k);
    if (!g) continue;
    let next: Ground | null = { ...g };
    if (next.shock) {
      next.shock--;
      if (!next.shock) delete next.shock;
    }
    if (next.turns !== null) {
      next.turns--;
      if (next.turns <= 0) next = g.id === 'ice' ? { id: 'water', turns: GROUNDS.water.turns, ...(g.by ? { by: g.by } : {}) } : null;
    }
    if (next) f.ground[i] = next;
    else delete f.ground[i];
    if (!next || next.id !== g.id) changed.push(i);
  }
  for (const [k, c] of Object.entries(f.clouds)) {
    const i = Number(k);
    if (!c) continue;
    const next: Cloud = { ...c, turns: c.turns - 1 };
    if (next.shock) {
      next.shock--;
      if (!next.shock) delete next.shock;
    }
    if (next.turns <= 0) {
      delete f.clouds[i];
      changed.push(i);
    } else f.clouds[i] = next;
  }
  return changed;
}

/** A copy that `applyField` can scribble on (for previews). */
export function cloneField(f: FieldLike): FieldLike {
  return { width: f.width, height: f.height, tiles: f.tiles, ground: { ...f.ground }, clouds: { ...f.clouds }, props: { ...f.props } };
}

export const emptyField = (): Pick<FieldLike, 'ground' | 'clouds' | 'props'> => ({ ground: {}, clouds: {}, props: {} });

// ---------------------------------------------------------------- creatures and elements

/** How a creature takes an element: monsters by kind, heroes from equipment and passives (Attunement). */
export function resistance(e: Entity, el: Element): Resist | null {
  if (e.kind === 'monster') return MONSTERS[e.type]?.resist?.[el] ?? null;
  const worn = gearResist(e, el);
  if (worn) return worn;
  if (el === 'fire' && hasBranch(e, 'elemental_affinity', 'B')) return 'resist';
  return null;
}

/** Damage multiplier for an element: 0 immune, 0.5 resistant (or Wet against fire), 2 weak, -1 heals it. */
export function damageFactor(e: Entity, el: Element): number {
  const r = resistance(e, el);
  if (r === 'immune') return 0;
  if (r === 'absorb') return -1;
  let k = r === 'resist' ? 0.5 : r === 'weak' ? 2 : 1;
  if (el === 'fire' && hasStatus(e, 'wet')) k *= 0.5;
  return k;
}

/** Statuses a creature shrugs off: Burning if fire can't hurt it, Poisoned if poison can't. */
export function immuneToStatus(e: Entity, id: StatusId): boolean {
  if (id === 'burning') {
    const r = resistance(e, 'fire');
    return r === 'immune' || r === 'absorb' || (e.kind === 'player' && hasBranch(e, 'elemental_affinity', 'B'));
  }
  if (id === 'poisoned') return resistance(e, 'poison') === 'immune';
  return false;
}

/** True if this kind of fire or poison on the ground can't hurt the creature. */
function shrugsOff(e: Entity | undefined, harm: 'fire' | 'poison'): boolean {
  if (!e) return false;
  if (harm === 'fire') return immuneToStatus(e, 'burning');
  return immuneToStatus(e, 'poisoned');
}

/**
 * Roughly how much it hurts to stand here (expected damage, with stuns and falls priced in), 0 if it's safe.
 * Pathfinding and the AI use it; `who` adds immunities (a fire drake doesn't mind fire).
 */
export function hazardAt(f: FieldLike, i: number, who?: Entity): number {
  const g = f.ground[i];
  const c = f.clouds[i];
  let harm = 0;
  if (g?.id === 'fire' && !shrugsOff(who, 'fire')) harm += 5;
  if (g?.id === 'lava' && !shrugsOff(who, 'fire')) harm += 10;
  if (g?.id === 'poison' && !shrugsOff(who, 'poison')) harm += 4;
  if (g?.id === 'ice') harm += 1.5;
  if (g?.id === 'water' && g.shock) harm += 8;
  if (c?.id === 'gas' && !shrugsOff(who, 'poison')) harm += 2.5;
  if (c?.id === 'steam' && c.shock) harm += 8;
  return harm;
}

/** Shortest path that stays out of hazards, or null if there's none. */
export function safePath(f: FieldLike, from: Pos, blocked: (x: number, y: number) => boolean, goal: (x: number, y: number) => boolean, who?: Entity): Pos[] | null {
  return findPath(f, from, (x, y) => blocked(x, y) || hazardAt(f, y * f.width + x, who) > 0, goal);
}

/** Hazardous tiles along a path. */
export const hazardsOn = (f: FieldLike, path: Pos[], who?: Entity): Pos[] => path.filter((p) => hazardAt(f, p.y * f.width + p.x, who) > 0);

/** Within `moves` steps, the way to the goal through the least harm (ties: fewer steps), or null if it's out of reach. */
function leastHarmPath(
  f: FieldLike, from: Pos, blocked: (x: number, y: number) => boolean, goal: (x: number, y: number) => boolean, moves: number, who?: Entity,
): Pos[] | null {
  const w = f.width;
  let layer = new Map<number, number>([[from.y * w + from.x, 0]]); // tile -> least harm after this many steps
  const parents: Map<number, number>[] = [];
  let best: { steps: number; i: number; harm: number } | null = null;
  for (let steps = 1; steps <= moves && layer.size; steps++) {
    const next = new Map<number, number>();
    const parent = new Map<number, number>();
    for (const [i, harm] of layer) {
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of DIRS) {
        if (!canStep(f, { x, y }, dx, dy) || blocked(x + dx, y + dy)) continue;
        const n = (y + dy) * w + x + dx;
        const h = harm + hazardAt(f, n, who);
        if ((next.get(n) ?? Infinity) <= h) continue;
        next.set(n, h);
        parent.set(n, i);
      }
    }
    parents.push(parent);
    for (const [i, harm] of next) if (goal(i % w, Math.floor(i / w)) && (!best || harm < best.harm)) best = { steps, i, harm };
    layer = next;
  }
  if (!best) return null;
  const path: Pos[] = [];
  for (let i = best.i, steps = best.steps; steps >= 1; steps--) {
    path.push(tilePos(f, i));
    i = parents[steps - 1].get(i)!;
  }
  return path.reverse();
}

/**
 * The walk for a hero who clicked a tile: around hazards if that still gets there with the moves left; otherwise
 * through as few of them as it can, if that gets there this turn (the client warns before sending it); and the safe
 * way again when nothing gets there this turn. The server and the client both use it.
 */
export function planWalk(
  f: FieldLike, from: Pos, to: Pos, moves: number, blocked: (x: number, y: number) => boolean, who?: Entity,
): { path: Pos[]; hazards: Pos[] } | null {
  const goal = (x: number, y: number) => x === to.x && y === to.y;
  const destHazard = hazardAt(f, to.y * f.width + to.x, who) > 0;
  const safe = destHazard
    ? findPath(f, from, (x, y) => blocked(x, y) || (!goal(x, y) && hazardAt(f, y * f.width + x, who) > 0), goal)
    : safePath(f, from, blocked, goal, who);
  const done = (path: Pos[]) => ({ path, hazards: hazardsOn(f, path, who) });
  if (safe && safe.length <= moves) return done(safe);
  const least = leastHarmPath(f, from, blocked, goal, moves, who);
  if (least) return done(least);
  const far = safe ?? findPath(f, from, blocked, goal);
  return far ? done(far.slice(0, moves)) : null;
}

// ---------------------------------------------------------------- skills on the field

/** Where an area or surface lands for a skill (the target's tile, the area, or around you). */
function reach(s: SkillStats, caster: Pos, res: AimResult, f: FieldLike): number[] {
  const at = (p: Pos) => p.y * f.width + p.x;
  switch (s.target) {
    case 'enemy':
      return res.prop !== undefined ? [res.prop] : res.foes.map(at);
    case 'area':
      return tilesAround(f, res.center, s.radius ?? 1);
    case 'around':
      return tilesAround(f, caster, s.radius ?? 1).filter((i) => i !== at(caster));
    default:
      return [];
  }
}

/**
 * What a skill does to the battlefield, aimed as `res`: its element touches the tiles it reaches, and it may leave a
 * surface. Computed before the skill resolves (where everyone stood when it was cast) and run after its hits.
 * Surfaces centered on yourself (Smoke Bomb) come from `selfFieldOps`, after any teleport.
 */
export function aimFieldOps(s: SkillStats, caster: Pos, res: AimResult, f: FieldLike): FieldOp[] {
  const ops: FieldOp[] = [];
  const tiles = reach(s, caster, res, f);
  const el = fieldElement(s.element);
  if (res.prop !== undefined && s.target === 'enemy') ops.push({ kind: 'hit', tile: res.prop, element: s.element ?? 'physical', from: caster.y * f.width + caster.x });
  else if (el && tiles.length) ops.push({ kind: 'touch', tiles, element: el });
  const sf = s.surface;
  if (sf && sf.at !== 'self') {
    const center = res.prop !== undefined ? tilePos(f, res.prop) : res.center;
    const r = sf.radius ?? (s.target === 'area' ? (s.radius ?? 1) : 0);
    const area = tilesAround(f, center, r);
    if (sf.ground) ops.push({ kind: 'ground', tiles: area, id: sf.ground, ...(sf.turns ? { turns: sf.turns } : {}) });
    if (sf.cloud) ops.push({ kind: 'cloud', tiles: area, id: sf.cloud, ...(sf.turns ? { turns: sf.turns } : {}) });
  }
  return ops;
}

/** Surfaces a skill leaves around you (Smoke Bomb), from where you stand after it resolves. */
export function selfFieldOps(s: SkillStats, caster: Pos, f: FieldLike): FieldOp[] {
  const sf = s.surface;
  if (!sf || sf.at !== 'self') return [];
  const area = tilesAround(f, caster, sf.radius ?? 0);
  const ops: FieldOp[] = [];
  if (sf.ground) ops.push({ kind: 'ground', tiles: area, id: sf.ground, ...(sf.turns ? { turns: sf.turns } : {}) });
  if (sf.cloud) ops.push({ kind: 'cloud', tiles: area, id: sf.cloud, ...(sf.turns ? { turns: sf.turns } : {}) });
  return ops;
}

export interface FieldPreview {
  result: FieldResult;
  field: FieldLike; // the battlefield afterwards
  blasted: Entity[]; // caught in an explosion
  exposed: Entity[]; // standing where a hazard just appeared (fire, poison, electrified water...)
}

/** What a set of field operations would set off, without touching the real battlefield. */
export function previewField(f: FieldLike, ops: FieldOp[], entities: Entity[]): FieldPreview {
  const field = cloneField(f);
  const result = applyField(field, ops);
  const at = (e: Entity) => e.y * f.width + e.x;
  const alive = entities.filter((e) => !(e.kind === 'player' && (e.dead || e.downed)));
  const blastSet = new Set(result.blasts);
  const changedSet = new Set(result.changed);
  return {
    result,
    field,
    blasted: alive.filter((e) => blastSet.has(at(e))),
    exposed: alive.filter((e) => changedSet.has(at(e)) && hazardAt(field, at(e), e) > 0),
  };
}

/** One line per reaction, for previews and the log: "⚡ Electrified! (6 tiles)". */
export function reactionSummary(r: FieldResult): string[] {
  return r.reactions.map((x) => `${REACTIONS[x.kind].text}${x.tiles.length > 1 ? ` (${x.tiles.length} tiles)` : ''}`);
}

/** Distance helper for callers that only have tile indices. */
export const tileDist = (f: MapLike, a: number, b: number) => dist(tilePos(f, a), tilePos(f, b));
