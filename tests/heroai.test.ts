import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canStep, dist, reachable, type MapLike } from '../shared/grid.ts';
import { CLASSES, CLASS_IDS, MONSTERS, TIER3_LEVEL, maxHpFor, maxSlotsFor } from '../shared/rules.ts';
import { SKILLS, SKILL_IDS, canUpgrade, countKind, limitFor, ownedSkill, resolveAim, skillBlockReason, slotCost, statsOf, type SkillId } from '../shared/skills.ts';
import { attackAdvantage, dirTo, isBehind, isFlanking, netAdvantage } from '../shared/tactics.ts';
import type { ClassId, MonsterEntity, PlayerEntity, Pos, TurnState } from '../shared/types.ts';
import { autoApproachChoice, autoEventChoice, autoPathChoice, nextHeroIntent, upkeepIntent, type HeroIntent, type HeroView } from '../server/heroai.ts';
import { recalcHero, startingSkills } from '../server/progression.ts';
import { makeRng, type Rng } from '../server/rng.ts';

/** A room with a wall ring and no obstacles. */
function room(w: number, h: number): MapLike {
  const tiles = Array.from({ length: w * h }, (_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.';
  }).join('');
  return { width: w, height: h, tiles };
}
const map = room(12, 8);

let ids = 0;
function hero(classId: ClassId, x: number, y: number, extra: Partial<PlayerEntity> = {}): PlayerEntity {
  const hp = maxHpFor(classId, 1);
  return {
    id: `h${++ids}`, kind: 'player', playerId: `p${ids}`, classId, name: classId, glyph: '', color: '#fff', x, y,
    hp, maxHp: hp, ac: CLASSES[classId].ac, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level: 1, xp: 0, skills: startingSkills(classId),
    levelUps: 0, offer: null, bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, kills: 0, steals: 0,
    slots: maxSlotsFor(classId, 1), maxSlots: maxSlotsFor(classId, 1), downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [],
    ...extra,
  };
}

function monster(type: string, x: number, y: number, extra: Partial<MonsterEntity> = {}): MonsterEntity {
  const d = MONSTERS[type];
  return {
    id: `m${++ids}`, kind: 'monster', type, name: d.name, glyph: '', x, y, hp: d.hp, maxHp: d.hp, ac: d.ac, speed: d.speed,
    statuses: [], facing: { x: -1, y: 0 }, boss: false, elite: false, dmgBy: {}, ...extra,
  };
}
const goblin = (x: number, y: number, extra: Partial<MonsterEntity> = {}) => monster('goblin', x, y, extra);

const freshTurn = (): TurnState => ({ order: [], init: {}, index: 0, round: 1, movesLeft: 6, actionUsed: false, bonusUsed: false });

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[], turn = freshTurn(), m = map): HeroView {
  const all = [...heroes, ...monsters];
  return {
    map: m, hero: h, heroes, monsters, turn,
    occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)),
  };
}

/** Swaps in skills (basic attacks are kept from the class start). */
const withSkills = (p: PlayerEntity, list: [SkillId, (1 | 2 | 3)?, ('A' | 'B')?][]) => {
  p.skills = [...p.skills.filter((s) => SKILLS[s.id].kind === 'basic'), ...list.map(([id, tier = 1, branch]) => ({ id, tier, branch, cd: 0 }))];
  return p;
};

/** True if the game would accept this act (the same checks as a human click). */
function validAct(v: HeroView, intent: HeroIntent): string | null {
  if (intent.kind !== 'act') return null;
  const why = skillBlockReason(v.hero, intent.skill, true, v.turn, true);
  if (why) return why;
  const res = resolveAim(statsOf(ownedSkill(v.hero, intent.skill)!), v.hero, intent.target, { map: v.map, entities: [...v.heroes, ...v.monsters], inCombat: true });
  return typeof res === 'string' ? res : null;
}

/** Follows the AI's moves (teleporting the hero) until it acts or ends the turn. */
function firstAct(v: HeroView): HeroIntent {
  for (let i = 0; i < 10; i++) {
    const intent = nextHeroIntent(v);
    if (intent.kind !== 'move') return intent;
    const walked = Math.max(Math.abs(intent.to.x - v.hero.x), Math.abs(intent.to.y - v.hero.y));
    Object.assign(v.hero, intent.to);
    v.turn.movesLeft -= walked;
  }
  throw new Error('keeps walking');
}

