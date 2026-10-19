// The monster AI (Phase 9). A squad director picks one target for each side; then every monster scores the tiles it
// can reach this turn (who it can hit from there, flanks and back attacks, danger, hazards, what its role wants) and
// plays the best. Scripted "utility AI", readable and beatable on purpose: on Normal a monster now and then slips and
// just goes for whoever is closest, and on Story they all fight that way. NPC allies run on the same code, for the
// party's side.
//
// Phase 12: tricks. Monsters set each other up: a Kobold nets a hero for the archers, a Spider webs one for the pack, a
// Goblin gets in a hero's face (Help) so the Ogre's swing lands, a leader shouts orders. A set-up is worth what the
// friends who act before the target's next turn gain from it (trickValue).
//
// Pure: game.ts (runMonster) hands it a snapshot and carries out the plan; the tests call it directly.

import { ALLIES, ENRAGED_DMG, auraOf, hasTrait, isAllyNpc, isFoe, sameSide } from '../shared/elites.ts';
import { DIRS, canStep, dist, hasLOS } from '../shared/grid.ts';
import { gearBonus } from '../shared/items.ts';
import {
  CHARGE_MOVES, COWARD_HP, COWARD_TURNS, DIFFICULTIES, FULL_COVER, HELP, MONSTERS, ORDER_RANGE, canHelp, packsFor, roleOf, statMod,
  type Difficulty, type OrderId, type Role,
} from '../shared/rules.ts';
import { ROOTED, SKILLS, SKIP_TURN, SLOWED, avgDice, blockOf, hasStatus, passiveOf, statsOf, type Element, type StatusApply } from '../shared/skills.ts';
import { EXPLOSION, damageFactor, fieldElement, hazardAt, previewField, type FieldLike } from '../shared/surfaces.ts';
import { attackAdvantage, coverFrom, dirTo, netAdvantage, turnsToFace } from '../shared/tactics.ts';
import type { Entity, MonsterEntity, Pos } from '../shared/types.ts';

export interface MonsterView {
  me: MonsterEntity;
  map: FieldLike;
  entities: Entity[];
  moves: number; // moves left this turn
  difficulty: Difficulty;
  focus: string | null; // its pack's target (squadPlan), or its side's (squadFocus)
  rand?: () => number; // for slips; the tests pass their own
  smart?: boolean; // force the squad's full tactics on or off (the learned policy always sees every option)
  round?: number; // the fight's round (a feature for the learned policy)
  order?: string[]; // who acts when: entity ids from this monster on (a set-up only pays off before the target's turn)
  assign?: Record<string, string>; // each monster's pack target (squadPlan): who its friends are going for
}

/** What a monster does this turn: walk `path`, then act. */
export interface MonsterPlan {
  kind: 'attack' | 'shove' | 'ignite' | 'heal' | 'buff' | 'flee' | 'move' | 'trick' | 'help';
  path: Pos[];
  target?: string; // who it attacks, shoves, heals, buffs, tricks or helps against
  tile?: Pos; // ignite: the ground it hits (oil under the party...)
  instinct?: boolean; // it slipped: went for the closest enemy without a plan
  cornered?: boolean; // a coward with nowhere left to run
}

const FOCUS_WEIGHT = 1.5; // hitting the squad's target is worth this much more
const STICKY = 0.7; // the squad keeps its target while it's still worth this share of the best one
const KILL_BONUS = 4; // taking an enemy out of the fight this turn
const APPROACH = 0.6; // per turn of walking still needed before it can hit its target
const PULL = 2; // turns of extra walking a target is worth per point of weight over 1 (its pack's target, a taunter)
const FRIEND_BLOCK = 3; // a friend standing in the way counts as this many extra steps: go round instead of queueing
const STEP_COST = 0.02; // don't shuffle around for nothing
const HARM = 1; // per point of expected hazard damage on the way
const SENTINEL_RISK = 3; // walking away from a hero with Sentinel
const DANGER: Record<Role, number> = { brute: 0.1, skirmisher: 0.4, archer: 1.5, support: 1.5, coward: 0.8 }; // per enemy next to it
const FRONT = 0.6; // a brute likes standing next to an enemy
const FLANK = 0.8; // a skirmisher likes setting up flanks
const SHOVE_HARM = 2.5; // shoving someone into a hazard: what it costs them (the step in, burning, getting out), times this
const FRIENDLY_FIRE = 1.2; // harm to its own side counts this much
const IGNITE_MIN = 3; // hitting the ground instead of a creature has to be worth at least this
const HEAL_BELOW = 0.75; // supports mend friends under this share of their HP
const SUPPORT_BIAS = 1; // a support would rather cast its spells than fight
const TRICK_BIAS = 1.5; // a monster with a trick would rather play it (that's what it's known for), when it sets something up
const OTHER_PACK = 0.5; // a friend hunting someone else might still take a swing at a set-up target
const ORDER_MIN = 1; // an order has to be worth at least this to be shouted
const CLUSTER = 0.5; // per friend next to it when a hero can blast an area (Fireball): don't bunch up
const CLUSTER_NEAR = 0.15; // per friend two tiles away (one blast can still catch both)
const COVER: Record<Role, number> = { brute: 0.2, skirmisher: 0.4, archer: 1, support: 1, coward: 0.8 }; // full cover from one hero who shoots

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- numbers about creatures

/** Still in the fight: every monster or NPC ally on the board, and heroes who aren't down. */
export const upNow = (e: Entity) => e.kind === 'monster' || (!e.dead && !e.downed);

/** Chance a d20 roll with this bonus hits this AC, with advantage (1) or disadvantage (-1). */
export function hitChance(bonus: number, ac: number, net: -1 | 0 | 1 = 0): number {
  const p = clamp((21 + bonus - ac) / 20, 0.05, 0.95);
  return net > 0 ? 1 - (1 - p) ** 2 : net < 0 ? p * p : p;
}

