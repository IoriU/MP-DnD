import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advantageText, attackAdvantage, canReact, dirTo, isBehind, isFlanking, netAdvantage, turnsToFace } from '../shared/tactics.ts';
import type { Entity, MonsterEntity, PlayerEntity, Pos } from '../shared/types.ts';

const goblin = (x: number, y: number, facing: Pos, extra: Partial<MonsterEntity> = {}): MonsterEntity => ({
  id: `g${x}${y}`, kind: 'monster', type: 'goblin', name: 'Goblin', glyph: '', x, y, hp: 7, maxHp: 7, ac: 15, speed: 6,
  statuses: [], boss: false, elite: false, dmgBy: {}, facing, ...extra,
});

const hero = (id: string, x: number, y: number, extra: Partial<PlayerEntity> = {}) =>
  ({ id, kind: 'player', x, y, statuses: [], facing: { x: 1, y: 0 }, downed: false, dead: false, ...extra }) as PlayerEntity;

test('dirTo gives the 8-way step toward a tile', () => {
  assert.deepEqual(dirTo({ x: 2, y: 2 }, { x: 7, y: 0 }), { x: 1, y: -1 });
  assert.deepEqual(dirTo({ x: 2, y: 2 }, { x: 2, y: 2 }), { x: 0, y: 0 });
});

test('the rear arc is the three tiles behind, whichever way it faces', () => {
  const east = goblin(5, 5, { x: 1, y: 0 });
  const behind = [{ x: 4, y: 5 }, { x: 4, y: 4 }, { x: 4, y: 6 }];
  const notBehind = [{ x: 6, y: 5 }, { x: 6, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 6 }, { x: 6, y: 6 }];
  for (const p of behind) assert.ok(isBehind(east, p), `(${p.x},${p.y}) is behind an east-facing goblin`);
  for (const p of notBehind) assert.ok(!isBehind(east, p), `(${p.x},${p.y}) is not behind it`);
  const northEast = goblin(5, 5, { x: 1, y: -1 });
  const behindNE = [{ x: 4, y: 6 }, { x: 4, y: 5 }, { x: 5, y: 6 }];
  for (const p of behindNE) assert.ok(isBehind(northEast, p), `(${p.x},${p.y}) is behind a north-east-facing goblin`);
  assert.ok(!isBehind(northEast, { x: 4, y: 4 }), 'its left side is not behind it');
  assert.ok(isBehind(east, { x: 0, y: 6 }), 'a long shot from behind counts too');
});

test('flanking needs a friend on the tile directly across, standing, and only in melee', () => {
  const g = goblin(5, 5, { x: -1, y: 0 });
  const rogue = hero('r', 6, 5);
  const fighter = hero('f', 4, 5);
  assert.ok(isFlanking(rogue, g, [rogue, fighter, g]));
  assert.ok(!isFlanking(hero('r2', 6, 4), g, [fighter, g]), 'not directly across');
  assert.ok(!isFlanking(rogue, g, [rogue, hero('f', 4, 5, { downed: true }), g]), 'a downed friend does not count');
  assert.ok(!isFlanking(hero('archer', 8, 5), g, [fighter, g]), 'not from range');
  const g2 = goblin(4, 5, { x: 1, y: 0 });
  const wizard = hero('w', 5, 5);
  const g3 = goblin(6, 5, { x: -1, y: 0 });
  assert.ok(isFlanking(g2, wizard, [g2, g3, wizard]), 'monsters flank heroes too');
});

test('stepping next to an enemy makes it turn to face you, unless you are hidden or it is caught off guard', () => {
  const g = goblin(5, 5, { x: 1, y: 0 });
  const rogue = hero('r', 3, 5);
  assert.ok(turnsToFace(g, rogue, { x: 4, y: 5 }), 'walking up behind it: it turns around');
  assert.ok(!turnsToFace(g, rogue, { x: 3, y: 5 }), 'two tiles away: it does not notice');
  assert.ok(!turnsToFace(g, hero('r', 3, 5, { statuses: [{ id: 'hidden', turns: 2 }] }), { x: 4, y: 5 }), 'hidden: it does not');
  assert.ok(!turnsToFace(goblin(5, 5, { x: 1, y: 0 }, { statuses: [{ id: 'surprised', turns: 1 }] }), rogue, { x: 4, y: 5 }), 'surprised: it cannot react');
  assert.ok(!turnsToFace(hero('f', 5, 6), rogue, { x: 4, y: 5 }), 'friends do not turn');
  assert.ok(canReact(g) && !canReact(goblin(1, 1, { x: 1, y: 0 }, { statuses: [{ id: 'stunned', turns: 1 }] })));
});

test('attackAdvantage lists every reason, and advantage and disadvantage cancel', () => {
  const g = goblin(5, 5, { x: -1, y: 0 });
  const rogue = hero('r', 6, 5);
  const fighter = hero('f', 4, 5);
  const all: Entity[] = [rogue, fighter, g];
  const a = attackAdvantage(rogue, g, all);
  assert.deepEqual(a.adv.sort(), ['flanking', 'from behind']);
  assert.equal(netAdvantage(a), 1);
  assert.match(advantageText(a), /^advantage \((flanking, from behind|from behind, flanking)\)$/);
  const blind = attackAdvantage(hero('r', 6, 5, { statuses: [{ id: 'blinded', turns: 1 }] }), g, all);
  assert.equal(netAdvantage(blind), 0, 'blinded cancels it');
  const plain = attackAdvantage(hero('w', 3, 5), g, [g]);
  assert.equal(netAdvantage(plain), 0);
  assert.equal(advantageText(plain), '');
  const hidden = attackAdvantage(hero('w', 2, 5, { statuses: [{ id: 'hidden', turns: 2 }] }), g, [g]);
  assert.deepEqual(hidden.adv, ['hidden']);
});
