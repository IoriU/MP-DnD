// Hero progression: XP shares, level-ups, level-up offers (pick 1 of 3), elite spoils, and training at rest sites.
// Pure functions on PlayerEntity, so they can be unit tested without a running game.

import { GEAR_IDS, ITEMS, ITEM_IDS, bagRoom, gearBonus, gearDef, isItemId, nextPity, rarityOdds, rarityPool, rollRarity, type ItemId } from '../shared/items.ts';
import { CARD_RARITIES, type CardRarity, type EngineId } from '../shared/engines.ts';
import {
  BOON_HP, CLASSES, INJURY_PCT, LEVEL_CAP, MAX_BONUS_AC, MAX_INJURIES, STATS, STAT_CAP, STAT_INFO, XP_ASSIST, XP_KILL, XP_SHARED,
  armorFor, fmtMod, maxHpFor, maxSlotsFor, statGain, statMod, statRoom, xpToNext, type Stat,
} from '../shared/rules.ts';
import {
  COUNTED_KINDS,
  SKILLS,
  SKILL_IDS,
  cardRarity,
  countKind,
  engineOf,
  enginePicks,
  hasBranch,
  isSignature,
  limitFor,
  nextTier,
  passiveOf,
  skillTitle,
  statsAt,
  trainOptions,
  type SkillId,
} from '../shared/skills.ts';
import type { BoonId, ClassId, OfferCard, OwnedSkill, PickRequest, PlayerEntity, RestPick } from '../shared/types.ts';
import { SUBCLASSES, isSubclassId, subclassesOf, type SubclassId } from '../shared/subclasses.ts';
import type { Rng } from './rng.ts';

export const startingSkills = (c: ClassId): OwnedSkill[] => CLASSES[c].start.map((id) => ({ id, tier: 1, cd: 0 }));

/**
 * Recomputes max HP, AC, speed and max slots from level, boons and passives.
 * Gains in max HP / slots are added to the current values; losses just clamp.
 */
export function recalcHero(p: PlayerEntity) {
  const c = CLASSES[p.classId];
  const drained = p.statuses.find((s) => s.id === 'drained')?.power ?? 0; // a Wight's touch, until the fight ends
  const injured = 1 - INJURY_PCT * Math.min(p.injuries ?? 0, MAX_INJURIES); // 🩹 deaths since the last rest
  const maxHp = Math.max(1, Math.round((maxHpFor(p.classId, p.level, statGain(p, 'con')) + p.bonusHp + (passiveOf(p, 'tough')?.value ?? 0) + gearBonus(p, 'hp')) * injured) - drained);
  const hpGain = maxHp - p.maxHp;
  p.maxHp = maxHp;
  if (hpGain > 0 && !p.downed && !p.dead) p.hp += hpGain;
  p.hp = Math.min(p.hp, p.maxHp);
  p.ac = armorFor(p.classId, statGain(p, 'dex')) + p.bonusAc + (hasBranch(p, 'battle_hardened', 'B') ? 1 : 0) + gearBonus(p, 'ac');
  p.speed = Math.max(1, c.speed + (passiveOf(p, 'slippery')?.value ?? 0) + (hasBranch(p, 'alert', 'A') ? 1 : 0) + gearBonus(p, 'speed'));
  const maxSlots = maxSlotsFor(p.classId, p.level, statGain(p, 'int')) + p.bonusSlots + gearBonus(p, 'slots');
  const slotGain = maxSlots - p.maxSlots;
  p.maxSlots = maxSlots;
  p.slots = Math.max(0, Math.min(maxSlots, p.slots + Math.max(0, slotGain)));
}

// ---------------------------------------------------------------- XP

/**
 * Who gets what when a monster dies: an even split of the shared part between every hero still alive,
 * a bonus for the killing blow, and a little for everyone else who hurt it. Catch-up is applied by the caller.
 */
export function killShares(xp: number, killerId: string | null, dmgBy: Record<string, number>, aliveIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  if (aliveIds.length) for (const id of aliveIds) add(id, (xp * XP_SHARED) / aliveIds.length);
  if (killerId) add(killerId, xp * XP_KILL);
  for (const [id, dmg] of Object.entries(dmgBy)) if (id !== killerId && dmg > 0) add(id, xp * XP_ASSIST);
  return out;
}