const acOf = (e: Entity) => e.ac + e.statuses.reduce((s, x) => s + (x.id === 'shielded' ? (x.power ?? 2) : 0), 0) - (hasStatus(e, 'shocked') ? 2 : 0);
/** HP that has to go before it drops: Block, temp HP and an elite's ward count. */
const ehp = (e: Entity) => Math.max(1, e.hp + blockOf(e) + (e.kind === 'player' ? e.tempHp : (e.ward ?? 0)));
const enraged = (m: MonsterEntity) => hasTrait(m, 'enraged') && m.hp < m.maxHp / 2;
const rallyOf = (e: Entity) => e.statuses.find((x) => x.id === 'rallied')?.power ?? 0;
const atkOf = (m: MonsterEntity) => MONSTERS[m.type].atk + (m.atkBonus ?? 0) + (hasStatus(m, 'blessed') ? 2 : 0) - (hasStatus(m, 'dazed') ? 2 : 0) + rallyOf(m);
const dmgOf = (m: MonsterEntity) => avgDice(MONSTERS[m.type].dmg) + (m.dmgBonus ?? 0) + (enraged(m) ? ENRAGED_DMG : 0) + rallyOf(m);
const attacksOf = (m: MonsterEntity) => MONSTERS[m.type].attacks + (enraged(m) ? 1 : 0);
export const elementOf = (m: MonsterEntity): Element => auraOf(m) ?? MONSTERS[m.type].element ?? 'physical';
const rangeOf = (m: MonsterEntity) => MONSTERS[m.type].range;
const shoots = (e: Entity) => e.kind === 'monster' && rangeOf(e) > 1;
const hunts = (m: MonsterEntity) => !!m.ally && Object.values(ALLIES).some((a) => a.monster === m.type && a.hunts);
const skips = (e: Entity) => SKIP_TURN.some((id) => hasStatus(e, id));
const rooted = (e: Entity) => ROOTED.some((id) => hasStatus(e, id));
/** Moves on its next turn: half if slowed, more if charging, none if stuck in a net or a web. */
const movesOf = (m: MonsterEntity) =>
  rooted(m) ? 0 : (SLOWED.some((id) => hasStatus(m, id)) ? Math.floor(m.speed / 2) : m.speed) + (hasStatus(m, 'charging') ? CHARGE_MOVES : 0);
/** Could it get to `t` and hit it on its next turn (walls aside)? */
const reaches = (m: MonsterEntity, t: Pos) => dist(m, t) <= movesOf(m) + rangeOf(m);
/** Roughly what an enemy deals in a round: a hero by level, an NPC ally by its stat block. */
/** A hero who fights from range (a bow, a ranged spell): monsters like cover from them. */
const shootsFar = (e: Entity) =>
  e.kind === 'player' &&
  e.skills.some((o) => {
    if (SKILLS[o.id].kind === 'passive') return false;
    const s = statsOf(o);
    return (s.target === 'enemy' || s.target === 'area') && s.range >= 4;
  });

/** A hero who can blast an area (Fireball, Shatter, a bomb's worth of spell): monsters spread out against them. */
const blasts = (e: Entity) =>
  e.kind === 'player' &&
  e.skills.some((o) => {
    if (SKILLS[o.id].kind === 'passive') return false;
    const s = statsOf(o);
    return s.target === 'area' && !!s.dmg && (s.radius ?? 0) >= 1;
  });

const threatOf = (e: Entity) => (e.kind === 'player' ? 3 + 1.2 * e.level : attacksOf(e) * dmgOf(e) * 0.6);

/** Chance a creature fails a save against this DC (d20 + its bonus, like game.ts creatureSave). */
export function saveFails(e: Entity, save: 'dex' | 'str' | 'wis', dc: number): number {
  const bonus =
    e.kind === 'player'
      ? statMod(e.classId, save) + (passiveOf(e, 'steady')?.value ?? 0) + (hasStatus(e, 'blessed') ? 2 : 0) + gearBonus(e, 'saves')
      : MONSTERS[e.type][save];
  return clamp((dc - bonus - 1) / 20, 0.05, 0.95);
}

/** Expected damage per round from a straight attack (no advantage). */
const roundDamage = (m: MonsterEntity, t: Entity) => attacksOf(m) * hitChance(atkOf(m), acOf(t)) * dmgOf(m) * damageFactor(t, elementOf(m));

/** Can `m` standing at `from` hit `t`? Melee next to it, ranged within range and in sight. */
export const canHitFrom = (map: FieldLike, m: MonsterEntity, from: Pos, t: Pos) =>
  dist(from, t) <= rangeOf(m) && (rangeOf(m) === 1 || hasLOS(map, from, t));

const contestOdds = new Map<number, number>();
/** Chance that d20 + `diff` beats (or ties) a plain d20. */
function contest(diff: number): number {
  let p = contestOdds.get(diff);
  if (p === undefined) {
    let wins = 0;
    for (let a = 1; a <= 20; a++) for (let b = 1; b <= 20; b++) if (a + diff >= b) wins++;
    p = wins / 400;
    contestOdds.set(diff, p);
  }
  return p;
}

/** What a creature adds to resist a shove: the better of STR and DEX. */
export const shoveResist = (e: Entity) =>
  e.kind === 'player' ? Math.max(statMod(e.classId, 'str'), statMod(e.classId, 'dex')) : Math.max(MONSTERS[e.type].str, MONSTERS[e.type].dex);

// ---------------------------------------------------------------- sides

const enemiesOf = (me: Entity, entities: Entity[]) => entities.filter((e) => upNow(e) && !sameSide(e, me));
const friendsOf = (me: Entity, entities: Entity[]) => entities.filter((e) => e.id !== me.id && upNow(e) && sameSide(e, me));

/** Hidden enemies are looked past while anyone else is in the open. */
function inSight(enemies: Entity[]): Entity[] {
  const open = enemies.filter((e) => !hasStatus(e, 'hidden'));
  return open.length ? open : enemies;
}

