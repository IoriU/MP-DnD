// The level-up panel: a floating card stack in the corner of the canvas (#levelup) for picking 1 of 3 cards.
// Victory spoils (one pick after every won fight: two skills and an item) use it too, titled "Victory spoils".
// Elite spoils (one pick per elite beaten) use the same panel, titled "Elite spoils", and can offer a piece of gear.
// Skill cards show their rarity and build engine (shared/engines.ts) and how many of that engine's cards you own.
// An old save can still have a subclass pick waiting: that offer is drawn too ("choose your path").
// It never blocks play: it collapses to a "Level up!" button, and it starts collapsed during fights.

import './levelup.css';
import { ENGINES, type CardRarity } from '../shared/engines.ts';
import { RARITY_COLOR, SLOT_NAME, bagRoom, describeStats, gearDef, isItemId } from '../shared/items.ts';
import { BOONS, CLASSES } from '../shared/rules.ts';
import {
  SKILLS, TIER_LABEL, cardRarity, countKind, describeSkill, engineCount, engineOf, isSignature, itemInfo, limitFor, ownedSkill, skillTitle, skillsOfKind, statsAt,
  type SkillId, type SkillKind,
} from '../shared/skills.ts';
import { SUBCLASSES } from '../shared/subclasses.ts';
import type { GameState, OfferCard, PickRequest, PlayerEntity } from '../shared/types.ts';
import { itemIcon } from './inventory.ts';
import { send } from './net.ts';
import { artKey } from './sprites.ts';
import { me, store } from './store.ts';
import { $, esc, toast } from './util.ts';

let open: boolean | null = null; // null = automatic: open, except during a fight
let forgetCard: number | null = null; // a learn card waiting for "forget which?"
let lastKey = '';
let lastOffer = '';
let lastPhase = '';
let lastUps = -1; // levelUps in the previous state, to toast when it goes up
let lastElite = -1; // the same for elitePicks
let lastReward = -1; // and for rewardPicks
let lockUntil = 0; // ignore clicks right after a pick, until the next offer arrives

const BAG_FULL = 'Bag full: drop or equip something first';

interface CardView {
  icon: string;
  title: string;
  badge: string;
  kind: string; // css hook for the accent color
  body: string; // html
  color?: string; // overrides the accent (gear takes its rarity color)
  skill?: SkillId; // a skill card: it shows its rarity and engine under the title
}

/** Picks still to make: victory spoils, elite spoils and (old saves) level-ups. */
const picksLeft = (m: PlayerEntity) => m.levelUps + m.elitePicks + (m.rewardPicks ?? 0);
const isElite = (m: PlayerEntity) => m.offerKind === 'elite';
const isReward = (m: PlayerEntity) => m.offerKind === 'reward';
/** The offer is the choice of subclass (an old save's level-up: the two cards of the hero's class). */
const isPath = (m: PlayerEntity) => !!m.offer?.some((c) => c.kind === 'subclass');

/** "Techniques" -> "Technique": every class flavor name is the plural of its singular. */
const singular = (plural: string) => plural.replace(/s$/, '');

/** The player-facing (plural) name of a skill kind for this hero's class. */
function kindPlural(m: PlayerEntity, kind: SkillKind): string {
  const names = CLASSES[m.classId].names;
  return kind === 'cantrip' ? names.cantrip : kind === 'spell' ? names.spell : kind === 'passive' ? 'Passives' : kind === 'basic' ? 'Attacks' : 'Skills';
}
const kindName = (m: PlayerEntity, kind: SkillKind) => singular(kindPlural(m, kind));

const desc = (text: string) => `<div class="lu-desc">${esc(text)}</div>`;

const RARITY_LABEL: Record<CardRarity, string> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic capstone' };

/** A skill card's rarity, and its engine with how many of that engine's cards you own: "Rare · ⚔️ Weapon Master · you have 2". */
function metaHtml(m: PlayerEntity, id: SkillId): string {
  const rarity = cardRarity(id);
  const engine = engineOf(id);
  const e = engine && ENGINES[engine];
  const have = engine ? engineCount(m, engine) : 0;
  return `<div class="lu-meta"><b class="lu-rarity" style="color:${RARITY_COLOR[rarity]}">${RARITY_LABEL[rarity]}</b>${
    e ? `<span class="lu-engine" title="${esc(e.desc)}">${e.icon} ${esc(e.name)} · you have ${have}</span>` : ''
  }</div>`;
}