/**
 * Levels up as far as the XP goes. Returns how many levels were gained. Levels give HP and power; skills come from the
 * pick after every won fight (since 2026-10-19 there's no subclass pick either: builds are engines, shared/engines.ts).
 */
export function applyLevelUps(p: PlayerEntity): number {
  let gained = 0;
  while (p.level < LEVEL_CAP && p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    gained++;
    if (p.level % 2 === 0) p.levelUps++; // a stat point every other level, put in any stat
  }
  if (p.level >= LEVEL_CAP) p.xp = 0;
  if (gained) recalcHero(p);
  return gained;
}

// ---------------------------------------------------------------- level-up offers

interface Weighted {
  card: OfferCard;
  key: string; // one card per skill/boon
  w: number;
}

/** An epic capstone is only offered once you picked this many cards of its engine (starting cards don't count). */
const CAPSTONE_AFTER = 2;

/** How much likelier an engine's cards get as you pick more of them: 2 picks double it, 4 triple it. */
const leanOf = (p: PlayerEntity, engine: EngineId | undefined) => {
  if (!engine) return 1;
  const n = enginePicks(p, engine);
  return n >= 4 ? 3 : n >= 2 ? 2 : 1;
};

/**
 * What an offer can draw: new skills and upgrades from the class pool (or passives and boons from the common pool).
 * New skills have a rarity like items: each rarity gets the act's share of the draws (with the hero's pity), split over
 * the cards of that rarity, and cards of engines the hero has started lean in (`leanOf`). The total weight of new
 * skills stays about one per card, so upgrades keep their old odds.
 */
function candidates(p: PlayerEntity, pool: 'class' | 'common', act = 1): Weighted[] {
  const out: Weighted[] = [];
  const learns: { id: SkillId; rarity: CardRarity; lean: number }[] = [];
  for (const id of SKILL_IDS) {
    const def = SKILLS[id];
    const engine = engineOf(id);
    if (!COUNTED_KINDS.includes(def.kind) && !(def.kind === 'basic' && engine)) continue; // Quick Stab is a card too
    if (pool === 'class' ? def.pool !== p.classId : def.pool !== 'common') continue;
    const owned = p.skills.some((s) => s.id === id);
    if (!owned) {
      const rarity = cardRarity(id);
      if (rarity === 'epic' && (!engine || enginePicks(p, engine) < CAPSTONE_AFTER)) continue;
      learns.push({ id, rarity, lean: leanOf(p, engine) });
      continue;
    }
    const tier = nextTier(p, id);
    // Upgrades are weighted up, so builds come together.
    if (tier) out.push({ card: { kind: 'upgrade', skill: id, tier }, key: id, w: 2 * leanOf(p, engine) });
  }
  const odds = rarityOdds(act, { pity: p.pity });
  const share: Record<CardRarity, number> = { common: odds.common, uncommon: odds.uncommon, rare: odds.rare, epic: odds.epic + odds.legendary };
  const count = (r: CardRarity) => learns.filter((l) => l.rarity === r).length;
  const total = CARD_RARITIES.reduce((s, r) => s + (count(r) ? share[r] : 0), 0);
  for (const l of learns) out.push({ card: { kind: 'learn', skill: l.id }, key: l.id, w: (learns.length * share[l.rarity] * l.lean) / (total * count(l.rarity)) });
  if (pool === 'common') {
    const boons: BoonId[] = ['hp', 'potions', 'slot'];
    if (p.bonusAc < MAX_BONUS_AC) boons.push('ac');
    for (const boon of boons) out.push({ card: { kind: 'boon', boon }, key: `boon:${boon}`, w: 0.75 });
    // Stat boons: a stat point like the one every other level, for a stat that can still go up.
    for (const stat of STATS) if (statRoom(p, stat) > 0) out.push({ card: { kind: 'boon', boon: stat }, key: `boon:${stat}`, w: 0.35 });
  }
  return out;
}

