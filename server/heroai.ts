// Auto-play brain for heroes: AFK players, disconnected players, bot players and bot tests all use it.
// It only *decides*; the game runs each decision through the same validation as a human click.
// Skills are scored from their stats (see SkillStats in shared/skills.ts), so a new skill is playable without new AI code:
// every usable skill is tried on every sensible aim, checked with skillBlockReason + resolveAim, and given a utility score.
// Positioning comes from the same scoring: hit chances use shared/tactics.ts from the tile being considered, so tiles
// that flank a monster or reach its back score higher and the movement planner walks there on purpose.

import { canStep, dist, reachable, type MapLike } from '../shared/grid.ts';
import { MAX_BONUS_AC, MONSTERS, saveDc, sneakDice, stealthBonus } from '../shared/rules.ts';
import { attackAdvantage, canReact, dirTo, isFlanking, netAdvantage, turnsToFace } from '../shared/tactics.ts';
import {
  SKILLS,
  attackBonus,
  avgDice,
  countKind,
  damageMod,
  hasStatus,
  healBonus,
  hitsOf,
  hotbar,
  limitFor,
  nextTier,
  ownedSkill,
  passiveOf,
  resolveAim,
  skillBlockReason,
  slotCost,
  statsOf,
  trainOptions,
  type AimCtx,
  type AimResult,
  type SkillId,
  type SkillKind,
  type SkillStats,
  type StatusApply,
  type StatusId,
} from '../shared/skills.ts';
import type { Entity, MonsterEntity, NodeType, OfferCard, OwnedSkill, PickRequest, PlayerEntity, Pos, RestPick, TurnState } from '../shared/types.ts';

export interface HeroView {
  map: MapLike;
  hero: PlayerEntity;
  heroes: PlayerEntity[];
  monsters: MonsterEntity[];
  turn: TurnState;
  occupied: (x: number, y: number, exceptId?: string) => boolean;
}

export type HeroIntent =
  | { kind: 'act'; skill: SkillId; target?: string | Pos } // entity id for enemy/ally, tile for area, omitted for self/around/allies
  | { kind: 'move'; to: Pos }
  | { kind: 'end' };

const END: HeroIntent = { kind: 'end' };
const MIN_BONUS = 0.5; // a bonus (or free) action has to be worth at least this much
const MOVE_MARGIN = 0.3; // don't shuffle around for tiny gains
const STEP_COST = 0.05; // per tile walked
const POTION_PRICE = 6; // potions are scarce: drink when it really helps
const REVIVE = 25; // getting a downed friend back up beats almost anything
const FLANK_GIFT = 0.3; // standing across a monster from a friend gives them advantage on it too
const CLEANSED: StatusId[] = ['burning', 'poisoned', 'dazed', 'blinded'];

const standing = (p: PlayerEntity) => !p.dead && !p.downed;
const hpPct = (p: PlayerEntity) => p.hp / p.maxHp;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** Chance that d20 + bonus reaches `target` (a natural 1 always fails, a natural 20 always works). */
const d20 = (bonus: number, target: number) => clamp((21 + bonus - target) / 20, 0.05, 0.95);
/** Extra AC from Shielded (game.ts counts a Shielded without a power as +2). */
const shieldOf = (e: Entity) => e.statuses.reduce((s, x) => s + (x.id === 'shielded' ? (x.power ?? 2) : 0), 0);
/** A copy with a pretend status (replacing any it has), or without one. */
const withStatus = <T extends Entity>(e: T, id: StatusId, power?: number): T => ({
  ...e,
  statuses: [...e.statuses.filter((x) => x.id !== id), power ? { id, turns: 1, power } : { id, turns: 1 }],
});
const without = <T extends Entity>(e: T, id: StatusId): T => (hasStatus(e, id) ? { ...e, statuses: e.statuses.filter((x) => x.id !== id) } : e);
/** Loses its next turn: stunned, or caught by surprise. */
const skipsTurn = (e: Entity) => hasStatus(e, 'stunned') || hasStatus(e, 'surprised');
const isOffensive = (s: SkillStats) => s.target === 'enemy' || s.target === 'area' || s.target === 'around';

// ---------------------------------------------------------------- numbers about monsters

/** Damage a monster deals in a round if every attack lands. */
function fullDamage(m: MonsterEntity): number {
  const d = MONSTERS[m.type];
  return d ? d.attacks * avgDice(d.dmg) : 5;
}

/** Expected damage per round against a typical hero (AC 15). */
function threat(m: MonsterEntity): number {
  const d = MONSTERS[m.type];
  return d ? fullDamage(m) * d20(d.atk, 15) : 3;
}

const isMelee = (m: MonsterEntity) => (MONSTERS[m.type]?.range ?? 1) <= 1;
const reachOf = (m: MonsterEntity) => m.speed + (MONSTERS[m.type]?.range ?? 1);
/** What taking a monster out of the fight is worth (on top of the damage itself). */
const killValue = (m: MonsterEntity) => 3 + 1.5 * threat(m) + (m.boss || m.elite ? 3 : 0);
const tauntedBy = (m: MonsterEntity) => m.statuses.find((x) => x.id === 'taunted')?.by;

// ---------------------------------------------------------------- the situation being scored

/** The fight as seen from one spot. Variants move the hero or add pretend statuses to score "what if". */
interface Sim {
  v: HeroView;
  me: PlayerEntity;
  heroes: PlayerEntity[];
  monsters: MonsterEntity[];
  turn: TurnState;
  ctx: AimCtx;
  spots: Pos[]; // centers worth trying for area skills
  price: number; // what a spell slot is worth right now
  ranged: Set<string>; // heroes who'd rather fight from a distance
  healer: boolean; // can heal (and so revive) someone this turn
  root: boolean; // the real situation: also weighs setups, dashes and refreshes
  actionLater: boolean; // this turn's action is still coming (and an attack would give a hidden hero away)
  memo: Map<string, number>;
}

/** Heroes with a ranged attack they can always fall back on (a basic attack or cantrip reaching 4+ tiles) keep out of melee. */
function fightsFromRange(p: PlayerEntity): boolean {
  return p.skills.some((o) => {
    const kind = SKILLS[o.id].kind;
    const s = statsOf(o);
    return (kind === 'basic' || kind === 'cantrip') && !!s.dmg && s.range >= 4;
  });
}

