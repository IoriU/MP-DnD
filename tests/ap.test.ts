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
import { rng } from '../server/rng.ts';
import { AP_GAIN, AP_MAX, ATTACK_AP } from '../shared/rules.ts';
import { DASH_TILES, SKILLS, SKILL_IDS, describeSkill, skillBlockReason, statsAt, statsOf } from '../shared/skills.ts';
import type { ClassId, Entity, MonsterEntity, OwnedSkill, PlayerEntity, PlayerInfo, TurnView } from '../shared/types.ts';

/** The acting creature's share of the turn (movement and AP left); the tests start one creature's turn at a time. */
const mine = (p: any) => p.turn.acts[p.turn.group[0]];

// Action points (decided 2026-10-19): 3 AP a turn, unspent AP carries over (a turn starts with at most 5), bonus actions
// became 1-AP skills, actions and basic attacks 2, the biggest spells 3. Rules run through the real Game class (private
// members reached with `any`, as in tests/classes.test.ts); the hero AI on a hand-made board.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-ap-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

const own = (id: OwnedSkill['id'], tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B'): OwnedSkill => ({ id, tier, branch, cd: 0 });

/** Dice that show these numbers (Math.random values), the way tests/classes.test.ts does it. */
function dice<T>(rolls: number[], fn: () => T): T {
  const real = { random: Math.random, next: rng.next };
  const queue = [...rolls];
  Math.random = () => queue.shift() ?? 0.5;
  rng.next = () => 0.99;
  try {
    return fn();
  } finally {
    Math.random = real.random;
    rng.next = real.next;
  }
}
const showing = (n: number, sides = 20) => (n - 0.5) / sides;

/** Heroes in a small walled room, in combat, with a sturdy goblin next to the first one. */
function battle(classes: ClassId[] = ['fighter', 'cleric']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'APTEST');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  Object.assign(g, { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 4, y: 3 + i }));
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, group: [heroes[0].id], acts: { [heroes[0].id]: { moves: 6, ap: 0 } } };
  p.runMonster = async () => {}; // the tests drive the rules themselves
  const foe = (type: string, x: number, y: number, hp = 100): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    Object.assign(m, { traits: undefined, ward: 0, atkBonus: 0, dmgBonus: 0, hp, maxHp: Math.max(hp, 2) });
    p.turn.order.push(m.id);
    return m;
  };
  const goblin = foe('goblin', 5, 3);
  return { g, p, heroes, goblin, foe };
}

/** Starts this creature's turn the way advanceTurn would. */
function startTurn(p: any, e: Entity) {
  p.turn.index = p.turn.order.indexOf(e.id);
  p.beginTurn([e.id]);
}

// ---------------------------------------------------------------- the skill data

test('every skill costs 0 to 3 AP: passives 0, basic attacks 2, and the biggest spells 3', () => {
  for (const id of SKILL_IDS) {
    const def = SKILLS[id];
    for (const [tier, branch] of [[1], [2], [3, 'A'], [3, 'B']] as const) {
      const s = statsAt(id, tier, branch);
      assert.ok(Number.isInteger(s.ap) && s.ap >= 0 && s.ap <= 3, `${id}: ${s.ap} AP`);
      if (def.kind === 'passive') assert.equal(s.ap, 0, `${id} is a passive`);
    }
    if (def.kind === 'basic') assert.equal(def.base.ap, id === 'quick_stab' ? 1 : ATTACK_AP, `${id}: a basic attack (the Skirmisher's Quick Stab is the 1-AP one)`);
  }
  for (const id of ['fireball', 'earth_splitter', 'shatter', 'hail_of_thorns', 'guiding_bolt', 'brutal_strike', 'heroic_anthem'] as const) {
    assert.equal(SKILLS[id].base.ap, 3, id);
  }
  assert.equal(statsAt('dash').ap, 1);
  assert.equal(statsAt('dash').dash, DASH_TILES);
  assert.equal(statsAt('action_surge', 3, 'A').ap, 0, 'Battle Surge is free');
  assert.equal(statsAt('grease', 3, 'A').ap, 1, 'Quick Grease');
  assert.match(describeSkill('fireball'), /\n3 AP · 🔮 1 slot$/);
  assert.match(describeSkill('cut_free'), /\n1 AP$/);
  assert.match(describeSkill('action_surge'), /\+2 AP this turn/);
});