/**
 * Roughly what game.ts does with an act: pay for it, apply the turn effects and your own statuses, give a hidden hero
 * away, turn toward the target, then hurt it (5 damage) or shove it (a won contest unless `r` says otherwise).
 */
function applyAct(v: HeroView, intent: Extract<HeroIntent, { kind: 'act' }>, r?: Rng) {
  const { hero: me, turn } = v;
  const own = ownedSkill(me, intent.skill)!;
  const s = statsOf(own);
  if (s.cost === 'action') turn.actionUsed = true;
  if (s.cost === 'bonus') turn.bonusUsed = true;
  if (SKILLS[intent.skill].kind === 'spell') me.slots -= slotCost(s);
  if (SKILLS[intent.skill].kind === 'cantrip') own.cd = s.cooldown ?? 0;
  if (intent.skill === 'potion') me.potions--;
  if (s.refresh) {
    turn.actionUsed = false;
    me.used.push('turn:surge');
  }
  if (s.dash) turn.movesLeft += s.dash;
  if (s.sneak) me.used.push('turn:sneak');
  if (s.heal) for (const p of v.heroes) if (p.id === intent.target || (!intent.target && p === me)) Object.assign(p, { downed: false, hp: Math.min(p.maxHp, p.hp + 5) });
  for (const st of s.selfStatus ?? []) me.statuses = [...me.statuses.filter((x) => x.id !== st.id), { id: st.id, turns: st.turns + 1, power: st.power }];
  const offensive = s.target === 'enemy' || s.target === 'area' || s.target === 'around';
  if (offensive) me.statuses = me.statuses.filter((x) => x.id !== 'hidden' && (s.roll !== 'attack' || x.id !== 'focused'));
  const target = v.monsters.find((m) => m.id === intent.target);
  if (!target) return;
  const d = dirTo(me, target);
  if (d.x || d.y) me.facing = d;
  if (s.roll === 'contest' && (!r || r.chance(0.5))) {
    const to = { x: target.x + d.x, y: target.y + d.y };
    if (canStep(v.map, target, d.x, d.y) && !v.occupied(to.x, to.y, target.id)) Object.assign(target, to);
  }
  if (s.dmg) {
    target.hp -= 5;
    if (target.hp <= 0) v.monsters.splice(v.monsters.indexOf(target), 1);
  }
}

/** Is the hero's attack on `m` from where it stands rolled with advantage? */
const hasAdv = (v: HeroView, m: MonsterEntity) => netAdvantage(attackAdvantage(v.hero, m, [...v.heroes, ...v.monsters])) > 0;

// ---------------------------------------------------------------- ported behaviors

test('a fighter next to a goblin attacks it (stepping around to its back first is fine)', () => {
  const f = hero('fighter', 3, 3);
  const g = goblin(4, 3);
  assert.deepEqual(firstAct(view(f, [f], [g])), { kind: 'act', skill: 'longsword', target: g.id });
});

test('a fighter far from enemies walks toward them', () => {
  const f = hero('fighter', 1, 3);
  const g = goblin(10, 3);
  const intent = nextHeroIntent(view(f, [f], [g]));
  assert.equal(intent.kind, 'move');
  if (intent.kind === 'move') assert.ok(intent.to.x > f.x, 'moves right, toward the goblin');
});

test('a wizard in melee steps away before casting', () => {
  const w = hero('wizard', 5, 3);
  const g = goblin(6, 3);
  const intent = nextHeroIntent(view(w, [w], [g]));
  assert.equal(intent.kind, 'move');
  if (intent.kind === 'move') assert.ok(Math.max(Math.abs(intent.to.x - g.x), Math.abs(intent.to.y - g.y)) >= 2);
});