/** What a spell slot is worth right now: cheap in emergencies and big fights, dear against trash. */
function slotPrice(v: HeroView): number {
  if (v.heroes.some((p) => !p.dead && (p.downed || hpPct(p) < 0.35))) return 2;
  if (v.monsters.some((m) => m.boss || m.elite)) return 3;
  return 15 - clamp(v.hero.slots - 1, 0, 4);
}

/** Every open tile on or next to a monster: candidate centers for area skills. */
function areaSpots(v: HeroView): Pos[] {
  const seen = new Set<number>();
  const out: Pos[] = [];
  for (const m of v.monsters) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = m.x + dx;
        const y = m.y + dy;
        const idx = y * v.map.width + x;
        if (x < 0 || y < 0 || x >= v.map.width || y >= v.map.height || v.map.tiles[idx] === '#' || seen.has(idx)) continue;
        seen.add(idx);
        out.push({ x, y });
      }
    }
  }
  return out;
}

const aimCtx = (map: MapLike, heroes: PlayerEntity[], monsters: MonsterEntity[]): AimCtx => ({ map, entities: [...heroes, ...monsters], inCombat: true });
const usable = (me: PlayerEntity, turn: TurnState) => hotbar(me).filter((id) => skillBlockReason(me, id, true, turn, true) === null);

function rootSim(v: HeroView): Sim {
  return {
    v,
    me: v.hero,
    heroes: v.heroes,
    monsters: v.monsters,
    turn: v.turn,
    ctx: aimCtx(v.map, v.heroes, v.monsters),
    spots: areaSpots(v),
    price: slotPrice(v),
    ranged: new Set(v.heroes.filter(fightsFromRange).map((p) => p.id)),
    healer: usable(v.hero, v.turn).some((id) => !!statsOf(ownedSkill(v.hero, id)!).heal),
    root: true,
    actionLater: !v.turn.actionUsed,
    memo: new Map(),
  };
}

/** The same fight with the hero swapped (moved, or with a pretend status), and maybe monsters or the turn changed. */
function variant(sim: Sim, me: PlayerEntity, monsters = sim.monsters, turn = sim.turn): Sim {
  const heroes = sim.heroes.map((h) => (h.id === me.id ? me : h));
  // Walking up to monsters makes them turn to face you (unless you're hidden), so no free backstabs.
  const moved = me.x !== sim.me.x || me.y !== sim.me.y;
  if (moved) monsters = monsters.map((m) => (turnsToFace(m, me, me) ? { ...m, facing: dirTo(m, me) } : m));
  const actionLater = turn === sim.turn ? sim.actionLater : !turn.actionUsed;
  return { ...sim, me, heroes, monsters, turn, ctx: aimCtx(sim.v.map, heroes, monsters), root: false, actionLater };
}

const standAt = (sim: Sim, pos: Pos) => variant(sim, { ...sim.me, x: pos.x, y: pos.y });

function memo(sim: Sim, key: string, f: () => number): number {
  let v = sim.memo.get(key);
  if (v === undefined) {
    v = f();
    sim.memo.set(key, v);
  }
  return v;
}

// ---------------------------------------------------------------- scoring one use of a skill

interface Plan {
  skill: SkillId;
  target?: string | Pos;
  cost: SkillStats['cost'];
  score: number;
  early: boolean; // do it before the action: a revive, an emergency heal, a setup (Feint) or a dash to reach a target
}

interface Strike {
  dmg: number; // expected damage
  kill: number; // chance it drops the target
  land: number; // chance at least one hit lands (or the save fails): statuses and pushes apply
}

/** P(total >= need) for a damage total with this mean and variance (normal approximation). */
function atLeast(mean: number, variance: number, need: number): number {
  if (variance <= 0) return mean >= need ? 1 : 0;
  const z = (need - 0.5 - mean) / Math.sqrt(variance);
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-z * z) / 2);
  return z >= 0 ? 0.5 * (1 - erf) : 0.5 * (1 + erf);
}

/** Chance that exactly k of these independent rolls succeed, for every k (index k). */
function successOdds(ps: number[]): number[] {
  let odds = [1];
  for (const p of ps) {
    const next = new Array<number>(odds.length + 1).fill(0);
    odds.forEach((q, k) => {
      next[k] += q * (1 - p);
      next[k + 1] += q * p;
    });
    odds = next;
  }
  return odds;
}

const allyNextTo = (sim: Sim, m: MonsterEntity) => sim.heroes.some((a) => a.id !== sim.me.id && standing(a) && dist(a, m) <= 1);

/** Flat damage from passives and buffs (the server applies these; the AI just counts them). */
function passiveDamage(me: PlayerEntity, id: SkillId, s: SkillStats, m: MonsterEntity): number {
  let b = 0;
  if (s.element === 'fire') b += passiveOf(me, 'elemental_affinity')?.value ?? 0;
  if (m.hp < m.maxHp / 2) b += passiveOf(me, 'opportunist')?.value ?? 0;
  if (s.roll !== 'attack') return b;
  const die = SKILLS[id].kind === 'basic' ? (passiveOf(me, 'divine_strike')?.value ?? 0) : 0;
  if (die) b += (die + 1) / 2;
  if (me.statuses.some((x) => x.id === 'blessed' && x.power)) b += 2.5; // Divine Favor
  return b;
}

/** Chance that d20 - d20 >= diff (an opposed roll where ties go to the one rolling first). */
function beat(diff: number): number {
  let n = 0;
  for (let a = 1; a <= 20; a++) n += clamp(a - diff, 0, 20);
  return n / 400;
}

/** Shove: d20 + your attack bonus against its d20 + the better of STR and DEX. `far`: winning by 5+ (one tile more). */
function shoveOdds(me: PlayerEntity, s: SkillStats, m: MonsterEntity): { win: number; far: number } {
  const d = MONSTERS[m.type];
  const diff = Math.max(d?.str ?? 0, d?.dex ?? 0) - attackBonus(me, s);
  return { win: beat(diff), far: beat(diff + 5) };
}