function cardView(m: PlayerEntity, c: OfferCard): CardView {
  if (c.kind === 'boon') {
    const b = BOONS[c.boon];
    return { icon: b.icon, title: b.name, badge: 'Boon', kind: 'boon', body: desc(b.desc) };
  }
  if (c.kind === 'gear' || c.kind === 'item') {
    const g = gearDef(c.item);
    if (!g && c.kind === 'item' && isItemId(c.item)) {
      // A consumable: its rules are the skill of the same id.
      const i = itemInfo(c.item);
      return {
        icon: itemIcon(c.item, i.icon), title: i.name, badge: 'Consumable', kind: 'gear', color: RARITY_COLOR[i.rarity],
        body: `<div class="lu-tier">${i.rarity} consumable</div>${desc(i.desc)}<div class="lu-note">🎒 Goes into your bag, used from your hotbar</div>`,
      };
    }
    if (!g) return { icon: '❔', title: 'Unknown item', badge: 'Item', kind: 'gear', body: '' }; // renamed or removed since a save was made
    return {
      icon: itemIcon(c.item, g.icon), title: g.name, badge: SLOT_NAME[g.slot], kind: 'gear', color: RARITY_COLOR[g.rarity],
      body: `<div class="lu-tier">${g.rarity} ${SLOT_NAME[g.slot].toLowerCase()}</div>${desc(describeStats(g.stats))}${g.note ? desc(g.note) : ''}<div class="lu-note">🎒 Goes into your bag</div>`,
    };
  }
  if (c.kind === 'subclass') {
    const sub = SUBCLASSES[c.sub];
    const sig = statsAt(sub.signature, 1);
    return {
      icon: sub.icon, title: sub.name, badge: 'Subclass', kind: 'subclass',
      body: `${desc(sub.blurb)}<div class="lu-tier up">Learn now · takes no slot</div><b class="lu-sig">${sig.icon} ${esc(sig.name)}</b>${desc(describeSkill(sub.signature, 1, undefined, m))}`,
    };
  }
  const def = SKILLS[c.skill];
  const base = statsAt(c.skill, 1);
  const kn = kindName(m, def.kind);
  if (c.kind === 'learn') {
    return {
      icon: base.icon, title: base.name, badge: `New ${kn}`, kind: def.kind, skill: c.skill,
      body: `<div class="lu-tier">New · tier I</div>${desc(describeSkill(c.skill, 1, undefined, m))}`,
    };
  }
  const own = ownedSkill(m, c.skill);
  const badge = `Upgrade · ${kn}`;
  if (c.tier === 2) {
    return {
      icon: base.icon, title: `${skillTitle({ id: c.skill, tier: 2 })}`, badge, kind: def.kind, skill: c.skill,
      body: `<div class="lu-tier">Now · tier I</div><div class="lu-now">${desc(describeSkill(c.skill, own?.tier ?? 1, own?.branch, m))}</div>
        <div class="lu-tier up">Next · tier II</div>${desc(describeSkill(c.skill, 2, undefined, m))}`,
    };
  }
  return { icon: base.icon, title: `${own ? skillTitle(own) : base.name} → tier III`, badge, kind: def.kind, skill: c.skill, body: '' }; // branches are drawn as two buttons
}

function branchButton(m: PlayerEntity, card: number, skill: SkillId, branch: 'A' | 'B'): string {
  const st = statsAt(skill, 3, branch);
  return `<button type="button" class="lu-branch" data-pick="${card}" data-branch="${branch}">
    <span class="lu-bhead"><b>${st.icon} ${esc(st.name)}</b><span class="lu-go">Choose ${TIER_LABEL(3, branch)}</span></span>
    ${desc(describeSkill(skill, 3, branch, m))}
  </button>`;
}

