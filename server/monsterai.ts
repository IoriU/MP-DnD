// The monster AI (Phase 9). A squad director picks one target for each side; then every monster scores the tiles it
// can reach this turn (who it can hit from there, flanks and back attacks, danger, hazards, what its role wants) and
// plays the best. Scripted "utility AI", readable and beatable on purpose: on Normal a monster now and then slips and
// just goes for whoever is closest, and on Story they all fight that way. NPC allies run on the same code, for the
// party's side.
//
// Pure: game.ts (runMonster) hands it a snapshot and carries out the plan; the tests call it directly.

import { ALLIES, ENRAGED_DMG, auraOf, hasTrait, isAllyNpc, isFoe, sameSide } from '../shared/elites.ts';
import { DIRS, canStep, dist, hasLOS } from '../shared/grid.ts';
import { COWARD_HP, COWARD_TURNS, DIFFICULTIES, MONSTERS, packsFor, roleOf, statMod, type Difficulty, type Role } from '../shared/rules.ts';
import { avgDice, hasStatus, passiveOf, type Element, type StatusApply } from '../shared/skills.ts';
import { EXPLOSION, damageFactor, fieldElement, hazardAt, previewField, type FieldLike } from '../shared/surfaces.ts';
import { attackAdvantage, dirTo, netAdvantage, turnsToFace } from '../shared/tactics.ts';
import type { Entity, MonsterEntity, Pos } from '../shared/types.ts';

export interface MonsterView {
  me: MonsterEntity;
  map: FieldLike;
  entities: Entity[];
  moves: number; // moves left this turn
  difficulty: Difficulty;
  focus: string | null; // its pack's target (squadPlan), or its side's (squadFocus)
  rand?: () => number; // for slips; the tests pass their own
}

/** What a monster does this turn: walk `path`, then act. */
export interface MonsterPlan {
  kind: 'attack' | 'shove' | 'ignite' | 'heal' | 'buff' | 'flee' | 'move';
  path: Pos[];
  target?: string; // who it attacks, shoves, heals or buffs
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
/** HP that has to go before it drops: temp HP and an elite's ward count. */
const ehp = (e: Entity) => Math.max(1, e.hp + (e.kind === 'player' ? e.tempHp : (e.ward ?? 0)));
const enraged = (m: MonsterEntity) => hasTrait(m, 'enraged') && m.hp < m.maxHp / 2;
const atkOf = (m: MonsterEntity) => MONSTERS[m.type].atk + (m.atkBonus ?? 0) + (hasStatus(m, 'blessed') ? 2 : 0) - (hasStatus(m, 'dazed') ? 2 : 0);
const dmgOf = (m: MonsterEntity) => avgDice(MONSTERS[m.type].dmg) + (m.dmgBonus ?? 0) + (enraged(m) ? ENRAGED_DMG : 0);
const attacksOf = (m: MonsterEntity) => MONSTERS[m.type].attacks + (enraged(m) ? 1 : 0);
export const elementOf = (m: MonsterEntity): Element => auraOf(m) ?? MONSTERS[m.type].element ?? 'physical';
const rangeOf = (m: MonsterEntity) => MONSTERS[m.type].range;
const shoots = (e: Entity) => e.kind === 'monster' && rangeOf(e) > 1;
const hunts = (m: MonsterEntity) => !!m.ally && Object.values(ALLIES).some((a) => a.monster === m.type && a.hunts);

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

/** What one tile and one action are worth. */
interface Option {
  score: number;
  plan: MonsterPlan;
}

/**
 * The monster's turn: where to walk and what to do there. A coward below its nerve runs; a support mends or buffs a
 * friend when that beats its attack; otherwise every reachable tile is scored for the best attack from it (or for
 * getting closer), with its role's likes and dislikes, hazards on the way, and Sentinel heroes it would walk away from.
 */
export function planMonster(v: MonsterView): MonsterPlan {
  const { me, map, entities } = v;
  const def = MONSTERS[me.type];
  const role = roleOf(def);
  const diff = DIFFICULTIES[v.difficulty];
  const rand = v.rand ?? Math.random;
  const smart = diff.squad && rand() >= diff.slip;
  const enemies = enemiesOf(me, entities);
  const friends = friendsOf(me, entities);
  const walks = walkMap(map, me, entities, v.moves);
  const w = map.width;
  const tileOf = (p: Pos) => p.y * w + p.x;
  const posOf = (i: number): Pos => ({ x: i % w, y: Math.floor(i / w) });
  const instinct = !smart || undefined;
  if (!enemies.length) return { kind: 'move', path: [] };

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
    if (best && best.gap > 1) return { kind: 'flee', path: best.walk.path };
    return withCornered(planFight());
  }
  return planFight();

