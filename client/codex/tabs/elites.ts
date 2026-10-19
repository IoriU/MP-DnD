// Elites & allies: the elite traits and the NPC allies, with their numbers.

import {
  ALLIES, ALLY_FIGHTS, ALLY_IDS, AURA_DICE, ENRAGED_DMG, MAX_ALLIES, MAX_SUMMONS, SUMMON_EVERY, TRAITS, TRAIT_IDS, WARD_EVERY, WARD_SHARE, allyScaling, traitCount,
} from '../../../shared/elites.ts';
import { ACTS, CHARGE_MOVES, HELP, MONSTERS, ORDERS, ORDER_EVERY, ORDER_RANGE, ORDER_STATUS, ROLES, diceText, roleOf, type OrderId } from '../../../shared/rules.ts';
import { MONSTER_SPRITES } from '../../sprites.ts';
import { srcConst, srcTag } from '../sources.ts';
import { chip, esc, group, icon, kv, monsterChip, q, statusText, td, th, wrapTable, type TabDef } from '../ui.ts';

function traitCards(): string {
  return `<div class="grid cards small">${TRAIT_IDS.map((id) => {
    const t = TRAITS[id];
    return `<article class="card trait" data-id="${id}" data-q="${q(t.name, id, t.desc, t.aura)}"><header class="trait-head"><span class="emoji big">${t.icon}</span><div><h3>${esc(t.name)}</h3><code>${id}</code></div>${srcTag('trait', id)}</header>
      <p>${esc(t.desc)}</p>${t.aura ? chip(`aura: ${t.aura}`, 'warn', 'Its attacks deal this element, it scorches whoever stands next to it, and it is immune to it') : ''}</article>`;
  }).join('')}</div>`;
}

const traitNumbers = () =>
  kv([
    ['Aura damage', `${diceText(AURA_DICE)} to everyone next to it`, srcConst('AURA_DICE', 'elites')],
    ['Shielded ward', `${WARD_SHARE * 100}% of max HP, back every ${WARD_EVERY} rounds`, srcConst('WARD_SHARE', 'elites')],
    ['Summoner', `a minion every ${SUMMON_EVERY} rounds, ${MAX_SUMMONS} at most`, srcConst('SUMMON_EVERY', 'elites')],
    ['Enraged', `+${ENRAGED_DMG} damage (and an extra attack) below half HP`, srcConst('ENRAGED_DMG', 'elites')],
    ...ACTS.map((_, i): [string, string, string] => {
      const lo = traitCount(i + 1, 0);
      const hi = traitCount(i + 1, 0.99);
      return [`Traits on an act ${i + 1} elite`, lo === hi ? String(lo) : `${lo} or ${hi}`, srcConst('traitCount', 'elites')];
    }),
  ]);

/** Leaders (elites and bosses with `leader`) and the orders they shout. */
function orders(): string {
  const rows = (Object.keys(ORDERS) as OrderId[]).map((id) => {
    const o = ORDERS[id];
    return `<tr data-id="${id}" data-q="${q(o.name, id, o.desc, 'order leader', ORDER_STATUS[id].map((x) => x.id).join(' '))}">${td(`<span class="emoji">${o.icon}</span>`)}${td(`<b>${esc(o.name)}</b>`)}${td(`<code>${id}</code>`)}${td(esc(o.desc), undefined, 'wide')}${td(ORDER_STATUS[id].map((x) => esc(statusText(x))).join('<br>'), undefined, 'wide')}${td(srcTag('order', id))}</tr>`;
  }).join('');
  const leaders = Object.entries(MONSTERS).filter(([, m]) => m.leader).map(([id]) => monsterChip(id)).join('');
  return `${wrapTable([th(''), th('Order'), th('Id'), th('Effect'), th('Statuses applied'), th('Source')].join(''), rows)}
    <p class="note"><span class="muted">Leaders:</span> <span class="chips">${leaders}</span></p>${kv([
      ['Order range', `${ORDER_RANGE} tiles`, srcConst('ORDER_RANGE')],
      ['Orders', `a free shout at the start of the leader's turn: on its first turn, then every ${ORDER_EVERY} turns`, srcConst('ORDER_EVERY')],
      ['Charge', `+${CHARGE_MOVES} movement on the next turn`, srcConst('CHARGE_MOVES')],
      ['Help action', `instead of attacking, a melee monster (or NPC ally) gets in a hero's face: ${statusText(HELP)}, so the next attack against them has advantage`, srcConst('HELP')],
    ])}`;
}

function allyCards(): string {
  return `<div class="grid cards">${ALLY_IDS.map((id) => {
    const a = ALLIES[id];
    const m = MONSTERS[a.monster];
    const flags = [a.heals && chip('heals', 'good', 'Heals the most hurt hero in range instead of attacking, when someone needs it'), a.hunts && chip('hunts casters', 'warn', 'Goes for the enemy archers and casters first')].filter(Boolean);
    const rows = ACTS.map((_, i) => {
      const s = allyScaling(i + 1);
      const dmg = { ...m.dmg, bonus: (m.dmg.bonus ?? 0) + s.dmg };
      return `<tr>${td(`Act ${i + 1}`)}${td(Math.round(m.hp * s.hp))}${td(`+${m.atk + s.atk}`)}${td(diceText(dmg))}</tr>`;
    }).join('');
    return `<article class="card ally" data-id="${id}" data-q="${q(id, a.monster, m?.name, a.desc, a.names.join(' '))}">
      <header class="hero-head">${icon(MONSTER_SPRITES[a.monster], m?.glyph ?? '❓', 48)}<div><h3>${esc(m?.name ?? a.monster)}</h3><code>${id}</code> <small class="muted">stat block <code>${a.monster}</code></small></div>${srcTag('ally', id)}</header>
      <p>${esc(a.desc)}</p>
      <div class="chips">${chip(`${ROLES[roleOf(m)].icon} ${ROLES[roleOf(m)].name}`)}${m.range > 1 ? chip(`range ${m.range}`) : chip('melee')}${chip(`speed ${m.speed}`)}${chip(`AC ${m.ac}`)}${flags.join('')}</div>
      <p class="muted note">Names: ${a.names.map(esc).join(', ')}</p>
      <div class="table-wrap"><table class="kv"><thead><tr><th></th><th>HP</th><th>Attack</th><th>Damage</th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
  }).join('')}</div>`;
}

export const elites: TabDef = {
  id: 'elites',
  label: 'Elites & allies',
  render: () =>
    group('Elite traits', traitCards(), 'An elite gets traits by act (below). The aura traits also make it immune to their element.') +
    group('Trait numbers', traitNumbers()) +
    group('Leaders and orders', orders(), 'A leader gives its side orders (Phase 12). The help action works for every monster that can melee (and not support) and for NPC allies.') +
    group('NPC allies', allyCards(), `An ally fights for the party for ${ALLY_FIGHTS} fights, ${MAX_ALLIES} at most at a time. They are monsters (Monsters tab) that grow with the act: more HP, better aim, harder hits.`),
};
