import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { getEvent } from '../server/events.ts';
import { Game } from '../server/game.ts';
import { autoLevelPick } from '../server/heroai.ts';
import { applyLevelUps, applyPick, dealOffer, raiseStat, recalcHero, startingSkills } from '../server/progression.ts';
import { makeRng } from '../server/rng.ts';
import { ACT_SCALING, CLASSES, CLASS_IDS, STATS, STAT_CAP, floorScaling, maxHpFor, maxSlotsFor, statMod, xpToNext } from '../shared/rules.ts';
import { SKILLS, attackBonus, heroDc, statsOf } from '../shared/skills.ts';
import type { ClassId, PlayerEntity, PlayerInfo } from '../shared/types.ts';

// The six D&D stats (playtest 1, 2026-10-21): every hero sees them, raises one every other level (any stat), and boons
// and gear add more. Every stat changes something: hit and damage, max HP (CON), AC in light armor (DEX), slots (INT),
// spells and heals (the casting stat), saves and event checks.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-stats-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

function hero(classId: ClassId, level = 1): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x: 0, y: 0,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], level, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [], elitePicks: 0, kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], facing: { x: 1, y: 0 },
  };
  recalcHero(p);
  return p;
}

test('every class has all six stats, a casting stat among them and an armor type; Bard and Paladin cast with CHA, Ranger with WIS', () => {
  for (const id of CLASS_IDS) {
    const c = CLASSES[id];
    assert.deepEqual(Object.keys(c.mods).sort(), [...STATS].sort(), id);
    for (const s of STATS) assert.ok(c.mods[s] >= -1 && c.mods[s] <= 3, `${id} ${s}`);
    assert.ok(STATS.includes(c.stat));
    assert.ok(c.armor === 'light' || c.armor === 'heavy');
  }
  assert.deepEqual([CLASSES.bard.stat, CLASSES.paladin.stat, CLASSES.ranger.stat], ['cha', 'cha', 'wis']);
});

test('a class starts exactly as before: no stat points, the same HP, AC and slots', () => {
  for (const id of CLASS_IDS) {
    const p = hero(id, 5);
    assert.equal(p.maxHp, maxHpFor(id, 5), id);
    assert.equal(p.ac, CLASSES[id].ac, id);
    assert.equal(p.maxSlots, maxSlotsFor(id, 5), id);
  }
});

test('CON: every point raised is +1 max HP per level, now and on every level after', () => {
  const p = hero('fighter', 4);
  const before = p.maxHp;
  assert.ok(raiseStat(p, 'con').ok);
  assert.equal(p.maxHp, before + 4);
  assert.equal(p.hp, p.maxHp, 'the new HP comes filled');
  p.xp = xpToNext(4);
  applyLevelUps(p);
  assert.equal(p.maxHp, maxHpFor('fighter', 5) + 5, 'level 5: +5 now');
});

test('DEX: raised DEX adds AC in light armor only, and initiative for everyone', () => {
  const rogue = hero('rogue');
  const fighter = hero('fighter');
  raiseStat(rogue, 'dex');
  raiseStat(fighter, 'dex');
  assert.equal(rogue.ac, CLASSES.rogue.ac + 1, 'light armor');
  assert.equal(fighter.ac, CLASSES.fighter.ac, 'heavy armor: no AC from DEX');
  assert.equal(statMod(fighter, 'dex'), CLASSES.fighter.mods.dex + 1);
});

test('INT: every 2 points raised are +1 max slot, for any class', () => {
  const b = hero('barbarian', 3);
  const base = b.maxSlots;
  raiseStat(b, 'int');
  assert.equal(b.maxSlots, base, 'one point: not yet');
  raiseStat(b, 'int');
  assert.equal(b.maxSlots, base + 1, 'two points: one more Fury');
});

test('the stat a skill uses adds to hit (and damage for weapons); the casting stat raises the save DC', () => {
  const f = hero('fighter');
  const sword = statsOf({ id: 'longsword', tier: 1 });
  const hit = attackBonus(f, sword);
  raiseStat(f, 'str');
  assert.equal(attackBonus(f, sword), hit + 1);
  const w = hero('wizard');
  const dc = heroDc(w);
  raiseStat(w, 'int');
  assert.equal(heroDc(w), dc + 1);
  assert.equal(SKILLS.longsword.base.stat, 'str');
});

test('a stat point every other level, put in any stat; a stat stops at +5, and the offer leaves it out then', () => {
  const p = hero('wizard');
  p.xp = xpToNext(1) + xpToNext(2) + xpToNext(3);
  assert.equal(applyLevelUps(p), 3);
  assert.equal(p.levelUps, 2, 'levels 2 and 4');
  dealOffer(p, makeRng(1), 1);
  assert.deepEqual(p.offer?.map((c) => c.kind === 'stat' && c.stat), [...STATS]);
  const cha = p.offer!.findIndex((c) => c.kind === 'stat' && c.stat === 'cha');
  const res = applyPick(p, { card: cha }, makeRng(1), 1);
  assert.ok(res.ok && /raises Charisma to \+1/.test(res.text), res.ok ? res.text : res.error);
  assert.equal(p.levelUps, 1);
  // INT starts at +3: two more points take it to the cap.
  p.statUps = { int: STAT_CAP - CLASSES.wizard.mods.int };
  assert.equal(raiseStat(p, 'int').ok, false);
  dealOffer(p, makeRng(1), 1);
  assert.ok(!p.offer?.some((c) => c.kind === 'stat' && c.stat === 'int'), 'INT at +5 is not offered');
});

