import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSES, CLASS_IDS } from '../shared/rules.ts';
import {
  SKILLS,
  SKILL_IDS,
  describeSkill,
  hotbar,
  resolveAim,
  skillBlockReason,
  skillTitle,
  statsAt,
} from '../shared/skills.ts';
import type { MonsterEntity, PlayerEntity, TurnState } from '../shared/types.ts';
import { recalcHero, startingSkills } from '../server/progression.ts';

const W = 12;
const H = 8;
const tiles = Array.from({ length: W * H }, (_, i) => {
  const x = i % W;
  const y = Math.floor(i / W);
  return x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : '.';
}).join('');
const map = { width: W, height: H, tiles };

function hero(classId: PlayerEntity['classId'], x = 2, y = 3): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x, y,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], level: 1, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], facing: { x: 1, y: 0 },
  };
  recalcHero(p);
  return p;
}

const goblin = (id: string, x: number, y: number): MonsterEntity => ({
  id, kind: 'monster', type: 'goblin', name: 'Goblin', glyph: '', x, y, hp: 7, maxHp: 7, ac: 15, speed: 6, statuses: [], boss: false, elite: false, dmgBy: {}, facing: { x: -1, y: 0 },
});

const turn = (): TurnState => ({ order: [], init: {}, index: 0, round: 1, movesLeft: 6, actionUsed: false, bonusUsed: false });

test('every class starts with a basic attack, a cantrip and a spell it owns', () => {
  for (const c of CLASS_IDS) {
    const kinds = CLASSES[c].start.map((id) => SKILLS[id].kind);
    assert.ok(kinds.includes('basic'), `${c} has a basic attack`);
    assert.ok(kinds.includes('cantrip'), `${c} has a cantrip`);
    assert.ok(kinds.includes('spell'), `${c} has a spell`);
    for (const id of CLASSES[c].start) assert.equal(SKILLS[id].pool, c, `${id} belongs to ${c}`);
  }
});

test('every upgradable skill has tier II and both tier III branches with their own names', () => {
  for (const id of SKILL_IDS) {
    const def = SKILLS[id];
    if (!def.t2) continue;
    assert.ok(def.a && def.b, `${id} has both branches`);
    assert.notEqual(statsAt(id, 3, 'A').name, statsAt(id, 3, 'B').name, `${id} branches are named differently`);
    assert.notEqual(statsAt(id, 3, 'A').name, def.base.name, `${id} III-A has its own name`);
  }
});

test('tiers stack: tier II changes what it says, tier III keeps tier II changes', () => {
  assert.equal(statsAt('fire_bolt', 1).dmg?.n, 1);
  assert.equal(statsAt('fire_bolt', 2).dmg?.n, 2);
  assert.equal(statsAt('fire_bolt', 3, 'A').dmg?.n, 2, 'Inferno keeps the tier II dice');
  assert.equal(statsAt('fire_bolt', 3, 'B').chain, 1);
  assert.equal(statsAt('fireball', 3, 'A').slots, 2, 'Meteor costs 2 slots');
  assert.equal(skillTitle({ id: 'fire_bolt', tier: 2 }), 'Fire Bolt II');
  assert.equal(skillTitle({ id: 'fire_bolt', tier: 3, branch: 'A' }), 'Inferno');
  assert.equal(skillTitle({ id: 'longsword', tier: 1 }), 'Longsword');
});

test('descriptions are generated for every skill at every tier without gaps', () => {
  const w = hero('wizard');
  for (const id of SKILL_IDS) {
    const tiers: [1 | 2 | 3, 'A' | 'B' | undefined][] = SKILLS[id].t2 ? [[1, undefined], [2, undefined], [3, 'A'], [3, 'B']] : [[1, undefined]];
    for (const [tier, branch] of tiers) {
      for (const text of [describeSkill(id, tier, branch), describeSkill(id, tier, branch, w)]) {
        assert.ok(text.length > 10, `${id} ${tier}${branch ?? ''} has text`);
        assert.ok(!/undefined|NaN|\[object/.test(text), `${id} ${tier}${branch ?? ''}: ${text}`);
      }
    }
  }
});

test('hotbar order: basic attacks, cantrips, spells, then Shove and the potion', () => {
  const r = hero('rogue');
  assert.deepEqual(hotbar(r), ['rapier', 'shortbow', 'cunning_dash', 'shadow_step', 'shove', 'potion']);
});

test('block reasons: cooldowns, slots, action economy, out of combat', () => {
  const w = hero('wizard');
  assert.equal(skillBlockReason(w, 'fire_bolt', true, turn(), true), null);
  w.skills.find((s) => s.id === 'fire_bolt')!.cd = 2;
  assert.match(skillBlockReason(w, 'fire_bolt', true, turn(), true) ?? '', /Ready in 2/);
  w.slots = 0;
  assert.match(skillBlockReason(w, 'magic_missile', true, turn(), true) ?? '', /Spell slots/);
  assert.match(skillBlockReason(w, 'dagger', true, { ...turn(), actionUsed: true }, true) ?? '', /Action already used/);
  assert.match(skillBlockReason(w, 'dagger', true, turn(), false) ?? '', /Not your turn/);
  assert.match(skillBlockReason(w, 'dagger', false, null, false) ?? '', /Only in combat/);
  assert.match(skillBlockReason(w, 'fireball', true, turn(), true) ?? '', /know/);
  const c = hero('cleric');
  assert.equal(skillBlockReason(c, 'healing_word', false, null, false), null, 'heal spells work between fights');
  assert.equal(skillBlockReason(c, 'potion', false, null, false), null);
});

test('resolveAim: range, line of sight, areas, chains and allies', () => {
  const w = hero('wizard', 2, 3);
  const g1 = goblin('g1', 8, 3);
  const g2 = goblin('g2', 9, 4);
  const g3 = goblin('g3', 10, 1);
  const ctx = { map, entities: [w, g1, g2, g3], inCombat: true };

  const bolt = resolveAim(statsAt('fire_bolt'), w, 'g1', ctx);
  assert.ok(typeof bolt === 'object' && bolt.foes.length === 1);
  assert.match(resolveAim(statsAt('dagger'), w, 'g1', ctx) as string, /Out of range/);
  assert.match(resolveAim(statsAt('fire_bolt'), w, w.id, ctx) as string, /enemy/);

  const split = resolveAim(statsAt('fire_bolt', 3, 'B'), w, 'g1', ctx);
  assert.ok(typeof split === 'object');
  assert.deepEqual(split.foes.map((f) => f.id), ['g1', 'g2'], 'Splitting Bolt jumps to the nearest other goblin');

  const ball = resolveAim(statsAt('fireball'), w, { x: 9, y: 3 }, ctx);
  assert.ok(typeof ball === 'object');
  assert.deepEqual(ball.foes.map((f) => f.id).sort(), ['g1', 'g2']);
  assert.match(resolveAim(statsAt('fireball'), w, { x: 0, y: 0 }, ctx) as string, /open spot|room/);

  const c = hero('cleric', 3, 3);
  const far = hero('fighter', 10, 6);
  const near = hero('rogue', 4, 4);
  const party = { map, entities: [c, far, near], inCombat: true };
  const mass = resolveAim(statsAt('bless'), c, null, party);
  assert.ok(typeof mass === 'object');
  assert.deepEqual(mass.friends.map((f) => f.id).sort(), [c.id, near.id].sort(), 'Bless reaches allies within 3');
  const between = resolveAim(statsAt('healing_word'), c, far.id, { ...party, inCombat: false });
  assert.ok(typeof between === 'object', 'range is ignored between fights');
});