// ---------------------------------------------------------------- the rules in the Game class

test('a turn starts with 3 AP; AP left over carries into the next turn, which starts with at most 5', () => {
  const { p, heroes, goblin } = battle();
  const [ann] = heroes;
  startTurn(p, ann);
  assert.equal(mine(p).ap, AP_GAIN);
  assert.equal(dice([showing(15), showing(15), 0.5], () => p.handleSkill(ann.playerId, 'longsword', goblin.id)), true);
  assert.equal(mine(p).ap, AP_GAIN - ATTACK_AP);
  assert.match(skillBlockReason(ann, 'longsword', true, mine(p), true) ?? '', /Needs 2 AP \(1 left\)/);
  assert.equal(p.handleSkill(ann.playerId, 'longsword', goblin.id), false, 'no AP for a second swing');
  p.endOfTurn(ann);
  assert.equal(ann.savedAp, 1);
  startTurn(p, ann);
  assert.equal(mine(p).ap, 4, '1 saved + 3');
  p.endOfTurn(ann); // saves all 4
  startTurn(p, ann);
  assert.equal(mine(p).ap, AP_MAX, '4 saved + 3, capped at 5');
  for (let i = 0; i < 2; i++) assert.equal(dice([showing(15), showing(15), 0.5], () => p.handleSkill(ann.playerId, 'longsword', goblin.id)), true);
  assert.equal(mine(p).ap, 1, 'two swings in one turn');
});

test('the 3-AP spells need all of a fresh turn; Dash costs 1 AP for 3 more tiles', () => {
  const { p, heroes } = battle(['wizard', 'cleric']);
  const [ann] = heroes;
  ann.skills.push(own('fireball'));
  startTurn(p, ann);
  assert.equal(skillBlockReason(ann, 'fireball', true, { ...p.turn, ap: 2 } as TurnView, true), 'Needs 3 AP (2 left)');
  assert.equal(skillBlockReason(ann, 'fireball', true, mine(p), true), null);
  const moves = mine(p).moves;
  assert.equal(p.handleSkill(ann.playerId, 'dash'), true);
  assert.equal(mine(p).moves, moves + DASH_TILES);
  assert.equal(mine(p).ap, 2);
  assert.equal(p.handleSkill(ann.playerId, 'fireball', { x: 8, y: 6 }), false, 'no longer 3 AP');
});

test('Action Surge gives 2 AP back, once per turn (Battle Surge costs nothing)', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.skills.push(own('action_surge'));
  ann.slots = ann.maxSlots = 3;
  startTurn(p, ann);
  assert.equal(p.handleSkill(ann.playerId, 'action_surge'), true);
  assert.equal(mine(p).ap, AP_GAIN - 1 + 2);
  assert.equal(skillBlockReason(ann, 'action_surge', true, mine(p), true), 'Only once per turn');
  ann.skills = ann.skills.map((o) => (o.id === 'action_surge' ? own('action_surge', 3, 'A') : o));
  startTurn(p, ann);
  const before = mine(p).ap;
  assert.equal(p.handleSkill(ann.playerId, 'action_surge'), true);
  assert.equal(mine(p).ap, before + 2);
});