function cardHtml(m: PlayerEntity, c: OfferCard, i: number): string {
  const v = cardView(m, c);
  const rarity = v.skill ? cardRarity(v.skill) : null; // skill cards: an outline in the rarity's color, a glow for epic
  const style = v.color ? ` style="--k:${v.color}"` : rarity ? ` style="--r:${RARITY_COLOR[rarity]}"` : '';
  const rcls = rarity ? ` r r-${rarity}` : '';
  const meta = v.skill ? metaHtml(m, v.skill) : '';
  const head = `<span class="lu-head2"><span class="lu-icon">${v.icon}</span><b class="lu-title"${v.color ? ` style="color:${v.color}"` : ''}>${esc(v.title)}</b><span class="lu-badge">${esc(v.badge)}</span></span>`;
  if (c.kind === 'upgrade' && c.tier === 3) {
    return `<div class="lu-card k-${v.kind}${rcls}"${style}>${head}${meta}<div class="lu-tier up">Pick a branch</div>${branchButton(m, i, c.skill, 'A')}${branchButton(m, i, c.skill, 'B')}</div>`;
  }
  // Gear needs room in the bag (and the bag is read-only in a fight, so say so).
  if ((c.kind === 'gear' || c.kind === 'item') && bagRoom(m) <= 0) {
    const why = store.state?.phase === 'combat' ? `${BAG_FULL} (not during a fight)` : BAG_FULL;
    return `<button type="button" class="lu-card k-${v.kind} off" disabled${style}>${head}${v.body}<span class="lu-why">⛔ ${esc(why)}</span></button>`;
  }
  return `<button type="button" class="lu-card k-${v.kind}${rcls}"${style} data-pick="${i}">${head}${meta}${v.body}<span class="lu-go">Choose</span></button>`;
}

function forgetHtml(m: PlayerEntity, i: number): string {
  const c = m.offer?.[i];
  if (!c || c.kind !== 'learn') return '';
  const kind = SKILLS[c.skill].kind;
  const learning = statsAt(c.skill, 1);
  const list = skillsOfKind(m, kind)
    .filter((o) => !isSignature(m, o.id)) // a subclass's signature skill can't be forgotten
    .map((o) => {
      const st = statsAt(o.id, o.tier, o.branch);
      return `<button type="button" class="lu-card k-${kind} forget" data-forget="${o.id}">
        <span class="lu-head2"><span class="lu-icon">${st.icon}</span><b class="lu-title">${esc(skillTitle(o))}</b><span class="lu-badge">Forget</span></span>
        ${desc(describeSkill(o.id, o.tier, o.branch, m))}
      </button>`;
    })
    .join('');
  return `<div class="lu-forget">You can only know ${limitFor(m, kind)} ${esc(kindPlural(m, kind).toLowerCase())}.
    Forget which one to learn <b>${learning.icon} ${esc(learning.name)}</b>?</div>${list}
    <button type="button" class="btn small ghost" data-lu="back">← Back to the cards</button>`;
}

function panelHtml(m: PlayerEntity, isOpen: boolean): string {
  const elite = isElite(m);
  const reward = isReward(m);
  const path = isPath(m);
  const n = picksLeft(m);
  if (!isOpen) {
    const label = elite ? '💀 Spoils' : reward ? '🏆 Spoils' : '⬆️ Level up!';
    return `<button type="button" class="lu-tab${elite ? ' elite' : ''}" data-lu="toggle" title="Open your ${elite ? 'elite spoils' : reward ? 'victory spoils' : 'level-up picks'} (L)">${label} (${n})</button>`;
  }
  const offer = m.offer ?? [];
  const body =
    forgetCard !== null ? forgetHtml(m, forgetCard) : offer.map((c, i) => cardHtml(m, c, i)).join('');
  return `<div class="lu-panel${elite ? ' elite' : ''}" role="dialog" aria-label="${elite ? 'Elite spoils' : reward ? 'Victory spoils' : 'Level up'}">
    <div class="lu-top">
      <b>${elite ? '💀 Elite spoils' : reward ? '🏆 Victory spoils: pick one' : path ? '⬆️ Choose your path' : '⬆️ Level up!'} <span class="muted">${n > 1 ? `${n} picks waiting` : reward ? '' : 'pick 1 of ' + offer.length}</span></b>
      <button type="button" class="lu-min" data-lu="toggle" title="Collapse (L)" aria-label="Collapse">–</button>
    </div>
    ${elite ? '<div class="lu-explain">Pick one reward for beating the elite.</div>' : ''}
    ${path ? '<div class="lu-explain">Your old save still has a subclass pick waiting. Its signature skill is yours now (no slot needed).</div>' : ''}
    <div class="lu-cards">${body}</div>
  </div>`;
}

/** Is a human picking for this hero? Auto-play heroes (switched on, or bots) get their picks made by the server. */
const manual = (s: GameState) => {
  const info = s.players.find((p) => p.id === store.playerId);
  return !!info && !info.auto && !info.bot;
};