/** Expected damage, kill chance and landing chance of a damaging skill against one monster. */
function strike(sim: Sim, id: SkillId, s: SkillStats, m: MonsterEntity, main: boolean): Strike {
  const me = sim.me;
  if (!s.roll) return { dmg: 0, kill: 0, land: 1 }; // no roll: its effects always apply
  if (s.roll === 'contest') return { dmg: 0, kill: 0, land: shoveOdds(me, s, m).win };
  const hits = hitsOf(me, s);
  const dice = s.dmg ?? { n: 0, d: 1 };
  let nDice = dice.n;
  const ps: number[] = []; // chance each hit lands
  const crits: number[] = [];
  const advs: boolean[] = []; // that hit rolls with advantage (Sneak Attack)
  let ambush = 0; // Shadow Strike: extra d6s on the attack from hiding
  if (s.roll === 'attack') {
    const bonus = attackBonus(me, s) + (hasStatus(me, 'blessed') ? 2 : 0) - (hasStatus(me, 'dazed') ? 2 : 0);
    const base = d20(bonus, m.ac + shieldOf(m));
    // Focus and hiding go into the first attack roll of the skill; flanking, the back arc and marks stay.
    const spent = without(without(me, 'focused'), 'hidden');
    const first = netAdvantage(attackAdvantage(main ? me : spent, m, sim.ctx.entities, !!s.adv));
    // After a melee swing the target turns to face you, so later swings lose "from behind".
    const faced = dist(me, m) <= 1 && canReact(m) ? { ...m, facing: dirTo(m, me) } : m;
    const rest = hits > 1 || !main ? netAdvantage(attackAdvantage(spent, faced, sim.ctx.entities, !!s.adv)) : first;
    const full = !!s.critFull && m.hp >= m.maxHp; // a crit always hits
    if (full) nDice *= 2;
    for (let i = 0; i < hits; i++) {
      const a = i === 0 ? first : rest;
      ps.push(full ? 1 : a > 0 ? 1 - (1 - base) ** 2 : a < 0 ? base ** 2 : base);
      crits.push(full ? 0 : a > 0 ? 0.0975 : a < 0 ? 0.0025 : 0.05);
      advs.push(a > 0);
    }
    if (main) ambush = me.statuses.find((x) => x.id === 'hidden')?.power ?? 0;
  } else {
    let p = 1;
    if (s.roll === 'save') {
      const mod = MONSTERS[m.type]?.[s.save ?? 'dex'] ?? 0;
      p = clamp((saveDc(me.classId, me.level) - 1 - mod) / 20, 0, 1); // fails on d20 + mod < DC
    }
    for (let i = 0; i < hits; i++) {
      ps.push(p);
      crits.push(0);
      advs.push(false);
    }
  }
  const roll = (nDice * (dice.d + 1)) / 2;
  const rollVar = (nDice * (dice.d ** 2 - 1)) / 12;
  const per = roll + (dice.bonus ?? 0) + damageMod(me, s) + passiveDamage(me, id, s, m) + (s.execute && m.hp < m.maxHp / 2 ? avgDice(s.execute) : 0);
  const land = 1 - ps.reduce((q, p) => q * (1 - p), 1);
  // Sneak Attack: once, on the first hit that lands with a friend next to the target or with advantage.
  const sneak = main && s.sneak && !me.used.includes('turn:sneak') ? sneakDice(me.level) : 0;
  const ally = sneak > 0 && allyNextTo(sim, m);
  const pSneak = sneak ? 1 - ps.reduce((q, p, i) => (ally || advs[i] ? q * (1 - p) : q), 1) : 0;
  const half = s.roll === 'save' && !!s.half;
  let dmg = sneak * 3.5 * pSneak + ambush * 3.5 * (ps[0] ?? 0);
  for (let i = 0; i < hits; i++) dmg += ps[i] * per + crits[i] * roll + (half ? ((1 - ps[i]) * per) / 2 : 0);
  // Kill chance: over how many hits land (they can have different odds), with the bonus dice if any did.
  const extraDice = land > 0 ? (sneak * pSneak + ambush * (ps[0] ?? 0)) / land : 0; // given at least one hit
  let kill = 0;
  successOdds(ps).forEach((pk, k) => {
    if (pk < 1e-4) return;
    let mean = k * per + (k ? extraDice * 3.5 : 0);
    let variance = k * rollVar + (k ? (extraDice * 35) / 12 : 0);
    if (half) {
      mean += ((hits - k) * per) / 2;
      variance += ((hits - k) * rollVar) / 4;
    }
    kill += pk * atLeast(mean, variance, m.hp);
  });
  return { dmg, kill, land };
}

/** Statuses on a monster: worth more on dangerous ones, nothing for turns it already has them (or skips anyway). */
function foeStatusValue(sim: Sim, m: MonsterEntity, list: StatusApply[]): number {
  const t = threat(m);
  const skip = skipsTurn(m) ? 1 : 0; // stunned or surprised: its next turn is lost already
  let v = 0;
  for (const st of list) {
    const turns = Math.min(st.turns, 2);
    const have = m.statuses.find((x) => x.id === st.id)?.turns ?? 0;
    const fresh = Math.max(0, turns - have); // a reapplied status only lasts longer
    const acting = Math.max(0, turns - Math.max(have, skip)); // turns it would actually act under it
    switch (st.id) {
      case 'stunned':
        v += 1.3 * t * acting; // it skips its turn
        break;
      case 'dazed':
        v += 0.35 * t * acting;
        break;
      case 'blinded':
        v += 0.4 * t * acting;
        break;
      case 'marked':
        v += 1.2 * fresh * sim.heroes.filter(standing).length; // the whole party gets advantage
        break;
      case 'burning':
      case 'poisoned':
        v += Math.min(2.5 * (st.power ?? 1) * fresh, m.hp); // ticks even on a lost turn
        break;
    }
  }
  return v;
}

const occupiedIn = (sim: Sim, x: number, y: number, exceptId: string) =>
  sim.ctx.entities.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead));

/** Where a knockback leaves a monster, like game.ts: straight away from `from`, stopped by walls and creatures. */
function pushedTo(sim: Sim, m: MonsterEntity, from: Pos, tiles: number): Pos {
  const dx = Math.sign(m.x - from.x);
  const dy = Math.sign(m.y - from.y);
  let at: Pos = { x: m.x, y: m.y };
  if (!dx && !dy) return at;
  for (let i = 0; i < tiles; i++) {
    if (!canStep(sim.v.map, at, dx, dy) || occupiedIn(sim, at.x + dx, at.y + dy, m.id)) break;
    at = { x: at.x + dx, y: at.y + dy };
  }
  return at;
}