function takeWeighted(list: Weighted[], n: number, r: Rng, taken: Set<string>): OfferCard[] {
  const out: OfferCard[] = [];
  for (let i = 0; i < n; i++) {
    const open = list.filter((c) => !taken.has(c.key));
    const total = open.reduce((s, c) => s + c.w, 0);
    if (!open.length || total <= 0) break;
    let roll = r.next() * total;
    let chosen = open[open.length - 1];
    for (const c of open) {
      roll -= c.w;
      if (roll < 0) {
        chosen = c;
        break;
      }
    }
    taken.add(chosen.key);
    out.push(chosen.card);
  }
  return out;
}

/** Three cards: two from the class pool (new skills and upgrades), one from the common pool (passives and boons). */
export function makeOffer(p: PlayerEntity, r: Rng): OfferCard[] {
  const taken = new Set<string>();
  const cls = candidates(p, 'class');
  const common = candidates(p, 'common');
  const cards = takeWeighted(cls, 2, r, taken);
  cards.push(...takeWeighted(common, 3 - cards.length, r, taken));
  if (cards.length < 3) cards.push(...takeWeighted([...cls, ...common], 3 - cards.length, r, taken));
  return cards;
}

/**
 * A victory's item: gear the hero isn't wearing, or a consumable, half the time each. Its rarity rolls on the act's
 * RARITY_ODDS with the hero's pity (shared/items.ts), or the nearest rarity there is.
 */
export function rewardItem(p: PlayerEntity, r: Rng, act: number): ItemId | null {
  const rarity = rollRarity(r.next(), act, { pity: p.pity });
  const worn = new Set(Object.values(p.gear));
  const gear = r.next() < 0.5;
  const pool = rarityPool(ITEM_IDS.filter((id) => (gear ? ITEMS[id].kind === 'gear' && !worn.has(id) : ITEMS[id].kind === 'consumable')), (id) => ITEMS[id].rarity, rarity);
  if (!pool.length) return null;
  const id = r.pick(pool);
  p.pity = nextPity(p.pity, ITEMS[id].rarity);
  return id;
}

/**
 * Victory spoils (one pick per hero for every fight won): two skill cards (the class and subclass pool, now and then a
 * common passive) and an item card (gear or a consumable). The item card is a boon a quarter of the time, or when the
 * bag is full.
 */
export function makeRewardOffer(p: PlayerEntity, r: Rng, act: number): OfferCard[] {
  const taken = new Set<string>();
  const common = candidates(p, 'common', act);
  const skills = [...candidates(p, 'class', act), ...common.filter((c) => c.card.kind !== 'boon').map((c) => ({ ...c, w: c.w * 0.5 }))];
  const cards = takeWeighted(skills, 2, r, taken);
  for (const c of cards) if (c.kind === 'learn') p.pity = nextPity(p.pity, cardRarity(c.skill)); // rare cards reset the pity too
  const item = bagRoom(p) > 0 && r.next() >= 0.25 ? rewardItem(p, r, act) : null;
  if (item) cards.push({ kind: 'item', item });
  cards.push(...takeWeighted(common.filter((c) => c.card.kind === 'boon'), 3 - cards.length, r, taken));
  return cards;
}

/**
 * Elite spoils (one pick per hero for each elite beaten): an upgrade to a skill you own (or a new class skill if
 * nothing can be upgraded), a piece of the act's elite gear, and a boon.
 */
export function makeEliteOffer(p: PlayerEntity, r: Rng, act: number): OfferCard[] {
  const taken = new Set<string>();
  const upgrades = candidates(p, 'class', act).concat(candidates(p, 'common', act)).filter((c) => c.card.kind === 'upgrade');
  const learns = candidates(p, 'class', act).filter((c) => c.card.kind === 'learn');
  const cards = takeWeighted(upgrades.length ? upgrades : learns, 1, r, taken);
  const want = rollRarity(r.next(), act, { pity: p.pity, elite: true }); // the next act's odds, never common
  const worn = new Set(Object.values(p.gear));
  const gear = rarityPool(GEAR_IDS.filter((id) => !worn.has(id)), (id) => ITEMS[id].rarity, want);
  if (gear.length) {
    const item = r.pick(gear);
    p.pity = nextPity(p.pity, ITEMS[item].rarity);
    cards.push({ kind: 'gear', item });
  }
  const boons = candidates(p, 'common').filter((c) => c.card.kind === 'boon');
  cards.push(...takeWeighted(boons, 3 - cards.length, r, taken));
  return cards;
}