test('a wizard saves Magic Missile for elites and bosses', () => {
  for (const weak of [goblin(7, 3, { hp: 3, ac: 12 }), goblin(7, 3), monster('orc', 7, 3)]) {
    const w = hero('wizard', 2, 3);
    const plain = firstAct(view(w, [w], [weak]));
    assert.ok(plain.kind === 'act' && ['fire_bolt', 'dagger'].includes(plain.skill), `${weak.type}: ${JSON.stringify(plain)}`);
  }
  const w = hero('wizard', 2, 3);
  const boss = goblin(7, 3, { hp: 50, maxHp: 50, boss: true });
  const big = nextHeroIntent(view(w, [w], [boss]));
  assert.equal(big.kind === 'act' && big.skill, 'magic_missile');
});

test('a cleric revives a downed ally with Healing Word first', () => {
  const c = hero('cleric', 2, 3);
  const down = hero('fighter', 5, 3, { hp: 0, downed: true });
  const g = goblin(6, 3);
  assert.deepEqual(nextHeroIntent(view(c, [c, down], [g])), { kind: 'act', skill: 'healing_word', target: down.id });
});

test('a cleric walks into range of a downed ally before reviving', () => {
  const c = hero('cleric', 1, 1);
  const down = hero('fighter', 9, 6, { hp: 0, downed: true });
  const g = goblin(10, 6);
  const v = view(c, [c, down], [g]);
  const intent = nextHeroIntent(v);
  assert.equal(intent.kind, 'move');
  if (intent.kind === 'move') assert.ok(Math.max(Math.abs(intent.to.x - down.x), Math.abs(intent.to.y - down.y)) <= 6);
});

test('a badly hurt hero drinks a potion', () => {
  const r = hero('rogue', 2, 3, { hp: 2 });
  const g = goblin(8, 3);
  assert.deepEqual(nextHeroIntent(view(r, [r], [g])), { kind: 'act', skill: 'potion', target: r.id });
});

test('the turn ends when the action is used and nothing else helps', () => {
  const f = hero('fighter', 3, 3);
  const g = goblin(4, 3);
  const turn = { ...freshTurn(), actionUsed: true, bonusUsed: true };
  assert.deepEqual(nextHeroIntent(view(f, [f], [g], turn)), { kind: 'end' });
});

test('between rooms: drink when hurt, otherwise do nothing', () => {
  const r = hero('rogue', 0, 0, { hp: 3 });
  assert.deepEqual(upkeepIntent(r, [r]), { kind: 'act', skill: 'potion', target: r.id });
  const fine = hero('rogue', 0, 0);
  assert.equal(upkeepIntent(fine, [fine]), null);
});

test('auto votes: rest when hurt, never an elite at level 1, leave events when nearly dead', () => {
  const hurt = [hero('fighter', 0, 0, { hp: 2 }), hero('wizard', 0, 0, { hp: 1 })];
  const options = [{ id: 'a', type: 'combat' as const }, { id: 'b', type: 'rest' as const }, { id: 'c', type: 'elite' as const }];
  for (let i = 0; i < 50; i++) assert.equal(autoPathChoice(options, hurt), 'b');
  const fresh = [hero('fighter', 0, 0), hero('wizard', 0, 0)];
  for (let i = 0; i < 50; i++) assert.notEqual(autoPathChoice(options, fresh), 'c');
  for (let i = 0; i < 20; i++) assert.equal(autoEventChoice(['pray', 'leave'], hurt), 'leave');
});

// ---------------------------------------------------------------- skills

test('cantrips are used when ready, the basic attack when they are on cooldown', () => {
  // firstAct: the hero may walk somewhere better (the goblin's back) before attacking.
  const w = hero('wizard', 2, 3);
  const ready = firstAct(view(w, [w], [goblin(6, 3)]));
  assert.equal(ready.kind === 'act' && ready.skill, 'fire_bolt');
  const w2 = hero('wizard', 2, 3);
  w2.skills.find((s) => s.id === 'fire_bolt')!.cd = 1;
  const g = goblin(6, 3);
  assert.deepEqual(firstAct(view(w2, [w2], [g])), { kind: 'act', skill: 'dagger', target: g.id });

  const f = withSkills(hero('fighter', 3, 3), [['heavy_strike']]);
  assert.equal((firstAct(view(f, [f], [goblin(4, 3, { hp: 20, maxHp: 20 })])) as { skill?: string }).skill, 'heavy_strike');
  const f2 = withSkills(hero('fighter', 3, 3), [['heavy_strike']]);
  f2.skills.find((s) => s.id === 'heavy_strike')!.cd = 2;
  assert.equal((firstAct(view(f2, [f2], [goblin(4, 3, { hp: 20, maxHp: 20 })])) as { skill?: string }).skill, 'longsword');
});

