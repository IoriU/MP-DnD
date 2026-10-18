// The bag (#inventory, key I): your three equipment slots, the bag and your potions. Outside a fight you can equip,
// unequip, give to a teammate and drop; during one it is read-only (consumables are used from the hotbar).
// Also the item and relic snippets the HUD, the map and the shop share.

import './inventory.css';
import { BAG_SIZE, ITEMS, RARITY_COLOR, RELICS, SLOTS, SLOT_NAME, bagRoom, isItemId, isRelicId, sellPrice, type ItemId, type Rarity, type RelicId } from '../shared/items.ts';
import { SKILLS, describeSkill, itemInfo } from '../shared/skills.ts';
import type { GameState, ItemRequest, PlayerEntity } from '../shared/types.ts';
import { send } from './net.ts';
import { me, store } from './store.ts';
import { $, esc } from './util.ts';

let open = false;
let giving: string | null = null; // 'potion' or an item id: waiting for "give to whom?"
let dropping: ItemId | null = null; // waiting for "drop it for good?"
let lastKey = '';

export const isInventoryOpen = () => open;

// ---------------------------------------------------------------- shared snippets

export const rarityColor = (r: Rarity) => RARITY_COLOR[r];

/** A relic is rare-ish or a boss reward: map it onto the item rarity colors. */
export const relicColor = (id: RelicId) => RARITY_COLOR[RELICS[id].rarity === 'boss' ? 'legendary' : RELICS[id].rarity === 'rare' ? 'rare' : 'common'];

/** Tooltip text for an item: name, rarity and slot, then what it does (and what it sells for, in a shop). */
export function itemTip(id: ItemId, extra = ''): string {
  const i = itemInfo(id);
  return `${i.name} · ${i.rarity}${i.slot ? ` ${SLOT_NAME[i.slot].toLowerCase()}` : ' consumable'}\n${i.desc}${extra}`;
}

/** The party's relics as icons with tooltips. */
export function relicsHtml(ids: readonly RelicId[]): string {
  return ids
    .filter(isRelicId)
    .map((id) => {
      const r = RELICS[id];
      return `<span class="relic ${r.rarity}" tabindex="0" role="img" aria-label="${esc(`${r.name}: ${r.desc}`)}" title="${esc(`${r.name}\n${r.desc}`)}">${r.icon}</span>`;
    })
    .join('');
}

/** Bag contents with duplicates folded into one entry each, in the order first picked up. */
export function bagGroups(bag: readonly ItemId[]): [ItemId, number][] {
  const out = new Map<ItemId, number>();
  for (const id of bag) if (isItemId(id)) out.set(id, (out.get(id) ?? 0) + 1);
  return [...out];
}

/** A hero's worn gear as small icons with tooltips (the party cards). */
export function gearIconsHtml(p: PlayerEntity): string {
  if (!SLOTS.some((slot) => p.gear?.[slot])) return '';
  return SLOTS.map((slot) => {
    const id = p.gear?.[slot];
    if (!id || !isItemId(id)) return `<span class="gear-ic empty" title="${SLOT_NAME[slot]}: empty">·</span>`;
    const i = itemInfo(id);
    return `<span class="gear-ic" title="${esc(`${SLOT_NAME[slot]}: ${itemTip(id)}`)}">${i.icon}</span>`;
  }).join('');
}

// ---------------------------------------------------------------- setup

export function toggleInventory(force?: boolean) {
  open = force ?? !open;
  giving = dropping = null;
  if (store.state) renderInventory(store.state);
  if (open) $('#inventory .inv-card')?.focus();
}

