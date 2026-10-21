import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSES, CLASS_IDS, LEVEL_CAP, MAX_CANTRIPS, XP_ASSIST, XP_KILL, XP_SHARED, maxHpFor, xpToNext } from '../shared/rules.ts';
import { countKind, limitFor, nextTier, passiveOf, trainOptions } from '../shared/skills.ts';
import type { PlayerEntity } from '../shared/types.ts';
import { applyLevelUps, applyPick, killShares, makeOffer, recalcHero, startingSkills, validRestPick } from '../server/progression.ts';
import { makeRng } from '../server/rng.ts';

function hero(classId: PlayerEntity['classId'], level = 1): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x: 0, y: 0,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], level, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [], elitePicks: 0, kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [], facing: { x: 1, y: 0 },
  };
  recalcHero(p);
  return p;
}

test('kill XP: an even shared part, a killing-blow bonus and assists', () => {
  const shares = killShares(100, 'a', { a: 3, b: 10 }, ['a', 'b', 'c', 'd']);
  const shared = (100 * XP_SHARED) / 4;
  assert.equal(shares.get('a'), shared + 100 * XP_KILL);
  assert.equal(shares.get('b'), shared + 100 * XP_ASSIST);
  assert.equal(shares.get('c'), shared);
  assert.ok(shares.get('a')! > shares.get('b')!, 'the killing blow is worth more than doing most of the damage');
});

test('levelling: XP carries over, HP and slots grow, the level cap holds', () => {
  const w = hero('wizard');
  w.xp = xpToNext(1) + xpToNext(2) + 5;
  assert.equal(applyLevelUps(w), 2);
  assert.equal(w.level, 3);
  assert.equal(w.xp, 5);
  assert.equal(w.levelUps, 1, 'level 2 brought a stat point (level 3 none)');
  assert.equal(w.maxHp, maxHpFor('wizard', 3));
  assert.equal(w.hp, w.maxHp, 'level-ups add the new max HP');
  assert.equal(w.maxSlots, CLASSES.wizard.slots + 1);
  const capped = hero('fighter', LEVEL_CAP);
  capped.xp = 99999;
  assert.equal(applyLevelUps(capped), 0);
  assert.equal(capped.level, LEVEL_CAP);
});

test('offers are three different cards the hero can take', () => {
  const r = makeRng(7);
  for (const c of CLASS_IDS) {
    for (let i = 0; i < 30; i++) {
      const p = hero(c, 1 + (i % LEVEL_CAP));
      const cards = makeOffer(p, r);
      assert.equal(cards.length, 3, `${c}: 3 cards`);
      const keys = cards.map((k) => (k.kind === 'boon' ? `boon:${k.boon}` : k.kind === 'stat' ? k.stat : k.kind === 'gear' || k.kind === 'item' ? k.item : k.kind === 'subclass' ? k.sub : k.skill));
      assert.equal(new Set(keys).size, 3, `${c}: no duplicates (${keys})`);
      for (const k of cards) if (k.kind === 'upgrade') assert.equal(nextTier(p, k.skill), k.tier);
    }
  }
});

