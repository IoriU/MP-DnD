import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { ACTS, BOSS, BOSS_SIGNATURES, MONSTERS } from '../shared/rules.ts';
import { stacksOf } from '../shared/skills.ts';
import type { ClassId, MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// Bosses are a race (decided 2026-10-20, BOSS and BOSS_SIGNATURES in shared/rules.ts): when the boss falls, the rest flee
// and the fight is won, and each act boss has its own signature that punishes a slow fight: the Goblin King's War Horn
// (more goblins every 3rd round), the Bone Knight's Rise Again (fallen minions get back up), the Dread Wyrm's Wrath (a
// Fury stack every round: +1 to hit, +10% damage). Rules run through the real Game class (private members reached with
// `any`, as in tests/revive.test.ts); dice are fixed by stubbing Math.random.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-boss-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** Dice that show these Math.random values in turn (then 0.5, a middle roll). */
function dice<T>(rolls: number[], fn: () => T): T {
  const real = Math.random;
  const queue = [...rolls];
  Math.random = () => queue.shift() ?? 0.5;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/** Three heroes in a 14x10 walled room, in combat in act `act`, and that act's boss (plus a minion) across the room. */
function bossFight(act = 1, classes: ClassId[] = ['fighter', 'cleric', 'wizard']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'BOSSES');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  const tiles = ['#'.repeat(14), ...Array.from({ length: 8 }, () => `#${'.'.repeat(12)}#`), '#'.repeat(14)].join('');
  Object.assign(g, { width: 14, height: 10, tiles, ground: {}, clouds: {}, props: {} });
  heroes.forEach((h, i) => Object.assign(h, { x: 2, y: 3 + i }));
  p.entities = [...heroes];
  p.run = { act, maxAct: 3, actName: ACTS[act - 1].name, map: generateActMap(act, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  p.phase = 'combat';
  p.roomKind = 'boss';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, group: [heroes[0].id], acts: { [heroes[0].id]: { moves: 6, ap: 0 } } };
  p.runMonster = async () => {};
  const spawn = (type: string, x: number, y: number): MonsterEntity => {
    p.spawnMonster(type, { x, y }, heroes.length);
    const m = p.entities.at(-1) as MonsterEntity;
    p.turn.order.push(m.id);
    return m;
  };
  const boss = spawn(ACTS[act - 1].boss, 11, 4);
  const minion = spawn(ACTS[act - 1].minions[0], 11, 6);
  return { g, p, heroes, boss, minion, spawn };
}
const logged = (p: any, re: RegExp) => p.log.some((l: { text: string }) => re.test(l.text));
const foes = (p: any) => (p.entities as MonsterEntity[]).filter((e) => e.kind === 'monster' && !e.ally);
const clockAt = (p: any, boss: MonsterEntity, round: number) => {
  p.turn.round = round;
  p.bossClock(boss);
};

test('the data: every act boss has its own signature, and none repeats', () => {
  const sigs = ACTS.map((a) => MONSTERS[a.boss].signature);
  assert.deepEqual(sigs, ['horn', 'rise', 'wrath']);
  for (const s of sigs) assert.ok(BOSS_SIGNATURES[s!].desc.length > 20);
  assert.ok(BOSS.furyFrom >= 2 && BOSS.callEvery >= 2 && BOSS.riseAfter >= 1 && BOSS.furyAtk > 0 && BOSS.furyDmg > 0 && BOSS.callPerHero > 0);
});

// ---------------------------------------------------------------- Wrath: the Dread Wyrm

test(`Wrath: no Fury before round ${BOSS.furyFrom}, then one stack a round, catching up after a lost turn`, () => {
  const { p, boss } = bossFight(3);
  for (const [round, want] of [[1, 0], [BOSS.furyFrom - 1, 0], [BOSS.furyFrom, 1], [BOSS.furyFrom + 1, 2], [BOSS.furyFrom + 4, 5]]) {
    clockAt(p, boss, round);
    assert.equal(stacksOf(boss, 'fury'), want, `round ${round}`);
  }
  assert.ok(logged(p, /grows furious: \+1 to hit and \+10% damage/), 'the first stack explains itself');
  assert.ok(logged(p, /fury grows \(5\)/));
});

test('only the Wyrm has Wrath, and only the Goblin King calls reinforcements', () => {
  for (const act of [1, 2]) {
    const { p, boss } = bossFight(act);
    clockAt(p, boss, 9);
    assert.equal(stacksOf(boss, 'fury'), 0, `act ${act}: no Fury`);
  }
  for (const act of [2, 3]) {
    const { p, boss } = bossFight(act);
    clockAt(p, boss, BOSS.callEvery);
    assert.equal(foes(p).length, 2, `act ${act}: no war horn`);
  }
});

test('Fury makes the boss hit more often and harder: +1 to hit and +10% of its average hit per stack', () => {
  const { p, heroes, boss } = bossFight(3);
  const ann = heroes[0];
  Object.assign(ann, { x: 10, y: 4, hp: 900, maxHp: 900 });
  const def = MONSTERS[boss.type];
  const avg = (def.dmg.n * (def.dmg.d + 1)) / 2 + (def.dmg.bonus ?? 0) + (boss.dmgBonus ?? 0);
  const swing = () => {
    const before = ann.hp;
    dice([0.5, 0.5, 0.5, 0.5], () => p.monsterAttack(boss, ann)); // an 11 to hit, middle damage dice
    return before - ann.hp;
  };
  const calm = swing();
  boss.statuses.push({ id: 'fury', turns: 99, power: 3 });
  const furious = swing();
  assert.equal(furious - calm, Math.round(avg * BOSS.furyDmg * 3), 'three stacks: +30% of its average hit');
  const lines = p.log.map((l: { text: string }) => l.text).filter((t: string) => t.startsWith(`${boss.name} `) && t.includes('🎲11+'));
  const bonus = (t: string) => Number(/🎲11\+(\d+)=/.exec(t)?.[1]);
  assert.equal(bonus(lines.at(-1)) - bonus(lines.at(-2)), 3, 'and +3 to hit');
});

test("the Dread Wyrm's breath grows with the act and its fury (it was a flat 3d6 all game)", () => {
  const { p, heroes, boss } = bossFight(3);
  const cid = heroes[2];
  Object.assign(cid, { x: 10, y: 4, hp: 900, maxHp: 900 });
  const breathe = () => {
    const before = cid.hp;
    dice([0, 0.5, 0.5, 0.5], () => p.breathWeapon(boss, [cid])); // a failed DEX save (a 1), then 3d6 of middle rolls
    return before - cid.hp;
  };
  const calm = breathe();
  assert.ok(calm >= 2 * 3 * 3.5 * 0.9, `act 3 breath: ${calm}`);
  boss.statuses.push({ id: 'fury', turns: 99, power: 5 });
  assert.ok(breathe() > calm, 'angrier, hotter');
});

// ---------------------------------------------------------------- War Horn: the Goblin King

test(`War Horn: every ${BOSS.callEvery} rounds the Goblin King calls its warband (one per two heroes, at least one), once a round`, () => {
  const { p, boss } = bossFight(1);
  clockAt(p, boss, BOSS.callEvery - 1);
  assert.equal(foes(p).length, 2, 'not yet');
  clockAt(p, boss, BOSS.callEvery);
  assert.equal(foes(p).length, 3, 'three heroes: one goblin');
  const called = foes(p).at(-1)!;
  assert.ok(ACTS[0].minions.includes(called.type), called.type);
  assert.ok(p.turn.order.includes(called.id), 'it joins the initiative order');
  assert.ok(logged(p, /Goblin King blows a war horn/));
  p.bossClock(boss);
  assert.equal(foes(p).length, 3, 'only once a round');
});

test('the War Horn never calls past a full room', () => {
  const { p, boss, spawn } = bossFight(1);
  for (let i = 0; i < 4; i++) spawn('goblin', 6 + i, 8); // 6 monsters: full
  clockAt(p, boss, BOSS.callEvery);
  assert.equal(foes(p).length, 6);
  assert.ok(!logged(p, /war horn/), 'no horn line when nobody came');
});

// ---------------------------------------------------------------- Rise Again: the Bone Knight

test(`Rise Again: a minion that falls gets back up ${BOSS.riseAfter} rounds later where it fell, and is worth no XP twice`, () => {
  const { p, heroes, boss, minion } = bossFight(2);
  const ann = heroes[0];
  p.turn.round = 2;
  const type = minion.type;
  minion.hp = 1;
  p.damage(minion, 10, ann);
  assert.equal(foes(p).length, 1, 'down');
  clockAt(p, boss, 2 + BOSS.riseAfter - 1);
  assert.equal(foes(p).length, 1, 'not yet');
  clockAt(p, boss, 2 + BOSS.riseAfter);
  const back = foes(p).find((m) => m !== boss)!;
  assert.ok(back, 'it rose');
  assert.deepEqual([back.type, back.x, back.y, back.risen, back.hp === back.maxHp], [type, 11, 6, true, true]);
  assert.ok(p.turn.order.includes(back.id));
  assert.ok(logged(p, /claws its way back up/));
  const xp = ann.xp;
  back.hp = 1;
  p.damage(back, 10, ann);
  assert.equal(ann.xp, xp, 'no XP for killing it again');
  clockAt(p, boss, 2 + 2 * BOSS.riseAfter + 1);
  assert.equal(foes(p).length, 2, 'and it keeps getting back up while the Knight stands');
});

test('Rise Again: once the Knight falls, the dead stay down and the rest flee', () => {
  const { p, heroes, boss, minion } = bossFight(2);
  p.turn.round = 2;
  minion.hp = 1;
  p.damage(minion, 10, heroes[0]);
  boss.hp = 1;
  p.damage(boss, 10, heroes[0]);
  assert.deepEqual(foes(p), []);
  assert.deepEqual(p.fallen, [], 'nobody is left to rise');
});

test('other bosses leave their dead down', () => {
  const { p, heroes, boss, minion } = bossFight(1);
  p.turn.round = 2;
  minion.hp = 1;
  p.damage(minion, 10, heroes[0]);
  clockAt(p, boss, 2 + BOSS.riseAfter);
  assert.equal(foes(p).length, 1);
});

// ---------------------------------------------------------------- every boss: when it falls, the rest flee

test('when the boss falls the rest flee: the fight is won, and they take no more hits (no kills, no XP)', () => {
  const { p, heroes, boss, minion } = bossFight();
  const ann = heroes[0];
  boss.hp = 1;
  p.damage(boss, 10, ann);
  assert.deepEqual(foes(p), [], 'the minion fled');
  assert.ok(!p.turn.order.includes(minion.id), 'and left the turn order');
  assert.ok(logged(p, new RegExp(`With ${boss.name} dead, the rest of them flee`)));
  const kills = ann.kills;
  p.damage(minion, 99, ann);
  assert.equal(ann.kills, kills, 'hitting a fled minion does nothing');
  p.checkEnd();
  assert.notEqual(p.phase, 'combat', 'the fight is over');
});

test('a regular monster falling does not end the fight', () => {
  const { p, heroes, minion } = bossFight(3);
  minion.hp = 1;
  p.damage(minion, 10, heroes[0]);
  assert.equal(foes(p).length, 1, 'the boss is still there');
});