test('a wizard drops a Fireball on a cluster of three goblins', () => {
  const w = withSkills(hero('wizard', 2, 3), [['fire_bolt'], ['fireball']]);
  const gs = [goblin(7, 3), goblin(8, 3), goblin(7, 4)];
  const v = view(w, [w], gs);
  const intent = nextHeroIntent(v);
  assert.equal(validAct(v, intent), null);
  assert.ok(intent.kind === 'act' && intent.skill === 'fireball', `got ${JSON.stringify(intent)}`);
  assert.equal(typeof intent.target, 'object', 'aimed at a tile');
  const res = resolveAim(statsOf({ id: 'fireball', tier: 1 }), w, intent.target, { map, entities: [w, ...gs], inCombat: true });
  assert.ok(typeof res === 'object' && res.foes.length === 3, 'catches all three');
  // ...but not on a single goblin: that's what Fire Bolt is for.
  const one = nextHeroIntent(view(w, [w], [goblin(7, 3)]));
  assert.equal(one.kind === 'act' && one.skill, 'fire_bolt');
});

test('a fighter follows up with Shield Bash after attacking', () => {
  const f = hero('fighter', 3, 3);
  const g = goblin(4, 3, { hp: 20, maxHp: 20 });
  const turn = { ...freshTurn(), actionUsed: true };
  assert.deepEqual(firstAct(view(f, [f], [g], turn)), { kind: 'act', skill: 'shield_bash', target: g.id });
});

test('a hurt fighter uses Second Wind', () => {
  const f = hero('fighter', 3, 3, { hp: 3 });
  const g = goblin(4, 3);
  assert.deepEqual(nextHeroIntent(view(f, [f], [g])), { kind: 'act', skill: 'second_wind' });
});

test('a rogue Feints before attacking, to get advantage and Sneak Attack', () => {
  // Rooted: with moves left it would rather walk to the goblin's back for advantage, and keep the Feint.
  const r = withSkills(hero('rogue', 3, 3), [['feint']]);
  const g = goblin(4, 3, { hp: 20, maxHp: 20 });
  assert.deepEqual(nextHeroIntent(view(r, [r], [g], { ...freshTurn(), movesLeft: 0 })), { kind: 'act', skill: 'feint', target: g.id });
});

test('a rogue uses Cunning Dash when that is the only way to reach a target', () => {
  const r = withSkills(hero('rogue', 1, 2), [['cunning_dash']]);
  r.skills = r.skills.filter((s) => s.id !== 'shortbow');
  const wide = room(20, 5);
  const g = goblin(14, 2); // 13 tiles away: out of reach with 6 moves, in reach with 6 + 6
  assert.deepEqual(nextHeroIntent(view(r, [r], [g], freshTurn(), wide)), { kind: 'act', skill: 'cunning_dash' });
  // Close enough without it: no dash, just walk.
  const near = goblin(6, 2);
  assert.equal(nextHeroIntent(view(r, [r], [near], freshTurn(), wide)).kind, 'move');
});

test('a wizard casts Shield when an elite is on them', () => {
  const w = withSkills(hero('wizard', 3, 3), [['fire_bolt'], ['shield']]);
  const hob = monster('hobgoblin', 4, 3, { elite: true });
  const turn = { ...freshTurn(), actionUsed: true, movesLeft: 0 };
  assert.deepEqual(nextHeroIntent(view(w, [w], [hob], turn)), { kind: 'act', skill: 'shield' });
});

test('a healthy fighter taunts goblins off the wizard, a badly hurt one does not', () => {
  const f = withSkills(hero('fighter', 4, 3), [['battle_cry']]);
  const w = hero('wizard', 6, 3);
  const gs = [goblin(5, 2), goblin(5, 4)]; // as close to both: they'd go for the frailer wizard
  const turn = () => ({ ...freshTurn(), actionUsed: true, movesLeft: 0 });
  assert.deepEqual(nextHeroIntent(view(f, [f, w], gs, turn())), { kind: 'act', skill: 'battle_cry' });
  f.hp = 3;
  const hurt = nextHeroIntent(view(f, [f, w], gs, turn()));
  assert.ok(hurt.kind !== 'act' || hurt.skill !== 'battle_cry', JSON.stringify(hurt));
});