/** Who's worse off with a monster on them: the downed, the badly hurt, the lightly armored, and heroes who fight from range. */
function frailty(sim: Sim, h: PlayerEntity): number {
  if (h.downed) return 2;
  const soft = h.ac + shieldOf(h) <= 14 ? 1 : 0.4; // Wizards and Rogues
  const ranged = sim.ranged.has(h.id) ? 1.25 : 1; // has to walk away before attacking
  const hurt = hpPct(h) < 0.4 ? 2.5 : hpPct(h) < 0.6 ? 1.5 : 1;
  return soft * ranged * hurt;
}

/** Heroes who'd flank a monster standing at `at`: each has a friend on the tile across from them. */
function flankers(sim: Sim, at: Pos): number {
  let n = 0;
  for (const h of sim.heroes) {
    if (!standing(h) || dist(h, at) !== 1) continue;
    const x = 2 * at.x - h.x;
    const y = 2 * at.y - h.y;
    if (sim.heroes.some((o) => o.id !== h.id && standing(o) && o.x === x && o.y === y)) n++;
  }
  return n;
}

/**
 * What moving a monster to `to` is worth: off a downed or frail friend (they get up, or shoot, without it in their face),
 * onto a sturdier target, or into a flank. It walks back on its turn, so the gain is modest unless it loses that turn.
 */
function pushGain(sim: Sim, m: MonsterEntity, to: Pos): number {
  if (to.x === m.x && to.y === m.y) return 0;
  const reach = isMelee(m) ? 1 : 0.3; // an archer shoots you from anywhere
  let v = 0;
  for (const h of sim.heroes) {
    if (h.dead) continue;
    const was = dist(h, m) <= 1;
    if (was === dist(h, to) <= 1) continue;
    // Yourself: only worth it if you'd rather shoot than fight it (you'd walk away otherwise).
    const f = h.id === sim.me.id ? (sim.ranged.has(h.id) ? 0.6 * frailty(sim, h) : 0) : frailty(sim, h);
    const w = f >= 0.6 ? f * reach : -0.1; // a sturdy fighter loses (or gains) something to hit
    v += was ? w : -w;
  }
  const moved = { ...m, x: to.x, y: to.y };
  const before = targetOf(sim, m);
  const after = targetOf(sim, moved);
  if (before && after && before.id !== after.id && !skipsTurn(m)) v += (frailty(sim, before) - frailty(sim, after)) * threat(m) * 0.5;
  v += FLANK_GIFT * (flankers(sim, to) - flankers(sim, m));
  return v * (skipsTurn(m) ? 1.5 : 1); // it can't walk straight back
}

/** Shove: no damage, just the push, if the contest is won (by 5+ it flies a tile further). */
function shoveValue(sim: Sim, s: SkillStats, m: MonsterEntity): number {
  const { win, far } = shoveOdds(sim.me, s, m);
  const tiles = s.push ?? 1;
  return (win - far) * pushGain(sim, m, pushedTo(sim, m, sim.me, tiles)) + far * pushGain(sim, m, pushedTo(sim, m, sim.me, tiles + 1));
}

/** One foe's share of a skill's value. `from`: where a knockback pushes it away from. */
function foeValue(sim: Sim, id: SkillId, s: SkillStats, m: MonsterEntity, main: boolean, from: Pos): number {
  if (s.roll === 'contest') return shoveValue(sim, s, m);
  const hit = strike(sim, id, s, m, main);
  let v = Math.min(hit.dmg, m.hp) + hit.kill * killValue(m);
  if (hit.dmg > 0) {
    if (m.boss || m.elite) v += 1.5;
    if (main) v -= m.hp * 0.02; // tie-break toward the wounded
  }
  const lives = hit.land * (1 - hit.kill);
  if (s.onHit) v += lives * foeStatusValue(sim, m, s.onHit);
  if (s.push) v += lives * pushGain(sim, m, pushedTo(sim, m, from, s.push));
  return v;
}

/** Monsters look past a hidden hero while anyone else is in the open, unless that hero gives themself away by attacking this turn. */
const unseen = (sim: Sim, h: PlayerEntity) => hasStatus(h, 'hidden') && !(h.id === sim.me.id && sim.actionLater);

/**
 * Who a monster will go for, like game.ts: whoever taunted it, else the nearest standing hero (the most hurt on a tie),
 * skipping hidden heroes when someone else is standing.
 */
function targetOf(sim: Sim, m: MonsterEntity): PlayerEntity | undefined {
  const taunter = sim.heroes.find((h) => h.id === tauntedBy(m) && standing(h));
  if (taunter) return taunter;
  const up = sim.heroes.filter(standing);
  const seen = up.filter((h) => !unseen(sim, h));
  let top: PlayerEntity | undefined;
  for (const h of seen.length ? seen : up) {
    if (!top || dist(h, m) < dist(top, m) || (dist(h, m) === dist(top, m) && h.hp < top.hp)) top = h;
  }
  return top;
}

/** How much a monster's next round is aimed at this hero: fully if it's their target, a little if they're in reach anyway. */
function aimedAt(sim: Sim, m: MonsterEntity, f: PlayerEntity): number {
  if (skipsTurn(m)) return 0;
  if (targetOf(sim, m)?.id === f.id) return 1;
  if (tauntedBy(m)) return 0;
  return unseen(sim, f) ? 0.05 : 0.2;
}

/** Damage that could come at a hero next round from monsters that can reach them. */
function exposure(sim: Sim, f: PlayerEntity): number {
  let e = 0;
  for (const m of sim.monsters) if (dist(m, f) <= reachOf(m)) e += fullDamage(m) * aimedAt(sim, m, f);
  return e;
}

/**
 * How dangerous the hero's tile is: melee monsters next to it count fully, two tiles away half (ranged ones shoot you anywhere).
 * Two monsters on opposite sides flank you (advantage); a hidden hero mostly gets ignored.
 */