test('picks: learning, forgetting when full, tier III needs a branch', () => {
  const r = makeRng(3);
  const w = hero('wizard', 5);
  w.levelUps = 3;
  w.offer = [{ kind: 'learn', skill: 'ray_of_frost' }];
  assert.ok(applyPick(w, { card: 0 }, r).ok);
  w.offer = [{ kind: 'learn', skill: 'shocking_grasp' }];
  assert.ok(applyPick(w, { card: 0 }, r).ok);
  assert.equal(countKind(w, 'cantrip'), MAX_CANTRIPS);
  const before = w.levelUps;
  w.offer = [{ kind: 'boon', boon: 'hp' }];
  assert.ok(applyPick(w, { card: 0 }, r).ok);
  assert.equal(w.levelUps, before - 1);
  assert.equal(w.bonusHp, 5);

  const f = hero('fighter', 5);
  f.levelUps = 2;
  f.skills.push({ id: 'heavy_strike', tier: 1, cd: 0 }, { id: 'battle_cry', tier: 1, cd: 0 });
  f.offer = [{ kind: 'learn', skill: 'shield_bash' }];
  assert.equal(applyPick(f, { card: 0 }, r).ok, false, 'already known');
  const full = hero('fighter', 5);
  full.levelUps = 1;
  full.skills.push({ id: 'heavy_strike', tier: 1, cd: 0 }, { id: 'battle_cry', tier: 1, cd: 0 });
  full.offer = [{ kind: 'upgrade', skill: 'shield_bash', tier: 2 }];
  assert.ok(applyPick(full, { card: 0 }, r).ok);
  full.levelUps = 1;
  full.offer = [{ kind: 'upgrade', skill: 'shield_bash', tier: 3 }];
  assert.equal(applyPick(full, { card: 0 }, r).ok, false, 'tier III needs a branch');
  assert.ok(applyPick(full, { card: 0, branch: 'B' }, r).ok);
  assert.equal(full.skills.find((s) => s.id === 'shield_bash')?.branch, 'B');

  const r2 = hero('rogue', 3);
  r2.levelUps = 1;
  r2.skills.push({ id: 'feint', tier: 1, cd: 0 }, { id: 'throwing_knives', tier: 1, cd: 0 });
  assert.equal(countKind(r2, 'cantrip'), limitFor(r2, 'cantrip'));
  r2.offer = [{ kind: 'learn', skill: 'opportunist' }];
  assert.ok(applyPick(r2, { card: 0 }, r).ok, 'passives have their own slots');
  assert.ok(passiveOf(r2, 'opportunist'));
});

test('learning past a full bar forgets the chosen skill', () => {
  const r = makeRng(5);
  const w = hero('wizard', 3);
  w.skills.push({ id: 'ray_of_frost', tier: 1, cd: 0 }, { id: 'shocking_grasp', tier: 1, cd: 0 });
  w.skills.push({ id: 'fireball', tier: 1, cd: 0 }, { id: 'shield', tier: 1, cd: 0 });
  w.levelUps = 1;
  w.offer = [{ kind: 'learn', skill: 'tough' }];
  assert.ok(applyPick(w, { card: 0 }, r).ok);
  w.levelUps = 1;
  w.skills.push({ id: 'elemental_affinity', tier: 1, cd: 0 });
  w.offer = [{ kind: 'learn', skill: 'arcane_ward' }];
  assert.equal(applyPick(w, { card: 0 }, r).ok, false, 'two passive slots at level 3');
  assert.ok(applyPick(w, { card: 0, forget: 'tough' }, r).ok);
  assert.equal(passiveOf(w, 'tough'), null);
  assert.equal(w.maxHp, maxHpFor('wizard', 3), 'forgetting Tough removes its HP');
});

test('Tough and Slippery change the hero sheet', () => {
  const r = hero('rogue', 2);
  r.skills.push({ id: 'tough', tier: 2, cd: 0 }, { id: 'slippery', tier: 1, cd: 0 });
  recalcHero(r);
  assert.equal(r.maxHp, maxHpFor('rogue', 2) + 8);
  assert.equal(r.speed, CLASSES.rogue.speed + 1);
});

test('rest picks: Long Rest always works, Train needs a skill that can grow', () => {
  const c = hero('cleric', 2);
  assert.equal(validRestPick(c, { kind: 'long' }), null);
  assert.equal(validRestPick(c, { kind: 'train', skill: 'sacred_flame' }), null);
  assert.ok(validRestPick(c, { kind: 'train', skill: 'mace' }), 'basic attacks have no tiers');
  assert.ok(validRestPick(c, { kind: 'train', skill: 'fireball' }), "can't train what you don't know");
  c.skills.find((s) => s.id === 'sacred_flame')!.tier = 2;
  assert.ok(validRestPick(c, { kind: 'train', skill: 'sacred_flame', branch: 'A' }), 'tier III needs a higher level');
  c.level = 4;
  assert.ok(validRestPick(c, { kind: 'train', skill: 'sacred_flame' }), 'tier III needs a branch');
  assert.equal(validRestPick(c, { kind: 'train', skill: 'sacred_flame', branch: 'A' }), null);
  assert.deepEqual(trainOptions(c).map((o) => o.skill), ['sacred_flame', 'healing_word']);
});
