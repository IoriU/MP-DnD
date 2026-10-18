// The merchant (phase 'shop'): everyone browses at once and spends the party's gold, then clicks Done.
// Offers (gear, consumables, a relic, potions), selling from your bag, and two services: a lesson (upgrade a
// cantrip or spell, like Train at a rest) and forgetting a skill.

import { BAG_SIZE, RELICS, SLOT_NAME, bagRoom, isItemId, isRelicId, sellPrice, type ItemId, type RelicId } from '../shared/items.ts';
import { SKILLS, TIER_LABEL, describeSkill, itemInfo, skillTitle, statsOf, trainOptions, type SkillId } from '../shared/skills.ts';
import type { GameState, PlayerEntity, RunInfo, ShopOffer, ShopRequest, ShopView } from '../shared/types.ts';
import { bagGroups, itemTip, rarityColor, relicColor, relicsHtml, toggleInventory } from './inventory.ts';
import { send } from './net.ts';
import { isAuto, me, store } from './store.ts';
import { $, esc } from './util.ts';
import { timerHtml, trainHtml } from './runview.ts';

let shopKey = '';
let service: 'train' | 'forget' | null = null; // the open service panel
let forgetPick: SkillId | null = null; // a skill waiting for "forget it?"

const shopSend = (req: ShopRequest) => send('shop', req);

export function initShop() {
  const view = $('#shop-view');
  view.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-sh], button[data-rest="train"]');
    const s = store.state;
    if (!b || b.disabled || !s || s.phase !== 'shop') return;
    const skill = b.dataset.skill as SkillId | undefined;
    switch (b.dataset.sh ?? 'train') {
      case 'buy':
        return shopSend({ kind: 'buy', offer: Number(b.dataset.offer) });
      case 'sell':
        return shopSend({ kind: 'sell', item: b.dataset.item as ItemId });
      case 'train': // a button from the rest site's train picker
        if (!skill) return;
        service = null;
        shopSend({ kind: 'train', skill, ...(b.dataset.branch === 'A' || b.dataset.branch === 'B' ? { branch: b.dataset.branch } : {}) });
        return renderShop(s);
      case 'svc':
        service = service === b.dataset.svc ? null : (b.dataset.svc as typeof service);
        forgetPick = null;
        break;
      case 'forget-pick':
        forgetPick = skill ?? null;
        break;
      case 'forget':
        if (!skill) return;
        forgetPick = null;
        service = null;
        shopSend({ kind: 'forget', skill });
        break;
      case 'cancel':
        forgetPick = null;
        break;
      case 'done': {
        const done = !!store.playerId && s.shop?.done.includes(store.playerId);
        return shopSend({ kind: 'done', done: !done });
      }
      case 'bag':
        return toggleInventory(true);
    }
    renderShop(s);
  });
}

// ---------------------------------------------------------------- render

const sig = (el: HTMLElement) => [el.dataset.sh ?? `r:${el.dataset.rest}`, el.dataset.offer, el.dataset.item, el.dataset.skill, el.dataset.branch, el.dataset.svc].join('|');

export function renderShop(s: GameState): void {
  const view = $('#shop-view');
  if (s.phase !== 'shop' || !s.shop || !s.run) {
    view.hidden = true;
    shopKey = '';
    service = forgetPick = null;
    return;
  }
  const shop = s.shop;
  const run = s.run;
  const m = me();
  // Close service panels that can't be used any more (spent the gold, nothing left to train, skill gone).
  if (service === 'train' && (!m || run.gold < shop.trainPrice || !trainOptions(m).length)) service = null;
  if (service === 'forget' && (!m || run.gold < shop.forgetPrice || !forgettable(m).length)) service = null;
  if (forgetPick && !m?.skills.some((o) => o.id === forgetPick)) forgetPick = null;

  view.hidden = false;
  const key = JSON.stringify([
    store.playerId,
    shop.offers, shop.forgetPrice, shop.trainPrice, shop.done, shop.endsInMs === null,
    run.gold, run.relics, service, forgetPick,
    m && [m.bag, m.gear, m.potions, m.level, m.skills.map((o) => [o.id, o.tier, o.branch])],
    s.players.map((p) => [p.id, p.name, p.color, p.connected, p.auto, p.bot]),
  ]);
  if (key === shopKey) return;
  shopKey = key;

  const a = document.activeElement;
  const focused = a && view.contains(a) ? a.closest<HTMLElement>('[data-sh], [data-rest]') : null;
  const focusSig = focused ? sig(focused) : null;
  const scroll = view.querySelector('.sh-scroll')?.scrollTop ?? 0;
  view.innerHTML = shopHtml(s, shop, run, m);
  const body = view.querySelector('.sh-scroll');
  if (body) body.scrollTop = scroll;
  if (focusSig) for (const el of view.querySelectorAll<HTMLElement>('[data-sh], [data-rest]')) if (sig(el) === focusSig && !(el as HTMLButtonElement).disabled) return el.focus();
}