  function withCornered(p: MonsterPlan): MonsterPlan {
    return { ...p, cornered: true };
  }

  function planFight(): MonsterPlan {
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
    const support = def.support;
    const options: Option[] = [];

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
        // A fire imp in the flames: the heroes have to step in to reach it.
        if (role !== 'brute' && hazardAt(map, i) > 0 && hazardAt(map, i, me) === 0) base += 0.4;
      }

      // ---- attacks (and shoves) from here
      let bestHere: Option | null = null;
      const consider = (score: number, plan: MonsterPlan) => {
        if (!bestHere || score > bestHere.score) bestHere = { score, plan };
      };
      for (const t of targets) {
        if (!canHitFrom(map, me, at, t)) {
          // Not in reach from here: how much walking is still left. A target that matters more pulls harder: its
          // pack's target is worth a longer walk, and a taunter even pulls it away from hitting someone else.
          const f = fieldFor(t)[i];
          const turns = Number.isFinite(f) ? f / Math.max(1, me.speed) : 3 + dist(at, t) / Math.max(1, me.speed);
          consider(base - APPROACH * (turns - PULL * (weight(t) - 1)), { kind: 'move', path: walk.path, target: t.id });
          continue;
        }
        // Stepping next to it makes it turn to face you: no free backstab in melee.
        const tNow = moved && turnsToFace(t, meAt, at) ? { ...t, facing: dirTo(t, at) } : t;
        const others = entities.map((e) => (e.id === me.id ? meAt : e.id === t.id ? tNow : e));
        const why = attackAdvantage(meAt, tNow, others);
        // On instinct it doesn't look for flanks or backs: it just takes the shortest way in.
        const p = hitChance(atkOf(me), acOf(t), smart ? netAdvantage(why) : 0);
        const ev = attacksOf(me) * p * dmgOf(me) * damageFactor(t, elementOf(me));
        const bite = Math.min(ev, ehp(t)) + KILL_BONUS * clamp(ev / ehp(t), 0, 1) ** 2;
        let score = base + weight(t) * bite + groundValue(tileOf(t));
        if (smart && role === 'skirmisher' && why.adv.includes('flanking')) score += FLANK;
        consider(score, { kind: 'attack', path: walk.path, target: t.id, instinct });
        // Shove it into the fire instead?
        if (smart && def.shove && dist(at, t) === 1) {
          const d = dirTo(at, t);
          const land = { x: t.x + d.x, y: t.y + d.y };
          if (canStep(map, t, d.x, d.y) && !entities.some((e) => e !== t && e.x === land.x && e.y === land.y && !(e.kind === 'player' && e.dead))) {
            const harm = hazardAt(map, tileOf(land), t);
            if (harm > 0) {
              const win = contest(def.str - shoveResist(t));
              consider(base + weight(t) * win * (harm * SHOVE_HARM + 1), { kind: 'shove', path: walk.path, target: t.id });
            }
          }
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
            if (val >= IGNITE_MIN) consider(base + val, { kind: 'ignite', path: walk.path, tile: g });
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
            consider(base + SUPPORT_BIAS + mend * urgency + (down ? 8 : 0) + big, { kind: 'heal', path: walk.path, target: f.id });
          }
          if (!down && !hasStatus(f, support.buff.id)) {
            const val = buffValue(f, support.buff, enemies);
            if (val > 0) consider(base + SUPPORT_BIAS + val, { kind: 'buff', path: walk.path, target: f.id });
          }
        }
      }
      if (bestHere) options.push(bestHere);
    }

    if (!options.length) return { kind: 'move', path: [], instinct };
    options.sort((a, b) => b.score - a.score);
    return options[0].plan;
  }
}

/** Roughly what a buff adds over its turns: Blessed lands more hits, Shielded turns some away. */
function buffValue(f: Entity, buff: StatusApply, enemies: Entity[]): number {
  const turns = Math.min(buff.turns, 2);
  const near = enemies.filter((e) => dist(e, f) <= (f.kind === 'monster' ? rangeOf(f) + 1 : 2)).length;
  if (!near) return 0;
  if (buff.id === 'blessed') {
    const swing = f.kind === 'monster' ? attacksOf(f) * dmgOf(f) : 7;
    return 0.1 * swing * turns * (f.kind === 'monster' && (f.boss || f.elite) ? 1.5 : 1);
  }
  if (buff.id === 'shielded') return 0.05 * (buff.power ?? 2) * 6 * enemies.filter((e) => dist(e, f) <= 1).length * turns;
  return 0;
}
