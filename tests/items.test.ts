import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { autoEquip, autoShopPick } from '../server/heroai.ts';
import { recalcHero } from '../server/progression.ts';
import {
  BAG_SIZE,
  CONSUMABLE_IDS,
  FORGET_PRICE,
  ITEMS,
  POTION_PRICE,
  RELIC_PRICE,
  RELICS,
  gearDef,
  isItemId,
  isRelicId,
  itemPrice,
  sellPrice,
  trainPrice,
  type ItemId,
} from '../shared/items.ts';
import { SKILLS, hotbar, isSkillId, skillBlockReason } from '../shared/skills.ts';
import type { ClassId, PlayerEntity, PlayerInfo, ShopOffer } from '../shared/types.ts';

// Phase 6: equipment, consumables, relics, the shop and treasure, through the real Game class. Private members are
// reached with `any`, the same way tests/elements.test.ts does it. Checkpoints write saves, so they go to a temp folder.

const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-items-'));
process.env.DELVERS_SAVES = saves;
const games: Game[] = [];
after(() => {
  games.forEach((g) => g.dispose());
  delete process.env.DELVERS_SAVES;
  fs.rmSync(saves, { recursive: true, force: true });
});

/** Dice come from Math.random: MID is the middle of every die. */
const MID = 0.5;
function withRandom<T>(roll: number, fn: () => T): T {
  const real = Math.random;
  Math.random = () => roll;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

const NAMES = ['Ann', 'Bob', 'Cid'];
const full = (): ItemId[] => Array.from({ length: BAG_SIZE }, (): ItemId => 'padded_vest');

/** A party on the map: act 1, 500 gold, nothing in the bags. Players who join are human, not auto. */
function camp(classes: ClassId[] = ['wizard']) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'ITEM');
  games.push(g);
  const p = g as any;
  const pids = classes.map((c, i) => {
    const r = g.join(undefined, NAMES[i], c);
    assert.ok(r.ok);
    return r.playerId;
  });
  const heroes = pids.map((id) => p.makePlayer(p.players.find((x: PlayerInfo) => x.id === id), 1) as PlayerEntity);
  p.entities = [...heroes];
  p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 1, 4), currentId: null, visited: [], gold: 500, relics: [], seed: 1 };
  p.phase = 'map';
  return { g, p, heroes, hero: heroes[0], ally: heroes[1], pid: pids[0] };
}

/** The same kind of party in a small walled room, mid-fight. A far-off kobold keeps the fight going. */
function fight(classes: ClassId[] = ['wizard', 'fighter']) {
  const c = camp(classes);
  const { g, p, heroes } = c;
  g.width = 12;
  g.height = 8;
  g.tiles = ['#'.repeat(12), ...Array.from({ length: 6 }, () => `#${'.'.repeat(10)}#`), '#'.repeat(12)].join('');
  g.ground = {};
  g.clouds = {};
  g.props = {};
  heroes.forEach((h, i) => {
    h.x = 2;
    h.y = 3 + i;
  });
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, movesLeft: 6, actionUsed: false, bonusUsed: false };
  p.turnOwner = heroes[0].id;
  const monster = (type: string, x: number, y: number, hp = 100) => {
    p.spawnMonster(type, { x, y }, 1);
    const m = p.entities.at(-1);
    m.hp = m.maxHp = hp;
    m.ac = 1;
    p.turn.order.push(m.id);
    return m;
  };
  const sentinel = monster('kobold', 10, 6, 9999);
  sentinel.ac = 30;
  return { ...c, monster };
}

/** A shop open with the party's gold at 500. The stock is random unless a test sets `shop.offers` itself. */
function shopOpen(classes?: ClassId[]) {
  const c = camp(classes);
  c.p.run.gold = 500;
  c.p.startShop();
  return c;
}

// ---------------------------------------------------------------- 1-4: equipment and the bag