const forgettable = (m: PlayerEntity) => m.skills.filter((o) => SKILLS[o.id].kind !== 'basic');

/** Why I can't buy this, or null. */
function buyReason(o: ShopOffer, m: PlayerEntity | undefined, run: RunInfo): string | null {
  if (!m) return 'No hero to buy for';
  if (o.left <= 0) return 'Sold out';
  if (o.kind === 'relic' && run.relics.includes(o.id as RelicId)) return 'Already owned';
  if (o.kind === 'item' && bagRoom(m) <= 0) return 'Bag full';
  if (o.price > run.gold) return `Need ${o.price - run.gold} more gold`;
  return null;
}

interface OfferView {
  icon: string;
  name: string;
  color: string;
  tag: string;
  desc: string;
  note: string;
  tip: string;
}

function offerView(o: ShopOffer, m: PlayerEntity | undefined): OfferView | null {
  if (o.kind === 'item' && isItemId(o.id)) {
    const i = itemInfo(o.id);
    const worn = i.slot && m?.gear[i.slot];
    return {
      icon: i.icon, name: i.name, color: rarityColor(i.rarity), desc: i.desc, tip: itemTip(o.id, `\nSells for ${sellPrice(o.id)} gold.`),
      tag: `${i.slot ? SLOT_NAME[i.slot] : 'Consumable'} · ${i.rarity}`,
      note: worn && isItemId(worn) ? `You wear: ${itemInfo(worn).name}` : '',
    };
  }
  if (o.kind === 'relic' && isRelicId(o.id)) {
    const r = RELICS[o.id];
    return { icon: r.icon, name: r.name, color: relicColor(o.id), desc: r.desc, tip: `${r.name}\n${r.desc}`, tag: 'Relic · helps the whole party', note: '' };
  }
  if (o.kind === 'potion') {
    const p = SKILLS.potion.base;
    const desc = describeSkill('potion', 1, undefined, m);
    return { icon: p.icon, name: p.name, color: '#c9d1d9', desc, tip: `${p.name}\n${desc}`, tag: 'Consumable', note: m ? `You have ${m.potions}` : '' };
  }
  return null;
}

const GROUPS: { title: string; has: (o: ShopOffer) => boolean }[] = [
  { title: '⚔️ Equipment', has: (o) => o.kind === 'item' && isItemId(o.id) && !!itemInfo(o.id).slot },
  { title: '🧪 Consumables', has: (o) => o.kind === 'item' && isItemId(o.id) && !itemInfo(o.id).slot },
  { title: '🏺 Relic', has: (o) => o.kind === 'relic' },
  { title: '🧴 Potions', has: (o) => o.kind === 'potion' },
];

