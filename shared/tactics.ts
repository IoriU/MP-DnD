// Positioning: facing, back attacks, flanking, and every reason an attack roll has advantage or disadvantage.
// The server rolls with these, the client previews them on hover, and the hero AI plans around them.

import { sameSide } from './elites.ts';
import { dist } from './grid.ts';
import { hasStatus } from './skills.ts';
import type { Entity, Pos } from './types.ts';

/** The 8-way step from `from` toward `to` ({0,0} on the same tile). */
export const dirTo = (from: Pos, to: Pos): Pos => ({ x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) });

/**
 * Is `attacker` in the target's rear arc? That's more than 112.5° away from where it faces:
 * for an adjacent attacker, the 3 tiles behind it. (Stepping next to it makes it turn: see turnsToFace.)
 */
export function isBehind(target: Entity, attacker: Pos): boolean {
  const vx = attacker.x - target.x;
  const vy = attacker.y - target.y;
  const f = target.facing;
  if ((!vx && !vy) || !f || (!f.x && !f.y)) return false;
  let diff = Math.abs(Math.atan2(vy, vx) - Math.atan2(f.y, f.x));
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff > (5 * Math.PI) / 8 + 1e-9;
}

const canHelp = (e: Entity) => e.kind === 'monster' || (!e.dead && !e.downed);

/** Can it react right now (turn toward someone, take a free swing)? Not while surprised, stunned or down. */
export const canReact = (e: Entity) => canHelp(e) && !hasStatus(e, 'surprised') && !hasStatus(e, 'stunned');

/**
 * Creatures keep an eye on whoever gets close: when an enemy steps next to `watcher` (or hits it in melee), it turns
 * to face them. So you can't just walk around a monster to stab it in the back: it has to be busy with someone else,
 * you shoot it from behind, or you're hidden.
 */
export const turnsToFace = (watcher: Entity, mover: Entity, at: Pos) =>
  !sameSide(watcher, mover) && dist(watcher, at) <= 1 && canReact(watcher) && !hasStatus(mover, 'hidden');

/** Flanking: in melee, with a friend (a hero or an NPC ally) standing on the tile directly across the target. Works for monsters too. */
export function isFlanking(attacker: Entity, target: Entity, entities: Entity[]): boolean {
  if (dist(attacker, target) !== 1) return false;
  const x = 2 * target.x - attacker.x;
  const y = 2 * target.y - attacker.y;
  return entities.some((e) => e.id !== attacker.id && sameSide(e, attacker) && e.x === x && e.y === y && canHelp(e));
}

export interface AdvantageInfo {
  adv: string[]; // reasons, e.g. "flanking", "from behind"
  dis: string[];
}

/** Advantage and disadvantage cancel out, however many reasons there are of each (like 5e). */
export const netAdvantage = (a: AdvantageInfo): -1 | 0 | 1 => (a.adv.length && !a.dis.length ? 1 : a.dis.length && !a.adv.length ? -1 : 0);

/**
 * Why this attack roll would have advantage or disadvantage. `attacker` may be a hypothetical copy
 * (another tile) when planning. `skillAdv`: the skill itself attacks with advantage (Shadow Step, Cheap Shot...).
 */
export function attackAdvantage(attacker: Entity, target: Entity, entities: Entity[], skillAdv = false): AdvantageInfo {
  const adv: string[] = [];
  const dis: string[] = [];
  if (skillAdv) adv.push('the skill');
  if (hasStatus(attacker, 'hidden')) adv.push('hidden');
  if (hasStatus(attacker, 'focused')) adv.push('focused');
  if (hasStatus(target, 'marked')) adv.push('marked');
  if (isFlanking(attacker, target, entities)) adv.push('flanking');
  if (isBehind(target, attacker)) adv.push('from behind');
  if (hasStatus(attacker, 'blinded')) dis.push('blinded');
  return { adv, dis };
}

/** "advantage (flanking, from behind)", "disadvantage (blinded)", or '' for a straight roll. */
export function advantageText(a: AdvantageInfo): string {
  const net = netAdvantage(a);
  if (net > 0) return `advantage (${a.adv.join(', ')})`;
  if (net < 0) return `disadvantage (${a.dis.join(', ')})`;
  if (a.adv.length) return `advantage and disadvantage cancel out`;
  return '';
}
