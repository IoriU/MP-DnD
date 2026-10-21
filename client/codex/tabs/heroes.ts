// Heroes: one card per class.

import { CARD_RARITIES } from '../../../shared/engines.ts';
import { RARITY_COLOR } from '../../../shared/items.ts';
import { CLASSES, CLASS_IDS, MAX_CANTRIPS, MAX_SPELLS, STATS, maxHpFor, maxSlotsFor, passiveSlots, saveDc } from '../../../shared/rules.ts';
import { SKILLS, type SkillId } from '../../../shared/skills.ts';
import { CLASS_SPRITES } from '../../sprites.ts';
import { enginesIn, looseCards, poolCounts } from '../checks.ts';
import { DATA } from '../model.ts';
import { srcTag } from '../sources.ts';
import { chip, esc, icon, link, q, type TabDef } from '../ui.ts';

const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
const LEVELS = [1, 4, 8, 12];

/** A skill as a chip that opens it in the Skills tab, outlined in its rarity's color. */
const skillChip = (id: SkillId, rarity?: (typeof CARD_RARITIES)[number]) =>
  link(`skills?id=${id}`, `<span class="sk-chip"${rarity ? ` style="border-color:${RARITY_COLOR[rarity]}"` : ''}>${SKILLS[id].base.icon} ${esc(SKILLS[id].base.name)}</span>`, id);

/** The class's build engines: what each builds up, and its cards by rarity (the offers lean toward the engines a hero has started). */
function engineBlock(classId: string): string {
  const engines = enginesIn(DATA, classId);
  if (!engines.length) return '';
  const cards = engines
    .map(([eid, e]) => {
      const rows = CARD_RARITIES.filter((r) => e.cards[r]?.length)
        .map((r) => `<div class="rar-row"><span class="rar" style="color:${RARITY_COLOR[r]}">${r}</span><span class="chips">${e.cards[r]!.map((s) => skillChip(s as SkillId, r)).join('')}</span></div>`)
        .join('');
      return `<div class="eng-card">
        <div class="eng-head"><b>${e.icon} ${esc(e.name)}</b><code>${eid}</code>${srcTag('engine', eid)}</div>
        <p class="blurb">${esc(e.desc)}</p>
        ${rows}
      </div>`;
    })
    .join('');
  const loose = looseCards(DATA, classId) as SkillId[];
  return `<h3>Engines <small class="muted">${engines.length} ways to build</small></h3><div class="eng-list">${cards}</div>${
    loose.length ? `<p class="muted note">In no engine (general picks): ${loose.map((s) => skillChip(s)).join(' ')}</p>` : ''
  }`;
}

function card(id: (typeof CLASS_IDS)[number]): string {
  const c = CLASSES[id];
  const sheet = CLASS_SPRITES[id];
  const n = poolCounts(DATA, id);
  const start = c.start.map((s: SkillId) => link(`skills?id=${s}`, `<span class="sk-chip">${SKILLS[s].base.icon} ${esc(SKILLS[s].base.name)}</span>`, s)).join('');
  const mods = STATS.map((s) => `<span class="mod${s === c.stat ? ' main' : ''}" title="${s === c.stat ? 'casting stat' : ''}"><small>${s.toUpperCase()}</small><b>${sign(c.mods[s])}</b></span>`).join('');
  const growth = LEVELS.map((lv) => `<tr><td>Lv ${lv}</td><td>${maxHpFor(id, lv)}</td><td>${maxSlotsFor(id, lv)}</td><td>${saveDc(id, lv)}</td></tr>`).join('');
  return `<article class="card hero" data-id="${id}" data-q="${q(c.name, id, c.blurb, c.stat, Object.values(c.names).join(' '), c.start.join(' '), ...enginesIn(DATA, id).map(([, e]) => `${e.name} ${e.desc}`))}">
    <header class="hero-head">
      ${icon(sheet ? { sheet, frame: 0 } : undefined, c.glyph, 56)}
      <div><h2>${c.glyph} ${esc(c.name)}</h2><code>${id}</code></div>
      ${srcTag('class', id)}
    </header>
    <p class="blurb">${esc(c.blurb)}</p>
    <div class="statline"><span><small>HP</small><b>${c.hp}</b><i>+${c.hpPerLevel}/level</i></span><span><small>AC</small><b>${c.ac}</b></span><span><small>Speed</small><b>${c.speed}</b></span><span><small>${esc(c.names.slots)}</small><b>${c.slots}</b><i>+1 every 2 levels</i></span></div>
    <div class="mods">${mods}</div>
    <p class="muted note">Casting stat: <b>${c.stat.toUpperCase()}</b> (cantrip and spell attacks, save DCs, heals). ${c.armor === 'light' ? 'Light' : 'Heavy'} armor${c.armor === 'light' ? ': DEX raised adds to AC' : ': no AC from DEX'}. Stats also set attacks, saves, initiative (DEX), max HP (CON), slots (INT) and event checks; a point every other level raises any of them.</p>
    <h3>Flavor names</h3>
    <p>Cantrips are <b>${esc(c.names.cantrip)}</b>, spells are <b>${esc(c.names.spell)}</b>, slots are <b>${esc(c.names.slots)}</b>.</p>
    <h3>Starting skills</h3>
    <div class="chips">${start}</div>
    <h3>Skill pool</h3>
    <p>${link(`skills?pool=${id}`, `${n.cantrip} cantrips · ${n.spell} spells · ${n.passive} passives${n.basic ? ` · ${n.basic} basic` : ''}`)}${n.engine ? ` <span class="muted">${n.engine} of them in engines</span>` : ''} ${chip(`holds ${MAX_CANTRIPS} / ${MAX_SPELLS} / ${passiveSlots(1)}-${passiveSlots(8)}`, 'dim', 'cantrips, spells, passives a hero can hold at once')}</p>
    ${engineBlock(id)}
    <h3>Growth</h3>
    <div class="table-wrap"><table class="kv"><thead><tr><th></th><th>Max HP</th><th>Slots</th><th>Save DC</th></tr></thead><tbody>${growth}</tbody></table></div>
  </article>`;
}

export const heroes: TabDef = {
  id: 'heroes',
  label: 'Heroes',
  render: () => `<div class="grid cards">${CLASS_IDS.map(card).join('')}</div>`,
};