function offerRow(o: ShopOffer, i: number, m: PlayerEntity | undefined, run: RunInfo): string {
  const v = offerView(o, m);
  if (!v) return '';
  const reason = buyReason(o, m, run);
  return `<li class="sh-row${o.left <= 0 ? ' sold' : ''}" title="${esc(v.tip)}">
    <span class="sh-ic">${v.icon}</span>
    <span class="sh-main">
      <span><b style="color:${v.color}">${esc(v.name)}</b> <span class="sh-tag">${esc(v.tag)}</span></span>
      <span class="sh-desc">${esc(v.desc)}</span>
      ${v.note ? `<span class="sh-note">${esc(v.note)}</span>` : ''}
    </span>
    <span class="sh-buy">
      <span class="sh-price" title="Price (the party's gold)">💰 ${o.price}</span>
      <span class="sh-left">${o.left > 0 ? `${o.left} left` : 'sold out'}</span>
      <button type="button" class="btn small primary" data-sh="buy" data-offer="${i}"${reason ? ` disabled title="${esc(reason)}"` : ''}>Buy</button>
      ${reason && o.left > 0 ? `<span class="sh-why">${esc(reason)}</span>` : ''}
    </span>
  </li>`;
}

function sellRows(m: PlayerEntity): string {
  return bagGroups(m.bag)
    .map(([id, n]) => {
      const i = itemInfo(id);
      return `<li class="sh-row sell" title="${esc(itemTip(id))}">
        <span class="sh-ic">${i.icon}</span>
        <span class="sh-main"><span><b style="color:${rarityColor(i.rarity)}">${esc(i.name)}</b>${n > 1 ? ` <span class="muted">×${n}</span>` : ''} <span class="sh-tag">${i.slot ? SLOT_NAME[i.slot] : 'Consumable'}</span></span></span>
        <span class="sh-buy"><button type="button" class="btn small" data-sh="sell" data-item="${id}" title="Sell one for ${sellPrice(id)} gold">Sell 💰 +${sellPrice(id)}</button></span>
      </li>`;
    })
    .join('');
}

function forgetRows(m: PlayerEntity, shop: ShopView): string {
  const picked = forgetPick ? m.skills.find((o) => o.id === forgetPick) : undefined;
  if (picked) {
    return `<div class="sh-confirm"><span>Forget <b>${statsOf(picked).icon} ${esc(skillTitle(picked))}</b> for 💰 ${shop.forgetPrice}? It can't be undone (you can learn skills again when you level up).</span>
      <span class="sh-confirm-btns"><button type="button" class="btn small danger" data-sh="forget" data-skill="${picked.id}">Forget it</button><button type="button" class="btn small ghost" data-sh="cancel">Keep it</button></span></div>`;
  }
  return forgettable(m)
    .map((o) => {
      const st = statsOf(o);
      const desc = describeSkill(o.id, o.tier, o.branch, m);
      return `<button type="button" class="rv-choice" data-sh="forget-pick" data-skill="${o.id}">
        <span class="rv-choice-main"><span class="rv-choice-label">${st.icon} ${esc(skillTitle(o))} <span class="muted">(${SKILLS[o.id].kind}${SKILLS[o.id].t2 ? `, tier ${TIER_LABEL(o.tier, o.branch)}` : ''})</span></span><span class="rv-choice-hint rv-pre">${esc(desc)}</span></span>
      </button>`;
    })
    .join('');
}

function servicesHtml(m: PlayerEntity | undefined, shop: ShopView, run: RunInfo): string {
  if (!m) return '';
  const train = trainOptions(m);
  const forget = forgettable(m);
  const reason = (price: number, none: string | null) => (none ?? (run.gold < price ? `Need ${price - run.gold} more gold` : null));
  const trainWhy = reason(shop.trainPrice, train.length ? null : 'Nothing to train right now (tier III needs a higher level)');
  const forgetWhy = reason(shop.forgetPrice, forget.length ? null : 'Nothing to forget');
  const svc = (id: 'train' | 'forget', label: string, price: number, hint: string, blocked: string | null) =>
    `<button type="button" class="rv-choice${service === id ? ' mine' : ''}" data-sh="svc" data-svc="${id}" aria-pressed="${service === id}"${blocked ? ` disabled title="${esc(blocked)}"` : ''}>
      <span class="rv-choice-main"><span class="rv-choice-label">${label} <span class="sh-price">💰 ${price}</span></span><span class="rv-choice-hint">${esc(blocked ?? hint)}</span></span>
    </button>`;
  return `<div class="sh-sec">
    <div class="sh-head">🧰 Services <span class="muted">for ${esc(m.name)}</span></div>
    <div class="rv-choices">
      ${svc('train', '📚 Lesson', shop.trainPrice, 'Upgrade one cantrip or spell a tier.', trainWhy)}
      ${service === 'train' ? `<div class="sh-svc">${train.map((o) => trainHtml(m, o, undefined)).join('')}</div>` : ''}
      ${svc('forget', '🗑️ Forget a skill', shop.forgetPrice, 'Free up a slot: forget a cantrip, spell or passive.', forgetWhy)}
      ${service === 'forget' ? `<div class="sh-svc">${forgetRows(m, shop)}</div>` : ''}
    </div>
  </div>`;
}

