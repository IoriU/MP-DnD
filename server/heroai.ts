// Auto-play brain for heroes: AFK players, disconnected players, bot players and bot tests all use it.
// It only *decides*; the game runs each decision through the same validation as a human click.
// Skills are scored from their stats (see SkillStats in shared/skills.ts), so a new skill is playable without new AI code:
// every usable skill is tried on every sensible aim, checked with skillBlockReason + resolveAim, and given a utility score.
// Positioning comes from the same scoring: hit chances use shared/tactics.ts from the tile being considered, so tiles
// that flank a monster or reach its back score higher and the movement planner walks there on purpose.
// The battlefield (shared/surfaces.ts) is priced the same way: standing in or walking through hazards costs HP, skills
// are previewed on a copy of the field (explosions, electrified water, fire spreading over oil), area skills count the
// friends caught in them, and elements count resistances and the statuses they leave (Chilled, Frozen, Shocked, Stunned).

import { DIRS, canStep, dist, fallsIn, reachable, type MapLike } from '../shared/grid.ts';
import { AP_GAIN, AP_MAX, ATTACK_AP, BOSS, CLASSES, FULL_COVER, HELP_UP_HP, MAX_BONUS_AC, MONSTERS, sneakDice, statMod, statRoom, stealthBonus, type Stat } from '../shared/rules.ts';
import { attackAdvantage, canReact, coverFrom, dirTo, isFlanking, netAdvantage, turnsToFace } from '../shared/tactics.ts';
import {
  CLEANSED,
  SKILLS,
  SKIP_TURN,
  SLOWED,
  STATUSES,
  apOf,
  atEdge,
  attackBonus,
  debuffsOn,
  engineOf,
  enginePicks,
  stacksOf,
  avgDice,
  blockOf,
  canHitProps,
  countKind,
  damageMod,
  hasBranch,
  hasStatus,
  healBonus,
  heroDc,
  hitsOf,
  hotbar,
  hpCostOf,
  isSignature,
  limitFor,
  ROOTED,
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
  type Element,
  type SkillId,
  type SkillKind,
  type SkillStats,
  type StatusApply,
  type StatusId,
} from '../shared/skills.ts';
import {
  EXPLOSION,
  FIELD_STATUS_TURNS,
  HAZARD_DICE,
  aimFieldOps,
  damageFactor,
  fieldElement,
  hazardAt,
  immuneToStatus,
  planWalk,
  previewField,
  tilePos,
  tilesAround,
  type FieldLike,
  type FieldOp,
} from '../shared/surfaces.ts';
import { RELICS, bagRoom, gearDef, isItemId, itemPrice, type ItemId, type RelicId } from '../shared/items.ts';
import { isFoe } from '../shared/elites.ts';
import type {
  Entity, ItemRequest, MonsterEntity, NodeType, OfferCard, OwnedSkill, PickRequest, PlayerEntity, Pos, RestPick, ShopRequest, ShopView, TurnView,
} from '../shared/types.ts';

export interface HeroView {
  map: FieldLike;
  hero: PlayerEntity;
  heroes: PlayerEntity[];
  monsters: MonsterEntity[];
  allies?: MonsterEntity[]; // NPC allies: in the way, and not to be caught in your blasts
  turn: TurnView;
  occupied: (x: number, y: number, exceptId?: string) => boolean;
}

export type HeroIntent =
  | { kind: 'act'; skill: SkillId; target?: string | Pos } // entity id for enemy/ally, tile for area, omitted for self/around/allies
  | { kind: 'move'; to: Pos }
  | { kind: 'end' };

const END: HeroIntent = { kind: 'end' };
const MIN_QUICK = 0.5; // a quick (1 AP) or free skill has to be worth at least this much
const SAVE_AP = 0.2; // an AP saved for the next turn (only as many as the cap lets carry over): a tie-breaker, so bots
// bank AP when nothing is worth it rather than skipping useful quick skills
const REPEAT = 0.8; // a second swing of the same basic attack in one turn (the first may already have done the job)
const MOVE_MARGIN = 0.3; // don't shuffle around for tiny gains
const STEP_COST = 0.05; // per tile walked
const POTION_PRICE = 6; // potions are scarce: drink when it really helps
const REVIVE = 25; // getting a downed friend back up beats almost anything
const COVER_LIKE = 0.6; // full cover from a shooter that could hit you next round (half cover: less)
const FLANK_GIFT = 0.3; // standing across a monster from a friend gives them advantage on it too
const DOWN_PRICE = 25; // a friend (or you) going down: about what getting them back up is worth
const SETUP_ODDS_CAP = 0.7; // oil or water waits for a spark: someone has to bring it before it's gone (or the monsters walk off)

const standing = (p: PlayerEntity) => !p.dead && !p.downed;
const hpPct = (p: PlayerEntity) => p.hp / p.maxHp;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** Chance that d20 + bonus reaches `target` (a natural 1 always fails, a natural 20 always works). */
const d20 = (bonus: number, target: number) => clamp((21 + bonus - target) / 20, 0.05, 0.95);
/** Extra AC from Shielded (game.ts counts a Shielded without a power as +2). */
const shieldOf = (e: Entity) => e.statuses.reduce((s, x) => s + (x.id === 'shielded' ? (x.power ?? 2) : 0), 0);
/** Armor class right now, like game.ts: Shielded adds, Shocked takes 2 off, Spell Shield adds 2 while the ward holds. */
const acOf = (e: Entity) =>
  e.ac + shieldOf(e) - (hasStatus(e, 'shocked') ? 2 : 0) + (e.kind === 'player' && e.tempHp > 0 && hasBranch(e, 'arcane_ward', 'A') ? 2 : 0);
/** A copy with a pretend status (replacing any it has), or without one. */
/** Damage that has to go before HP does: Block, then a hero's temporary HP or an elite's ward. */
const soakOf = (e: Entity) => blockOf(e) + (e.kind === 'player' ? e.tempHp : (e.ward ?? 0));

const withStatus = <T extends Entity>(e: T, id: StatusId, power?: number): T => ({
  ...e,
  statuses: [...e.statuses.filter((x) => x.id !== id), power ? { id, turns: 1, power } : { id, turns: 1 }],
});
const without = <T extends Entity>(e: T, id: StatusId): T => (hasStatus(e, id) ? { ...e, statuses: e.statuses.filter((x) => x.id !== id) } : e);
/** Loses its next turn: stunned, frozen solid, or caught by surprise. */
const skipsTurn = (e: Entity) => SKIP_TURN.some((id) => hasStatus(e, id));
const isOffensive = (s: SkillStats) => s.target === 'enemy' || s.target === 'area' || s.target === 'around';
/** Grease, Create Water: no damage, they only leave something on the ground (and may have no foe in them). */
const isSetup = (s: SkillStats) => (!!s.surface && s.surface.at !== 'self' && !s.dmg) || !!s.trap || (!!s.raise && !s.raise.ring); // ...or a snare, or raised cover

// ---------------------------------------------------------------- numbers about monsters

/** Damage a monster deals in a round if every attack lands (with what the act, the party and the difficulty add). */
function fullDamage(m: MonsterEntity): number {
  const d = MONSTERS[m.type];
  return d ? d.attacks * Math.max(1, avgDice(d.dmg) + (m.dmgBonus ?? 0)) * (1 + BOSS.furyDmg * stacksOf(m, 'fury')) : 5;
}

/** Expected damage per round against a typical hero (AC 15). */
function threat(m: MonsterEntity): number {
  const d = MONSTERS[m.type];
  return d ? fullDamage(m) * d20(d.atk + (m.atkBonus ?? 0) + BOSS.furyAtk * stacksOf(m, 'fury'), 15) : 3;
}

const isMelee = (m: MonsterEntity) => (MONSTERS[m.type]?.range ?? 1) <= 1;
/** Moves next turn: dazed and chilled monsters get half (game.ts beginTurn). */
const movesOf = (m: MonsterEntity) => (SLOWED.some((id) => hasStatus(m, id)) ? Math.floor(m.speed / 2) : m.speed);
const reachOf = (m: MonsterEntity) => movesOf(m) + (MONSTERS[m.type]?.range ?? 1);
/** Monsters that set the others up (nets, webs, brands, Help riders, orders) are worth taking out first. */
function trickster(m: MonsterEntity): number {
  const d = MONSTERS[m.type];
  return d ? (d.trick ? 1 : 0) + (d.leader ? 2 : 0) + (d.rider ? 0.5 : 0) : 0;
}
/** What taking a monster out of the fight is worth (on top of the damage itself). */
const killValue = (m: MonsterEntity) => 3 + 1.5 * threat(m) + (m.boss || m.elite ? 3 : 0) + trickster(m);
const tauntedBy = (m: MonsterEntity) => m.statuses.find((x) => x.id === 'taunted')?.by;

// ---------------------------------------------------------------- the situation being scored

/** The fight as seen from one spot. Variants move the hero or add pretend statuses to score "what if". */
interface Sim {
  v: HeroView;
  me: PlayerEntity;
  heroes: PlayerEntity[];
  monsters: MonsterEntity[];
  turn: TurnView;
  ctx: AimCtx;
  spots: Pos[]; // centers worth trying for area skills
  price: number; // what a spell slot is worth right now
  ranged: Set<string>; // heroes who'd rather fight from a distance
  healer: boolean; // can heal (and so revive) someone this turn
  root: boolean; // the real situation: also weighs setups, dashes and refreshes
  actionLater: boolean; // there's AP for an attack this turn (and an attack would give a hidden hero away)
  memo: Map<string, number>;
  fx: FieldCache; // the battlefield, and what its tiles cost this hero
  odds: Record<'fire' | 'cold' | 'lightning', number>; // chance the party brings each element to a setup (oil, water) in time
}

/** A skill's effect on the battlefield, worked out once on a copy. */
interface Preview {
  field: FieldLike; // the battlefield afterwards
  blasts: Set<number>; // tiles caught in an explosion
  changed: Set<number>; // tiles where something new appeared (whoever stands there is affected)
  sparks: Partial<Record<'fire' | 'lightning', Preview>>; // what a later spark (oil) or shock (water) would set off
}

/** The battlefield as one hero sees it, computed once per decision (variants share it). */
interface FieldCache {
  field: FieldLike;
  empty: boolean; // no surfaces, clouds or props at all: nothing to preview
  walk: Float64Array | null; // harm of stepping onto each tile (null: nothing hurts anywhere)
  stand: Float64Array | null; // harm of ending the turn there, plus risks (see riskAt)
  fiery: boolean; // a monster throws fire (a firebomb on oil sets it all ablaze)
  frosty: boolean; // a monster's attacks are cold or lightning (a Wet hero freezes or gets stunned)
  propAims: Pos[]; // oil barrels and braziers with a monster near enough to care
  previews: Map<string, Preview | null>;
  paths: Map<string, Map<number, number>>; // walking distance to the enemies (or downed friends) from every tile
}

