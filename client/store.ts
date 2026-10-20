// Client-side state: the latest snapshot from the server plus local UI state.

import { hotbar, ownedSkill, resolveAim, skillBlockReason, statsOf, SKILLS, type AimResult, type SkillId, type SkillStats } from '../shared/skills.ts';
import type { Entity, Fx, GameState, PlayerEntity, Pos, TurnActs } from '../shared/types.ts';

type Listener = () => void;
const listeners = new Set<Listener>();
const fxListeners = new Set<(fx: Fx[]) => void>();

export const store = {
  state: null as GameState | null,
  receivedAt: 0, // Date.now() when `state` arrived; vote and rest countdowns count down from here
  playerId: null as string | null,
  selected: null as SkillId | null, // skill waiting for a target click
};

function emit() {
  for (const fn of listeners) fn();
}

/** Tells every subscriber to draw again with the same state (the graphics mode changed, so the HTML needs redrawing). */
export const refresh = emit;

export function setState(s: GameState | null) {
  if (s?.phase !== store.state?.phase) store.selected = null; // a selected skill never carries over to a new screen
  store.state = s;
  store.receivedAt = Date.now();
  if (store.selected && blockReason(store.selected)) store.selected = null; // it was spent, or the turn moved on
  emit();
}

export function select(skill: SkillId | null) {
  store.selected = skill;
  emit();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onFx(fn: (fx: Fx[]) => void): () => void {
  fxListeners.add(fn);
  return () => fxListeners.delete(fn);
}

export function emitFx(fx: Fx[]) {
  for (const fn of fxListeners) fn(fx);
}

export function me(): PlayerEntity | undefined {
  return store.state?.entities.find((e): e is PlayerEntity => e.kind === 'player' && e.playerId === store.playerId);
}

/**
 * Who is acting now: a monster or an NPC ally, or the heroes side by side in the order, who play at the same time. Those
 * losing their turn (down, stunned...) only count while nobody else in it plays.
 */
export function actingNow(s: GameState | null = store.state): Entity[] {
  const t = s?.phase === 'combat' ? s.turn : null;
  if (!t) return [];
  const playing = t.group.filter((id) => !t.acts[id]?.lost);
  return (playing.length ? playing : t.group).map((id) => s!.entities.find((e) => e.id === id)).filter((e): e is Entity => !!e);
}

/** The first of them (the turn order's highlight, "Waiting for..."). */
export function currentEntity(): Entity | undefined {
  return actingNow()[0];
}

export function isMyTurn(): boolean {
  const m = me();
  const t = store.state?.turn;
  return !!m && store.state?.phase === 'combat' && !!t?.group.includes(m.id) && !t.acts[m.id]?.lost;
}

/** My movement and AP left this turn. */
export function myActs(): TurnActs | undefined {
  const m = me();
  return m && isMyTurn() ? store.state?.turn?.acts[m.id] : undefined;
}

/** Changes when a new turn begins (a toast, a cleared walk preview); stays put while the heroes of one turn finish theirs. */
export function turnKey(s: GameState | null = store.state): string {
  const t = s?.turn;
  return t ? `${t.round}:${t.order[t.index]}` : '';
}

/** The heroes the monsters are hunting (turn.focus: one per pack of monsters), as entity ids. None outside a fight. */
export function huntedIds(s: GameState | null = store.state): string[] {
  return s?.phase === 'combat' ? (s.turn?.focus ?? []) : [];
}

/** Is the Sneak-or-Charge vote open? The room is on screen with the monsters placed, but no turn order yet. */
export function inApproach(s: GameState | null = store.state): boolean {
  return !!s && s.phase === 'combat' && s.vote?.kind === 'approach';
}

export function occupied(s: GameState, x: number, y: number, exceptId?: string): boolean {
  return s.entities.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead));
}

/** Is auto-play driving this player's hero (switched on, a bot, or disconnected)? */
export function isAuto(s: GameState, playerId: string): boolean {
  const info = s.players.find((p) => p.id === playerId);
  return !!info && (info.auto || info.bot || !info.connected);
}

// ---------------------------------------------------------------- skills and aiming

/** Why I can't use a skill right now, or null. */
export function blockReason(id: SkillId): string | null {
  const s = store.state;
  const m = me();
  if (!s || !m) return 'Not in the game';
  const reason = skillBlockReason(m, id, s.phase === 'combat', myActs() ?? null, isMyTurn());
  if (reason) return reason;
  // Hide can't be used with an enemy next to you. resolveAim knows, so the button greys out and says why.
  if (s.phase === 'combat' && mySkillStats(m, id)?.stealth) {
    const aim = aimAt(s, m, id, null);
    if (typeof aim === 'string') return aim;
  }
  return null;
}

/** The stats of one of my skills at its current tier. */
export function mySkillStats(m: PlayerEntity, id: SkillId): SkillStats | null {
  const own = ownedSkill(m, id);
  return own ? statsOf(own) : null;
}

/** What my skill would hit if aimed at an entity id or a tile, or the reason it can't be aimed there. */
export function aimAt(s: GameState, m: PlayerEntity, id: SkillId, aim: string | Pos | null | undefined): AimResult | string {
  const st = mySkillStats(m, id);
  if (!st) return "You don't know that skill";
  return resolveAim(st, m, aim, { map: s, entities: s.entities, inCombat: s.phase === 'combat' });
}

/** Mirrors the server's target checks so the UI can highlight valid targets (area skills accept a creature: its tile). */
export function validTarget(s: GameState, m: PlayerEntity, e: Entity, id: SkillId): boolean {
  return typeof aimAt(s, m, id, e.id) !== 'string';
}

/** The first free basic attack that isn't blocked and reaches this target: melee if adjacent, otherwise the ranged one. */
export function bestAttack(s: GameState, m: PlayerEntity, target: Entity): SkillId | null {
  for (const id of hotbar(m)) {
    if (SKILLS[id].kind !== 'basic' || blockReason(id)) continue;
    if (validTarget(s, m, target, id)) return id;
  }
  return null;
}

/** The first free basic attack that can smash the oil barrel or brazier on this tile. */
export function bestPropAttack(s: GameState, m: PlayerEntity, at: Pos): SkillId | null {
  for (const id of hotbar(m)) {
    if (SKILLS[id].kind !== 'basic' || blockReason(id)) continue;
    if (typeof aimAt(s, m, id, at) !== 'string') return id;
  }
  return null;
}

/** Why clicking a monster did nothing: a basic attack that's blocked (not your turn, action spent), else distance. */
export function attackProblem(m: PlayerEntity): string {
  const basics = hotbar(m).filter((id) => SKILLS[id].kind === 'basic');
  const reasons = basics.map((id) => blockReason(id));
  return reasons.length && reasons.every(Boolean) ? reasons[0]! : 'Out of range. Move closer first.';
}
