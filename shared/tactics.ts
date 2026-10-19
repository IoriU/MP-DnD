// Positioning: facing, back attacks, flanking, and every reason an attack roll has advantage or disadvantage.
// The server rolls with these, the client previews them on hover, and the hero AI plans around them.

import { sameSide } from './elites.ts';
import { LOW_COVER, dist, type MapLike } from './grid.ts';
import { FULL_COVER, HALF_COVER } from './rules.ts';
import type { PropMap } from './surfaces.ts';
import { hasStatus } from './skills.ts';
import type { Entity, Pos } from './types.ts';

/**
 * Cover at `t` against an attack (or a blast) from `from`: FULL_COVER behind a wall, HALF_COVER behind low cover or a
 * prop, on the side of `t` that faces `from`. None in melee, in the open, or when `from` is far enough round the side
 * (more than about 60 degrees off: it flanks the cover).
 */
export function coverFrom(m: MapLike & { props?: PropMap }, from: Pos, t: Pos): number {
  if (dist(from, t) <= 1) return 0;
  const dx = from.x - t.x;
  const dy = from.y - t.y;
  let best = 0;
  for (const [sx, sy] of [[Math.sign(dx), 0], [0, Math.sign(dy)]]) {
    if (!sx && !sy) continue;
    const along = Math.abs(sx ? dx : dy);
    const across = Math.abs(sx ? dy : dx);
    if (along * 2 < across) continue; // too far round the side: flanked
    const x = t.x + sx;
    const y = t.y + sy;
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
    const i = y * m.width + x;
    const tile = m.tiles[i];
    best = Math.max(best, tile === LOW_COVER || (tile === '#' && m.props?.[i]) ? HALF_COVER : tile === '#' ? FULL_COVER : 0);
  }
  return best;
}

/** "behind a wall" / "in cover" for the log. */
export const coverWord = (c: number) => (c >= FULL_COVER ? 'behind a wall' : c > 0 ? 'in cover' : '');

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
  if (hasStatus(target, 'webbed')) adv.push('webbed');
  if (hasStatus(target, 'distracted') && !sameSide(attacker, target)) adv.push('distracted');
  // Shooting someone in a net is easy; someone lying down is easy to hit up close and hard to hit from afar.
  const ranged = dist(attacker, target) > 1;
  if (hasStatus(target, 'netted') && ranged) adv.push('netted');
  if (hasStatus(target, 'prone')) (ranged ? dis : adv).push('prone');
  if (isFlanking(attacker, target, entities)) adv.push('flanking');
  if (isBehind(target, attacker)) adv.push('from behind');
  if (hasStatus(attacker, 'blinded')) dis.push('blinded');
  if (hasStatus(attacker, 'webbed')) dis.push('webbed');
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