/** Not a hazard yet, but asking for one: oil when monsters throw fire, water or steam when their attacks freeze or shock. */
function riskAt(fx: Pick<FieldCache, 'fiery' | 'frosty'>, f: FieldLike, i: number): number {
  const g = f.ground[i]?.id;
  return (g === 'oil' && fx.fiery ? 2 : 0) + ((g === 'water' || f.clouds[i]?.id === 'steam') && fx.frosty ? 1.5 : 0);
}

function fieldCache(field: FieldLike, me: PlayerEntity, monsters: MonsterEntity[]): FieldCache {
  const tiles = new Set([...Object.keys(field.ground), ...Object.keys(field.clouds)].map(Number));
  const props = Object.keys(field.props).map(Number);
  const n = field.width * field.height;
  const kinds = monsters.map((m) => MONSTERS[m.type]);
  const fiery = kinds.some((d) => d?.element === 'fire' || !!d?.breath);
  const frosty = kinds.some((d) => d?.element === 'cold' || d?.element === 'lightning');
  let walk: Float64Array | null = null;
  let stand: Float64Array | null = null;
  for (const i of tiles) {
    const harm = hazardAt(field, i, me);
    const risk = riskAt({ fiery, frosty }, field, i);
    if (harm > 0) (walk ??= new Float64Array(n))[i] = harm;
    if (harm + risk > 0) (stand ??= new Float64Array(n))[i] = harm + risk;
  }
  const propAims = props.map((i) => tilePos(field, i)).filter((p) => monsters.some((m) => dist(m, p) <= 2));
  return { field, empty: !tiles.size && !props.length, walk, stand, fiery, frosty, propAims, previews: new Map(), paths: new Map() };
}