export function initInventory() {
  const view = $('#inventory');
  view.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t === view) return toggleInventory(false); // the backdrop
    const b = t.closest<HTMLButtonElement>('button[data-inv]');
    if (!b || b.disabled) return;
    const item = b.dataset.item as ItemId | undefined;
    const req = (r: ItemRequest) => {
      giving = dropping = null;
      send('item', r);
      if (store.state) renderInventory(store.state);
    };
    switch (b.dataset.inv) {
      case 'close':
        return toggleInventory(false);
      case 'equip':
        return item && req({ kind: 'equip', item });
      case 'unequip':
        return req({ kind: 'unequip', slot: b.dataset.slot as (typeof SLOTS)[number] });
      case 'give-open':
        giving = b.dataset.item ?? null;
        dropping = null;
        break;
      case 'give':
        return b.dataset.to && b.dataset.item && req({ kind: 'give', item: b.dataset.item as ItemId | 'potion', to: b.dataset.to });
      case 'drop-open':
        dropping = item ?? null;
        giving = null;
        break;
      case 'drop':
        return item && req({ kind: 'drop', item });
      case 'cancel':
        giving = dropping = null;
        break;
    }
    if (store.state) renderInventory(store.state);
  });
}

// ---------------------------------------------------------------- render

export function renderInventory(s: GameState) {
  const view = $('#inventory');
  const m = me();
  const playing = ['map', 'event', 'rest', 'shop', 'combat'].includes(s.phase);
  if (!m || !playing) open = false;
  view.hidden = !open;
  if (!open || !m) {
    lastKey = '';
    giving = dropping = null;
    return;
  }
  // A pending give or drop is dropped when its item is gone.
  if (giving && !(giving === 'potion' ? m.potions > 0 : m.bag.includes(giving as ItemId))) giving = null;
  if (dropping && !m.bag.includes(dropping)) dropping = null;

  const mates = s.entities.filter((e): e is PlayerEntity => e.kind === 'player' && e.id !== m.id && !e.dead);
  const fight = s.phase === 'combat';
  const key = JSON.stringify([s.phase, m.gear, m.bag, m.potions, mates.map((h) => [h.id, h.name, h.color]), giving, dropping, s.run?.gold]);
  if (key === lastKey) return;
  lastKey = key;
  const card = view.querySelector('.inv-card');
  const top = card?.scrollTop ?? 0;
  const hadFocus = !!card && card.contains(document.activeElement);
  view.innerHTML = inventoryHtml(s, m, mates, fight);
  const next = view.querySelector<HTMLElement>('.inv-card');
  if (next) {
    next.scrollTop = top;
    if (hadFocus || !card) next.focus();
  }
}

const why = (fight: boolean, extra = '') => (fight ? ' disabled title="Not during a fight"' : extra);

