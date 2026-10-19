// Events: each ❓ event with its scene and, per act, its choices (labels, hints and costs; what a choice does is code).

import { getEvent } from '../../../server/events.ts';
import { ACTS } from '../../../shared/rules.ts';
import { DATA } from '../model.ts';
import { srcTag } from '../sources.ts';
import { chip, esc, icon, monsterChip, q, type TabDef } from '../ui.ts';

const actsLabel = (acts: number[]) => (acts.length === ACTS.length ? 'all acts' : `act ${acts.join(', ')}`);

/** The choices of an event in each act it can appear in; acts whose choices read the same are shown together (prices change by act). */
function choices(id: string, acts: number[]): string {
  const groups = new Map<string, { acts: number[]; list: { id: string; label: string; hint?: string; cost?: number }[] }>();
  for (const n of acts) {
    const list = (getEvent(id, n)?.choices ?? []).map(({ id, label, hint, cost }) => ({ id, label, hint, cost }));
    const key = JSON.stringify(list);
    const g = groups.get(key) ?? { acts: [], list };
    g.acts.push(n);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => `<div class="ev-choices">${groups.size > 1 ? `<h4>${actsLabel(g.acts)}</h4>` : ''}<ul>${g.list
      .map((c) => `<li><b>${esc(c.label)}</b>${c.hint ? ` <span class="muted">${esc(c.hint)}</span>` : ''}${c.cost ? ` ${chip(`${c.cost}g`, 'warn', 'The choice is only offered to a party with this much gold')}` : ''} <code>${c.id}</code></li>`)
      .join('')}</ul></div>`)
    .join('');
}

function row(id: string): string {
  const e = DATA.events.find((x) => x.id === id)!;
  const acts = e.acts ?? ACTS.map((_, i) => i + 1);
  const fight = DATA.eventFights[id];
  const labels = acts.flatMap((n) => getEvent(id, n)?.choices.map((c) => `${c.label} ${c.hint ?? ''}`) ?? []).join(' ');
  return `<details class="entry ev" data-id="${id}" data-act="${acts.join(' ')}" data-q="${q(e.title, id, e.text, labels)}">
    <summary>
      <span class="sk-ic">${icon(undefined, e.glyph, 28)}</span>
      <span class="sk-name"><b>${esc(e.title)}</b><code>${id}</code></span>
      <span class="sk-tags">${chip(actsLabel(acts), acts.length === ACTS.length ? 'dim' : 'pool')}${fight ? chip('fight', 'bad', 'Some choices can start a fight') : ''}</span>
      <span class="sk-desc">${esc(e.text)}</span>
    </summary>
    <div class="entry-body">
      <p class="scene">${esc(e.text)}</p>
      ${choices(id, acts)}
      ${fight ? `<p class="fights"><span class="muted">Fights can use:</span> <span class="chips">${fight.monsters.map((m) => monsterChip(m)).join('')}</span>${fight.pool ? chip("+ the act's regular monsters", 'dim') : ''}</p>` : ''}
      <div class="entry-foot">${srcTag('event', id)}</div>
    </div>
  </details>`;
}

export const events: TabDef = {
  id: 'events',
  label: 'Events',
  filters: [{ key: 'act', label: 'Act', options: ACTS.map((a, i): [string, string] => [String(i + 1), `${a.glyph} Act ${i + 1}`]) }],
  render: () =>
    `<p class="lead">Short text scenes the party votes on. Each ends with a safe way out. Prices scale with the act. A choice's effects are code in server/events.ts (the "fight" tag and monster list are read from its source text).</p>
    <div class="list">${DATA.events.map((e) => row(e.id)).join('')}</div>`,
};