/** Which elements the standing party could bring to oil or water before it's gone (you a bit more surely than a friend). */
function partyOdds(v: HeroView): Sim['odds'] {
  const odds = { fire: 0, cold: 0, lightning: 0 };
  for (const h of v.heroes) {
    if (!standing(h)) continue;
    for (const el of ['fire', 'cold', 'lightning'] as const) {
      const has = h.skills.some((o) => {
        const s = statsOf(o);
        return SKILLS[o.id].kind !== 'passive' && s.element === el && !!s.dmg && isOffensive(s);
      });
      if (has) odds[el] = Math.min(SETUP_ODDS_CAP, odds[el] + (h.id === v.hero.id ? 0.35 : 0.3));
    }
  }
  return odds;
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

/**
 * Candidate centers for area skills: every open tile on or next to a monster, and friends standing in fire, poison or
 * oil (Create Water puts it out or washes it away).
 */
function areaSpots(v: HeroView): Pos[] {
  const seen = new Set<number>();
  const out: Pos[] = [];
  const add = (x: number, y: number) => {
    const idx = y * v.map.width + x;
    if (x < 0 || y < 0 || x >= v.map.width || y >= v.map.height || v.map.tiles[idx] === '#' || seen.has(idx)) return;
    seen.add(idx);
    out.push({ x, y });
  };
  for (const m of v.monsters) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(m.x + dx, m.y + dy);
  for (const h of v.heroes) {
    const g = v.map.ground[h.y * v.map.width + h.x]?.id;
    if (standing(h) && (g === 'fire' || g === 'poison' || g === 'oil')) add(h.x, h.y);
  }
  return out;
}

const aimCtx = (map: FieldLike, heroes: PlayerEntity[], monsters: MonsterEntity[], allies: MonsterEntity[] = []): AimCtx => ({
  map,
  entities: [...heroes, ...allies, ...monsters],
  inCombat: true,
});
const usable = (me: PlayerEntity, turn: TurnView) => hotbar(me).filter((id) => skillBlockReason(me, id, true, turn, true) === null);

function rootSim(v: HeroView): Sim {
  return {
    v,
    me: v.hero,
    heroes: v.heroes,
    monsters: v.monsters,
    turn: v.turn,
    ctx: aimCtx(v.map, v.heroes, v.monsters, v.allies),
    spots: areaSpots(v),
    price: slotPrice(v),
    ranged: new Set(v.heroes.filter(fightsFromRange).map((p) => p.id)),
    healer: usable(v.hero, v.turn).some((id) => {
      const s = statsOf(ownedSkill(v.hero, id)!);
      return (!!s.heal && !s.noRevive) || !!s.helpUp; // Help Up: everyone with 2 AP
    }),
    root: true,
    actionLater: v.turn.ap >= ATTACK_AP,
    memo: new Map(),
    fx: fieldCache(v.map, v.hero, v.monsters),
    odds: partyOdds(v),
  };
}

/** The same fight with the hero swapped (moved, or with a pretend status), and maybe monsters or the turn changed. */
function variant(sim: Sim, me: PlayerEntity, monsters = sim.monsters, turn = sim.turn): Sim {
  const heroes = sim.heroes.map((h) => (h.id === me.id ? me : h));
  // Walking up to monsters makes them turn to face you (unless you're hidden), so no free backstabs.
  const moved = me.x !== sim.me.x || me.y !== sim.me.y;
  if (moved) monsters = monsters.map((m) => (turnsToFace(m, me, me) ? { ...m, facing: dirTo(m, me) } : m));
  const actionLater = turn === sim.turn ? sim.actionLater : turn.ap >= ATTACK_AP;
  return { ...sim, me, heroes, monsters, turn, ctx: aimCtx(sim.fx.field, heroes, monsters, sim.v.allies), root: false, actionLater };
}

const standAt = (sim: Sim, pos: Pos) => variant(sim, { ...sim.me, x: pos.x, y: pos.y });

/** The same fight after paying for a skill: its AP are gone. */
const paid = (sim: Sim, s: SkillStats) => variant(sim, sim.me, sim.monsters, { ...sim.turn, ap: sim.turn.ap - s.ap });

/** After paying for this skill, there's still AP for an attack this turn. */
const attackAfter = (sim: Sim, s: SkillStats) => sim.actionLater && sim.turn.ap - s.ap >= ATTACK_AP;

/** The same fight on a changed battlefield (after a Quick Grease, say). */
function onField(sim: Sim, field: FieldLike): Sim {
  const v = variant(sim, sim.me);
  return { ...v, fx: fieldCache(field, sim.me, sim.monsters), ctx: aimCtx(field, v.heroes, v.monsters, sim.v.allies) };
}

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
  ap: number;
  repeat: boolean; // a basic attack: can be used again this turn if there's AP for it
  score: number;
  early: boolean; // do it before the attack: a revive, an emergency heal, a setup (Feint) or a dash to reach a target
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
function passiveDamage(me: PlayerEntity, id: SkillId, s: SkillStats, m: Entity): number {
  let b = 0;
  if (s.element === 'fire') b += passiveOf(me, 'elemental_affinity')?.value ?? 0;
  if (m.hp < m.maxHp / 2) b += passiveOf(me, 'opportunist')?.value ?? 0;
  // Subclass passives (server/game.ts bonusDamage).
  if (hasStatus(m, 'netted') || hasStatus(m, 'webbed') || hasStatus(m, 'prone')) b += passiveOf(me, 'ambusher')?.value ?? 0;
  const eye = passiveOf(me, 'deadeye');
  if (eye && dist(me, m) >= (hasBranch(me, 'deadeye', 'B') ? 4 : 5)) b += eye.value;
  const lust = passiveOf(me, 'bloodlust');
  if (lust && s.range <= 1 && (me.hp < me.maxHp / 2 || (hasBranch(me, 'bloodlust', 'B') && hasStatus(me, 'raging')))) b += lust.value;
  const blades = passiveOf(me, 'psychic_blades');
  if (blades && m.statuses.some((x) => !STATUSES[x.id].good)) b += blades.value * 3.5;
  if (SKILLS[id].kind === 'spell') b += passiveOf(me, 'empowered_evocation')?.value ?? 0;
  if (s.target === 'area') b += passiveOf(me, 'sculpt_spells')?.value ?? 0;
  if (hasBranch(me, 'catalyst', 'B') && (s.element === 'fire' || s.element === 'cold' || s.element === 'lightning')) b += 2;
  // Build engines (server/game.ts engineDamage).
  if (SKILLS[id].kind === 'spell') b += stacksOf(me, 'charged') * (hasBranch(me, 'arcane_charge', 'A') ? 2 : 1) + stacksOf(me, 'unleashed') * 3.5;
  if (s.per) {
    const n = { poison: stacksOf(m, 'poisoned'), radiance: stacksOf(m, 'seared'), debuffs: debuffsOn(m), focus: stacksOf(me, 'aiming'), block: blockOf(me), verses: stacksOf(me, 'verse') }[s.per.of];
    b += n * ((s.per.dice ? avgDice(s.per.dice) : 0) + (s.per.flat ?? 0));
  }
  if (s.element === 'lightning' && hasStatus(m, 'wet') && passiveOf(me, 'conductor') && s.dmg) b += (s.dmg.n * (s.dmg.d + 1)) / 2;
  if (hasStatus(m, 'frozen')) b += (passiveOf(me, 'shatter_point')?.value ?? 0) * 3.5;
  if (hasStatus(m, 'prone')) b += (passiveOf(me, 'stomp')?.value ?? 0) * 3.5;
  const fury = passiveOf(me, 'blood_fury');
  if (fury && s.range <= 1) b += fury.value * Math.floor((10 * (me.maxHp - me.hp)) / me.maxHp);
  if (s.element === 'radiant') b += stacksOf(m, 'seared');
  b += stacksOf(me, 'inspired') * 3.5;
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

/** Damage multiplier of a skill's element on a creature: resistances, Wet against fire; 1 for plain weapons. */
const factorOf = (e: Entity, el: Element | undefined) => (el && el !== 'physical' ? damageFactor(e, el) : 1);

/**
 * Expected damage, kill chance and landing chance of a damaging skill against one monster. Resistances scale the damage:
 * nothing against an immune monster, negative (it heals) against one that drinks the element in.
 */
/**
 * `scale`: the share of the damage it takes (half on the outer ring of a Fireball). `origin`: where a DEX save's blast
 * comes from, for cover (attack rolls are from where you stand).
 */
function strike(sim: Sim, id: SkillId, s: SkillStats, m: MonsterEntity, main: boolean, scale = 1, origin: Pos = sim.me): Strike {
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
  let honed = 0; // expected extra damage on the first hit
  if (s.roll === 'attack') {
    const bonus = attackBonus(me, s) + (hasStatus(me, 'blessed') ? 2 : 0) - (hasStatus(me, 'dazed') ? 2 : 0);
    const base = d20(bonus, acOf(m) + coverFrom(sim.ctx.map, sim.me, m));
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
    if (main) honed = (me.statuses.find((x) => x.id === 'honed')?.power ?? 0) * 4.5; // Precision Strike: d8s on the next hit
  } else {
    let p = 1;
    if (s.roll === 'save') {
      const mod = (MONSTERS[m.type]?.[s.save ?? 'dex'] ?? 0) + ((s.save ?? 'dex') === 'dex' ? coverFrom(sim.ctx.map, origin, m) : 0);
      p = clamp((heroDc(me) - 1 - mod) / 20, 0, 1); // fails on d20 + mod < DC
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
  const mark = passiveOf(me, 'death_mark'); // Death Mark: more dice on the Poisoned (or Marked)
  const doomed = !!mark && (hasStatus(m, 'poisoned') || (hasBranch(me, 'death_mark', 'B') && hasStatus(m, 'marked')));
  const sneak = main && s.sneak && !me.used.includes('turn:sneak') ? sneakDice(me.level) + (doomed ? mark.value : 0) : 0;
  const ally = sneak > 0 && allyNextTo(sim, m);
  const pSneak = sneak ? 1 - ps.reduce((q, p, i) => (ally || advs[i] ? q * (1 - p) : q), 1) : 0;
  const half = s.roll === 'save' && !!s.half;
  let dmg = sneak * 3.5 * pSneak + (ambush * 3.5 + honed) * (ps[0] ?? 0);
  for (let i = 0; i < hits; i++) dmg += ps[i] * per + crits[i] * roll + (half ? ((1 - ps[i]) * per) / 2 : 0);
  const factor = factorOf(m, s.element) * scale;
  if (factor <= 0) return { dmg: factor * dmg, kill: 0, land }; // immune, or it heals
  // Kill chance: over how many hits land (they can have different odds), with the bonus dice if any did.
  const extraDice = land > 0 ? (sneak * pSneak + ambush * (ps[0] ?? 0)) / land : 0; // given at least one hit
  let kill = 0;
  successOdds(ps).forEach((pk, k) => {
    if (pk < 1e-4) return;
    let mean = k * per + (k ? extraDice * 3.5 + honed : 0);
    let variance = k * rollVar + (k ? (extraDice * 35) / 12 : 0);
    if (half) {
      mean += ((hits - k) * per) / 2;
      variance += ((hits - k) * rollVar) / 4;
    }
    kill += pk * atLeast(mean, variance, (m.hp + soakOf(m)) / factor);
  });
  return { dmg: dmg * factor, kill, land };
}

/** Statuses on a monster: worth more on dangerous ones, nothing for turns it already has them (or skips anyway). */
function foeStatusValue(sim: Sim, m: MonsterEntity, list: StatusApply[]): number {
  const t = threat(m);
  const skip = skipsTurn(m) ? 1 : 0; // stunned, frozen or surprised: its next turn is lost already
  let v = 0;
  for (const st of list) {
    const turns = Math.min(st.turns, 2);
    const have = m.statuses.find((x) => x.id === st.id)?.turns ?? 0;
    const fresh = Math.max(0, turns - have); // a reapplied status only lasts longer
    const acting = Math.max(0, turns - Math.max(have, skip)); // turns it would actually act under it
    switch (st.id) {
      case 'stunned':
      case 'frozen':
        v += 1.3 * t * acting; // it skips its turn
        break;
      case 'dazed':
        v += 0.35 * t * acting;
        break;
      case 'chilled': {
        // Half movement: only slows down a melee monster that still has to walk to someone.
        const walking = isMelee(m) && !sim.heroes.some((h) => standing(h) && dist(h, m) <= 1);
        v += (walking ? 0.25 : 0.05) * t * acting;
        break;
      }
      case 'blinded':
        v += 0.4 * t * acting;
        break;
      case 'frightened': // it runs instead of attacking (and gets away from whoever it was on)
        v += 1.1 * t * acting;
        break;
      case 'prone': {
        // Melee friends near it get advantage until it gets up (and it loses half its movement doing that).
        const near = sim.heroes.filter((h) => standing(h) && dist(h, m) <= 2).length;
        v += fresh ? 0.8 * near + 0.1 * t : 0;
        break;
      }
      case 'netted':
      case 'webbed': {
        // It can't walk: a melee monster with nobody next to it is out of the fight.
        const engaged = sim.heroes.some((h) => standing(h) && dist(h, m) <= 1);
        v += fresh * ((isMelee(m) && !engaged ? 0.6 : 0.15) * t + (st.id === 'webbed' ? 0.8 : 0.4) * sim.heroes.filter(standing).length);
        break;
      }
      case 'taunted': {
        // Compelled Duel: its attacks come at you instead of a friend.
        const sturdy = hpPct(sim.me) >= 0.6 ? 1 : hpPct(sim.me) >= 0.4 ? 0.3 : -0.6;
        v += acting * fullDamage(m) * (targetOf(sim, m)?.id !== sim.me.id ? 0.3 : 0.05) * sturdy;
        break;
      }
      case 'marked':
        v += 1.2 * fresh * sim.heroes.filter(standing).length; // the whole party gets advantage
        break;
      case 'shocked':
        v += 0.5 * fresh * sim.heroes.filter(standing).length; // -2 AC: everyone hits it a bit more often
        break;
      case 'burning':
        // Ticks even on a lost turn. A Wet monster just dries off; fire-proof ones don't care.
        if (!immuneToStatus(m, 'burning') && !hasStatus(m, 'wet')) v += Math.min(2.5 * (st.power ?? 1) * fresh * Math.max(0, damageFactor(m, 'fire')), m.hp);
        break;
      case 'poisoned':
        if (!immuneToStatus(m, 'poisoned')) v += Math.min(2.5 * (st.power ?? 1) * fresh * Math.max(0, damageFactor(m, 'poison')), m.hp);
        break;
    }
  }
  return v;
}

/** Wet (from the status, or standing in water or steam): lightning stuns it, cold freezes it, fire does half. */
const isWet = (f: FieldLike, e: Entity) => {
  const i = e.y * f.width + e.x;
  return hasStatus(e, 'wet') || f.ground[i]?.id === 'water' || f.clouds[i]?.id === 'steam';
};

/**
 * What an element does to a monster it hurts and doesn't kill (game.ts elementHit): cold chills, or freezes a Wet or
 * Chilled one; lightning shocks, or stuns a Wet or Shocked one; fire thaws (giving a frozen monster its turn back).
 */
function elementValue(sim: Sim, m: MonsterEntity, el: Element): number {
  const wet = isWet(sim.fx.field, m);
  switch (el) {
    case 'cold':
      if (hasStatus(m, 'frozen')) return 0;
      return foeStatusValue(sim, m, [wet || hasStatus(m, 'chilled') ? { id: 'frozen', turns: 1 } : { id: 'chilled', turns: FIELD_STATUS_TURNS }]);
    case 'lightning':
      if (hasStatus(m, 'stunned')) return 0;
      return foeStatusValue(sim, m, [wet || hasStatus(m, 'shocked') ? { id: 'stunned', turns: 1 } : { id: 'shocked', turns: FIELD_STATUS_TURNS }]);
    case 'fire': {
      const thawed = m.statuses.filter((x) => x.id === 'frozen' || x.id === 'chilled');
      if (!thawed.length) return 0;
      const bare = { ...m, statuses: m.statuses.filter((x) => !thawed.includes(x)) };
      return -foeStatusValue(sim, bare, thawed.map((x) => ({ id: x.id, turns: x.turns })));
    }
    default:
      return 0;
  }
}

const occupiedIn = (sim: Sim, x: number, y: number, exceptId: string) =>
  sim.ctx.entities.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead));

/** The tiles a knockback drags a monster through, like game.ts: straight away from `from`, stopped by walls and creatures. */
function pushPath(sim: Sim, m: MonsterEntity, from: Pos, tiles: number): Pos[] {
  const dx = Math.sign(m.x - from.x);
  const dy = Math.sign(m.y - from.y);
  const path: Pos[] = [];
  if (!dx && !dy) return path;
  let at: Pos = { x: m.x, y: m.y };
  for (let i = 0; i < tiles; i++) {
    if (!canStep(sim.fx.field, at, dx, dy) || occupiedIn(sim, at.x + dx, at.y + dy, m.id)) break;
    at = { x: at.x + dx, y: at.y + dy };
    path.push(at);
  }
  return path;
}

/**
 * What a knockback is worth: where it ends up, and every hazard it's shoved through (fire, poison, electrified water). Over
 * the edge of a pit, the monster is gone (an elite or a boss usually catches the edge).
 */
function pushValue(sim: Sim, m: MonsterEntity, from: Pos, tiles: number): number {
  const path = pushPath(sim, m, from, tiles);
  const to = path[path.length - 1] ?? m;
  const [dx, dy] = [Math.sign(m.x - from.x), Math.sign(m.y - from.y)];
  if (path.length < tiles && (dx || dy) && fallsIn(sim.fx.field, to, dx, dy)) return (m.elite || m.boss ? 0.35 : 1) * (1.2 * m.hp + 10);
  let harm = 0;
  if (sim.fx.walk) for (const p of path) harm += hazardAt(sim.fx.field, p.y * sim.fx.field.width + p.x, m);
  return pushGain(sim, m, to) + 0.8 * Math.min(harm, m.hp);
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
  return (win - far) * pushValue(sim, m, sim.me, tiles) + far * pushValue(sim, m, sim.me, tiles + 1);
}

/**
 * One foe's share of a skill's value. `from`: where a knockback pushes it away from. `own`: the skill's effect on the
 * battlefield (`stunned`: the monsters it stuns anyway, by electrified water, so its own lightning doesn't count twice).
 */
function foeValue(
  sim: Sim, id: SkillId, s: SkillStats, res: AimResult, m: MonsterEntity, main: boolean, from: Pos, own: Preview | null, stunned: Set<string>,
): number {
  if (s.roll === 'contest') return shoveValue(sim, s, m);
  const hit = strike(sim, id, s, m, main, atEdge(s, res.center, m) ? 0.5 : 1, s.target === 'area' ? res.center : sim.me);
  // Damage up to its HP; healing (a Magma Imp drinking fire) up to what it's missing.
  // Damage into Block or a ward is worth a little (it's gone for the next hit), the rest counts up to its HP.
  const soak = soakOf(m);
  const into = hit.dmg >= 0 ? Math.min(Math.max(0, hit.dmg - soak), m.hp) + 0.3 * Math.min(hit.dmg, soak) : Math.max(hit.dmg, m.hp - m.maxHp);
  // A boss fight is a race: when the boss falls the rest flee (they count as killed), and a Rise Again boss's minions
  // don't stay down while it stands.
  const rises = !m.boss && sim.monsters.some((b) => b.boss && MONSTERS[b.type]?.signature === 'rise');
  let v = into + hit.kill * killValue(m) * (rises ? 0.4 : 1);
  if (m.boss) v += 0.25 * into + hit.kill * sim.monsters.filter((x) => x.id !== m.id).reduce((n, x) => n + killValue(x), 0);
  if (hit.dmg > 0) {
    if (m.boss || m.elite) v += 1.5;
    if (main) v -= m.hp * 0.02; // tie-break toward the wounded
  }
  const lives = hit.land * (1 - hit.kill);
  if (s.onHit) v += lives * foeStatusValue(sim, m, s.onHit);
  if (s.push) v += lives * pushValue(sim, m, from, s.push);
  // The element's own status: only when it actually takes damage (a save for half still counts), and not when the skill
  // freezes or stuns it anyway (Deep Freeze) or the electrified water does.
  const skips = (s.onHit ?? []).some((x) => SKIP_TURN.includes(x.id)) || (s.element === 'lightning' && stunned.has(m.id));
  if (s.dmg && s.element && hit.dmg > 0 && !skips) {
    const hurt = (s.roll === 'save' && s.half ? 1 : hit.land) * (1 - hit.kill);
    v += hurt * elementValue(sim, m, s.element);
  }
  if (hit.kill > 0 && MONSTERS[m.type]?.death) v += hit.kill * deathValue(sim, id, s, res, m, own);
  return v;
}

/** Monsters look past a hidden hero while anyone else is in the open, unless that hero gives themself away by attacking this turn. */
const unseen = (sim: Sim, h: PlayerEntity) => hasStatus(h, 'hidden') && !(h.id === sim.me.id && sim.actionLater);

/**
 * Who a monster will go for (server/monsterai.ts): whoever taunted it; else the closest hero its squad hunts, if it can get to them;
 * else the nearest standing hero (the most hurt on a tie), skipping hidden heroes when someone else is standing.
 */
function targetOf(sim: Sim, m: MonsterEntity): PlayerEntity | undefined {
  const taunter = sim.heroes.find((h) => h.id === tauntedBy(m) && standing(h));
  if (taunter) return taunter;
  const up = sim.heroes.filter(standing);
  const seen = up.filter((h) => !unseen(sim, h));
  const hunted = seen.filter((h) => sim.turn.focus?.includes(h.id) && dist(h, m) <= reachOf(m)).sort((a, b) => dist(a, m) - dist(b, m))[0];
  if (hunted) return hunted;
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
    // Cover from the archers that can shoot this tile: they need more to hit you.
    if (!isMelee(m) && r > 1 && r <= reachOf(m)) {
      const cover = coverFrom(sim.ctx.map, m, sim.me);
      if (cover) d -= COVER_LIKE * (cover / FULL_COVER) * clamp(threat(m) / 3, 0.5, 3) * Math.max(floor, aimedAt(sim, m, sim.me));
    }
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
    case 'raging': {
      // More damage on melee hits, half the physical damage taken: worth it in the thick of it.
      if (hasStatus(f, 'raging')) return 0;
      const melee = adjacentFoes(sim, f) > 0 || sim.monsters.some((m) => dist(m, f) <= f.speed + 1);
      return melee ? turns * ((st.power ?? 2) * 1.2 + 0.25 * exposure(sim, f)) : 0.3;
    }
    case 'rallied': {
      const have = f.statuses.find((x) => x.id === 'rallied')?.power ?? 0;
      if (have >= (st.power ?? 1) * (st.stack ?? 1)) return 0;
      return Math.min(st.turns, 3) * (st.power ?? 1) * (0.1 * (5 + f.level) + 0.7) * (f.id === sim.me.id || standing(f) ? 1 : 0);
    }
    case 'marked': // Reckless Attack: the monsters get advantage on you
      return -0.3 * exposure(sim, f) * turns;
    case 'honed': // used up by this turn's attack (setupGain counts that), else saved for the next one
      return (f.id === sim.me.id && sim.actionLater) || hasStatus(f, 'honed') ? 0 : 1.5 * (st.power ?? 1);
    case 'envenomed': {
      // Envenom: every weapon hit for a couple of turns poisons (about 2.5 a hit, more with Death Mark).
      if (hasStatus(f, 'envenomed') || !f.skills.some((o) => SKILLS[o.id].kind === 'basic')) return 0;
      const fight = sim.monsters.some((m) => dist(m, f) <= f.speed + 1);
      return fight ? turns * 2.5 * (st.power ?? 1) * (passiveOf(f, 'death_mark') ? 1.5 : 1) : 0.3;
    }
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

/** What a hidden hero throws away with a quick skill that gives them away without an attack roll (Shove, Feint). */
function hiddenWorth(sim: Sim): number {
  const h = sim.me.statuses.find((x) => x.id === 'hidden');
  if (!h) return 0;
  if (sim.actionLater) return 2 + (h.power ?? 0) * 3.5 * 0.6; // the advantage this turn's attack was going to get
  return hideValue(sim, without(sim.me, 'hidden'), h.power);
}

/**
 * How much getting a downed friend up is worth (of REVIVE): they come back Groggy and lose their next turn, so with the
 * monsters around them able to put them down again first, it mostly just saves their death saves (and each time they
 * go down again in a fight their saves start worse, see game.ts MAX_DOWNS). A friend close to dying is worth it anyway.
 */
function upAgain(sim: Sim, f: PlayerEntity, hp: number): number {
  const hits = sim.monsters.filter((m) => !skipsTurn(m) && dist(m, f) <= reachOf(m)).reduce((n, m) => n + 0.6 * fullDamage(m), 0);
  const odds = hits < hp ? 1 : hits < 2 * hp ? 0.5 : 0.15;
  return f.saves.fail >= 2 ? Math.max(odds, 0.7) : odds;
}

const healWeight = (f: PlayerEntity) => (hpPct(f) < 0.35 ? 1.6 : hpPct(f) < 0.6 ? 0.9 : 0.3);

/** Heals and buffs on one friend (you included). */
function friendValue(sim: Sim, s: SkillStats, f: PlayerEntity): number {
  let v = 0;
  if (s.helpUp) return f.downed ? REVIVE * upAgain(sim, f, Math.ceil(f.maxHp * HELP_UP_HP)) + Math.ceil(f.maxHp * HELP_UP_HP) : 0;
  if (s.heal) {
    const amt = avgDice(s.heal) + healBonus(sim.me, s);
    const missing = f.maxHp - f.hp;
    if (f.downed) v += s.noRevive ? 0 : REVIVE * upAgain(sim, f, amt) + amt;
    else v += Math.min(amt, missing) * healWeight(f) + (s.overheal ? Math.max(0, amt - missing) * 0.3 : 0);
  } else if (!standing(f)) {
    return 0; // buffs don't help someone lying on the floor
  }
  if (s.tempHp) v += avgDice(s.tempHp) * (exposure(sim, f) > 0 ? 0.5 : 0.1);
  if (s.block) v += blockWorth(sim, f, avgDice(s.block) + (s.blockLevel ? sim.me.level : 0));
  if (s.cleanse) v += 1.5 * f.statuses.filter((x) => CLEANSED.includes(x.id)).length;
  // Out of a net or a web: free to move again, and a web's advantage for the monsters is gone.
  if (s.frees) v += (hasStatus(f, 'webbed') ? 4 : 2.5) + 0.2 * exposure(sim, f);
  for (const st of s.status ?? []) v += heroStatusValue(sim, f, st);
  return v;
}

/**
 * 🧱 Block until your next turn on a friend (you included): the hits it soaks before then (about 60% of what could come
 * at them lands), priced like heals by how hurt those hits would leave them, and dearest when they could drop them.
 */
function blockWorth(sim: Sim, f: PlayerEntity, n: number): number {
  if (!standing(f)) return 0;
  const e = 0.6 * exposure(sim, f);
  const have = blockOf(f);
  const soak = Math.max(0, Math.min(have + n, e) - Math.min(have, e));
  const left = f.hp + f.tempHp + have - e;
  return soak * (left <= 0 ? 2 : healWeight({ ...f, hp: left }));
}

/**
 * The engines' active cards that aren't plain damage, heals or statuses: Toxic Catalyst (more Poison over the next
 * turns), Entrench (your Block again), Unleash (Charges into dice), raised cover and walls, Finale (heals and Block per
 * Verse on every friend). Rough prices: these are the setups the hit math doesn't see.
 */
function engineValue(sim: Sim, s: SkillStats, res: AimResult): number {
  const me = sim.me;
  let v = 0;
  if (s.poisonMult) for (const m of res.foes) v += Math.min(stacksOf(m, 'poisoned') * (s.poisonMult - 1), 10) * 2.5 * 1.5;
  if (s.doubleBlock) v += blockWorth(sim, me, me.block?.[me.id] ?? 0);
  if (s.unleash) v += stacksOf(me, 'charged') * 3.5 * (me.slots > 0 ? 0.8 : 0.2) - 0.5;
  if (s.raise) {
    const shooters = sim.monsters.filter((m) => !isMelee(m)).length;
    const near = sim.monsters.filter((m) => dist(m, res.center) <= 2).length;
    if (s.raise.ring) v += res.main && isMelee(res.main as MonsterEntity) && !sim.heroes.some((h) => standing(h) && dist(h, res.main!) <= 1) ? 2 + threat(res.main as MonsterEntity) : 0;
    else if (s.raise.cover === 'wall') v += near ? 1.5 * near : 0;
    else v += sim.heroes.some((h) => standing(h) && dist(h, res.center) <= 1) ? 0.8 * shooters : 0;
  }
  if (s.rubble) v += 0.3 * s.rubble;
  if (s.finale) {
    const verses = stacksOf(me, 'verse');
    for (const f of res.friends) if (standing(f)) v += Math.min(s.finale.heal * verses, f.maxHp - f.hp) * healWeight(f) + blockWorth(sim, f, s.finale.block * verses);
    if (verses < 3) v -= 3; // wait for more Verses
  }
  return v;
}

/**
 * Snare Trap: a melee monster on its way to someone walks into the tiles between it and its target, so a snare there is
 * likely to catch it (about 35% if it's right next to it and still has to walk). Worth what Netted and the damage are.
 */
function trapValue(sim: Sim, s: SkillStats, at: Pos): number {
  const r = s.radius ?? 0;
  let v = 0;
  for (const m of sim.monsters) {
    if (!isMelee(m) || skipsTurn(m) || ROOTED.some((id) => hasStatus(m, id))) continue;
    const target = targetOf(sim, m);
    if (!target || dist(m, target) <= 1) continue; // already there: it won't walk
    const near = dist(m, at) <= 1 + r && dist(at, target) < dist(m, target);
    if (!near) continue;
    const odds = Math.min(0.6, 0.35 * (1 + r));
    v += odds * (foeStatusValue(sim, m, s.trap!.status) + (s.trap!.dmg ? avgDice(s.trap!.dmg) : 0) + 0.5 * fullDamage(m));
  }
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

/**
 * The best way to spend the AP left from a spot (with the walk there already paid), or 0 if it holds no attack-sized
 * move. Plus 10 so "can act" beats "can't".
 */
const actionAt = (p: Sim) => {
  const c = spend(plansFrom(p, false), p.turn.ap);
  return c.main ? 10 + c.score : 0;
};

/** The best way to spend the AP left from a spot, attack or not. */
const spendAt = (p: Sim) => spend(plansFrom(p, false), p.turn.ap).score;

/** Action Surge: AP back, worth what they buy this turn. Spend what you have first: the surge is for after the attack. */
function refreshValue(sim: Sim, s: SkillStats): number {
  const left = sim.turn.ap - s.ap;
  if (left >= ATTACK_AP) return -5;
  if (!sim.root) return 0;
  return memo(sim, `refresh:${left}`, () => {
    const moves = sim.turn.movesLeft;
    const fresh = scan(variant(sim, sim.me, sim.monsters, { ...sim.turn, ap: left + (s.gainAp ?? 0) }), moves, spendAt).score;
    const without = scan(variant(sim, sim.me, sim.monsters, { ...sim.turn, ap: left }), moves, spendAt).score;
    return Math.max(0, fresh - without);
  });
}

/** Extra movement is worth a lot when it's the only way to reach a target this turn (with AP left to attack it). */
function dashValue(sim: Sim, s: SkillStats): number {
  if (!sim.root || !attackAfter(sim, s) || ROOTED.some((id) => hasStatus(sim.me, id))) return 0; // stuck: a dash waits until it's free
  const canAct = (moves: number, ap: number) =>
    memo(sim, `act:${moves}:${ap}`, () => scan(variant(sim, sim.me, sim.monsters, { ...sim.turn, ap }), moves, actionAt).score) > 5;
  if (canAct(sim.turn.movesLeft, sim.turn.ap)) return 0;
  return canAct(sim.turn.movesLeft + (s.dash ?? 0), sim.turn.ap - s.ap) ? 6 : 1;
}

/**
 * Extra value of a quick skill that improves this turn's attack (Feint, Hide, Mark for Death, Hit and Run...): the best
 * spend of the AP left that you can still walk to with it, against the best one without (which may already have
 * advantage from a flank, and has the AP the setup would cost).
 */
function setupGain(sim: Sim, s: SkillStats, res: AimResult): number {
  const mine = [...(s.selfStatus ?? []), ...(res.friends.some((f) => f.id === sim.me.id) ? (s.status ?? []) : [])].filter(
    (x) => x.id === 'focused' || x.id === 'hidden' || x.id === 'honed',
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
  const left = { ...sim.turn, ap: sim.turn.ap - s.ap };
  const after = memo(sim, `${key}:${left.ap}`, () => gain(scan(variant(sim, me, monsters, left), moves, actionAt).score));
  return Math.max(0, after - Math.max(0, before));
}

// ---------------------------------------------------------------- the battlefield

/**
 * What expected damage costs a friend (or you): a bit more than the same damage on a monster, dearer the lower it
 * leaves them (priced at the middle of the drop), and going down costs about a revive.
 */
function heroLoss(h: PlayerEntity, dmg: number, down: number): number {
  if (dmg <= 0) return down * DOWN_PRICE;
  const mid = clamp((h.hp + soakOf(h) - dmg / 2) / h.maxHp, 0, 1);
  return dmg * (1.2 + 1.2 * (1 - mid)) + down * DOWN_PRICE;
}

/** Standing in or stepping into hazards (hazardAt's expected harm, with stuns and falls priced in). */
function harmCost(h: PlayerEntity, harm: number, down = 0): number {
  if (harm <= 0) return 0;
  const left = h.hp + soakOf(h);
  return heroLoss(h, harm, Math.max(down, harm >= left ? 0.6 : 2 * harm >= left ? 0.15 : 0));
}

const tileOf = (f: FieldLike, p: Pos) => p.y * f.width + p.x;
/** Ending the turn on this tile: what it does at the start of your next turn, and the risks around it. */
const standCost = (p: Sim) => harmCost(p.me, p.fx.stand?.[tileOf(p.fx.field, p.me)] ?? 0);

/**
 * The least harm of walking to each tile within `moves` steps: every hazard stepped into hurts (leaving the one you
 * stand on doesn't). game.ts walks around hazards when that still gets there (planWalk), so a safe detour is free.
 * Null when nothing on the battlefield hurts this hero.
 */
function walkHarm(sim: Sim, moves: number, blocked: (x: number, y: number) => boolean): { harm: Map<number, number>; prev: Map<number, number> } | null {
  const { walk, field } = sim.fx;
  if (!walk) return null;
  const w = field.width;
  const start = tileOf(field, sim.me);
  const harm = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>(); // the step before, on the least harmful way there
  let frontier = [start];
  for (let step = 1; step <= moves && frontier.length; step++) {
    const next = new Set<number>();
    for (const cur of frontier) {
      const at = tilePos(field, cur);
      const sofar = harm.get(cur)!;
      for (const [dx, dy] of DIRS) {
        if (!canStep(field, at, dx, dy) || blocked(at.x + dx, at.y + dy)) continue;
        const ni = cur + dy * w + dx;
        const h = sofar + walk[ni];
        if (h < (harm.get(ni) ?? Infinity)) {
          harm.set(ni, h);
          prev.set(ni, cur);
          next.add(ni);
        }
      }
    }
    frontier = [...next];
  }
  return { harm, prev };
}

/**
 * Where to send a move so it's walked the way it was priced. game.ts walks it with planWalk: around hazards when that
 * detour fits in the moves left, straight through otherwise, which can cross more fire than the least harmful route
 * the scan priced. Then the move goes in legs: to the furthest tile on the priced route that planWalk reaches as cheaply.
 */
function routeTo(sim: Sim, to: Pos): Pos {
  const fx = sim.fx;
  const moves = sim.turn.movesLeft;
  const blocked = (x: number, y: number) => sim.v.occupied(x, y, sim.me.id);
  const dp = fx.walk ? walkHarm(sim, moves, blocked) : null;
  if (!dp || !fx.walk) return to;
  const walk = fx.walk;
  const walked = (p: Pos) => {
    const plan = planWalk(fx.field, sim.me, p, moves, blocked, sim.me);
    const end = plan?.path[plan.path.length - 1];
    if (!plan || !end || end.x !== p.x || end.y !== p.y) return Infinity;
    return plan.hazards.reduce((sum, h) => sum + walk[tileOf(fx.field, h)], 0);
  };
  const cheap = (i: number) => walked(tilePos(fx.field, i)) <= (dp.harm.get(i) ?? Infinity) + 1e-6;
  const goal = tileOf(fx.field, to);
  if (cheap(goal)) return to;
  const route: number[] = [];
  const start = tileOf(fx.field, sim.me);
  for (let i = goal; i !== start && route.length <= moves + 1; i = dp.prev.get(i) ?? start) route.push(i);
  for (const i of route.slice(1)) if (cheap(i)) return tilePos(fx.field, i); // from the far end back
  return to;
}

function makePreview(field: FieldLike, ops: FieldOp[]): Preview {
  const p = previewField(field, ops, []);
  return { field: p.field, blasts: new Set(p.result.blasts), changed: new Set(p.result.changed), sparks: {} };
}

/** Identifies a skill's aim for the preview caches (what it reaches only depends on these). */
function aimKey(sim: Sim, id: SkillId, s: SkillStats, res: AimResult): string {
  const at = s.target === 'around' ? sim.me : res.center;
  return `${id}|${at.x},${at.y}|${res.prop ?? ''}|${res.foes.map((m) => m.id).join()}`;
}

/**
 * What a skill aimed like this does to the battlefield (worked out once per aim and shared by every variant), or null
 * when nothing it reaches reacts and it leaves nothing behind.
 */
function fieldPreview(sim: Sim, id: SkillId, s: SkillStats, res: AimResult): Preview | null {
  const fx = sim.fx;
  const leaves = !!s.surface && s.surface.at !== 'self';
  if (!leaves && res.prop === undefined && (fx.empty || !fieldElement(s.element))) return null;
  const key = aimKey(sim, id, s, res);
  let p = fx.previews.get(key);
  if (p === undefined) {
    const f = fx.field;
    const ops = aimFieldOps(s, sim.me, res, f);
    const live = ops.some((op) => op.kind !== 'touch' || op.tiles.some((i) => f.ground[i] || f.clouds[i] || f.props[i]));
    p = live ? makePreview(f, ops) : null;
    fx.previews.set(key, p);
  }
  return p;
}

const EXPLOSION_AVG = avgDice(EXPLOSION);
const EXPLOSION_VAR = (EXPLOSION.n * (EXPLOSION.d ** 2 - 1)) / 12;

/** An explosion's 2d6 fire on a monster (resistances count: a Magma Imp drinks it in), and the chance it kills it. */
function blastValue(sim: Sim, m: MonsterEntity): { value: number; kill: number } {
  const k = damageFactor(m, 'fire');
  if (k <= 0) return { value: Math.max(k * EXPLOSION_AVG, m.hp - m.maxHp), kill: 0 };
  const kill = atLeast(EXPLOSION_AVG * k, EXPLOSION_VAR * k * k, m.hp + soakOf(m));
  return { value: Math.min(EXPLOSION_AVG * k, m.hp) + kill * killValue(m) + (1 - kill) * elementValue(sim, m, 'fire'), kill };
}

/**
 * What appearing in a tile's hazard does to a monster right away (game.ts standIn): fire or lava burns it, poison
 * poisons it, electrified water or steam zaps it and stuns it (the water makes it Wet first). `stun`: it ends up stunned.
 */
function monsterHarm(sim: Sim, m: MonsterEntity, f: FieldLike, i: number): { value: number; stun: boolean } {
  const g = f.ground[i];
  const c = f.clouds[i];
  const statuses: StatusApply[] = [];
  let dmg = 0;
  if ((g?.id === 'fire' || g?.id === 'lava') && !immuneToStatus(m, 'burning')) {
    dmg += avgDice(HAZARD_DICE[g.id]!) * Math.max(0, damageFactor(m, 'fire'));
    statuses.push({ id: 'burning', turns: FIELD_STATUS_TURNS });
  }
  if (g?.id === 'poison' && !immuneToStatus(m, 'poisoned')) {
    dmg += avgDice(HAZARD_DICE.poison!) * Math.max(0, damageFactor(m, 'poison'));
    statuses.push({ id: 'poisoned', turns: FIELD_STATUS_TURNS });
  }
  if (c?.id === 'gas' && !immuneToStatus(m, 'poisoned')) statuses.push({ id: 'poisoned', turns: FIELD_STATUS_TURNS });
  const k = damageFactor(m, 'lightning');
  const stun = !!((g?.id === 'water' && g.shock) || (c?.id === 'steam' && c.shock)) && k > 0 && !hasStatus(m, 'stunned');
  if (stun) dmg += avgDice(HAZARD_DICE.shock!) * k;
  let value = Math.min(dmg, m.hp) + foeStatusValue(sim, m, statuses);
  if (stun) value += foeStatusValue(sim, m, [{ id: 'stunned', turns: 1 }]);
  if (g?.id === 'ice' && isMelee(m)) value += 0.1 * threat(m); // it may slip on its way to someone
  return { value, stun };
}

interface FieldPlay {
  value: number; // explosions and new hazards under monsters, minus the same under friends, plus fires put out under friends
  stunned: Set<string>; // monsters it stuns (electrified water)
}

const NO_STUNS = new Set<string>();

/**
 * What a change to the battlefield is worth, for everyone standing in it (`base`: the battlefield before; `gone`: a
 * monster that won't be there, the one that just died). Friends (you included) count against it like your own HP.
 */
function fieldValue(sim: Sim, p: Preview, base: FieldLike, gone?: string): FieldPlay {
  let value = 0;
  const stunned = new Set<string>();
  for (const e of sim.ctx.entities) {
    if (e.id === gone || (e.kind === 'player' && !standing(e))) continue;
    const i = tileOf(base, e);
    const blasted = p.blasts.has(i);
    const changed = p.changed.has(i);
    if (!blasted && !changed) continue;
    const before = changed ? hazardAt(base, i, e) : 0;
    const after = changed ? hazardAt(p.field, i, e) : 0;
    // Water or steam makes whoever's in it Wet, which puts out Burning.
    const burning = e.statuses.find((x) => x.id === 'burning');
    const doused = changed && burning && (p.field.ground[i]?.id === 'water' || p.field.clouds[i]?.id === 'steam') ? 2.5 * (burning.power ?? 1) * Math.min(burning.turns, 2) : 0;
    if (e.kind === 'monster' && !isFoe(e)) {
      // An NPC ally: a blast or a hazard under it costs about what it would cost a hero.
      if (blasted || after > before) value -= 0.6 * ((blasted ? EXPLOSION_AVG * Math.max(0, damageFactor(e, 'fire')) : 0) + Math.max(0, after - before));
    } else if (e.kind === 'monster') {
      const blast = blasted ? blastValue(sim, e) : { value: 0, kill: 0 };
      value += blast.value;
      if (after > 0) {
        const h = monsterHarm(sim, e, p.field, i);
        value += (1 - blast.kill) * h.value; // what's left of it, if the blast didn't finish it
        if (h.stun) stunned.add(e.id);
      }
      if (before > after) value -= 0.5 * monsterHarm(sim, e, base, i).value; // it would have started its turn in that
      value -= Math.min(doused, e.hp);
    } else {
      // The blast and whatever appears under them land together: priced as one drop in HP. New oil or water under
      // them counts too when the monsters can set it off.
      const k = blasted ? Math.max(0, damageFactor(e, 'fire')) : 0;
      const down = k ? atLeast(EXPLOSION_AVG * k, EXPLOSION_VAR * k * k, e.hp + soakOf(e)) : 0;
      const risk = changed ? Math.max(0, riskAt(sim.fx, p.field, i) - riskAt(sim.fx, base, i)) : 0;
      value -= harmCost(e, EXPLOSION_AVG * k + after + risk, down);
      if (before > after) value += 0.7 * (harmCost(e, before) - harmCost(e, after));
      value += doused;
    }
  }
  return { value, stunned };
}

/**
 * Oil left under monsters waits for a spark, water for a shock (or a frost bolt on someone Wet): worth part of what that
 * would set off, if the party has the element. Friends standing in it count against it.
 */
function setupPotential(sim: Sim, p: Preview, base: FieldLike): number {
  let v = 0;
  for (const [ground, el] of [['oil', 'fire'], ['water', 'lightning']] as const) {
    if (!sim.odds[el]) continue;
    const m = sim.monsters.find((x) => {
      const i = tileOf(base, x);
      return p.changed.has(i) && p.field.ground[i]?.id === ground && base.ground[i]?.id !== ground;
    });
    if (!m) continue;
    const spark = (p.sparks[el] ??= makePreview(p.field, [{ kind: 'touch', tiles: [tileOf(base, m)], element: el }]));
    v += sim.odds[el] * Math.max(0, fieldValue(sim, spark, p.field).value);
  }
  if (sim.odds.cold) {
    let top = 0;
    for (const m of sim.monsters) {
      const i = tileOf(base, m);
      if (p.changed.has(i) && p.field.ground[i]?.id === 'water' && !isWet(base, m)) top = Math.max(top, foeStatusValue(sim, m, [{ id: 'frozen', turns: 1 }]));
    }
    v += 0.5 * sim.odds.cold * top;
  }
  return v;
}

/**
 * A quick setup (Quick Grease) followed by this turn's attack on the changed battlefield (a Fire Bolt into the oil),
 * against the best attack without it (walking included, so it's never oversold).
 */
function comboGain(sim: Sim, s: SkillStats, p: Preview): number {
  const gain = (x: number) => (x > 0 ? x - 10 : 0); // actionAt adds 10 for "can act"
  const before = memo(sim, 'setup:none', () => gain(scan(variant(sim, sim.me), sim.turn.movesLeft, actionAt).score));
  const after = gain(actionAt(onField(paid(sim, s), p.field)));
  return Math.max(0, after - Math.max(0, before));
}

/**
 * What killing this monster with this skill changes on the battlefield: the skill's own effect, then what the monster
 * leaves behind (a bloated zombie's poison, a magma imp's fire), since game.ts holds death bursts until the killing
 * skill is done. Against the skill's effect with it alive, which the plan already counts.
 */
function deathValue(sim: Sim, id: SkillId, s: SkillStats, res: AimResult, m: MonsterEntity, own: Preview | null): number {
  const death = MONSTERS[m.type]?.death;
  if (!death) return 0;
  // The last one standing: the fight ends with it, so its burst can't hurt anyone (and must not stop the kill).
  if (sim.monsters.every((o) => o.id === m.id)) return 0;
  const fx = sim.fx;
  const key = `death|${m.id}|${aimKey(sim, id, s, res)}`;
  let p = fx.previews.get(key) ?? null;
  if (!p) {
    const area = tilesAround(fx.field, m, death.radius);
    const ops: FieldOp[] = [];
    if (fieldElement(s.element) || s.surface || res.prop !== undefined) ops.push(...aimFieldOps(s, sim.me, res, fx.field));
    if (death.ground) ops.push({ kind: 'ground', tiles: area, id: death.ground });
    if (death.cloud) ops.push({ kind: 'cloud', tiles: area, id: death.cloud });
    p = makePreview(fx.field, ops);
    fx.previews.set(key, p);
  }
  return fieldValue(sim, p, fx.field, m.id).value - (own ? fieldValue(sim, own, fx.field).value : 0);
}

/** A friend's save against your spell (game.ts heroSave): their stat, Steady and Bless. */
const heroSaveMod = (h: PlayerEntity, save: Stat) =>
  statMod(h, save) + (passiveOf(h, 'steady')?.value ?? 0) + (hasStatus(h, 'blessed') ? 2 : 0);

/** Friendly fire on an NPC ally: priced a little under a hero's HP (it only stays a few fights anyway). */
function allyNpcHit(s: SkillStats, a: Entity): number {
  if (!s.dmg || s.roll === 'contest') return 0;
  return 0.6 * avgDice(s.dmg) * Math.max(0, factorOf(a, s.element));
}

/** A status landing on a friend caught in your area skill. */
function heroDebuffCost(h: PlayerEntity, st: StatusApply): number {
  const unshakable = hasBranch(h, 'steady', 'A');
  switch (st.id) {
    case 'stunned':
      return unshakable ? 0 : 8; // a lost turn
    case 'frozen':
      return 8;
    case 'dazed':
      return unshakable ? 0 : 1.5;
    case 'blinded':
    case 'marked':
      return 1.5;
    case 'burning':
    case 'poisoned':
      return immuneToStatus(h, st.id) ? 0 : 2.5 * (st.power ?? 1) * Math.min(st.turns, 2);
    default:
      return 0;
  }
}

/**
 * Friendly fire on one friend in the blast (you included): the same attack roll or save the monsters get. Expected
 * damage is priced like your own HP, and the chance of dropping them like a revive.
 */
function friendlyHit(sim: Sim, id: SkillId, s: SkillStats, h: PlayerEntity, scale = 1): number {
  const me = sim.me;
  if (s.roll === 'contest') return 0;
  const hits = s.roll ? hitsOf(me, s) : 1;
  let p = 1; // chance each hit lands (or the save fails)
  if (s.roll === 'attack') p = d20(attackBonus(me, s) + (hasStatus(me, 'blessed') ? 2 : 0) - (hasStatus(me, 'dazed') ? 2 : 0), acOf(h));
  else if (s.roll === 'save') p = clamp((heroDc(me) - 1 - heroSaveMod(h, s.save ?? 'dex')) / 20, 0, 1);
  let cost = 0;
  if (s.dmg) {
    const k = Math.max(0, factorOf(h, s.element)) * scale;
    const per = (avgDice(s.dmg) + damageMod(me, s) + passiveDamage(me, id, s, h)) * k;
    const rollVar = ((s.dmg.n * (s.dmg.d ** 2 - 1)) / 12) * k * k;
    const evasion = s.roll === 'save' && hasBranch(h, 'opportunist', 'B'); // half on a failed save, nothing on a good one
    const onFail = evasion ? per / 2 : per;
    const onSave = s.roll === 'save' && s.half && !evasion ? per / 2 : 0;
    let mean = 0;
    let down = 0;
    successOdds(new Array<number>(hits).fill(p)).forEach((pk, j) => {
      const total = j * onFail + (hits - j) * onSave;
      const variance = (j * (evasion ? 0.25 : 1) + (onSave ? (hits - j) / 4 : 0)) * rollVar;
      mean += pk * total;
      down += pk * atLeast(total, variance, h.hp + soakOf(h));
    });
    cost += heroLoss(h, mean, down);
  }
  const land = 1 - (1 - p) ** hits;
  for (const st of s.onHit ?? []) cost += land * heroDebuffCost(h, st);
  return cost;
}

function costOf(sim: Sim, id: SkillId, s: SkillStats): number {
  const kind = SKILLS[id].kind;
  if (kind === 'spell') return slotCost(s) * sim.price;
  if (kind === 'cantrip') return (s.cooldown ?? 0) * 0.3; // they come back, so use them freely
  if (kind === 'item') return id === 'potion' || !isItemId(id) ? POTION_PRICE : Math.max(3, itemPrice(id) / 6); // bombs and flasks are cheaper than potions
  return 0;
}

/** The utility of using a skill with this aim, or null if it would do nothing. */
function scorePlan(sim: Sim, id: SkillId, s: SkillStats, res: AimResult, setup: boolean): { score: number; early: boolean } | null {
  const offensive = isOffensive(s);
  // Nothing to hit: only a barrel, or a setup (Create Water on a burning friend), can still be worth it.
  if (offensive && !res.foes.length && res.prop === undefined && !isSetup(s)) return null;
  const me = sim.me;
  let score = 0;
  let early = false;
  // What it sets off on the battlefield: explosions, fire over the oil, lightning through the water...
  const prev = fieldPreview(sim, id, s, res);
  const play = prev ? fieldValue(sim, prev, sim.fx.field) : null;
  // Knockback is away from you, or from the area's center for anyone not standing on it (like game.ts).
  const from = (m: MonsterEntity) => (s.target === 'area' && (m.x !== res.center.x || m.y !== res.center.y) ? res.center : me);
  res.foes.forEach((m, i) => (score += foeValue(sim, id, s, res, m, i === 0, from(m), prev, play?.stunned ?? NO_STUNS)));
  if (play && prev) {
    score += play.value;
    // Oil or water left under monsters for a later spark; or, with Quick Grease, lit by this turn's own action.
    let later = setupPotential(sim, prev, sim.fx.field);
    if (setup && isSetup(s) && s.ap < ATTACK_AP && attackAfter(sim, s) && res.foes.length >= 2) {
      const combo = comboGain(sim, s, prev);
      if (combo > later) {
        later = combo;
        early ||= combo > MIN_QUICK;
      }
    }
    score += later;
  }
  // Friends in the blast take it too.
  for (const h of res.caught ?? []) score -= h.kind === 'player' ? friendlyHit(sim, id, s, h, atEdge(s, res.center, h) ? 0.5 : 1) : allyNpcHit(s, h);
  // A Shove or Feint gives a hidden hero away for nothing (an attack roll spends it on advantage, already scored), and
  // so does smashing a barrel (no roll at all).
  if (offensive && (res.prop !== undefined || (s.roll !== 'attack' && s.ap < ATTACK_AP))) score -= hiddenWorth(sim);
  for (const f of res.friends) score += friendValue(sim, s, f);
  for (const st of s.selfStatus ?? []) score += heroStatusValue(sim, me, st);
  if (s.selfBlock) score += blockWorth(sim, me, avgDice(s.selfBlock) + (s.blockLevel ? me.level : 0));
  if (s.taunt) score += tauntValue(sim, s.taunt.radius, s.taunt.turns);
  if (s.hpCost) score -= heroLoss(me, hpCostOf(me, s), 0); // Blood Price: your own HP
  if (s.trap) score += trapValue(sim, s, res.center);
  score += engineValue(sim, s, res);
  if (s.healSelf && s.heal) {
    const healed = res.friends.filter((f) => f.id !== me.id).reduce((n, f) => n + Math.min(avgDice(s.heal!) + healBonus(me, s), f.maxHp - f.hp), 0);
    score += Math.min(healed * s.healSelf, me.maxHp - me.hp) * healWeight(me);
  }
  if (s.gainAp) {
    const r = refreshValue(sim, s);
    score += r;
    early ||= r > 0; // before walking off: the next action may want this spot
  }
  if (s.resetCooldowns) score += 2 * me.skills.filter((o) => o.cd > 0 && SKILLS[o.id].kind === 'cantrip').length;
  // Ether: a slot back is worth a slot, when there's a spell to spend it on.
  if (s.restoreSlots && countKind(me, 'spell')) score += Math.min(s.restoreSlots, me.maxSlots - me.slots) * sim.price * (me.slots === 0 ? 1.5 : 1);
  if (s.dash) {
    const d = s.ap >= ATTACK_AP ? 0.5 : dashValue(sim, s);
    score += d;
    early ||= d >= 6;
  }
  if (setup && s.ap < ATTACK_AP && attackAfter(sim, s)) {
    const gain = setupGain(sim, s, res);
    score += gain;
    early ||= gain > MIN_QUICK;
  }
  if (s.heal && res.friends.some((f) => f.downed || hpPct(f) < 0.35)) early = true; // patch people up first
  if (s.frees) early = true; // cut free before walking or attacking
  if (s.helpUp) early = true; // get them up first
  // Rage before the swing, so the swing gets it.
  if (attackAfter(sim, s) && s.selfStatus?.some((x) => x.id === 'raging') && score > MIN_QUICK) early = true;
  return { score: score - costOf(sim, id, s), early };
}

/** Candidate aims for a skill (cheaply pre-filtered by range; resolveAim has the final word). */
function aimsFor(sim: Sim, s: SkillStats): (string | Pos | undefined)[] {
  const near = (p: Pos) => dist(sim.me, p) <= s.range;
  switch (s.target) {
    case 'enemy': {
      const aims: (string | Pos)[] = sim.monsters.filter(near).map((m) => m.id);
      if (canHitProps(s)) for (const p of sim.fx.propAims) if (near(p)) aims.push(p); // smash a barrel next to them
      return aims;
    }
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
      if (r && (!top || r.score > top.score)) top = { skill: id, target, ap: apOf(sim.me, id, s), repeat: SKILLS[id].kind === 'basic', ...r };
    }
    if (top) out.push(top);
  }
  return out;
}

/** The highest-scoring plan, or null. */
function top(plans: Plan[]): Plan | null {
  let best: Plan | null = null;
  for (const p of plans) if (!best || p.score > best.score) best = p;
  return best;
}

/** A plan's worth over doing nothing: quick and free skills have to clear a small bar. */
const net = (p: Plan) => p.score - (p.ap < ATTACK_AP ? MIN_QUICK : 0);

/** What AP left over is worth: it carries into the next turn, but only as far as the cap lets it. */
const savedWorth = (ap: number) => SAVE_AP * Math.min(Math.max(0, ap), AP_MAX - AP_GAIN);

interface Spend {
  picks: Plan[];
  score: number; // their worth (net), plus the AP saved
  main: boolean; // holds an attack-sized move (2+ AP)
}

/**
 * The best way to spend `ap` on these plans (each once; a basic attack again if there's AP for it), with what's left
 * saved for the next turn. Plans were scored one at a time, so two hits on one monster are an overestimate; the turn is
 * planned again after every step anyway.
 */
function spend(plans: Plan[], ap: number): Spend {
  const items: Plan[] = [];
  for (const p of plans) {
    if (net(p) <= 0 || p.ap > ap) continue;
    items.push(p);
    if (p.repeat && p.ap > 0) for (let k = 2 * p.ap; k <= ap; k += p.ap) items.push({ ...p, score: p.score * REPEAT });
  }
  // Knapsack over AP: at most a dozen plans and a handful of AP.
  let table = Array.from({ length: ap + 1 }, () => ({ score: 0, picks: [] as Plan[] }));
  for (const it of items) {
    const next = table.slice();
    for (let c = it.ap; c <= ap; c++) {
      const from = table[c - it.ap];
      const v = from.score + net(it);
      if (v > next[c].score) next[c] = { score: v, picks: [...from.picks, it] };
    }
    table = next;
  }
  let out: Spend = { picks: [], score: savedWorth(ap), main: false };
  for (const row of table) {
    const used = row.picks.reduce((n, p) => n + p.ap, 0);
    const score = row.score + savedWorth(ap - used);
    if (score > out.score) out = { picks: row.picks, score, main: row.picks.some((p) => p.ap >= ATTACK_AP) };
  }
  return out;
}

// ---------------------------------------------------------------- where to stand

/**
 * The best tile within `moves` steps by `scoreAt` (minus a small cost per step, and the hazards walked into on the
 * way), and the score of staying put.
 */
function scan(sim: Sim, moves: number, scoreAt: (p: Sim) => number): { pos: Pos; score: number; stay: number } {
  const stay = scoreAt(variant(sim, sim.me));
  let top = { pos: { x: sim.me.x, y: sim.me.y } as Pos, score: stay };
  if (moves > 0) {
    const map = sim.fx.field;
    const blocked = (x: number, y: number) => sim.v.occupied(x, y, sim.me.id);
    const harm = walkHarm(sim, moves, blocked);
    for (const [idx, steps] of reachable(map, sim.me, moves, blocked)) {
      if (!steps) continue;
      const pos = tilePos(map, idx);
      const score = scoreAt(standAt(sim, pos)) - steps * STEP_COST - harmCost(sim.me, harm?.harm.get(idx) ?? 0);
      if (score > top.score) top = { pos, score };
    }
  }
  return { ...top, stay };
}

function bestMove(sim: Sim, scoreAt: (p: Sim) => number): Pos | null {
  const r = scan(sim, sim.turn.movesLeft, scoreAt);
  return r.score > r.stay + MOVE_MARGIN ? routeTo(sim, r.pos) : null;
}

const dangerAt = (p: Sim) => (p.ranged.has(p.me.id) ? danger(p) * (hpPct(p.me) < 0.5 ? 6 : 4) : 0);
const nearestFoe = (p: Sim) => Math.min(99, ...p.monsters.map((m) => dist(p.me, m)));

/**
 * Walking distance from this spot to the nearest goal, around walls and crates (creatures don't count, they move).
 * Straight-line distance kept melee heroes pinned behind a wall 3 tiles from a boss forever: every step around it
 * looked like a step away. Worked out once per decision for each set of goals; tiles it can't reach count as far.
 */
function walkDist(p: Sim, key: string, goals: Pos[]): number {
  let field = p.fx.paths.get(key);
  if (!field) {
    field = new Map();
    for (const g of goals) for (const [i, n] of reachable(p.fx.field, g, 99, () => false)) if (n < (field.get(i) ?? Infinity)) field.set(i, n);
    p.fx.paths.set(key, field);
  }
  return Math.min(99, field.get(p.me.y * p.fx.field.width + p.me.x) ?? 20 + Math.min(...goals.map((g) => dist(p.me, g))));
}

/** Where to head when nothing is in reach: a downed friend if you can get them up, else the nearest enemy. */
function approachDist(p: Sim): number {
  const downed = p.heroes.filter((h) => h.downed && !h.dead);
  return p.healer && downed.length ? walkDist(p, `downed:${downed.map((h) => h.id).join(',')}`, downed) : walkDist(p, 'foes', p.monsters);
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

/** A spot to act from: the best way to spend the AP there (flanks and back attacks included), minus danger. */
function engageAt(p: Sim): number {
  const c = spend(plansFrom(p, false), p.turn.ap);
  const score = (c.main ? 10 : -0.5 * approachDist(p)) + c.score;
  return score + FLANK_GIFT * flanksGiven(p) - dangerAt(p) - standCost(p);
}

/**
 * A spot to finish the turn on: the best quick skills there for the AP left (Shove, Hide...), then safety (ranged) or
 * staying in the fight (melee), and out of fire, poison and electrified water.
 */
function afterAt(p: Sim): number {
  let score = spend(plansFrom(p, false), p.turn.ap).score;
  if (p.ranged.has(p.me.id)) score += Math.min(nearestFoe(p), 3) * 0.2;
  else score -= Math.max(0, walkDist(p, 'foes', p.monsters) - 1) * 0.3;
  return score + FLANK_GIFT * flanksGiven(p) - dangerAt(p) - standCost(p);
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

  // 1. Revives, emergency heals and setups (Feint, Hide, a dash to reach a target) come first.
  const early = top(plans.filter((p) => p.early && p.ap < ATTACK_AP && net(p) > 0));
  if (early) return act(early);

  // 2. While there's AP for an attack: get to the best spot to act from (in reach, flanking or behind, out of melee for
  // ranged heroes, near a downed friend), then make the biggest move of the best way to spend the AP there.
  if (sim.actionLater) {
    const to = bestMove(sim, engageAt);
    if (to) return { kind: 'move', to };
    const main = top(spend(plans, v.turn.ap).picks.filter((p) => p.ap >= ATTACK_AP));
    if (main) return act(main);
  }

  // 3. Quick and free skills with the AP left (Shield Bash, Second Wind, Shove, Hide, Action Surge...), from a better
  // spot if there is one, or save the AP. With no attack coming, hiding now lasts into the monsters' turns.
  const late = sim.actionLater ? { ...sim, actionLater: false, memo: new Map<string, number>() } : sim;
  const latePlans = late === sim ? plans : plansFrom(late, false);
  const to = bestMove(late, afterAt);
  if (to) return { kind: 'move', to };
  const next = top(spend(latePlans, v.turn.ap).picks);
  return next ? act(next) : END;
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
export function autoPathChoice(options: { id: string; type: NodeType }[], heroes: PlayerEntity[], gold = 0): string {
  const alive = heroes.filter((p) => !p.dead);
  const health = alive.length ? alive.reduce((s, p) => s + hpPct(p), 0) / alive.length : 0;
  const level = alive.length ? alive.reduce((s, p) => s + p.level, 0) / alive.length : 1;
  const value: Record<NodeType, number> = {
    rest: health < 0.5 ? 3 : 0.5,
    elite: health > 0.75 && level >= 2 ? 2.5 : 0.2, // elites hit hard: not at level 1
    treasure: 2,
    event: 1.5,
    combat: 1.2,
    shop: gold >= 120 ? 2.2 : gold >= 60 ? 1.3 : 0.4, // worth it with gold to spend (the party's purse)
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
const skillWorth = (o: OwnedSkill) => o.tier + (statsOf(o).heal ? 0.5 : 0) + (engineOf(o.id) ? 0.5 : 0);
/** Bots build engines: a card of an engine they already picked cards of is worth more (up to 4 cards). */
const leanIn = (p: PlayerEntity, id: SkillId) => {
  const e = engineOf(id);
  return e ? 0.8 * Math.min(4, enginePicks(p, e)) : 0;
};
const ownedOfKind = (p: PlayerEntity, kind: SkillKind) => p.skills.filter((s) => SKILLS[s.id].kind === kind && !isSignature(p, s.id)); // the signature can't be forgotten

/**
 * Which stat an auto hero raises: its casting stat (spells, DCs, heals), then its weapon's stat, then CON (HP), then DEX
 * in light armor (AC), then WIS (saves), and anything else last.
 */
function statWant(p: PlayerEntity, stat: Stat): number {
  if (statRoom(p, stat) <= 0) return -Infinity;
  const c = CLASSES[p.classId];
  const weapon = p.skills.map((o) => SKILLS[o.id]).find((d) => d.kind === 'basic')?.base.stat;
  if (stat === c.stat) return 9;
  if (stat === weapon) return 8;
  if (stat === 'con') return 7;
  if (stat === 'dex' && c.armor === 'light') return 6;
  return stat === 'wis' ? 4 : 2;
}

/** How much an auto hero wants a level-up card. */
function cardValue(p: PlayerEntity, c: OfferCard): number {
  switch (c.kind) {
    case 'upgrade':
      return nextTier(p, c.skill) === c.tier ? (c.tier === 3 ? 9 : 7) + 0.4 * leanIn(p, c.skill) : -Infinity;
    case 'learn': {
      if (p.skills.some((s) => s.id === c.skill)) return -Infinity;
      const kind = SKILLS[c.skill].kind;
      if (kind === 'basic') return 6 + leanIn(p, c.skill); // Quick Stab: no slot needed
      // An empty passive slot is free power (and bot runs need passives exercised), so fill it early.
      if (countKind(p, kind) < limitFor(p, kind)) return (kind === 'passive' ? (countKind(p, 'passive') === 0 ? 7.5 : 6.5) : 8) + leanIn(p, c.skill);
      return 3 + leanIn(p, c.skill) - Math.min(...ownedOfKind(p, kind).map(skillWorth)); // a swap: only worth it for a weak skill
    }
    case 'boon':
      if (c.boon === 'ac') return p.bonusAc < MAX_BONUS_AC ? 4 : -Infinity;
      if (c.boon === 'slot') return countKind(p, 'spell') ? 4 : 1;
      return 3;
    case 'subclass':
      return 10; // the only cards in that offer: either, at random (so bot runs play both)
    case 'stat':
      return statWant(p, c.stat);
    case 'gear':
    case 'item': {
      // Elite and victory spoils: gear when it beats what's worn (or there's room to carry it for a friend), a
      // consumable when the bag has room for it.
      if (bagRoom(p) <= 0) return -Infinity;
      const g = gearDef(c.item);
      if (!g) return 3.5;
      return 3.5 + Math.max(0, gearScore(p, c.item) - gearScore(p, p.gear[g.slot])) / 2;
    }
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

// ---------------------------------------------------------------- items (auto heroes manage their own kit)

const CASTERS = new Set(['wizard', 'cleric']);

/** Roughly what a piece of equipment is worth to this hero, in the same units as the AI's other scores. */
export function gearScore(p: PlayerEntity, id: ItemId | undefined): number {
  const g = id && isItemId(id) ? gearDef(id) : null;
  if (!g) return 0;
  const st = g.stats;
  const caster = CASTERS.has(p.classId);
  let v = (st.ac ?? 0) * 3 + (st.block ?? 0) * 2 + (st.hp ?? 0) * 0.4 + (st.speed ?? 0) + (st.init ?? 0) * 0.3 + (st.saves ?? 0) * 1.5 + (st.slots ?? 0) * 2.5 + (st.stealth ?? 0) * 0.3;
  v += (st.hit ?? 0) * (caster ? 1 : 2.5) + (st.dmg ?? 0) * (caster ? 0.5 : 1.5) + (st.power ?? 0) * (caster ? 3 : 0.3);
  v += (st.heal ?? 0) * (p.classId === 'cleric' ? 2 : 0.3);
  if (st.weapon) v += caster ? 1.5 : 4;
  if (st.onHit?.length) v += caster ? 0.5 : 2;
  if (st.resist) v += Object.keys(st.resist).length * 1.2;
  if (st.alert) v += 1;
  if (st.shove) v += 0.5;
  if (st.lucky) v += 1;
  return v;
}

/** Put on whatever in the bag beats what's worn. */
export function autoEquip(p: PlayerEntity): ItemRequest | null {
  let best: { item: ItemId; gain: number } | null = null;
  for (const item of p.bag) {
    const g = gearDef(item);
    if (!g) continue;
    const gain = gearScore(p, item) - gearScore(p, p.gear[g.slot]);
    if (gain > 0.1 && (!best || gain > best.gain)) best = { item, gain };
  }
  return best ? { kind: 'equip', item: best.item } : null;
}

/** Hand a piece of gear in the bag to a teammate it suits better (and who has room). */
export function autoGive(p: PlayerEntity, heroes: PlayerEntity[]): ItemRequest | null {
  for (const item of p.bag) {
    const g = gearDef(item);
    if (!g) continue;
    const mine = gearScore(p, item) - gearScore(p, p.gear[g.slot]);
    const taker = heroes
      .filter((h) => h !== p && !h.dead && bagRoom(h) > 0)
      .map((h) => ({ h, gain: gearScore(h, item) - gearScore(h, h.gear[g.slot]) }))
      .sort((a, b) => b.gain - a.gain)[0];
    if (taker && taker.gain > Math.max(0.5, mine)) return { kind: 'give', item, to: taker.h.id };
  }
  return null;
}

/**
 * One purchase at a shop for an auto hero (null = done). Gold is the party's, so the game asks each auto hero in turn
 * and nobody empties the purse alone: an upgrade for the hero's own gear, a relic for everyone, a potion when short,
 * a lesson when one is due, a couple of bombs.
 */
export function autoShopPick(p: PlayerEntity, shop: Pick<ShopView, 'offers' | 'trainPrice'>, gold: number, partySize: number, relics: RelicId[]): ShopRequest | null {
  const budget = Math.max(gold / Math.max(1, partySize), gold * 0.4);
  let best: { req: ShopRequest; value: number } | null = null;
  const consider = (req: ShopRequest, value: number, price: number) => {
    if (price > gold || value <= 0) return;
    const v = value - price / 40; // cheaper is better
    if (v > 0.5 && (!best || v > best.value)) best = { req, value: v };
  };
  shop.offers.forEach((o, i) => {
    if (o.left <= 0) return;
    if (o.kind === 'potion') consider({ kind: 'buy', offer: i }, p.potions < 2 ? 3.5 : 0.5, o.price);
    else if (o.kind === 'relic') consider({ kind: 'buy', offer: i }, relics.includes(o.id as RelicId) || !(o.id in RELICS) ? 0 : 6, o.price);
    else if (isItemId(o.id) && bagRoom(p) > 0 && o.price <= budget) {
      const g = gearDef(o.id);
      if (g) consider({ kind: 'buy', offer: i }, (gearScore(p, o.id) - gearScore(p, p.gear[g.slot])) * 1.3, o.price);
      else consider({ kind: 'buy', offer: i }, p.bag.filter((x) => !gearDef(x)).length < 3 ? 2.5 : 0, o.price);
    }
  });
  const train = trainOptions(p)[0];
  if (train && shop.trainPrice <= budget) {
    consider(train.tier === 3 ? { kind: 'train', skill: train.skill, branch: randomBranch() } : { kind: 'train', skill: train.skill }, 6.5, shop.trainPrice);
  }
  return (best as { req: ShopRequest; value: number } | null)?.req ?? null;
}
