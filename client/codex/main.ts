// The Codex page: tabs, a search box and per-tab filters over the game's content. Read-only: editing happens in code.
// The hash holds the tab and its filters (#skills?pool=wizard&q=fire), so any view can be linked.

import { $, loadPref, savePref } from '../util.ts';
import './codex.css';
import { acts } from './tabs/acts.ts';
import { elites } from './tabs/elites.ts';
import { events } from './tabs/events.ts';
import { heroes } from './tabs/heroes.ts';
import { items } from './tabs/items.ts';
import { monsters } from './tabs/monsters.ts';
import { overview } from './tabs/overview.ts';
import { rules } from './tabs/rules.ts';
import { skills } from './tabs/skills.ts';
import { esc, type TabDef } from './ui.ts';

const TABS: TabDef[] = [overview, heroes, skills, items, monsters, acts, elites, rules, events];

interface State {
  tab: string;
  q: string;
  f: Record<string, string>; // filter key -> value ('' = all)
}

const tabById = (id: string) => TABS.find((t) => t.id === id);

function parseHash(): State {
  const [name, query = ''] = location.hash.slice(1).split('?');
  const saved = loadPref('codex.tab') ?? '';
  const tab = tabById(name)?.id ?? tabById(saved)?.id ?? TABS[0].id;
  const state: State = { tab, q: '', f: {} };
  new URLSearchParams(query).forEach((v, k) => {
    if (k === 'q') state.q = v;
    else state.f[k] = v;
  });
  return state;
}

const hashOf = (s: State) => {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  for (const [k, v] of Object.entries(s.f)) if (v) p.set(k, v);
  const qs = p.toString();
  return `#${s.tab}${qs ? `?${qs}` : ''}`;
};

let state = parseHash();
const panels = new Map<string, HTMLElement>();
const search = $<HTMLInputElement>('#search');

/** The tab's panel, rendered the first time it is shown. */
function panelFor(tab: TabDef): HTMLElement {
  let el = panels.get(tab.id);
  if (el) return el;
  el = document.createElement('section');
  el.className = 'panel';
  try {
    el.innerHTML = `${tab.render()}<p class="empty" hidden>Nothing matches.</p>`;
  } catch (err) {
    el.innerHTML = `<pre class="error-box">The ${esc(tab.label)} tab failed to render:\n${esc(String(err instanceof Error ? err.stack ?? err.message : err))}</pre>`;
  }
  $('#view').append(el);
  panels.set(tab.id, el);
  return el;
}

function renderFilters(tab: TabDef) {
  const defs = tab.filters ?? [];
  const selects = defs.map((d) => {
    const opts = [['', 'All'], ...d.options].map(([v, label]) => `<option value="${esc(v)}"${(state.f[d.key] ?? '') === v ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<label class="flt"><span>${esc(d.label)}</span><select data-filter="${d.key}">${opts}</select></label>`;
  });
  // A filter from a link that has no select (say, one entry by id) shows as a pill that clears it.
  const extra = Object.entries(state.f).filter(([k, v]) => v && !defs.some((d) => d.key === k)).map(([k, v]) => `<button type="button" class="pill" data-clear="${esc(k)}" title="Clear this filter">${esc(k)}: ${esc(v)} ✕</button>`);
  $('#filters').innerHTML = [...selects, ...extra].join('');
}

/** Hides the entries that don't match the search and filters, and any group left empty. */
function applyFilters() {
  const panel = panels.get(state.tab)!;
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = Object.entries(state.f).filter(([, v]) => v);
  const active = terms.length > 0 || wanted.length > 0;
  let shown = 0;
  let total = 0;
  panel.querySelectorAll<HTMLElement>('[data-q]').forEach((el) => {
    const hay = el.dataset.q ?? '';
    const ok = terms.every((t) => hay.includes(t)) && wanted.every(([k, v]) => (el.dataset[k] ?? '').split(' ').includes(v));
    el.hidden = !ok;
    if (!el.querySelector('[data-q]')) {
      total++;
      if (ok) shown++;
    }
  });
  panel.querySelectorAll<HTMLElement>('.group').forEach((g) => {
    const entries = [...g.querySelectorAll<HTMLElement>('[data-q]')];
    g.hidden = entries.length ? entries.every((e) => e.hidden) : active;
  });
  panel.querySelector<HTMLElement>('.empty')!.hidden = !active || shown > 0 || total === 0;
  $('#count').textContent = total ? `${active ? `${shown} of ` : ''}${total} entries` : '';
}

function show(scroll: boolean) {
  const tab = tabById(state.tab)!;
  const panel = panelFor(tab);
  for (const [id, el] of panels) el.hidden = id !== tab.id;
  document.querySelectorAll<HTMLElement>('.tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab.id));
  document.title = `${tab.label} · Delvers Codex`;
  search.value = state.q;
  renderFilters(tab);
  applyFilters();
  savePref('codex.tab', tab.id);
  if (scroll) window.scrollTo(0, 0);
  // keep the active tab in view in the (scrollable) tab bar
  document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  void panel;
}

/** Keeps the hash in step with the search and filters, without adding history entries. */
const sync = () => history.replaceState(null, '', hashOf(state));

// ---------------------------------------------------------------- wiring

$('#tabs').innerHTML = TABS.map((t) => `<a class="tab" href="#${t.id}" data-tab="${t.id}">${esc(t.label)}</a>`).join('');

search.addEventListener('input', () => {
  state.q = search.value.trim();
  applyFilters();
  sync();
});

$('#filters').addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-filter]');
  if (!sel) return;
  state.f[sel.dataset.filter!] = sel.value;
  applyFilters();
  sync();
});

$('#filters').addEventListener('click', (e) => {
  const pill = (e.target as HTMLElement).closest<HTMLElement>('[data-clear]');
  if (!pill) return;
  delete state.f[pill.dataset.clear!];
  renderFilters(tabById(state.tab)!);
  applyFilters();
  sync();
});

/** Sorts a table by the clicked column: the cells' data-v (numbers or text), ascending then descending. */
function sortBy(th: HTMLElement) {
  const table = th.closest('table')!;
  const body = table.tBodies[0];
  const col = (th as HTMLTableCellElement).cellIndex;
  const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
  table.querySelectorAll('th').forEach((h) => h.removeAttribute('aria-sort'));
  th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
  const num = th.dataset.sort === 'num';
  const key = (tr: HTMLTableRowElement) => {
    const c = tr.cells[col];
    const v = c?.dataset.v ?? c?.textContent ?? '';
    return num ? Number(v) : v.toLowerCase();
  };
  const rows = [...body.rows].map((tr, i) => ({ tr, i, k: key(tr) }));
  rows.sort((a, b) => dir * (a.k < b.k ? -1 : a.k > b.k ? 1 : 0) || a.i - b.i);
  body.append(...rows.map((r) => r.tr));
}

$('#view').addEventListener('click', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-sort]');
  if (th) sortBy(th);
});
$('#view').addEventListener('keydown', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-sort]');
  if (th && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    sortBy(th);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    search.focus();
  }
});

window.addEventListener('hashchange', () => {
  const next = parseHash();
  const changedTab = next.tab !== state.tab;
  state = next;
  show(changedTab);
});

show(false);
if (!location.hash) sync();
