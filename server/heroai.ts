// Auto-play brain for heroes: AFK players, disconnected players, bot players and bot tests all use it.
// It only *decides*; the game runs each decision through the same validation as a human click.
// Skills are scored from their stats (see SkillStats in shared/skills.ts), so a new skill is playable without new AI code:
// every usable skill is tried on every sensible aim, checked with skillBlockReason + resolveAim, and given a utility score.

import { dist, reachable, type MapLike } from '../shared/grid.ts';
import { MAX_BONUS_AC, MONSTERS, saveDc, sneakDice } from '../shared/rules.ts';
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
const CLEANSED: StatusId[] = ['burning', 'poisoned', 'dazed', 'blinded'];

const standing = (p: PlayerEntity) => !p.dead && !p.downed;
const hpPct = (p: PlayerEntity) => p.hp / p.maxHp;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** Chance that d20 + bonus reaches `target` (a natural 1 always fails, a natural 20 always works). */
const d20 = (bonus: number, target: number) => clamp((21 + bonus - target) / 20, 0.05, 0.95);
/** Extra AC from Shielded (game.ts counts a Shielded without a power as +2). */
const shieldOf = (e: Entity) => e.statuses.reduce((s, x) => s + (x.id === 'shielded' ? (x.power ?? 2) : 0), 0);
const withStatus = <T extends Entity>(e: T, id: StatusId): T => ({ ...e, statuses: [...e.statuses, { id, turns: 1 }] });

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
    memo: new Map(),
  };
}