/** The level-up pick that chooses a subclass: one card for each of the class's two. */
export const subclassOffer = (p: PlayerEntity): OfferCard[] => subclassesOf(p.classId).map((sub) => ({ kind: 'subclass', sub }));

/** Picks still to make, of every kind. */
export const picksLeft = (p: PlayerEntity) => p.levelUps + p.elitePicks + (p.rewardPicks ?? 0);

/** Deals the next pick: elite spoils first, then victory spoils (and old saves' level-up picks). */
export function dealOffer(p: PlayerEntity, r: Rng, act: number) {
  if (p.elitePicks > 0) {
    p.offer = makeEliteOffer(p, r, act);
    p.offerKind = 'elite';
  } else if ((p.rewardPicks ?? 0) > 0) {
    p.offer = makeRewardOffer(p, r, act);
    p.offerKind = 'reward';
  } else if (p.levelUps > 0 && statOffer(p).length) {
    p.offer = statOffer(p);
    p.offerKind = 'level';
  } else {
    if (p.levelUps > 0) p.levelUps = 0; // every stat at +5 already: nothing to raise
    p.offer = null;
    delete p.offerKind;
  }
}

/** A stat point (every other level): one card for each stat that can still go up. */
export const statOffer = (p: PlayerEntity): OfferCard[] => STATS.filter((stat) => statRoom(p, stat) > 0).map((stat) => ({ kind: 'stat', stat }));

/** Cards that still make sense after a save is loaded (skills and items can be renamed or removed between versions). */
export const validCard = (c: OfferCard) =>
  c.kind === 'boon'
    ? true
    : c.kind === 'stat'
      ? STATS.includes(c.stat)
    : c.kind === 'gear'
      ? isItemId(c.item) && !!gearDef(c.item)
      : c.kind === 'item'
        ? isItemId(c.item)
        : c.kind === 'subclass'
          ? isSubclassId(c.sub)
          : Object.hasOwn(SKILLS, c.skill);

/** Adds a new skill after the last one of its kind, so the hotbar stays grouped. */
function insertSkill(p: PlayerEntity, id: SkillId) {
  const kind = SKILLS[id].kind;
  let at = -1;
  p.skills.forEach((s, i) => {
    if (SKILLS[s.id].kind === kind) at = i;
  });
  const skill: OwnedSkill = { id, tier: 1, cd: 0 };
  if (at < 0) p.skills.push(skill);
  else p.skills.splice(at + 1, 0, skill);
}

export type PickResult = { ok: true; text: string } | { ok: false; error: string };

/** Learns a skill, forgetting `forget` first if that bar is full. */
function learn(p: PlayerEntity, id: SkillId, forget: unknown): PickResult {
  const kind = SKILLS[id].kind;
  if (p.skills.some((s) => s.id === id)) return { ok: false, error: 'You already know that.' };
  let forgot = '';
  if (countKind(p, kind) >= limitFor(p, kind)) {
    const old = p.skills.find((s) => s.id === forget);
    if (!old || SKILLS[old.id].kind !== kind || isSignature(p, old.id)) return { ok: false, error: `Your ${kind} slots are full: pick one to forget.` };
    p.skills = p.skills.filter((s) => s !== old);
    forgot = ` (forgot ${skillTitle(old)})`;
  }
  insertSkill(p, id);
  return { ok: true, text: `learns ${SKILLS[id].base.name}${forgot}` };
}

/** Raises a skill one tier. Tier III needs a branch and enough levels. */
export function upgrade(p: PlayerEntity, id: SkillId, tier: 2 | 3, branch: unknown): PickResult {
  const o = p.skills.find((s) => s.id === id);
  if (!o || nextTier(p, id) !== tier) return { ok: false, error: "That upgrade isn't available." };
  if (tier === 3) {
    if (branch !== 'A' && branch !== 'B') return { ok: false, error: 'Pick a branch (A or B).' };
    o.tier = 3;
    o.branch = branch;
    return { ok: true, text: `masters ${SKILLS[id].base.name}: ${statsAt(id, 3, branch).name}` };
  }
  o.tier = 2;
  return { ok: true, text: `upgrades ${SKILLS[id].base.name} to tier II` };
}

