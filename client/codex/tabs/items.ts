// Items: gear, consumables, relics and blessings, with prices.

import {
  BLESSINGS, BLESSING_IDS, BLESSING_STATS, CONSUMABLE_IDS, CONSUMABLE_PRICE, ELITE_GEAR, FORGET_PRICE, GEAR_IDS, GEAR_PRICE, ITEMS, POTION_PRICE,
  RARITY_COLOR, RELICS, RELIC_IDS, RELIC_PRICE, RELIC_STATS, SELL_SHARE, SLOTS, SLOT_NAME, describeStats, gearDef, itemPrice, sellPrice, trainPrice,
  type GearStats, type Rarity,
} from '../../../shared/items.ts';
import { ACTS } from '../../../shared/rules.ts';
import { SKILLS, describeSkill, type SkillId } from '../../../shared/skills.ts';
import { ITEM_SPRITES } from '../../sprites.ts';
import { srcConst, srcTag } from '../sources.ts';
import { chip, esc, group, icon, kv, q, td, th, wrapTable, type TabDef } from '../ui.ts';

const rarity = (r: Rarity | 'boss') => `<span class="rarity" style="color:${RARITY_COLOR[r === 'boss' ? 'legendary' : r]}">${r}</span>`;
const sprite = (id: string) => (ITEM_SPRITES as Record<string, (typeof ITEM_SPRITES)[keyof typeof ITEM_SPRITES]>)[id];
const stats = (st: GearStats | undefined) => (st ? esc(describeStats(st)) : '');

const attrs = (id: string, sec: string, r: string, text: string, slot = '') => `data-id="${id}" data-sec="${sec}" data-rarity="${r}"${slot ? ` data-slot="${slot}"` : ''} data-q="${q(text, id, sec, r, slot)}"`;