test('equipping a chain shirt wears it, takes it out of the bag and adds 2 AC', () => {
  const c = camp();
  const h = c.hero;
  h.bag = ['chain_shirt'];
  const ac = h.ac;
  c.g.handleItem(c.pid, { kind: 'equip', item: 'chain_shirt' });
  assert.equal(h.gear.armor, 'chain_shirt');
  assert.deepEqual(h.bag, []);
  assert.equal(h.ac, ac + 2);
});

test('equipping a new piece of armor puts the one you wore back in the bag', () => {
  const c = camp();
  const h = c.hero;
  h.bag = ['chain_shirt', 'padded_vest'];
  const ac = h.ac;
  c.g.handleItem(c.pid, { kind: 'equip', item: 'chain_shirt' });
  c.g.handleItem(c.pid, { kind: 'equip', item: 'padded_vest' });
  assert.equal(h.gear.armor, 'padded_vest');
  assert.deepEqual(h.bag, ['chain_shirt']);
  assert.equal(h.ac, ac + 1);
});

test('unequipping moves the item into the bag, and a full bag refuses it', () => {
  const c = camp();
  const h = c.hero;
  h.gear.armor = 'chain_shirt';
  recalcHero(h);
  c.g.handleItem(c.pid, { kind: 'unequip', slot: 'armor' });
  assert.equal(h.gear.armor, undefined);
  assert.deepEqual(h.bag, ['chain_shirt']);

  h.gear.armor = 'chain_shirt';
  h.bag = full();
  c.g.handleItem(c.pid, { kind: 'unequip', slot: 'armor' });
  assert.equal(h.gear.armor, 'chain_shirt');
  assert.deepEqual(h.bag, full());
});

test('giving an item or a potion to an ally moves it, and a full bag refuses the item', () => {
  const c = camp(['wizard', 'fighter']);
  const { hero, ally } = c;
  hero.bag = ['chain_shirt'];
  c.g.handleItem(c.pid, { kind: 'give', item: 'chain_shirt', to: ally.id });
  assert.deepEqual(hero.bag, []);
  assert.deepEqual(ally.bag, ['chain_shirt']);

  const [mine, theirs] = [hero.potions, ally.potions];
  c.g.handleItem(c.pid, { kind: 'give', item: 'potion', to: ally.id });
  assert.equal(hero.potions, mine - 1);
  assert.equal(ally.potions, theirs + 1);

  hero.bag = ['padded_vest'];
  ally.bag = full();
  c.g.handleItem(c.pid, { kind: 'give', item: 'padded_vest', to: ally.id });
  assert.deepEqual(hero.bag, ['padded_vest']);
  assert.deepEqual(ally.bag, full());
});

test('dropping an item removes it from the bag', () => {
  const c = camp();
  c.hero.bag = ['chain_shirt', 'padded_vest'];
  c.g.handleItem(c.pid, { kind: 'drop', item: 'chain_shirt' });
  assert.deepEqual(c.hero.bag, ['padded_vest']);
});