test('a cleric patches up a badly hurt ally in the fight', () => {
  const c = hero('cleric', 2, 3);
  const f = hero('fighter', 5, 3, { hp: 3 });
  const g = goblin(6, 3);
  assert.deepEqual(nextHeroIntent(view(c, [c, f], [g])), { kind: 'act', skill: 'healing_word', target: f.id });
});

test('a stunned or downed hero just ends the turn', () => {
  const f = hero('fighter', 3, 3, { statuses: [{ id: 'stunned', turns: 1 }] });
  const g = goblin(4, 3);
  assert.deepEqual(nextHeroIntent(view(f, [f], [g])), { kind: 'end' });
  const d = hero('fighter', 3, 3, { hp: 0, downed: true });
  assert.deepEqual(nextHeroIntent(view(d, [d], [g])), { kind: 'end' });
});

test('between rooms: heal spells only with a slot to spare', () => {
  const c = hero('cleric', 0, 0, { slots: 2 });
  const f = hero('fighter', 0, 0, { hp: 4, potions: 1 }); // has a potion of their own, so the cleric keeps theirs
  assert.deepEqual(upkeepIntent(c, [c, f]), { kind: 'act', skill: 'healing_word', target: f.id });
  c.slots = 1;
  assert.equal(upkeepIntent(c, [c, f]), null, 'keeps the last slot for the next fight');
  f.hp = 2; // in real trouble now
  assert.deepEqual(upkeepIntent(c, [c, f]), { kind: 'act', skill: 'healing_word', target: f.id });
});

// ---------------------------------------------------------------- positioning & surprise (Phase 4)

/** A Rogue with only the rapier: it has to fight in melee. */
const meleeRogue = (x: number, y: number) => {
  const r = withSkills(hero('rogue', x, y), []);
  r.skills = r.skills.filter((s) => s.id !== 'shortbow');
  return r;
};

test('a rogue walks to the tile across from the fighter to flank, rather than the nearest one', () => {
  const f = hero('fighter', 4, 3);
  const g = goblin(5, 3, { hp: 20, maxHp: 20, facing: { x: 0, y: 1 } }); // looking south, at the rogue
  const r = meleeRogue(5, 6);
  const v = view(r, [r, f], [g]);
  // The tiles below the goblin are 2 steps away but in front of it; across from the fighter is 3.
  assert.deepEqual(firstAct(v), { kind: 'act', skill: 'rapier', target: g.id });
  assert.deepEqual({ x: r.x, y: r.y }, { x: 6, y: 3 });
  assert.ok(isFlanking(r, g, [r, f, g]));
});

test('a fighter takes a flanking tile when one is reachable at similar cost', () => {
  const c = hero('cleric', 4, 3);
  const g = goblin(5, 3, { hp: 20, maxHp: 20, facing: { x: 0, y: 1 } });
  const f = hero('fighter', 6, 6);
  const v = view(f, [f, c], [g]);
  assert.deepEqual(firstAct(v), { kind: 'act', skill: 'longsword', target: g.id });
  assert.ok(isFlanking(f, g, [f, c, g]), `attacks from ${f.x},${f.y}`);
});

test('a rogue with a bow shoots a goblin in the back', () => {
  const f = hero('fighter', 4, 3);
  const g = goblin(5, 3, { hp: 20, maxHp: 20 }); // looking west, at the fighter
  const r = hero('rogue', 2, 5);
  const v = view(r, [r, f], [g]);
  const intent = firstAct(v);
  assert.ok(intent.kind === 'act' && intent.target === g.id && ['shortbow', 'rapier'].includes(intent.skill), JSON.stringify(intent));
  assert.ok(isBehind(g, r) && hasAdv(v, g), `shoots from ${r.x},${r.y}`);
});