function inventoryHtml(s: GameState, m: PlayerEntity, mates: PlayerEntity[], fight: boolean): string {
  const room = bagRoom(m);
  const shop = s.phase === 'shop';

  const slotRows = SLOTS.map((slot) => {
    const id = m.gear[slot];
    if (!id || !isItemId(id)) {
      return `<li class="inv-row empty"><span class="inv-ic">▫️</span><span class="inv-main"><span class="inv-slot first">${SLOT_NAME[slot]}</span><span class="inv-desc">Nothing equipped.</span></span></li>`;
    }
    const noRoom = room <= 0;
    return itemRow(id, `<span class="inv-slot">${SLOT_NAME[slot]}</span>`, '', shop ? ` · sells for ${sellPrice(id)}` : '',
      `<button type="button" class="btn small" data-inv="unequip" data-slot="${slot}"${fight ? why(true) : noRoom ? ' disabled title="Your bag is full"' : ' title="Put it in your bag"'}>Unequip</button>`);
  }).join('');

  const groups = bagGroups(m.bag);
  const bagRows = groups
    .map(([id, n]) => {
      const def = ITEMS[id];
      const equip =
        def.kind === 'gear'
          ? (() => {
              const old = m.gear[def.slot];
              const title = old && isItemId(old) ? `Wear it instead of the ${itemInfo(old).name}` : `Wear it as your ${SLOT_NAME[def.slot].toLowerCase()}`;
              return `<button type="button" class="btn small primary" data-inv="equip" data-item="${id}"${fight ? why(true) : ` title="${esc(title)}"`}>Equip</button>`;
            })()
          : '';
      const give = `<button type="button" class="btn small" data-inv="give-open" data-item="${id}"${fight ? why(true) : mates.length ? '' : ' disabled title="No one else to give it to"'}>Give…</button>`;
      const drop = `<button type="button" class="btn small ghost" data-inv="drop-open" data-item="${id}"${fight ? why(true) : ' title="Throw it away"'}>Drop</button>`;
      const slot = def.kind === 'gear' ? `<span class="inv-slot">${SLOT_NAME[def.slot]}</span>` : '<span class="inv-slot">Consumable</span>';
      const sub = giving === id ? giveHtml(id, mates) : dropping === id ? dropHtml(id) : '';
      return itemRow(id, slot, n > 1 ? ` ×${n}` : '', shop ? ` · sells for ${sellPrice(id)}` : '', `${equip}${give}${drop}`, sub);
    })
    .join('');

  const potion = SKILLS.potion.base;
  const potionRow = `<li class="inv-row" title="${esc(`${potion.name}\n${describeSkill('potion', 1, undefined, m)}`)}">
      <span class="inv-ic">${potion.icon}</span>
      <span class="inv-main"><span><b>${esc(potion.name)}s</b> <span class="muted">×${m.potions}</span></span><span class="inv-desc">${esc(describeSkill('potion', 1, undefined, m))}</span></span>
      <span class="inv-acts"><button type="button" class="btn small" data-inv="give-open" data-item="potion"${fight ? why(true) : m.potions > 0 && mates.length ? '' : ` disabled title="${m.potions > 0 ? 'No one else to give it to' : 'No potions left'}"`}>Give…</button></span>
      ${giving === 'potion' ? giveHtml('potion', mates) : ''}
    </li>`;

  return `<div class="inv-card" role="dialog" aria-modal="true" aria-labelledby="inv-title" tabindex="-1">
    <header class="inv-head">
      <h2 id="inv-title">🎒 ${esc(m.name)}'s gear</h2>
      <span class="rv-pill gold" title="Party gold (shared)">💰 ${s.run?.gold ?? 0}</span>
      <button type="button" class="inv-close" data-inv="close" title="Close (I or Esc)" aria-label="Close">×</button>
    </header>
    ${fight ? '<p class="inv-note">Read-only during a fight. Use consumables from your hotbar.</p>' : ''}
    <h3 class="inv-sec">Equipped</h3>
    <ul class="inv-list">${slotRows}</ul>
    <h3 class="inv-sec">Bag <span class="inv-count${room <= 0 ? ' full' : ''}" title="Gear and consumables; potions are counted separately">${m.bag.length} / ${BAG_SIZE}</span></h3>
    <ul class="inv-list">${bagRows || '<li class="inv-row empty"><span class="inv-main"><span class="inv-desc">Empty. Elite fights drop gear, and shops sell it.</span></span></li>'}</ul>
    <h3 class="inv-sec">Potions</h3>
    <ul class="inv-list">${potionRow}</ul>
  </div>`;
}

function itemRow(id: ItemId, slotTag: string, count: string, extraTip: string, actions: string, sub = ''): string {
  const i = itemInfo(id);
  return `<li class="inv-row" title="${esc(itemTip(id, extraTip))}">
    <span class="inv-ic">${i.icon}</span>
    <span class="inv-main"><span><b style="color:${rarityColor(i.rarity)}">${esc(i.name)}</b><span class="muted">${count}</span> ${slotTag}</span><span class="inv-desc">${esc(i.desc)}</span></span>
    <span class="inv-acts">${actions}</span>
    ${sub}
  </li>`;
}

function giveHtml(item: string, mates: PlayerEntity[]): string {
  const who = mates
    .map((h) => `<button type="button" class="btn small" data-inv="give" data-item="${item}" data-to="${esc(h.id)}"><span class="rv-dot" style="background:${esc(h.color)}"></span> ${esc(h.name)}</button>`)
    .join('');
  return `<div class="inv-sub">Give to: ${who}<button type="button" class="btn small ghost" data-inv="cancel">Cancel</button></div>`;
}

function dropHtml(id: ItemId): string {
  return `<div class="inv-sub warn">Throw away the ${esc(itemInfo(id).name)} for good?
    <button type="button" class="btn small danger" data-inv="drop" data-item="${id}">Drop it</button>
    <button type="button" class="btn small ghost" data-inv="cancel">Keep</button></div>`;
}
