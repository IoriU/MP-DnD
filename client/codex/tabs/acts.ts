// Acts & encounters: per act, the regular pool, encounter templates, elites with their escorts, and the boss with its minions.

import { ACTS, ACT_ROWS, MONSTERS, type ActDef } from '../../../shared/rules.ts';
import { DATA } from '../model.ts';
import { srcTag } from '../sources.ts';
import { esc, monsterChip, q, td, th, wrapTable, type TabDef } from '../ui.ts';

/** Monster ids as chips, a repeated id once with its count ("goblin" twice -> Goblin ×2). */
const chips = (ids: string[]) => [...new Set(ids)].map((id) => monsterChip(id, ids.filter((x) => x === id).length)).join('');

function encounters(act: ActDef, n: number): string {
  const rows = act.encounters.map((e) => {
    const threat = e.monsters.reduce((s, id) => s + (MONSTERS[id]?.threat ?? 0), 0);
    const names = e.monsters.map((id) => MONSTERS[id]?.name ?? id).join(' ');
    return `<tr data-act="${n}" data-q="${q(e.name, names, e.monsters.join(' '))}">${td(`<b>${esc(e.name)}</b>`)}${td(`<div class="chips">${chips(e.monsters)}</div>`)}${td(e.minRow ? `row ${e.minRow}+` : 'any row', e.minRow ?? 0)}${td(threat, threat)}${td(srcTag('encounter', e.name))}</tr>`;
  }).join('');
  return wrapTable([th('Template'), th('Monsters'), th('From', 'num'), th('Threat', 'num'), th('Source')].join(''), rows, 'sortable');
}

function card(act: ActDef, i: number): string {
  const n = i + 1;
  const events = DATA.events.filter((e) => !e.acts || e.acts.includes(n)).length;
  const elites = act.elites
    .map((el) => `<div class="elite-row">${monsterChip(el)}<span class="muted">escorts</span><div class="chips">${chips(act.escorts[el] ?? [])}</div></div>`)
    .join('');
  const everything = [act.name, ...act.pool, ...act.elites, act.boss, ...act.minions, ...act.encounters.flatMap((e) => [e.name, ...e.monsters])].map((id) => `${id} ${MONSTERS[id]?.name ?? ''}`).join(' ');
  return `<article class="card act" data-act="${n}" data-q="${q(everything)}">
    <header class="act-head"><span class="act-glyph">${act.glyph}</span><div><h2>Act ${n}: ${esc(act.name)}</h2><small class="muted">${act.encounters.length} encounter templates · ${act.pool.length} regular monsters · ${events} events · ${ACT_ROWS} map rows</small></div>${srcTag('act', act.name)}</header>
    <h3>Regular pool</h3><p class="muted note">Every regular monster of the act (events draw from it).</p>
    <div class="chips">${chips(act.pool)}</div>
    <h3>Encounter templates</h3>
    <p class="muted note">The fight draws monsters from the list until the threat budget runs out; a type listed twice is twice as common.</p>
    ${encounters(act, n)}
    <h3>Elites</h3>${elites}
    <h3>Boss</h3>
    <div class="elite-row">${monsterChip(act.boss)}<span class="muted">minions</span><div class="chips">${chips(act.minions)}</div></div>
  </article>`;
}

export const acts: TabDef = {
  id: 'acts',
  label: 'Acts & encounters',
  filters: [{ key: 'act', label: 'Act', options: ACTS.map((a, i): [string, string] => [String(i + 1), `${a.glyph} Act ${i + 1}`]) }],
  render: () => `<div class="stack">${ACTS.map(card).join('')}</div>`,
};
