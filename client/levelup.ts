// The level-up panel: a floating card stack in the corner of the canvas (#levelup) for picking 1 of 3 cards.
// Elite spoils (one pick per elite beaten) use the same panel, titled "Elite spoils", and can offer a piece of gear.
// It never blocks play: it collapses to a "Level up!" button, and it starts collapsed during fights.

import './levelup.css';
import { RARITY_COLOR, SLOT_NAME, bagRoom, describeStats, gearDef } from '../shared/items.ts';
import { BOONS, CLASSES } from '../shared/rules.ts';
import {
  SKILLS, TIER_LABEL, countKind, describeSkill, limitFor, ownedSkill, skillTitle, skillsOfKind, statsAt,
  type SkillId, type SkillKind,
} from '../shared/skills.ts';
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
let lockUntil = 0; // ignore clicks right after a pick, until the next offer arrives

const BAG_FULL = 'Bag full: drop or equip something first';

interface CardView {
  icon: string;
  title: string;
  badge: string;
  kind: string; // css hook for the accent color
  body: string; // html
  color?: string; // overrides the accent (gear takes its rarity color)
}

/** Picks still to make: level-ups and elite spoils. */
const picksLeft = (m: PlayerEntity) => m.levelUps + m.elitePicks;
const isElite = (m: PlayerEntity) => m.offerKind === 'elite';

/** "Techniques" -> "Technique": every class flavor name is the plural of its singular. */
const singular = (plural: string) => plural.replace(/s$/, '');

/** The player-facing (plural) name of a skill kind for this hero's class. */
function kindPlural(m: PlayerEntity, kind: SkillKind): string {
  const names = CLASSES[m.classId].names;
  return kind === 'cantrip' ? names.cantrip : kind === 'spell' ? names.spell : kind === 'passive' ? 'Passives' : 'Skills';
}
const kindName = (m: PlayerEntity, kind: SkillKind) => singular(kindPlural(m, kind));

const desc = (text: string) => `<div class="lu-desc">${esc(text)}</div>`;

function cardView(m: PlayerEntity, c: OfferCard): CardView {
  if (c.kind === 'boon') {
    const b = BOONS[c.boon];
    return { icon: b.icon, title: b.name, badge: 'Boon', kind: 'boon', body: desc(b.desc) };
  }
  if (c.kind === 'gear') {
    const g = gearDef(c.item);
    if (!g) return { icon: '❔', title: 'Unknown gear', badge: 'Gear', kind: 'gear', body: '' }; // renamed or removed since a save was made
    return {
      icon: itemIcon(c.item, g.icon), title: g.name, badge: SLOT_NAME[g.slot], kind: 'gear', color: RARITY_COLOR[g.rarity],
      body: `<div class="lu-tier">${g.rarity} ${SLOT_NAME[g.slot].toLowerCase()}</div>${desc(describeStats(g.stats))}${g.note ? desc(g.note) : ''}<div class="lu-note">🎒 Goes into your bag</div>`,
    };
  }
  const def = SKILLS[c.skill];
  const base = statsAt(c.skill, 1);
  const kn = kindName(m, def.kind);
  if (c.kind === 'learn') {
    return {
      icon: base.icon, title: base.name, badge: `New ${kn}`, kind: def.kind,
      body: `<div class="lu-tier">New · tier I</div>${desc(describeSkill(c.skill, 1, undefined, m))}`,
    };
  }
  const own = ownedSkill(m, c.skill);
  const badge = `Upgrade · ${kn}`;
  if (c.tier === 2) {
    return {
      icon: base.icon, title: `${skillTitle({ id: c.skill, tier: 2 })}`, badge, kind: def.kind,
      body: `<div class="lu-tier">Now · tier I</div><div class="lu-now">${desc(describeSkill(c.skill, own?.tier ?? 1, own?.branch, m))}</div>
        <div class="lu-tier up">Next · tier II</div>${desc(describeSkill(c.skill, 2, undefined, m))}`,
    };
  }
  return { icon: base.icon, title: `${own ? skillTitle(own) : base.name} → tier III`, badge, kind: def.kind, body: '' }; // branches are drawn as two buttons
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
  const style = v.color ? ` style="--k:${v.color}"` : '';
  const head = `<span class="lu-head2"><span class="lu-icon">${v.icon}</span><b class="lu-title"${v.color ? ` style="color:${v.color}"` : ''}>${esc(v.title)}</b><span class="lu-badge">${esc(v.badge)}</span></span>`;
  if (c.kind === 'upgrade' && c.tier === 3) {
    return `<div class="lu-card k-${v.kind}">${head}<div class="lu-tier up">Pick a branch</div>${branchButton(m, i, c.skill, 'A')}${branchButton(m, i, c.skill, 'B')}</div>`;
  }
  // Gear needs room in the bag (and the bag is read-only in a fight, so say so).
  if (c.kind === 'gear' && bagRoom(m) <= 0) {
    const why = store.state?.phase === 'combat' ? `${BAG_FULL} (not during a fight)` : BAG_FULL;
    return `<button type="button" class="lu-card k-${v.kind} off" disabled${style}>${head}${v.body}<span class="lu-why">⛔ ${esc(why)}</span></button>`;
  }
  return `<button type="button" class="lu-card k-${v.kind}"${style} data-pick="${i}">${head}${v.body}<span class="lu-go">Choose</span></button>`;
}

function forgetHtml(m: PlayerEntity, i: number): string {
  const c = m.offer?.[i];
  if (!c || c.kind !== 'learn') return '';
  const kind = SKILLS[c.skill].kind;
  const learning = statsAt(c.skill, 1);
  const list = skillsOfKind(m, kind)
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
  const n = picksLeft(m);
  if (!isOpen) {
    return `<button type="button" class="lu-tab${elite ? ' elite' : ''}" data-lu="toggle" title="Open your ${elite ? 'elite spoils' : 'level-up picks'} (L)">${elite ? '💀 Spoils' : '⬆️ Level up!'} (${n})</button>`;
  }
  const offer = m.offer ?? [];
  const body =
    forgetCard !== null ? forgetHtml(m, forgetCard) : offer.map((c, i) => cardHtml(m, c, i)).join('');
  return `<div class="lu-panel${elite ? ' elite' : ''}" role="dialog" aria-label="${elite ? 'Elite spoils' : 'Level up'}">
    <div class="lu-top">
      <b>${elite ? '💀 Elite spoils' : '⬆️ Level up!'} <span class="muted">${n > 1 ? `${n} picks waiting` : 'pick 1 of ' + offer.length}</span></b>
      <button type="button" class="lu-min" data-lu="toggle" title="Collapse (L)" aria-label="Collapse">–</button>
    </div>
    ${elite ? '<div class="lu-explain">Pick one reward for beating the elite.</div>' : ''}
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
  }
  lastUps = m ? m.levelUps : -1;
  lastElite = m ? m.elitePicks : -1;
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
  const key = JSON.stringify([isOpen, forgetCard, m.levelUps, m.elitePicks, m.offerKind, m.level, offerKey, bagRoom(m), m.skills.map((o) => [o.id, o.tier, o.branch]), artKey()]);
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
    if (picksLeft(m) > 0) toast('Auto-play makes your level-up and elite-spoils picks. Press P to take over.');
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
  if (c.kind === 'gear' && bagRoom(m) <= 0) return toast(BAG_FULL);
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