/** Should the panel be shown at all? Not for auto-play heroes or outside a run. */
function wanted(s: GameState, m: PlayerEntity): boolean {
  if (picksLeft(m) <= 0 || !m.offer?.length) return false;
  if (s.phase !== 'map' && s.phase !== 'event' && s.phase !== 'rest' && s.phase !== 'combat') return false;
  return manual(s);
}

export function renderLevelUp(s: GameState) {
  const el = $('#levelup');
  const m = me();
  if (m && manual(s)) {
    if (lastElite >= 0 && m.elitePicks > lastElite) toast('💀 Elite spoils! Pick a reward in the corner of the map (L).');
    else if (lastUps >= 0 && m.levelUps > lastUps) toast('⬆️ Level up! Pick a card in the corner of the map (L).');
    else if (lastReward >= 0 && (m.rewardPicks ?? 0) > lastReward) toast('🏆 Victory! Pick your spoils in the corner of the map (L).');
  }
  lastUps = m ? m.levelUps : -1;
  lastElite = m ? m.elitePicks : -1;
  lastReward = m ? (m.rewardPicks ?? 0) : -1;
  if (!m || !wanted(s, m)) {
    el.hidden = true;
    el.innerHTML = '';
    lastKey = '';
    lastOffer = '';
    forgetCard = null;
    return;
  }
  if (s.phase !== lastPhase) {
    lastPhase = s.phase;
    open = null;
  }
  const offerKey = JSON.stringify(m.offer);
  if (offerKey !== lastOffer) {
    lastOffer = offerKey;
    forgetCard = null;
    lockUntil = 0;
  }
  const isOpen = open ?? s.phase !== 'combat';
  const key = JSON.stringify([isOpen, forgetCard, m.levelUps, m.elitePicks, m.rewardPicks, m.offerKind, m.level, offerKey, bagRoom(m), m.skills.map((o) => [o.id, o.tier, o.branch]), artKey()]);
  el.hidden = false;
  el.classList.toggle('collapsed', !isOpen);
  if (key === lastKey) return;
  lastKey = key;
  el.classList.remove('busy');
  const cards = el.querySelector('.lu-cards');
  const top = cards?.scrollTop ?? 0;
  el.innerHTML = panelHtml(m, isOpen);
  const fresh = el.querySelector('.lu-cards');
  if (fresh) fresh.scrollTop = top;
}

/** Opens or collapses the panel (the L key, the party card badge, the tab). */
export function toggleLevelUp() {
  const s = store.state;
  const m = me();
  if (!s || !m) return;
  if (!wanted(s, m)) {
    if (picksLeft(m) > 0) toast('Auto-play makes your level-up and spoils picks. Press P to take over.');
    return;
  }
  open = !(open ?? s.phase !== 'combat');
  renderLevelUp(s);
}

function submit(req: PickRequest) {
  lockUntil = Date.now() + 600;
  forgetCard = null;
  $('#levelup').classList.add('busy'); // greyed until the server's next state arrives
  window.setTimeout(() => $('#levelup').classList.remove('busy'), 1500); // or a rejected pick
  send('pick', req);
}

function choose(card: number, branch?: 'A' | 'B') {
  const m = me();
  const c = m?.offer?.[card];
  if (!m || !c || Date.now() < lockUntil) return;
  if ((c.kind === 'gear' || c.kind === 'item') && bagRoom(m) <= 0) return toast(BAG_FULL);
  if (c.kind === 'learn') {
    const kind = SKILLS[c.skill].kind;
    if (countKind(m, kind) >= limitFor(m, kind)) {
      forgetCard = card; // the bar is full: ask what to forget first
      if (store.state) renderLevelUp(store.state);
      return;
    }
  }
  submit(branch ? { card, branch } : { card });
}

export function initLevelUp() {
  $('#levelup').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const lu = t.closest<HTMLElement>('[data-lu]')?.dataset.lu;
    if (lu === 'toggle') return toggleLevelUp();
    if (lu === 'back') {
      forgetCard = null;
      if (store.state) renderLevelUp(store.state);
      return;
    }
    const forget = t.closest<HTMLElement>('[data-forget]')?.dataset.forget;
    if (forget && forgetCard !== null) {
      if (Date.now() < lockUntil) return;
      return submit({ card: forgetCard, forget: forget as SkillId });
    }
    const pick = t.closest<HTMLElement>('[data-pick]');
    if (pick) choose(Number(pick.dataset.pick), (pick.dataset.branch as 'A' | 'B' | undefined) ?? undefined);
  });
}
