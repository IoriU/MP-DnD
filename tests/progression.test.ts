// Auto-play level-up and rest choices: always valid, and sensible.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_IDS, LEVEL_CAP, TIER3_LEVEL } from '../shared/rules.ts';
import { COUNTED_KINDS, SKILLS, SKILL_IDS, canUpgrade, countKind, limitFor } from '../shared/skills.ts';
import type { ClassId, PlayerEntity } from '../shared/types.ts';
import { autoLevelPick, autoRestPick } from '../server/heroai.ts';
import { applyPick, makeOffer, recalcHero, startingSkills, validRestPick } from '../server/progression.ts';
import { makeRng, type Rng } from '../server/rng.ts';

function hero(classId: ClassId, level = 1): PlayerEntity {
  const p: PlayerEntity = {
    id: `h-${classId}`, kind: 'player', playerId: `p-${classId}`, classId, name: classId, glyph: '', color: '#fff', x: 0, y: 0,
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], level, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [],
  };
  recalcHero(p);
  return p;
}

/** A hero of any class and level with a random set of skills (within the bar limits) at random tiers. */
function randomHero(r: Rng): PlayerEntity {
  const p = hero(r.pick(CLASS_IDS), r.int(1, LEVEL_CAP));
  for (const id of r.shuffle(SKILL_IDS.filter((id) => COUNTED_KINDS.includes(SKILLS[id].kind)))) {
    const def = SKILLS[id];
    if ((def.pool !== p.classId && def.pool !== 'common') || p.skills.some((s) => s.id === id)) continue;
    if (countKind(p, def.kind) < limitFor(p, def.kind) && r.chance(0.6)) p.skills.push({ id, tier: 1, cd: 0 });
  }
  for (const s of p.skills) {
    if (!canUpgrade(s.id)) continue;
    s.tier = r.pick(p.level >= TIER3_LEVEL ? ([1, 2, 3] as const) : ([1, 2] as const));
    if (s.tier === 3) s.branch = r.pick(['A', 'B'] as const);
  }
  p.bonusAc = r.int(0, 2);
  recalcHero(p);
  p.hp = r.int(0, p.maxHp);
  p.slots = r.int(0, p.maxSlots);
  return p;
}

function assertSane(p: PlayerEntity, why: string) {
  for (const kind of COUNTED_KINDS) assert.ok(countKind(p, kind) <= limitFor(p, kind), `${why}: too many ${kind}s`);
  assert.equal(new Set(p.skills.map((s) => s.id)).size, p.skills.length, `${why}: a skill twice`);
  for (const s of p.skills) assert.ok(s.tier < 3 || s.branch, `${why}: tier III without a branch`);
}

test('auto level-up picks are always accepted (random heroes of every class and level)', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = makeRng(seed);
    const p = randomHero(r);
    p.levelUps = r.int(1, 6);
    p.offer = makeOffer(p, r);
    for (let guard = 0; p.levelUps > 0; guard++) {
      assert.ok(guard < 10, `seed ${seed}: picks never run out`);
      const req = autoLevelPick(p);
      const res = applyPick(p, req, r);
      assert.ok(res.ok, `seed ${seed} (${p.classId} L${p.level}): ${JSON.stringify(req)} -> ${!res.ok && res.error} on ${JSON.stringify(p.offer)}`);
      assertSane(p, `seed ${seed}`);
    }
    assert.equal(p.offer, null);
  }
});

test('an auto hero levels from 1 to the cap, filling and then swapping its bars', () => {
  for (const classId of CLASS_IDS) {
    for (let seed = 1; seed <= 25; seed++) {
      const r = makeRng(seed * 31 + classId.length);
      const p = hero(classId);
      while (p.level < LEVEL_CAP) {
        p.level++;
        p.levelUps = 1;
        recalcHero(p);
        p.offer = makeOffer(p, r);
        const req = autoLevelPick(p);
        const res = applyPick(p, req, r);
        assert.ok(res.ok, `${classId} seed ${seed} L${p.level}: ${JSON.stringify(req)} -> ${!res.ok && res.error}`);
        assertSane(p, `${classId} L${p.level}`);
      }
      assert.ok(p.skills.some((s) => s.tier > 1), `${classId} seed ${seed}: upgraded something on the way`);
    }
  }
});

test('level-up priorities: a tier III upgrade (with a branch) beats a new passive and a boon', () => {
  const f = hero('fighter', 6);
  f.skills.find((s) => s.id === 'shield_bash')!.tier = 2;
  f.levelUps = 1;
  f.offer = [{ kind: 'boon', boon: 'hp' }, { kind: 'learn', skill: 'tough' }, { kind: 'upgrade', skill: 'shield_bash', tier: 3 }];
  for (let i = 0; i < 20; i++) {
    const req = autoLevelPick(f);
    assert.equal(req.card, 2);
    assert.ok(req.branch === 'A' || req.branch === 'B');
  }
});

test('learning into a full bar forgets the weakest skill of that kind', () => {
  const w = hero('wizard', 6);
  w.skills.push({ id: 'elemental_affinity', tier: 1, cd: 0 }, { id: 'arcane_ward', tier: 2, cd: 0 }, { id: 'lucky', tier: 1, cd: 0 });
  assert.equal(countKind(w, 'passive'), limitFor(w, 'passive'));
  w.levelUps = 1;
  w.offer = [{ kind: 'learn', skill: 'tough' }];
  const req = autoLevelPick(w);
  assert.equal(req.card, 0);
  assert.ok(req.forget === 'elemental_affinity' || req.forget === 'lucky', `forgets a tier I passive, not ${req.forget}`);
  assert.ok(applyPick(w, req, makeRng(1)).ok);
  assert.ok(w.skills.some((s) => s.id === 'tough'));
});

test('auto rest picks are always valid', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = makeRng(seed);
    const p = randomHero(r);
    const pick = autoRestPick(p, [p]);
    assert.equal(validRestPick(p, pick), null, `seed ${seed}: ${JSON.stringify(pick)}`);
  }
});

test('rest: Long Rest when hurt or out of slots, otherwise Train', () => {
  const w = hero('wizard', 5);
  w.hp = Math.floor(w.maxHp * 0.4);
  assert.deepEqual(autoRestPick(w, [w]), { kind: 'long' }, 'hurt');
  w.hp = w.maxHp;
  w.slots = 0;
  assert.deepEqual(autoRestPick(w, [w]), { kind: 'long' }, 'no slots');
  w.slots = w.maxSlots;
  const train = autoRestPick(w, [w]);
  assert.equal(train.kind, 'train');
  assert.equal(validRestPick(w, train), null);
  // Everything maxed: nothing to train, so rest anyway.
  for (const s of w.skills) if (canUpgrade(s.id)) Object.assign(s, { tier: 3, branch: 'B' });
  assert.deepEqual(autoRestPick(w, [w]), { kind: 'long' });
  // A tier III training needs a branch.
  const f = hero('fighter', TIER3_LEVEL);
  for (const s of f.skills) if (canUpgrade(s.id)) s.tier = 2;
  const pick = autoRestPick(f, [f]);
  assert.ok(pick.kind === 'train' && (pick.branch === 'A' || pick.branch === 'B'));
});