function peopleHtml(s: GameState, shop: ShopView): string {
  return s.players
    .map((p) => {
      const auto = isAuto(s, p.id);
      const done = shop.done.includes(p.id);
      const you = p.id === store.playerId ? ' <span class="muted">(you)</span>' : '';
      const state = auto ? '<span class="muted" title="Auto-play shops once the people are done">🤖 shops last</span>' : done ? '<span class="sh-done">✓ Done</span>' : '<span class="muted">shopping…</span>';
      return `<li><span class="rv-dot" style="background:${esc(p.color)}"></span><b>${esc(p.name)}</b>${you}<span class="rv-pick">${state}</span></li>`;
    })
    .join('');
}

function shopHtml(s: GameState, shop: ShopView, run: RunInfo, m: PlayerEntity | undefined): string {
  const offers = GROUPS.map((g) => {
    const rows = shop.offers.map((o, i) => (g.has(o) ? offerRow(o, i, m, run) : '')).join('');
    return rows ? `<div class="sh-sec"><div class="sh-head">${g.title}</div><ul class="sh-list">${rows}</ul></div>` : '';
  }).join('');

  const people = s.players.filter((p) => !isAuto(s, p.id));
  const doneCount = people.filter((p) => shop.done.includes(p.id)).length;
  const mine = !!store.playerId && shop.done.includes(store.playerId);
  const sell = m
    ? `<div class="sh-sec">
        <div class="sh-head">💱 Sell <span class="muted">half price · your bag ${m.bag.length}/${BAG_SIZE}</span>
          <button type="button" class="btn small ghost sh-bag" data-sh="bag" title="Equip, give or drop (I)">🎒 Open bag <kbd>I</kbd></button></div>
        <ul class="sh-list">${sellRows(m) || '<li class="sh-empty">Your bag is empty.</li>'}</ul>
        <div class="sh-hint">Worn gear isn't sold from here: open the bag and unequip it first.</div>
      </div>`
    : '';

  return `<div class="rv-event-panel sh-panel" role="dialog" aria-labelledby="sh-title">
    <header class="sh-top">
      <span class="sh-glyph">🛒</span>
      <div class="sh-titles"><h2 id="sh-title" class="rv-event-title">The merchant</h2><div class="muted">One purse for the whole party. Everyone shops at once.</div></div>
      <span class="rv-pill gold" title="Party gold (shared)">💰 ${run.gold}</span>
    </header>
    ${run.relics.length ? `<div class="rv-relics sh-relics" title="The party's relics">${relicsHtml(run.relics)}</div>` : ''}
    <div class="sh-scroll">
      ${offers}
      ${sell}
      ${servicesHtml(m, shop, run)}
      <ul class="rv-picks">${peopleHtml(s, shop)}</ul>
    </div>
    <footer class="rv-event-foot sh-foot">
      <span class="rv-sub"><span class="rv-status${mine ? '' : ' go'}">${mine ? 'Waiting for the party…' : 'Spend your gold, then click Done.'}</span><span class="rv-progress">${doneCount}/${people.length} done</span></span>
      <span class="rv-stats">${timerHtml(shop, 'Time left. When it ends the party moves on.')}
        <button type="button" class="btn ${mine ? 'gold' : 'primary'}" data-sh="done" aria-pressed="${mine}">${mine ? '✓ Done (keep shopping)' : '✔ Done shopping'}</button></span>
    </footer>
  </div>`;
}
