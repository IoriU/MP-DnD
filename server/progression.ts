// Hero progression: XP shares, level-ups, level-up offers (pick 1 of 3), and training at rest sites.
// Pure functions on PlayerEntity, so they can be unit tested without a running game.

import { BOON_HP, CLASSES, LEVEL_CAP, MAX_BONUS_AC, XP_ASSIST, XP_KILL, XP_SHARED, maxHpFor, maxSlotsFor, xpToNext } from '../shared/rules.ts';
import {
  COUNTED_KINDS,
  SKILLS,
  SKILL_IDS,
  countKind,
  hasBranch,
  limitFor,
  nextTier,
  passiveOf,
  skillTitle,
  statsAt,
  trainOptions,
  type SkillId,
} from '../shared/skills.ts';
import type { BoonId, ClassId, OfferCard, OwnedSkill, PickRequest, PlayerEntity, RestPick } from '../shared/types.ts';
import type { Rng } from './rng.ts';

export const startingSkills = (c: ClassId): OwnedSkill[] => CLASSES[c].start.map((id) => ({ id, tier: 1, cd: 0 }));

/**
 * Recomputes max HP, AC, speed and max slots from level, boons and passives.
 * Gains in max HP / slots are added to the current values; losses just clamp.
 */
export function recalcHero(p: PlayerEntity) {
  const c = CLASSES[p.classId];
  const maxHp = Math.max(1, maxHpFor(p.classId, p.level) + p.bonusHp + (passiveOf(p, 'tough')?.value ?? 0));
  const hpGain = maxHp - p.maxHp;
  p.maxHp = maxHp;
  if (hpGain > 0 && !p.downed && !p.dead) p.hp += hpGain;
  p.hp = Math.min(p.hp, p.maxHp);
  p.ac = c.ac + p.bonusAc + (hasBranch(p, 'battle_hardened', 'B') ? 1 : 0);
  p.speed = c.speed + (passiveOf(p, 'slippery')?.value ?? 0) + (hasBranch(p, 'alert', 'A') ? 1 : 0);
  const maxSlots = maxSlotsFor(p.classId, p.level) + p.bonusSlots;
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

/** Levels up as far as the XP goes. Returns how many levels were gained. */
export function applyLevelUps(p: PlayerEntity): number {
  let gained = 0;
  while (p.level < LEVEL_CAP && p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    p.levelUps++;
    gained++;
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

function candidates(p: PlayerEntity, pool: 'class' | 'common'): Weighted[] {
  const out: Weighted[] = [];
  for (const id of SKILL_IDS) {
    const def = SKILLS[id];
    if (!COUNTED_KINDS.includes(def.kind)) continue;
    if (pool === 'class' ? def.pool !== p.classId : def.pool !== 'common') continue;
    const owned = p.skills.some((s) => s.id === id);
    if (!owned) {
      out.push({ card: { kind: 'learn', skill: id }, key: id, w: 1 });
      continue;
    }
    const tier = nextTier(p, id);
    // Upgrades are weighted up, so builds come together.
    if (tier) out.push({ card: { kind: 'upgrade', skill: id, tier }, key: id, w: 2 });
  }
  if (pool === 'common') {
    const boons: BoonId[] = ['hp', 'potions', 'slot'];
    if (p.bonusAc < MAX_BONUS_AC) boons.push('ac');
    for (const boon of boons) out.push({ card: { kind: 'boon', boon }, key: `boon:${boon}`, w: 0.75 });
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
    if (!old || SKILLS[old.id].kind !== kind) return { ok: false, error: `Your ${kind} slots are full: pick one to forget.` };
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
  }
}

/** Applies a level-up pick, then deals the next offer if more picks are waiting. */
export function applyPick(p: PlayerEntity, req: PickRequest, r: Rng): PickResult {
  const card = p.offer?.[Number(req?.card)];
  if (!card || !p.levelUps) return { ok: false, error: 'Pick a card.' };
  const res =
    card.kind === 'learn' ? learn(p, card.skill, req.forget) : card.kind === 'upgrade' ? upgrade(p, card.skill, card.tier, req.branch) : boon(p, card.boon);
  if (!res.ok) return res;
  p.levelUps--;
  p.offer = p.levelUps > 0 ? makeOffer(p, r) : null;
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