function gear(): string {
  const rows = GEAR_IDS.map((id) => {
    const g = gearDef(id)!;
    return `<tr ${attrs(id, 'gear', g.rarity, `${g.name} ${describeStats(g.stats)} ${g.note ?? ''}`, g.slot)}>${td(icon(sprite(id), g.icon, 28))}${td(`<b>${esc(g.name)}</b>`, g.name)}${td(`<code>${id}</code>`)}${td(SLOT_NAME[g.slot], g.slot)}${td(rarity(g.rarity), g.rarity)}${td(stats(g.stats), undefined, 'wide')}${td(esc(g.note ?? ''), undefined, 'wide muted')}${td(`${itemPrice(id)}g <small class="muted">(sell ${sellPrice(id)})</small>`, itemPrice(id))}${td(srcTag('item', id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Name', 'str'), th('Id'), th('Slot', 'str'), th('Rarity', 'str'), th('Stats'), th('Note'), th('Price', 'num'), th('Source')].join(''), rows, 'sortable');
}

function consumables(): string {
  const rows = CONSUMABLE_IDS.map((id) => {
    const s = SKILLS[id as SkillId];
    const r = ITEMS[id].rarity;
    const rules = s ? describeSkill(id as SkillId) : '(no skill of this id: broken)';
    return `<tr ${attrs(id, 'consumable', r, `${s?.base.name ?? id} ${rules}`)}>${td(icon(sprite(id), s?.base.icon ?? '❓', 28))}${td(`<b>${esc(s?.base.name ?? id)}</b>`, s?.base.name ?? id)}${td(`<code>${id}</code>`)}${td(rarity(r), r)}${td(esc(rules), undefined, 'wide pre')}${td(`${itemPrice(id)}g`, itemPrice(id))}${td(`${srcTag('item', id)}${s ? srcTag('skill', id) : ''}`, undefined, 'tags')}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Name', 'str'), th('Id'), th('Rarity', 'str'), th('Rules'), th('Price', 'num'), th('Source (item, rules)')].join(''), rows, 'sortable');
}

function relics(): string {
  const rows = RELIC_IDS.map((id) => {
    const r = RELICS[id];
    return `<tr ${attrs(id, 'relic', r.rarity, `${r.name} ${r.desc}`)}>${td(icon(undefined, r.icon, 28))}${td(`<b>${esc(r.name)}</b>`, r.name)}${td(`<code>${id}</code>`)}${td(rarity(r.rarity), r.rarity)}${td(esc(r.desc), undefined, 'wide')}${td(RELIC_STATS[id] ? stats(RELIC_STATS[id]) : '<span class="muted">hook in server/game.ts</span>', undefined, 'wide')}${td(srcTag('relic', id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Name', 'str'), th('Id'), th('Rarity', 'str'), th('Effect'), th('Stat block'), th('Source')].join(''), rows, 'sortable');
}

function blessings(): string {
  const rows = BLESSING_IDS.map((id) => {
    const b = BLESSINGS[id];
    return `<tr ${attrs(id, 'blessing', 'blessing', `${b.name} ${b.desc}`)}>${td(icon(undefined, b.icon, 28))}${td(`<b>${esc(b.name)}</b>`, b.name)}${td(`<code>${id}</code>`)}${td(esc(b.desc), undefined, 'wide')}${td(BLESSING_STATS[id] ? stats(BLESSING_STATS[id]) : '<span class="muted">hook in server/game.ts</span>', undefined, 'wide')}${td(srcTag('blessing', id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Name', 'str'), th('Id'), th('Effect'), th('Stat block'), th('Source')].join(''), rows, 'sortable');
}

function prices(): string {
  const byRarity = (m: Record<Rarity, number>) => (Object.keys(m) as Rarity[]).map((r) => `${rarity(r)} ${m[r]}g`).join(' · ');
  return kv([
    ['Gear', byRarity(GEAR_PRICE), srcConst('GEAR_PRICE', 'items')],
    ['Consumables', byRarity(CONSUMABLE_PRICE), srcConst('CONSUMABLE_PRICE', 'items')],
    ['Relic', `${RELIC_PRICE}g`, srcConst('RELIC_PRICE', 'items')],
    ['Potion', `${POTION_PRICE}g`, srcConst('POTION_PRICE', 'items')],
    ['Forget a skill', `${FORGET_PRICE}g`, srcConst('FORGET_PRICE', 'items')],
    ['Train (upgrade a cantrip or spell)', ACTS.map((_, i) => `act ${i + 1}: ${trainPrice(i + 1)}g`).join(' · '), srcConst('trainPrice', 'items')],
    ['Sell back', `${SELL_SHARE * 100}% of the price`, srcConst('SELL_SHARE', 'items')],
    ['Elite spoils (gear rarity)', Object.entries(ELITE_GEAR).map(([a, r]) => `act ${a}: ${r.join(', ')}`).join(' · '), srcConst('ELITE_GEAR', 'items')],
  ]);
}

export const items: TabDef = {
  id: 'items',
  label: 'Items',
  filters: [
    { key: 'sec', label: 'Kind', options: [['gear', 'Gear'], ['consumable', 'Consumables'], ['relic', 'Relics'], ['blessing', 'Blessings']] },
    { key: 'slot', label: 'Slot', options: SLOTS.map((s): [string, string] => [s, SLOT_NAME[s]]) },
    { key: 'rarity', label: 'Rarity', options: [['common', 'common'], ['uncommon', 'uncommon'], ['rare', 'rare'], ['legendary', 'legendary'], ['boss', 'boss']] },
  ],
  render: () =>
    group('Gear', gear(), `${chip('1 weapon, 1 armor, 1 trinket per hero', 'dim')} Weapons change basic attacks whatever the class; stats are summed by gearBonus.`) +
    group('Consumables', consumables(), 'One use each, from the bag. Their rules are the skill of the same id.') +
    group('Relics', relics(), 'Party-wide perks for the rest of the run. Act bosses drop the boss relics.') +
    group('Blessings', blessings(), 'Party-wide perks until the end of the act.') +
    group('Prices', prices()),
};
