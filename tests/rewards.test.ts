// Rewards after every win (decided 2026-10-19): each hero picks one of three cards after every won fight (two skill
// cards and an item card), levels give HP and power (no pick: builds are engines now, tests/engines.test.ts), and potions
// drop with Slay the Spire's odds. Progression is tested as pure functions; the potion odds through the real Game class.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { autoLevelPick } from '../server/heroai.ts';
import { applyLevelUps, applyPick, dealOffer, makeRewardOffer, picksLeft, recalcHero, startingSkills } from '../server/progression.ts';
import { makeRng, rng } from '../server/rng.ts';
import { BAG_SIZE, ITEMS } from '../shared/items.ts';
import { CLASS_IDS, POTION_ODDS, POTION_ODDS_STEP, xpToNext } from '../shared/rules.ts';
import type { ClassId, PlayerEntity, PlayerInfo } from '../shared/types.ts';

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-rewards-'));
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
    hp: 0, maxHp: 0, ac: 10, speed: 6, statuses: [], facing: { x: 1, y: 0 }, level, xp: 0, skills: startingSkills(classId), levelUps: 0, offer: null,
    bonusHp: 0, bonusAc: 0, bonusSlots: 0, tempHp: 0, potions: 2, gear: {}, bag: [], relics: [], blessings: [], elitePicks: 0, kills: 0, steals: 0, slots: 0, maxSlots: 0,
    downed: false, dead: false, saves: { ok: 0, fail: 0 }, used: [],
  };
  recalcHero(p);
  return p;
}

const SKILL_CARDS = ['learn', 'upgrade'];

test('a victory offer is two skill cards and an item card (a boon when the bag is full), all different', () => {
  let items = 0;
  let boons = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const p = hero(CLASS_IDS[seed % CLASS_IDS.length], 1 + (seed % 6));
    const cards = makeRewardOffer(p, makeRng(seed), 1 + (seed % 3));
    assert.equal(cards.length, 3, `seed ${seed}`);
    assert.ok(SKILL_CARDS.includes(cards[0].kind) && SKILL_CARDS.includes(cards[1].kind), `seed ${seed}: ${JSON.stringify(cards)}`);
    assert.ok(cards[2].kind === 'item' || cards[2].kind === 'boon', `seed ${seed}: ${JSON.stringify(cards[2])}`);
    if (cards[2].kind === 'item') items++;
    else boons++;
    assert.equal(new Set(cards.map((c) => JSON.stringify(c))).size, 3);
  }
  assert.ok(items > 150 && boons > 30, `items ${items}, boons ${boons}`);
  const full = hero('fighter');
  full.bag = Array.from({ length: BAG_SIZE }, () => 'fine_blade' as const);
  for (let seed = 1; seed <= 50; seed++) assert.equal(makeRewardOffer(full, makeRng(seed), 1)[2].kind, 'boon', 'no item card with a full bag');
});

test('victory items: rares are rare in act 1, gear the hero is not wearing, consumables too', () => {
  const seen = new Set<string>();
  let cards = 0;
  let rares = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const p = hero('rogue');
    p.gear.weapon = 'fine_blade';
    const card = makeRewardOffer(p, makeRng(seed), 1)[2];
    if (card.kind !== 'item') continue;
    cards++;
    if (['rare', 'epic', 'legendary'].includes(ITEMS[card.item].rarity)) rares++;
    assert.notEqual(card.item, 'fine_blade', 'not what it already wears');
    seen.add(ITEMS[card.item].kind);
  }
  assert.ok(rares / cards < 0.12, `${rares} rare or better of ${cards} act 1 item cards`);
  assert.deepEqual([...seen].sort(), ['consumable', 'gear']);
});

test('picking a victory card uses up a victory pick; the item goes in the bag; bots take them too', () => {
  const p = hero('cleric', 2);
  p.rewardPicks = 2;
  dealOffer(p, makeRng(3), 1);
  assert.equal(p.offerKind, 'reward');
  const i = p.offer!.findIndex((c) => c.kind === 'item');
  if (i >= 0) {
    const item = (p.offer![i] as { item: string }).item;
    assert.equal(applyPick(p, { card: i }, makeRng(4), 1).ok, true);
    assert.ok(p.bag.includes(item as never));
  } else {
    assert.equal(applyPick(p, autoLevelPick(p), makeRng(4), 1).ok, true);
  }
  assert.equal(p.rewardPicks, 1);
  assert.equal(p.offerKind, 'reward', 'the next one is dealt');
  assert.equal(applyPick(p, autoLevelPick(p), makeRng(5), 1).ok, true);
  assert.equal(p.rewardPicks, 0);
  assert.equal(p.offer, null);
  assert.equal(picksLeft(p), 0);
});

test('levels give stats, not picks: no level-up pick is owed at level 2 or 3 (the subclass pick is gone)', () => {
  const p = hero('ranger');
  p.xp = xpToNext(1);
  assert.equal(applyLevelUps(p), 1);
  assert.equal(p.levelUps, 0, 'level 2: nothing to pick');
  p.xp = xpToNext(2);
  assert.equal(applyLevelUps(p), 1);
  assert.equal(p.level, 3);
  assert.equal(p.levelUps, 0, 'level 3: nothing to pick either');
  dealOffer(p, makeRng(1), 1);
  assert.equal(p.offer, null, 'so no offer is dealt');
});

test('elite spoils come first, then the victory picks', () => {
  const p = hero('paladin', 3);
  Object.assign(p, { elitePicks: 1, levelUps: 0, rewardPicks: 2 });
  const order: string[] = [];
  const r = makeRng(9);
  dealOffer(p, r, 1);
  while (p.offer) {
    order.push(p.offerKind!);
    assert.equal(applyPick(p, autoLevelPick(p), r, 1).ok, true);
  }
  assert.deepEqual(order, ['elite', 'reward', 'reward']);
});

// ---------------------------------------------------------------- potions and the spoils pick in the Game class

function party(classes: ClassId[] = ['fighter', 'cleric', 'wizard']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'REWARDS');
  games.push(g);
  const p = g as any;
  const heroes: PlayerEntity[] = classes.map((c, i) => {
    const r = g.join(undefined, ['Ann', 'Bob', 'Cid'][i], c);
    assert.ok(r.ok);
    return p.makePlayer(p.players.find((x: PlayerInfo) => x.id === r.playerId), 1);
  });
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 1 };
  return { g, p, heroes };
}

function rolling<T>(v: number, fn: () => T): T {
  const real = rng.next;
  rng.next = () => v;
  try {
    return fn();
  } finally {
    rng.next = real;
  }
}

test('potions: 40% at first, the odds drop 10 after one drops and climb 10 after a fight without; the poorest hero gets it', () => {
  const { p, heroes } = party();
  heroes[1].potions = 0;
  assert.equal(rolling(0.99, () => p.potionDrop()), null);
  assert.equal(p.run.potionOdds, POTION_ODDS + POTION_ODDS_STEP);
  const text = rolling(0.45, () => p.potionDrop()); // 45 < 50
  assert.match(text, /Bob finds a healing potion/);
  assert.equal(heroes[1].potions, 1);
  assert.equal(p.run.potionOdds, POTION_ODDS);
});

test('a won fight gives every hero a victory pick with an offer', () => {
  const { p, heroes } = party();
  p.victorySpoils();
  for (const h of heroes) {
    assert.equal(h.rewardPicks, 1);
    assert.equal(h.offerKind, 'reward');
    assert.equal(h.offer?.length, 3);
  }
});
