// Small HTML helpers shared by the codex tabs. Tabs render strings; main.ts wires search, filters, sorting and the hash.

import { MONSTERS } from '../../shared/rules.ts';
import { STATUSES, type StatusApply } from '../../shared/skills.ts';
import { MONSTER_SPRITES, spriteHtml, type Sprite } from '../sprites.ts';
import { esc } from '../util.ts';

export { esc };

/** One select in the toolbar. The tab's entries carry `data-<key>` (space-separated values) and show when it matches. */
export interface FilterDef {
  key: string;
  label: string;
  options: [value: string, label: string][];
}

export interface TabDef {
  id: string;
  label: string;
  filters?: FilterDef[];
  render(): string;
}

/** Lowercase search text for an entry (the toolbar's search box matches it), escaped for an attribute. */
export const q = (...parts: (string | number | undefined | false)[]) => esc(parts.filter((p) => p !== undefined && p !== false).join(' ').toLowerCase());

export const chip = (text: string, cls = '', title = '') => `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
export const link = (hash: string, html: string, title = '') => `<a href="#${hash}"${title ? ` title="${esc(title)}"` : ''}>${html}</a>`;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A sprite tile, or the emoji when there is none. */
export const icon = (sp: Sprite | undefined, emoji: string, px = 32, title = ''): string =>
  spriteHtml(sp, px, title) || `<span class="emoji" style="font-size:${Math.round(px * 0.72)}px;width:${px}px" ${title ? `title="${esc(title)}"` : ''}>${emoji}</span>`;

/** A monster as a small chip (sprite + name) that opens its row in the Monsters tab. */
export function monsterChip(id: string, count = 1): string {
  const def = MONSTERS[id];
  const sp = MONSTER_SPRITES[id];
  const body = `${icon(sp, def?.glyph ?? '❓', 24)}<span>${def ? esc(def.name) : `<s>${esc(id)}</s>`}${count > 1 ? ` ×${count}` : ''}</span>`;
  return `<a class="mchip${def ? '' : ' bad'}" href="#monsters?id=${esc(id)}" title="${esc(id)}">${body}</a>`;
}

/** A key/value list: `[['XP shared', '0.5', srcTag], ...]` as table rows. */
export const kv = (rows: [label: string, value: string | number, tag?: string][]) =>
  `<div class="table-wrap"><table class="kv"><tbody>${rows.map(([k, v, t]) => `<tr><th>${k}</th><td>${v}</td><td>${t ?? ''}</td></tr>`).join('')}</tbody></table></div>`;

/** A table cell that sorts by `v` (a number or a string) when its column header is clicked. */
export const td = (html: string | number, v?: string | number, cls = '') => `<td${cls ? ` class="${cls}"` : ''}${v !== undefined ? ` data-v="${esc(String(v))}"` : ''}>${html}</td>`;

/** A table header; `sort` makes it clickable ('num' or 'str'). */
export const th = (label: string, sort?: 'num' | 'str') => `<th${sort ? ` data-sort="${sort}" tabindex="0" title="Sort by ${esc(label)}"` : ''}>${label}</th>`;

export const wrapTable = (head: string, rows: string, cls = '') => `<div class="table-wrap"><table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;

/** A group of entries under a heading; main.ts hides it when the search or a filter leaves nothing in it. */
export const group = (title: string, body: string, note = '') =>
  `<section class="group"><h2>${title}</h2>${note ? `<p class="muted note">${note}</p>` : ''}${body}</section>`;

export const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

/** A status application in a few words: "🪢 Netted 2t", "🩸 Drained rest of the fight +2 (stacks to 5)". */
export function statusText(x: StatusApply): string {
  const s = STATUSES[x.id];
  return `${s?.icon ?? ''} ${s?.name ?? x.id} ${x.turns >= 99 ? 'rest of the fight' : `${x.turns}t`}${x.power ? ` +${x.power}` : ''}${x.stack ? ` (stacks to ${x.stack})` : ''}`;
}