/** The same fight with the hero swapped (moved, or with a pretend status), and maybe monsters or the turn changed. */
function variant(sim: Sim, me: PlayerEntity, monsters = sim.monsters, turn = sim.turn): Sim {
  const heroes = sim.heroes.map((h) => (h.id === me.id ? me : h));
  return { ...sim, me, heroes, monsters, turn, ctx: aimCtx(sim.v.map, heroes, monsters), root: false };
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

function binom(n: number, k: number, p: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c * p ** k * (1 - p) ** (n - k);
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

/** Expected damage, kill chance and landing chance of a damaging skill against one monster. */
function strike(sim: Sim, id: SkillId, s: SkillStats, m: MonsterEntity, main: boolean): Strike {
  const me = sim.me;
  if (!s.roll) return { dmg: 0, kill: 0, land: 1 }; // no roll: its effects always apply
  const hits = hitsOf(me, s);
  const dice = s.dmg ?? { n: 0, d: 1 };
  let nDice = dice.n;
  let p = 1;
  let crit = 0;
  let adv = false;
  if (s.roll === 'attack') {
    const bonus = attackBonus(me, s) + (hasStatus(me, 'blessed') ? 2 : 0) - (hasStatus(me, 'dazed') ? 2 : 0);
    const base = d20(bonus, m.ac + shieldOf(m));
    const wantAdv = !!s.adv || hasStatus(me, 'focused') || hasStatus(m, 'marked');
    const dis = hasStatus(me, 'blinded') && !wantAdv;
    adv = wantAdv && !hasStatus(me, 'blinded');
    p = adv ? 1 - (1 - base) ** 2 : dis ? base ** 2 : base;
    crit = adv ? 0.0975 : dis ? 0.0025 : 0.05;
    if (s.critFull && m.hp >= m.maxHp) {
      p = 1; // a crit always hits
      nDice *= 2;
      crit = 0;
    }
  } else if (s.roll === 'save') {
    const mod = MONSTERS[m.type]?.[s.save ?? 'dex'] ?? 0;
    p = clamp((saveDc(me.classId, me.level) - 1 - mod) / 20, 0, 1); // fails on d20 + mod < DC
  }
  const roll = (nDice * (dice.d + 1)) / 2;
  const rollVar = (nDice * (dice.d ** 2 - 1)) / 12;
  const per = roll + (dice.bonus ?? 0) + damageMod(me, s) + passiveDamage(me, id, s, m) + (s.execute && m.hp < m.maxHp / 2 ? avgDice(s.execute) : 0);
  const sneak = main && s.sneak && !me.used.includes('turn:sneak') && (adv || allyNextTo(sim, m)) ? sneakDice(me.level) : 0;
  const half = s.roll === 'save' && !!s.half;
  const land = 1 - (1 - p) ** hits;
  const dmg = hits * (p * per + crit * roll + (half ? ((1 - p) * per) / 2 : 0)) + sneak * 3.5 * land;
  let kill = 0;
  for (let k = 0; k <= hits; k++) {
    const pk = binom(hits, k, p);
    if (pk < 1e-4) continue;
    let mean = k * per + (k ? sneak * 3.5 : 0);
    let variance = k * rollVar + (k ? (sneak * 35) / 12 : 0);
    if (half) {
      mean += ((hits - k) * per) / 2;
      variance += ((hits - k) * rollVar) / 4;
    }
    kill += pk * atLeast(mean, variance, m.hp);
  }
  return { dmg, kill, land };
}

/** Statuses on a monster: worth more on dangerous ones, little if it already has them. */
function foeStatusValue(sim: Sim, m: MonsterEntity, list: StatusApply[]): number {
  const t = threat(m);
  let v = 0;
  for (const st of list) {
    const turns = Math.min(st.turns, 2);
    const fresh = hasStatus(m, st.id) ? 0.25 : 1;
    switch (st.id) {
      case 'stunned':
        v += 1.3 * t * turns * fresh; // it skips its turn
        break;
      case 'dazed':
        v += 0.35 * t * turns * fresh;
        break;
      case 'blinded':
        v += 0.4 * t * turns * fresh;
        break;
      case 'marked':
        v += 1.2 * turns * sim.heroes.filter(standing).length * fresh; // the whole party gets advantage
        break;
      case 'burning':
      case 'poisoned':
        v += Math.min(2.5 * (st.power ?? 1) * turns, m.hp);
        break;
    }
  }
  return v;
}

/** Knocking a melee monster off a hero who'd rather fight from range. */
function pushValue(sim: Sim, m: MonsterEntity): number {
  if (!isMelee(m)) return 0;
  return sim.heroes.some((h) => standing(h) && sim.ranged.has(h.id) && dist(h, m) <= 1) ? 1.5 : 0.3;
}

function foeValue(sim: Sim, id: SkillId, s: SkillStats, m: MonsterEntity, main: boolean): number {
  const hit = strike(sim, id, s, m, main);
  let v = Math.min(hit.dmg, m.hp) + hit.kill * killValue(m);
  if (hit.dmg > 0) {
    if (m.boss || m.elite) v += 1.5;
    if (main) v -= m.hp * 0.02; // tie-break toward the wounded
  }
  const lives = hit.land * (1 - hit.kill);
  if (s.onHit) v += lives * foeStatusValue(sim, m, s.onHit);
  if (s.push) v += lives * pushValue(sim, m);
  return v;
}

/** Who a monster will go for, like game.ts: whoever taunted it, else the nearest standing hero (the most hurt on a tie). */
function targetOf(sim: Sim, m: MonsterEntity): PlayerEntity | undefined {
  const taunter = sim.heroes.find((h) => h.id === tauntedBy(m) && standing(h));
  if (taunter) return taunter;
  let top: PlayerEntity | undefined;
  for (const h of sim.heroes) {
    if (standing(h) && (!top || dist(h, m) < dist(top, m) || (dist(h, m) === dist(top, m) && h.hp < top.hp))) top = h;
  }
  return top;
}

/** How much a monster's next round is aimed at this hero: fully if it's their target, a little if they're in reach anyway. */
function aimedAt(sim: Sim, m: MonsterEntity, f: PlayerEntity): number {
  if (hasStatus(m, 'stunned')) return 0;
  if (targetOf(sim, m)?.id === f.id) return 1;
  return tauntedBy(m) ? 0 : 0.2;
}

/** Damage that could come at a hero next round from monsters that can reach them. */
function exposure(sim: Sim, f: PlayerEntity): number {
  let e = 0;
  for (const m of sim.monsters) if (dist(m, f) <= reachOf(m)) e += fullDamage(m) * aimedAt(sim, m, f);
  return e;
}

/** How dangerous the hero's tile is: melee monsters next to it count fully, two tiles away half (ranged ones shoot you anywhere). */
function danger(sim: Sim): number {
  let d = 0;
  for (const m of sim.monsters) {
    const r = dist(sim.me, m);
    if (!isMelee(m) || r > 2) continue;
    const w = clamp(threat(m) / 3, 0.5, 3) * Math.max(0.4, aimedAt(sim, m, sim.me));
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
      // Used up by this turn's attack: the setup gain counts that. Otherwise it waits for the next turn.
      return (f.id === sim.me.id && !sim.turn.actionUsed) || hasStatus(f, 'focused') ? 0 : 1.5;
    case 'riposte':
      return 1.2 * adjacentFoes(sim, f);
    default:
      return 0;
  }
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
    if (dist(m, me) > radius || hasStatus(m, 'stunned')) continue;
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
  if (!sim.root || sim.turn.actionUsed) return 0;
  const canAct = (moves: number) => memo(sim, `act:${moves}`, () => scan(variant(sim, sim.me), moves, actionAt).score) > 5;
  if (canAct(sim.turn.movesLeft)) return 0;
  return canAct(sim.turn.movesLeft + extra) ? 6 : 1;
}

/** Extra value of a bonus action that improves this turn's action (Feint, Mark for Death, Hit and Run...). */
function setupGain(sim: Sim, s: SkillStats, res: AimResult): number {
  const focus =
    (s.selfStatus ?? []).some((x) => x.id === 'focused') || (res.friends.some((f) => f.id === sim.me.id) && (s.status ?? []).some((x) => x.id === 'focused'));
  const mark = !s.roll && (s.onHit ?? []).some((x) => x.id === 'marked') ? res.foes[0] : undefined;
  if (!focus && !mark) return 0;
  const me = focus ? withStatus(sim.me, 'focused') : sim.me;
  const monsters = mark ? sim.monsters.map((m) => (m === mark ? withStatus(m, 'marked') : m)) : sim.monsters;
  const before = memo(sim, 'action', () => best(plansFrom(variant(sim, sim.me), false), 'action')?.score ?? 0);
  const after = best(plansFrom(variant(sim, me, monsters), false), 'action')?.score ?? 0;
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
  const offensive = s.target === 'enemy' || s.target === 'area' || s.target === 'around';
  if (offensive && !res.foes.length) return null;
  const me = sim.me;
  let score = 0;
  let early = false;
  res.foes.forEach((m, i) => (score += foeValue(sim, id, s, m, i === 0)));
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
  if (setup && s.cost !== 'action' && !sim.turn.actionUsed) {
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

/** A spot to act from: the best action there, plus the best bonus action there, minus danger. */
function engageAt(p: Sim): number {
  const plans = plansFrom(p, false);
  const action = best(plans, 'action');
  const bonus = best(plans, 'bonus');
  let score = action && action.score > 0 ? 10 + action.score : -0.5 * approachDist(p);
  if (bonus && bonus.score > MIN_BONUS) score += bonus.score;
  return score - dangerAt(p);
}

/** A spot to finish the turn on: the best bonus action there, then safety (ranged) or staying in the fight (melee). */
function afterAt(p: Sim): number {
  const bonus = best(plansFrom(p, false), 'bonus');
  let score = bonus && bonus.score > MIN_BONUS ? bonus.score : 0;
  if (p.ranged.has(p.me.id)) score += Math.min(nearestFoe(p), 3) * 0.2;
  else score -= Math.max(0, nearestFoe(p) - 1) * 0.3;
  return score - dangerAt(p);
}

// ---------------------------------------------------------------- the turn

const act = (p: Plan): HeroIntent => (p.target === undefined ? { kind: 'act', skill: p.skill } : { kind: 'act', skill: p.skill, target: p.target });

/** The next thing an auto-played hero should do on its turn. Call again after each step until it says 'end'. */
export function nextHeroIntent(v: HeroView): HeroIntent {
  const h = v.hero;
  if (!standing(h) || !v.monsters.length || hasStatus(h, 'stunned')) return END;
  const sim = rootSim(v);
  const plans = plansFrom(sim, true);
  const bonus = best(plans, 'bonus');
  const free = best(plans, 'free');

  // 1. Revives, emergency heals and setups (Feint, a dash to reach a target) come first.
  for (const p of [bonus, free]) if (p && p.early && p.score > MIN_BONUS) return act(p);

  // 2. Get to the best spot to act from (in reach, out of melee for ranged heroes, near a downed friend), then act.
  if (!v.turn.actionUsed) {
    const to = bestMove(sim, engageAt);
    if (to) return { kind: 'move', to };
    const action = best(plans, 'action');
    if (action && action.score > 0) return act(action);
  }

  // 3. Bonus and free actions (Shield Bash, Second Wind, Action Surge...), from a better spot if there is one.
  const to = bestMove(sim, afterAt);
  if (to) return { kind: 'move', to };
  for (const p of [free, bonus]) if (p && p.score > MIN_BONUS) return act(p);
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