test('a rogue hides before attacking when nothing else gives advantage, then attacks with it', () => {
  const r = withSkills(hero('rogue', 5, 3), [['hide']]);
  const g = goblin(10, 3, { hp: 20, maxHp: 20 }); // its back is to the wall: no way behind it
  const v = view(r, [r], [g]);
  const hide = nextHeroIntent(v);
  assert.deepEqual(hide, { kind: 'act', skill: 'hide' });
  assert.equal(validAct(v, hide), null);
  applyAct(v, hide as Extract<HeroIntent, { kind: 'act' }>);
  assert.ok(r.statuses.some((s) => s.id === 'hidden'));
  const attack = firstAct(v);
  assert.ok(attack.kind === 'act' && attack.target === g.id && ['shortbow', 'rapier'].includes(attack.skill), JSON.stringify(attack));
  assert.ok(hasAdv(v, g), 'attacks from hiding');
});

test('a rogue never tries to Hide next to an enemy (unless it has Smoke and Mirrors)', () => {
  for (const branch of [undefined, 'A', 'B'] as const) {
    const r = withSkills(hero('rogue', 9, 3, { level: 5 }), [['hide', branch ? 3 : 1, branch]]);
    const f = hero('fighter', 9, 5);
    const g = goblin(10, 3, { hp: 20, maxHp: 20 });
    const turn = freshTurn();
    const first = nextHeroIntent(view(r, [r, f], [g], turn));
    if (branch === 'B') assert.deepEqual(first, { kind: 'act', skill: 'hide' }, 'Smoke and Mirrors hides in melee');
    else assert.ok(first.kind !== 'act' || first.skill !== 'hide', `III-${branch}: ${JSON.stringify(first)}`);
    // Through the whole turn: whenever it hides, it's allowed to.
    for (let i = 0; i < 20; i++) {
      const v = view(r, [r, f], [g], turn);
      const intent = nextHeroIntent(v);
      if (intent.kind === 'end') break;
      if (intent.kind === 'move') {
        turn.movesLeft -= dist(r, intent.to);
        Object.assign(r, intent.to);
        continue;
      }
      assert.equal(validAct(v, intent), null, JSON.stringify(intent));
      if (intent.skill === 'hide' && branch !== 'B') assert.ok(dist(r, g) > 1);
      applyAct(v, intent);
    }
  }
});

test('after attacking, a rogue slips away from the goblin and hides', () => {
  const r = withSkills(hero('rogue', 6, 3), [['hide']]);
  const f = hero('fighter', 6, 4);
  const g = goblin(7, 3, { hp: 20, maxHp: 20 });
  const v = view(r, [r, f], [g], { ...freshTurn(), actionUsed: true });
  assert.deepEqual(firstAct(v), { kind: 'act', skill: 'hide' });
  assert.ok(dist(r, g) > 1);
});

test('a fighter shoves a goblin off a downed friend, but Shield Bashes when it can', () => {
  for (const bashReady of [false, true]) {
    const down = hero('wizard', 3, 4, { hp: 0, downed: true });
    const c = hero('cleric', 9, 6, { slots: 0 });
    const f = hero('fighter', 4, 4, { potions: 0 }); // no potion to feed them
    if (!bashReady) f.skills.find((s) => s.id === 'shield_bash')!.cd = 1;
    const g = goblin(4, 3, { hp: 20, maxHp: 20 });
    const v = view(f, [f, down, c], [g], { ...freshTurn(), actionUsed: true });
    const intent = firstAct(v);
    assert.deepEqual(intent, { kind: 'act', skill: bashReady ? 'shield_bash' : 'shove', target: g.id });
    assert.equal(validAct(v, intent), null);
  }
});

test('a fighter shoves a goblin off the wizard', () => {
  const w = hero('wizard', 5, 3);
  const f = hero('fighter', 5, 2);
  f.skills.find((s) => s.id === 'shield_bash')!.cd = 1;
  const g = goblin(6, 3, { hp: 20, maxHp: 20 });
  const v = view(f, [f, w], [g], { ...freshTurn(), actionUsed: true });
  assert.deepEqual(firstAct(v), { kind: 'act', skill: 'shove', target: g.id });
});