test('stat boons are stat points from the spoils; gear adds on top, even past +5', () => {
  const p = hero('paladin');
  p.offer = [{ kind: 'boon', boon: 'cha' }];
  p.offerKind = 'reward';
  p.rewardPicks = 1;
  assert.ok(applyPick(p, { card: 0 }, makeRng(1), 1).ok);
  assert.equal(statMod(p, 'cha'), CLASSES.paladin.mods.cha + 1);
  p.statUps = { ...p.statUps, str: STAT_CAP - CLASSES.paladin.mods.str };
  p.gear = { trinket: 'giant_belt' };
  assert.equal(statMod(p, 'str'), STAT_CAP + 1, 'the Belt of Giant Strength goes past the cap');
  p.gear = { trinket: 'fortitude_stone' };
  recalcHero(p);
  assert.equal(p.maxHp, maxHpFor('paladin', 1) + 1, 'a CON item is +1 HP per level like a point');
});

test('bots raise their casting stat or weapon stat first, then CON', () => {
  for (const id of CLASS_IDS) {
    const p = hero(id, 2);
    p.levelUps = 1;
    dealOffer(p, makeRng(1), 1);
    const picked = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const c = p.offer![autoLevelPick(p).card];
      if (c.kind === 'stat') picked.add(c.stat);
    }
    const weapon = p.skills.map((o) => SKILLS[o.id]).find((d) => d.kind === 'basic')?.base.stat;
    for (const s of picked) assert.ok(s === CLASSES[id].stat || s === weapon || s === 'con', `${id} raised ${s}`);
  }
});

// ---------------------------------------------------------------- in a run

function camp(classes: ClassId[] = ['fighter', 'bard']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'STATS');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 100, relics: [], blessings: [], allies: [], seed: 1, difficulty: 'normal' };
  p.phase = 'map';
  return { g, p, heroes };
}

test('event checks use the hero with the best raised stat: a Bard talks the party past the toll goblins (CHA)', () => {
  const { p, heroes } = camp();
  const [ann, bob] = heroes;
  p.event = getEvent('toll_bridge', 1);
  p.phase = 'event';
  const hint = () => p.snapshot().event.choices.find((c: { id: string }) => c.id === 'bluff').hint as string;
  assert.match(hint(), /^CHA check, DC 13: Bob rolls \(\+3\), 55%$/);
  ann.statUps = { cha: 4 };
  assert.match(hint(), /^CHA check, DC 13: Ann rolls \(\+4\), 60%$/, 'the raised stat counts');
  assert.equal(bob.name, 'Bob');
});

test('a saved hero from before stat points gets the points of the even levels it already reached', () => {
  const { p } = camp();
  const info = p.players[0];
  const saved = { ...p.makePlayer(info, 5) };
  delete saved.statUps;
  saved.levelUps = 0;
  const back = p.restoreHero(saved, info);
  assert.equal(back.levelUps, 2, 'levels 2 and 4');
  assert.deepEqual(back.statUps, {});
  assert.equal(back.offerKind, 'level');
});

test('a latecomer joining at level 5 gets the stat points of the levels it skipped', () => {
  const { p } = camp();
  const r = p.join(undefined, 'Cid', 'cleric');
  const late = p.newcomer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 5);
  assert.equal(late.levelUps, 2);
});

// ---------------------------------------------------------------- monsters grow every floor (playtest 1)

test('monsters get a little tougher every floor, the middle of each act is its old numbers, and the act jump is smaller', () => {
  const rows = 12;
  const at = (act: number, row: number) => floorScaling(act, row, rows);
  let last = at(1, 0).hp;
  for (const act of [1, 2, 3]) {
    for (let row = 0; row < rows; row++) {
      const hp = at(act, row).hp;
      assert.ok(hp >= last, `act ${act} row ${row}: ${hp} after ${last}`);
      last = hp;
    }
  }
  assert.ok(Math.abs(at(2, 5.5).hp - ACT_SCALING[1].hp) < 1e-9, "act 2's middle is act 2's numbers");
  assert.equal(at(1, 0).hp, 1, 'the first floors stay at act 1');
  const jump = at(2, 0).hp - at(1, rows - 1).hp;
  assert.ok(jump < (ACT_SCALING[1].hp - ACT_SCALING[0].hp) / 2, `act 1 → 2 jump ${jump.toFixed(2)}`);
});
