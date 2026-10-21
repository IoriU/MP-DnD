// The six stats as a compact row (STR +3 · DEX +1 ...): on the hero cards, the class cards in the tavern and the codex.
// Hover a stat to read what it does. The casting stat is outlined; stats a hero has raised show in green.

import { CLASSES, STATS, STAT_INFO, fmtMod, statGain, statMod } from '../shared/rules.ts';
import type { ClassId, PlayerEntity } from '../shared/types.ts';
import { esc } from './util.ts';

/** A class's starting stats, or a hero's own (raised points and gear included). */
export function statsRow(classId: ClassId, hero?: PlayerEntity): string {
  const c = CLASSES[classId];
  return `<span class="abil">${STATS.map((s) => {
    const mod = hero ? statMod(hero, s) : c.mods[s];
    const up = hero ? statGain(hero, s) : 0;
    const info = STAT_INFO[s];
    const tip = `${info.icon} ${info.name} ${fmtMod(mod)}${s === c.stat ? ' (casting stat)' : ''}${up > 0 ? `, raised by ${up}` : ''}\n${info.does}`;
    return `<span class="ab${s === c.stat ? ' cast' : ''}${up > 0 ? ' up' : ''}" title="${esc(tip)}"><small>${s.toUpperCase()}</small><b>${fmtMod(mod)}</b></span>`;
  }).join('')}</span>`;
}
