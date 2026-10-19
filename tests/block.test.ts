import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { nextHeroIntent, type HeroView } from '../server/heroai.ts';
import { startingSkills } from '../server/progression.ts';
import { describeStats } from '../shared/items.ts';
import { MONSTERS } from '../shared/rules.ts';
import { blockOf, describeSkill, skillBlockReason, statsAt } from '../shared/skills.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, PlayerInfo, TurnState } from '../shared/types.ts';

// 🧱 Block (decided 2026-10-19, Slay the Spire style): skills, gear and shields put up Block; it soaks damage before
// temporary HP and runs out at the start of the turn of whoever gave it. Rules run through the real Game class (private
// members reached with `any`, as in tests/classes.test.ts); the hero AI on a hand-made board.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-block-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const own = (id: OwnedSkill['id'], tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B'): OwnedSkill => ({ id, tier, branch, cd: 0 });

/** Dice that all land in the middle (Math.random 0.5): a d6 shows 4. */
function middle<T>(fn: () => T): T {
  const real = Math.random;
  Math.random = () => 0.5;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

function battle(classes: ClassId[] = ['fighter', 'paladin', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'BLOCK');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  Object.assign(g, { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 4, y: 2 + i }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, movesLeft: 6, ap: 0 };
  p.turnOwner = heroes[0].id;
  p.runMonster = async () => {};
  const foe = (type: string, x: number, y: number, hp = 100): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    Object.assign(m, { traits: undefined, ward: 0, atkBonus: 0, dmgBonus: 0, hp, maxHp: hp });
    p.turn.order.push(m.id);
    return m;
  };
  foe('rat', 10, 6); // someone is always standing, so the fight does not end
  return { g, p, heroes, foe };
}

function startTurn(p: any, e: Entity) {
  p.turn.index = p.turn.order.indexOf(e.id);
  p.turnOwner = e.id;
  p.beginTurn();
}

// ---------------------------------------------------------------- data

test('Block sources: Brace for everyone, Fighter and Paladin skills, gear, shield-carrying monsters', () => {
  assert.deepEqual(statsAt('brace').block, { n: 1, d: 6 });
  assert.equal(statsAt('brace').ap, 1);
  assert.match(describeSkill('brace'), /You get 1d6 🧱 Block until your next turn\. Once per turn\./);
  assert.match(describeSkill('bulwark'), /2d4 \+ level 🧱 Block until your next turn/);
  assert.ok(statsAt('shield_bash', 3, 'B').selfBlock, 'Bulwark Bash');
  assert.ok(statsAt('battle_cry', 3, 'B').selfBlock, 'Iron Wall');
  assert.match(describeStats({ block: 2 }), /🧱 2 Block at the start of each of your turns/);
  for (const id of ['skeleton', 'hobgoblin', 'bone_knight', 'sellsword']) assert.ok((MONSTERS[id].block ?? 0) > 0, id);
});

// ---------------------------------------------------------------- the rules

test('Block soaks damage before temporary HP, then the rest comes off HP', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.tempHp = 3;
  ann.block = { [ann.id]: 4 };
  const hp = ann.hp;
  p.damage(ann, 5);
  assert.equal(blockOf(ann), 0);
  assert.equal(ann.block, undefined, 'used up');
  assert.equal(ann.tempHp, 2);
  assert.equal(ann.hp, hp);
  p.damage(ann, 4);
  assert.equal(ann.tempHp, 0);
  assert.equal(ann.hp, hp - 2);
});

test('Brace: 1d6 Block until your next turn, once per turn', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  startTurn(p, ann);
  assert.equal(middle(() => p.handleSkill(ann.playerId, 'brace')), true);
  assert.equal(blockOf(ann), 4);
  assert.equal(p.turn.ap, 2);
  assert.equal(skillBlockReason(ann, 'brace', true, p.turn, true), 'Only once per turn');
  startTurn(p, heroes[1]); // other turns come and go: it holds
  assert.equal(blockOf(ann), 4);
  startTurn(p, ann);
  assert.equal(blockOf(ann), 0, 'gone at the start of your next turn');
  assert.equal(skillBlockReason(ann, 'brace', true, p.turn, true), null, 'and Brace is ready again');
});