test('no item action works during a fight', () => {
  const c = fight();
  const { hero, ally } = c;
  hero.gear.weapon = 'fine_blade';
  hero.bag = ['chain_shirt', 'padded_vest'];
  const snapshot = () => JSON.stringify([hero.gear, hero.bag, ally.bag, hero.ac]);
  const before = snapshot();
  c.g.handleItem(c.pid, { kind: 'equip', item: 'chain_shirt' });
  c.g.handleItem(c.pid, { kind: 'unequip', slot: 'weapon' });
  c.g.handleItem(c.pid, { kind: 'give', item: 'padded_vest', to: ally.id });
  c.g.handleItem(c.pid, { kind: 'drop', item: 'padded_vest' });
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- 6: gear stats

test('worn gear changes max HP, speed and max slots once the hero is recalculated', () => {
  const c = camp();
  const h = c.hero;
  const base = { hp: h.maxHp, speed: h.speed, slots: h.maxSlots };
  h.gear.trinket = 'health_amulet';
  recalcHero(h);
  assert.equal(h.maxHp, base.hp + 8);
  h.gear.trinket = 'speed_boots';
  recalcHero(h);
  assert.equal(h.speed, base.speed + 2);
  assert.equal(h.maxHp, base.hp);
  h.gear.armor = 'archmage_robe';
  recalcHero(h);
  assert.equal(h.maxSlots, base.slots + 1);
});

// ---------------------------------------------------------------- 7: relics

test('a war banner adds 1 AC to every hero, and a second copy adds nothing', () => {
  const c = camp(['wizard', 'fighter']);
  const before = c.heroes.map((h) => h.ac);
  c.p.grantRelic('war_banner');
  assert.ok(c.p.run.relics.includes('war_banner'));
  c.heroes.forEach((h, i) => {
    assert.ok(h.relics.includes('war_banner'));
    assert.equal(h.ac, before[i] + 1);
  });
  c.p.grantRelic('war_banner');
  assert.equal(c.p.run.relics.length, 1);
  c.heroes.forEach((h, i) => assert.equal(h.ac, before[i] + 1));
});

test('a mana crystal adds a max slot to every hero, and a hero who joins later gets the relics', () => {
  const c = camp();
  const { hero, p } = c;
  const slots = hero.maxSlots;
  p.grantRelic('mana_crystal');
  assert.equal(hero.maxSlots, slots + 1);
  p.grantRelic('war_banner');
  const later = p.makePlayer(p.players[0], 1) as PlayerEntity;
  assert.deepEqual(later.relics, ['mana_crystal', 'war_banner']);
  assert.equal(later.maxSlots, slots + 1);
  assert.equal(later.ac, hero.ac);
});

// ---------------------------------------------------------------- 8-12: the shop

test('a merchant stocks 3 gear, 3 consumables, at most one non-boss relic and 3 potions', () => {
  const c = shopOpen();
  assert.equal(c.g.phase, 'shop');
  const offers: ShopOffer[] = c.p.shop.offers;
  const items = offers.filter((o) => o.kind === 'item');
  assert.equal(items.filter((o) => isItemId(o.id) && gearDef(o.id)).length, 3);
  assert.equal(items.filter((o) => isItemId(o.id) && !gearDef(o.id)).length, 3);
  const relics = offers.filter((o) => o.kind === 'relic');
  assert.ok(relics.length <= 1);
  for (const o of relics) assert.ok(isRelicId(o.id) && RELICS[o.id].rarity !== 'boss', o.id);
  assert.deepEqual(
    offers.find((o) => o.kind === 'potion'),
    { kind: 'potion', id: 'potion', price: POTION_PRICE, left: 3 },
  );
});

test('buying an item pays its price, puts it in the bag and uses up one of the offer', () => {
  const c = shopOpen();
  c.p.shop.offers = [{ kind: 'item', id: 'chain_shirt', price: itemPrice('chain_shirt'), left: 1 }];
  c.g.handleShop(c.pid, { kind: 'buy', offer: 0 });
  assert.equal(c.p.run.gold, 500 - itemPrice('chain_shirt'));
  assert.deepEqual(c.hero.bag, ['chain_shirt']);
  assert.equal(c.p.shop.offers[0].left, 0);
});

test('a purchase is refused without enough gold or with a full bag, and nothing changes', () => {
  const c = shopOpen();
  c.p.shop.offers = [{ kind: 'item', id: 'chain_shirt', price: itemPrice('chain_shirt'), left: 1 }];
  c.p.run.gold = itemPrice('chain_shirt') - 1;
  c.g.handleShop(c.pid, { kind: 'buy', offer: 0 });
  assert.equal(c.p.run.gold, itemPrice('chain_shirt') - 1);
  assert.deepEqual(c.hero.bag, []);
  assert.equal(c.p.shop.offers[0].left, 1);

  c.p.run.gold = 500;
  c.hero.bag = full();
  c.g.handleShop(c.pid, { kind: 'buy', offer: 0 });
  assert.equal(c.p.run.gold, 500);
  assert.deepEqual(c.hero.bag, full());
  assert.equal(c.p.shop.offers[0].left, 1);
});

test('buying the relic adds it to the run, and buying the potion adds one', () => {
  const c = shopOpen();
  c.p.shop.offers = [
    { kind: 'relic', id: 'whetstone', price: RELIC_PRICE, left: 1 },
    { kind: 'potion', id: 'potion', price: POTION_PRICE, left: 3 },
  ];
  c.g.handleShop(c.pid, { kind: 'buy', offer: 0 });
  assert.ok(c.p.run.relics.includes('whetstone'));
  assert.ok(c.hero.relics.includes('whetstone'));
  assert.equal(c.p.run.gold, 500 - RELIC_PRICE);

  const potions = c.hero.potions;
  c.g.handleShop(c.pid, { kind: 'buy', offer: 1 });
  assert.equal(c.hero.potions, potions + 1);
  assert.equal(c.p.run.gold, 500 - RELIC_PRICE - POTION_PRICE);
  assert.equal(c.p.shop.offers[1].left, 2);
});

test('selling takes an item out of the bag for its sell price', () => {
  const c = shopOpen();
  c.hero.bag = ['chain_shirt'];
  c.g.handleShop(c.pid, { kind: 'sell', item: 'chain_shirt' });
  assert.deepEqual(c.hero.bag, []);
  assert.equal(c.p.run.gold, 500 + sellPrice('chain_shirt'));
});

test('training fire bolt to tier II costs the training price', () => {
  const c = shopOpen();
  c.g.handleShop(c.pid, { kind: 'train', skill: 'fire_bolt' });
  assert.equal(c.hero.skills.find((s) => s.id === 'fire_bolt')?.tier, 2);
  assert.equal(c.p.run.gold, 500 - trainPrice(1));
});

test('forgetting a spell costs the forget price, and a basic attack cannot be forgotten', () => {
  const c = shopOpen();
  c.g.handleShop(c.pid, { kind: 'forget', skill: 'magic_missile' });
  assert.ok(!c.hero.skills.some((s) => s.id === 'magic_missile'));
  assert.equal(c.p.run.gold, 500 - FORGET_PRICE);
  c.g.handleShop(c.pid, { kind: 'forget', skill: 'dagger' });
  assert.ok(c.hero.skills.some((s) => s.id === 'dagger'));
  assert.equal(c.p.run.gold, 500 - FORGET_PRICE);
});

test('when the only hero is done shopping, the shop closes and the party goes back to the map', async () => {
  const c = shopOpen();
  c.g.handleShop(c.pid, { kind: 'done', done: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(c.g.phase, 'map');
  assert.equal(c.p.shop, null);
});

// ---------------------------------------------------------------- 13-14: consumables

test('a fire bomb is one hotbar entry, and throwing one uses up exactly one of the two', () => {
  const c = fight();
  const { hero } = c;
  hero.bag = ['fire_bomb', 'fire_bomb'];
  assert.equal(hotbar(hero).filter((id) => id === 'fire_bomb').length, 1);
  const goblin = c.monster('goblin', 5, 3);
  const thrown = withRandom(MID, () => c.g.handleSkill(c.pid, 'fire_bomb', { x: goblin.x, y: goblin.y }));
  assert.equal(thrown, true);
  assert.deepEqual(hero.bag, ['fire_bomb']);
});

test('with no fire bombs left, the skill is blocked with None left', () => {
  const c = fight();
  const { hero } = c;
  hero.bag = ['fire_bomb'];
  const goblin = c.monster('goblin', 5, 3);
  withRandom(MID, () => c.g.handleSkill(c.pid, 'fire_bomb', { x: goblin.x, y: goblin.y }));
  assert.deepEqual(hero.bag, []);
  assert.equal(skillBlockReason(hero, 'fire_bomb', true, c.p.turn, true), 'None left');
});

test('an ether restores one slot outside a fight and is used up', () => {
  const c = camp();
  const { hero } = c;
  hero.slots = hero.maxSlots - 2;
  hero.bag = ['ether'];
  assert.equal(c.g.handleSkill(c.pid, 'ether', undefined), true);
  assert.equal(hero.slots, hero.maxSlots - 1);
  assert.deepEqual(hero.bag, []);
});

test('every consumable has an item skill with the same id, which the hotbar and the bag use', () => {
  for (const id of CONSUMABLE_IDS) assert.ok(isSkillId(id) && SKILLS[id].kind === 'item', id);
});

// ---------------------------------------------------------------- 15-16: treasure and elite loot

test('a treasure chest offers three non-boss relics, and taking one adds it and pays gold', () => {
  const c = camp();
  const gold = c.p.run.gold;
  c.p.treasure();
  assert.equal(c.g.phase, 'event');
  const choices: { id: string }[] = c.p.event.choices;
  assert.equal(choices.length, 3);
  for (const ch of choices) assert.ok(isRelicId(ch.id) && RELICS[ch.id].rarity !== 'boss', ch.id);
  c.p.chooseEventOption(choices[0].id);
  assert.ok(c.p.run.relics.includes(choices[0].id));
  assert.ok(c.p.run.gold > gold);
});

test('an elite leaves its gear with whoever landed the killing blow', () => {
  const c = camp(['wizard', 'fighter']);
  c.p.eliteKiller = c.ally.id;
  c.p.fightLoot('elite');
  assert.equal(c.ally.bag.length, 1);
  assert.ok(gearDef(c.ally.bag[0]));
  assert.deepEqual(c.hero.bag, []);
});

test('when every bag is full, the elite gear is sold for gold instead', () => {
  const c = camp(['wizard', 'fighter']);
  c.hero.bag = full();
  c.ally.bag = full();
  c.p.eliteKiller = c.hero.id;
  const gold = c.p.run.gold;
  c.p.fightLoot('elite');
  assert.ok(c.p.run.gold > gold);
  assert.deepEqual(c.hero.bag, full());
  assert.deepEqual(c.ally.bag, full());
});

// ---------------------------------------------------------------- 17: saves from before items

test('a hero saved without gear or a bag loads with empty ones, and unknown items are dropped', () => {
  const c = camp();
  const info = c.p.players[0];
  const saved = c.p.makePlayer(info, 1);
  delete saved.gear;
  delete saved.bag;
  delete saved.relics;
  const restored = c.p.restoreHero(saved, info) as PlayerEntity;
  assert.deepEqual(restored.gear, {});
  assert.deepEqual(restored.bag, []);
  saved.bag = ['chain_shirt', 'not_an_item'];
  const again = c.p.restoreHero(saved, info) as PlayerEntity;
  assert.deepEqual(again.bag, ['chain_shirt']);
});

// ---------------------------------------------------------------- 18: the hero AI

test('an auto hero puts on armor that beats the bare body, and keeps armor that is better', () => {
  const c = camp();
  c.hero.bag = ['chain_shirt'];
  assert.deepEqual(autoEquip(c.hero), { kind: 'equip', item: 'chain_shirt' });
  c.hero.gear.armor = 'plate_armor';
  assert.equal(autoEquip(c.hero), null);
});

test('auto shopping buys nothing with no gold, and buys an affordable armor upgrade', () => {
  const c = camp();
  const offers: ShopOffer[] = [{ kind: 'item', id: 'chain_shirt', price: itemPrice('chain_shirt'), left: 1 }];
  const shop = { offers, trainPrice: trainPrice(1) };
  assert.equal(autoShopPick(c.hero, shop, 0, 1, []), null);
  assert.deepEqual(autoShopPick(c.hero, shop, 500, 1, []), { kind: 'buy', offer: 0 });
});

// ---------------------------------------------------------------- loot rarity

test(
  'a common consumable drop is only ever a common consumable',
  () => {
    const c = camp();
    for (let i = 0; i < 200; i++) {
      const id = c.p.randomItem('consumable', ['common']) as ItemId;
      assert.equal(ITEMS[id].rarity, 'common', id);
    }
  },
);