/** +1 to a stat (a stat point or a stat boon), up to +5. */
export function raiseStat(p: PlayerEntity, stat: Stat): PickResult {
  if (statRoom(p, stat) <= 0) return { ok: false, error: `${STAT_INFO[stat].name} is as high as levels and boons take it (+${STAT_CAP}).` };
  p.statUps = { ...p.statUps, [stat]: (p.statUps?.[stat] ?? 0) + 1 };
  recalcHero(p);
  return { ok: true, text: `raises ${STAT_INFO[stat].name} to ${fmtMod(statMod(p, stat))}` };
}

function boon(p: PlayerEntity, id: BoonId): PickResult {
  switch (id) {
    case 'hp':
      p.bonusHp += BOON_HP;
      return { ok: true, text: `gains ${BOON_HP} max HP` };
    case 'ac':
      if (p.bonusAc >= MAX_BONUS_AC) return { ok: false, error: 'Your armor is as good as it gets.' };
      p.bonusAc++;
      return { ok: true, text: 'gets better armor (+1 AC)' };
    case 'potions':
      p.potions += 2;
      return { ok: true, text: 'stocks up on 2 potions' };
    case 'slot':
      p.bonusSlots++;
      return { ok: true, text: `gains a ${CLASSES[p.classId].names.slots} slot` };
    default:
      return raiseStat(p, id);
  }
}

/** Picks the subclass and learns its signature skill (it takes no slot). */
function chooseSubclass(p: PlayerEntity, sub: SubclassId): PickResult {
  const def = SUBCLASSES[sub];
  if (!def || def.classId !== p.classId || p.subclass) return { ok: false, error: "That subclass isn't open to you." };
  p.subclass = sub;
  if (!p.skills.some((s) => s.id === def.signature)) insertSkill(p, def.signature);
  return { ok: true, text: `becomes ${/^[AEIOU]/.test(def.name) ? 'an' : 'a'} ${def.name} ${CLASSES[p.classId].name} and learns ${SKILLS[def.signature].base.name}` };
}

function takeGear(p: PlayerEntity, id: ItemId): PickResult {
  if (bagRoom(p) <= 0) return { ok: false, error: 'Your bag is full: drop or equip something first (I opens the bag).' };
  p.bag.push(id);
  return { ok: true, text: `takes the ${gearDef(id)?.name ?? SKILLS[id as SkillId]?.base.name ?? id}` };
}

/** Applies a level-up or elite pick, then deals the next offer if more picks are waiting. */
export function applyPick(p: PlayerEntity, req: PickRequest, r: Rng, act = 1): PickResult {
  const card = p.offer?.[Number(req?.card)];
  const kind = p.offerKind ?? 'level';
  const left = kind === 'elite' ? p.elitePicks : kind === 'reward' ? (p.rewardPicks ?? 0) : p.levelUps;
  if (!card || !left) return { ok: false, error: 'Pick a card.' };
  const res =
    card.kind === 'learn'
      ? learn(p, card.skill, req.forget)
      : card.kind === 'upgrade'
        ? upgrade(p, card.skill, card.tier, req.branch)
        : card.kind === 'gear' || card.kind === 'item'
          ? takeGear(p, card.item)
          : card.kind === 'subclass'
            ? chooseSubclass(p, card.sub)
            : card.kind === 'stat'
              ? raiseStat(p, card.stat)
              : boon(p, card.boon);
  if (!res.ok) return res;
  if (kind === 'elite') p.elitePicks--;
  else if (kind === 'reward') p.rewardPicks = (p.rewardPicks ?? 1) - 1;
  else p.levelUps--;
  dealOffer(p, r, act);
  recalcHero(p);
  return res;
}

// ---------------------------------------------------------------- rest sites

/** Checks a rest pick before it's stored. */
export function validRestPick(p: PlayerEntity, pick: RestPick): string | null {
  if (pick?.kind === 'long') return null;
  if (pick?.kind !== 'train') return 'Pick Long Rest or Train.';
  const opt = trainOptions(p).find((o) => o.skill === pick.skill);
  if (!opt) return "That skill can't be trained right now.";
  if (opt.tier === 3 && pick.branch !== 'A' && pick.branch !== 'B') return 'Pick a branch (A or B).';
  return null;
}