test('Executioner: a killing blow gives 2 AP back, once per turn', () => {
  const { p, heroes, foe } = battle(['rogue', 'fighter']);
  const [ann] = heroes;
  ann.skills.push(own('opportunist', 3, 'A'));
  const weak = foe('goblin', 4, 2, 1);
  const weak2 = foe('goblin', 3, 2, 1);
  startTurn(p, ann);
  assert.equal(dice([showing(15), showing(15), 0.5, 0.5], () => p.handleSkill(ann.playerId, 'rapier', weak.id)), true);
  assert.equal(weak.hp, 0);
  assert.equal(mine(p).ap, AP_GAIN - ATTACK_AP + 2);
  assert.equal(dice([showing(15), showing(15), 0.5, 0.5], () => p.handleSkill(ann.playerId, 'rapier', weak2.id)), true);
  assert.equal(mine(p).ap, AP_GAIN - 2 * ATTACK_AP + 2, 'only once per turn');
});

test('a lost turn (stunned) gains no AP but keeps what was saved; a fight starts from scratch', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.savedAp = 2;
  ann.statuses.push({ id: 'stunned', turns: 2 });
  startTurn(p, ann);
  assert.equal(mine(p).ap, 0);
  assert.equal(skillBlockReason(ann, 'shove', true, mine(p), true), 'You are stunned');
  p.endOfTurn(ann);
  assert.equal(ann.savedAp, 2, 'the savings are still there');
  ann.statuses = [];
  startTurn(p, ann);
  assert.equal(mine(p).ap, AP_MAX);
  p.endOfTurn(ann);
  p.prepareForFight(ann);
  assert.equal(ann.savedAp, 0, 'AP never carries from one fight into the next');
});

test('going down costs the AP saved up, even mid-turn', () => {
  const { p, heroes } = battle();
  const [ann] = heroes;
  ann.savedAp = 2;
  ann.hp = 1;
  p.damage(ann, 50);
  assert.ok(ann.downed);
  assert.equal(ann.savedAp, 0);
  const [, bob] = heroes;
  startTurn(p, bob);
  bob.hp = 1;
  p.damage(bob, 50); // walks into the fire on their own turn, with 3 AP unspent
  p.endOfTurn(bob);
  assert.equal(bob.savedAp, 0);
});

// ---------------------------------------------------------------- the hero AI

function view(h: PlayerEntity, heroes: PlayerEntity[], monsters: MonsterEntity[], turn: TurnView): HeroView {
  const tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  const all = [...heroes, ...monsters];
  return {
    map: { width: 12, height: 8, tiles, ground: {}, clouds: {}, props: {} }, hero: h, heroes, monsters, turn,
    occupied: (x, y, exceptId) => all.some((e) => e.x === x && e.y === y && e.id !== exceptId && !(e.kind === 'player' && e.dead)),
  };
}

test('a bot with 5 AP next to a monster swings twice, and keeps going until the AP is spent or not worth it', () => {
  const { heroes, goblin } = battle();
  const [ann] = heroes;
  Object.assign(ann, { skills: startingSkills('fighter') });
  const turn: TurnView = { order: [], init: {}, index: 0, round: 1, group: [], acts: {}, movesLeft: 0, ap: AP_MAX };
  const used: string[] = [];
  for (let i = 0; i < 6; i++) {
    const intent = nextHeroIntent(view(ann, heroes, [goblin], turn));
    if (intent.kind !== 'act') break;
    used.push(intent.skill);
    const own = ann.skills.find((o) => o.id === intent.skill);
    const s = own ? statsOf(own) : statsAt(intent.skill);
    assert.ok(s.ap <= turn.ap, `${intent.skill} fits the AP left`);
    turn.ap -= s.ap;
    if (own && SKILLS[own.id].kind === 'cantrip') own.cd = (s.cooldown ?? 0) + 1;
    if (SKILLS[intent.skill].kind === 'spell') ann.slots--;
  }
  assert.equal(used.filter((id) => id === 'longsword').length, 2, used.join());
  assert.ok(turn.ap <= 1, `${turn.ap} AP left: ${used.join()}`);
});