function danger(sim: Sim): number {
  const floor = unseen(sim, sim.me) ? 0.15 : 0.4;
  let d = 0;
  for (const m of sim.monsters) {
    const r = dist(sim.me, m);
    if (!isMelee(m) || r > 2) continue;
    let w = clamp(threat(m) / 3, 0.5, 3) * Math.max(floor, aimedAt(sim, m, sim.me));
    if (r <= 1 && isFlanking(m, sim.me, sim.ctx.entities)) w *= 1.4;
    d += r <= 1 ? w : w / 2;
  }
  return d;
}

const adjacentFoes = (sim: Sim, p: Pos) => sim.monsters.filter((m) => dist(m, p) <= 1).length;

/** A buff on a hero. */
function heroStatusValue(sim: Sim, f: PlayerEntity, st: StatusApply): number {
  const turns = Math.min(st.turns, 2);
  switch (st.id) {
    case 'shielded': {
      const gain = Math.max(0, (st.power ?? 0) - shieldOf(f));
      const e = exposure(sim, f);
      return (gain / 20) * e * turns * (f.hp <= e ? 2.5 : 1); // much more when the next round could drop them
    }
    case 'blessed': // +2 to hit (about +10% of their damage, which grows with level), plus 1d4 a hit with power
      return Math.min(st.turns, 3) * (0.1 * (5 + f.level) + (st.power ? 1.5 : 0)) * (hasStatus(f, 'blessed') ? 0.3 : 1);
    case 'focused':
      // Used up by this turn's attack: the setup gain counts that. Otherwise it waits for the next turn
      // (unless that attack has advantage already: hiding is spent on the same roll).
      return (f.id === sim.me.id && sim.actionLater) || hasStatus(f, 'focused') || hasStatus(f, 'hidden') ? 0 : 1.5;
    case 'hidden': {
      if (f.id !== sim.me.id) return 0;
      const have = f.statuses.find((x) => x.id === 'hidden');
      if (have && (have.power ?? 0) >= (st.power ?? 0)) return 0;
      // This turn's attack would give you away at once: setupGain counts the advantage it brings.
      return sim.actionLater ? 0 : hideValue(sim, without(f, 'hidden'), st.power);
    }
    case 'riposte':
      return 1.2 * adjacentFoes(sim, f);
    default:
      return 0;
  }
}

/**
 * Hiding until your next turn: monsters go for someone else if they can (the damage you dodge), and the next attack has
 * advantage (so Sneak Attack too), plus Shadow Strike's dice. `me` is you, not hidden.
 */
function hideValue(sim: Sim, me: PlayerEntity, power = 0): number {
  const late = { ...sim, actionLater: false };
  const hidden = withStatus(me, 'hidden', power);
  const was = exposure(variant(late, me), me);
  const now = exposure(variant(late, hidden), hidden);
  const safety = 0.5 * Math.max(0, was - now) * (me.hp <= was ? 2 : 1);
  const sneaky = me.skills.some((o) => !!statsOf(o).sneak);
  return safety + 1.5 + (sneaky ? 0.3 * sneakDice(me.level) * 3.5 : 0) + power * 3.5 * 0.6;
}

/** What a hidden hero throws away with a bonus action that gives them away without an attack roll (Shove, Feint). */
function hiddenWorth(sim: Sim): number {
  const h = sim.me.statuses.find((x) => x.id === 'hidden');
  if (!h) return 0;
  if (sim.actionLater) return 2 + (h.power ?? 0) * 3.5 * 0.6; // the advantage this turn's attack was going to get
  return hideValue(sim, without(sim.me, 'hidden'), h.power);
}

const healWeight = (f: PlayerEntity) => (hpPct(f) < 0.35 ? 1.6 : hpPct(f) < 0.6 ? 0.9 : 0.3);

/** Heals and buffs on one friend (you included). */
function friendValue(sim: Sim, s: SkillStats, f: PlayerEntity): number {
  let v = 0;
  if (s.heal) {
    const amt = avgDice(s.heal) + healBonus(sim.me, s);
    const missing = f.maxHp - f.hp;
    if (f.downed) v += REVIVE + amt;
    else v += Math.min(amt, missing) * healWeight(f) + (s.overheal ? Math.max(0, amt - missing) * 0.3 : 0);
  } else if (!standing(f)) {
    return 0; // buffs don't help someone lying on the floor
  }
  if (s.tempHp) v += avgDice(s.tempHp) * (exposure(sim, f) > 0 ? 0.5 : 0.1);
  if (s.cleanse) v += 1.5 * f.statuses.filter((x) => CLEANSED.includes(x.id)).length;
  for (const st of s.status ?? []) v += heroStatusValue(sim, f, st);
  return v;
}

/** Taunting is good when you're healthy and the monsters would otherwise go for someone else. */
function tauntValue(sim: Sim, radius: number, turns: number): number {
  const me = sim.me;
  const sturdy = hpPct(me) >= 0.6 ? 1 : hpPct(me) >= 0.4 ? 0.3 : -0.6;
  let v = 0;
  for (const m of sim.monsters) {
    if (dist(m, me) > radius || skipsTurn(m)) continue;
    if (tauntedBy(m) === me.id) continue;
    const target = targetOf(sim, m);
    v += fullDamage(m) * (target && target.id !== me.id ? 0.3 : 0.05); // pull it off a friend
  }
  return v * sturdy * Math.min(turns, 2);
}

/** Best action score from a spot (with the walk there already paid), or 0. Plus 10 so "can act" beats "can't". */
const actionAt = (p: Sim) => {
  const a = best(plansFrom(p, false), 'action');
  return a && a.score > 0 ? 10 + a.score : 0;
};

/** Action Surge and friends: worth the best action you could still take this turn. */
function refreshValue(sim: Sim): number {
  if (!sim.turn.actionUsed) return -5; // the action is still there: nothing to get back
  if (!sim.root) return 0;
  return memo(sim, 'refresh', () => {
    const fresh = variant(sim, sim.me, sim.monsters, { ...sim.turn, actionUsed: false });
    return Math.max(0, scan(fresh, sim.turn.movesLeft, actionAt).score - 10);
  });
}

/** Extra movement is worth a lot when it's the only way to reach a target this turn. */
function dashValue(sim: Sim, extra: number): number {
  if (!sim.root || !sim.actionLater) return 0;
  const canAct = (moves: number) => memo(sim, `act:${moves}`, () => scan(variant(sim, sim.me), moves, actionAt).score) > 5;
  if (canAct(sim.turn.movesLeft)) return 0;
  return canAct(sim.turn.movesLeft + extra) ? 6 : 1;
}