test("a Paladin's Bulwark on a friend lasts until the Paladin's next turn, not the friend's", () => {
  const { p, heroes } = battle();
  const [ann, bob] = heroes;
  bob.skills.push(own('bulwark'));
  startTurn(p, bob);
  assert.equal(middle(() => p.handleSkill(bob.playerId, 'bulwark', ann.id)), true);
  assert.equal(blockOf(ann), 3 + 3 + bob.level, '2d4 (3 and 3) + level');
  startTurn(p, ann);
  assert.ok(blockOf(ann) > 0, "the friend's own turn doesn't end it");
  startTurn(p, bob);
  assert.equal(blockOf(ann), 0);
});

test('gear Block comes back at the start of each of your turns (it does not pile up)', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.gear.trinket = 'buckler';
  startTurn(p, ann);
  assert.equal(blockOf(ann), 2);
  p.damage(ann, 1);
  assert.equal(blockOf(ann), 1);
  startTurn(p, ann);
  assert.equal(blockOf(ann), 2);
  startTurn(p, ann);
  assert.equal(blockOf(ann), 2, 'not 4');
});

test("a Skeleton's shield: Block at the start of each of its turns", () => {
  const { p, foe } = battle();
  const bones = foe('skeleton', 6, 3, 13);
  startTurn(p, bones);
  assert.equal(blockOf(bones), MONSTERS.skeleton.block);
  p.damage(bones, 5);
  assert.equal(bones.hp, 13 - (5 - MONSTERS.skeleton.block!));
});

test('going down, a new fight, or the giver leaving the fight clears Block', () => {
  const { p, heroes } = battle();
  const [ann, bob] = heroes;
  ann.block = { [bob.id]: 5 };
  p.removeFromOrder(bob.id);
  assert.equal(blockOf(ann), 0, 'nobody left whose turn would end it');
  ann.block = { [ann.id]: 50 };
  ann.hp = 1;
  p.damage(ann, 60);
  assert.ok(ann.downed);
  assert.equal(ann.block, undefined);
  bob.block = { [bob.id]: 3 };
  p.prepareForFight(bob);
  assert.equal(bob.block, undefined);
});

// ---------------------------------------------------------------- the hero AI

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[], turn: TurnState): HeroView {
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  const all = [...heroes, ...monsters];
  return {
    map: { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} }, hero: h, heroes, monsters, turn,
    occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)),
  };
}
const turn = (ap: number): TurnState => ({ order: [], init: {}, index: 0, round: 1, movesLeft: 0, ap });

test("a Paladin with 1 AP left Bulwarks the hurt friend an ogre is about to hit, not a healthy one out of reach", () => {
  const { heroes, foe } = battle();
  const [ann, bob, cid] = heroes;
  bob.skills = [...startingSkills('paladin'), own('bulwark')];
  Object.assign(ann, { x: 4, y: 2, hp: Math.ceil(ann.maxHp / 2) });
  Object.assign(bob, { x: 4, y: 3 });
  Object.assign(cid, { x: 3, y: 4 });
  const ogre = foe('ogre', 5, 1);
  const intent = nextHeroIntent(view(bob, heroes, [ogre], turn(1)));
  assert.deepEqual(intent, { kind: 'act', skill: 'bulwark', target: ann.id });
});

test('a bot counts Block: it hits the goblin, not the 4-HP skeleton whose Block would soak the whole swing', () => {
  const { heroes, foe } = battle(['fighter']);
  const [ann] = heroes;
  ann.skills = startingSkills('fighter');
  Object.assign(ann, { x: 4, y: 3 });
  const bones = foe('skeleton', 5, 3, 4);
  const gob = foe('goblin', 3, 3, 12);
  bones.block = { [bones.id]: 12 }; // no hit gets through this turn (without it, the skeleton is the easy kill)
  const intent = nextHeroIntent(view(ann, heroes, [bones, gob], turn(2)));
  assert.ok(intent.kind === 'act' && intent.target === gob.id, JSON.stringify(intent));
});
