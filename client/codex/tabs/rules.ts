// Rules: statuses, the battlefield (grounds, clouds, props, element reactions) and monster roles.

import { MONSTERS, NODE_INFO, ROLES, diceText, roleOf } from '../../../shared/rules.ts';
import { CLEANSED, ROOTED, SKIP_TURN, SLOWED, STATUSES, type StatusId } from '../../../shared/skills.ts';
import {
  CLOUDS, COMBOS, EXPLOSION, ELECTRIFIED, FIELD_STATUS_TURNS, GROUNDS, HAZARD_DICE, ICE_DC, OIL_FIRE_TURNS, PROPS, REACTIONS, SHOCK_TURNS, type CloudId, type GroundId,
  type LayerInfo, type PropId,
} from '../../../shared/surfaces.ts';
import { statusUsage } from '../data.ts';
import { DATA } from '../model.ts';
import { srcConst, srcTag } from '../sources.ts';
import { chip, esc, group, kv, q, td, th, wrapTable, type TabDef } from '../ui.ts';

const attrs = (id: string, sec: string, ...text: string[]) => `data-id="${id}" data-sec="${sec}" data-q="${q(...text, id, sec)}"`;
const swatch = (color: string) => `<span class="swatch" style="background:${color}"></span>`;

function statuses(): string {
  const used = statusUsage(DATA);
  const rows = (Object.keys(STATUSES) as StatusId[]).map((id) => {
    const s = STATUSES[id];
    const flags = [SKIP_TURN.includes(id) && chip('skips a turn', 'warn'), SLOWED.includes(id) && chip('slows', 'warn'), ROOTED.includes(id) && chip('rooted', 'warn', "Can't move; Cut Free (or fire, for a web) gets out of it"), CLEANSED.includes(id) && chip('cleansed', 'good', 'Removed by Lay on Hands and other cleanses')].filter(Boolean);
    const by = used.get(id) ?? [];
    const shown = by.slice(0, 6).map(esc).join(', ');
    return `<tr ${attrs(id, 'status', s.name, s.desc, s.good ? 'buff' : 'debuff')}>${td(`<span class="emoji">${s.icon}</span>`)}${td(`<b>${esc(s.name)}</b>`, s.name)}${td(`<code>${id}</code>`)}${td(s.good ? chip('buff', 'good') : chip('debuff', 'bad'), s.good ? 'buff' : 'debuff')}${td(esc(s.desc), undefined, 'wide')}${td(flags.join(' '), undefined, 'chips')}${td(by.length ? `${shown}${by.length > 6 ? ` <span class="muted">+${by.length - 6} more</span>` : ''}` : '<span class="bad-text">never</span>', undefined, 'wide muted')}${td(srcTag('status', id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Status', 'str'), th('Id'), th('Kind', 'str'), th('Effect'), th('Flags'), th('Applied by'), th('Source')].join(''), rows, 'sortable');
}

function layers<T extends string>(sec: string, defs: Record<T, LayerInfo>, kind: 'ground' | 'cloud'): string {
  const rows = (Object.keys(defs) as T[]).map((id) => {
    const l = defs[id];
    return `<tr ${attrs(id, sec, l.name, l.desc)}>${td(`${swatch(l.color)}<span class="emoji">${l.icon}</span>`)}${td(`<b>${esc(l.name)}</b>`)}${td(`<code>${id}</code>`)}${td(l.turns ? `${l.turns} rounds` : 'never made by skills')}${td(esc(l.desc), undefined, 'wide')}${td(srcTag(kind, id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Name'), th('Id'), th('Lasts'), th('Effect'), th('Source')].join(''), rows);
}

function props(): string {
  const rows = (Object.keys(PROPS) as PropId[]).map((id) => {
    const p = PROPS[id];
    return `<tr ${attrs(id, 'prop', p.name, p.desc)}>${td(`<span class="emoji">${p.icon}</span>`)}${td(`<b>${esc(p.name)}</b>`)}${td(`<code>${id}</code>`)}${td(esc(p.desc), undefined, 'wide')}${td(srcTag('prop', id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Name'), th('Id'), th('Effect'), th('Source')].join(''), rows);
}

const electrified = () =>
  `<div class="table-wrap"><table><tbody><tr ${attrs('electrified', 'ground', ELECTRIFIED.name, ELECTRIFIED.desc)}>${td(`${swatch(ELECTRIFIED.color)}<span class="emoji">${ELECTRIFIED.icon}</span>`)}${td(`<b>${ELECTRIFIED.name}</b>`)}${td('<code>electrified</code>')}${td('shock rounds')}${td(esc(ELECTRIFIED.desc), undefined, 'wide')}${td(srcConst('ELECTRIFIED', 'surfaces'))}</tr></tbody></table></div>`;

function combos(): string {
  const rows = COMBOS.map((c) => `<tr ${attrs(c.on.toLowerCase().replace(/\W+/g, '_'), 'combo', c.on, c.fire ?? '', c.cold ?? '', c.lightning ?? '', c.water ?? '')}>${td(`<b>${esc(c.on)}</b>`)}${(['fire', 'cold', 'lightning', 'water'] as const).map((k) => td(c[k] ? esc(c[k]!) : '<span class="muted">—</span>')).join('')}</tr>`).join('');
  return `${wrapTable([th('On the tile'), th('🔥 Fire'), th('❄️ Cold'), th('⚡ Lightning'), th('💧 Water')].join(''), rows, 'combos')}
    <p class="muted note">The combo table lives in ${srcConst('COMBOS', 'surfaces')}; applyField is the real implementation.</p>`;
}

function reactions(): string {
  const rows = Object.entries(REACTIONS).map(([id, r]) => `<tr ${attrs(id, 'reaction', r.text, r.log)}>${td(`<b style="color:${r.color}">${esc(r.text)}</b>`)}${td(`<code>${id}</code>`)}${td(esc(r.log), undefined, 'wide')}</tr>`).join('');
  return wrapTable([th('Pop-up'), th('Id'), th('Log line')].join(''), rows);
}

const surfaceNumbers = () =>
  kv([
    ['Explosion', `${diceText(EXPLOSION)} fire to everyone within 1 tile`, srcConst('EXPLOSION', 'surfaces')],
    ['Ice', `DEX save DC ${ICE_DC} when stepping on it`, srcConst('ICE_DC', 'surfaces')],
    ...(Object.entries(HAZARD_DICE) as [GroundId | CloudId | 'shock', { n: number; d: number }][]).map(([k, dice]): [string, string, string] => [`Hazard: ${k}`, `${diceText(dice)} when you step in or start your turn there`, srcConst('HAZARD_DICE', 'surfaces')]),
    ['Shock', `electrified water and steam last ${SHOCK_TURNS} round`, srcConst('SHOCK_TURNS', 'surfaces')],
    ['Burning oil', `${OIL_FIRE_TURNS} rounds`, srcConst('OIL_FIRE_TURNS', 'surfaces')],
    ['Field statuses', `last ${FIELD_STATUS_TURNS} of the creature's turns`, srcConst('FIELD_STATUS_TURNS', 'surfaces')],
  ]);

function roles(): string {
  const rows = Object.entries(ROLES).map(([id, r]) => {
    const who = Object.entries(MONSTERS).filter(([, m]) => roleOf(m) === id).map(([, m]) => m.name);
    return `<tr ${attrs(id, 'role', r.name, r.desc, who.join(' '))}>${td(`<span class="emoji">${r.icon}</span>`)}${td(`<b>${r.name}</b>`)}${td(`<code>${id}</code>`)}${td(esc(r.desc), undefined, 'wide')}${td(who.map(esc).join(', '), undefined, 'wide muted')}${td(srcTag('role', id))}</tr>`;
  }).join('');
  return wrapTable([th(''), th('Role'), th('Id'), th('How it fights'), th('Monsters'), th('Source')].join(''), rows);
}

const nodes = () => `<div class="chips">${Object.entries(NODE_INFO).map(([id, n]) => `<span class="chip" data-q="${q(n.name, id, 'map node')}" data-sec="node" title="${id}">${n.icon} ${n.name}</span>`).join('')}</div>`;

export const rules: TabDef = {
  id: 'rules',
  label: 'Rules',
  filters: [{ key: 'sec', label: 'Section', options: [['status', 'Statuses'], ['ground', 'Grounds'], ['cloud', 'Clouds'], ['prop', 'Props'], ['combo', 'Combos'], ['reaction', 'Reactions'], ['role', 'Roles'], ['node', 'Map nodes']] }],
  render: () =>
    group('Statuses', statuses(), 'Durations drop by 1 at the end of each of the creature\'s turns. Burning and Poisoned deal their damage at the start of its turn.') +
    group('Grounds', layers('ground', GROUNDS, 'ground') + electrified(), 'The ground layer. Fire, cold and lightning react with it.') +
    group('Clouds', layers('cloud', CLOUDS, 'cloud'), 'The layer above the ground.') +
    group('Props', props(), 'Stand on wall tiles: they block movement and sight.') +
    group('Element combos', combos()) +
    group('Reactions', reactions(), 'The pop-up text and log line of each reaction.') +
    group('Surface numbers', surfaceNumbers()) +
    group('Monster roles', roles(), 'How a monster fights (server/monsterai.ts). Default: archer if it shoots, else brute.') +
    group('Map nodes', nodes()),
};