/**
 * Extra value of a bonus action that improves this turn's action (Feint, Hide, Mark for Death, Hit and Run...): the best
 * attack you can still walk to with it, against the best one without (which may already have advantage from a flank).
 */
function setupGain(sim: Sim, s: SkillStats, res: AimResult): number {
  const mine = [...(s.selfStatus ?? []), ...(res.friends.some((f) => f.id === sim.me.id) ? (s.status ?? []) : [])].filter(
    (x) => x.id === 'focused' || x.id === 'hidden',
  );
  const mark = !s.roll && (s.onHit ?? []).some((x) => x.id === 'marked') ? res.foes[0] : undefined;
  if (!mine.length && !mark) return 0;
  let me = isOffensive(s) ? without(sim.me, 'hidden') : sim.me; // Feinting gives you away
  for (const x of mine) me = withStatus(me, x.id, x.power);
  const monsters = mark ? sim.monsters.map((m) => (m === mark ? withStatus(m, 'marked') : m)) : sim.monsters;
  const moves = sim.turn.movesLeft;
  const gain = (x: number) => (x > 0 ? x - 10 : 0); // actionAt adds 10 for "can act"
  const before = memo(sim, 'setup:none', () => gain(scan(variant(sim, sim.me), moves, actionAt).score));
  const key = `setup:${mine.map((x) => `${x.id}${x.power ?? ''}`).join()}:${mark?.id ?? ''}:${isOffensive(s)}`;
  const after = memo(sim, key, () => gain(scan(variant(sim, me, monsters), moves, actionAt).score));
  return Math.max(0, after - Math.max(0, before));
}

function costOf(sim: Sim, id: SkillId, s: SkillStats): number {
  const kind = SKILLS[id].kind;
  if (kind === 'spell') return slotCost(s) * sim.price;
  if (kind === 'cantrip') return (s.cooldown ?? 0) * 0.3; // they come back, so use them freely
  if (kind === 'item') return POTION_PRICE;
  return 0;
}

/** The utility of using a skill with this aim, or null if it would do nothing. */
function scorePlan(sim: Sim, id: SkillId, s: SkillStats, res: AimResult, setup: boolean): { score: number; early: boolean } | null {
  const offensive = isOffensive(s);
  if (offensive && !res.foes.length) return null;
  const me = sim.me;
  let score = 0;
  let early = false;
  // Knockback is away from you, or from the area's center for anyone not standing on it (like game.ts).
  const from = (m: MonsterEntity) => (s.target === 'area' && (m.x !== res.center.x || m.y !== res.center.y) ? res.center : me);
  res.foes.forEach((m, i) => (score += foeValue(sim, id, s, m, i === 0, from(m))));
  // A Shove or Feint gives a hidden hero away for nothing (an attack roll spends it on advantage, already scored).
  if (offensive && s.roll !== 'attack' && s.cost !== 'action') score -= hiddenWorth(sim);
  for (const f of res.friends) score += friendValue(sim, s, f);
  for (const st of s.selfStatus ?? []) score += heroStatusValue(sim, me, st);
  if (s.taunt) score += tauntValue(sim, s.taunt.radius, s.taunt.turns);
  if (s.refresh) {
    const r = refreshValue(sim);
    score += r;
    early ||= r > 0; // before walking off: the next action may want this spot
  }
  if (s.resetCooldowns) score += 2 * me.skills.filter((o) => o.cd > 0 && SKILLS[o.id].kind === 'cantrip').length;
  if (s.dash) {
    const d = s.cost === 'action' ? 0.5 : dashValue(sim, s.dash);
    score += d;
    early ||= d >= 6;
  }
  if (setup && s.cost !== 'action' && sim.actionLater) {
    const gain = setupGain(sim, s, res);
    score += gain;
    early ||= gain > MIN_BONUS;
  }
  if (s.heal && res.friends.some((f) => f.downed || hpPct(f) < 0.35)) early = true; // patch people up first
  return { score: score - costOf(sim, id, s), early };
}

/** Candidate aims for a skill (cheaply pre-filtered by range; resolveAim has the final word). */
function aimsFor(sim: Sim, s: SkillStats): (string | Pos | undefined)[] {
  const near = (p: Pos) => dist(sim.me, p) <= s.range;
  switch (s.target) {
    case 'enemy':
      return sim.monsters.filter(near).map((m) => m.id);
    case 'ally':
      return sim.heroes.filter((p) => !p.dead && near(p)).map((p) => p.id);
    case 'area':
      return sim.spots.filter(near);
    default:
      return [undefined];
  }
}

/** The best valid use of every skill the hero can use right now. */
function plansFrom(sim: Sim, setup: boolean): Plan[] {
  const out: Plan[] = [];
  for (const id of usable(sim.me, sim.turn)) {
    const s = statsOf(ownedSkill(sim.me, id)!);
    let top: Plan | null = null;
    for (const target of aimsFor(sim, s)) {
      const res = resolveAim(s, sim.me, target, sim.ctx);
      if (typeof res === 'string') continue;
      const r = scorePlan(sim, id, s, res, setup);
      if (r && (!top || r.score > top.score)) top = { skill: id, target, cost: s.cost, ...r };
    }
    if (top) out.push(top);
  }
  return out;
}

function best(plans: Plan[], cost: SkillStats['cost']): Plan | null {
  let top: Plan | null = null;
  for (const p of plans) if (p.cost === cost && (!top || p.score > top.score)) top = p;
  return top;
}

// ---------------------------------------------------------------- where to stand

/** The best tile within `moves` steps by `scoreAt` (minus a small cost per step), and the score of staying put. */
function scan(sim: Sim, moves: number, scoreAt: (p: Sim) => number): { pos: Pos; score: number; stay: number } {
  const stay = scoreAt(variant(sim, sim.me));
  let top = { pos: { x: sim.me.x, y: sim.me.y } as Pos, score: stay };
  if (moves > 0) {
    const w = sim.v.map.width;
    for (const [idx, steps] of reachable(sim.v.map, sim.me, moves, (x, y) => sim.v.occupied(x, y, sim.me.id))) {
      if (!steps) continue;
      const pos = { x: idx % w, y: Math.floor(idx / w) };
      const score = scoreAt(standAt(sim, pos)) - steps * STEP_COST;
      if (score > top.score) top = { pos, score };
    }
  }
  return { ...top, stay };
}