/** The old instinct: whoever taunted it, else the closest enemy in the open (the most hurt on a tie). */
export function closestEnemy(me: MonsterEntity, entities: Entity[]): Entity | undefined {
  const enemies = enemiesOf(me, entities);
  const taunt = me.statuses.find((s) => s.id === 'taunted')?.by;
  const taunter = enemies.find((e) => e.id === taunt);
  if (taunter) return taunter;
  const pool = inSight(enemies);
  const shooters = hunts(me) ? pool.filter(shoots) : [];
  return [...(shooters.length ? shooters : pool)].sort((a, b) => dist(a, me) - dist(b, me) || a.hp - b.hp)[0];
}

// ---------------------------------------------------------------- the squad director

const squadOf = (entities: Entity[], side: 'foes' | 'allies') =>
  entities.filter((e): e is MonsterEntity => (side === 'foes' ? isFoe(e) : isAllyNpc(e)));

/**
 * What each enemy in sight is worth as a target for this squad: the biggest bite it can take out of them this round
 * (damage it can bring, against the HP that has to go), hurt heroes a bit more. Best first.
 */
function targetValues(squad: MonsterEntity[], entities: Entity[]): [string, number][] {
  const out: [string, number][] = [];
  for (const t of inSight(enemiesOf(squad[0], entities))) {
    let pressure = 0;
    for (const s of squad) {
      const d = dist(s, t);
      const reach = d <= s.speed + rangeOf(s) ? 1 : d <= 2 * s.speed + rangeOf(s) ? 0.4 : 0.1;
      pressure += reach * Math.max(0, roundDamage(s, t));
    }
    out.push([t.id, Math.min(1.5, pressure / ehp(t)) + (t.hp < t.maxHp / 2 ? 0.2 : 0)]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

/**
 * Who a side gangs up on (one target: the NPC allies use it). It keeps its target while that's still a decent pick,
 * so the party can read it and play around it. `side`: the monsters, or the party's NPC allies.
 */
export function squadFocus(entities: Entity[], side: 'foes' | 'allies', current: string | null): string | null {
  const squad = squadOf(entities, side);
  if (!squad.length) return null;
  const values = targetValues(squad, entities);
  if (!values.length) return null;
  const kept = values.find(([id]) => id === current);
  return kept && kept[1] >= STICKY * values[0][1] ? kept[0] : values[0][0];
}

export interface SquadPlan {
  targets: string[]; // the heroes (or NPC allies) the packs hunt, one per pack
  assign: Record<string, string>; // squad member id -> its pack's target
}

/**
 * The monsters' squad director. Bigger parties face more and tougher monsters (partyScaling), so the monsters split
 * into packs (packsFor: about one per two heroes, 3 at most), each hunting its own target, instead of the whole fight
 * landing on one hero.
 * Targets are kept while they're still a decent pick (the client marks them 🎯), and the packs come out the same
 * size give or take one, each monster in the nearest pack that has room.
 */
export function squadPlan(entities: Entity[], current: string[] = []): SquadPlan {
  const squad = squadOf(entities, 'foes');
  if (!squad.length) return { targets: [], assign: {} };
  const values = targetValues(squad, entities);
  if (!values.length) return { targets: [], assign: {} };
  const party = enemiesOf(squad[0], entities).length;
  const k = Math.min(packsFor(party), values.length, squad.length);
  const worth = new Map(values);
  const targets = current.filter((id) => (worth.get(id) ?? -1) >= STICKY * values[0][1]).slice(0, k);
  for (const [id] of values) if (targets.length < k && !targets.includes(id)) targets.push(id);
  // Every pack first gets its fair share (nearest monsters first), then the leftovers join their nearest pack:
  // the packs end up within one monster of each other, and none is empty.
  const byId = new Map(entities.map((e) => [e.id, e]));
  const load = new Map(targets.map((t) => [t, 0]));
  const assign: Record<string, string> = {};
  const pairs = squad.flatMap((s) => targets.map((t) => ({ s, t, d: dist(s, byId.get(t)!) }))).sort((a, b) => a.d - b.d);
  for (const room of [Math.floor(squad.length / targets.length), Math.ceil(squad.length / targets.length)]) {
    for (const { s, t } of pairs) {
      if (assign[s.id] || load.get(t)! >= room) continue;
      assign[s.id] = t;
      load.set(t, load.get(t)! + 1);
    }
  }
  return { targets, assign };
}

// ---------------------------------------------------------------- walking

interface Walk {
  steps: number;
  harm: number; // expected hazard damage on the way
  path: Pos[];
}

/** Every tile it can reach this turn, each by the way through the least harm (then the fewest steps). */
export function walkMap(map: FieldLike, me: MonsterEntity, entities: Entity[], moves: number): Map<number, Walk> {
  const w = map.width;
  const blocked = (x: number, y: number) => entities.some((e) => e.id !== me.id && e.x === x && e.y === y && !(e.kind === 'player' && e.dead));
  const start = me.y * w + me.x;
  const out = new Map<number, Walk>([[start, { steps: 0, harm: 0, path: [] }]]);
  let layer = new Map<number, { harm: number; path: Pos[] }>([[start, { harm: 0, path: [] }]]);
  for (let step = 1; step <= moves && layer.size; step++) {
    const next = new Map<number, { harm: number; path: Pos[] }>();
    for (const [i, cur] of layer) {
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of DIRS) {
        if (!canStep(map, { x, y }, dx, dy) || blocked(x + dx, y + dy)) continue;
        const n = (y + dy) * w + x + dx;
        const harm = cur.harm + hazardAt(map, n, me);
        if ((next.get(n)?.harm ?? Infinity) <= harm) continue;
        next.set(n, { harm, path: [...cur.path, { x: x + dx, y: y + dy }] });
      }
    }
    for (const [n, v] of next) {
      const have = out.get(n);
      if (!have || v.harm < have.harm - 1e-9) out.set(n, { steps: step, harm: v.harm, path: v.path });
    }
    layer = next;
  }
  return out;
}

/** A tiny binary heap for the distance fields. */
class Heap {
  private a: [number, number][] = [];
  get size() {
    return this.a.length;
  }
  push(cost: number, i: number) {
    const a = this.a;
    a.push([cost, i]);
    for (let k = a.length - 1; k > 0; ) {
      const p = (k - 1) >> 1;
      if (a[p][0] <= a[k][0]) break;
      [a[p], a[k]] = [a[k], a[p]];
      k = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        k = m;
      }
    }
    return top;
  }
}

/**
 * Steps from each tile to somewhere `me` could hit `t` from. Enemies block; a friend in the way costs extra (it
 * would have to wait behind them), so the monsters fan out round another way instead of queueing in a corridor.
 */
function approachField(map: FieldLike, me: MonsterEntity, t: Entity, entities: Entity[], friendCost: number): Float64Array {
  const w = map.width;
  const cost = new Float64Array(w * map.height).fill(Infinity);
  const who = new Map<number, Entity>();
  for (const e of entities) if (e.id !== me.id && !(e.kind === 'player' && e.dead)) who.set(e.y * w + e.x, e);
  const heap = new Heap();
  for (let i = 0; i < w * map.height; i++) {
    const p = { x: i % w, y: Math.floor(i / w) };
    const there = who.get(i);
    if (map.tiles[i] !== '.' || (there && !sameSide(there, me))) continue;
    if (!canHitFrom(map, me, p, t)) continue;
    cost[i] = there ? friendCost : 0;
    heap.push(cost[i], i);
  }
  while (heap.size) {
    const [c, i] = heap.pop();
    if (c > cost[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of DIRS) {
      if (!canStep(map, { x, y }, dx, dy)) continue;
      const n = (y + dy) * w + x + dx;
      const there = who.get(i); // walking backwards: entering tile i from n
      if (there && !sameSide(there, me)) continue;
      const step = 1 + (there ? friendCost : 0) + Math.min(3, hazardAt(map, i, me) * 0.3);
      if (c + step < cost[n]) {
        cost[n] = c + step;
        heap.push(c + step, n);
      }
    }
  }
  return cost;
}

// ---------------------------------------------------------------- the plan

/** One thing a monster could do this turn (a tile and an action), with what the scripted AI thinks of it. */
interface Candidate {
  score: number;
  plan: MonsterPlan;
  raw: Raw;
}

/** The facts behind a candidate, which the learned policy sees (optionFeatures). */
interface Raw {
  steps: number;
  harm: number; // hazard damage on the way
  endHazard: number; // hazard where it ends up
  adjacent: number; // enemies next to that tile
  near2: number; // enemies two tiles from it
  adjFriends: number;
  sentinel: number; // Sentinel heroes it walks away from
  target?: Entity;
  focus?: boolean; // the target is its pack's
  taunter?: boolean;
  ev?: number; // expected damage
  p?: number; // hit chance
  net?: number; // advantage (1), disadvantage (-1)
  flank?: boolean;
  behind?: boolean;
  turns?: number; // walking still needed before it can hit its target
  ground?: number; // what its element sets off on the ground
  shove?: number; // win chance × harm of a shove
  heal?: number;
  buff?: number;
  setup?: number; // what a trick, a Help or its attacks' rider sets up for its friends
}

interface Candidates {
  forced: MonsterPlan | null; // decided by its role, not by choice: a coward running away
  list: Candidate[];
  fallback: MonsterPlan; // when there's nothing to choose
}

/**
 * The monster's turn: where to walk and what to do there. A coward below its nerve runs; a support mends or buffs a
 * friend when that beats its attack; otherwise every reachable tile is scored for the best attack from it (or for
 * getting closer), with its role's likes and dislikes, hazards on the way, and Sentinel heroes it would walk away from.
 */
export function planMonster(v: MonsterView): MonsterPlan {
  const { forced, list, fallback } = candidates(v);
  if (forced) return forced;
  let best: Candidate | null = null;
  for (const c of list) if (!best || c.score > best.score) best = c;
  return best?.plan ?? fallback;
}

/** Everything a monster could do this turn, scored by the scripted AI. */
function candidates(v: MonsterView): Candidates {
  const { me, map, entities } = v;
  const def = MONSTERS[me.type];
  const role = roleOf(def);
  const diff = DIFFICULTIES[v.difficulty];
  const rand = v.rand ?? Math.random;
  const smart = v.smart ?? (diff.squad && rand() >= diff.slip);
  const enemies = enemiesOf(me, entities);
  const friends = friendsOf(me, entities);
  const walks = walkMap(map, me, entities, v.moves);
  const w = map.width;
  const tileOf = (p: Pos) => p.y * w + p.x;
  const posOf = (i: number): Pos => ({ x: i % w, y: Math.floor(i / w) });
  const instinct = !smart || undefined;
  const still: MonsterPlan = { kind: 'move', path: [], instinct };
  if (!enemies.length) return { forced: { kind: 'move', path: [] }, list: [], fallback: still };

  // ---- frightened (Dissonant Whispers): it runs from whoever scared it, as far as it can, and doesn't attack
  const fear = me.statuses.find((s) => s.id === 'frightened');
  if (fear) {
    const from = enemies.find((e) => e.id === fear.by) ?? closestEnemy(me, entities) ?? enemies[0];
    let best: { score: number; walk: Walk } | null = null;
    for (const [i, walk] of walks) {
      const score = dist(from, posOf(i)) - walk.harm * HARM - hazardAt(map, i, me) * 0.5 - walk.steps * STEP_COST;
      if (!best || score > best.score) best = { score, walk };
    }
    return { forced: { kind: 'flee', path: best?.walk.path ?? [] }, list: [], fallback: still };
  }

  // ---- a coward below its nerve runs (a few turns, then it fights cornered)
  // (Only while the rest of its side still fights: the last one standing has nowhere to run to.)
  if (role === 'coward' && me.hp < me.maxHp * COWARD_HP && (me.fled ?? 0) < COWARD_TURNS && friends.length) {
    let best: { score: number; walk: Walk; gap: number } | null = null;
    for (const [i, walk] of walks) {
      const p = posOf(i);
      const gap = Math.min(...enemies.map((e) => dist(e, p)));
      const score = gap - walk.harm * HARM - hazardAt(map, i, me) * 0.5 - walk.steps * STEP_COST;
      if (!best || score > best.score) best = { score, walk, gap };
    }
    if (best && best.gap > 1) return { forced: { kind: 'flee', path: best.walk.path }, list: [], fallback: still };
    const list = planFight();
    for (const c of list) c.plan.cornered = true;
    return { forced: null, list, fallback: { ...still, cornered: true } };
  }
  return { forced: null, list: planFight(), fallback: still };

  function planFight(): Candidate[] {
    const taunt = me.statuses.find((s) => s.id === 'taunted')?.by;
    const taunter = enemies.find((e) => e.id === taunt);
    const sightPool = inSight(enemies);
    const nearest = closestEnemy(me, entities);
    // On instinct it only cares about the closest enemy; with a plan, about everyone it can see (the focus most).
    const targets = smart ? (taunter ? [taunter, ...sightPool.filter((e) => e !== taunter)] : sightPool) : nearest ? [nearest] : [];
    const weight = (t: Entity) => {
      if (taunter) return t === taunter ? 4 : 0.3;
      let k = smart && t.id === v.focus ? FOCUS_WEIGHT : 1;
      if (hunts(me) && shoots(t)) k *= 1.5;
      return k;
    };
    const fields = new Map<string, Float64Array>();
    const fieldFor = (t: Entity) => {
      let f = fields.get(t.id);
      if (!f) fields.set(t.id, (f = approachField(map, me, t, entities, smart ? FRIEND_BLOCK : 0)));
      return f;
    };

    // What its element would set off on the ground (fire on oil, cold on water...): enemies hurt minus friends hurt.
    const fe = fieldElement(elementOf(me));
    const groundCache = new Map<number, number>();
    const groundValue = (i: number): number => {
      if (!fe || !smart) return 0;
      let val = groundCache.get(i);
      if (val === undefined) {
        val = 0;
        if (map.ground[i] || map.clouds[i]) {
          const pv = previewField(map, [{ kind: 'touch', tiles: [i], element: fe }], entities);
          for (const e of new Set([...pv.exposed, ...pv.blasted])) {
            if (!upNow(e)) continue;
            let harm = pv.exposed.includes(e) ? hazardAt(pv.field, tileOf(e), e) : 0;
            if (pv.blasted.includes(e)) harm += avgDice(EXPLOSION) * Math.max(0, damageFactor(e, 'fire'));
            val += sameSide(e, me) ? -FRIENDLY_FIRE * harm : harm;
          }
        }
        groundCache.set(i, val);
      }
      return val;
    };

    const sentinels = enemies.filter((e) => e.kind === 'player' && passiveOf(e, 'sentinel') && dist(e, me) <= 1 && !hasStatus(e, 'surprised'));
    const spread = smart && enemies.some(blasts);
    const shooters = smart ? enemies.filter(shootsFar) : [];
    const support = def.support;
    const list: Candidate[] = [];

    for (const [i, walk] of walks) {
      const at = posOf(i);
      const meAt: MonsterEntity = { ...me, x: at.x, y: at.y };
      const moved = walk.steps > 0;
      const adjacent = enemies.filter((e) => dist(e, at) <= 1);
      // ---- where it stands: hazards, danger for its role, Sentinels it walks away from
      let base = -walk.harm * HARM - hazardAt(map, i, me) * 0.5 - walk.steps * STEP_COST;
      if (smart) {
        base -= DANGER[role] * adjacent.length + (role === 'archer' || role === 'support' ? 0.4 * enemies.filter((e) => dist(e, at) === 2).length : 0);
        base -= SENTINEL_RISK * sentinels.filter((s) => dist(s, at) > 1).length;
        if (role === 'brute' && adjacent.length) base += FRONT;
        // Behind a wall or a crate from the heroes who shoot.
        for (const h of shooters) if (dist(h, at) > 1) base += (COVER[role] * coverFrom(map, h, at)) / FULL_COVER;
        // Bunched up, one Fireball takes the whole pack.
        if (spread) base -= CLUSTER * friends.filter((f) => dist(f, at) <= 1).length + CLUSTER_NEAR * friends.filter((f) => dist(f, at) === 2).length;
        // A fire imp in the flames: the heroes have to step in to reach it.
        if (role !== 'brute' && hazardAt(map, i) > 0 && hazardAt(map, i, me) === 0) base += 0.4;
      }

      // ---- attacks (and shoves) from here
      const stand: Raw = {
        steps: walk.steps, harm: walk.harm, endHazard: hazardAt(map, i, me), adjacent: adjacent.length,
        near2: enemies.filter((e) => dist(e, at) === 2).length, adjFriends: friends.filter((f) => dist(f, at) <= 1).length,
        sentinel: sentinels.filter((s) => dist(s, at) > 1).length,
      };
      const consider = (score: number, plan: MonsterPlan, raw: Partial<Raw> = {}) => list.push({ score, plan, raw: { ...stand, ...raw } });
      const about = (t: Entity): Partial<Raw> => ({ target: t, focus: t.id === v.focus, taunter: t === taunter });
      for (const t of targets) {
        if (!canHitFrom(map, me, at, t)) {
          // Not in reach from here: how much walking is still left. A target that matters more pulls harder: its
          // pack's target is worth a longer walk, and a taunter even pulls it away from hitting someone else.
          const f = fieldFor(t)[i];
          const turns = Number.isFinite(f) ? f / Math.max(1, me.speed) : 3 + dist(at, t) / Math.max(1, me.speed);
          consider(base - APPROACH * (turns - PULL * (weight(t) - 1)), { kind: 'move', path: walk.path, target: t.id }, { ...about(t), turns });
          continue;
        }
        // Stepping next to it makes it turn to face you: no free backstab in melee.
        const tNow = moved && turnsToFace(t, meAt, at) ? { ...t, facing: dirTo(t, at) } : t;
        const others = entities.map((e) => (e.id === me.id ? meAt : e.id === t.id ? tNow : e));
        const why = attackAdvantage(meAt, tNow, others);
        // On instinct it doesn't look for flanks or backs: it just takes the shortest way in.
        const p = hitChance(atkOf(me), acOf(t) + coverFrom(map, at, t), smart ? netAdvantage(why) : 0);
        const ev = attacksOf(me) * p * dmgOf(me) * damageFactor(t, elementOf(me));
        const bite = Math.min(ev, ehp(t)) + KILL_BONUS * clamp(ev / ehp(t), 0, 1) ** 2;
        let score = base + weight(t) * bite + groundValue(tileOf(t));
        if (smart && role === 'skirmisher' && why.adv.includes('flanking')) score += FLANK;
        // What its attacks do on a hit (a Wolf drags them down, a Wight drains them), if they live through it.
        let setup = 0;
        if (smart && def.rider && t.kind === 'player') {
          const land = 1 - (1 - p) ** attacksOf(me);
          const fails = def.rider.save ? saveFails(t, def.rider.save, def.rider.dc ?? 12) : 1;
          setup = land * fails * (1 - clamp(ev / ehp(t), 0, 1)) * trickValue(v, def.rider.status, t, meAt);
          score += weight(t) * setup;
        }
        const hit: Partial<Raw> = {
          ...about(t), ev, p, net: netAdvantage(why), flank: why.adv.includes('flanking'), behind: why.adv.includes('from behind'), ground: groundValue(tileOf(t)),
          setup,
        };
        consider(score, { kind: 'attack', path: walk.path, target: t.id, instinct }, hit);
        // Help instead: get in its face so a bigger friend's swing lands.
        if (smart && canHelp(def) && dist(at, t) === 1) {
          const val = trickValue(v, HELP, t, meAt);
          if (val > 0) consider(base + weight(t) * val, { kind: 'help', path: walk.path, target: t.id }, { ...about(t), setup: val });
        }
        // Shove it into the fire instead?
        if (smart && def.shove && dist(at, t) === 1) {
          const d = dirTo(at, t);
          const land = { x: t.x + d.x, y: t.y + d.y };
          if (canStep(map, t, d.x, d.y) && !entities.some((e) => e !== t && e.x === land.x && e.y === land.y && !(e.kind === 'player' && e.dead))) {
            const harm = hazardAt(map, tileOf(land), t);
            if (harm > 0) {
              const win = contest(def.str - shoveResist(t));
              consider(base + weight(t) * win * (harm * SHOVE_HARM + 1), { kind: 'shove', path: walk.path, target: t.id }, { ...hit, shove: win * harm });
            }
          }
        }
      }

      // ---- its trick: a net, a web, sand in the eyes, a brand, set up for its friends
      const trick = def.trick;
      if (smart && trick && !(me.trickCd ?? 0)) {
        for (const t of targets) {
          if (dist(at, t) > trick.range || (trick.range > 1 && !hasLOS(map, at, t))) continue;
          let chance = trick.save ? saveFails(t, trick.save, trick.dc ?? 12) : 0;
          if (!trick.save) {
            const tNow = moved && turnsToFace(t, meAt, at) ? { ...t, facing: dirTo(t, at) } : t;
            const others = entities.map((e) => (e.id === me.id ? meAt : e.id === t.id ? tNow : e));
            chance = hitChance(atkOf(me), acOf(t), netAdvantage(attackAdvantage(meAt, tNow, others)));
          }
          const val = trick.status.reduce((s, st) => s + trickValue(v, st, t, meAt), 0);
          if (val > 0) consider(base + TRICK_BIAS + weight(t) * chance * val, { kind: 'trick', path: walk.path, target: t.id }, { ...about(t), p: chance, setup: chance * val });
        }
      }

      // ---- hit the ground: fire on the oil under the party, cold on their water
      if (smart && fe && rangeOf(me) > 1) {
        for (const e of enemies) {
          for (const [dx, dy] of DIRS) {
            const g = { x: e.x + dx, y: e.y + dy };
            const gi = tileOf(g);
            if (g.x < 0 || g.y < 0 || g.x >= w || g.y >= map.height || map.tiles[gi] !== '.') continue;
            if (entities.some((x) => x.x === g.x && x.y === g.y && !(x.kind === 'player' && x.dead))) continue; // creatures there get hit instead
            if (dist(at, g) > rangeOf(me) || !hasLOS(map, at, g)) continue;
            const val = groundValue(gi);
            if (val >= IGNITE_MIN) consider(base + val, { kind: 'ignite', path: walk.path, tile: g }, { ground: val });
          }
        }
      }

      // ---- a support's spells: mend a hurt friend, or buff one that's in the thick of it
      if (support) {
        const reach = rangeOf(me);
        for (const f of me.ally ? entities.filter((e) => sameSide(e, me) && e.id !== me.id && !(e.kind === 'player' && e.dead)) : friends) {
          if (dist(at, f) > reach) continue;
          const down = f.kind === 'player' && f.downed;
          if (down || f.hp < f.maxHp * HEAL_BELOW) {
            const mend = Math.min(f.maxHp - f.hp, avgDice(support.heal));
            const urgency = down ? 3 : f.hp < f.maxHp * 0.35 ? 1.5 : 1;
            const big = f.kind === 'monster' && (f.boss || f.elite) ? 1 : 0;
            consider(base + SUPPORT_BIAS + mend * urgency + (down ? 8 : 0) + big, { kind: 'heal', path: walk.path, target: f.id }, { target: f, heal: mend / f.maxHp });
          }
          if (!down && canBuff(f, support.buff)) {
            const val = buffValue(f, support.buff, enemies);
            if (val > 0) consider(base + SUPPORT_BIAS + val, { kind: 'buff', path: walk.path, target: f.id }, { target: f, buff: val });
          }
        }
      }
    }
    return list;
  }
}

// ---------------------------------------------------------------- what the learned policy sees (Phase 11)

/** One option for the learned policy: the plan, the scripted AI's score for it, and its features. */
export interface MonsterOption {
  plan: MonsterPlan;
  score: number;
  features: number[];
}

export interface MonsterChoices {
  forced: MonsterPlan | null; // no choice to make (a coward running, nothing to fight)
  options: MonsterOption[]; // the scripted AI's pick first, then the rest
  state: number[]; // the fight as this monster sees it (for the trainer's value estimate)
}

const KINDS: MonsterPlan['kind'][] = ['attack', 'shove', 'ignite', 'heal', 'buff', 'move', 'trick', 'help'];
const ROLE_IDS: Role[] = ['brute', 'skirmisher', 'archer', 'support', 'coward'];
const SELF_FEATURES = 11;
export const OPTION_FEATURES = KINDS.length + 29 + SELF_FEATURES;
/** Where optionFeatures puts "the scripted AI's top pick" (the trainer measures how often the policy agrees with it). */
export const TOP_FEATURE = KINDS.length + 1;
export const STATE_FEATURES = SELF_FEATURES + 3;
export const MAX_OPTIONS = 32;
const bit = (b: boolean | undefined) => (b ? 1 : 0);

/** The monster itself: HP, role, rank, how the fight stands. */
function selfFeatures(v: MonsterView, friends: Entity[], enemies: Entity[]): number[] {
  const { me } = v;
  const role = roleOf(MONSTERS[me.type]);
  return [
    me.hp / me.maxHp, ...ROLE_IDS.map((r) => bit(r === role)), bit(me.elite || me.boss),
    friends.length / 6, enemies.length / 6, Math.min(1, (v.round ?? 1) / 10), bit(!!MONSTERS[me.type].trick && !(me.trickCd ?? 0)),
  ];
}

/**
 * An option as numbers, roughly 0..1 each. Three of them are the scripted AI's opinion (its score, whether it's its
 * top pick, how far behind the top it is): the policy can lean on them or learn past them.
 */
function optionFeatures(c: Candidate, top: number, moves: number, self: number[]): number[] {
  const r = c.raw;
  const t = r.target;
  return [
    ...KINDS.map((k) => bit(c.plan.kind === k)),
    clamp(c.score / 10, -3, 3), bit(c.score >= top - 1e-9), clamp((c.score - top) / 2, -3, 0), r.steps / Math.max(1, moves), Math.min(3, r.harm / 10), Math.min(3, r.endHazard / 10),
    r.adjacent / 4, r.near2 / 4, r.adjFriends / 4, r.sentinel,
    bit(r.focus), bit(r.taunter), t ? t.hp / t.maxHp : 0, t ? Math.min(3, ehp(t) / 50) : 0, bit(t?.kind === 'player'), bit(!!t && shoots(t)),
    Math.min(3, (r.ev ?? 0) / 10), t && r.ev !== undefined ? clamp(r.ev / ehp(t), 0, 1.5) : 0, r.p ?? 0, r.net ?? 0, bit(r.flank), bit(r.behind),
    Math.min(3, (r.turns ?? 0) / 3), clamp((r.ground ?? 0) / 10, -3, 3), Math.min(3, (r.shove ?? 0) / 10), r.heal ?? 0, Math.min(3, (r.buff ?? 0) / 5),
    bit(t?.kind === 'player' && t.downed), Math.min(3, (r.setup ?? 0) / 5),
    ...self,
  ];
}

/**
 * The options the learned policy chooses from (server/policy.ts, training/): the best candidate for every action and
 * target, then the best of the rest by the scripted score, MAX_OPTIONS at most. The scripted AI's own pick comes first.
 * Always with the squad's full tactics (no slips): the policy decides for itself.
 */
export function monsterChoices(v: MonsterView): MonsterChoices {
  const { forced, list, fallback } = candidates({ ...v, smart: true });
  const enemies = enemiesOf(v.me, v.entities);
  const friends = friendsOf(v.me, v.entities);
  const self = selfFeatures(v, friends, enemies);
  const side = (es: Entity[]) => (es.length ? es.reduce((s, e) => s + e.hp / e.maxHp, 0) / es.length : 0);
  const downed = v.entities.filter((e) => e.kind === 'player' && e.downed && !e.dead).length;
  const state = [...self, side(friends), side(enemies), downed / 6];
  if (forced) return { forced, options: [], state };
  const sorted = [...list].sort((a, b) => b.score - a.score);
  const picked = new Set<Candidate>();
  const seen = new Set<string>();
  for (const c of sorted) {
    const key = `${c.plan.kind}:${c.plan.target ?? `${c.plan.tile?.x},${c.plan.tile?.y}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.add(c);
  }
  for (const c of sorted) {
    if (picked.size >= MAX_OPTIONS) break;
    picked.add(c);
  }
  const chosen = sorted.filter((c) => picked.has(c)).slice(0, MAX_OPTIONS);
  if (!chosen.length) return { forced: fallback, options: [], state };
  const top = chosen[0].score;
  return { forced: null, options: chosen.map((c) => ({ plan: c.plan, score: c.score, features: optionFeatures(c, top, v.moves, self) })), state };
}

/** Not on it yet, or it stacks and has room for another. */
function canBuff(f: Entity, buff: StatusApply): boolean {
  const have = f.statuses.find((x) => x.id === buff.id);
  return !have || (!!buff.stack && (have.power ?? 0) < (buff.power ?? 1) * buff.stack);
}

/** Roughly what a buff adds over its turns: Blessed and Rallied land more (and harder) hits, Shielded turns some away. */
function buffValue(f: Entity, buff: StatusApply, enemies: Entity[]): number {
  const turns = Math.min(buff.turns, 2);
  const near = enemies.filter((e) => dist(e, f) <= (f.kind === 'monster' ? rangeOf(f) + 1 : 2)).length;
  if (!near) return 0;
  if (buff.id === 'blessed') {
    const swing = f.kind === 'monster' ? attacksOf(f) * dmgOf(f) : 7;
    return 0.1 * swing * turns * (f.kind === 'monster' && (f.boss || f.elite) ? 1.5 : 1);
  }
  if (buff.id === 'rallied') {
    const hits = f.kind === 'monster' ? attacksOf(f) : 1;
    return hits * (0.55 + 0.05 * (f.kind === 'monster' ? dmgOf(f) : 7)) * (buff.power ?? 1) * turns * (f.kind === 'monster' && (f.boss || f.elite) ? 1.5 : 1);
  }
  if (buff.id === 'shielded') return 0.05 * (buff.power ?? 2) * 6 * enemies.filter((e) => dist(e, f) <= 1).length * turns;
  return 0;
}

// ---------------------------------------------------------------- tricks: set-ups and orders (Phase 12)

/** Will `a` act before `b` gets its next turn? Unknown order: assume so. */
function actsBefore(v: MonsterView, a: Entity, b: Entity): boolean {
  if (!v.order) return true;
  const i = v.order.indexOf(a.id);
  const j = v.order.indexOf(b.id);
  return i >= 0 && (j < 0 || i < j);
}

/**
 * What its friends gain against `t` from a change to their attack rolls (advantage +1, disadvantage -1), over at most
 * `swings` attacks each: the friends who can get to it before its turn (all of them with `anyTime`), its pack fully
 * and the rest by half. `best`: only the best one counts (a Help is spent on the first attack).
 */
function swingGain(v: MonsterView, t: Entity, net: 1 | -1, pick: (f: MonsterEntity) => boolean, o: { swings?: number; best?: boolean; anyTime?: boolean } = {}): number {
  let sum = 0;
  for (const f of v.entities) {
    if (f.kind !== 'monster' || f.id === v.me.id || !sameSide(f, v.me) || skips(f) || !pick(f) || !reaches(f, t)) continue;
    if (!o.anyTime && !actsBefore(v, f, t)) continue;
    const p0 = hitChance(atkOf(f), acOf(t));
    const g = Math.abs(hitChance(atkOf(f), acOf(t), net) - p0) * Math.min(attacksOf(f), o.swings ?? 9) * dmgOf(f) * damageFactor(t, elementOf(f));
    const share = v.assign?.[f.id] === undefined || v.assign[f.id] === t.id ? 1 : OTHER_PACK;
    sum = o.best ? Math.max(sum, g * share) : sum + g * share;
  }
  return sum;
}

/** What keeping `t` from moving is worth: a melee hero who can't walk in is out of the fight; anyone else can't get away. */
function rootValue(v: MonsterView, t: Entity): number {
  const engaged = v.entities.some((f) => f.kind === 'monster' && sameSide(f, v.me) && dist(f, t) <= 1);
  const melee = t.kind === 'player' ? t.classId === 'fighter' || t.classId === 'cleric' : !shoots(t);
  return engaged || !melee ? 0.5 : 0.5 * threatOf(t);
}

/** What putting this status on `t` is worth to the monster's side (`me`: the monster where it would stand). */
export function trickValue(v: MonsterView, st: StatusApply, t: Entity, me: MonsterEntity = v.me): number {
  if (!upNow(t)) return 0;
  const has = hasStatus(t, st.id);
  const all = () => true;
  const view = me === v.me ? v : { ...v, me };
  switch (st.id) {
    case 'netted': // the archers get advantage; it can't come at us or get away
      return rooted(t) ? 0 : swingGain(view, t, 1, shoots) + rootValue(view, t);
    case 'webbed': // everyone gets advantage, its own attacks get disadvantage; stuck until it cuts itself free
      return rooted(t) ? 0 : swingGain(view, t, 1, all) + 0.3 * threatOf(t) + rootValue(view, t);
    case 'prone': // melee gets advantage until it stands up, archers get disadvantage
      return has ? 0 : swingGain(view, t, 1, (f) => !shoots(f)) - swingGain(view, t, -1, shoots);
    case 'marked': // advantage for everyone, for two turns
      return has ? 0 : 1.5 * swingGain(view, t, 1, all, { anyTime: true });
    case 'distracted': // the next attack against it has advantage
      return has ? 0 : swingGain(view, t, 1, all, { swings: 1, best: true });
    case 'blinded': // its attacks have disadvantage for a turn
      return has ? 0 : 0.3 * threatOf(t);
    case 'drained':
      return t.kind === 'player' ? 0.5 * (st.power ?? 2) : 0;
    default:
      return 0;
  }
}

export interface MonsterOrder {
  id: OrderId;
  target?: string; // Kill that one!
}

/**
 * A leader's order at the start of its turn (game.ts gives it, then the leader takes its turn as usual):
 * - Charge! when friends are just out of reach (+3 movement gets them in) or a Rallied stack helps the fight;
 * - Hold the line! when friends are in the thick of it, the hurt ones and the big ones most;
 * - Kill that one! on the enemy the most friends can get to, so they all hit it with advantage.
 */
export function pickOrder(v: MonsterView): MonsterOrder | null {
  const { me } = v;
  const enemies = enemiesOf(me, v.entities);
  if (!enemies.length) return null;
  const squad = v.entities.filter((f): f is MonsterEntity => f.kind === 'monster' && sameSide(f, me) && dist(f, me) <= ORDER_RANGE && !skips(f));
  let charge = 0;
  let hold = 0;
  for (const f of squad) {
    const gap = Math.min(...enemies.map((e) => dist(e, f))) - rangeOf(f);
    const swing = attacksOf(f) * 0.55 * dmgOf(f);
    if (!rooted(f) && gap > movesOf(f) && gap <= movesOf(f) + CHARGE_MOVES) charge += swing;
    if (gap <= movesOf(f) + CHARGE_MOVES && rallyOf(f) < 3) charge += attacksOf(f) * 1.5;
    const adjacent = enemies.filter((e) => dist(e, f) <= 1).length;
    if (adjacent && !hasStatus(f, 'shielded')) hold += 1.2 * adjacent * (f.hp < f.maxHp / 2 ? 1.5 : 1) * (f.boss || f.elite ? 1.5 : 1);
  }
  let kill = 0;
  let target: Entity | undefined;
  for (const t of inSight(enemies)) {
    const val = trickValue(v, { id: 'marked', turns: 2 }, t);
    if (val > kill) [kill, target] = [val, t];
  }
  const best = Math.max(charge, hold, kill);
  if (best < ORDER_MIN) return null;
  if (best === kill && target) return { id: 'kill', target: target.id };
  return best === charge ? { id: 'charge' } : { id: 'hold' };
}