test('nobody bothers taunting monsters that are surprised: they lose their turn anyway', () => {
  const f = withSkills(hero('fighter', 4, 3), [['battle_cry']]);
  const w = hero('wizard', 6, 3);
  const gs = [goblin(5, 2), goblin(5, 4)].map((g) => ({ ...g, statuses: [{ id: 'surprised' as const, turns: 1 }] }));
  const intent = nextHeroIntent(view(f, [f, w], gs, { ...freshTurn(), actionUsed: true, movesLeft: 0 }));
  assert.ok(intent.kind !== 'act' || intent.skill !== 'battle_cry', JSON.stringify(intent));
});

test('a surprised hero just ends the turn (game.ts skips it anyway)', () => {
  const f = hero('fighter', 3, 3, { statuses: [{ id: 'surprised', turns: 1 }] });
  assert.deepEqual(nextHeroIntent(view(f, [f], [goblin(4, 3)])), { kind: 'end' });
});

test('approach vote: a stealthy party sneaks past a dull guard, a clumsy one charges a sharp one', () => {
  const rogues = [hero('rogue', 0, 0, { level: 5 }), hero('rogue', 0, 0, { level: 5 })];
  assert.equal(autoApproachChoice(rogues, 12), 'sneak');
  const clumsy = [hero('fighter', 0, 0), hero('cleric', 0, 0), hero('fighter', 0, 0)];
  assert.equal(autoApproachChoice(clumsy, 18), 'charge');
  // Only standing heroes roll: a downed clumsy friend doesn't drag the rogue down.
  assert.equal(autoApproachChoice([rogues[0], hero('fighter', 0, 0, { hp: 0, downed: true })], 12), 'sneak');
  // Nobody to lose: an all-Alert party can't be surprised, so it always tries.
  const alert = clumsy.map((p) => withSkills({ ...p }, [['alert']]));
  assert.equal(autoApproachChoice(alert, 25), 'sneak');
  assert.equal(autoApproachChoice([], 10), 'charge');
});

// ---------------------------------------------------------------- property tests: never an invalid act, never stuck

const ACTIVE = SKILL_IDS.filter((id) => ['cantrip', 'spell', 'passive'].includes(SKILLS[id].kind));

function randomMap(r: Rng): MapLike {
  const w = r.int(6, 16);
  const h = r.int(5, 12);
  const tiles = Array.from({ length: w * h }, (_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return x === 0 || y === 0 || x === w - 1 || y === h - 1 || r.chance(0.12) ? '#' : '.';
  }).join('');
  return { width: w, height: h, tiles };
}

function randomHero(r: Rng, pos: Pos): PlayerEntity {
  const classId = r.pick(CLASS_IDS);
  const level = r.int(1, 12);
  const p = hero(classId, pos.x, pos.y, { level, maxHp: 1, hp: 1, maxSlots: 0, slots: 0 });
  for (const id of r.shuffle([...ACTIVE])) {
    const def = SKILLS[id];
    if ((def.pool !== classId && def.pool !== 'common') || p.skills.some((s) => s.id === id)) continue;
    if (countKind(p, def.kind) < limitFor(p, def.kind) && r.chance(0.5)) p.skills.push({ id, tier: 1, cd: 0 });
  }
  for (const s of p.skills) {
    if (!canUpgrade(s.id)) continue;
    s.tier = r.pick(level >= TIER3_LEVEL ? [1, 2, 3] as const : [1, 2] as const);
    if (s.tier === 3) s.branch = r.pick(['A', 'B'] as const);
    if (SKILLS[s.id].kind === 'cantrip') s.cd = r.pick([0, 0, 1, 2]);
  }
  recalcHero(p);
  p.slots = r.int(0, p.maxSlots);
  p.potions = r.int(0, 3);
  p.hp = r.int(1, p.maxHp);
  if (r.chance(0.1)) Object.assign(p, { hp: 0, downed: true });
  else if (r.chance(0.05)) Object.assign(p, { hp: 0, dead: true });
  for (const id of ['blessed', 'dazed', 'blinded', 'focused', 'shielded', 'stunned', 'hidden', 'surprised'] as const) {
    if (r.chance(id === 'stunned' || id === 'surprised' ? 0.05 : 0.12)) {
      p.statuses.push({ id, turns: 1, power: id === 'shielded' ? 2 : id === 'hidden' ? r.pick([undefined, 2]) : undefined });
    }
  }
  if (r.chance(0.2)) p.used.push('turn:sneak');
  p.facing = r.pick(FACINGS);
  return p;
}