function bestMove(sim: Sim, scoreAt: (p: Sim) => number): Pos | null {
  const r = scan(sim, sim.turn.movesLeft, scoreAt);
  return r.score > r.stay + MOVE_MARGIN ? r.pos : null;
}

const dangerAt = (p: Sim) => (p.ranged.has(p.me.id) ? danger(p) * (hpPct(p.me) < 0.5 ? 6 : 4) : 0);
const nearestFoe = (p: Sim) => Math.min(99, ...p.monsters.map((m) => dist(p.me, m)));

/** Where to head when nothing is in reach: a downed friend if you can get them up, else the nearest enemy. */
function approachDist(p: Sim): number {
  const downed = p.heroes.filter((h) => h.downed && !h.dead);
  const goals = p.healer && downed.length ? downed : p.monsters;
  return Math.min(99, ...goals.map((g) => dist(p.me, g)));
}

/** Friends standing across a monster from you: you give them flanking (advantage) on it. */
function flanksGiven(p: Sim): number {
  let n = 0;
  for (const m of p.monsters) {
    if (dist(p.me, m) !== 1) continue;
    const x = 2 * m.x - p.me.x;
    const y = 2 * m.y - p.me.y;
    if (p.heroes.some((h) => h.id !== p.me.id && standing(h) && h.x === x && h.y === y)) n++;
  }
  return Math.min(n, 2);
}

/** A spot to act from: the best action there (flanks and back attacks included), plus the best bonus action there, minus danger. */
function engageAt(p: Sim): number {
  const plans = plansFrom(p, false);
  const action = best(plans, 'action');
  const bonus = best(plans, 'bonus');
  let score = action && action.score > 0 ? 10 + action.score : -0.5 * approachDist(p);
  if (bonus && bonus.score > MIN_BONUS) score += bonus.score;
  return score + FLANK_GIFT * flanksGiven(p) - dangerAt(p);
}

/** A spot to finish the turn on: the best bonus action there (Shove, Hide...), then safety (ranged) or staying in the fight (melee). */
function afterAt(p: Sim): number {
  const bonus = best(plansFrom(p, false), 'bonus');
  let score = bonus && bonus.score > MIN_BONUS ? bonus.score : 0;
  if (p.ranged.has(p.me.id)) score += Math.min(nearestFoe(p), 3) * 0.2;
  else score -= Math.max(0, nearestFoe(p) - 1) * 0.3;
  return score + FLANK_GIFT * flanksGiven(p) - dangerAt(p);
}

// ---------------------------------------------------------------- the turn

const act = (p: Plan): HeroIntent => (p.target === undefined ? { kind: 'act', skill: p.skill } : { kind: 'act', skill: p.skill, target: p.target });

/** The next thing an auto-played hero should do on its turn. Call again after each step until it says 'end'. */
export function nextHeroIntent(v: HeroView): HeroIntent {
  const h = v.hero;
  // game.ts skips the turn of a surprised hero; answer the same if asked anyway.
  if (!standing(h) || !v.monsters.length || skipsTurn(h)) return END;
  const sim = rootSim(v);
  const plans = plansFrom(sim, true);
  const bonus = best(plans, 'bonus');
  const free = best(plans, 'free');

  // 1. Revives, emergency heals and setups (Feint, Hide, a dash to reach a target) come first.
  for (const p of [bonus, free]) if (p && p.early && p.score > MIN_BONUS) return act(p);

  // 2. Get to the best spot to act from (in reach, flanking or behind, out of melee for ranged heroes, near a downed
  // friend), then act.
  if (!v.turn.actionUsed) {
    const to = bestMove(sim, engageAt);
    if (to) return { kind: 'move', to };
    const action = best(plans, 'action');
    if (action && action.score > 0) return act(action);
  }

  // 3. Bonus and free actions (Shield Bash, Second Wind, Shove, Hide, Action Surge...), from a better spot if there is
  // one. With the action unused there's no attack coming, so hiding now lasts into the monsters' turns.
  const late = v.turn.actionUsed ? sim : { ...sim, actionLater: false, memo: new Map<string, number>() };
  const latePlans = late === sim ? plans : plansFrom(late, false);
  const to = bestMove(late, afterAt);
  if (to) return { kind: 'move', to };
  for (const p of [best(latePlans, 'free'), best(latePlans, 'bonus')]) if (p && p.score > MIN_BONUS) return act(p);
  return END;
}

// ---------------------------------------------------------------- between rooms

const NO_MAP: MapLike = { width: 0, height: 0, tiles: '' };

/**
 * Potions and heals an auto hero wants to use between fights (at most one per call). Heal spells only when the caster
 * keeps a slot for the next fight (or someone is in real trouble); potions for the drinker, or for a friend without any.
 */
export function upkeepIntent(hero: PlayerEntity, heroes: PlayerEntity[]): HeroIntent | null {
  if (!standing(hero)) return null;
  const ctx: AimCtx = { map: NO_MAP, entities: heroes, inCombat: false };
  const trouble = (f: PlayerEntity) => f.downed || hpPct(f) < 0.3;
  let top: { intent: HeroIntent; score: number } | null = null;
  for (const id of hotbar(hero)) {
    if (skillBlockReason(hero, id, false, null, false)) continue;
    const s = statsOf(ownedSkill(hero, id)!);
    if (!s.heal) continue;
    const amt = avgDice(s.heal) + healBonus(hero, s);
    const spell = SKILLS[id].kind === 'spell';
    const aims = s.target === 'ally' ? heroes.filter((p) => !p.dead).map((p) => p.id) : [undefined];
    for (const target of aims) {
      const res = resolveAim(s, hero, target, ctx);
      if (typeof res === 'string') continue;
      if (id === 'potion' && res.friends.some((f) => f.id !== hero.id && (f.potions > 0 || !trouble(f)))) continue;
      if (spell && hero.slots - slotCost(s) < 1 && !res.friends.some(trouble)) continue;
      let gain = 0;
      for (const f of res.friends) gain += f.downed ? REVIVE : hpPct(f) < 0.5 ? Math.min(amt, f.maxHp - f.hp) : 0;
      if (gain < amt * 0.6) continue; // mostly wasted
      const score = gain + (spell ? 1 : 0); // spare slots before potions
      if (!top || score > top.score) top = { intent: target === undefined ? { kind: 'act', skill: id } : { kind: 'act', skill: id, target }, score };
    }
  }
  return top?.intent ?? null;
}