const FACINGS: Pos[] = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y }))).filter((d) => d.x || d.y);

function randomMonster(r: Rng, pos: Pos): MonsterEntity {
  const type = r.pick(Object.keys(MONSTERS));
  const m = monster(type, pos.x, pos.y, { elite: r.chance(0.15), boss: r.chance(0.08) });
  m.hp = r.int(1, m.maxHp);
  for (const id of ['marked', 'stunned', 'dazed', 'taunted', 'burning', 'surprised'] as const) if (r.chance(0.1)) m.statuses.push({ id, turns: 1 });
  m.facing = r.pick(FACINGS);
  return m;
}

function randomFight(seed: number) {
  const r = makeRng(seed);
  const m = randomMap(r);
  const open: Pos[] = [];
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.tiles[y * m.width + x] !== '#') open.push({ x, y });
  r.shuffle(open);
  const nHeroes = Math.min(r.int(1, 4), open.length - 1);
  const nMonsters = Math.min(r.int(1, 6), open.length - nHeroes);
  const heroes = open.slice(0, nHeroes).map((p) => randomHero(r, p));
  const monsters = open.slice(nHeroes, nHeroes + nMonsters).map((p) => randomMonster(r, p));
  const turn: TurnState = { ...freshTurn(), movesLeft: r.int(0, 8), actionUsed: r.chance(0.25), bonusUsed: r.chance(0.25) };
  return { r, map: m, heroes, monsters, turn, me: heroes[0] };
}

const FIGHTS = 400;

test(`every act in ${FIGHTS} random fights passes the game's checks`, () => {
  let acts = 0;
  for (let seed = 1; seed <= FIGHTS; seed++) {
    const f = randomFight(seed);
    const v = view(f.me, f.heroes, f.monsters, f.turn, f.map);
    const intent = nextHeroIntent(v);
    assert.equal(validAct(v, intent), null, `seed ${seed}: ${JSON.stringify(intent)}`);
    if (intent.kind === 'act') acts++;
    if (intent.kind === 'move') {
      const reach = reachable(f.map, f.me, f.turn.movesLeft, (x, y) => v.occupied(x, y, f.me.id));
      const steps = reach.get(intent.to.y * f.map.width + intent.to.x);
      assert.ok(steps !== undefined && steps > 0, `seed ${seed}: can't walk to ${JSON.stringify(intent.to)}`);
    }
  }
  assert.ok(acts > FIGHTS / 5, `the AI did act sometimes (${acts})`);
});

test(`whole turns in ${FIGHTS} random fights end without a rejected act or a loop`, () => {
  const used = new Map<string, number>();
  for (let seed = 1; seed <= FIGHTS; seed++) {
    const f = randomFight(seed + 10_000);
    const { me, turn } = f;
    let steps = 0;
    for (;; steps++) {
      assert.ok(steps < 25, `seed ${seed}: the turn never ends`);
      const v = view(me, f.heroes, f.monsters, turn, f.map);
      const intent = nextHeroIntent(v);
      if (intent.kind === 'end') break;
      if (intent.kind === 'move') {
        const reach = reachable(f.map, me, turn.movesLeft, (x, y) => v.occupied(x, y, me.id));
        const walked = reach.get(intent.to.y * f.map.width + intent.to.x);
        assert.ok(walked !== undefined && walked > 0, `seed ${seed}: bad move ${JSON.stringify(intent.to)}`);
        Object.assign(me, intent.to);
        turn.movesLeft -= walked;
        continue;
      }
      assert.equal(validAct(v, intent), null, `seed ${seed} step ${steps}: ${JSON.stringify(intent)}`);
      used.set(intent.skill, (used.get(intent.skill) ?? 0) + 1);
      if (intent.skill === 'hide' && !(me.skills.find((o) => o.id === 'hide')?.branch === 'B')) {
        assert.ok(f.monsters.every((m) => dist(m, me) > 1), `seed ${seed}: hides next to an enemy`);
      }
      applyAct(v, intent, f.r);
    }
  }
  // The new tricks do come up in random fights (so the checks above cover them).
  for (const id of ['hide', 'shove']) assert.ok(used.get(id), `never used ${id}: ${JSON.stringify([...used])}`);
});