/** Map vote for an all-auto party: rest when hurt, elites when healthy, otherwise a bit of everything. */
export function autoPathChoice(options: { id: string; type: NodeType }[], heroes: PlayerEntity[]): string {
  const alive = heroes.filter((p) => !p.dead);
  const health = alive.length ? alive.reduce((s, p) => s + hpPct(p), 0) / alive.length : 0;
  const level = alive.length ? alive.reduce((s, p) => s + p.level, 0) / alive.length : 1;
  const value: Record<NodeType, number> = {
    rest: health < 0.5 ? 3 : 0.5,
    elite: health > 0.75 && level >= 2 ? 2.5 : 0.2, // elites hit hard: not at level 1
    treasure: 2,
    event: 1.5,
    combat: 1.2,
    shop: 0.5,
    boss: 10,
  };
  let best = options[0];
  let bestScore = -Infinity;
  for (const o of options) {
    const score = value[o.type] + Math.random() * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best.id;
}

/** Event vote for an all-auto party: try something, but walk away when the party is hurting. */
export function autoEventChoice(options: string[], heroes: PlayerEntity[]): string {
  const alive = heroes.filter((p) => !p.dead);
  const health = alive.length ? alive.reduce((s, p) => s + hpPct(p), 0) / alive.length : 0;
  const daring = options.filter((o) => o !== 'leave');
  if (!daring.length || (health < 0.35 && options.includes('leave'))) return options.includes('leave') ? 'leave' : options[0];
  return daring[Math.floor(Math.random() * daring.length)];
}

/**
 * Sneak-or-Charge vote for an all-auto party: sneak when the group Stealth check (at least half the standing heroes beat
 * the DC) works at least half the time. A party that's all Alert can't be caught off guard, so it always tries.
 */
export function autoApproachChoice(heroes: PlayerEntity[], dc: number): 'sneak' | 'charge' {
  const party = heroes.filter(standing);
  if (!party.length) return 'charge';
  if (party.every((h) => passiveOf(h, 'alert'))) return 'sneak';
  const odds = successOdds(party.map((h) => d20(stealthBonus(h), dc)));
  const success = odds.reduce((sum, q, k) => (k * 2 >= party.length ? sum + q : sum), 0);
  return success >= 0.5 ? 'sneak' : 'charge';
}

// ---------------------------------------------------------------- level-ups and rest sites

const randomBranch = (): 'A' | 'B' => (Math.random() < 0.5 ? 'A' : 'B');
/** How much a hero has invested in a skill (healing skills are kept a little longer). */
const skillWorth = (o: OwnedSkill) => o.tier + (statsOf(o).heal ? 0.5 : 0);
const ownedOfKind = (p: PlayerEntity, kind: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === kind);

/** How much an auto hero wants a level-up card. */
function cardValue(p: PlayerEntity, c: OfferCard): number {
  switch (c.kind) {
    case 'upgrade':
      return nextTier(p, c.skill) === c.tier ? (c.tier === 3 ? 9 : 7) : -Infinity;
    case 'learn': {
      if (p.skills.some((s) => s.id === c.skill)) return -Infinity;
      const kind = SKILLS[c.skill].kind;
      // An empty passive slot is free power (and bot runs need passives exercised), so fill it early.
      if (countKind(p, kind) < limitFor(p, kind)) return kind === 'passive' ? (countKind(p, 'passive') === 0 ? 7.5 : 6.5) : 8;
      return 3 - Math.min(...ownedOfKind(p, kind).map(skillWorth)); // a swap: only worth it for a weak skill
    }
    case 'boon':
      if (c.boon === 'ac') return p.bonusAc < MAX_BONUS_AC ? 4 : -Infinity;
      if (c.boon === 'slot') return countKind(p, 'spell') ? 4 : 1;
      return 3;
  }
}

/**
 * Level-up pick: tier III upgrades, then new skills while there's room, a first passive, tier II, more passives, then boons (with a little randomness
 * so bot builds vary). Tier III branches are random, so bot runs exercise both. A full bar forgets its weakest skill.
 */
export function autoLevelPick(hero: PlayerEntity): PickRequest {
  const offer = hero.offer ?? [];
  let card = 0;
  let top = -Infinity;
  offer.forEach((c, i) => {
    const v = cardValue(hero, c) + Math.random() * 1.5;
    if (v > top) {
      top = v;
      card = i;
    }
  });
  const req: PickRequest = { card };
  const c = offer[card];
  if (c?.kind === 'upgrade' && c.tier === 3) req.branch = randomBranch();
  if (c?.kind === 'learn') {
    const kind = SKILLS[c.skill].kind;
    if (countKind(hero, kind) >= limitFor(hero, kind)) {
      const weakest = ownedOfKind(hero, kind).reduce<OwnedSkill | null>((a, s) => (!a || skillWorth(s) < skillWorth(a) ? s : a), null);
      if (weakest) req.forget = weakest.id;
    }
  }
  return req;
}

/** Rest site: Long Rest when hurt or low on slots, else Train the best upgrade (cantrips first: they're used every fight). */
export function autoRestPick(hero: PlayerEntity, _heroes: PlayerEntity[]): RestPick {
  const lowSlots = countKind(hero, 'spell') > 0 && hero.slots < hero.maxSlots / 2;
  const options = trainOptions(hero);
  if (hpPct(hero) < 0.6 || lowSlots || !options.length) return { kind: 'long' };
  const value = (o: { skill: SkillId; tier: number }) => o.tier + (SKILLS[o.skill].kind === 'cantrip' ? 0.5 : 0) + Math.random() * 0.4;
  const pick = options.map((o) => ({ o, v: value(o) })).sort((a, b) => b.v - a.v)[0].o;
  return pick.tier === 3 ? { kind: 'train', skill: pick.skill, branch: randomBranch() } : { kind: 'train', skill: pick.skill };
}
